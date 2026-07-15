// @ts-check
/**
 * @file Self-contained Tablo 4th Gen API client.
 *
 * Handles cloud login, device-request signing, and the three things the web
 * UI needs: channel lineup, native JSON guide data, and per-channel watch
 * (playlist) URLs. Adapted from the proven signing/login flow in tablo2plex,
 * but standalone so Tablo4U can live in its own repo.
 */

const crypto = require('crypto');

const CLOUD_HOST = 'lighthousetv.ewscloud.com';

const UA = 'Tablo-FAST/2.0.0 (Mobile; iPhone; iOS 16.6)';

const DEVICE_UA = 'Tablo-FAST/1.7.0 (Mobile; iPhone; iOS 18.4)';

// Falsy-fallback (not `== undefined`) so an empty env value uses the default
// instead of signing with "" — the footgun that reads as an auth failure.
const HASH_KEY = process.env.HashKey || '6l8jU5N43cEilqItmT3U2M2PFM3qPziilXqau9ys';

const DEVICE_KEY = process.env.DeviceKey || 'ljpg6ZkwShVv8aI12E2LP55Ep8vq1uYDPvX0DdTB';

/**
 * RFC-1123-ish date string the device expects.
 * @returns {string}
 */
function deviceDate() {
    return new Date().toUTCString();
}

/**
 * Builds the `tablo:<deviceKey>:<hmac>` Authorization header for a device
 * request.
 *
 * @param {string} method
 * @param {string} path - path only, no query
 * @param {string} msg - request body ("" for none)
 * @param {string} date
 * @returns {string}
 */
function deviceAuth(method, path, msg, date) {
    if (msg != '') {
        msg = crypto.createHash('md5').update(msg).digest('hex').toLowerCase();
    }

    const full = method + '\n' + path + '\n' + msg + '\n' + date;

    const sig = crypto.createHmac('md5', HASH_KEY).update(full).digest('hex').toLowerCase();

    return 'tablo:' + DEVICE_KEY + ':' + sig;
}

/**
 * @typedef {Object} TabloConfig
 * @property {string} email
 * @property {string} password
 * @property {string} [serverId] - specific device serverId to use
 * @property {string} [profileId] - specific profile identifier to use
 */

class TabloClient {
    /**
     * @param {TabloConfig} config
     */
    constructor(config) {
        this.config = config;

        /** @type {string|null} */
        this.authorization = null;

        /** @type {string|null} */
        this.lighthouse = null;

        /** @type {any} */
        this.device = null;

        /** @type {any} */
        this.profile = null;

        /** Real tuner count, read from the device after login. */
        this.tuners = 4;

        this.uuid = crypto.randomUUID();

        this.ready = false;
    }

