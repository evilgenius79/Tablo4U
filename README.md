# Tablo4U

**Watch your Tablo in any browser — no Plex required.**

Tablo4U is a self-hosted web app that talks to a **Tablo 4th Gen** device using
Tablo's *own JSON API*. It gives you a real channel guide and an in-browser
live player, with multi-user logins — so you can watch OTA (and OTT) TV from a
laptop, phone, or TV browser without being locked into the official apps.

> **Companion to [tablo2plex](https://github.com/hearhellacopters/tablo2plex).**
> Where tablo2plex bridges Tablo → Plex (spoofing an HDHomeRun and converting
> the guide to XMLTV), Tablo4U skips all the translation and exposes Tablo
> **directly** as a web app. Same reverse-engineered auth, native data.

![Tablo4U guide](docs/guide.png)

![Multi-user admin](docs/admin.png)

---

## Features

- 📺 **Native EPG guide** — a rolling timeline grid (~1h back to ~3h ahead with
  Earlier/Later navigation, live now-line, live indicators, date picker,
  **channel logos**, **HD/SD badges**, and **lazy-loaded rows** so 100+ channel
  lineups stay fast) built straight from Tablo's JSON guide data. No XMLTV.
- ▶️ **In-browser live player** — plays streams via
  [mpegts.js](https://github.com/xqq/mpegts.js) (bundled), with
  **picture-in-picture**. OTT channels are remuxed cheaply (already H.264) and
  **don't occupy a tuner**; OTA channels (MPEG-2/AC3) use a tuner and are
  transcoded to H.264/AAC by ffmpeg so they play in any modern browser.
- ⏺ **DVR / recording** — record any channel to an MPEG-TS file on the server
  (instant "● Rec" from the player), then play back, download, or delete it from
  the **Recordings** view. Recordings and live streams share the real tuner
  count so they can't oversubscribe the device (OTA only; OTT records without a
  tuner). Save folder is configurable.
- ⭐ **Favorites & recently watched** — star channels (filter to just those),
  and jump back to what you were watching — saved per user.
- 🔎 **Search** the guide by channel or program, and click any program for a
  **detail view** (still, description, genres, episode info).
- 👥 **Multi-user accounts** — session login with scrypt-hashed passwords,
  admin vs. user roles, and an in-app user manager. No database needed
  (`data/users.json`).
- 🔐 **Runs on your LAN** — nothing leaves your network except the Tablo login
  itself (over HTTPS). No cloud, no third parties.
- 🌗 **Light / dark theme** — follows your OS by default, with an in-app
  toggle (Auto → Light → Dark) that remembers your choice.
- 🧪 **Mock mode** — explore the whole UI with sample data and a test-pattern
  stream, no Tablo required.

## Requirements

- A **Tablo 4th Gen** device on your LAN and a Tablo account.
- For the **prebuilt Windows release**: nothing else — Node and ffmpeg are
  included.
- To **run from source** (any OS): **Node.js 20+** and **ffmpeg** on your
  `PATH` (static build from [ffmpeg.org](https://ffmpeg.org/download.html)).

## Download & run (Windows)

The easiest way — no Node or ffmpeg install needed:

1. Grab **`tablo4u-win-x64.zip`** from the
   [latest release](https://github.com/evilgenius79/Tablo4U/releases/latest)
   and extract it anywhere.
2. Rename **`.env.example.txt`** to **`.env`** and fill in your `TABLO_EMAIL`
   and `TABLO_PASSWORD` (see [Configuration](#configuration-env)).
3. Run **`tablo4u-win-x64.exe`**. On first start it prints an admin login:

   ```
   [tablo4u] Created admin account:  admin / 7Gk2pQ9x
   ```
4. Open **http://localhost:3400** and sign in.

The exe is self-contained (bundled ffmpeg); your `.env` and `data/` live in the
same folder as the exe. New releases are published on the
[Releases](https://github.com/evilgenius79/Tablo4U/releases) page.

## Run from source (any OS)

```bash
git clone https://github.com/evilgenius79/Tablo4U.git
cd Tablo4U
npm install
cp .env.example .env        # add your Tablo email + password
npm start
```

Then open **http://localhost:3400** and sign in with the admin login printed on
first run (or set `ADMIN_PASSWORD` to choose your own).

**Just want to look around?** No Tablo needed:

```bash
npm run mock                # sample guide + a test-pattern you can "watch"
```

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `TABLO_EMAIL` / `TABLO_PASSWORD` | — | Your Tablo account (required unless `MOCK=1`) |
| `TABLO_SERVER_ID` | first device | Pick a specific device if you have more than one |
| `ADMIN_PASSWORD` | random | Admin password. Set it and it **always wins** — the admin login is (re)set to it on every start. Leave unset and a random one is generated + printed on first run. |
| `PORT` | `3400` | Web UI port |
| `RECORDINGS_DIR` | `./recordings` | Where DVR recordings are saved (a folder on the server; also changeable in-app) |
| `OPEN` | off | Set `OPEN=1` to disable login (LAN convenience) |
| `MOCK` | off | Set `MOCK=1` for sample data + test-pattern stream |
| `SESSION_SECRET` | random | Set a fixed value so sessions survive restarts |

> The **tuner count is read from the device** after login (`/server/info`), not
> from config — so it's always correct and there's no `TUNER_COUNT` to set.
> Only OTA channels use a tuner; OTT channels don't.

## How it works

```
Browser ──HTTP──► Tablo4U server ──HTTPS──► Tablo cloud (login / guide / lineup)
   ▲                     │
   │  mpegts.js          └────HTTP (signed)──► Tablo device (watch / stream)
   └──── MPEG-TS ◄── ffmpeg (copy for OTT · transcode for OTA)
```

- **Auth & data** come from Tablo's cloud API (`login`, `account`, guide
  `airings`, channel lineup) — all JSON, served through to the browser as-is.
- **Streams**: OTA asks the Tablo device for a watch session (a tuner) and is
  transcoded MPEG-2/AC3 → H.264/AAC. OTT streams from the **direct URL in the
  lineup** (`ott.streamUrl`) — no device request, no tuner — with the
  highest-bitrate HLS variant selected so it plays HD (disable with
  `OTT_NO_VARIANT=1`), remuxed with `-c copy` (or transcoded if
  `OTT_TRANSCODE=1`). Both are piped to the browser as MPEG-TS. Optionally,
  `OTT_DIRECT_HLS=1` plays OTT's HLS **directly in the browser** (hls.js, no
  server ffmpeg) — lighter, with browser-managed adaptive bitrate — when the
  OTT CDN allows CORS.

## API

All endpoints require a session (unless `OPEN=1`):

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/login` | `{username, password}` → session |
| `POST` | `/api/logout` | End session |
| `GET` | `/api/me` | Current user |
| `GET` | `/api/channels` | Native channel lineup (JSON) |
| `GET` | `/api/guide?date=YYYY-MM-DD` | Native guide airings per channel |
| `GET` | `/api/stream/:channelId` | Live MPEG-TS stream |
| `GET` | `/api/recordings` | List active + saved recordings, folder, tuner use |
| `POST` | `/api/recordings/start` | `{channelId, title, minutes}` → start a recording |
| `POST` | `/api/recordings/:id/stop` | Stop an in-flight recording |
| `GET` | `/api/recordings/:id/file` | Play back / download a saved recording |
| `DELETE` | `/api/recordings/:id` | Delete a recording |
| `GET` | `/api/profile` | Current user's favorites + recently watched |
| `PUT`/`DELETE` | `/api/favorites/:channelId` | Add/remove a favorite |
| `GET` | `/api/users` | List users *(admin)* |
| `POST` | `/api/users` | Add user *(admin)* |
| `DELETE` | `/api/users/:username` | Remove user *(admin)* |

## Security

- Do **not** expose this server to the internet — it fronts your Tablo. Keep it
  on your LAN (or behind a VPN / your own reverse proxy with TLS).
- Passwords are scrypt-hashed; `data/users.json` is written owner-only.
- Set `SESSION_SECRET` in production so sessions persist and aren't guessable.

## Roadmap

- [x] Channel logos & richer program details / descriptions
- [x] Favorites and "recently watched" per user
- [x] Search across the guide
- [x] Picture-in-picture and mobile-optimized layout
- [x] Rolling time window (~1h back / ~3h ahead) with Earlier/Later navigation,
      date-jump, and lazy-loaded channel rows
- [x] Tuner count auto-detected from the device (OTT channels tuner-free)
- [x] DVR: record a channel to disk (instant), play back / download / delete,
      with shared tuner accounting
- [ ] DVR: schedule recordings from the guide (click a future program)
- [ ] Program reminders / "watch later"

## Status

Early but functional. The guide, data API, multi-user auth, and the streaming
pipeline are working; the player has been verified end-to-end (real OTA
playback needs a full ffmpeg on the host). Expect rough edges — issues and PRs
welcome.

## Credits

Built on the Tablo API reverse-engineering from
[tablo2plex](https://github.com/hearhellacopters/tablo2plex) by
HearHellacopters. The device-signing approach is shared between the two
projects.

## License

ISC
