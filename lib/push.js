'use strict';

/**
 * homey-push: push notifications for Homey apps (client SDK, CommonJS)
 *
 * Lets you send a short message from your own server to every installation of your
 * app (optionally only one app version). The SDK shows it with
 * this.homey.notifications.createNotification({ excerpt }).
 *
 * Setup:
 *   1. npm install ws        (or: npm install homey-push)
 *   2. Put these in env.json (or process.env), or pass them as options:
 *        { "PUSH_URL": "wss://push.example.com/ws", "PUSH_APP_ID": "com.example.myapp" }
 *   3. In app.js:
 *
 *        const HomeyPush = require('./lib/homey-push');
 *
 *        async onInit() {
 *          this.push = new HomeyPush(this);
 *          await this.push.startPush();
 *        }
 *
 *        async onUninit() {
 *          this.push.stopPush();
 *        }
 *
 * Privacy: no Homey identifiers are used. Each installation gets a random UUID stored in
 * the app's settings (an uninstall removes it, a reinstall gets a new one). The only data
 * sent to the server is that UUID, the app ID and the app version.
 *
 * The SDK never throws into your app: every public method swallows its own errors.
 */

const crypto = require('crypto');
const WebSocket = require('ws');

const DEFAULTS = {
  url: 'wss://homey.services.dypodex.nl/ws', // wss://your-server/ws (or PUSH_URL)
  appId: null, // shared app ID known to the server (or PUSH_APP_ID)
  reconnectMin: 2000, // ms
  reconnectMax: 5 * 60 * 1000, // ms
  idleTimeout: 75 * 1000, // reconnect if the server has been silent this long (server pings every 30s)
  handshakeTimeout: 15 * 1000,
  instanceSettingKey: 'push_instance_id', // app setting holding this installation's UUID
  seenSettingKey: 'push_seen_notifications', // app setting holding handled notification IDs
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_EXCERPT_CHARS = 500;
const MAX_SEEN = 50;

function uuidv4() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function readEnv(key) {
  try {
    // Homey exposes env.json through Homey.env
    // eslint-disable-next-line global-require
    const Homey = require('homey');
    if (Homey && Homey.env && Homey.env[key]) return Homey.env[key];
  } catch (_) { /* not running inside Homey */ }
  return process.env[key];
}

class HomeyPush {
  /**
   * @param {Homey.App} app  the app instance (`this` in app.js)
   * @param {object} [options]  see DEFAULTS
   */
  constructor(app, options = {}) {
    if (!app || !app.homey) throw new Error('HomeyPush: pass your Homey.App instance, e.g. new HomeyPush(this)');

    this.app = app;
    this.homey = app.homey;
    this.options = Object.assign({}, DEFAULTS, options);
    this.appId = this.homey.manifest.id;
    this.url = 'wss://homey.services.dypodex.nl/ws';

    this.instanceId = null; // random UUID, persisted in the app settings

    this._ws = null;
    this._started = false;
    this._stopped = false;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._watchdog = null;
    this._showing = new Set(); // notification IDs currently being shown
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                         */
  /* ------------------------------------------------------------------ */

  /** Connect to the push server and keep the connection alive. Call from onInit(). */
  async startPush() {
    try {
      if (this._started) return;
      if (!this.appId || !this.url) {
        this.app.log('[push] PUSH_URL and/or PUSH_APP_ID not configured, push disabled');
        return;
      }
      this._started = true;
      this._stopped = false;
      this.instanceId = this._loadInstanceId();
      this._connect();
    } catch (err) {
      this.app.log('[push] startPush failed:', err && err.message);
    }
  }

  /** Disconnect and stop reconnecting. Call from onUninit(). */
  stopPush() {
    this._stopped = true;
    this._started = false;
    this._clearTimeout(this._reconnectTimer);
    this._clearTimeout(this._watchdog);
    this._reconnectTimer = this._watchdog = null;
    if (this._ws) {
      try { this._ws.close(1000, 'app stopping'); } catch (_) { /* ignore */ }
      this._ws = null;
    }
  }

  /** True while the connection to the push server is open. */
  get pushConnected() {
    return !!this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  // Random UUID, generated once and kept in the app settings
  _loadInstanceId() {
    const key = this.options.instanceSettingKey;
    try {
      const existing = this.homey.settings.get(key);
      if (typeof existing === 'string' && UUID_RE.test(existing)) return existing;
    } catch (_) { /* fall through and create one */ }

    const id = uuidv4();
    try {
      this.homey.settings.set(key, id);
    } catch (err) {
      this.app.log('[push] could not persist instance ID:', err && err.message);
    }
    return id;
  }

  _connect() {
    if (this._stopped || this._ws || !this.instanceId) return;

    let ws;
    try {
      ws = new WebSocket(this.url, {
        headers: {
          'x-app-id': this.appId,
          'x-instance-id': this.instanceId,
        },
        handshakeTimeout: this.options.handshakeTimeout,
        maxPayload: 64 * 1024,
      });
    } catch (err) {
      this.app.log('[push] connect failed:', err && err.message);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      if (this._ws !== ws) return;
      this._armWatchdog();
      this._send({ t: 'hello', appVersion: this._appVersion() });
    });

    ws.on('message', (data) => {
      if (this._ws !== ws) return;
      this._armWatchdog();
      try {
        const msg = JSON.parse(data.toString());
        if (!msg) return;
        if (msg.t === 'ready') {
          this._attempt = 0; // registered, connection is healthy
        } else if (msg.t === 'notification') {
          this._onNotification(msg).catch((err) => {
            this.app.log('[push] notification failed:', err && err.message);
          });
        }
      } catch (_) { /* ignore malformed messages */ }
    });

    ws.on('ping', () => {
      if (this._ws === ws) this._armWatchdog();
    });

    ws.on('error', (err) => {
      this.app.log('[push] socket error:', err && err.message);
    });

    ws.on('close', () => {
      if (this._ws === ws) {
        this._ws = null;
        this._clearTimeout(this._watchdog);
        this._watchdog = null;
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    const base = Math.min(this.options.reconnectMax, this.options.reconnectMin * 2 ** this._attempt);
    const delay = Math.round(base * (0.5 + Math.random() * 0.5)); // jitter
    this._attempt = Math.min(this._attempt + 1, 20);
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _armWatchdog() {
    this._clearTimeout(this._watchdog);
    this._watchdog = this._setTimeout(() => {
      // Server went silent: drop the socket, the close handler reconnects
      if (this._ws) {
        try { this._ws.terminate(); } catch (_) { /* ignore */ }
      }
    }, this.options.idleTimeout);
  }

  _appVersion() {
    try {
      return (this.homey.manifest && this.homey.manifest.version) || '';
    } catch (_) {
      return '';
    }
  }

  // Show a pushed notification once, then acknowledge it. Not acknowledging (e.g. when
  // createNotification fails) makes the server resend it on the next connect.
  async _onNotification(msg) {
    const id = Number(msg.id);
    const excerpt = typeof msg.excerpt === 'string' ? msg.excerpt.trim().slice(0, MAX_EXCERPT_CHARS) : '';
    if (!Number.isSafeInteger(id) || id <= 0 || !excerpt) return;
    if (this._showing.has(id)) return;
    this._showing.add(id);

    try {
      const seen = this._seenNotifications();
      if (!seen.includes(id)) {
        await this.homey.notifications.createNotification({ excerpt });
        this._markSeen(id, seen);
      }
      this._send({ t: 'ack', id });
    } finally {
      this._showing.delete(id);
    }
  }

  _seenNotifications() {
    try {
      const v = this.homey.settings.get(this.options.seenSettingKey);
      return Array.isArray(v) ? v.filter((n) => Number.isSafeInteger(n)) : [];
    } catch (_) {
      return [];
    }
  }

  _markSeen(id, seen) {
    try {
      this.homey.settings.set(this.options.seenSettingKey, seen.concat(id).slice(-MAX_SEEN));
    } catch (_) { /* ignore */ }
  }

  _send(msg) {
    try {
      if (this.pushConnected) this._ws.send(JSON.stringify(msg), () => {});
    } catch (_) { /* ignore */ }
  }

  // Use Homey's timers when available so they are cleaned up with the app
  _setTimeout(fn, ms) {
    return typeof this.homey.setTimeout === 'function' ? this.homey.setTimeout(fn, ms) : setTimeout(fn, ms);
  }

  _clearTimeout(handle) {
    if (!handle) return;
    if (typeof this.homey.clearTimeout === 'function') this.homey.clearTimeout(handle);
    else clearTimeout(handle);
  }
}

module.exports = HomeyPush;