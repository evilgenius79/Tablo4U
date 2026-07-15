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
const { atomicWrite } = require('./fsatomic');
const tuners = require('./tuners');
const { buildArgs } = require('./stream');

const DATA_DIR = path.join(baseDir(), 'data');
const INDEX_FILE = path.join(DATA_DIR, 'recordings.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

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
    atomicWrite(file, JSON.stringify(data, null, 2));
}

/** @returns {string} the configured recordings directory. */
function getDir() {
    const cfg = readJson(CONFIG_FILE, {});

    const dir = cfg.recordingsDir || process.env.RECORDINGS_DIR || path.join(baseDir(), 'recordings');

    return dir;
}

/** @param {string} dir */
function setDir(dir) {
    dir = String(dir || '').trim();

    if (!dir) throw new Error('folder required');

    ensureDir(dir); // fails early if the path is invalid / not creatable

    const cfg = readJson(CONFIG_FILE, {});

    cfg.recordingsDir = dir;

    writeJson(CONFIG_FILE, cfg);

    return dir;
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

    const poolName = isHdhr ? 'hdhr' : isOtt ? 'ott' : 'tablo';

    const usesSlot = !o.mock;

    if (usesSlot && !tuners.tryReserve(poolName)) {
        throw new Error(poolName === 'ott' ? 'Too many OTT streams active — cannot record.' : 'All tuners are in use — cannot start recording.');
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
        if (usesSlot) tuners.release(poolName);

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

    log(`record start "${meta.title}" (${o.channelName}) → ${base}${usesSlot ? ` [${poolName} ${tuners.inUse(poolName)}/${tuners.getLimit(poolName)}]` : ' (mock)'}`);

    if (process.env.STREAM_DEBUG == '1') {
        ffmpeg.stderr.on('data', (d) => process.stderr.write('[rec] ' + d));
    } else {
        ffmpeg.stderr.on('data', () => {});
    }

    const finish = (status) => {
        if (!active.has(id)) return;

        active.delete(id);

        if (usesSlot) tuners.release(poolName);

        // Deleted mid-record: don't re-add it to the index, and now that ffmpeg
        // has exited the file handle is closed — safe to unlink (matters on
        // Windows, where an open file can't be deleted).
        if (removed.has(id)) {
            removed.delete(id);
            try { fs.unlinkSync(file); } catch { /* already gone */ }
            log(`record end "${meta.title}" — deleted`);
            return;
        }

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

    // Persist the reconciled statuses so they don't stay inconsistent forever.
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
    const wasActive = active.has(id);

    if (wasActive) { removed.add(id); stop(id); } // finish() unlinks after ffmpeg exits

    const arr = loadIndex();

    const rec = arr.find(r => r.id === id);

    // For a finished recording, unlink now. For an in-flight one, leave the file
    // to finish() (unlinking an open file fails on Windows).
    if (!wasActive && rec && rec.file) { try { fs.unlinkSync(rec.file); } catch { /* already gone */ } }

    saveIndex(arr.filter(r => r.id !== id));

    return true;
}

module.exports = { start, stop, list, get, remove, getDir, setDir };
