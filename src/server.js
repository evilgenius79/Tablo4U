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
const { HdhrClient } = require('./hdhr');
const Auth = require('./auth');
const { handleStream } = require('./stream');
const recorder = require('./recorder');
const scheduler = require('./scheduler');
const tuners = require('./tuners');
const mock = require('./mock');

const PORT = parseInt(process.env.PORT || '3400', 10);

const MOCK = process.env.MOCK == '1';

const OPEN = process.env.OPEN == '1';

/** @type {TabloClient|null} */
var tablo = null;

/** @type {HdhrClient|null} */
var hdhr = null;

/** channelId -> 'ota'|'ott' */
const channelKind = new Map();

/** channelId -> display name (for recording metadata). */
const channelName = new Map();

/** In-memory guide cache: date -> { at, data }. */
const guideCache = new Map();

const GUIDE_TTL = 5 * 60 * 1000;

/** Keep at most this many distinct guide dates in memory. */
const GUIDE_CACHE_MAX = 8;

/** YYYY-MM-DD only — rejects path-traversal-ish values before they hit Tablo. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {string} date
 * @param {any} data
 */
function setGuideCache(date, data) {
    guideCache.set(date, { at: Date.now(), data });

    if (guideCache.size <= GUIDE_CACHE_MAX) return;

    // Evict oldest by stamp.
    let oldestKey = null;

    let oldestAt = Infinity;

    for (const [k, v] of guideCache) {
        if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    }

    if (oldestKey != null) guideCache.delete(oldestKey);
}

// channel_identifier -> resolution ("hd_1080"|"sd"|…), from the device. Warmed
// in the background (177 per-channel device requests) since the cloud lineup
// doesn't carry it. Refreshed lazily once past the TTL.
let resCache = { at: 0, map: /** @type {Record<string,string>} */ ({}) };

let resWarming = null;

const RES_TTL = 6 * 60 * 60 * 1000;

function warmResolutions() {
    if (MOCK || !tablo) return Promise.resolve();

    if (resWarming) return resWarming;

    resWarming = tablo.getChannelResolutions()
        .then((map) => {
            // Stamp `at` on every outcome (even empty/failure) so a failed warm
            // backs off instead of re-hammering the device 177× on each request.
            resCache = { at: Date.now(), map: (map && Object.keys(map).length) ? map : resCache.map };
        })
        .catch(() => { resCache = { at: Date.now(), map: resCache.map }; })
        .finally(() => { resWarming = null; });

    return resWarming;
}

/**
 * @param {any[]} channels
 */
function indexKinds(channels) {
    for (const ch of channels) {
        if (!ch || !ch.identifier) continue;

        channelKind.set(ch.identifier, ch.kind);

        const k = ch.ota || ch.ott || {};

        channelName.set(ch.identifier, ch.name || k.callSign || ch.identifier);
    }
}

