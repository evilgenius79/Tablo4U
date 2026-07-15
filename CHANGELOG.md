# Changelog

All notable changes to **Tablo4U** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [0.8.1] — 2026-07-15

### Changed
- **Reproducible builds:** `package-lock.json` is now committed and CI installs
  with `npm ci` (locked dependency tree + npm cache) instead of `npm install`.
- **Supply-chain-hardened ffmpeg:** the Windows build verifies the downloaded
  ffmpeg archive against GitHub's published SHA256 asset digest before bundling
  it. A new optional `FFMPEG_TAG` repo variable pins a specific BtbN release for
  fully reproducible ffmpeg (defaults to the rolling `latest`).

## [0.8.0] — 2026-07-15

### Security
- Hardening pass drawing on multiple independent AI code audits, aimed at
  running Tablo4U safely when exposed over the internet:
  - Channel IDs and guide dates are validated at every API boundary; device
    requests are pinned to the device's own origin (no SSRF).
  - Login is rate-limited (10 failures / 15 min per IP + username) and the
    session id is regenerated on login; a dummy scrypt hash runs for unknown
    usernames so timing can't leak which accounts exist.
  - `OPEN=1` never grants admin — user management, the device probe, and
    changing the recordings folder always require a real admin login.
  - The session secret auto-persists to `data/session-secret` so logins survive
    restarts; `SESSION_SECRET` overrides it.
  - Baseline security headers (`nosniff`, `X-Frame-Options: DENY`,
    `Referrer-Policy`), `x-powered-by` disabled, JSON body size limit, and
    `TRUST_PROXY` / `SECURE_COOKIES` options for running behind HTTPS.
  - `users.json` and recording metadata are written atomically (temp + rename),
    owner-only.

### Added
- gzip compression for API/JSON responses (skips live stream and file
  endpoints), and long-lived cache headers for vendored assets.
- `MAX_NON_TUNER_FFMPEG` cap on concurrent OTT ffmpeg processes.

### Changed
- Channel and guide data are cached briefly and coalesced so concurrent viewers
  don't stampede the Tablo cloud.

## [0.7.1] — 2026-07-15

### Fixed
- A batch of correctness and robustness issues surfaced by code review,
  including a tuner-pool conflict check in the recording scheduler.

## [0.7.0] — 2026-07-15

### Added
- **HDHomeRun support alongside Tablo.** Point `HDHR_URL` at an HDHomeRun on
  your LAN and its channels merge into the guide (program data borrowed from
  Tablo by channel number), stream from the device's direct URL, and show a
  **live signal meter** while watching. HDHomeRun tuners are tracked in a
  separate pool from the Tablo's, and DRM-protected channels are filtered out.

## [0.6.0] — 2026-07-15

### Added
- **DVR Phase 2 — scheduled recordings.** Click any upcoming program in the
  guide → *Schedule* to record it later. The scheduler checks for tuner
  conflicts upfront (OTA only; OTT is tuner-free) and sweeps for due recordings.

## [0.5.6] — 2026-07-15

### Added
- A note about the second tuner used when recording to the viewing PC.

