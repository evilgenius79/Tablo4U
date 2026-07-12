// @ts-check
/**
 * @file Shared tuner-slot accounting. Both live streaming and recording draw
 * from the same physical OTA tuners, so they reserve/release through here to
 * avoid oversubscribing the device (e.g. 4 tuners → at most 4 concurrent OTA
 * streams+recordings). OTT never uses a tuner and never reserves.
 */

let limit = 4;

let count = 0;

module.exports = {
    /** @param {number} n real tuner count from the device */
    setLimit(n) { limit = Math.max(1, n || 4); },

    getLimit() { return limit; },

    inUse() { return count; },

    /** Reserve one slot. @returns {boolean} false if all tuners are busy. */
    tryReserve() {
        if (count >= limit) return false;

        count += 1;

        return true;
    },

    release() { count = Math.max(0, count - 1); }
};
