# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

m3u4me — a self-hosted, single-user, local-network IPTV M3U playlist manager. Playlists/channels never leave the box it runs on. Express backend + Vite-built React 19 frontend, persisted to a single JSON file on disk. Per the README, the codebase is AI-generated with the maintainer (a non-developer) reviewing/steering — keep changes readable and avoid introducing patterns that need heavy explanation. There is no test suite in this repo.

## Commands

- `npm run dev` — `tsx server.ts`; runs Express with Vite in middleware mode (HMR dev server), on port 8080 (override with `PORT` env var).
- `npm run build` — `vite build` → `dist/`.
- `npm run start` — `node server.ts` in production mode; requires `dist/` to already exist (run `build` first). Serves `dist/` statically with SPA fallback.
- `npm run preview` — `vite preview`.
- `npm run lint` — `eslint . && tsc --noEmit`. This is also the typecheck command; there's no separate `typecheck` script.
- `npm run clean` — `rm -rf dist`.
- `npm run verify:migration` — checks the `data/db.json` → SQLite import is lossless, against a throwaway database.
- `npm run verify:auth` — end-to-end account/device-token checks; boots a real server on port 8123 against a throwaway database.
- `npm run verify:scoping` — end-to-end per-user isolation and export-token checks; boots a real server on port 8126.
- `npm run verify:concurrency` — end-to-end If-Match/ETag/409 checks; boots a real server on port 8127.
- `npm run verify:openapi` — validates the API description and cross-checks it against the real route table in both directions; boots a real server on port 8128. No general test runner is configured.
- `npm run openapi:write` — regenerates `openapi.json` from `openapi.ts`. Run this after changing the spec, or `verify:openapi` fails on a stale file.
- Production process management is PM2 via `ecosystem.config.cjs` (`pm2 start ecosystem.config.cjs`).

## Architecture

### One backend file, one SQLite database

- `server.ts` is the entire backend — a single Express app with every route registered inline inside `startServer()`. No router modules, no ORM.
- Persistence is SQLite via Node's built-in `node:sqlite` (no dependency), in `db.ts`. That file owns the schema, the row mappers, a plain-function repository per entity (`store.playlists`, `store.channels`, `store.epgSources`, `store.poolSources`, `store.poolEntries`, `store.poolChangeLogs`) and `inTransaction()`. The database lives at `data/m3u4me.db` (gitignored, WAL mode). `M3U4ME_DB_PATH` overrides the path for tests.
- **Requires Node 24+** (see `engines` and `.nvmrc`) — both for `node:sqlite` and because `npm run start` runs `node server.ts` directly, relying on native TypeScript type-stripping.
- **Every repository read and write takes the owning `userId`.** That is deliberate: a missing scope is a compile error rather than a silent cross-account leak. The handful of intentional exceptions are named `*Unscoped` (`epgSources.allUnscoped`, `poolSources.byIdUnscoped`, `playlists.byShortIdUnscoped`, …) for the background refresh loops, which run for every account and have no request user, plus `channels.byPlaylistForExport` for the public export routes. `server.ts`'s `actingUserId(req)` returns `req.user?.id ?? LEGACY_USER_ID`, so an install with auth disabled keeps working as a single-user app.
- Channels have no `user_id` of their own; ownership comes from their playlist, so scoped channel queries join through `playlists`.
- Cross-account access returns **404, not 403**, so a probe cannot confirm that someone else's id exists.
- Multi-statement writes must go through `store.inTransaction(...)` so they cannot half-apply. Columns are snake_case, TypeScript objects stay camelCase, and each table has an explicit `rowTo*` mapper — no automatic name conversion.
- Every mutable row carries a `version` column, incremented on write and **exposed on every read** as a `version` field (list endpoints included, since there are no single-resource GETs). It is the entity tag.
- Conditional writes go through `WriteResult<T>` — `{ status: "ok" | "notfound" | "conflict" }`. The discriminant is a **string, not a boolean `ok` flag**, because this project's tsconfig does not set `strict`: without `strictNullChecks` TypeScript will not narrow a union on a boolean literal, though it narrows string literals fine.
- `update()`/`delete()` take an optional `expectedVersion`. The version test is in the `UPDATE`'s own `WHERE` clause, not a preceding read, so check-and-write is one atomic statement rather than a race window.
- Two escape hatches from the conditional path, both deliberate: `epgSources.updateStatus()` / `poolSources.updateStatus()` for the background refresh (no request user, must not fail on a version race — it only writes fetch bookkeeping), and `channels.updateUnconditional()` for the bulk routes, which have no single version to gate on.
- In-place schema changes go through `addColumnIfMissing()` near the top of `db.ts`, **not** the main `CREATE TABLE IF NOT EXISTS` batch: on a database whose tables already exist, that batch is a no-op, so anything referencing a new column (an index, especially) must run *after* the `ALTER TABLE`. Getting this order wrong fails only on upgrade, never on a fresh database — `verify:migration` covers it by opening a deliberately older-shaped database in a subprocess.
- The previous store was a single JSON file, `data/db.json`, whose `readDb()`/`writeDb()` rewrote the whole document per mutation. `db.ts`'s `migrateFromJson()` imports it once on first boot when the database is empty, then leaves it alone as a rollback copy; `npm run verify:migration` re-checks that import field-for-field against a throwaway database. That migration also backfills `shortId`/`exportId`, which is why the old `migrateShortIds()` boot pass is gone — `short_id` is now `NOT NULL UNIQUE`.
- Auth secrets live in a separate gitignored file, `data/auth.json`.
- In dev (`NODE_ENV !== 'production'`), `server.ts` creates a Vite server in middleware mode and mounts it; in production it serves `dist/` statically with an `index.html` catch-all for client-side routing.

