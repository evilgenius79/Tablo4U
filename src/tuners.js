// @ts-check
/**
 * @file Tuner-slot accounting, per source pool. Live streaming and recording
 * both draw from the same physical OTA tuners, so they reserve/release through
 * here to avoid oversubscribing a device. Tablo and HDHomeRun have separate
 * physical tuners, so each has its own pool. OTT never uses a tuner.
 */

/** @type {Record<string, {limit:number, count:number}>} */
const pools = {
    tablo: { limit: 4, count: 0 },
    hdhr: { limit: 0, count: 0 }
};

function pool(name) {
    if (!pools[name]) pools[name] = { limit: 4, count: 0 };

    return pools[name];
}

module.exports = {
    /** @param {number} n @param {string} [name] */
    setLimit(n, name = 'tablo') { pool(name).limit = Math.max(0, n || 0); },

    /** @param {string} [name] */
    getLimit(name = 'tablo') { return pool(name).limit; },

    /** @param {string} [name] */
    inUse(name = 'tablo') { return pool(name).count; },

    /** Reserve one slot. @param {string} [name] @returns {boolean} false if the pool is full. */
    tryReserve(name = 'tablo') {
        const p = pool(name);

        if (p.count >= p.limit) return false;

        p.count += 1;

        return true;
    },

    /** @param {string} [name] */
    release(name = 'tablo') { const p = pool(name); p.count = Math.max(0, p.count - 1); }
};
