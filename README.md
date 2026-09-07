<p align="center">
<img src="design/readme_banner.jpg" width="1920" height="1256">
</p>
<h3 align="center">m3ugoat: Self-hosted M3U playlist manager with a sync API</h3>
<p align="center">
m3ugoat is your IPTV playlists' new home. Your streams don't leave your local network, you are in charge, nobody can see or control your playlists.
</p>
<br/>

> [!IMPORTANT]
> **m3ugoat is a fork of [m3u4me](https://github.com/andrei-savin/m3u4me) by [@andrei-savin](https://github.com/andrei-savin).**
> All of the original app's features and design are his work. This fork adds multi-user accounts, a documented sync API, and a SQLite-backed store — see [What this fork adds](#what-this-fork-adds).
> If you want the original, simpler, single-user app, **go there instead** — it is excellent and this fork is not a replacement for it.

> [!WARNING]
> m3ugoat does NOT provide ANY streams! It is purely a M3U playlist manager. You must bring your own content.

> [!NOTE]
> The upstream project aims to be a self-hosted alternative to https://m3u4u.com/ - as you can see, m3u4me's name is obviously referencing them. The projects are not related in any way. No harm intended!

## AI Disclosure

> [!NOTE] by [@andrei-savin](https://github.com/andrei-savin)
> This app's code was AI-generated, with minor interventions from me. I am a graphic designer with very limited coding knowledge; I do not support pointless usage of AI and I am fully aware of the harm it can cause. <br/><br/> m3u4me started out as something that was intended only for personal use - I am sharing it only because I believe it is an useful app which might help many other IPTV enthusiasts. <b>It will always be entirely free</b>. <br/><br/> I fully encourage any developer who comes across this app and wants to turn it into something human-made, without AI involvement. </br></br> AI was not used for <b>anything</b> else besides writing the actual code of the app.

> [!NOTE]
> The same is true of this fork: the changes listed below were AI-written under review. They are covered by an automated test suite (`npm run verify:*`) rather than trusted on sight.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

## What this fork adds

Everything upstream does, plus:

- <b>Multi-user accounts:</b> Separate accounts, each with their own playlists, EPG sources and channel-pool sources. Accounts cannot see each other's data. Still optional — with no password set the app behaves exactly like upstream.
- <b>Per-device sign-in:</b> Each device gets its own token, stored only as a hash. Sessions survive a server restart, and you can sign a lost phone or TV box out remotely from Settings.
- <b>SQLite storage:</b> Replaces the single JSON file, which was rewritten in full on every edit. Real transactions, and a single-channel edit is ~320x faster on a large library.
- <b>A documented sync API:</b> OpenAPI 3.1, served from the running app at `/api/openapi.json`, so several devices can safely edit the same playlists. See [API](#api).
- <b>Conflict detection:</b> Optimistic concurrency via `If-Match`/`ETag`, so two devices editing at once can't silently overwrite each other.
- <b>Unguessable export links:</b> Playlist links use a secret token (`/e/<token>`) that you can rotate if one leaks.

> [!WARNING]
> **Breaking change vs upstream:** the numeric playlist URLs (`http://IP:port/1`) are **disabled by default** and return `410 Gone`. They are unauthenticated and sequential, so with more than one account anyone on your network could walk `/1`, `/2`, `/3` and read every playlist — including stream URLs, which often embed your provider credentials. Use the `/e/<token>` link shown in the Export dialog instead. To re-enable the old URLs during a migration, start the server with `ALLOW_INSECURE_SHORT_IDS=1`.

> [!NOTE]
> Requires **Node 24+** (upstream requires Node 18+). The app uses Node's built-in SQLite, and runs the server through Node's native TypeScript support.

## Features
- <b>Multiple playlist support:</b> Add as many playlists as you like. Start empty or import an M3U or XSPF playlist from a URL or an uploaded file.
- <b>Channel pool sources:</b> Connect your Xtream Codes account, a playlist URL, or an M3U/XSPF file; then browse, search and add channels into any playlist. Each source refreshes on its own schedule and keeps a changelog of what got added, removed or renamed.
- <b>EPG guide:</b> Add EPG sources from an XMLTV URL or an Xtream Codes account, each on its own refresh interval. Browse a live programme timeline and assign TVG IDs to your channels by hand, in bulk via automatic fuzzy name-matching, or one by one.
- <b>Logo editing:</b> Add/edit/remove your channels' logos.
- <b>Stream checker</b> (Not recommended): Basic stream checking functionality, not recommended due to some IPTV providers not reacting nicely to any sort of bulk checking. Use at your own risk!
- <b>Bulk actions:</b> Move, delete, find & replace, or check multiple channels at once.
- <b>Auto-saving:</b> You don't need to remember to save your changes or push your playlist. Everything happens instantly, automatically.
- <b>Undo delete:</b> Deleted a channel by mistake? Hit the "Undo" button which appears on the bottom of your screen and bring it back without a hassle.
- <b>Playlist links:</b> Each playlist gets a download link and its own EPG feed, both copyable from the Export dialog. <i>In this fork these are secret-token links (`http://IP:port/e/<token>`) rather than upstream's numeric `http://IP:port/1` — see the warning above.</i>
- <b>Global search:</b> Search across every playlist, channel pool source, and EPG source at once.
- <b>Keyboard shortcuts</b>: Delete your channels with `DEL`, select everything with `Cmd+A`, make your work easier overall. Full list of commands is available inside the app.

### Cosmetic UI features:
- <b>Light mode, Dark mode & AMOLED Dark mode</b>
- <b>Custom accent colours:</b> Even the browser tab's favicon matches your chosen colour.
- <b>Channel logo background colour presets</b>: Choose between light gray, white, black or transparency. <i>(Only for previewing. Does not affect the actual logos in the playlist.)</i>
- <b>Hide stream URLs</b>: Useful for sharing screenshots.
- <b>12-hour or 24-hour time</b>: Pick your preferred clock format for the EPG guide.

## Installation
> [!NOTE]
> The upstream app has been tested on macOS (Apple Silicon) and Debian, running via PM2 with as little as 512MB of RAM.
### 1. Install Node.js
The official website is pretty straightforward about this: https://nodejs.org/en/download.<br/>After installing, make sure it was installed correctly by running `node -v` and/or `npm -v` in your terminal.
### 2. Install PM2
This keeps your app running 24/7 in the background.
```
npm install -g pm2
```
### 3. Run the app
<b>3a. Clone the source via git:</b>
```
git clone https://github.com/m3ugoat/m3ugoat.git
```
<b>3b. Navigate into the folder:</b>
```
cd m3ugoat
```
<b>3c. Install the dependencies:</b>
```
npm install
```
m3ugoat runs on port 8080 by default. You can change that in `ecosystem.config.cjs`.

<b>3d. Build the app:</b>
```
npm run build
```
<b>3e. Start up PM2:</b>
```
pm2 start ecosystem.config.cjs
```
All done! You can now use m3ugoat at http://localhost:8080 [replace `localhost` with the IP of your server, and `8080` with whatever custom port you set up earlier].

### 4. Make m3ugoat auto-run at startup (Optional):
```
pm2 startup
pm2 save
```

## Updating
### 1. Navigate into the app's folder
> [!NOTE]
> The folder shown in the command below is only an example.
```
cd /opt/m3ugoat
```
### 2. Pull the latest code from this repo
```
git pull --ff-only
```
> [!NOTE]
> During this step, you might run into the following error:
> `Your local changes to the following files would be overwritten by merge. / package-lock.json / Please commit your changes or stash them before you merge.`
> If so, just run `git restore package-lock.json` and then continue with the following steps.
### 3. Install any new dependencies
```
npm ci
```
### 4. Rebuild the app
```
npm run build
```
### 5. Restart the PM2 process
```
pm2 restart ecosystem.config.cjs --update-env
```

## API

Every action in the UI is available over HTTP, so several devices can share and edit the same playlists.

**The full reference is served by the app itself at `http://IP:port/api/openapi.json`** (OpenAPI 3.1 — paste it into Swagger Editor, Postman, Insomnia, or any client generator). It needs no authentication, so you can read it before you have credentials.

### Quick start

```bash
BASE=http://localhost:8080

# 1. Is a login required? `enabled:false` means no account exists and the API is open.
curl -s $BASE/api/auth/status
# {"enabled":true,"userCount":1,"multiUser":false}

# 2. Get a token. `username` is optional until you have a second account.
TOKEN=$(curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"your-password","deviceName":"Living room TV"}' | jq -r .token)

# 3. List your playlists. Every request carries the token.
curl -s $BASE/api/playlists -H "Authorization: Bearer $TOKEN"

# 4. Add channels to a playlist.
curl -s -X POST $BASE/api/playlists/$PLAYLIST_ID/channels/bulk \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"channels":[{"name":"BBC One","url":"http://example/stream","category":"UK"}]}'
```

### Editing safely from more than one device

Every record has a `version`. Send back the one you last read as `If-Match`, and the server refuses the write if someone else changed it first:

```bash
# The response to any read includes "version": 4
curl -s -X PUT $BASE/api/playlists/$PLAYLIST_ID \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'If-Match: 4' \
  -d '{"name":"Renamed"}'
```

If the playlist has moved on you get `409` with the current state, so you can merge and retry without a second request:

```json
{ "error": "Version conflict: the resource changed since you last read it",
  "currentVersion": 5,
  "current": { "id": "...", "name": "Someone else's rename", "version": 5 } }
```

`If-Match` is optional — omit it and the last write wins. A syncing client should always send it.

The bulk routes take a `versions` map instead of `If-Match`, since one precondition can't cover many rows. Items that have moved on are **skipped and reported**, and the rest still apply:

```bash
curl -s -X POST $BASE/api/playlists/$PLAYLIST_ID/channels/bulk-delete \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ids":["ch1","ch2"],"versions":{"ch1":3,"ch2":1}}'
# {"success":true,"deleted":1,"conflicts":[{"id":"ch2","expected":1,"current":4}]}
```

### Sharing a playlist with a player

Player and EPG-grabber URLs can't send an auth header, so they use the playlist's secret token instead — copy them from the Export dialog:

```
http://IP:port/e/<exportToken>        # M3U
http://IP:port/e/<exportToken>/epg    # XMLTV
```

Anyone holding that link can read the playlist without signing in. `POST /api/playlists/{id}/rotate-export-token` issues a new one and kills the old link.


## Bug reports & feature requests

Please work out which project the issue belongs to first:

- Something this fork added — accounts, the API, SQLite, export tokens — [open an issue here](https://github.com/m3ugoat/m3ugoat/issues).
- Anything else — please **do not** report it upstream if you are running this fork, since the code has diverged substantially. Open it here and it can be forwarded if it turns out to be a genuine upstream bug.

## Credits

m3u4me is by [@andrei-savin](https://github.com/andrei-savin). This fork keeps the original GPL-3.0 licence, and all of the original app's design and features are his work.
