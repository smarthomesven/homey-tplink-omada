'use strict';

const Homey = require('homey');
const axios = require('axios');
const https = require('https');
const POLL_INTERVAL_MS = 15000;


module.exports = class OmadaApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('OmadaApp has been initialized');
    // generate ID, random UUID
    try {
      const { randomUUID } = require('crypto');
      let id = this.homey.settings.get('id');
      if (!id) {
        id = randomUUID();
        this.homey.settings.set('id', id);
      }
      await axios.post('https://homey-apps-telemetry.vercel.app/api/installations', {
        id: id,
        appId: "com.omadanetworks",
        homeyPlatform: this.homey.platformVersion ? this.homey.platformVersion : 1,
        appVersion: this.manifest.version,
      }).catch(error => {
        this.error('Error sending telemetry data:', error.message);
      });
    } catch (error) {
      this.error('Error in onInit:', error.message);
    }
    this._devices = new Map(); // mac -> device instance
    this._client = null;
    this._sessionCookie = null;
    this._csrfToken = null;
    this._cid = null;
    this._pollTimer = null;

    await this._startPolling();
  }

  registerDevice(mac, device) {
    this._devices.set(mac, device);
    this.log(`Registered device: ${mac}`);
  }

  unregisterDevice(mac) {
    this._devices.delete(mac);
    this.log(`Unregistered device: ${mac}`);
  }

  async _startPolling() {
    await this._poll(); // immediate first poll
    this._pollTimer = this.homey.setInterval(async () => {
      await this._poll();
    }, POLL_INTERVAL_MS);
  }

  async _ensureSession() {
    if (this._client && this._csrfToken) return true;

    const ip = this.homey.settings.get('ip');
    const email = this.homey.settings.get('email');
    const password = this.homey.settings.get('password');

    if (!ip || !email || !password) return false;

    try {
      this._client = axios.create({
        baseURL: `https://${ip}:8043`,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        maxRedirects: 0,
      });
      const loginRes = await this._client.post('/api/v2/login', { username: email, password });
      const setCookie = loginRes.headers['set-cookie'];
      const match = setCookie?.join('; ').match(/TPOMADA_SESSIONID=([^;]+)/);
      if (!match) throw new Error('No session cookie');
      this._sessionCookie = `TPOMADA_SESSIONID=${match[1]}`;

      this._client.interceptors.request.use(config => {
        config.headers['Cookie'] = this._sessionCookie;
        return config;
      });

      const cidRes = await this._client.get('/api/v2/anon/info');
      this._cid = cidRes.data.result.omadacId;

      const tokenRes = await this._client.get('/api/v2/loginStatus?needToken=true');
      this._csrfToken = tokenRes.data.result.token;

      return true;
    } catch (err) {
      this.error('Session init failed:', err.message);
      this._invalidateSession();
      return false;
    }
  }

  _invalidateSession() {
    this._client = null;
    this._sessionCookie = null;
    this._csrfToken = null;
    this._cid = null;
  }

    async _poll() {
    if (this._devices.size === 0) return;
    if (!await this._ensureSession()) return;

    try {
      // Collect all unique siteIds needed by registered devices
      const siteIds = new Set(
        [...this._devices.values()].map(d => d.getSiteId())
      );

      // Build mac -> client map from one pass per site
      const clientMap = new Map(); // mac -> client object (or absent = disconnected)

      for (const siteId of siteIds) {
        const res = await this._client.get(
          `/${this._cid}/api/v2/sites/${siteId}/clients?currentPage=1&currentPageSize=1000&filters.active=true`,
          { headers: { 'Csrf-Token': this._csrfToken } }
        );

        if (res.status === 200 && Array.isArray(res.data?.result?.data)) {
          for (const client of res.data.result.data) {
            clientMap.set(client.mac, client);
          }
        }
      }

      // Dispatch to each device
      for (const [mac, device] of this._devices) {
        device.onClientData(clientMap.get(mac) ?? null);
      }
    } catch (err) {
      this.error('Poll failed:', err.message);
      if (
        err.response?.status === 401 ||
        err.response?.status === 403 ||
        err.response?.status === 302
      ) {
        this.log('Session expired, will re-authenticate on next poll');
        this._invalidateSession();
      }
    }
  }

};
