// @ts-check
/**
 * @file Tablo4U web server — serves the guide UI and a small REST API over
 * Tablo's native JSON, with a simple session login in front.
 *
 * Env:
 *   TABLO_EMAIL / TABLO_PASSWORD   Tablo account (required unless MOCK=1)
 *   TABLO_SERVER_ID                Optional: pick a specific device
 *   APP_PASSWORD                   Optional: password to gate the web UI
 *   APP_USER                       Optional: username (default "admin")
 *   PORT                           Default 3400
 *   MOCK=1                         Serve sample data, no Tablo needed
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');

const { TabloClient } = require('./tablo');
const mock = require('./mock');

const PORT = parseInt(process.env.PORT || '3400', 10);

const MOCK = process.env.MOCK == '1';

const APP_USER = process.env.APP_USER || 'admin';

const APP_PASSWORD = process.env.APP_PASSWORD || '';

/** @type {TabloClient|null} */
var tablo = null;

/** In-memory guide cache: `${date}` -> { at, data }. */
const guideCache = new Map();

const GUIDE_TTL = 5 * 60 * 1000;

/**
 * Fetch guide airings for every channel on a date, with a small concurrency
 * pool and a short cache. Returns { [channelIdentifier]: airing[] }.
 *
 * @param {string} date
 * @returns {Promise<Record<string, any[]>>}
 */
async function getGuideForDate(date) {
    const cached = guideCache.get(date);

    if (cached && Date.now() - cached.at < GUIDE_TTL) {
        return cached.data;
    }

    if (!tablo) {
        return {};
    }

    const channels = await tablo.getChannels();

    /** @type {Record<string, any[]>} */
    const out = {};

    var i = 0;

    const worker = async () => {
        while (i < channels.length) {
            const ch = channels[i++];

            try {
                out[ch.identifier] = await tablo.getChannelGuide(ch.identifier, date);
            } catch {
                out[ch.identifier] = [];
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(6, channels.length) }, worker));

    guideCache.set(date, { at: Date.now(), data: out });

    return out;
}

const app = express();

app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || require('crypto').randomBytes(16).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ---- auth ----

/** @type {express.RequestHandler} */
function requireAuth(req, res, next) {
    // If no APP_PASSWORD is configured, the UI is open (LAN convenience).
    // @ts-ignore
    if (!APP_PASSWORD || (req.session && req.session.authed)) {
        return next();
    }

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    return res.redirect('/login');
}

app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};

    if (!APP_PASSWORD) {
        return res.json({ ok: true, open: true });
    }

    if (username == APP_USER && password == APP_PASSWORD) {
        // @ts-ignore
        req.session.authed = true;

        return res.json({ ok: true });
    }

    return res.status(401).json({ error: 'invalid credentials' });
});

app.post('/api/logout', (req, res) => {
    // @ts-ignore
    req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
    // @ts-ignore
    res.json({ authed: !APP_PASSWORD || !!(req.session && req.session.authed), loginRequired: !!APP_PASSWORD });
});

// ---- Tablo data API ----

app.get('/api/channels', requireAuth, async (req, res) => {
    try {
        const channels = MOCK ? mock.channels : await (tablo ? tablo.getChannels() : []);

        res.json(channels);
    } catch (err) {
        res.status(502).json({ error: String(err && err.message || err) });
    }
});

app.get('/api/guide', requireAuth, async (req, res) => {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));

    try {
        const guide = MOCK ? mock.guide : await getGuideForDate(date);

        res.json({ date, guide });
    } catch (err) {
        res.status(502).json({ error: String(err && err.message || err) });
    }
});

app.get('/api/watch/:channelId', requireAuth, async (req, res) => {
    if (MOCK) {
        return res.json({ playlist_url: 'https://example.com/mock/stream.m3u8', mock: true });
    }

    try {
        const result = tablo ? await tablo.watch(req.params.channelId) : { error: 'not ready' };

        res.json(result);
    } catch (err) {
        res.status(502).json({ error: String(err && err.message || err) });
    }
});

// ---- static UI ----

app.use(requireAuth, express.static(path.join(__dirname, '..', 'public')));

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

/**
 * Boot: log into Tablo (unless mock), then listen.
 */
(async function start() {
    if (MOCK) {
        console.log('[tablo4u] MOCK mode — serving sample data, no Tablo connection.');
    } else if (process.env.TABLO_EMAIL && process.env.TABLO_PASSWORD) {
        tablo = new TabloClient({
            email: process.env.TABLO_EMAIL,
            password: process.env.TABLO_PASSWORD,
            serverId: process.env.TABLO_SERVER_ID
        });

        try {
            const info = await tablo.login();

            console.log(`[tablo4u] Connected to Tablo "${info.device}" as profile "${info.profile}".`);
        } catch (err) {
            console.error('[tablo4u] Tablo login failed:', err && err.message || err);

            console.error('[tablo4u] Check TABLO_EMAIL / TABLO_PASSWORD. Serving UI anyway; data calls will error.');
        }
    } else {
        console.error('[tablo4u] No TABLO_EMAIL / TABLO_PASSWORD set (and MOCK not enabled). Data calls will error.');
    }

    app.listen(PORT, () => {
        console.log(`[tablo4u] Web UI on http://localhost:${PORT}${APP_PASSWORD ? '  (login required)' : '  (open — set APP_PASSWORD to lock)'}`);
    });
})();