### Data model — duplicated by hand across backend and frontend

`db.ts` is the source of truth for the backend types (`Playlist`, `Channel`, `EpgSource`, `ChannelPoolSource`, `ChannelPoolEntry`, `ChannelPoolChangeLog`); `server.ts` imports them. `src/apiClient.ts` still declares its own frontend copies — there's no shared types package, so when changing a shape update `db.ts` and `src/apiClient.ts`.

- **`Playlist`** — has an `exportToken` (256-bit, URL-safe) used by the public `/e/:token` and `/e/:token/epg` export URLs and rotatable via `POST /api/playlists/:id/rotate-export-token`; a `shortId` (small incrementing integer, now only a display number — see the export-URL section below); and an `exportId` (UUID, legacy long-form export route kept for backwards compatibility).
- **`Channel`** — belongs to one playlist + one category string; `order` drives manual drag-reordering.
- **`EpgSource`** — an XMLTV URL (optionally gzip) or Xtream Codes credentials. Parsed programme/channel data is cached **in memory only** (`epgCache` Map keyed by source id) — it is never persisted, so it's rebuilt from scratch on every server restart via `refreshEpgSource()`, which runs for every stored source at boot and again on a 5-minute interval check against each source's `refreshIntervalHours`.
- **`ChannelPoolSource` / `ChannelPoolEntry` / `ChannelPoolChangeLog`** — a separate "bulk source" concept, distinct from playlists: an Xtream account, a playlist URL, or an uploaded file that you browse and cherry-pick channels from into an actual playlist. Entries *are* persisted (the `channel_pool_entries` table, mirrored into an in-memory `channelPoolCache` for the running session). Each refresh diffs old vs. new entries by stream URL and appends an added/removed/renamed changelog entry, pruned to entries newer than 90 days.

### Auth is bespoke — and unrelated to `AuthContext`

