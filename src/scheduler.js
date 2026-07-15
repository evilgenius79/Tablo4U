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

/** @type {(entry:any)=>Promise<any>} */
let fireFn = null;

let sweepTimer = null;

function load() {
    try { const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(a) ? a : []; }
    catch { return []; }
}

function save(list) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

/**
 * Max number of OTA schedules that overlap at any instant within [start,end),
 * counting the ones already scheduled plus (optionally) a candidate window.
 * OTT schedules use no tuner and are ignored.
 * @param {number} start
 * @param {number} end
 * @param {any[]} list
 * @returns {number}
 */
function maxOverlap(start, end, list) {
    const events = [];

    for (const e of list) {
        if (e.kind === 'ott' || e.status !== 'scheduled') continue;

        if (e.endMs <= start || e.startMs >= end) continue; // no overlap with window

        events.push([Math.max(e.startMs, start), 1]);

        events.push([Math.min(e.endMs, end), -1]);
    }

    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    let cur = 0;

    let max = 0;

    for (const [, d] of events) { cur += d; if (cur > max) max = cur; }

    return max;
}

const Scheduler = {
    /** @param {(entry:any)=>Promise<any>} fn called to actually start a recording */
    setFire(fn) { fireFn = fn; },

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

        const durationSec = Math.max(60, Math.round(o.durationSec || 3600));

        const endMs = startMs + (durationSec + POST_PAD_SEC) * 1000;

        if (!startMs || endMs <= Date.now()) throw new Error('that program has already ended');

        const list = load();

        // Upfront OTA tuner-conflict check.
        if (o.kind !== 'ott') {
            const concurrent = maxOverlap(startMs, endMs, list) + 1; // +1 for this one

            if (concurrent > tuners.getLimit()) {
                throw new Error(`tuner conflict — ${concurrent} OTA recordings would overlap but only ${tuners.getLimit()} tuners exist`);
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
        const now = Date.now();

        const list = load();

        for (const e of list) {
            if (e.status !== 'scheduled') continue;

            if (now >= e.endMs) { Scheduler._finish(e.id, 'missed'); continue; }

            if (now >= e.startMs && fireFn) {
                // Mark first so a slow fire isn't double-triggered by the next sweep.
                Scheduler._finish(e.id, 'recording');

                const remainingSec = Math.max(60, Math.round((e.endMs - now) / 1000));

                try {
                    const rec = await fireFn({ ...e, minutes: remainingSec / 60 });

                    Scheduler._finish(e.id, 'recording', { recordingId: rec && rec.id });
                } catch (err) {
                    Scheduler._finish(e.id, 'failed', { error: String(err && err.message || err) });
                }
            }
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
