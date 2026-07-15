// @ts-check
/**
 * @file Atomic JSON persistence — write to a temp file then rename, so a crash
 * mid-write can't truncate/corrupt users.json, schedule.json, or recordings.json
 * (rename is atomic on the same filesystem).
 */

const fs = require('fs');

/**
 * @param {string} file
 * @param {string} data
 * @param {number} [mode]
 */
function atomicWrite(file, data, mode) {
    const tmp = `${file}.${process.pid}.tmp`;

    fs.writeFileSync(tmp, data, mode ? { mode } : undefined);

    try {
        fs.renameSync(tmp, file);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }

        throw err;
    }
}

module.exports = { atomicWrite };
