// @ts-check
/**
 * @file Input validation helpers for API boundaries. Channel IDs and dates come
 * from URLs and get interpolated into signed device paths and cache keys, so
 * they're validated to safe formats to block path traversal / cache poisoning.
 */

/**
 * A channel id is either a Tablo identifier ("S35595_004_01", "O1_206_00") or an
 * HDHomeRun one ("hdhr:6.1"). Anything with slashes, dots, %-escapes, etc. is
 * rejected so it can't traverse into arbitrary device paths.
 * @param {any} id
 * @returns {boolean}
 */
function validChannelId(id) {
    if (typeof id !== 'string' || id.length > 64) return false;

    if (id.startsWith('hdhr:')) return /^hdhr:\d{1,5}(\.\d{1,5})?$/.test(id);

    return /^[A-Za-z0-9_]+$/.test(id);
}

/**
 * @param {any} d
 * @returns {boolean} true for a strict YYYY-MM-DD calendar date
 */
function validDate(d) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;

    const t = Date.parse(d + 'T00:00:00Z');

    return !isNaN(t);
}

module.exports = { validChannelId, validDate };
