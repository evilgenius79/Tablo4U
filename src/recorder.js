// @ts-check
/**
 * @file DVR recorder. Records a channel to an MPEG-TS file on the server using
 * the same ffmpeg pipeline as live streaming, reserving a tuner for OTA so
 * recordings + live can't oversubscribe the device. Metadata persists to
 * data/recordings.json; the destination folder is configurable
 * (data/config.json → recordingsDir, or the RECORDINGS_DIR env, or ./recordings
 * next to the exe).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { baseDir } = require('./paths');
const tuners = require('./tuners');
const { buildArgs } = require('./stream');

const DATA_DIR = path.join(baseDir(), 'data');
const INDEX_FILE = path.join(DATA_DIR, 'recordings.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/** Soft cap on concurrent ffmpeg processes that don't use a physical tuner (OTT / mock). */
const MAX_NON_TUNER = Math.max(1, parseInt(process.env.MAX_NON_TUNER_FFMPEG || '4', 10) || 4);

let nonTunerCount = 0;

/** id -> { proc, meta } for in-flight recordings. */
const active = new Map();

/** ids deleted while still recording — so finish() doesn't resurrect them. */
const removed = new Set();

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
    ensureDir(path.dirname(file));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

/**
 * Root under which recordings must live. RECORDINGS_ROOT overrides; otherwise
 * anything under the app/exe folder (baseDir) is allowed — so the default
 * ./recordings and sibling folders work without extra config. Point
 * RECORDINGS_ROOT at an external drive (e.g. /mnt/media) when recordings live
 * outside the app folder.
 * @returns {string}
 */
function recordingsRoot() {
    const root = process.env.RECORDINGS_ROOT || baseDir();

    return path.resolve(root);
}

/**
 * Resolve `dir` and require it to stay under recordingsRoot().
 * @param {string} dir
 * @returns {string}
 */
function containDir(dir) {
    const root = recordingsRoot();

    const resolved = path.resolve(dir);

    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error('recordings folder must be under ' + root);
    }

    return resolved;
}

/** Default recordings folder: ./recordings under the app, or RECORDINGS_ROOT itself. */
function defaultDir() {
    const underApp = path.join(baseDir(), 'recordings');

    try { return containDir(underApp); } catch { return recordingsRoot(); }
}

/** @returns {string} the configured recordings directory. */
function getDir() {
    const cfg = readJson(CONFIG_FILE, {});

    const dir = cfg.recordingsDir || process.env.RECORDINGS_DIR || defaultDir();

    try {
        return containDir(dir);
    } catch {
        // Misconfigured/persisted path outside the allowlist — fall back safely.
        return defaultDir();
    }
}

/** @param {string} dir */
function setDir(dir) {
    dir = String(dir || '').trim();

    if (!dir) throw new Error('folder required');

    const resolved = containDir(dir);

    ensureDir(resolved); // fails early if the path is invalid / not creatable

    const cfg = readJson(CONFIG_FILE, {});

    cfg.recordingsDir = resolved;

    writeJson(CONFIG_FILE, cfg);

    return resolved;
}

/** @returns {any[]} persisted recording metadata (newest first). */
function loadIndex() {
    const arr = readJson(INDEX_FILE, []);

    return Array.isArray(arr) ? arr : [];
}

function saveIndex(arr) {
    writeJson(INDEX_FILE, arr);
}

/** Upsert one record into the persisted index. */
function upsert(meta) {
    const arr = loadIndex();

    const i = arr.findIndex(r => r.id === meta.id);

    if (i >= 0) arr[i] = meta; else arr.unshift(meta);

    saveIndex(arr);
}

