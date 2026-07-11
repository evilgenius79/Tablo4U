// @ts-check
/**
 * @file Live stream handler. Fetches a Tablo watch session, then pipes the
 * stream to the browser as MPEG-TS (played client-side by mpegts.js):
 *   - OTT channels are usually already H.264/AAC → ffmpeg `-c copy` (cheap remux)
 *   - OTA channels are MPEG-2/AC3 → ffmpeg transcodes to H.264/AAC
 * In MOCK mode it emits a test pattern so the player is demoable without a Tablo.
 */

const { spawn } = require('child_process');

/** Max concurrent streams (Tablo tuners). */
const TUNER_COUNT = parseInt(process.env.TUNER_COUNT || '4', 10);

var current = 0;

/**
 * ffmpeg args for a mock test pattern (color bars + tone).
 * @returns {string[]}
 */
function mockArgs() {
    return [
        '-re',
        '-f', 'lavfi', '-i', 'testsrc=size=960x540:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '30',
        '-c:a', 'aac', '-b:a', '128k',
        '-f', 'mpegts', 'pipe:1'
    ];
}

/**
 * ffmpeg args for a real Tablo stream.
 * @param {string} playlistUrl
 * @param {boolean} transcode - true for OTA (MPEG-2/AC3), false to copy
 * @returns {string[]}
 */
function tabloArgs(playlistUrl, transcode) {
    const input = [
        '-fflags', '+nobuffer+genpts',
        '-analyzeduration', '1000000',
        '-probesize', '1000000',
        '-http_persistent', '1',
        '-i', playlistUrl
    ];

    const output = transcode
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-c:a', 'aac', '-b:a', '160k']
        : ['-c', 'copy'];

    return [...input, ...output, '-f', 'mpegts', 'pipe:1'];
}

/**
 * Handles GET /api/stream/:channelId.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} opts
 * @param {boolean} opts.mock
 * @param {import('./tablo').TabloClient|null} opts.tablo
 * @param {(id:string)=>('ota'|'ott'|undefined)} opts.kindOf
 * @param {(msg:string)=>void} [opts.log]
 */
async function handleStream(req, res, opts) {
    const log = opts.log || (() => {});

    const channelId = req.params.channelId;

    if (current >= TUNER_COUNT) {
        res.status(503).send('All tuners are in use.');

        return;
    }

    /** @type {string[]} */
    let args;

    if (opts.mock) {
        args = mockArgs();
    } else {
        if (!opts.tablo) {
            res.status(502).send('Tablo not connected.');

            return;
        }

        let watch;

        try {
            watch = await opts.tablo.watch(channelId);
        } catch (err) {
            res.status(502).send('watch failed: ' + (err && err.message || err));

            return;
        }

        if (!watch || !watch.playlist_url) {
            res.status(502).json(watch && watch.error ? { error: watch.error } : { error: 'no playlist_url' });

            return;
        }

        const transcode = opts.kindOf(channelId) !== 'ott'; // default to transcode unless known-OTT

        args = tabloArgs(watch.playlist_url, transcode);
    }

    current += 1;

    log(`[${current}/${TUNER_COUNT}] stream start ${channelId}${opts.mock ? ' (mock)' : ''}`);

    const ffmpeg = spawn('ffmpeg', args);

    var done = false;

    const cleanup = () => {
        if (done) return;

        done = true;

        current = Math.max(0, current - 1);

        ffmpeg.kill('SIGKILL');

        log(`[${current}/${TUNER_COUNT}] stream end ${channelId}`);
    };

    res.setHeader('Content-Type', 'video/mp2t');

    ffmpeg.stdout.pipe(res);

    ffmpeg.on('error', (err) => {
        // most commonly: ffmpeg not on PATH
        if (!res.headersSent) res.status(500).send('ffmpeg failed: ' + err.message);
        else res.end();

        cleanup();
    });

    ffmpeg.stderr.on('data', () => { /* swallow unless debugging */ });

    ffmpeg.on('close', () => { if (!res.writableEnded) res.end(); cleanup(); });

    req.on('close', cleanup);

    res.on('close', cleanup);
}

module.exports = { handleStream, TUNER_COUNT };
