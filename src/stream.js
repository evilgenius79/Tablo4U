// @ts-check
/**
 * @file Live stream handler. Pipes a channel to the browser as MPEG-TS
 * (played client-side by mpegts.js):
 *   - OTA: request a watch session from the device (uses a tuner) and
 *     transcode MPEG-2/AC3 → H.264/AAC.
 *   - OTT: stream the direct URL from the lineup (`ott.streamUrl`) — no watch
 *     session, no tuner used — and remux to MPEG-TS.
 * In MOCK mode it emits a test pattern so the player is demoable without a Tablo.
 */

const { spawn } = require('child_process');

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
 * OTA: transcode the device HLS to H.264/AAC with ~1s keyframes.
 * @param {string} playlistUrl
 * @returns {string[]}
 */
function otaArgs(playlistUrl) {
    return [
        '-fflags', '+nobuffer+genpts',
        '-analyzeduration', '1000000',
        '-probesize', '1000000',
        '-http_persistent', '1',
        '-i', playlistUrl,
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '160k',
        '-f', 'mpegts', '-flush_packets', '1', 'pipe:1'
    ];
}

/**
 * OTT copy (cheap remux). Works on feeds without mid-stream discontinuities;
 * opt in with OTT_COPY=1. Kept as an option because it's the lightest path.
 * @param {string} url
 * @returns {string[]}
 */
function ottCopyArgs(url) {
    return [
        '-fflags', '+genpts+discardcorrupt',
        '-analyzeduration', '2000000',
        '-probesize', '2000000',
        '-http_persistent', '1',
        '-i', url,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'mpegts', '-flush_packets', '1', 'pipe:1'
    ];
}

/**
 * OTT default: transcode the device's HLS to a continuous H.264/AAC MPEG-TS.
 * FAST/OTT feeds splice ads with HLS discontinuities and timestamp resets that
 * `-c copy` passes straight through — which is what makes mpegts.js skip and
 * break up. Re-encoding normalizes timestamps and codecs, so playback is
 * smooth at the cost of some CPU. Set OTT_COPY=1 to use the cheap copy path.
 * @param {string} url
 * @returns {string[]}
 */
function ottArgs(url) {
    if (process.env.OTT_COPY == '1') return ottCopyArgs(url);

    return [
        '-fflags', '+genpts',
        '-analyzeduration', '2000000',
        '-probesize', '2000000',
        '-http_persistent', '1',
        '-i', url,
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
        '-max_muxing_queue_size', '1024',
        '-f', 'mpegts', '-flush_packets', '1', 'pipe:1'
    ];
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
 * @param {number} opts.tunerCount
 * @param {(msg:string)=>void} [opts.log]
 */
async function handleStream(req, res, opts) {
    const log = opts.log || (() => {});

    const channelId = req.params.channelId;

    const isOtt = opts.kindOf(channelId) === 'ott';

    // Only OTA channels consume a physical tuner. OTT still goes through the
    // device's /watch endpoint (that's what actually returns a playable HLS
    // playlist — the lineup's direct streamUrl isn't reliably playable), but it
    // doesn't occupy a tuner slot.
    const usesTuner = !isOtt && !opts.mock;

    const limit = opts.tunerCount || 4;

    if (usesTuner && current >= limit) {
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

        // OTT is already H.264/AAC → copy; OTA (MPEG-2/AC3) → transcode.
        args = isOtt ? ottArgs(watch.playlist_url) : otaArgs(watch.playlist_url);
    }

    if (usesTuner) current += 1;

    log(`stream start ${channelId}${opts.mock ? ' (mock)' : isOtt ? ' (ott, no tuner)' : ` [${current}/${limit}]`}`);

    const ffmpeg = spawn('ffmpeg', args);

    var done = false;

    const cleanup = () => {
        if (done) return;

        done = true;

        if (usesTuner) current = Math.max(0, current - 1);

        ffmpeg.kill('SIGKILL');

        log(`stream end ${channelId}${usesTuner ? ` [${current}/${limit}]` : ''}`);
    };

    res.setHeader('Content-Type', 'video/mp2t');

    ffmpeg.stdout.pipe(res);

    ffmpeg.on('error', (err) => {
        // most commonly: ffmpeg not on PATH
        if (!res.headersSent) res.status(500).send('ffmpeg failed: ' + err.message);
        else res.end();

        cleanup();
    });

    // Set STREAM_DEBUG=1 to see ffmpeg's progress (speed=, fps, drops) — useful
    // if a stream buffers: speed below ~1x means the transcode can't keep up.
    if (process.env.STREAM_DEBUG == '1') {
        ffmpeg.stderr.on('data', (d) => process.stderr.write('[ffmpeg] ' + d));
    } else {
        ffmpeg.stderr.on('data', () => {});
    }

    ffmpeg.on('close', () => { if (!res.writableEnded) res.end(); cleanup(); });

    req.on('close', cleanup);

    res.on('close', cleanup);
}

module.exports = { handleStream };
