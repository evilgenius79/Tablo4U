// @ts-check
/**
 * @file Live stream handler + shared ffmpeg arg builders. Streams a channel to
 * the browser as MPEG-TS (played client-side by mpegts.js):
 *   - OTA: request a watch session from the device (uses a tuner) and
 *     transcode MPEG-2/AC3 → H.264/AAC.
 *   - OTT: request a watch session too (that's how the app plays OTT; the device
 *     re-serves it as HD H.264) — no tuner — and remux (or transcode).
 * The arg builders and getPlaylistUrl are exported so the recorder reuses the
 * exact same pipeline, writing to a file instead of the response.
 * In MOCK mode it emits a test pattern so the player is demoable without a Tablo.
 */

const { spawn } = require('child_process');

const tuners = require('./tuners');

/** Soft cap on concurrent live ffmpeg processes that don't use a physical tuner (OTT / mock). */
const MAX_NON_TUNER = Math.max(1, parseInt(process.env.MAX_NON_TUNER_FFMPEG || '4', 10) || 4);

let nonTunerLive = 0;

/**
 * ffmpeg args for a mock test pattern (color bars + tone).
 * @param {string} [out] output target (default the stdout pipe)
 * @param {number} [durationSec] optional hard stop (for recordings)
 * @returns {string[]}
 */
function mockArgs(out = 'pipe:1', durationSec) {
    return [
        '-re',
        '-f', 'lavfi', '-i', 'testsrc=size=960x540:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '30',
        '-c:a', 'aac', '-b:a', '128k',
        ...(durationSec ? ['-t', String(durationSec)] : []),
        '-f', 'mpegts', '-flush_packets', '1', out
    ];
}

/**
 * OTA: transcode the device HLS to H.264/AAC with ~1s keyframes.
 * @param {string} url
 * @param {string} [out]
 * @param {number} [durationSec]
 * @returns {string[]}
 */
function otaArgs(url, out = 'pipe:1', durationSec) {
    return [
        '-fflags', '+nobuffer+genpts',
        '-analyzeduration', '1000000',
        '-probesize', '1000000',
        '-http_persistent', '1',
        '-i', url,
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '160k',
        ...(durationSec ? ['-t', String(durationSec)] : []),
        '-f', 'mpegts', '-flush_packets', '1', out
    ];
}

/**
 * OTT copy (cheap remux) — the default, lightest path.
 * @param {string} url
 * @param {string} [out]
 * @param {number} [durationSec]
 * @returns {string[]}
 */
function ottCopyArgs(url, out = 'pipe:1', durationSec) {
    return [
        '-fflags', '+genpts+discardcorrupt',
        '-analyzeduration', '2000000',
        '-probesize', '2000000',
        '-http_persistent', '1',
        '-i', url,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        ...(durationSec ? ['-t', String(durationSec)] : []),
        '-f', 'mpegts', '-flush_packets', '1', out
    ];
}

/**
 * OTT args. Copy (remux) by default; OTT_TRANSCODE=1 re-encodes to a continuous
 * H.264/AAC MPEG-TS to smooth ad-break discontinuities that make some feeds
 * skip on certain hosts.
 * @param {string} url
 * @param {string} [out]
 * @param {number} [durationSec]
 * @returns {string[]}
 */
function ottArgs(url, out = 'pipe:1', durationSec) {
    if (process.env.OTT_TRANSCODE != '1') return ottCopyArgs(url, out, durationSec);

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
        ...(durationSec ? ['-t', String(durationSec)] : []),
        '-f', 'mpegts', '-flush_packets', '1', out
    ];
}

/**
 * Requests a watch session and returns a playable playlist URL.
 * @param {import('./tablo').TabloClient} tablo
 * @param {string} channelId
 * @returns {Promise<string>}
 */
async function getPlaylistUrl(tablo, channelId) {
    const watch = await tablo.watch(channelId);

    if (!watch || !watch.playlist_url) {
        throw new Error(watch && watch.error ? JSON.stringify(watch.error) : 'no playlist_url');
    }

    return watch.playlist_url;
}

