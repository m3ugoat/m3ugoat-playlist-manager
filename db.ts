// ── SQLite data layer ───────────────────────────────────────────────────────
//
// Replaces the previous single-JSON-file store (data/db.json), which parsed and
// rewrote the whole document on every mutation. That was safe only by accident:
// Node's single thread meant a synchronous read-modify-write could not be
// interleaved. One `await` between the read and the write, or a second process
// (PM2 cluster mode), and unrelated records get clobbered. It also rewrote ~5 MB
// per single-channel edit and offered no way to compare-and-swap.
//
// Every write here is a scoped statement, in a transaction where more than one
// statement is involved.
//
// Conventions, kept deliberately boring:
//   - Columns are snake_case; the TypeScript objects stay camelCase. Each table
//     has an explicit `rowTo*` mapper below — no automatic name conversion.
//   - Lists that need to keep their order (playlist categories, changelog
//     entries) are stored as JSON text in a single column.
//   - `version` is written but not yet enforced; optimistic concurrency
//     (If-Match / 409) arrives in a later phase.

import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes } from "crypto";
import path from "path";
import fs from "fs";

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Both paths can be overridden so tests and one-off checks can run against a
// throwaway database instead of the live one.
export const DB_PATH = process.env.M3U4ME_DB_PATH || path.join(DATA_DIR, "m3u4me.db");
export const LEGACY_JSON_PATH =
  process.env.M3U4ME_LEGACY_JSON || path.join(DATA_DIR, "db.json");

// ── Types (shared with server.ts; frontend copy lives in src/apiClient.ts) ──

export interface Playlist {
  id: string;
  name: string;
  userId: string;
  categories: string[];
  exportId: string;
  shortId: number;
  /** Secret used by the public /e/:token export URLs. Rotatable. */
  exportToken: string;
  createdAt: number;
  updatedAt: number;
}