/** @returns {Promise<any[]>} */
async function getChannels() {
    let channels = MOCK ? mock.channels : (tablo ? await tablo.getChannels() : []);

    // Merge in HDHomeRun channels (tagged source:'hdhr'), if configured.
    if (hdhr) {
        try { channels = channels.concat(await hdhr.getChannels()); }
        catch (err) { console.error('[tablo4u] HDHomeRun lineup failed:', err && err.message || err); }
    }

    indexKinds(channels);

    // Merge in HD/SD from the Tablo device (cached). HDHR channels already carry
    // their own resolution from the lineup, so skip those.
    if (!MOCK && tablo) {
        if (Date.now() - resCache.at > RES_TTL) warmResolutions();

        for (const ch of channels) {
            if (ch.source === 'hdhr') continue;

            const r = resCache.map[ch.identifier];

            if (r) ch.resolution = r;
        }
    }

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

    const channels = await getChannels();

    /** @type {Record<string, any[]>} */
    const out = {};

    // Guide data comes from Tablo (HDHomeRun's free API has none). Fetch for the
    // Tablo channels...
    const tabloChannels = tablo ? channels.filter(c => c.source !== 'hdhr') : [];

    var i = 0;

    const worker = async () => {
        while (i < tabloChannels.length) {
            const ch = tabloChannels[i++];

            try {
                out[ch.identifier] = await tablo.getChannelGuide(ch.identifier, date);
            } catch {
                out[ch.identifier] = [];
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(6, tabloChannels.length) }, worker));

    // ...then lend it to HDHomeRun channels on the same virtual channel number
    // (both tune the same local broadcast, so the programming is identical).
    const byNum = {};

    for (const ch of tabloChannels) {
        const k = ch.ota || ch.ott || {};

        if (k.major != null) byNum[k.major + '.' + k.minor] = out[ch.identifier] || [];
    }

    for (const ch of channels) {
        if (ch.source !== 'hdhr') continue;

        const k = ch.ota || {};

        out[ch.identifier] = byNum[k.major + '.' + k.minor] || [];
    }

    setGuideCache(date, out);

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

// Needed so Secure cookies / req.secure work behind a reverse proxy (Caddy/nginx).
if (process.env.TRUST_PROXY == '1' || process.env.SECURE_COOKIES == '1') {
    app.set('trust proxy', 1);
}

app.use(express.json({ limit: '64kb' }));

const secureCookies = process.env.SECURE_COOKIES == '1';

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies,
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
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
    // OPEN only skips login for watching — never elevates to admin. Otherwise
    // anyone on the LAN could change recordingsDir / probe the device / manage users.
    // @ts-ignore
    if (req.session && req.session.user && req.session.user.role === 'admin') return next();

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

    res.json({ authed: OPEN || !!user, open: OPEN, user: user || null, ottDirectHls: process.env.OTT_DIRECT_HLS == '1' });
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

    if (!DATE_RE.test(date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

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
    // Validate ?path= before the Tablo-connected check so bad inputs get a clear
    // 400 even in MOCK / disconnected mode.
    if (req.query.path) {
        const p = String(req.query.path);

        if (!p.startsWith('/') || p.startsWith('//')) {
            return res.status(400).json({ error: 'path must be a root-relative device path' });
        }
    }

    if (!tablo) return res.status(502).json({ error: 'Tablo not connected' });

    // ?path=/guide/channels/180 — fetch any single device path raw, so we can
    // keep digging without rebuilding the exe. Absolute / protocol-relative
    // URLs are also rejected inside TabloClient.deviceReq (SSRF + DeviceKey leak).
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
        hdhrUrlOf: (id) => hdhr ? hdhr.streamUrl(id) : undefined,
        log: (m) => console.log('[tablo4u] ' + m)
    });
});

// HDHomeRun live signal for a channel (only meaningful while it's tuned).
app.get('/api/hdhr/signal/:channelId', requireAuth, async (req, res) => {
    if (!hdhr) return res.status(404).json({ error: 'no HDHomeRun configured' });

    try {
        res.json({ signal: await hdhr.signalFor(req.params.channelId) });
    } catch (err) {
        res.status(502).json({ error: String(err && err.message || err) });
    }
});

// ---- DVR / recordings ----

app.get('/api/recordings', requireAuth, (req, res) => {
    res.json({ ...recorder.list(), scheduled: scheduler.list() });
});

// Schedule a recording for a (future) program.
app.post('/api/recordings/schedule', requireAuth, (req, res) => {
    try {
        const { channelId, title, startMs, durationSec } = req.body || {};

        if (!channelId || !startMs) return res.status(400).json({ error: 'channelId and startMs required' });

        const entry = scheduler.add({
            channelId,
            channelName: channelName.get(channelId) || (req.body || {}).channelName || channelId,
            kind: channelKind.get(channelId) || (req.body || {}).kind,
            title,
            startMs: Number(startMs),
            durationSec: Number(durationSec) || 3600
        });

        res.json({ ok: true, scheduled: entry });
    } catch (err) {
        res.status(409).json({ error: String(err && err.message || err) });
    }
});

app.delete('/api/recordings/schedule/:id', requireAuth, (req, res) => {
    res.json({ ok: scheduler.cancel(req.params.id) });
});

app.post('/api/recordings/start', requireAuth, async (req, res) => {
    try {
        const { channelId, title, minutes } = req.body || {};

        if (!channelId) return res.status(400).json({ error: 'channelId required' });

        const meta = await recorder.start({
            mock: MOCK,
            tablo,
            channelId,
            channelName: channelName.get(channelId) || (req.body || {}).channelName || channelId,
            kind: channelKind.get(channelId) || (req.body || {}).kind,
            hdhrUrl: hdhr ? hdhr.streamUrl(channelId) : undefined,
            title,
            minutes: Math.max(1, Math.min(360, parseInt(minutes, 10) || 60)),
            log: (m) => console.log('[tablo4u] ' + m)
        });

        res.json({ ok: true, recording: meta });
    } catch (err) {
        res.status(503).json({ error: String(err && err.message || err) });
    }
});

app.post('/api/recordings/:id/stop', requireAuth, (req, res) => {
    res.json({ ok: recorder.stop(req.params.id) });
});

app.delete('/api/recordings/:id', requireAuth, (req, res) => {
    res.json({ ok: recorder.remove(req.params.id) });
});

