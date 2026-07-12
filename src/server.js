// @ts-check
/**
 * @file Tablo4U web server — serves the guide UI, a REST API over Tablo's
 * native JSON, an in-browser live player, and multi-user login.
 *
 * Env:
 *   TABLO_EMAIL / TABLO_PASSWORD   Tablo account (required unless MOCK=1)
 *   TABLO_SERVER_ID                Optional: pick a specific device
 *   ADMIN_PASSWORD                 Admin password (always wins; else random, printed)
 *   PORT                           Default 3400
 *   OPEN=1                         Disable login (LAN convenience)
 *   MOCK=1                         Serve sample data + test-pattern stream
 */

const path = require('path');
const fs = require('fs');

const { baseDir } = require('./paths');

// Load .env from next to the exe (when packaged) or the project root.
require('dotenv').config({ path: path.join(baseDir(), '.env') });

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
        if (!ch || !ch.identifier) continue;

        channelKind.set(ch.identifier, ch.kind);
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

// ---- static assets (loaded into memory at boot) ----
// Read via fs.readFileSync so this works identically whether running as a
// script or from a pkg-built exe (embedded assets are read-only in the
// snapshot; readFileSync is the most reliable way to reach them).
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.json': 'application/json'
};

/** @type {Map<string, {body: Buffer, type: string}>} */
const STATIC = new Map();

// Embedded assets (generated at build time). Present in the packaged exe;
// absent in dev, where we read public/ from disk instead.
let embedded = null;

try {
    embedded = require('./assets.generated');
} catch { /* dev — no generated module, read from disk */ }

function loadStatic() {
    // Dev: serve live files from public/. Packaged exe: public/ isn't in the
    // snapshot, so fall back to the embedded module.
    const root = path.join(__dirname, '..', 'public');

    const walk = (dir, base) => {
        for (const name of fs.readdirSync(dir)) {
            const fp = path.join(dir, name);

            const url = base + '/' + name;

            if (fs.statSync(fp).isDirectory()) {
                walk(fp, url);
            } else {
                STATIC.set(url, { body: fs.readFileSync(fp), type: CONTENT_TYPES[path.extname(name)] || 'application/octet-stream' });
            }
        }
    };

    try {
        walk(root, '');
    } catch { /* fall through to embedded */ }

    if (STATIC.size === 0 && embedded) {
        for (const url of Object.keys(embedded)) {
            STATIC.set(url, { body: Buffer.from(embedded[url].b64, 'base64'), type: embedded[url].type });
        }
    }

    if (STATIC.size === 0) {
        console.error('[tablo4u] No web assets found (neither public/ on disk nor an embedded bundle).');
    }
}

loadStatic();

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

// ---- device diagnostics (admin only) ----
// Read-only probe of candidate device endpoints, used to discover what the
// Tablo 4th Gen exposes (e.g. per-channel signal strength — not present in the
// cloud lineup/guide we normally use). Admin-only since the site may be public.
app.get('/api/device/probe', requireAuth, requireAdmin, async (req, res) => {
    if (!tablo) return res.status(502).json({ error: 'Tablo not connected' });

    // ?path=/guide/channels/180 — fetch any single device path raw, so we can
    // keep digging without rebuilding the exe.
    if (req.query.path) {
        const p = String(req.query.path);

        try {
            return res.json({ path: p, result: await tablo.deviceReq('GET', p) });
        } catch (err) {
            return res.json({ path: p, error: String(err && err.message || err) });
        }
    }

    const paths = [
        '/server/info', '/server/tuners', '/server/capabilities',
        '/server/netstatus', '/netstatus', '/server/net', '/guide/channels'
    ];

    /** @type {Record<string, any>} */
    const out = {};

    // Raw cloud channel samples (one OTA, one OTT) in case signal hides there.
    try {
        const chs = await getChannels();
        out['_cloud_ota_sample'] = chs.find(c => c && c.kind === 'ota') || null;
        out['_cloud_ott_sample'] = chs.find(c => c && c.kind === 'ott') || null;
    } catch (err) {
        out['_cloud_channel_sample'] = { error: String(err && err.message || err) };
    }

    await Promise.all(paths.map(async (p) => {
        try {
            const r = await tablo.deviceReq('GET', p);

            out[p] = Array.isArray(r)
                ? { type: 'array', length: r.length, sample: r.slice(0, 3) }
                : (typeof r === 'string' ? r.slice(0, 300) : r);
        } catch (err) {
            out[p] = { error: String(err && err.message || err) };
        }
    }));

    // Follow the /guide/channels list into a couple of per-channel resources —
    // the most likely home for signal strength.
    try {
        const list = await tablo.deviceReq('GET', '/guide/channels');

        /** @type {Record<string, any>} */
        const details = {};

        if (Array.isArray(list)) {
            for (const entry of list.slice(0, 3)) {
                const cp = typeof entry === 'string' ? entry : (entry && (entry.path || entry.href));

                if (cp) {
                    try { details[cp] = await tablo.deviceReq('GET', cp); }
                    catch (err) { details[cp] = { error: String(err && err.message || err) }; }
                }
            }
        }

        out['_channel_detail_samples'] = details;
    } catch (err) {
        out['_channel_detail_samples'] = { error: String(err && err.message || err) };
    }

    res.json(out);
});