function sanitize(s) {
    return String(s || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'rec';
}

function stamp(d) {
    const p = (n) => String(n).padStart(2, '0');

    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Absolute path for a recording file, always under getDir(). Prefers the
 * basename stored as `name` so a tampered `file` field in JSON can't LFI.
 * @param {any} rec
 * @returns {string|null}
 */
function resolveFile(rec) {
    if (!rec) return null;

    const name = path.basename(String(rec.name || rec.file || ''));

    if (!name || name === '.' || name === '..') return null;

    const root = getDir();

    const file = path.resolve(root, name);

    if (file !== root && !file.startsWith(root + path.sep)) return null;

    return file;
}

/**
 * Starts a recording.
 *
 * @param {object} o
 * @param {boolean} o.mock
 * @param {import('./tablo').TabloClient|null} o.tablo
 * @param {string} o.channelId
 * @param {string} o.channelName
 * @param {'ota'|'ott'|undefined} o.kind
 * @param {string} [o.hdhrUrl] direct HDHomeRun stream URL (for HDHR channels)
 * @param {string} [o.title]
 * @param {number} o.minutes
 * @param {(m:string)=>void} [o.log]
 * @returns {Promise<any>} the recording metadata
 */
async function start(o) {
    const isOtt = o.kind === 'ott';

    const isHdhr = String(o.channelId || '').startsWith('hdhr:');

    const poolName = isHdhr ? 'hdhr' : 'tablo';

    const usesTuner = !isOtt && !o.mock;

    if (usesTuner && !tuners.tryReserve(poolName)) {
        throw new Error('All tuners are in use — cannot start recording.');
    }

    // OTT/mock don't share the physical tuner pool — enforce a separate ceiling
    // so one user can't spawn unbounded ffmpeg processes.
    if (!usesTuner) {
        if (nonTunerCount >= MAX_NON_TUNER) {
            throw new Error('Too many concurrent non-tuner recordings — try again later.');
        }

        nonTunerCount += 1;
    }

    const durationSec = Math.max(1, Math.round((o.minutes || 60) * 60));

    const dir = getDir();

    ensureDir(dir);

    const id = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

    const base = `${sanitize(o.channelName)}${o.title ? '_' + sanitize(o.title) : ''}_${stamp(new Date())}_${id}.ts`;

    const file = path.join(dir, base);

    /** @type {string[]} */
    let args;

    try {
        args = await buildArgs({ mock: o.mock, tablo: o.tablo, channelId: o.channelId, isOtt, hdhrUrl: o.hdhrUrl, out: file, durationSec });
    } catch (err) {
        if (usesTuner) tuners.release(poolName);
        else nonTunerCount = Math.max(0, nonTunerCount - 1);

        throw new Error('stream failed: ' + (err && err.message || err));
    }

    const meta = {
        id,
        channelId: o.channelId,
        channelName: o.channelName || o.channelId,
        title: o.title || o.channelName || 'Recording',
        kind: o.kind || 'ota',
        file,
        name: base,
        startedAt: Date.now(),
        plannedSec: durationSec,
        endedAt: null,
        bytes: 0,
        status: 'recording'
    };

    upsert(meta);

    const log = o.log || (() => {});

    const ffmpeg = spawn('ffmpeg', args);

    active.set(id, { proc: ffmpeg, meta });

    log(`record start "${meta.title}" (${o.channelName}) → ${base}${usesTuner ? ` [${poolName} ${tuners.inUse(poolName)}/${tuners.getLimit(poolName)}]` : ' (ott, no tuner)'}`);

    if (process.env.STREAM_DEBUG == '1') {
        ffmpeg.stderr.on('data', (d) => process.stderr.write('[rec] ' + d));
    } else {
        ffmpeg.stderr.on('data', () => {});
    }

    const finish = (status) => {
        if (!active.has(id)) return;

        active.delete(id);

        if (usesTuner) tuners.release(poolName);
        else nonTunerCount = Math.max(0, nonTunerCount - 1);

        // Deleted mid-record: don't re-add it to the index (or its file is gone).
        if (removed.has(id)) { removed.delete(id); log(`record end "${meta.title}" — deleted`); return; }

        meta.endedAt = Date.now();

        try { meta.bytes = fs.statSync(file).size; } catch { /* file may not exist on failure */ }

        // If ffmpeg produced nothing, mark it failed rather than a 0-byte "done".
        meta.status = (status === 'stopped') ? 'stopped' : (meta.bytes > 0 ? 'done' : 'failed');

        upsert(meta);

        log(`record end "${meta.title}" — ${meta.status} (${Math.round(meta.bytes / 1e6)} MB)`);
    };

    ffmpeg.on('error', () => finish('failed'));

    ffmpeg.on('close', () => finish(meta.status === 'stopping' ? 'stopped' : 'done'));

    return meta;
}

/** Stops an in-flight recording (keeps what's recorded so far). */
function stop(id) {
    const rec = active.get(id);

    if (!rec) return false;

    rec.meta.status = 'stopping';

    // SIGINT lets ffmpeg finalize the file; force-kill shortly after if needed.
    try { rec.proc.kill('SIGINT'); } catch { /* ignore */ }

    setTimeout(() => { try { rec.proc.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);

    return true;
}

/**
 * Busy OTA windows currently recording (for scheduler conflict checks).
 * @returns {{channelId:string, kind:string, startMs:number, endMs:number}[]}
 */
function activeWindows() {
    const out = [];

    for (const { meta } of active.values()) {
        if (meta.kind === 'ott') continue;

        out.push({
            channelId: meta.channelId,
            kind: meta.kind || 'ota',
            startMs: meta.startedAt,
            endMs: meta.startedAt + (meta.plannedSec || 3600) * 1000
        });
    }

    return out;
}

/** @returns {{active:any[], saved:any[], dir:string, tuners:{inUse:number, limit:number}}} */
function list() {
    const idx = loadIndex();

    // Reconcile: anything marked recording but not actually active (e.g. after a
    // restart) is stale — report it as stopped so the UI isn't misleading.
    const activeIds = new Set(active.keys());

    const activeList = [];

    const saved = [];

    let dirty = false;

    for (const r of idx) {
        if (r.status === 'recording' && activeIds.has(r.id)) activeList.push(r);
        else if (r.status === 'recording') { r.status = 'stopped'; dirty = true; saved.push(r); }
        else saved.push(r);
    }

    if (dirty) saveIndex(idx);

    return {
        active: activeList,
        saved,
        dir: getDir(),
        tuners: { inUse: tuners.inUse(), limit: tuners.getLimit() }
    };
}

/** @param {string} id */
function get(id) {
    return loadIndex().find(r => r.id === id) || null;
}

/** Deletes a recording (file + index entry). Stops it first if in-flight. */
function remove(id) {
    if (active.has(id)) { removed.add(id); stop(id); } // don't let finish() resurrect it

    const arr = loadIndex();

    const rec = arr.find(r => r.id === id);

    if (rec) {
        const file = resolveFile(rec);

        if (file) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
    }

    saveIndex(arr.filter(r => r.id !== id));

    return true;
}

module.exports = { start, stop, list, get, remove, getDir, setDir, resolveFile, activeWindows, recordingsRoot };