/**
 * Builds the ffmpeg args for a channel. Both OTA and OTT stream through the
 * device's /watch endpoint — that's how the official app plays OTT too (it does
 * not play the lineup's direct Amagi URL server-side; that raw URL is only used
 * for the opt-in client-side HLS path). The device re-serves OTT as a single
 * H.264 rendition, so it's already HD. OTT just doesn't consume a tuner.
 *
 * @param {object} o
 * @param {boolean} o.mock
 * @param {import('./tablo').TabloClient|null} o.tablo
 * @param {string} o.channelId
 * @param {boolean} o.isOtt
 * @param {string} [o.hdhrUrl] direct HDHomeRun stream URL (if this is an HDHR channel)
 * @param {string} [o.out]
 * @param {number} [o.durationSec]
 * @returns {Promise<string[]>}
 */
async function buildArgs(o) {
    if (o.mock) return mockArgs(o.out, o.durationSec);

    // HDHomeRun: a direct MPEG-TS URL (no auth). Transcode like OTA (ATSC 1.0 is
    // MPEG-2, ATSC 3.0 is HEVC — libx264 handles both inputs).
    if (o.hdhrUrl) return otaArgs(o.hdhrUrl, o.out, o.durationSec);

    if (!o.tablo) throw new Error('Tablo not connected');

    const url = await getPlaylistUrl(o.tablo, o.channelId);

    return o.isOtt ? ottArgs(url, o.out, o.durationSec) : otaArgs(url, o.out, o.durationSec);
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
 * @param {(id:string)=>(string|undefined)} [opts.hdhrUrlOf] direct HDHR URL for HDHR channels
 * @param {(msg:string)=>void} [opts.log]
 */
async function handleStream(req, res, opts) {
    const log = opts.log || (() => {});

    const channelId = req.params.channelId;

    const isHdhr = channelId.startsWith('hdhr:');

    const hdhrUrl = isHdhr && opts.hdhrUrlOf ? opts.hdhrUrlOf(channelId) : undefined;

    const isOtt = !isHdhr && opts.kindOf(channelId) === 'ott';

    // HDHR and Tablo have separate physical tuners → separate pools. OTT uses none.
    const poolName = isHdhr ? 'hdhr' : 'tablo';

    const usesTuner = !isOtt && !opts.mock;

    // Reserve before the async watch so concurrent requests can't oversubscribe.
    if (usesTuner && !tuners.tryReserve(poolName)) {
        res.status(503).send('All tuners are in use.');

        return;
    }

    if (!usesTuner) {
        if (nonTunerLive >= MAX_NON_TUNER) {
            res.status(503).send('Too many concurrent streams — try again later.');

            return;
        }

        nonTunerLive += 1;
    }

    /** @type {string[]} */
    let args;

    try {
        args = await buildArgs({ mock: opts.mock, tablo: opts.tablo, channelId, isOtt, hdhrUrl });
    } catch (err) {
        if (usesTuner) tuners.release(poolName);
        else nonTunerLive = Math.max(0, nonTunerLive - 1);

        res.status(502).send('stream failed: ' + (err && err.message || err));

        return;
    }

    log(`stream start ${channelId}${opts.mock ? ' (mock)' : isOtt ? ' (ott, no tuner)' : ` [${poolName} ${tuners.inUse(poolName)}/${tuners.getLimit(poolName)}]`}`);

    const ffmpeg = spawn('ffmpeg', args);

    var done = false;

    const cleanup = () => {
        if (done) return;

        done = true;

        if (usesTuner) tuners.release(poolName);
        else nonTunerLive = Math.max(0, nonTunerLive - 1);

        ffmpeg.kill('SIGKILL');

        log(`stream end ${channelId}${usesTuner ? ` [${poolName} ${tuners.inUse(poolName)}/${tuners.getLimit(poolName)}]` : ''}`);
    };

    res.setHeader('Content-Type', 'video/mp2t');

    ffmpeg.stdout.pipe(res);

    ffmpeg.on('error', (err) => {
        // most commonly: ffmpeg not on PATH
        if (!res.headersSent) res.status(500).send('ffmpeg failed: ' + err.message);
        else res.end();

        cleanup();
    });

    // Set STREAM_DEBUG=1 to see ffmpeg's progress (speed=, fps, drops).
    if (process.env.STREAM_DEBUG == '1') {
        ffmpeg.stderr.on('data', (d) => process.stderr.write('[ffmpeg] ' + d));
    } else {
        ffmpeg.stderr.on('data', () => {});
    }

    ffmpeg.on('close', () => { if (!res.writableEnded) res.end(); cleanup(); });

    req.on('close', cleanup);

    res.on('close', cleanup);
}

module.exports = { handleStream, buildArgs, mockArgs, otaArgs, ottArgs, getPlaylistUrl };