// Live player stream (MPEG-TS; played by mpegts.js in the browser).
app.get('/api/stream/:channelId', requireAuth, (req, res) => {
    // @ts-ignore - record recently-watched for the signed-in user
    const user = req.session && req.session.user;

    if (user) {
        try { Auth.addRecent(user.username, req.params.channelId); } catch { /* non-fatal */ }
    }

    return handleStream(req, res, {
        mock: MOCK,
        tablo,
        kindOf: (id) => channelKind.get(id),
        tunerCount: tablo ? tablo.tuners : 4,
        log: (m) => console.log('[tablo4u] ' + m)
    });
});

// ---- per-user favorites & recently watched ----

app.get('/api/profile', requireAuth, (req, res) => {
    // @ts-ignore
    const user = req.session && req.session.user;

    res.json(user ? Auth.getProfile(user.username) : { favorites: [], recent: [] });
});

app.put('/api/favorites/:channelId', requireAuth, (req, res) => {
    // @ts-ignore
    const user = req.session && req.session.user;

    if (user) Auth.setFavorite(user.username, req.params.channelId, true);

    res.json({ ok: true });
});

app.delete('/api/favorites/:channelId', requireAuth, (req, res) => {
    // @ts-ignore
    const user = req.session && req.session.user;

    if (user) Auth.setFavorite(user.username, req.params.channelId, false);

    res.json({ ok: true });
});

// ---- static UI ----

/**
 * @param {import('express').Response} res
 * @param {string} url
 * @returns {boolean} whether the asset was served
 */
function sendStatic(res, url) {
    const asset = STATIC.get(url);

    if (!asset) return false;

    res.set('Content-Type', asset.type);

    res.send(asset.body);

    return true;
}

// Login page is public (no auth).
app.get('/login', (req, res) => { if (!sendStatic(res, '/login.html')) res.status(404).send('not found'); });

// Everything else behind auth.
app.use(requireAuth, (req, res, next) => {
    if (req.method !== 'GET') return next();

    const url = req.path === '/' ? '/index.html' : req.path;

    if (sendStatic(res, url)) return;

    next();
});

// ---- boot ----

(async function start() {
    if (!OPEN) {
        if (process.env.ADMIN_PASSWORD) {
            // ADMIN_PASSWORD always wins: create the admin with it, or reset the
            // existing admin's password to it on every start.
            const seed = Auth.ensureAdmin(process.env.ADMIN_PASSWORD);

            if (!seed.created) Auth.setPassword('admin', process.env.ADMIN_PASSWORD);
        } else {
            // No ADMIN_PASSWORD set: generate one on first run and print it.
            const seed = Auth.ensureAdmin();

            if (seed.created) {
                console.log('[tablo4u] ----------------------------------------------');
                console.log(`[tablo4u] Created admin account:  ${seed.username} / ${seed.password}`);
                console.log('[tablo4u] (set ADMIN_PASSWORD in .env to choose your own)');
                console.log('[tablo4u] ----------------------------------------------');
            }
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

            console.log(`[tablo4u] Connected to Tablo "${info.device}" as profile "${info.profile}" (${info.tuners} tuners).`);

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
