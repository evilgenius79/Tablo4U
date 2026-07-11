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

- 📺 **Native EPG guide** — a real timeline grid (now-line, live indicators,
  date picker) built straight from Tablo's JSON guide data. No XMLTV.
- ▶️ **In-browser live player** — plays streams via
  [mpegts.js](https://github.com/xqq/mpegts.js) (bundled). OTT channels
  (H.264) are remuxed cheaply; OTA channels (MPEG-2/AC3) are transcoded to
  H.264/AAC by ffmpeg so they play in any modern browser.
- 👥 **Multi-user accounts** — session login with scrypt-hashed passwords,
  admin vs. user roles, and an in-app user manager. No database needed
  (`data/users.json`).
- 🔐 **Runs on your LAN** — nothing leaves your network except the Tablo login
  itself (over HTTPS). No cloud, no third parties.
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
| `ADMIN_PASSWORD` | random | First-run admin password (printed if generated) |
| `PORT` | `3400` | Web UI port |
| `TUNER_COUNT` | `4` | Max concurrent streams |
| `OPEN` | off | Set `OPEN=1` to disable login (LAN convenience) |
| `MOCK` | off | Set `MOCK=1` for sample data + test-pattern stream |
| `SESSION_SECRET` | random | Set a fixed value so sessions survive restarts |

## How it works

```
Browser ──HTTP──► Tablo4U server ──HTTPS──► Tablo cloud (login / guide / lineup)
   ▲                     │
   │  mpegts.js          └────HTTP (signed)──► Tablo device (watch / stream)
   └──── MPEG-TS ◄── ffmpeg (copy for OTT · transcode for OTA)
```

- **Auth & data** come from Tablo's cloud API (`login`, `account`, guide
  `airings`, channel lineup) — all JSON, served through to the browser as-is.
- **Streams**: the server asks the Tablo device for a watch session, then pipes
  it through ffmpeg to the browser as MPEG-TS. OTT (already H.264) uses
  `-c copy`; OTA (MPEG-2/AC3) transcodes to H.264/AAC.

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
| `GET` | `/api/users` | List users *(admin)* |
| `POST` | `/api/users` | Add user *(admin)* |
| `DELETE` | `/api/users/:username` | Remove user *(admin)* |

## Security

- Do **not** expose this server to the internet — it fronts your Tablo. Keep it
  on your LAN (or behind a VPN / your own reverse proxy with TLS).
- Passwords are scrypt-hashed; `data/users.json` is written owner-only.
- Set `SESSION_SECRET` in production so sessions persist and aren't guessable.

## Roadmap

- [ ] Channel logos & richer program details / descriptions
- [ ] Favorites and "recently watched" per user
- [ ] Search across the guide
- [ ] DVR / recordings (pending Tablo endpoint exposure)
- [ ] Picture-in-picture and mobile-optimized layout

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
