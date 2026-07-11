// @ts-check
/**
 * @file Tablo4U web server — serves the guide UI, a REST API over Tablo's
 * native JSON, an in-browser live player, and multi-user login.
 *
 * Env:
 *   TABLO_EMAIL / TABLO_PASSWORD   Tablo account (required unless MOCK=1)
 *   TABLO_SERVER_ID                Optional: pick a specific device
 *   ADMIN_PASSWORD                 First-run admin password (else random, printed)
 *   PORT                           Default 3400
 *   TUNER_COUNT                    Max concurrent streams (default 4)
 *   OPEN=1                         Disable login (LAN convenience)
 *   MOCK=1                         Serve sample data + test-pattern stream
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');

const { TabloClient } = require('./tablo');
const Auth = require('./auth');
const { handleStream } = require('./stream');
const mock = require('./mock');

const PORT = parseInt(process.env.PORT || '3400', 10);

const MOCK = process.env.MOCK == '1';

const OPEN = process.env.OPEN == '1';

/** @type {TabloClient|null} */
var tablo = null;

/** channelId -> 'ota'|'ott' */
const channelKind = new Map();

/** In-memory guide cache: date -> { at, data }. */
const guideCache = new Map();

const GUIDE_TTL = 5 * 60 * 1000;

/**
 * @param {any[]} channels
 */
function indexKinds(channels) {
    for (const ch of channels) {
        if (ch && ch.identifier) channelKind.set(ch.identifier, ch.kind);
    }
}

/** @returns {Promise<any[]>} */
async function getChannels() {
    const channels = MOCK ? mock.channels : (tablo ? await tablo.getChannels() : []);

    indexKinds(channels);

    return channels;
}

/**
 * @param {string} date
 * @returns {Promise<Record<string, any[]>>}
 */
async function getGuideForDate(date) {
    if (MOCK) return mock.guide;

    const cached = guideCache.get(date);

    if (cached && Date.now() - cached.at < GUIDE_TTL) return cached.data;

    if (!tablo) return {};

    const channels = await getChannels();

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
    secret: process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ---- auth middleware ----

/** @type {express.RequestHandler} */
function requireAuth(req, res, next) {
    // @ts-ignore
    if (OPEN || (req.session && req.session.user)) return next();

    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });

    return res.redirect('/login');
}

/** @type {express.RequestHandler} */
function requireAdmin(req, res, next) {
    // @ts-ignore
    if (OPEN || (req.session && req.session.user && req.session.user.role === 'admin')) return next();

    return res.status(403).json({ error: 'admin only' });
}

app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};

    const user = Auth.verify(username, password);

    if (!user) return res.status(401).json({ error: 'invalid credentials' });

    // @ts-ignore
    req.session.user = { username: user.username, role: user.role };

    res.json({ ok: true, user: { username: user.username, role: user.role } });
});

app.post('/api/logout', (req, res) => {
    // @ts-ignore
    req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
    // @ts-ignore
    const user = req.session && req.session.user;

    res.json({ authed: OPEN || !!user, open: OPEN, user: user || null });
});

// ---- user administration (admin only) ----

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    res.json(Auth.list());
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
    try {
        const { username, password, role } = req.body || {};

        const u = Auth.addUser(username, password, role === 'admin' ? 'admin' : 'user');

        res.json({ ok: true, user: { username: u.username, role: u.role } });
    } catch (err) {
        res.status(400).json({ error: String(err && err.message || err) });
    }
});

app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
    try {
        Auth.remove(req.params.username);

        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: String(err && err.message || err) });
    }
});

// ---- Tablo data API ----

app.get('/api/channels', requireAuth, async (req, res) => {
    try {
        res.json(await getChannels());
    } catch (err) {
        res.status(502).json({ error: String(err && err.message || err) });
    }
});

app.get('/api/guide', requireAuth, async (req, res) => {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));

    try {
        res.json({ date, guide: await getGuideForDate(date) });
    } catch (err) {
        res.status(502).json({ error: String(err && err.message || err) });
    }
});

// Live player stream (MPEG-TS; played by mpegts.js in the browser).
app.get('/api/stream/:channelId', requireAuth, (req, res) => {
    return handleStream(req, res, {
        mock: MOCK,
        tablo,
        kindOf: (id) => channelKind.get(id),
        log: (m) => console.log('[tablo4u] ' + m)
    });
});

// ---- static UI ----

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));

app.use(requireAuth, express.static(path.join(__dirname, '..', 'public')));

// ---- boot ----

(async function start() {
    if (!OPEN) {
        const seed = Auth.ensureAdmin(process.env.ADMIN_PASSWORD);

        if (seed.created) {
            console.log('[tablo4u] ----------------------------------------------');
            console.log(`[tablo4u] Created admin account:  ${seed.username} / ${seed.password}`);
            console.log('[tablo4u] (set ADMIN_PASSWORD to choose your own, or change it in the app)');
            console.log('[tablo4u] ----------------------------------------------');
        }
    }

    if (MOCK) {
        console.log('[tablo4u] MOCK mode — sample data + test-pattern stream, no Tablo needed.');
    } else if (process.env.TABLO_EMAIL && process.env.TABLO_PASSWORD) {
        tablo = new TabloClient({
            email: process.env.TABLO_EMAIL,
            password: process.env.TABLO_PASSWORD,
            serverId: process.env.TABLO_SERVER_ID
        });

        try {
            const info = await tablo.login();

            console.log(`[tablo4u] Connected to Tablo "${info.device}" as profile "${info.profile}".`);

            await getChannels(); // warm the kind index
        } catch (err) {
            console.error('[tablo4u] Tablo login failed:', err && err.message || err);
        }
    } else {
        console.error('[tablo4u] No TABLO_EMAIL / TABLO_PASSWORD (and MOCK off). Data calls will error.');
    }

    app.listen(PORT, () => {
        console.log(`[tablo4u] Web UI on http://localhost:${PORT}${OPEN ? '  (open)' : '  (login required)'}`);
    });
})();
