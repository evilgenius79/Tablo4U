# Tablo4U

A native web front-end for **Tablo 4th Gen** — browse the guide and watch live
TV in your browser, using Tablo's *own JSON API* directly. No Plex, no XML
conversion, no HDHomeRun spoofing.

> Companion to [tablo2plex](https://github.com/hearhellacopters/tablo2plex).
> Where tablo2plex ports Tablo → Plex, Tablo4U exposes Tablo directly as a web
> app. Early WIP.

## Why

tablo2plex already reverse-engineers Tablo's full auth + API surface, then
squeezes it through the narrow HDHomeRun/XMLTV shape Plex expects. Tablo4U
keeps the data **native**: Tablo's guide is JSON, so we serve JSON; channels
and watch sessions come straight from the device. That opens the door to a
real UI, multi-user logins, and watching in any browser — not just Plex.

## Status

Working now:
- Self-contained Tablo client (cloud login, device-request signing, channels,
  native-JSON guide, watch/playlist).
- REST API: `/api/channels`, `/api/guide?date=YYYY-MM-DD`, `/api/watch/:id`.
- Web **EPG guide** — timeline grid with now-line, live indicators, date
  picker.
- Session **login** in front of the UI (optional).
- `MOCK=1` mode with sample data for development without a Tablo.

Planned:
- In-browser **player** with a transcode path for OTA (MPEG-2/AC3 → H.264/AAC
  via ffmpeg); OTT streams that are already H.264 play direct.
- Multi-user accounts, favorites, recordings/DVR, search.

## Run

```bash
cd tablo4u
npm install
cp .env.example .env      # fill in TABLO_EMAIL / TABLO_PASSWORD
npm start                 # http://localhost:3400
```

Try the UI without a Tablo:

```bash
npm run mock              # serves sample channels + guide
```

## Notes

- **OTA playback:** over-the-air channels are MPEG-2 video / AC3 audio, which
  most browsers can't decode via Media Source Extensions — those need a
  server-side transcode (planned). OTT channels are often H.264 and may play
  directly.
- **Security:** if `APP_PASSWORD` is unset the UI is open (LAN convenience).
  Set it to require login. Do not expose this server to the internet.
- Reuses the Tablo signing approach proven in tablo2plex; empty
  `HashKey`/`DeviceKey` env values fall back to the built-in defaults.
