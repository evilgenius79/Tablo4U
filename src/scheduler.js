// @ts-check
/**
 * @file DVR scheduler. Persists upcoming scheduled recordings to
 * data/schedule.json and fires them at their start time via a periodic sweep
 * (robust across restarts — no long-lived timers). At fire time the recorder
 * still enforces the tuner limit, and scheduling does an upfront OTA
 * tuner-conflict check so users can't queue more simultaneous OTA recordings
 * than the device has tuners.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { baseDir } = require('./paths');
const tuners = require('./tuners');

const DATA_DIR = path.join(baseDir(), 'data');
const FILE = path.join(DATA_DIR, 'schedule.json');

// Record a bit past the listed end so overruns (sports, live TV) aren't cut off.
const POST_PAD_SEC = 120;

/** Max duration for a single scheduled recording (6 hours), matching instant-record cap. */
const MAX_DURATION_SEC = 6 * 60 * 60;

/** Soft cap on how many schedule entries may exist at once. */
const MAX_SCHEDULED = Math.max(10, parseInt(process.env.MAX_SCHEDULED || '100', 10) || 100);

/** @type {(entry:any)=>Promise<any>} */
let fireFn = null;

/** @type {(() => {channelId:string, kind:string, startMs:number, endMs:number}[]) | null} */
let busyFn = null;

let sweepTimer = null;

/** Prevent overlapping sweeps from double-firing the same entry. */
let sweeping = false;

function load() {
    try { const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(a) ? a : []; }
    catch { return []; }
}

function save(list) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, FILE);
}

/** Which tuner pool a schedule draws from — HDHR and Tablo are separate. */
function poolOf(entry) {
    return String(entry.channelId || '').startsWith('hdhr:') ? 'hdhr' : 'tablo';
}

/**
 * Max number of OTA schedules in one tuner pool that overlap at any instant
 * within [start,end). OTT schedules use no tuner and are ignored, and only
 * schedules in the same pool count against each other. Optional `extra` busy
 * windows (e.g. already-recording sessions) are included.
 * @param {number} start
 * @param {number} end
 * @param {any[]} list
 * @param {string} poolName
 * @param {{channelId?:string, kind?:string, startMs:number, endMs:number}[]} [extra]
 * @returns {number}
 */
function maxOverlap(start, end, list, poolName, extra = []) {
    const events = [];

    const consider = (e) => {
        if (e.kind === 'ott') return;

        if (poolOf(e) !== poolName) return;

        if (e.endMs <= start || e.startMs >= end) return; // no overlap with window

        events.push([Math.max(e.startMs, start), 1]);

        events.push([Math.min(e.endMs, end), -1]);
    };

    for (const e of list) {
        if (e.status !== 'scheduled' && e.status !== 'recording') continue;

        consider(e);
    }

    for (const e of extra) consider(e);

    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    let cur = 0;

    let max = 0;

    for (const [, d] of events) { cur += d; if (cur > max) max = cur; }

    return max;
}

const Scheduler = {
    /** @param {(entry:any)=>Promise<any>} fn called to actually start a recording */
    setFire(fn) { fireFn = fn; },

    /** Optional: returns currently-busy OTA windows from the recorder. */
    setBusy(fn) { busyFn = fn; },

    /** @returns {any[]} */
    list() { return load(); },

    /**
     * Adds a scheduled recording.
     * @param {object} o
     * @param {string} o.channelId
     * @param {string} o.channelName
     * @param {'ota'|'ott'|undefined} o.kind
     * @param {string} o.title
     * @param {number} o.startMs
     * @param {number} o.durationSec
     * @returns {any} the created entry
     */
    add(o) {
        const startMs = Number(o.startMs);

        const durationSec = Math.min(MAX_DURATION_SEC, Math.max(60, Math.round(o.durationSec || 3600)));

        const endMs = startMs + (durationSec + POST_PAD_SEC) * 1000;

        if (!startMs || endMs <= Date.now()) throw new Error('that program has already ended');

        const list = load();

        const pending = list.filter(e => e.status === 'scheduled' || e.status === 'recording').length;

        if (pending >= MAX_SCHEDULED) {
            throw new Error(`too many scheduled recordings (max ${MAX_SCHEDULED})`);
        }

        // Upfront OTA tuner-conflict check, per pool (HDHR vs Tablo), including
        // recordings already in flight.
        if (o.kind !== 'ott') {
            const poolName = poolOf(o);

            const busy = busyFn ? busyFn() : [];

            const concurrent = maxOverlap(startMs, endMs, list, poolName, busy) + 1; // +1 for this one

            if (concurrent > tuners.getLimit(poolName)) {
                const label = poolName === 'hdhr' ? 'HDHomeRun' : 'Tablo';

                throw new Error(`tuner conflict — ${concurrent} ${label} recordings would overlap but only ${tuners.getLimit(poolName)} tuners exist`);
            }
        }

        const entry = {
            id: Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
            channelId: o.channelId,
            channelName: o.channelName || o.channelId,
            kind: o.kind || 'ota',
            title: o.title || o.channelName || 'Recording',
            startMs,
            endMs,
            durationSec: durationSec + POST_PAD_SEC,
            status: 'scheduled',
            createdAt: Date.now()
        };

        list.push(entry);

        save(list);

        return entry;
    },

    /** Cancels/dismisses a schedule entry by removing it. If it hasn't fired
     * yet this stops it from firing; if it already started, the actual recording
     * (tracked by the recorder) keeps going. @param {string} id */
    cancel(id) {
        const list = load();

        const idx = list.findIndex(x => x.id === id);

        if (idx < 0) return false;

        list.splice(idx, 1);

        save(list);

        return true;
    },

    /** Marks a fired schedule with its outcome (called by the sweep). */
    _finish(id, status, extra) {
        const list = load();

        const e = list.find(x => x.id === id);

        if (!e) return;

        e.status = status;

        if (extra) Object.assign(e, extra);

        save(list);
    },

    /** Fire anything due; mark anything whose window fully passed as missed. */
    async sweep() {
        if (sweeping) return;

        sweeping = true;

        try {
            const now = Date.now();

            const list = load();

            for (const e of list) {
                if (e.status !== 'scheduled') continue;

                if (now >= e.endMs) { Scheduler._finish(e.id, 'missed'); continue; }

                if (now >= e.startMs && fireFn) {
                    // Mark first so a slow fire isn't double-triggered by the next sweep.
                    Scheduler._finish(e.id, 'recording');

                    const remainingSec = Math.max(60, Math.min(MAX_DURATION_SEC, Math.round((e.endMs - now) / 1000)));

                    try {
                        const rec = await fireFn({ ...e, minutes: remainingSec / 60 });

                        Scheduler._finish(e.id, 'recording', { recordingId: rec && rec.id });
                    } catch (err) {
                        Scheduler._finish(e.id, 'failed', { error: String(err && err.message || err) });
                    }
                }
            }
        } finally {
            sweeping = false;
        }
    },

    /** Starts the periodic sweep (idempotent). */
    start() {
        if (sweepTimer) return;

        sweepTimer = setInterval(() => { Scheduler.sweep().catch(() => {}); }, 20000);

        // Run once shortly after boot to catch anything already due.
        setTimeout(() => { Scheduler.sweep().catch(() => {}); }, 3000);
    }
};

module.exports = Scheduler;