// Play back a saved recording (MPEG-TS, with range support for seeking).
app.get('/api/recordings/:id/file', requireAuth, (req, res) => {
    const rec = recorder.get(req.params.id);

    const file = recorder.resolveFile(rec);

    if (!rec || !file || !fs.existsSync(file)) return res.status(404).send('not found');

    const size = fs.statSync(file).size;

    res.setHeader('Content-Type', 'video/mp2t');

    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;

    const m = range && /bytes=(\d*)-(\d*)/.exec(range);

    if (m && (m[1] || m[2])) {
        // Support "start-", "start-end", and suffix "-N" (last N bytes).
        let startB, endB;

        if (m[1] === '') { startB = Math.max(0, size - parseInt(m[2], 10)); endB = size - 1; }
        else { startB = parseInt(m[1], 10); endB = m[2] ? parseInt(m[2], 10) : size - 1; }

        endB = Math.min(endB, size - 1);

        // Unsatisfiable (start past EOF or inverted) → 416.
        if (isNaN(startB) || startB > endB || startB >= size) {
            res.status(416).setHeader('Content-Range', `bytes */${size}`);
            return res.end();
        }

        res.status(206);
        res.setHeader('Content-Range', `bytes ${startB}-${endB}/${size}`);
        res.setHeader('Content-Length', endB - startB + 1);

        fs.createReadStream(file, { start: startB, end: endB }).pipe(res);
    } else {
        res.setHeader('Content-Length', size);

        fs.createReadStream(file).pipe(res);
    }
});

// Recordings folder (admin): view / change the save location.
app.get('/api/settings/recordings-dir', requireAuth, requireAdmin, (req, res) => {
    res.json({ dir: recorder.getDir() });
});

app.put('/api/settings/recordings-dir', requireAuth, requireAdmin, (req, res) => {
    try {
        res.json({ ok: true, dir: recorder.setDir((req.body || {}).dir) });
    } catch (err) {
        res.status(400).json({ error: String(err && err.message || err) });
    }
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

    // Vendor libs rarely change within a release — let browsers cache them.
    if (url.startsWith('/vendor/')) {
        res.set('Cache-Control', 'public, max-age=86400');
    }

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
    // Always ensure an admin exists — even in OPEN mode — so privileged actions
    // (recordings folder, user admin, device probe) remain available after login.
    // OPEN only skips auth for watching; it no longer elevates anonymous clients.
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

    if (OPEN) {
        console.log('[tablo4u] OPEN=1 — login not required for watching. Admin actions still need an admin sign-in.');
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

            tuners.setLimit(info.tuners); // share the real tuner count with streams + recordings

            console.log(`[tablo4u] Connected to Tablo "${info.device}" as profile "${info.profile}" (${info.tuners} tuners).`);

            await getChannels(); // warm the kind index

            warmResolutions(); // background: fetch HD/SD from the device
        } catch (err) {
            console.error('[tablo4u] Tablo login failed:', err && err.message || err);
        }
    } else {
        console.error('[tablo4u] No TABLO_EMAIL / TABLO_PASSWORD (and MOCK off). Data calls will error.');
    }

    // Optional HDHomeRun (in addition to / instead of Tablo). Its channels merge
    // into the guide; program data is borrowed from the Tablo guide by channel
    // number. HDHR has its own tuners (separate pool).
    if (!MOCK && process.env.HDHR_URL) {
        hdhr = new HdhrClient(process.env.HDHR_URL);

        try {
            const info = await hdhr.connect();

            tuners.setLimit(hdhr.tuners, 'hdhr');

            await hdhr.getChannels(); // warm the id→URL map

            console.log(`[tablo4u] HDHomeRun "${info.FriendlyName || info.ModelNumber || 'device'}" — ${hdhr.tuners} tuners at ${process.env.HDHR_URL}`);
        } catch (err) {
            console.error('[tablo4u] HDHomeRun connect failed:', err && err.message || err);

            hdhr = null;
        }
    }

    // DVR scheduler: fire a scheduled recording by starting a normal recording.
    scheduler.setFire((entry) => recorder.start({
        mock: MOCK,
        tablo,
        channelId: entry.channelId,
        channelName: entry.channelName,
        kind: entry.kind,
        hdhrUrl: hdhr ? hdhr.streamUrl(entry.channelId) : undefined,
        title: entry.title,
        minutes: entry.minutes,
        log: (m) => console.log('[tablo4u] (scheduled) ' + m)
    }));

    scheduler.setBusy(() => recorder.activeWindows());

    scheduler.start();

    app.listen(PORT, () => {
        console.log(`[tablo4u] Web UI on http://localhost:${PORT}${OPEN ? '  (open)' : '  (login required)'}`);
    });
})();
