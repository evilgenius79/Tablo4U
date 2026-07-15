// @ts-check
/**
 * @file HDHomeRun client. Unlike Tablo, HDHomeRun's local API is simple and
 * open: discover.json (device info + tuner count), lineup.json (channels with
 * direct MPEG-TS URLs — no auth), and status.json (per-tuner signal strength).
 * Channels are normalized to the same shape Tablo4U uses elsewhere, tagged
 * source:'hdhr', so they slot straight into the guide UI. Program data isn't in
 * HDHomeRun's free API, so the server borrows it from the Tablo guide by channel
 * number.
 */

const HDHR_UA = 'Tablo4U';

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
async function getJson(url, timeoutMs = 5000) {
    const res = await fetch(url, { headers: { 'User-Agent': HDHR_UA }, signal: AbortSignal.timeout(timeoutMs) });

    if (!res.ok) throw new Error(`${url} -> ${res.status}`);

    return res.json();
}

/**
 * True if `candidate` is http(s) under the same origin as `baseUrl`.
 * Prevents a poisoned discover/lineup response from sending fetches/ffmpeg
 * off-LAN (or to file:/other schemes).
 *
 * @param {string} baseUrl
 * @param {string} candidate
 * @returns {boolean}
 */
function sameOriginHttp(baseUrl, candidate) {
    try {
        const base = new URL(baseUrl);

        const u = new URL(candidate, base);

        return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === base.origin;
    } catch {
        return false;
    }
}

class HdhrClient {
    /** @param {string} baseUrl e.g. http://10.0.0.50 */
    constructor(baseUrl) {
        this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');

        /** @type {any} */
        this.info = null;

        this.tuners = 0;

        /** identifier -> direct stream URL */
        this.urls = new Map();
    }

    /** Reads discover.json; populates device info + tuner count. */
    async connect() {
        this.info = await getJson(this.baseUrl + '/discover.json');

        this.tuners = parseInt(this.info.TunerCount, 10) || 0;

        return this.info;
    }

    /**
     * Channel lineup, normalized to Tablo4U's channel shape.
     * @returns {Promise<any[]>}
     */
    async getChannels() {
        // Prefer LineupURL from discover, but only if it stays on this device.
        let lineupUrl = this.baseUrl + '/lineup.json';

        if (this.info && this.info.LineupURL && sameOriginHttp(this.baseUrl, this.info.LineupURL)) {
            lineupUrl = this.info.LineupURL;
        }

        const lineup = await getJson(lineupUrl);

        if (!Array.isArray(lineup)) return [];

        this.urls.clear();

        return lineup
            .filter(c => c && c.GuideNumber && c.URL && !c.DRM && sameOriginHttp(this.baseUrl, c.URL))
            .map(c => {
                const [maj, min] = String(c.GuideNumber).split('.');

                const identifier = 'hdhr:' + c.GuideNumber;

                // Resolve relative URLs against the device base so ffmpeg gets an absolute http URL.
                this.urls.set(identifier, new URL(c.URL, this.baseUrl).toString());

                return {
                    identifier,
                    name: c.GuideName || c.GuideNumber,
                    kind: 'ota',
                    source: 'hdhr',
                    logos: [],
                    resolution: c.HD ? 'hd_1080' : 'sd',
                    ota: {
                        major: parseInt(maj, 10) || 0,
                        minor: parseInt(min || '0', 10) || 0,
                        callSign: c.GuideName || '',
                        network: c.GuideName || ''
                    }
                };
            });
    }

    /** @param {string} identifier @returns {string|undefined} */
    streamUrl(identifier) { return this.urls.get(identifier); }

    /**
     * Per-tuner status incl. signal strength (only meaningful for a tuner
     * currently locked to a channel).
     * @returns {Promise<any[]>}
     */
    async status() {
        try {
            const s = await getJson(this.baseUrl + '/status.json', 3000);

            return Array.isArray(s) ? s : [];
        } catch {
            return [];
        }
    }

    /**
     * Signal for a channel that's actively tuned right now, matched by virtual
     * channel number (VctNumber). Returns null if nothing is tuned to it.
     * @param {string} identifier
     * @returns {Promise<{strength:number, quality:number, symbol:number}|null>}
     */
    async signalFor(identifier) {
        const num = identifier.replace(/^hdhr:/, '');

        for (const t of await this.status()) {
            if (t && t.VctNumber === num && t.SignalStrengthPercent != null) {
                return {
                    strength: t.SignalStrengthPercent,
                    quality: t.SignalQualityPercent,
                    symbol: t.SymbolQualityPercent
                };
            }
        }

        return null;
    }
}

module.exports = { HdhrClient };