    /**
     * @param {string} method
     * @param {string} path
     * @param {any} [body]
     * @param {Record<string,string>} [extraHeaders]
     * @returns {Promise<any>}
     */
    async cloud(method, path, body = undefined, extraHeaders = {}, _retried = false) {
        const headers = {
            'User-Agent': UA,
            'Accept': '*/*',
            'Content-Type': 'application/json',
            ...extraHeaders
        };

        const res = await fetch(`https://${CLOUD_HOST}${path}`, {
            method,
            headers,
            body: body != undefined ? JSON.stringify(body) : undefined
        });

        const text = await res.text();

        // The cloud token expires after a while; on a 401, re-login once and
        // retry with refreshed tokens so long-running instances don't wedge.
        if (res.status === 401 && !_retried && !this._relogin && !path.includes('/login/') && this.config.email) {
            if (await this.relogin()) {
                const refreshed = { ...extraHeaders };

                if (refreshed.Authorization) refreshed.Authorization = this.authorization;

                if (refreshed.Lighthouse) refreshed.Lighthouse = this.lighthouse;

                return this.cloud(method, path, body, refreshed, true);
            }
        }

        if (!res.ok) {
            throw new Error(`cloud ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
        }

        return text ? JSON.parse(text) : {};
    }

    /**
     * Re-runs the login flow to refresh expired tokens. Concurrent callers share
     * one attempt. @returns {Promise<boolean>}
     */
    async relogin() {
        if (!this._relogin) {
            this._relogin = (async () => { try { await this.login(); return true; } catch { return false; } })()
                .finally(() => { this._relogin = null; });
        }

        return this._relogin;
    }

    /**
     * Signed request against the selected Tablo device (LAN, http).
     *
     * @param {string} method
     * @param {string} path
     * @param {any} [body]
     * @returns {Promise<any>}
     */
    async deviceReq(method, path, body = undefined) {
        if (!this.device) {
            throw new Error('not logged in');
        }

        const msg = body != undefined ? JSON.stringify(body) : '';

        const date = deviceDate();

        const headers = {
            'Connection': 'keep-alive',
            'Date': date,
            'Accept': '*/*',
            'User-Agent': DEVICE_UA,
            'Authorization': deviceAuth(method, path, msg, date)
        };

        if (method == 'POST') {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        // device.url is like http://10.0.0.220:8887 ; keep the ?lh param the
        // official client uses
        const url = new URL(path, this.device.url);

        url.search = 'lh';

        const res = await fetch(url.toString(), {
            method,
            headers,
            body: method == 'POST' ? msg : undefined
        });

        const text = await res.text();

        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    /**
     * Logs in, picks a profile + device, and gets the account (Lighthouse)
     * token. Populates the client so channels/guide/watch work.
     */
    async login() {
        const { email, password } = this.config;

        const loginResp = await this.cloud('POST', '/api/v2/login/', { email, password });

        if (!loginResp.access_token || !loginResp.token_type) {
            throw new Error('login failed: ' + (loginResp.message || 'no token'));
        }

        this.authorization = `${loginResp.token_type} ${loginResp.access_token}`;

        const account = await this.cloud('GET', '/api/v2/account/', undefined, {
            Authorization: this.authorization
        });

        if (!account.profiles || !account.profiles.length) {
            throw new Error('no profiles on account');
        }

        this.profile = this.config.profileId
            ? account.profiles.find((/** @type {any} */ p) => p.identifier == this.config.profileId) || account.profiles[0]
            : account.profiles[0];

        if (!account.devices || !account.devices.length) {
            throw new Error('no devices on account');
        }

        this.device = this.config.serverId
            ? account.devices.find((/** @type {any} */ d) => d.serverId == this.config.serverId) || account.devices[0]
            : account.devices[0];

        const select = await this.cloud('POST', '/api/v2/account/select/', {
            pid: this.profile.identifier,
            sid: this.device.serverId
        }, { Authorization: this.authorization });

        if (!select.token) {
            throw new Error('account select returned no token');
        }

        this.lighthouse = select.token;

        // Tuner count comes from the device itself, not config — the .env value
        // could be wrong.
        await this.getServerInfo();

        this.ready = true;

        return { device: this.device.name, profile: this.profile.name, tuners: this.tuners };
    }

    /**
     * Reads /server/info from the device to get the real tuner count.
     * @returns {Promise<any>}
     */
    async getServerInfo() {
        try {
            const info = await this.deviceReq('GET', '/server/info');

            if (info && info.model && info.model.tuners) {
                this.tuners = info.model.tuners;
            }

            return info;
        } catch {
            return null;
        }
    }

    /**
     * Builds a map of channel_identifier -> resolution ("hd_1080" | "sd" | …)
     * by walking the device's per-channel resources (/guide/channels/{id}).
     * The cloud lineup doesn't carry resolution, so this is how we get HD/SD.
     * @returns {Promise<Record<string,string>>}
     */
    async getChannelResolutions() {
        /** @type {Record<string,string>} */
        const map = {};

        let list;

        try {
            list = await this.deviceReq('GET', '/guide/channels');
        } catch {
            return map;
        }

        if (!Array.isArray(list)) return map;

        var i = 0;

        const worker = async () => {
            while (i < list.length) {
                const entry = list[i++];

                const p = typeof entry === 'string' ? entry : (entry && (entry.path || entry.href));

                if (!p) continue;

                try {
                    const d = await this.deviceReq('GET', p);

                    const c = d && d.channel;

                    if (c && c.channel_identifier && c.resolution) {
                        map[c.channel_identifier] = c.resolution;
                    }
                } catch { /* skip this channel */ }
            }
        };

        await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));

        return map;
    }

    /**
     * Native channel lineup (JSON, as Tablo returns it).
     * @returns {Promise<any[]>}
     */
    async getChannels() {
        const data = await this.cloud('GET', `/api/v2/account/${this.lighthouse}/guide/channels/`, undefined, {
            Authorization: this.authorization,
            Lighthouse: this.lighthouse
        });

        return Array.isArray(data) ? data : [];
    }

    /**
     * Native guide airings for one channel on one day (JSON, no XML).
     *
     * @param {string} channelId
     * @param {string} date - YYYY-MM-DD
     * @returns {Promise<any[]>}
     */
    async getChannelGuide(channelId, date) {
        const data = await this.cloud('GET', `/api/v2/account/guide/channels/${channelId}/airings/${date}/`, undefined, {
            Authorization: this.authorization,
            Lighthouse: this.lighthouse
        });

        return Array.isArray(data) ? data : [];
    }

    /**
     * Requests a watch session for a channel and returns the playlist URL.
     *
     * @param {string} channelId
     * @returns {Promise<{playlist_url?:string, error?:any, [k:string]:any}>}
     */
    async watch(channelId) {
        const body = {
            bandwidth: null,
            extra: {
                limitedAdTracking: 1,
                deviceOSVersion: '16.6',
                lang: 'en_US',
                height: 1080,
                deviceId: '00000000-0000-0000-0000-000000000000',
                width: 1920,
                deviceModel: 'iPhone10,1',
                deviceMake: 'Apple',
                deviceOS: 'iOS'
            },
            device_id: this.uuid,
            platform: 'ios'
        };

        return await this.deviceReq('POST', `/guide/channels/${channelId}/watch`, body);
    }
}

module.exports = { TabloClient, deviceAuth };
