'use strict';

const Homey = require('homey');
const axios = require('axios');
const https = require('https');

module.exports = class ClientDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('ClientDriver has been initialized');
  }

  async onPair(session) {
    session.setHandler("login", async (data) => {
      this.log("Attempting to log in with provided credentials...");
      try {
        const ip = data.ip;
        const email = data.email;
        const password = data.password;
        if (!ip || !email || !password) {
          return { success: false, error: "INVALID_CREDENTIALS" };
        }
        this._client = axios.create({
          baseURL: `https://${ip}:8043`,
          withCredentials: true,
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        });
        this._sessionCookie = null;
        const response = await this._client.post('/api/v2/login', {
          username: email,
          password,
        });
        const setCookie = response.headers['set-cookie'];
        if (setCookie) {
          const match = setCookie
            .join('; ')
            .match(/TPOMADA_SESSIONID=([^;]+)/);
          if (match) {
            this._sessionCookie = `TPOMADA_SESSIONID=${match[1]}`;
          } else {
            throw new Error("Session cookie not found in response.");
          }
        } else {
          throw new Error("Session cookie not found in response.");
        }
        this._client.interceptors.request.use((config) => {
          if (this._sessionCookie) {
            config.headers['Cookie'] = this._sessionCookie;
          }
          return config;
        });
        const idResponse = await this._client.get('/api/v2/anon/info');
        if (idResponse.status !== 200 || !idResponse.data.result || !idResponse.data.result.omadacId) {
          this.error('Response data:', idResponse.data);
          throw new Error("Failed to retrieve controller ID.");
        }
        this._cid = idResponse.data.result.omadacId;
        this.homey.settings.set("cid", this._cid);
        const tokenResponse = await this._client.get('/api/v2/loginStatus?needToken=true');
        if (tokenResponse.status !== 200) {
          throw new Error("Failed to retrieve CSRF token.");
        }
        this._csrfToken = tokenResponse.data.result.token;
        this.homey.settings.set('ip', ip);
        this.homey.settings.set('email', email);
        this.homey.settings.set('password', password);
        this.homey.settings.set('loggedIn', true);
        await session.showView('list_devices');
        return { success: true };
      } catch (error) {
        this._client = null;
        this._sessionCookie = null;
        this._csrfToken = null;
        this._cid = null;
        this.error('Login failed: ', error.message);
        this.error('Stack trace: ', error.stack);
        if (error.response && error.response.status === 401) {
          return { success: false, error: "INVALID_CREDENTIALS" };
        }
        return { success: false, error: "ERROR" };
      }
    });

    /*session.setHandler("showView", async (viewId) => {
      if (viewId === 'login') {
        const loggedIn = this.homey.settings.get('loggedIn');
        if (loggedIn) {
          await session.showView('list_devices');
          return;
        }
      }
    });*/

    session.setHandler("list_devices", async (data) => {
      try {
        const devices = [];
        if (this._client && this._csrfToken) {
          const response = await this._client.get(`/${this._cid}/api/v2/user/sites?currentPage=1&currentPageSize=100&filters.needFavorite=true`, {
            headers: {
              'Csrf-Token': this._csrfToken,
            },
          });
          if (response.status === 200 && response.data.result && Array.isArray(response.data.result.data)) {
            for (const site of response.data.result.data) {
              const clientsResponse = await this._client.get(`/${this._cid}/api/v2/sites/${site.id}/clients?currentPage=1&currentPageSize=100&filters.active=true`, {
                headers: {
                  'Csrf-Token': this._csrfToken,
                },
              });
              if (clientsResponse.status === 200 && clientsResponse.data.result && Array.isArray(clientsResponse.data.result.data)) {
                const activeClients = clientsResponse.data.result.data;
                for (const client of activeClients) {
                  devices.push({
                    name: `${client.name} (${client.mac})`,
                    data: {
                      mac: client.mac,
                      siteId: client.siteId,
                      wireless: client.wireless,
                    },
                  });
                }
              } else {
                this.log(`Failed to retrieve clients for site ${site.name}.`);
                continue;
              }
            }
          } else {
            throw new Error("Failed to retrieve sites.");
          }
        }
        this._cid = null;
        this._client = null;
        this._sessionCookie = null;
        this._csrfToken = null;
        return devices;
      } catch (error) {
        this._cid = null;
        this._client = null;
        this._sessionCookie = null;
        this._csrfToken = null;
        return [];
      }
    });
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    return [
      // Example device data, note that `store` is optional
      // {
      //   name: 'My Device',
      //   data: {
      //     id: 'my-device',
      //   },
      //   store: {
      //     address: '127.0.0.1',
      //   },
      // },
    ];
  }

};