- Real auth: per-user accounts in the `users` table (PBKDF2 password + a one-time-shown recovery key, `is_admin` flag). Login issues a random bearer token and stores **only its SHA-256** in `device_tokens`, one row per device — so tokens are durable across restarts, revocable individually, and a copy of the database yields no usable credential. The middleware at `app.use('/api', ...)` resolves the token to a device + user, populates `req.user`/`req.device` (declared via a `declare global` augmentation in `server.ts`), touches `last_seen_at`, and gates every `/api/*` route except `publicPaths` (`/auth/status`, `/auth/login`, `/auth/recover`). `requireAdmin` gates the `/api/users` routes. **If no account exists, auth is a complete no-op** — unchanged from before.
- Password/recovery-key comparison goes through `crypto.timingSafeEqual` (`safeEqualHex`), not `!==`.
- `username` is optional on `login`/`recover`: with exactly one account it falls back to that account (which is what the current web UI relies on), and becomes required once a second account exists.
- `remove-password` deletes the sole account to turn auth off again, and is **refused with 409 when more than one account exists** — dropping auth would otherwise expose every account's data on the LAN.
- Changing a password or using a recovery key revokes all of that user's device tokens (the caller's own device is re-issued so it stays signed in). Neither touches other accounts.
- The old store was a single global password in `data/auth.json` with an in-memory `activeSessions` Set. `db.ts`'s `migrateFromAuthJson()` converts it into the first account on boot, **reusing the existing PBKDF2 hashes so the same password keeps working**, with id `LEGACY_USER_ID` (`"local-user"`) so pre-existing playlists already belong to it. `M3U4ME_LEGACY_AUTH` overrides the path for tests.
- The frontend stores the token in `sessionStorage` (`src/apiClient.ts`: `getSessionToken`/`setSessionToken`) and routes every call through `authFetch()`, which attaches `Authorization: Bearer …` and fires a global `auth-expired` window event on a 401 (handled in `App.tsx` to re-lock the UI via `LockScreen`).
- `src/contexts/AuthContext.tsx` (`useAuth()`) is a **vestigial, unrelated stub** — it always returns a hardcoded dummy local user and has no connection to the password system above. Don't conflate the two when touching auth.
- Public export URLs are registered outside the `/api` prefix and are therefore never auth-gated — intentional, since IPTV players/EPG grabbers can't supply a bearer token. Authorisation is instead the playlist's unguessable `exportToken`:
  - `GET /e/:token` — the M3U.
  - `GET /e/:token/epg` — the XMLTV document.
  - `GET /:shortId` and `GET /:shortId/epg` are **disabled by default, returning 410 Gone.** `shortId` is a small incrementing integer, so with more than one account these enumerable, unauthenticated routes would expose every playlist — including stream URLs, which in IPTV routinely embed provider credentials. `ALLOW_INSECURE_SHORT_IDS=1` re-enables them (with a startup warning) for a migration window while players are repointed.
  - `serveEpgXml()` filters the global `epgCache` to the playlist owner's EPG sources, so a shared tvg-id can't pull another account's programme data into the document.

### The API description lives in `openapi.ts`