### Changed
- README now credits [tablo2plex](https://github.com/hearhellacopters/tablo2plex)
  author HearHellacopters as the originator of the idea, at the top.

## [0.5.5] — 2026-07-15

### Added
- **DVR — record to this computer.** Alongside recording to the server, you can
  now record straight to the viewing machine via the browser's native Save
  dialog (File System Access API).

## [0.5.4] — 2026-07-14

### Fixed
- **OTT streaming**, definitively: OTT channels stream through the Tablo
  device's `/watch` session (a single HD H.264 rendition) — the same path the
  official app uses — after earlier attempts to use the raw lineup/CDN URL
  proved unreliable. Restores reliable, higher-quality OTT playback.

## [0.5.3] — 2026-07-13

### Fixed
- Attempted fix for OTT feeds dying instantly by sending a browser User-Agent to
  the CDN. (Superseded by 0.5.4.)

## [0.5.2] — 2026-07-13

### Added
- OTT picks the highest HLS variant, with an optional direct-in-browser HLS path
  (`OTT_DIRECT_HLS`). (OTT source later reverted to device `/watch` in 0.5.4.)

## [0.5.1] — 2026-07-13

### Changed
- OTT streamed from the lineup URL instead of a device `/watch` request.
  (Reverted in 0.5.4 — the device path is what the official app uses.)

## [0.5.0] — 2026-07-12

### Added
- **DVR Phase 1 — instant recording.** Record any channel to the server from the
  player's "● Rec" button, then play back, download, or delete it. Recordings
  and live streams share the real tuner count so they can't oversubscribe the
  device.

## [0.4.9] — 2026-07-12

### Added
- **Rolling guide window** (~1h back to ~3h ahead) with Earlier/Later
  navigation, plus **lazy-loaded channel rows** so 100+ channel lineups stay
  fast.

### Changed
- OTT feeds default to a cheap `-c copy` remux again.

## [0.4.8] — 2026-07-12

### Changed
- Benign player errors (mpegts teardown, buffer removal) are quieted with a
  clean teardown, so the on-screen error banner only shows real problems.

## [0.4.7] — 2026-07-12

### Added
- **HD / SD (and 4K) resolution badges** under each channel.

## [0.4.6] — 2026-07-12

### Fixed
- Guide going blank on the first channel click, caused by the browser
  autofilling the login username into the search box (`autocomplete="off"`).

## [0.4.5] — 2026-07-12

### Added
- Extended the admin device probe with a `?path=` parameter and a per-channel
  detail sweep (used to discover the signal-strength endpoint).

## [0.4.4] — 2026-07-12

### Fixed
- **OTT channels not loading** — stream them via the Tablo device's `/watch`
  session, which does not occupy a tuner.

## [0.4.3] — 2026-07-12

### Added
- An admin-only device probe to discover the device's signal-strength endpoint.

## [0.4.2] — 2026-07-12

### Fixed
- Picture-in-picture: hand off cleanly and stop it freezing the page on close.

## [0.4.1] — 2026-07-12

### Fixed
- Channel logos: consistent dark chip with a call-sign fallback when no logo is
  available.

## [0.4.0] — 2026-07-12

### Added
- **Full-day guide** with pagination.
- Tuner count is now read from the device itself (`/server/info`); OTT channels
  are recognized as tuner-free.

## [0.3.0] — 2026-07-12

### Added
- **Favorites** and **recently watched** (per user), guide **search**, channel
  **logos**, **program detail** views, and **picture-in-picture**.

## [0.2.3] — 2026-07-11

### Added
- Light / dark theme toggle (Auto → Light → Dark) that follows the OS by default
  and remembers your choice.

## [0.2.2] — 2026-07-11

### Changed
- Reduced player buffering with more frequent keyframes and low-latency tuning.

## [0.2.1] — 2026-07-11

### Fixed
- Web assets missing from the Windows exe — they're now embedded as a required
  module so the self-contained build serves the UI correctly.

## [0.2.0] — 2026-07-11

### Added
- **In-browser live player** (mpegts.js) and **multi-user accounts** (session
  login, scrypt-hashed passwords, admin vs. user roles, in-app user manager, no
  database).
- **Windows exe build**: pkg-aware paths, in-memory assets, and the GitHub
  Actions CI workflow that bundles ffmpeg.
- Documentation of the prebuilt Windows release as the easy install path.

## [0.1.0] — 2026-07-11

### Added
- Initial Tablo4U foundation: a self-hosted web app that talks to a Tablo 4th
  Gen device using Tablo's own JSON API, with a native EPG guide built from the
  cloud guide data. Built on the reverse-engineered API groundwork from
  [tablo2plex](https://github.com/hearhellacopters/tablo2plex).

[0.8.1]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.8.1
[0.8.0]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.8.0
[0.7.1]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.7.1
[0.7.0]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.7.0
[0.6.0]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.6.0
[0.5.6]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.5.6
[0.5.5]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.5.5
[0.5.4]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.5.4
[0.5.3]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.5.3
[0.5.2]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.5.2
[0.5.1]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.5.1
[0.5.0]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.5.0
[0.4.9]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.4.9
[0.4.8]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.4.8
[0.4.7]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.4.7
[0.4.6]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.4.6
[0.4.5]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.4.5
[0.4.4]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.4.4
[0.4.3]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.4.3
[0.4.2]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.4.2
[0.4.1]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.4.1
[0.4.0]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.4.0
[0.3.0]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.3.0
[0.2.3]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.2.3
[0.2.2]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.2.2
[0.2.1]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.2.1
[0.2.0]: https://github.com/evilgenius79/Tablo4U/releases/tag/v0.2.0
[0.1.0]: https://github.com/evilgenius79/Tablo4U/commits/main
