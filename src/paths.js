// @ts-check
/**
 * @file Path helpers that work both when run as a normal Node script and when
 * packaged into a single executable with pkg.
 *
 * - Web assets (public/) are embedded read-only inside the exe snapshot, so
 *   they resolve relative to __dirname.
 * - Writable/config files (.env, data/) must live NEXT TO the exe, not in the
 *   read-only snapshot — so they resolve relative to the executable's folder.
 */

const path = require('path');

/**
 * Directory for writable state and config (.env, data/). Next to the exe when
 * packaged, else the project root.
 *
 * @returns {string}
 */
function baseDir() {
    // @ts-ignore - process.pkg is set only inside a pkg-built executable
    if (process.pkg) {
        return path.dirname(process.execPath);
    }

    return path.join(__dirname, '..');
}

module.exports = { baseDir };