- `openapi.ts` is the **source of truth** for the public contract, authored as a typed object rather than a `.yaml` file: the repo has no YAML parser, `tsc` catches structural typos, and `scripts/verify-openapi.ts` can import it directly.
- Served unauthenticated at **`GET /api/openapi.json`** (it's in `publicPaths`), so a client author can read the contract before having credentials. `npm run openapi:write` emits the committed `openapi.json` for external tooling.
- `operationId`s live in one `OPERATION_IDS` table near the top of `openapi.ts`. `applyOperationIds()` **throws at import time** if a route has no id, if an id is duplicated, or if the table names a route that no longer exists — so adding a route without naming it is a startup failure, not a silently unnamed client method. They are public API: don't rename them once published.
- `verify:openapi` compares declared operations against `server.ts`'s route table **in both directions**, so neither an undocumented route nor a documented-but-missing one can slip through. It also asserts the concurrency contract is described (all 8 conditional routes document `If-Match` and 409; the bulk routes do *not* claim `If-Match`), and that `openapi.json` is not stale.
- Externally validated with `npx @redocly/cli lint openapi.json` (run via npx, deliberately not a dependency): **valid, 0 errors**. Four warnings remain and are all expected — a `localhost` server URL (correct: this is a self-hosted local app), `/e/{token}` vs `/{shortId}/epg` reported as ambiguous (unavoidable in path templating; at runtime the short-id routes are digit-only regexes registered after `/e/:token`), and two `operation-4xx-response` on `/api/auth/status` and `/api/openapi.json`, which genuinely have no meaningful 4xx.

### Optimistic concurrency (the sync contract)

- Clients read a resource, take its `version`, and send it back on the next write as `If-Match`. A successful write returns the new version in an `ETag` header.
- A stale version gets **409** with `{ error, currentVersion, current }` — the body carries the current server state so the client can merge and retry without a second round trip. The 409 also sets `ETag` to the current version.
- **`If-Match` is optional.** RFC 9110 treats a missing precondition as "no precondition", and the existing web UI sends none, so omitting it means last-write-wins. A sync client SHOULD always send it.
- Accepted header forms: `3`, `"3"`, `W/"3"`. `*` means no precondition. Anything else is **400** — distinct from 409, so a client can tell a bug from a conflict.
- **404 beats 409**: a missing resource is 404 even with `If-Match`.
- The bulk routes (`bulk-update`, `bulk-update-many`, `bulk-replace`, `bulk-delete`, `reorder`) do **not** support `If-Match` — they span many rows with independent versions. They remain last-write-wins; a sync client that needs per-record safety should use the single-resource routes.

### Frontend data flow: no query library — hand-rolled fetch + event bus

- `src/apiClient.ts` exports one `api` object holding every REST call, plus fetch-on-mount hooks (`usePlaylists`, `useChannels`, `useEpgSources`, `useChannelPoolSources`).
- There's no cache/invalidation library. After a mutation, call the matching `trigger*Refresh()` (`triggerRefresh` / `triggerEpgRefresh` / `triggerChannelPoolRefresh`), which dispatches a `refresh` event on a plain `EventTarget` (`dbEvents` / `epgEvents` / `channelPoolEvents`); every hook subscribed to that bus refetches. Forgetting to call the right trigger after adding a new mutation leaves the UI silently stale.
- Cross-cutting UI/app state (active playlist/category, sidebar width, theme, accent color, hide-URLs, etc.) lives in one Zustand store, `src/store.ts`. Only cosmetic fields are persisted to localStorage via `partialize` (`logoBgColor`, `accentColor`, `isDarkMode`, `isAmoledMode`, `is24Hour`) — navigation/selection state resets on reload.

### Three feature surfaces, one `Dashboard.tsx` shell

`Dashboard.tsx` renders a sidebar (playlist/source/EPG list depending on tab) + a main viewer, switched by `activeView` in the store:

1. **My Playlists** — `PlaylistEditor.tsx` + `CategoryList.tsx`. Drag-reorder (dnd-kit) for both channels and categories, inline click-to-edit fields, multi-select bulk move/delete/find-replace, a stream health checker (HEAD, falling back to GET, per channel), TVG-ID autocomplete against the EPG pool, and client-side pagination (100 channels/page) per category.
2. **Sources** — `ChannelPoolViewer.tsx` + `ChannelPoolUpdateLog.tsx` (collapsible right-hand drawer) + `AddChannelPoolSourceDialog.tsx`. Browse/search a channel-pool source and bulk-add selected channels into a real playlist (with optional category override).
3. **EPG** — `EpgViewer.tsx` (a manually-windowed/virtualized timeline grid, not a library) rendering `/api/epg-sources/:id/now`, plus `EpgProgramDialog.tsx` and `AddEpgSourceDialog.tsx`. `BulkEpgAssignDialog.tsx` fuzzy-matches (trigram + word-overlap scoring, computed client-side) playlist channel names against EPG channel names and bulk-assigns `tvgId` in chunks (with cancel/revert support). `AssignTvgIdDialog.tsx` is the reverse flow: pick one EPG channel, then assign it to channels chosen from across any playlist.

M3U/XSPF parsing for channel-pool sources happens entirely server-side (`parseM3uToChannelPoolEntries` / `parseXspfToChannelPoolEntries` in `server.ts`) — there is no client-side parser; an earlier `src/utils/m3uParser.ts` that duplicated this logic client-side was removed once nothing imported it.

### Styling conventions

- Tailwind v4 (CSS-first config via `@tailwindcss/vite`, no `tailwind.config.js`). Two custom variants are defined in `src/index.css`: `dark` (class-based, toggled on `<html>`) and `amoled` (stacks with `dark`, e.g. `amoled:dark:bg-black`, for true-black surfaces).
- `.md-btn` and `.elev-{1,2,4,8,16,24}` in `index.css` are hand-rolled Material Design 2 ripple/elevation utilities used throughout instead of a component library.
- Accent color is a user setting (`useStore().accentColor`) applied via inline `style={{ color/backgroundColor: accentColor }}` rather than Tailwind classes, since it's arbitrary/user-picked. `contrastText()` and `accentAlpha()` in `store.ts` compute readable foreground text and tinted backgrounds against it.

### Non-`/api` routes served directly by `server.ts`

- `GET /:shortId` — the playlist as `#EXTM3U` text (`serveM3U()`).
- `GET /:shortId/epg` — an XMLTV `<tv>` document built from the in-memory EPG cache, filtered to that playlist's channels' `tvgId`s.
- `GET /api/playlists/:exportId.m3u` — legacy long-form export URL, kept only for backwards compatibility with links generated before `shortId` existed.