export interface Channel {
  id: string;
  playlistId: string;
  name: string;
  url: string;
  logo: string | null;
  tvgId: string | null;
  category: string;
  order: number;
  isHidden?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EpgSource {
  id: string;
  userId: string;
  name: string;
  url: string;
  type: "xml" | "xtream";
  xtreamCredentials?: { username: string; password: string };
  refreshIntervalHours: number;
  lastFetched: number | null;
  lastFetchError: string | null;
  channelCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelPoolSource {
  id: string;
  userId: string;
  name: string;
  type: "xtream" | "playlist-url" | "playlist-file";
  url: string | null;
  xtreamCredentials?: { username: string; password: string };
  refreshIntervalHours: number;
  lastFetched: number | null;
  lastFetchError: string | null;
  channelCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelPoolEntry {
  id: string;
  sourceId: string;
  name: string;
  url: string;
  logo: string | null;
  category: string;
  tvgId: string | null;
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  recoveryKeyHash: string;
  recoveryKeySalt: string;
  isAdmin: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A logged-in device. `token_hash` is never exposed through the API. */
export interface DeviceToken {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface ChannelPoolChangeLog {
  id: string;
  sourceId: string;
  sourceName: string;
  timestamp: number;
  added: { name: string; category: string }[];
  removed: { name: string; category: string }[];
  renamed: { oldName: string; newName: string; category: string }[];
}

// ── Connection and schema ───────────────────────────────────────────────────

export const db = new DatabaseSync(DB_PATH);

// WAL lets readers carry on while a write is in flight — the reason multiple
// devices can hit this concurrently at all.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
// Wait rather than throw SQLITE_BUSY if another write holds the lock.
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS playlists (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    categories  TEXT NOT NULL DEFAULT '[]',
    export_id   TEXT NOT NULL UNIQUE,
    short_id    INTEGER NOT NULL UNIQUE,
    -- Unguessable, rotatable secret for the public /e/:token export URLs.
    export_token TEXT UNIQUE,
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channels (
    id          TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    logo        TEXT,
    tvg_id      TEXT,
    category    TEXT NOT NULL,
    sort_order  INTEGER NOT NULL,
    is_hidden   INTEGER NOT NULL DEFAULT 0,
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS epg_sources (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL DEFAULT 'local-user',
    name                  TEXT NOT NULL,
    url                   TEXT NOT NULL,
    type                  TEXT NOT NULL,
    xtream_username       TEXT,
    xtream_password       TEXT,
    refresh_interval_hours INTEGER NOT NULL DEFAULT 12,
    last_fetched          INTEGER,
    last_fetch_error      TEXT,
    channel_count         INTEGER NOT NULL DEFAULT 0,
    version               INTEGER NOT NULL DEFAULT 1,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_pool_sources (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL DEFAULT 'local-user',
    name                  TEXT NOT NULL,
    type                  TEXT NOT NULL,
    url                   TEXT,
    xtream_username       TEXT,
    xtream_password       TEXT,
    refresh_interval_hours INTEGER NOT NULL DEFAULT 24,
    last_fetched          INTEGER,
    last_fetch_error      TEXT,
    channel_count         INTEGER NOT NULL DEFAULT 0,
    version               INTEGER NOT NULL DEFAULT 1,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_pool_entries (
    id        TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES channel_pool_sources(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    url       TEXT NOT NULL,
    logo      TEXT,
    category  TEXT NOT NULL,
    tvg_id    TEXT
  );

  -- Changelogs have no foreign key so that pruning/retention is driven purely by
  -- timestamp. Deleting a source still clears its logs, via deleteBySource().
  CREATE TABLE IF NOT EXISTS channel_pool_change_logs (
    id          TEXT PRIMARY KEY,
    source_id   TEXT NOT NULL,
    source_name TEXT NOT NULL,
    timestamp   INTEGER NOT NULL,
    added       TEXT NOT NULL DEFAULT '[]',
    removed     TEXT NOT NULL DEFAULT '[]',
    renamed     TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS users (
    id                TEXT PRIMARY KEY,
    username          TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash     TEXT NOT NULL,
    password_salt     TEXT NOT NULL,
    recovery_key_hash TEXT NOT NULL,
    recovery_key_salt TEXT NOT NULL,
    is_admin          INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  -- One row per logged-in device. Only the SHA-256 of the bearer token is
  -- stored, so a copy of this database does not yield usable credentials.
  -- Rows are durable, which is what lets a device stay logged in across a
  -- server restart (the old in-memory Set did not).
  CREATE TABLE IF NOT EXISTS device_tokens (
    id           TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
  -- The user_id indexes for epg_sources and channel_pool_sources are created in
  -- the migration section below, not here: on a database that predates those
  -- columns, CREATE TABLE IF NOT EXISTS is a no-op and indexing a column that
  -- does not exist yet fails the whole batch.
  CREATE INDEX IF NOT EXISTS idx_playlists_user      ON playlists(user_id);
  CREATE INDEX IF NOT EXISTS idx_channels_playlist   ON channels(playlist_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_channels_tvg        ON channels(tvg_id);
  CREATE INDEX IF NOT EXISTS idx_pool_entries_source ON channel_pool_entries(source_id);
  CREATE INDEX IF NOT EXISTS idx_pool_entries_cat    ON channel_pool_entries(source_id, category);
  CREATE INDEX IF NOT EXISTS idx_pool_logs_source    ON channel_pool_change_logs(source_id, timestamp);
`);

// ── In-place schema migration ───────────────────────────────────────────────
//
// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
// databases created by an earlier phase need their new columns added. Both are
// idempotent and cheap enough to run on every boot.

function addColumnIfMissing(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// Existing rows predate multi-user, so they belong to the legacy account.
addColumnIfMissing("epg_sources", "user_id", "user_id TEXT NOT NULL DEFAULT 'local-user'");
addColumnIfMissing("channel_pool_sources", "user_id", "user_id TEXT NOT NULL DEFAULT 'local-user'");
// Nullable + a unique index rather than NOT NULL UNIQUE: ALTER TABLE cannot add
// a unique column with a constant default without every row colliding.
addColumnIfMissing("playlists", "export_token", "export_token TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_export_token ON playlists(export_token)");
db.exec("CREATE INDEX IF NOT EXISTS idx_epg_sources_user  ON epg_sources(user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_pool_sources_user ON channel_pool_sources(user_id)");

/** 256 bits, URL-safe — the secret in a public export link. */
export function newExportToken(): string {
  return randomBytes(32).toString("base64url");
}

// Backfill playlists that predate export_token.
for (const r of db.prepare("SELECT id FROM playlists WHERE export_token IS NULL").all() as Row[]) {
  db.prepare("UPDATE playlists SET export_token = ? WHERE id = ?").run(newExportToken(), r.id);
}

// ── Row mappers ─────────────────────────────────────────────────────────────

type Row = Record<string, any>;

const toBool = (v: any) => v === 1 || v === true;
const fromBool = (v: any) => (v ? 1 : 0);
const parseJson = <T>(text: any, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

function rowToPlaylist(r: Row): Playlist {
  return {
    id: r.id,
    name: r.name,
    userId: r.user_id,
    categories: parseJson<string[]>(r.categories, []),
    exportId: r.export_id,
    shortId: r.short_id,
    exportToken: r.export_token,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToChannel(r: Row): Channel {
  return {
    id: r.id,
    playlistId: r.playlist_id,
    name: r.name,
    url: r.url,
    logo: r.logo ?? null,
    tvgId: r.tvg_id ?? null,
    category: r.category,
    order: r.sort_order,
    isHidden: toBool(r.is_hidden),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function credsFrom(r: Row) {
  return r.xtream_username != null
    ? { username: r.xtream_username, password: r.xtream_password ?? "" }
    : undefined;
}

function rowToEpgSource(r: Row): EpgSource {
  const s: EpgSource = {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    url: r.url,
    type: r.type,
    refreshIntervalHours: r.refresh_interval_hours,
    lastFetched: r.last_fetched ?? null,
    lastFetchError: r.last_fetch_error ?? null,
    channelCount: r.channel_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  const creds = credsFrom(r);
  if (creds) s.xtreamCredentials = creds;
  return s;
}

function rowToPoolSource(r: Row): ChannelPoolSource {
  const s: ChannelPoolSource = {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    type: r.type,
    url: r.url ?? null,
    refreshIntervalHours: r.refresh_interval_hours,
    lastFetched: r.last_fetched ?? null,
    lastFetchError: r.last_fetch_error ?? null,
    channelCount: r.channel_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  const creds = credsFrom(r);
  if (creds) s.xtreamCredentials = creds;
  return s;
}

function rowToPoolEntry(r: Row): ChannelPoolEntry {
  return {
    id: r.id,
    sourceId: r.source_id,
    name: r.name,
    url: r.url,
    logo: r.logo ?? null,
    category: r.category,
    tvgId: r.tvg_id ?? null,
  };
}

function rowToChangeLog(r: Row): ChannelPoolChangeLog {
  return {
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    timestamp: r.timestamp,
    added: parseJson(r.added, []),
    removed: parseJson(r.removed, []),
    renamed: parseJson(r.renamed, []),
  };
}

// ── Transactions ────────────────────────────────────────────────────────────

/**
 * Runs `fn` inside a single transaction. Any throw rolls the whole thing back,
 * so a multi-statement write (e.g. reordering every channel in a playlist) can
 * never land half-applied the way the old whole-file rewrite could.
 */
export function inTransaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* rollback of an already-aborted transaction is not itself an error */
    }
    throw err;
  }
}

// ── Playlists ───────────────────────────────────────────────────────────────

export const playlists = {
  /**
   * Every read and write is scoped by userId. Passing the owner in explicitly
   * (rather than filtering at the route) means a missing scope is a type error
   * rather than a silent cross-account leak.
   */
  all(userId: string): Playlist[] {
    return db
      .prepare("SELECT * FROM playlists WHERE user_id = ? ORDER BY short_id")
      .all(userId)
      .map(rowToPlaylist);
  },
  byId(id: string, userId: string): Playlist | null {
    const r = db.prepare("SELECT * FROM playlists WHERE id = ? AND user_id = ?").get(id, userId);
    return r ? rowToPlaylist(r as Row) : null;
  },
  /** Public export lookup: the token is the credential, so this is not scoped. */
  byExportToken(token: string): Playlist | null {
    const r = db.prepare("SELECT * FROM playlists WHERE export_token = ?").get(token);
    return r ? rowToPlaylist(r as Row) : null;
  },
  /**
   * Unscoped shortId lookup, only for the legacy /:shortId routes. shortId is a
   * small incrementing integer, so this is enumerable across accounts — the
   * caller must gate it (see ALLOW_INSECURE_SHORT_IDS in server.ts).
   */
  byShortIdUnscoped(shortId: number): Playlist | null {
    const r = db.prepare("SELECT * FROM playlists WHERE short_id = ?").get(shortId);
    return r ? rowToPlaylist(r as Row) : null;
  },
  byExportId(exportId: string, userId: string): Playlist | null {
    const r = db
      .prepare("SELECT * FROM playlists WHERE export_id = ? AND user_id = ?")
      .get(exportId, userId);
    return r ? rowToPlaylist(r as Row) : null;
  },
  /** shortId stays globally unique so the legacy URLs keep working. */
  nextShortId(): number {
    const r = db.prepare("SELECT COALESCE(MAX(short_id), 0) + 1 AS next FROM playlists").get() as Row;
    return r.next;
  },
  insert(p: Playlist): void {
    db.prepare(
      `INSERT INTO playlists
         (id, user_id, name, categories, export_id, short_id, export_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id,
      p.userId,
      p.name,
      JSON.stringify(p.categories ?? []),
      p.exportId,
      p.shortId,
      p.exportToken || newExportToken(),
      p.createdAt,
      p.updatedAt,
    );
  },
  update(id: string, userId: string, patch: Partial<Playlist>): Playlist | null {
    const current = this.byId(id, userId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    db.prepare(
      `UPDATE playlists
          SET name = ?, categories = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND user_id = ?`,
    ).run(next.name, JSON.stringify(next.categories ?? []), next.updatedAt, id, userId);
    return next;
  },
  /** Invalidates any export link already handed out for this playlist. */
  rotateExportToken(id: string, userId: string): string | null {
    const token = newExportToken();
    const changed = db
      .prepare(
        "UPDATE playlists SET export_token = ?, updated_at = ?, version = version + 1 WHERE id = ? AND user_id = ?",
      )
      .run(token, Date.now(), id, userId).changes as number;
    return changed > 0 ? token : null;
  },
  delete(id: string, userId: string): boolean {
    // channels cascade via the foreign key
    return (
      (db.prepare("DELETE FROM playlists WHERE id = ? AND user_id = ?").run(id, userId)
        .changes as number) > 0
    );
  },
};

// ── Channels ────────────────────────────────────────────────────────────────

export const channels = {
  // Channels have no user_id of their own — ownership comes from their
  // playlist, so every scoped query joins through it. `OWNED` is that join.
  // Anything reachable by id must use it, or one account can read and edit
  // another's channels by guessing a UUID.

  /** Every channel belonging to a user, across all their playlists (for search). */
  allForUser(userId: string): Channel[] {
    return db
      .prepare(
        `SELECT c.* FROM channels c
           JOIN playlists p ON p.id = c.playlist_id
          WHERE p.user_id = ?`,
      )
      .all(userId)
      .map(rowToChannel);
  },
  byPlaylist(playlistId: string, userId: string): Channel[] {
    return db
      .prepare(
        `SELECT c.* FROM channels c
           JOIN playlists p ON p.id = c.playlist_id
          WHERE c.playlist_id = ? AND p.user_id = ?
          ORDER BY c.sort_order`,
      )
      .all(playlistId, userId)
      .map(rowToChannel);
  },
  /** Unscoped, for the public export routes where the token is the credential. */
  byPlaylistForExport(playlistId: string): Channel[] {
    return db
      .prepare("SELECT * FROM channels WHERE playlist_id = ? ORDER BY sort_order")
      .all(playlistId)
      .map(rowToChannel);
  },
  byId(id: string, userId: string): Channel | null {
    const r = db
      .prepare(
        `SELECT c.* FROM channels c
           JOIN playlists p ON p.id = c.playlist_id
          WHERE c.id = ? AND p.user_id = ?`,
      )
      .get(id, userId);
    return r ? rowToChannel(r as Row) : null;
  },
  maxOrder(playlistId: string): number {
    const r = db
      .prepare("SELECT COALESCE(MAX(sort_order), 0) AS mx FROM channels WHERE playlist_id = ?")
      .get(playlistId) as Row;
    return r.mx;
  },
  countByPlaylist(playlistId: string): number {
    const r = db
      .prepare("SELECT COUNT(*) AS n FROM channels WHERE playlist_id = ?")
      .get(playlistId) as Row;
    return r.n;
  },
  insert(c: Channel): void {
    db.prepare(
      `INSERT INTO channels
         (id, playlist_id, name, url, logo, tvg_id, category, sort_order, is_hidden, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.id,
      c.playlistId,
      c.name,
      c.url,
      c.logo ?? null,
      c.tvgId ?? null,
      c.category,
      c.order,
      fromBool(c.isHidden),
      c.createdAt,
      c.updatedAt,
    );
  },
  insertMany(list: Channel[]): void {
    const stmt = db.prepare(
      `INSERT INTO channels
         (id, playlist_id, name, url, logo, tvg_id, category, sort_order, is_hidden, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of list) {
      stmt.run(
        c.id,
        c.playlistId,
        c.name,
        c.url,
        c.logo ?? null,
        c.tvgId ?? null,
        c.category,
        c.order,
        fromBool(c.isHidden),
        c.createdAt,
        c.updatedAt,
      );
    }
  },
  update(id: string, userId: string, patch: Partial<Channel>): Channel | null {
    const current = this.byId(id, userId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    db.prepare(
      `UPDATE channels
          SET name = ?, url = ?, logo = ?, tvg_id = ?, category = ?,
              sort_order = ?, is_hidden = ?, updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(
      next.name,
      next.url,
      next.logo ?? null,
      next.tvgId ?? null,
      next.category,
      next.order,
      fromBool(next.isHidden),
      next.updatedAt,
      id,
    );
    return next;
  },
  setOrder(id: string, order: number, updatedAt = Date.now()): void {
    db.prepare(
      "UPDATE channels SET sort_order = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    ).run(order, updatedAt, id);
  },
  delete(id: string, userId: string): boolean {
    return (
      (db
        .prepare(
          `DELETE FROM channels
             WHERE id = ?
               AND playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)`,
        )
        .run(id, userId).changes as number) > 0
    );
  },
  deleteMany(ids: string[], userId: string): number {
    if (ids.length === 0) return 0;
    const stmt = db.prepare(
      `DELETE FROM channels
         WHERE id = ?
           AND playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)`,
    );
    let n = 0;
    for (const id of ids) n += stmt.run(id, userId).changes as number;
    return n;
  },
  deleteByPlaylist(playlistId: string): void {
    db.prepare("DELETE FROM channels WHERE playlist_id = ?").run(playlistId);
  },
  distinctTvgIds(userId: string): string[] {
    return db
      .prepare(
        `SELECT DISTINCT c.tvg_id FROM channels c
           JOIN playlists p ON p.id = c.playlist_id
          WHERE p.user_id = ? AND c.tvg_id IS NOT NULL AND c.tvg_id != ''`,
      )
      .all(userId)
      .map((r: any) => r.tvg_id);
  },
};

// ── EPG sources ─────────────────────────────────────────────────────────────

export const epgSources = {
  all(userId: string): EpgSource[] {
    return db
      .prepare("SELECT * FROM epg_sources WHERE user_id = ? ORDER BY created_at")
      .all(userId)
      .map(rowToEpgSource);
  },
  /** Unscoped — only for the boot/interval refresh loops, which run for every account. */
  allUnscoped(): EpgSource[] {
    return db.prepare("SELECT * FROM epg_sources ORDER BY created_at").all().map(rowToEpgSource);
  },
  byId(id: string, userId: string): EpgSource | null {
    const r = db.prepare("SELECT * FROM epg_sources WHERE id = ? AND user_id = ?").get(id, userId);
    return r ? rowToEpgSource(r as Row) : null;
  },
  /** Unscoped — used by the background refresh, which has no request user. */
  byIdUnscoped(id: string): EpgSource | null {
    const r = db.prepare("SELECT * FROM epg_sources WHERE id = ?").get(id);
    return r ? rowToEpgSource(r as Row) : null;
  },
  insert(s: EpgSource): void {
    db.prepare(
      `INSERT INTO epg_sources
         (id, user_id, name, url, type, xtream_username, xtream_password, refresh_interval_hours,
          last_fetched, last_fetch_error, channel_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.id,
      s.userId,
      s.name,
      s.url,
      s.type,
      s.xtreamCredentials?.username ?? null,
      s.xtreamCredentials?.password ?? null,
      s.refreshIntervalHours,
      s.lastFetched ?? null,
      s.lastFetchError ?? null,
      s.channelCount,
      s.createdAt,
      s.updatedAt,
    );
  },
  /** userId omitted deliberately: the refresh loop updates fetch status for any account. */
  update(id: string, patch: Partial<EpgSource>): EpgSource | null {
    const current = this.byIdUnscoped(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    db.prepare(
      `UPDATE epg_sources
          SET name = ?, url = ?, type = ?, xtream_username = ?, xtream_password = ?,
              refresh_interval_hours = ?, last_fetched = ?, last_fetch_error = ?,
              channel_count = ?, updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(
      next.name,
      next.url,
      next.type,
      next.xtreamCredentials?.username ?? null,
      next.xtreamCredentials?.password ?? null,
      next.refreshIntervalHours,
      next.lastFetched ?? null,
      next.lastFetchError ?? null,
      next.channelCount,
      next.updatedAt,
      id,
    );
    return next;
  },
  delete(id: string, userId: string): boolean {
    return (
      (db.prepare("DELETE FROM epg_sources WHERE id = ? AND user_id = ?").run(id, userId)
        .changes as number) > 0
    );
  },
};

// ── Channel pool sources ────────────────────────────────────────────────────

export const poolSources = {
  all(userId: string): ChannelPoolSource[] {
    return db
      .prepare("SELECT * FROM channel_pool_sources WHERE user_id = ? ORDER BY created_at")
      .all(userId)
      .map(rowToPoolSource);
  },
  /** Unscoped — only for the boot/interval refresh loops. */
  allUnscoped(): ChannelPoolSource[] {
    return db
      .prepare("SELECT * FROM channel_pool_sources ORDER BY created_at")
      .all()
      .map(rowToPoolSource);
  },
  byId(id: string, userId: string): ChannelPoolSource | null {
    const r = db
      .prepare("SELECT * FROM channel_pool_sources WHERE id = ? AND user_id = ?")
      .get(id, userId);
    return r ? rowToPoolSource(r as Row) : null;
  },
  /** Unscoped — used by the background refresh, which has no request user. */
  byIdUnscoped(id: string): ChannelPoolSource | null {
    const r = db.prepare("SELECT * FROM channel_pool_sources WHERE id = ?").get(id);
    return r ? rowToPoolSource(r as Row) : null;
  },
  insert(s: ChannelPoolSource): void {
    db.prepare(
      `INSERT INTO channel_pool_sources
         (id, user_id, name, type, url, xtream_username, xtream_password, refresh_interval_hours,
          last_fetched, last_fetch_error, channel_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.id,
      s.userId,
      s.name,
      s.type,
      s.url ?? null,
      s.xtreamCredentials?.username ?? null,
      s.xtreamCredentials?.password ?? null,
      s.refreshIntervalHours,
      s.lastFetched ?? null,
      s.lastFetchError ?? null,
      s.channelCount,
      s.createdAt,
      s.updatedAt,
    );
  },
  /** userId omitted deliberately: the refresh loop updates fetch status for any account. */
  update(id: string, patch: Partial<ChannelPoolSource>): ChannelPoolSource | null {
    const current = this.byIdUnscoped(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    db.prepare(
      `UPDATE channel_pool_sources
          SET name = ?, type = ?, url = ?, xtream_username = ?, xtream_password = ?,
              refresh_interval_hours = ?, last_fetched = ?, last_fetch_error = ?,
              channel_count = ?, updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(
      next.name,
      next.type,
      next.url ?? null,
      next.xtreamCredentials?.username ?? null,
      next.xtreamCredentials?.password ?? null,
      next.refreshIntervalHours,
      next.lastFetched ?? null,
      next.lastFetchError ?? null,
      next.channelCount,
      next.updatedAt,
      id,
    );
    return next;
  },
  delete(id: string, userId: string): boolean {
    // Entries cascade via the foreign key; changelogs are cleared explicitly by
    // the caller (see the DELETE route) to match the previous behaviour.
    return (
      (db.prepare("DELETE FROM channel_pool_sources WHERE id = ? AND user_id = ?").run(id, userId)
        .changes as number) > 0
    );
  },
};

// ── Channel pool entries ────────────────────────────────────────────────────

export const poolEntries = {
  bySource(sourceId: string): ChannelPoolEntry[] {
    return db
      .prepare("SELECT * FROM channel_pool_entries WHERE source_id = ?")
      .all(sourceId)
      .map(rowToPoolEntry);
  },
  countBySource(sourceId: string): number {
    const r = db
      .prepare("SELECT COUNT(*) AS n FROM channel_pool_entries WHERE source_id = ?")
      .get(sourceId) as Row;
    return r.n;
  },
  categoriesBySource(sourceId: string): string[] {
    return db
      .prepare(
        "SELECT DISTINCT category FROM channel_pool_entries WHERE source_id = ? ORDER BY category",
      )
      .all(sourceId)
      .map((r: any) => r.category);
  },
  replaceForSource(sourceId: string, list: ChannelPoolEntry[]): void {
    db.prepare("DELETE FROM channel_pool_entries WHERE source_id = ?").run(sourceId);
    const stmt = db.prepare(
      `INSERT INTO channel_pool_entries (id, source_id, name, url, logo, category, tvg_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of list) {
      stmt.run(e.id, sourceId, e.name, e.url, e.logo ?? null, e.category, e.tvgId ?? null);
    }
  },
  deleteBySource(sourceId: string): void {
    db.prepare("DELETE FROM channel_pool_entries WHERE source_id = ?").run(sourceId);
  },
};

// ── Channel pool changelogs ─────────────────────────────────────────────────

export const poolChangeLogs = {
  /** Scoped through the owning source, so one account never sees another's history. */
  all(userId: string): ChannelPoolChangeLog[] {
    return db
      .prepare(
        `SELECT l.* FROM channel_pool_change_logs l
           JOIN channel_pool_sources s ON s.id = l.source_id
          WHERE s.user_id = ?
          ORDER BY l.timestamp DESC`,
      )
      .all(userId)
      .map(rowToChangeLog);
  },
  insert(log: ChannelPoolChangeLog): void {
    db.prepare(
      `INSERT INTO channel_pool_change_logs
         (id, source_id, source_name, timestamp, added, removed, renamed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      log.id,
      log.sourceId,
      log.sourceName,
      log.timestamp,
      JSON.stringify(log.added ?? []),
      JSON.stringify(log.removed ?? []),
      JSON.stringify(log.renamed ?? []),
    );
  },
  deleteBySource(sourceId: string): void {
    db.prepare("DELETE FROM channel_pool_change_logs WHERE source_id = ?").run(sourceId);
  },
  /**
   * Matches the previous 90-day pruning behaviour, which kept only logs with
   * `timestamp > cutoff` — hence `<=` here rather than `<`.
   */
  pruneOlderThan(cutoff: number): number {
    return db
      .prepare("DELETE FROM channel_pool_change_logs WHERE timestamp <= ?")
      .run(cutoff).changes as number;
  },
};

// ── Users and device tokens ─────────────────────────────────────────────────

function rowToUser(r: Row): User {
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    passwordSalt: r.password_salt,
    recoveryKeyHash: r.recovery_key_hash,
    recoveryKeySalt: r.recovery_key_salt,
    isAdmin: toBool(r.is_admin),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The id given to the account migrated out of data/auth.json. It matches the
 *  `userId` already stored on pre-existing playlists, so that data belongs to
 *  this account without needing to be rewritten. */
export const LEGACY_USER_ID = "local-user";

export const users = {
  count(): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as Row).n;
  },
  /** Auth is a no-op while this is true, matching the old "no password set" behaviour. */
  none(): boolean {
    return this.count() === 0;
  },
  all(): User[] {
    return db.prepare("SELECT * FROM users ORDER BY created_at").all().map(rowToUser);
  },
  byId(id: string): User | null {
    const r = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return r ? rowToUser(r as Row) : null;
  },
  byUsername(username: string): User | null {
    const r = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    return r ? rowToUser(r as Row) : null;
  },
  /** Used when a login omits a username and exactly one account exists. */
  only(): User | null {
    const all = this.all();
    return all.length === 1 ? all[0] : null;
  },
  insert(u: User): void {
    db.prepare(
      `INSERT INTO users
         (id, username, password_hash, password_salt, recovery_key_hash,
          recovery_key_salt, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      u.id,
      u.username,
      u.passwordHash,
      u.passwordSalt,
      u.recoveryKeyHash,
      u.recoveryKeySalt,
      fromBool(u.isAdmin),
      u.createdAt,
      u.updatedAt,
    );
  },
  updateCredentials(
    id: string,
    creds: Pick<User, "passwordHash" | "passwordSalt" | "recoveryKeyHash" | "recoveryKeySalt">,
  ): void {
    db.prepare(
      `UPDATE users
          SET password_hash = ?, password_salt = ?, recovery_key_hash = ?,
              recovery_key_salt = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      creds.passwordHash,
      creds.passwordSalt,
      creds.recoveryKeyHash,
      creds.recoveryKeySalt,
      Date.now(),
      id,
    );
  },
  delete(id: string): void {
    // device_tokens cascade via the foreign key
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  },
};

export const deviceTokens = {
  /** Resolves a presented bearer token. Callers pass the SHA-256 hash, never the raw token. */
  byTokenHash(tokenHash: string): DeviceToken | null {
    const r = db
      .prepare("SELECT id, user_id, name, created_at, last_seen_at FROM device_tokens WHERE token_hash = ?")
      .get(tokenHash) as Row | undefined;
    return r
      ? {
          id: r.id,
          userId: r.user_id,
          name: r.name,
          createdAt: r.created_at,
          lastSeenAt: r.last_seen_at,
        }
      : null;
  },
  insert(rec: { id: string; tokenHash: string; userId: string; name: string }): DeviceToken {
    const now = Date.now();
    db.prepare(
      `INSERT INTO device_tokens (id, token_hash, user_id, name, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(rec.id, rec.tokenHash, rec.userId, rec.name, now, now);
    return { id: rec.id, userId: rec.userId, name: rec.name, createdAt: now, lastSeenAt: now };
  },
  touch(id: string, at = Date.now()): void {
    db.prepare("UPDATE device_tokens SET last_seen_at = ? WHERE id = ?").run(at, id);
  },
  listByUser(userId: string): DeviceToken[] {
    return db
      .prepare(
        `SELECT id, user_id, name, created_at, last_seen_at
           FROM device_tokens WHERE user_id = ? ORDER BY last_seen_at DESC`,
      )
      .all(userId)
      .map((r: any) => ({
        id: r.id,
        userId: r.user_id,
        name: r.name,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
      }));
  },
  /** Revokes one device. Scoped by user so a token can only revoke its own account's devices. */
  revoke(id: string, userId: string): boolean {
    return (
      (db.prepare("DELETE FROM device_tokens WHERE id = ? AND user_id = ?").run(id, userId)
        .changes as number) > 0
    );
  },
  revokeByTokenHash(tokenHash: string): void {
    db.prepare("DELETE FROM device_tokens WHERE token_hash = ?").run(tokenHash);
  },
  revokeAllForUser(userId: string): number {
    return db.prepare("DELETE FROM device_tokens WHERE user_id = ?").run(userId)
      .changes as number;
  },
};

// ── One-time migration from data/auth.json ──────────────────────────────────

export const LEGACY_AUTH_PATH =
  process.env.M3U4ME_LEGACY_AUTH || path.join(DATA_DIR, "auth.json");

/**
 * Turns the old single global password (data/auth.json) into the first user
 * account, reusing the existing PBKDF2 hashes so the same password keeps
 * working. Runs only when no users exist yet, so it is safe to call on every
 * boot. The JSON file is left in place as a rollback copy.
 */
export function migrateFromAuthJson(): { migrated: boolean; username?: string } {
  if (users.count() > 0) return { migrated: false };
  if (!fs.existsSync(LEGACY_AUTH_PATH)) return { migrated: false };

  let auth: any;
  try {
    auth = JSON.parse(fs.readFileSync(LEGACY_AUTH_PATH, "utf-8"));
  } catch (err) {
    console.error("Could not parse data/auth.json; skipping auth migration.", err);
    return { migrated: false };
  }
  if (!auth?.passwordHash || !auth?.passwordSalt) return { migrated: false };

  const now = Date.now();
  users.insert({
    id: LEGACY_USER_ID,
    username: "admin",
    passwordHash: auth.passwordHash,
    passwordSalt: auth.passwordSalt,
    // A pre-users install always had a recovery key, but tolerate its absence.
    recoveryKeyHash: auth.recoveryKeyHash ?? "",
    recoveryKeySalt: auth.recoveryKeySalt ?? "",
    isAdmin: true,
    createdAt: now,
    updatedAt: now,
  });
  return { migrated: true, username: "admin" };
}

// ── One-time migration from data/db.json ────────────────────────────────────

/**
 * Copies data/db.json into SQLite the first time the server boots after the
 * switch. Runs only when the JSON file exists and the database is still empty,
 * so it is safe to call unconditionally. The JSON file is left untouched — it
 * becomes the rollback copy.
 */
export function migrateFromJson(): { migrated: boolean; counts?: Record<string, number> } {
  if (!fs.existsSync(LEGACY_JSON_PATH)) return { migrated: false };

  const existing = db.prepare("SELECT COUNT(*) AS n FROM playlists").get() as Row;
  const existingSources = db.prepare("SELECT COUNT(*) AS n FROM channel_pool_sources").get() as Row;
  if (existing.n > 0 || existingSources.n > 0) return { migrated: false };

  let json: any;
  try {
    json = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, "utf-8"));
  } catch (err) {
    console.error("Could not parse data/db.json; skipping migration.", err);
    return { migrated: false };
  }

  const counts: Record<string, number> = {};
  inTransaction(() => {
    // short_id and export_id are NOT NULL UNIQUE in the schema, so backfill any
    // playlist that predates those fields. This subsumes the old
    // migrateShortIds() pass, which the constraints now make unnecessary.
    let maxShortId = 0;
    for (const p of json.playlists ?? []) {
      if (typeof p.shortId === "number" && p.shortId > maxShortId) maxShortId = p.shortId;
    }
    for (const p of json.playlists ?? []) {
      playlists.insert({
        ...p,
        userId: p.userId ?? "local-user",
        categories: p.categories ?? [],
        shortId: p.shortId || ++maxShortId,
        exportId: p.exportId || randomUUID(),
        exportToken: p.exportToken || newExportToken(),
      });
    }
    counts.playlists = (json.playlists ?? []).length;

    channels.insertMany(json.channels ?? []);
    counts.channels = (json.channels ?? []).length;

    // Pre-existing sources predate multi-user, so they belong to the legacy account.
    for (const s of json.epgSources ?? []) epgSources.insert({ ...s, userId: s.userId ?? LEGACY_USER_ID });
    counts.epgSources = (json.epgSources ?? []).length;

    for (const s of json.channelPoolSources ?? []) poolSources.insert({ ...s, userId: s.userId ?? LEGACY_USER_ID });
    counts.channelPoolSources = (json.channelPoolSources ?? []).length;

    // Grouped per source so each insert satisfies the foreign key.
    const bySource = new Map<string, ChannelPoolEntry[]>();
    for (const e of json.channelPoolEntries ?? []) {
      if (!bySource.has(e.sourceId)) bySource.set(e.sourceId, []);
      bySource.get(e.sourceId)!.push(e);
    }
    let entryCount = 0;
    for (const [sourceId, list] of bySource) {
      if (!poolSources.byIdUnscoped(sourceId)) {
        console.warn(
          `Skipping ${list.length} pool entries for missing source ${sourceId}`,
        );
        continue;
      }
      poolEntries.replaceForSource(sourceId, list);
      entryCount += list.length;
    }
    counts.channelPoolEntries = entryCount;

    for (const l of json.channelPoolChangeLogs ?? []) poolChangeLogs.insert(l);
    counts.channelPoolChangeLogs = (json.channelPoolChangeLogs ?? []).length;
  });

  return { migrated: true, counts };
}
