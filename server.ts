import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { gunzipSync } from "zlib";
import { XMLParser } from "fast-xml-parser";
import * as store from "./db.ts";
import type {
  Playlist,
  Channel,
  EpgSource,
  ChannelPoolSource,
  ChannelPoolEntry,
  ChannelPoolChangeLog,
  User,
  DeviceToken,
} from "./db.ts";

// The auth middleware resolves the bearer token once and hangs the result here
// so every downstream handler can read the caller's identity.
declare global {
  namespace Express {
    interface Request {
      user?: User;
      device?: DeviceToken;
    }
  }
}
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}


// Persistence lives in db.ts (SQLite). The previous store rewrote the whole of
// data/db.json on every mutation, which loses updates as soon as more than one
// client writes; every write below is now a scoped statement in a transaction.
// data/db.json is migrated on first boot and then left alone as a rollback copy.
const migration = store.migrateFromJson();
if (migration.migrated) {
  console.log("Migrated data/db.json into SQLite:", migration.counts);
}

// ── EPG Cache and Parser ─────────────────────────────────────────────────
interface ParsedEpgChannel {
  id: string;
  displayName: string;
  icon: string | null;
}

interface ParsedEpgProgramme {
  channel: string;
  title: string;
  desc: string | null;
  start: string;
  stop: string;
  category: string | null;
  date: string | null;
  episodeNum: string | null;
  subTitle: string | null;
  icon: string | null;
  rating: string | null;
}

const epgCache = new Map<string, { channels: ParsedEpgChannel[]; programmes: ParsedEpgProgramme[]; fetchedAt: number }>();

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['channel', 'programme', 'display-name', 'category', 'icon'].includes(name),
  // Keep tag text as-is (e.g. a channel display-name of "20" should stay the
  // string "20", not become the number 20 — downstream code assumes strings).
  parseTagValue: false,
});

// EPG sources are often large (multi-MB XMLTV documents) fetched over the
// open internet — without a timeout, a stalled connection would hang the
// refresh forever instead of failing and letting it be retried.
const EPG_FETCH_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAndParseEpg(source: EpgSource): Promise<{ channels: ParsedEpgChannel[]; programmes: ParsedEpgProgramme[] }> {
  let fetchUrl = source.url;
  if (source.type === 'xtream' && source.xtreamCredentials) {
    const baseUrl = source.url.replace(/\/$/, '');
    fetchUrl = `${baseUrl}/xmltv.php?username=${encodeURIComponent(source.xtreamCredentials.username)}&password=${encodeURIComponent(source.xtreamCredentials.password)}`;
  }

  const res = await fetchWithTimeout(fetchUrl, EPG_FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Failed to fetch EPG: ${res.statusText}`);
  const buf = await res.arrayBuffer();
  let xmlData = Buffer.from(buf);
  
  if (xmlData.length > 2 && xmlData[0] === 0x1F && xmlData[1] === 0x8B) {
    xmlData = gunzipSync(xmlData);
  }
  
  const parsed = xmlParser.parse(xmlData.toString('utf-8'));
  const tv = parsed.tv || {};
  
  const getText = (val: any) => typeof val === 'object' && val !== null ? val['#text'] || '' : val;
  
  const channels: ParsedEpgChannel[] = (tv.channel || []).map((c: any) => ({
    id: c['@_id'] || '',
    displayName: (c['display-name'] && c['display-name'][0] ? getText(c['display-name'][0]) : '') || '',
    icon: (c.icon && c.icon[0] ? c.icon[0]['@_src'] : null) || null,
  }));
  
  const programmes: ParsedEpgProgramme[] = (tv.programme || []).map((p: any) => ({
    channel: p['@_channel'] || '',
    start: p['@_start'] || '',
    stop: p['@_stop'] || '',
    title: getText(p.title) || '',
    desc: getText(p.desc) || null,
    category: p.category && p.category.length > 0 ? getText(p.category[0]) : null,
    date: p.date ? String(p.date) : null,
    episodeNum: p['episode-num'] ? getText(p['episode-num']) : null,
    subTitle: p['sub-title'] ? getText(p['sub-title']) : null,
    icon: (p.icon && p.icon[0] ? p.icon[0]['@_src'] : null) || null,
    rating: p.rating && p.rating.value ? String(p.rating.value) : null,
  }));
  
  return { channels, programmes };
}

async function refreshEpgSource(sourceId: string) {
  // Background refresh: runs for every account, so it is deliberately unscoped.
  const source = store.epgSources.byIdUnscoped(sourceId);
  if (!source) return;
  try {
    const data = await fetchAndParseEpg(source);
    epgCache.set(sourceId, { ...data, fetchedAt: Date.now() });

    store.epgSources.update(sourceId, {
      lastFetched: Date.now(),
      channelCount: data.channels.length,
      lastFetchError: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to refresh EPG source ${source.name}:`, err);
    store.epgSources.update(sourceId, { lastFetchError: message });
  }
}

// Refreshes EPG sources one at a time instead of all at once, so a batch of
// sources (e.g. every source refreshing together at server boot) doesn't
// pile concurrent large-file fetches onto the same moment — which is what
// can make an otherwise-healthy source fail its refresh right when the
// server starts.
async function refreshEpgSourcesSequentially(sourceIds: string[]) {
  for (const id of sourceIds) {
    await refreshEpgSource(id);
  }
}

// ── Channel Pool Cache and Functions ─────────────────────────────────────
const channelPoolCache = new Map<string, ChannelPoolEntry[]>();

async function fetchXtreamChannels(source: ChannelPoolSource): Promise<ChannelPoolEntry[]> {
  if (!source.url || !source.xtreamCredentials) return [];
  const baseUrl = source.url.replace(/\/$/, '');
  const { username, password } = source.xtreamCredentials;
  
  const catRes = await fetch(`${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_categories`);
  if (!catRes.ok) throw new Error(`Failed to fetch categories: ${catRes.statusText}`);
  const catData = await catRes.json();
  // Xtream panels respond with HTTP 200 even for an invalid/expired login — the body is
  // an error object (e.g. {"user_info":{"auth":0}}) instead of the expected array. Treating
  // that as "zero categories/channels" would make a transient auth hiccup look like a real,
  // empty refresh and wipe out every previously cached channel for this source, so it's
  // treated as a hard failure instead (caught by refreshChannelPoolSource, which leaves the
  // existing cached entries untouched on error).
  if (!Array.isArray(catData)) {
    throw new Error('Xtream server returned an unexpected response for categories (check the URL/username/password — the login may be invalid or expired).');
  }
  const catMap = new Map<string, string>();
  for (const c of catData) {
    catMap.set(String(c.category_id), c.category_name || 'General');
  }

  const streamsRes = await fetch(`${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`);
  if (!streamsRes.ok) throw new Error(`Failed to fetch streams: ${streamsRes.statusText}`);
  const streamsData = await streamsRes.json();
  if (!Array.isArray(streamsData)) {
    throw new Error('Xtream server returned an unexpected response for live streams (check the URL/username/password — the login may be invalid or expired).');
  }

  const entries: ChannelPoolEntry[] = [];
  for (const s of streamsData) {
    entries.push({
      id: uuidv4(),
      sourceId: source.id,
      name: s.name || 'Unknown',
      url: `${baseUrl}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.stream_id}.ts`,
      logo: s.stream_icon || null,
      category: catMap.get(String(s.category_id)) || 'General',
      tvgId: s.epg_channel_id || null,
    });
  }
  return entries;
}

function parseM3uToChannelPoolEntries(content: string, sourceId: string): ChannelPoolEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: ChannelPoolEntry[] = [];
  let currentEntry: Partial<ChannelPoolEntry> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) {
      const tvgIdMatch = line.match(/tvg-id="([^"]+)"/i);
      const tvgLogoMatch = line.match(/tvg-logo="([^"]+)"/i);
      const groupTitleMatch = line.match(/group-title="([^"]+)"/i);
      const nameMatch = line.match(/,(.+)$/);
      
      currentEntry = {
        tvgId: tvgIdMatch ? tvgIdMatch[1] : null,
        logo: tvgLogoMatch ? tvgLogoMatch[1] : null,
        category: groupTitleMatch ? groupTitleMatch[1] : 'General',
        name: nameMatch ? nameMatch[1].trim() : 'Unknown',
      };
    } else if (line && !line.startsWith('#')) {
      if (currentEntry.name) {
        entries.push({
          id: uuidv4(),
          sourceId,
          name: currentEntry.name || 'Unknown',
          url: line,
          logo: currentEntry.logo || null,
          category: currentEntry.category || 'General',
          tvgId: currentEntry.tvgId || null,
        });
        currentEntry = {};
      }
    }
  }
  return entries;
}

function parseXspfToChannelPoolEntries(content: string, sourceId: string): ChannelPoolEntry[] {
  const parsed = xmlParser.parse(content);
  const trackList = parsed?.playlist?.trackList?.track || [];
  const tracks = Array.isArray(trackList) ? trackList : [trackList];
  
  return tracks.map((t: any) => {
    let cat = 'General';
    if (t.extension && t.extension.application) cat = t.extension.application;
    if (t.annotation) cat = t.annotation;
    
    return {
      id: uuidv4(),
      sourceId,
      name: t.title || 'Unknown',
      url: t.location || '',
      logo: t.image || null,
      category: cat,
      tvgId: null,
    };
  }).filter((e: any) => e.url);
}

async function fetchPlaylistChannels(source: ChannelPoolSource): Promise<ChannelPoolEntry[]> {
  if (!source.url) return [];
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`Failed to fetch playlist: ${res.statusText}`);
  const content = await res.text();
  if (content.trim().startsWith('<?xml') && content.includes('<playlist')) {
    return parseXspfToChannelPoolEntries(content, source.id);
  }
  return parseM3uToChannelPoolEntries(content, source.id);
}

// Inspects M3U/XSPF text and returns a warning message if it looks like something
// other than a channel playlist (e.g. a raw HLS livestream / VOD segment feed), or
// null if it looks like a genuine playlist. Shared by the channel-pool URL validator
// and the "import playlist from M3U" flow so both surfaces agree on what's valid.
function detectPlaylistWarning(text: string): string | null {
  if (text.trim().startsWith('<?xml') && text.includes('<playlist')) {
    // XSPF playlist — trust the format's own structure.
    return null;
  }

  // Channel playlists (IPTV M3U) always have channel-specific EXTINF attributes.
  // Check for these first — if present the file is definitely a channel playlist regardless
  // of any HLS tags that might appear in it (e.g. some providers serve m3u8 master playlists).
  const hasChannelMarkers = (
    text.includes('#EXTM3U') &&
    (text.includes('tvg-id=') || text.includes('tvg-logo=') || text.includes('group-title='))
  );
  if (hasChannelMarkers) return null;

  // HLS media-segment / master playlists describe a single stream's variants or chunks,
  // not a list of channels — these are what "m3u8 livestream" links usually are.
  const isHlsStream = (
    text.includes('#EXT-X-TARGETDURATION') ||
    text.includes('#EXT-X-MEDIA-SEQUENCE') ||
    text.includes('#EXT-X-STREAM-INF')
  );
  if (isHlsStream) return "This is a channel stream link (M3U8 livestream), not a playlist";

  // At minimum a valid M3U playlist starts with #EXTM3U or contains #EXTINF entries.
  const isM3uRelated = text.includes('#EXTM3U') || text.includes('#EXTINF');
  if (!isM3uRelated) return "Not a valid M3U/XSPF playlist";

  return null;
}

/**
 * Keys entries by URL plus their occurrence index among entries sharing that URL
 * (e.g. "http://x#1", "http://x#2"), so duplicate-URL entries (mirrors/aliases,
 * common in real IPTV playlists) each get a distinct map key instead of clobbering
 * each other. The Nth entry at a given URL lines up against the Nth entry at that
 * URL on the other side of the diff.
 */
function keyEntriesByUrlOccurrence(entries: ChannelPoolEntry[]): Map<string, ChannelPoolEntry> {
  const seenCounts = new Map<string, number>();
  const byKey = new Map<string, ChannelPoolEntry>();
  for (const e of entries) {
    const occurrence = (seenCounts.get(e.url) || 0) + 1;
    seenCounts.set(e.url, occurrence);
    byKey.set(`${e.url}#${occurrence}`, e);
  }
  return byKey;
}

/** Diffs old vs. new entries and logs the changes. Returns whether anything actually changed. */
function detectChannelPoolChanges(sourceId: string, newEntries: ChannelPoolEntry[]): boolean {
  const oldEntries = store.poolEntries.bySource(sourceId);
  const source = store.poolSources.byIdUnscoped(sourceId);

  if (!oldEntries.length) {
    store.inTransaction(() => store.poolEntries.replaceForSource(sourceId, newEntries));
    return newEntries.length > 0;
  }

  const oldByUrl = keyEntriesByUrlOccurrence(oldEntries);
  const newByUrl = keyEntriesByUrlOccurrence(newEntries);

  const added: { name: string; category: string }[] = [];
  const removed: { name: string; category: string }[] = [];
  const renamed: { oldName: string; newName: string; category: string }[] = [];

  for (const [key, ne] of newByUrl.entries()) {
    const oe = oldByUrl.get(key);
    if (!oe) {
      added.push({ name: ne.name, category: ne.category });
    } else if (oe.name !== ne.name) {
      renamed.push({ oldName: oe.name, newName: ne.name, category: ne.category });
    }
  }

  for (const [key, oe] of oldByUrl.entries()) {
    if (!newByUrl.has(key)) {
      removed.push({ name: oe.name, category: oe.category });
    }
  }
  
  const hasChanges = added.length > 0 || removed.length > 0 || renamed.length > 0;

  // The changelog append, the 90-day prune and the entry swap go in one
  // transaction so a failure can't leave entries replaced but unlogged.
  store.inTransaction(() => {
    if (hasChanges) {
      const log: ChannelPoolChangeLog = {
        id: uuidv4(),
        sourceId,
        sourceName: source?.name || 'Unknown Source',
        timestamp: Date.now(),
        added,
        removed,
        renamed,
      };
      store.poolChangeLogs.insert(log);
      store.poolChangeLogs.pruneOlderThan(Date.now() - 90 * 24 * 60 * 60 * 1000);
    }
    store.poolEntries.replaceForSource(sourceId, newEntries);
  });

  return hasChanges;
}

/** Refreshes a Channel Pool source's entries. Returns whether the entries actually changed. */
async function refreshChannelPoolSource(sourceId: string): Promise<boolean> {
  // Background refresh: unscoped for the same reason as refreshEpgSource.
  const source = store.poolSources.byIdUnscoped(sourceId);
  if (!source || source.type === 'playlist-file') return false;

  try {
    let newEntries: ChannelPoolEntry[] = [];
    if (source.type === 'xtream') {
      newEntries = await fetchXtreamChannels(source);
    } else if (source.type === 'playlist-url') {
      newEntries = await fetchPlaylistChannels(source);
    }

    const changed = detectChannelPoolChanges(sourceId, newEntries);
    channelPoolCache.set(sourceId, newEntries);

    store.poolSources.update(sourceId, {
      lastFetched: Date.now(),
      channelCount: newEntries.length,
      lastFetchError: null,
    });
    return changed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to refresh Channel Pool source ${source.name}:`, err);
    store.poolSources.update(sourceId, { lastFetchError: message });
    return false;
  }
}

// Refreshes Channel Pool sources one at a time instead of all at once, so a
// batch of sources (e.g. every source refreshing together at server boot)
// doesn't pile concurrent fetches onto the same moment — which is what can
// make an otherwise-healthy source time out right when the server starts.
// Mirrors refreshEpgSourcesSequentially above for the same reason.
async function refreshChannelPoolSourcesSequentially(sourceIds: string[]) {
  for (const id of sourceIds) {
    await refreshChannelPoolSource(id);
  }
}

// ── Auth helpers ─────────────────────────────────────────────────────────
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

// Accounts and device tokens live in SQLite (see db.ts). Previously there was a
// single global password in data/auth.json plus an in-memory Set of session
// tokens, which meant every device was logged out whenever the server
// restarted. Tokens are now persisted (as hashes) so a device stays logged in.
const authMigration = store.migrateFromAuthJson();
if (authMigration.migrated) {
  console.log(`Migrated data/auth.json into the users table as "${authMigration.username}".`);
}

/**
 * The account a request acts as.
 *
 * When authentication is disabled (no accounts exist at all) there is no
 * req.user, so requests fall back to the legacy account — which owns all
 * pre-existing data. That keeps a single-user install behaving exactly as it
 * did before accounts were introduced, while every query stays scoped.
 */
function actingUserId(req: express.Request): string {
  return req.user?.id ?? store.LEGACY_USER_ID;
}

/** Bearer tokens are stored only as SHA-256, so the database holds no usable credential. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Length-safe constant-time compare for hex digests. */
function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  if (!hash || !salt) return false;
  const { hash: candidate } = await hashPassword(password, salt);
  return safeEqualHex(candidate, hash);
}

/** Builds a fresh password + recovery-key credential set for a user. */
async function buildCredentials(password: string) {
  const { hash: passwordHash, salt: passwordSalt } = await hashPassword(password);
  const recoveryKey = generateRecoveryKey();
  const { hash: recoveryKeyHash, salt: recoveryKeySalt } = await hashPassword(recoveryKey);
  return { passwordHash, passwordSalt, recoveryKeyHash, recoveryKeySalt, recoveryKey };
}

/** Issues a device token and returns the raw value — the only time it exists in plaintext. */
function issueDeviceToken(userId: string, deviceName?: unknown) {
  const token = generateToken();
  const name =
    typeof deviceName === 'string' && deviceName.trim() ? deviceName.trim().slice(0, 100) : 'Unnamed device';
  const device = store.deviceTokens.insert({
    id: uuidv4(),
    tokenHash: hashToken(token),
    userId,
    name,
  });
  return { token, device };
}

function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  return new Promise((resolve, reject) => {
    const s = salt || crypto.randomBytes(32).toString('hex');
    crypto.pbkdf2(password, s, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST, (err, key) => {
      if (err) reject(err);
      else resolve({ hash: key.toString('hex'), salt: s });
    });
  });
}

function generateToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

function generateRecoveryKey(): string {
  // 24-char alphanumeric, grouped as XXXX-XXXX-XXXX-XXXX-XXXX-XXXX for readability
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let key = '';
  const bytes = crypto.randomBytes(24);
  for (let i = 0; i < 24; i++) key += chars[bytes[i] % chars.length];
  return key;
}

function formatRecoveryKey(key: string): string {
  return key.match(/.{1,4}/g)!.join('-');
}

// The old migrateShortIds() pass lived here. It is no longer needed: short_id is
// NOT NULL UNIQUE in the schema and migrateFromJson() backfills any playlist
// that predates the field, so a playlist without one cannot reach the database.

// M3U/EXTINF has no formal attribute-escaping spec, so quotes inside a value would
// otherwise prematurely close the attribute and corrupt the line for any parser.
function escapeM3uAttr(value: string): string {
  return value.replace(/"/g, "'");
}

// #EXTINF is meant to be a single logical line per channel, immediately followed by
// its stream URL on the next line — nothing in the app validates that channel fields
// (name, url, or any attribute) can't contain a literal newline (e.g. a paste, an API
// call, or a find/replace). An embedded \r or \n would split that one line into extra
// lines and shift the name/URL pairing for every channel that follows it in the file.
function stripM3uNewlines(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

// Minimal XML escaping for attribute values (icon src, channel/programme ids, timestamps).
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// CDATA sections are safe from &/</> but a literal "]]>" inside the source text would
// still prematurely close the section, so split it across two adjacent CDATA blocks.
function escapeCData(value: string): string {
  return value.replace(/]]>/g, "]]]]><![CDATA[>");
}

function serveM3U(playlist: Playlist, res: any) {
  const catIndex = new Map(playlist.categories.map((cat, i) => [cat, i]));
  const channels = store.channels
    .byPlaylistForExport(playlist.id)
    .filter(c => !c.isHidden)
    .sort((a, b) => {
      const catA = catIndex.has(a.category) ? catIndex.get(a.category)! : playlist.categories.length;
      const catB = catIndex.has(b.category) ? catIndex.get(b.category)! : playlist.categories.length;
      if (catA !== catB) return catA - catB;
      return a.order - b.order;
    });
  res.setHeader("Content-Type", "audio/x-mpegurl");
  res.setHeader("Content-Disposition", `inline; filename="${playlist.shortId}.m3u"`);
  let m3u = "#EXTM3U\n";
  channels.forEach(ch => {
    let extinf = `#EXTINF:-1`;
    if (ch.tvgId) extinf += ` tvg-id="${escapeM3uAttr(stripM3uNewlines(ch.tvgId))}"`;
    if (ch.logo)  extinf += ` tvg-logo="${escapeM3uAttr(stripM3uNewlines(ch.logo))}"`;
    if (ch.category) extinf += ` group-title="${escapeM3uAttr(stripM3uNewlines(ch.category))}"`;
    extinf += `,${stripM3uNewlines(ch.name || 'Unnamed')}\n${stripM3uNewlines(ch.url)}\n`;
    m3u += extinf;
  });
  res.send(m3u);
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 8080;

  app.use(express.json({ limit: '50mb' }));

  // Initialize EPG Cache. Refreshed one source at a time (not all at once) —
  // see refreshEpgSourcesSequentially. This is fired without awaiting so it
  // doesn't delay the server from listening.
  refreshEpgSourcesSequentially(store.epgSources.allUnscoped().map(s => s.id));
  const channelPoolSourceIdsToRefresh: string[] = [];
  for (const source of store.poolSources.allUnscoped()) {
    if (source.type !== 'playlist-file') {
      channelPoolSourceIdsToRefresh.push(source.id);
    } else {
      // Uploaded files are never re-fetched, so seed the cache from what's stored.
      channelPoolCache.set(source.id, store.poolEntries.bySource(source.id));
    }
  }
  // Same reasoning as the EPG sources above — refreshed one at a time (see
  // refreshChannelPoolSourcesSequentially) instead of all firing their fetches
  // in the same instant, and fired without awaiting so it doesn't delay the
  // server from listening.
  refreshChannelPoolSourcesSequentially(channelPoolSourceIdsToRefresh);

  setInterval(() => {
    const now = Date.now();
    // A source whose last attempt failed is retried on every tick (regardless
    // of its refresh interval) until it succeeds, instead of silently sitting
    // empty until the interval next comes due.
    const dueEpgSourceIds = store.epgSources.allUnscoped().filter(source => {
      const intervalMs = (source.refreshIntervalHours || 12) * 60 * 60 * 1000;
      return !source.lastFetched || source.lastFetchError || (now - source.lastFetched) > intervalMs;
    }).map(source => source.id);
    refreshEpgSourcesSequentially(dueEpgSourceIds);
    // A source whose last attempt failed is retried on every tick (same as EPG sources
    // above), instead of silently sitting on stale/empty data until the interval next
    // comes due — which for the default 24h channel-pool interval could otherwise mean
    // a whole day before an invalid-login error is retried after being fixed.
    const dueChannelPoolSourceIds = store.poolSources.allUnscoped().filter(source => {
      if (source.type === 'playlist-file') return false;
      const intervalMs = (source.refreshIntervalHours || 24) * 60 * 60 * 1000;
      return !source.lastFetched || source.lastFetchError || (now - source.lastFetched) > intervalMs;
    }).map(source => source.id);
    refreshChannelPoolSourcesSequentially(dueChannelPoolSourceIds);
  }, 5 * 60 * 1000);

  // ── Auth middleware ──────────────────────────────────────────────────
  // Resolves the bearer token to a device + user and hangs them off the request,
  // so route handlers (and the per-user scoping in the next phase) have an
  // identity to work with. When no account exists at all, auth stays a complete
  // no-op — same as the old "no password set" behaviour.
  const publicPaths = ['/auth/status', '/auth/login', '/auth/recover'];
  app.use('/api', (req, res, next) => {
    if (publicPaths.includes(req.path)) return next();
    if (store.users.none()) return next(); // No account set up — allow all

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const device = store.deviceTokens.byTokenHash(hashToken(header.slice(7)));
    if (!device) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    const user = store.users.byId(device.userId);
    if (!user) {
      // The account was deleted while this device still held a token.
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    // Cheap in SQLite, and gives the device list a meaningful "last seen".
    store.deviceTokens.touch(device.id);
    req.user = user;
    req.device = device;
    next();
  });

  /** Routes that only an admin may call. */
  const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // With no accounts at all the API is unauthenticated anyway, so there is
    // nothing to gate; once accounts exist, req.user is always populated here.
    if (store.users.none()) return next();
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin privileges required' });
    next();
  };

  // ── Auth routes ────────────────────────────────────────────────────
  app.get('/api/auth/status', (_req, res) => {
    // `enabled` keeps its original meaning (is a login required?); the extra
    // fields let a multi-user client decide whether to ask for a username.
    const all = store.users.all();
    res.json({
      enabled: all.length > 0,
      userCount: all.length,
      multiUser: all.length > 1,
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    if (store.users.none()) return res.json({ token: null, message: 'No password set' });
    const { username, password, deviceName } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });

    // `username` is optional: existing single-account installs (and the current
    // web UI) post only a password, so fall back to the sole account. Once more
    // than one account exists a username becomes required.
    const user = username ? store.users.byUsername(String(username)) : store.users.only();
    if (!user) {
      return res.status(username ? 401 : 400).json({
        error: username ? 'Incorrect username or password' : 'Username required',
      });
    }
    try {
      if (!(await verifyPassword(password, user.passwordHash, user.passwordSalt))) {
        // Same message for a bad username and a bad password, so the response
        // doesn't reveal which accounts exist.
        return res.status(401).json({ error: 'Incorrect username or password' });
      }
      const { token, device } = issueDeviceToken(user.id, deviceName);
      res.json({
        token,
        user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
        device: { id: device.id, name: device.name },
      });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Creates the first account, or changes the calling user's own password.
  app.post('/api/auth/set-password', async (req, res) => {
    const { password, currentPassword, username } = req.body;
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    const firstRun = store.users.none();

    try {
      if (firstRun) {
        // Bootstrap: the first account is an admin. Reuse the legacy id so any
        // pre-existing playlists (userId "local-user") belong to it.
        const creds = await buildCredentials(password);
        const now = Date.now();
        const desired = typeof username === 'string' && username.trim() ? username.trim() : 'admin';
        store.users.insert({
          id: store.LEGACY_USER_ID,
          username: desired,
          passwordHash: creds.passwordHash,
          passwordSalt: creds.passwordSalt,
          recoveryKeyHash: creds.recoveryKeyHash,
          recoveryKeySalt: creds.recoveryKeySalt,
          isAdmin: true,
          createdAt: now,
          updatedAt: now,
        });
        return res.json({ recoveryKey: formatRecoveryKey(creds.recoveryKey), username: desired });
      }

      // Changing an existing password requires being logged in as that user.
      const user = req.user;
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
      if (!(await verifyPassword(currentPassword, user.passwordHash, user.passwordSalt))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const creds = await buildCredentials(password);
      store.inTransaction(() => {
        store.users.updateCredentials(user.id, creds);
        // Every other device holding a token from the old password is logged out;
        // the caller's own device is re-issued below so it stays signed in.
        store.deviceTokens.revokeAllForUser(user.id);
      });
      const { token } = issueDeviceToken(user.id, req.device?.name);
      res.json({ recoveryKey: formatRecoveryKey(creds.recoveryKey), token });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/auth/recover', async (req, res) => {
    if (store.users.none()) return res.status(400).json({ error: 'No password set' });
    const { recoveryKey, newPassword, username } = req.body;
    if (!recoveryKey || !newPassword) {
      return res.status(400).json({ error: 'Recovery key and new password required' });
    }
    if (newPassword.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    // Optional username, for the same reason as login.
    const user = username ? store.users.byUsername(String(username)) : store.users.only();
    if (!user) {
      return res.status(username ? 401 : 400).json({
        error: username ? 'Invalid recovery key' : 'Username required',
      });
    }
    try {
      // Strip formatting dashes from recovery key
      const cleanKey = recoveryKey.replace(/-/g, '').toUpperCase();
      if (!(await verifyPassword(cleanKey, user.recoveryKeyHash, user.recoveryKeySalt))) {
        return res.status(401).json({ error: 'Invalid recovery key' });
      }
      const creds = await buildCredentials(newPassword);
      store.inTransaction(() => {
        store.users.updateCredentials(user.id, creds);
        // A recovery means the password may have been compromised, so every
        // device for this account is logged out.
        store.deviceTokens.revokeAllForUser(user.id);
      });
      const { token } = issueDeviceToken(user.id, req.body?.deviceName);
      res.json({ token, recoveryKey: formatRecoveryKey(creds.recoveryKey) });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Turns authentication off again by deleting the only account. Refused once
  // more than one account exists: with per-user data, dropping auth would hand
  // every account's playlists to anyone on the network.
  app.post('/api/auth/remove-password', async (req, res) => {
    if (store.users.none()) return res.json({ success: true });
    if (store.users.count() > 1) {
      return res.status(409).json({
        error:
          'Cannot disable authentication while more than one account exists. Delete the other accounts first.',
      });
    }
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { currentPassword } = req.body;
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    try {
      if (!(await verifyPassword(currentPassword, user.passwordHash, user.passwordSalt))) {
        return res.status(401).json({ error: 'Incorrect password' });
      }
      // Device tokens cascade with the user row.
      store.users.delete(user.id);
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      // Revoking the row is what makes logout durable — the token is dead even
      // after a restart.
      store.deviceTokens.revokeByTokenHash(hashToken(header.slice(7)));
    }
    res.json({ success: true });
  });

  // ── Identity, devices and accounts ──────────────────────────────────
  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.json({ user: null, authDisabled: true });
    res.json({
      user: { id: req.user.id, username: req.user.username, isAdmin: req.user.isAdmin },
      device: req.device ? { id: req.device.id, name: req.device.name } : null,
    });
  });

  // The devices currently signed in to the calling account.
  app.get('/api/auth/devices', (req, res) => {
    if (!req.user) return res.json([]);
    const current = req.device?.id;
    res.json(store.deviceTokens.listByUser(req.user.id).map(d => ({ ...d, current: d.id === current })));
  });

  // Revokes one device — how you sign a lost phone or TV box out remotely.
  app.delete('/api/auth/devices/:id', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const removed = store.deviceTokens.revoke(req.params.id, req.user.id);
    if (!removed) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true });
  });

  app.get('/api/users', requireAdmin, (_req, res) => {
    res.json(
      store.users.all().map(u => ({
        id: u.id,
        username: u.username,
        isAdmin: u.isAdmin,
        createdAt: u.createdAt,
        deviceCount: store.deviceTokens.listByUser(u.id).length,
      })),
    );
  });

  app.post('/api/users', requireAdmin, async (req, res) => {
    const { username, password, isAdmin } = req.body;
    if (!username || !String(username).trim()) {
      return res.status(400).json({ error: 'Username required' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    const name = String(username).trim();
    if (store.users.byUsername(name)) {
      return res.status(409).json({ error: `A user named "${name}" already exists` });
    }
    try {
      const creds = await buildCredentials(password);
      const now = Date.now();
      const id = uuidv4();
      store.users.insert({
        id,
        username: name,
        passwordHash: creds.passwordHash,
        passwordSalt: creds.passwordSalt,
        recoveryKeyHash: creds.recoveryKeyHash,
        recoveryKeySalt: creds.recoveryKeySalt,
        isAdmin: !!isAdmin,
        createdAt: now,
        updatedAt: now,
      });
      // The recovery key is shown once, here, and never stored in plaintext.
      res.json({
        user: { id, username: name, isAdmin: !!isAdmin },
        recoveryKey: formatRecoveryKey(creds.recoveryKey),
      });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/users/:id', requireAdmin, (req, res) => {
    const target = store.users.byId(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (req.user && target.id === req.user.id) {
      return res.status(400).json({
        error: 'You cannot delete the account you are signed in with. Use remove-password instead.',
      });
    }
    if (store.users.count() <= 1) {
      return res.status(409).json({ error: 'Cannot delete the last remaining account' });
    }
    // Device tokens cascade. Playlists owned by this user are deliberately left
    // in place; reassigning or deleting them is a separate decision.
    store.users.delete(target.id);
    res.json({ success: true });
  });

  // --- API Routes ---

  // ── EPG Routes ───────────────────────────────────────────────────────
  app.get("/api/epg-sources", (req, res) => {
    res.json(store.epgSources.all(actingUserId(req)));
  });

  app.post("/api/epg-sources", async (req, res) => {
    const newSource: EpgSource = {
      id: uuidv4(),
      ...req.body,
      userId: actingUserId(req),
      refreshIntervalHours: req.body.refreshIntervalHours ?? 12,
      lastFetched: null,
      lastFetchError: null,
      channelCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.epgSources.insert(newSource);
    await refreshEpgSource(newSource.id);
    res.json(store.epgSources.byId(newSource.id, actingUserId(req)) ?? newSource);
  });

  app.put("/api/epg-sources/:id", (req, res) => {
    // Ownership first: an unscoped update() would otherwise edit another account's source.
    if (!store.epgSources.byId(req.params.id, actingUserId(req))) {
      return res.status(404).json({ error: "Not found" });
    }
    const updated = store.epgSources.update(req.params.id, req.body);
    if (updated) {
      res.json(updated);
    } else {
      res.status(404).json({ error: "Not found" });
    }
  });

  app.delete("/api/epg-sources/:id", (req, res) => {
    if (!store.epgSources.delete(req.params.id, actingUserId(req))) {
      return res.status(404).json({ error: "Not found" });
    }
    epgCache.delete(req.params.id);
    res.json({ success: true });
  });

  app.post("/api/epg-sources/:id/refresh", async (req, res) => {
    await refreshEpgSource(req.params.id);
    const cache = epgCache.get(req.params.id);
    res.json({ success: true, channelCount: cache?.channels.length || 0 });
  });

  app.get("/api/epg-sources/:id/channels", (req, res) => {
    const source = store.epgSources.byId(req.params.id, actingUserId(req));
    if (!source) return res.status(404).json({ error: "Not found" });
    const cache = epgCache.get(req.params.id);
    if (!cache) return res.json([]);
    const channels = cache.channels.map(c => ({ ...c, sourceId: source.id, sourceName: source.name }));
    channels.sort((a, b) => a.displayName.localeCompare(b.displayName));
    res.json(channels);
  });

  app.get("/api/epg-sources/:id/programs/:channelId", (req, res) => {
    const cache = epgCache.get(req.params.id);
    if (!cache) return res.json([]);
    const progs = cache.programmes.filter(p => p.channel === req.params.channelId);
    res.json(progs);
  });

  app.get("/api/epg-sources/:id/now", (req, res) => {
    const cache = epgCache.get(req.params.id);
    if (!cache) return res.json({ channels: [], programmes: {} });
    
    const now = new Date();
    const startWindow = new Date(now.getTime() - 3 * 3600 * 1000);
    const endWindow = new Date(now.getTime() + 6 * 3600 * 1000);

    function parseXmltvDate(dtStr: string): Date {
      const yr = dtStr.substring(0, 4);
      const mo = dtStr.substring(4, 6);
      const da = dtStr.substring(6, 8);
      const hr = dtStr.substring(8, 10);
      const mi = dtStr.substring(10, 12);
      const se = dtStr.substring(12, 14) || "00";
      const tz = dtStr.substring(15) || "+0000";
      const tzFmt = tz ? `${tz.substring(0,3)}:${tz.substring(3)}` : "+00:00";
      return new Date(`${yr}-${mo}-${da}T${hr}:${mi}:${se}${tzFmt}`);
    }

    const progsMap: Record<string, ParsedEpgProgramme[]> = {};
    for (const p of cache.programmes) {
      if (!p.start || !p.stop) continue;
      try {
        const pStart = parseXmltvDate(p.start);
        const pStop = parseXmltvDate(p.stop);
        if (pStop >= startWindow && pStart <= endWindow) {
          if (!progsMap[p.channel]) progsMap[p.channel] = [];
          progsMap[p.channel].push(p);
        }
      } catch (e) {}
    }
    
    res.json({ channels: cache.channels, programmes: progsMap });
  });

  app.get("/api/epg/tvg-ids", (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);
    
    const results = [];
    const dbSources = store.epgSources.all(actingUserId(req));
    
    for (const [sourceId, cache] of epgCache.entries()) {
      const source = dbSources.find(s => s.id === sourceId);
      if (!source) continue;
      
      for (const ch of cache.channels) {
        if (ch.id.toLowerCase().includes(q) || ch.displayName.toLowerCase().includes(q)) {
          results.push({ ...ch, sourceId: source.id, sourceName: source.name });
          if (results.length >= 50) return res.json(results);
        }
      }
    }
    res.json(results);
  });

  // Resolve tvg-ids in bulk: given a list of ids, return display names + source names
  app.post("/api/epg/resolve-tvg-ids", (req, res) => {
    const { ids } = req.body as { ids: string[] };
    if (!ids || !Array.isArray(ids)) return res.json({});
    
    const dbSources = store.epgSources.all(actingUserId(req));
    const result: Record<string, { displayName: string; sourceName: string }> = {};
    
    // Build a lookup set for fast matching
    const idsSet = new Set(ids.filter(Boolean));
    
    for (const [sourceId, cache] of epgCache.entries()) {
      const source = dbSources.find(s => s.id === sourceId);
      if (!source) continue;
      
      for (const ch of cache.channels) {
        if (idsSet.has(ch.id) && !result[ch.id]) {
          result[ch.id] = { displayName: ch.displayName, sourceName: source.name };
        }
      }
    }
    res.json(result);
  });

  // ── Channel Pool Routes ───────────────────────────────────────────────────────
  app.get("/api/channel-pool/sources", (req, res) => {
    res.json(store.poolSources.all(actingUserId(req)));
  });

  app.post("/api/channel-pool/validate-url", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Missing URL" });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      
      let response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'VLC/3.0.16 LibVLC/3.0.16',
            'Accept': '*/*'
          }
        });
      } catch (err) {
        clearTimeout(timeout);
        return res.json({ warning: "Not a valid playlist link" });
      }

      // Content-Type is not a reliable signal here — real playlist servers commonly
      // label M3U playlists as audio/x-mpegurl (this app's own export does too, see
      // serveM3U), so a Content-Type-based short-circuit produces false positives on
      // genuine multi-channel playlists. Inspect the actual body instead via
      // detectPlaylistWarning(), which distinguishes playlists from single-stream
      // HLS/binary content far more accurately.
      const reader = response.body?.getReader();
      let text = '';
      if (reader) {
        let bytesRead = 0;
        const decoder = new TextDecoder('utf-8');
        try {
          while (bytesRead < 8192) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              bytesRead += value.length;
              text += decoder.decode(value, { stream: true });
            }
          }
        } catch (e) {
          // ignore read errors
        } finally {
          reader.cancel().catch(() => {});
        }
      }
      clearTimeout(timeout);

      return res.json({ warning: detectPlaylistWarning(text) });
    } catch (err) {
      return res.json({ warning: "Not a valid playlist link" });
    }
  });

  app.post("/api/channel-pool/sources", async (req, res) => {
    const newSource: ChannelPoolSource = {
      id: uuidv4(),
      ...req.body,
      userId: actingUserId(req),
      refreshIntervalHours: req.body.refreshIntervalHours ?? 24,
      lastFetched: null,
      lastFetchError: null,
      channelCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.poolSources.insert(newSource);

    if (newSource.type !== 'playlist-file') {
      await refreshChannelPoolSource(newSource.id);
    }
    res.json(store.poolSources.byId(newSource.id, actingUserId(req)) || newSource);
  });

  app.put("/api/channel-pool/sources/:id", (req, res) => {
    if (!store.poolSources.byId(req.params.id, actingUserId(req))) {
      return res.status(404).json({ error: "Not found" });
    }
    const updated = store.poolSources.update(req.params.id, req.body);
    if (updated) {
      res.json(updated);
    } else {
      res.status(404).json({ error: "Not found" });
    }
  });

  app.delete("/api/channel-pool/sources/:id", (req, res) => {
    const userId = actingUserId(req);
    if (!store.poolSources.byId(req.params.id, userId)) {
      return res.status(404).json({ error: "Not found" });
    }
    store.inTransaction(() => {
      // Entries cascade from the source row; changelogs are cleared explicitly.
      store.poolChangeLogs.deleteBySource(req.params.id);
      store.poolSources.delete(req.params.id, userId);
    });
    channelPoolCache.delete(req.params.id);
    res.json({ success: true });
  });

  app.post("/api/channel-pool/sources/:id/refresh", async (req, res) => {
    // Ownership is checked before the refresh so this cannot be used to make
    // the server fetch on behalf of another account's source.
    if (!store.poolSources.byId(req.params.id, actingUserId(req))) {
      return res.status(404).json({ error: "Not found" });
    }
    const changed = await refreshChannelPoolSource(req.params.id);
    const source = store.poolSources.byId(req.params.id, actingUserId(req));
    res.json({ success: true, channelCount: source?.channelCount || 0, changed });
  });

  app.get("/api/channel-pool/sources/:id/channels", (req, res) => {
    const source = store.poolSources.byId(req.params.id, actingUserId(req));
    if (!source) return res.status(404).json({ error: "Not found" });

    let entries = channelPoolCache.get(req.params.id) || store.poolEntries.bySource(req.params.id);
    
    const q = String(req.query.q || '').trim().toLowerCase();
    const cat = String(req.query.category || '').trim();
    const sort = String(req.query.sort || 'name');

    if (cat) {
      entries = entries.filter(e => e.category === cat);
    }
    if (q) {
      entries = entries.filter(e => e.name.toLowerCase().includes(q) || e.url.toLowerCase().includes(q));
    }

    // 'original' preserves the order entries were parsed from the source (M3U/Xtream
    // order); anything else falls back to the previous alphabetical-by-name behavior.
    const sorted = sort === 'original' ? entries : [...entries].sort((a, b) => a.name.localeCompare(b.name));
    res.json(sorted);
  });

  app.get("/api/channel-pool/sources/:id/categories", (req, res) => {
    // The cache is keyed by source id across all accounts, so ownership must be
    // confirmed before serving from it.
    if (!store.poolSources.byId(req.params.id, actingUserId(req))) {
      return res.status(404).json({ error: "Not found" });
    }
    const entries = channelPoolCache.get(req.params.id) || store.poolEntries.bySource(req.params.id);
    
    const categories = new Set(entries.map(e => e.category));
    const sorted = Array.from(categories).sort((a, b) => a.localeCompare(b));
    res.json(sorted);
  });

  app.get("/api/channel-pool/changelog", (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const perPage = 20;

    const logs = store.poolChangeLogs.all(actingUserId(req));
    const total = logs.length;
    const paginatedLogs = logs.slice((page - 1) * perPage, page * perPage);
    
    res.json({
      logs: paginatedLogs,
      hasMore: page * perPage < total
    });
  });

  app.post("/api/channel-pool/sources/upload", (req, res) => {
    const { name, content, filename } = req.body;
    
    if (!name || !content || !filename) {
      return res.status(400).json({ error: "Missing name, content, or filename" });
    }
    
    const newSource: ChannelPoolSource = {
      id: uuidv4(),
      userId: actingUserId(req),
      name,
      type: 'playlist-file',
      url: null,
      refreshIntervalHours: 0,
      lastFetched: Date.now(),
      lastFetchError: null,
      channelCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    let entries: ChannelPoolEntry[] = [];
    if (content.trim().startsWith('<?xml') && content.includes('<playlist')) {
      entries = parseXspfToChannelPoolEntries(content, newSource.id);
    } else {
      entries = parseM3uToChannelPoolEntries(content, newSource.id);
    }

    newSource.channelCount = entries.length;
    // Source row and its entries land together, so an upload can never leave a
    // source with a channelCount it has no entries to back.
    store.inTransaction(() => {
      store.poolSources.insert(newSource);
      store.poolEntries.replaceForSource(newSource.id, entries);
    });
    
    channelPoolCache.set(newSource.id, entries);
    
    res.json(newSource);
  });

  app.get("/api/version", (_req, res) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
      res.json({ version: pkg.version });
    } catch {
      res.json({ version: "0.0.0" });
    }
  });

  app.get("/api/playlists", (req, res) => {
    res.json(store.playlists.all(actingUserId(req)));
  });

  app.post("/api/playlists", (req, res) => {
    const { name } = req.body;
    const nextShortId = store.playlists.nextShortId();
    const newPlaylist: Playlist = {
      id: uuidv4(),
      name: name || "Unnamed Playlist",
      userId: actingUserId(req),
      categories: ["General"],
      exportId: uuidv4(),
      shortId: nextShortId,
      exportToken: store.newExportToken(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.playlists.insert(newPlaylist);
    res.json(newPlaylist);
  });

  // Creates a playlist pre-populated from an existing M3U/XSPF playlist, given either a URL
  // to fetch or raw file content. Rejects (with a warning the caller can confirm past, mirroring
  // the channel-pool "Add Source" flow) anything that looks like a raw stream link rather than
  // an actual channel playlist — e.g. an M3U8 livestream/VOD segment feed.
  app.post("/api/playlists/import", async (req, res) => {
    const { name, url, content: rawContent, confirmWarning } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Missing playlist name" });
    }
    if (!url && !rawContent) {
      return res.status(400).json({ error: "Provide a URL or a file to import from" });
    }

    let content: string;
    if (url) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let response;
        try {
          response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'VLC/3.0.16 LibVLC/3.0.16', 'Accept': '*/*' },
          });
        } catch {
          clearTimeout(timeout);
          return res.status(400).json({ error: "Could not fetch that URL" });
        }

        // Content-Type is not a reliable signal here — real playlist servers commonly
        // label M3U playlists as audio/x-mpegurl (this app's own export does too, see
        // serveM3U), so a Content-Type-based short-circuit produces false positives on
        // genuine multi-channel playlists. Inspect the actual body instead via
        // detectPlaylistWarning() below, which distinguishes playlists from single-stream
        // HLS/binary content far more accurately.
        content = await response.text();
        clearTimeout(timeout);
      } catch {
        return res.status(400).json({ error: "Could not fetch that URL" });
      }
    } else {
      content = String(rawContent);
    }

    const warning = detectPlaylistWarning(content);
    if (warning && !confirmWarning) {
      return res.json({ warning });
    }

    const isXspf = content.trim().startsWith('<?xml') && content.includes('<playlist');
    const entries = isXspf
      ? parseXspfToChannelPoolEntries(content, 'import')
      : parseM3uToChannelPoolEntries(content, 'import');

    if (entries.length === 0) {
      return res.status(400).json({ error: "No channels found in that playlist" });
    }

    const nextShortId = store.playlists.nextShortId();
    const categories = Array.from(new Set(entries.map(e => e.category || "General")));
    const newPlaylist: Playlist = {
      id: uuidv4(),
      name: String(name).trim(),
      userId: actingUserId(req),
      categories: categories.length > 0 ? categories : ["General"],
      exportId: uuidv4(),
      shortId: nextShortId,
      exportToken: store.newExportToken(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const newChannels: Channel[] = entries.map((e, i) => ({
      id: uuidv4(),
      playlistId: newPlaylist.id,
      name: e.name || "Unknown",
      url: e.url || "",
      logo: e.logo || null,
      tvgId: e.tvgId || null,
      category: e.category || "General",
      order: i + 1,
      isHidden: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    // Playlist and its imported channels commit together — a partial import
    // would otherwise leave an empty playlist behind.
    store.inTransaction(() => {
      store.playlists.insert(newPlaylist);
      store.channels.insertMany(newChannels);
    });

    res.json(newPlaylist);
  });

  app.put("/api/playlists/:playlistId", (req, res) => {
    const { playlistId } = req.params;
    const userId = actingUserId(req);
    if (!store.playlists.byId(playlistId, userId)) {
      return res.status(404).json({ error: "Not found" });
    }
    if (Array.isArray(req.body.categories)) {
      const trimmed = req.body.categories.map((c: string) => typeof c === "string" ? c.trim() : c);
      const seen = new Set<string>();
      for (const c of trimmed) {
        if (seen.has(c)) {
          return res.status(400).json({ error: `A category named "${c}" already exists in this playlist.` });
        }
        seen.add(c);
      }
      req.body.categories = trimmed;
    }
    const updated = store.playlists.update(playlistId, userId, req.body);
    res.json(updated);
  });

  // Invalidates the current /e/:token export link and issues a new one — how you
  // revoke a link that has leaked.
  app.post("/api/playlists/:playlistId/rotate-export-token", (req, res) => {
    const token = store.playlists.rotateExportToken(req.params.playlistId, actingUserId(req));
    if (!token) return res.status(404).json({ error: "Not found" });
    res.json({ exportToken: token });
  });

  app.delete("/api/playlists/:playlistId", (req, res) => {
    // Channels are removed by the ON DELETE CASCADE on channels.playlist_id.
    if (!store.playlists.delete(req.params.playlistId, actingUserId(req))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ success: true });
  });

  app.get("/api/playlists/:playlistId/channels", (req, res) => {
    const userId = actingUserId(req);
    if (!store.playlists.byId(req.params.playlistId, userId)) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(store.channels.byPlaylist(req.params.playlistId, userId));
  });

  app.post("/api/playlists/:playlistId/channels/bulk", (req, res) => {
    const { playlistId } = req.params;
    const { channels } = req.body;
    const userId = actingUserId(req);
    if (!store.playlists.byId(playlistId, userId)) {
      return res.status(404).json({ error: "Not found" });
    }

    // Auto increment order
    const maxOrder = store.channels.maxOrder(playlistId);

    const newChannels: Channel[] = channels.map((c: any, i: number) => {
      // Find category and add it to playlist if missing
      const cat = c.category || "General";
      return {
        id: uuidv4(),
        playlistId,
        name: c.name || "Unknown",
        url: c.url || "",
        logo: c.logo || null,
        tvgId: c.tvgId || null,
        category: cat,
        order: maxOrder + i + 1,
        isHidden: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    });

    // Channels and any new categories they introduce commit together.
    store.inTransaction(() => {
      store.channels.insertMany(newChannels);

      // Update categories — preserve existing order, append new ones at the end
      const playlist = store.playlists.byId(playlistId, userId);
      if (playlist) {
        const categories = [...playlist.categories];
        const existingSet = new Set(categories);
        newChannels.forEach(c => {
          if (!existingSet.has(c.category)) {
            categories.push(c.category);
            existingSet.add(c.category);
          }
        });
        if (categories.length !== playlist.categories.length) {
          store.playlists.update(playlistId, userId, { categories });
        }
      }
    });

    res.json({ success: true, added: newChannels.length, ids: newChannels.map((c: Channel) => c.id) });
  });

  app.put("/api/playlists/:playlistId/channels/:channelId", (req, res) => {
    const updated = store.channels.update(req.params.channelId, actingUserId(req), req.body);
    if (updated) {
      res.json(updated);
    } else {
      res.status(404).json({ error: "Not found" });
    }
  });

  app.delete("/api/playlists/:playlistId/channels/:channelId", (req, res) => {
    if (!store.channels.delete(req.params.channelId, actingUserId(req))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ success: true });
  });

  app.post("/api/playlists/:playlistId/channels/bulk-update", (req, res) => {
    const { playlistId } = req.params;
    const { ids, updates } = req.body;
    const userId = actingUserId(req);
    if (!store.playlists.byId(playlistId, userId)) {
      return res.status(404).json({ error: "Not found" });
    }

    store.inTransaction(() => {
      const idSet = new Set<string>(ids ?? []);
      for (const c of store.channels.byPlaylist(playlistId, userId)) {
        if (idSet.has(c.id)) store.channels.update(c.id, userId, updates);
      }

      // Handle new category dynamic pushing
      if (updates.category) {
        const playlist = store.playlists.byId(playlistId, userId);
        if (playlist && !playlist.categories.includes(updates.category)) {
          store.playlists.update(playlistId, userId, {
            categories: [...playlist.categories, updates.category],
          });
        }
      }
    });

    res.json({ success: true });
  });

  app.post("/api/playlists/:playlistId/channels/bulk-update-many", (req, res) => {
    const { playlistId } = req.params;
    const { updates } = req.body; // updates: Array<{ id: string, changes: any }>

    const userId = actingUserId(req);
    if (!store.playlists.byId(playlistId, userId)) {
      return res.status(404).json({ error: "Not found" });
    }
    const updateMap = new Map<string, any>(updates.map((u: any) => [u.id, u.changes]));

    store.inTransaction(() => {
      const playlist = store.playlists.byId(playlistId, userId);
      const categories = playlist ? [...playlist.categories] : [];

      for (const c of store.channels.byPlaylist(playlistId, userId)) {
        if (!updateMap.has(c.id)) continue;
        const changes = updateMap.get(c.id);

        // Handle new category dynamic pushing
        if (changes.category && !categories.includes(changes.category)) {
          categories.push(changes.category);
        }
        store.channels.update(c.id, userId, changes);
      }

      if (playlist && categories.length !== playlist.categories.length) {
        store.playlists.update(playlistId, userId, { categories });
      }
    });

    res.json({ success: true });
  });

  app.post("/api/playlists/:playlistId/channels/bulk-replace", (req, res) => {
    const { playlistId } = req.params;
    const { search, replace, field, ids } = req.body;
    if (!search || typeof search !== "string") {
      return res.status(400).json({ error: "Missing search string" });
    }
    const userId = actingUserId(req);
    if (!store.playlists.byId(playlistId, userId)) {
      return res.status(404).json({ error: "Not found" });
    }
    const targetField = field || "url";
    let modified = 0;

    store.inTransaction(() => {
      for (const c of store.channels.byPlaylist(playlistId, userId)) {
        if (ids && Array.isArray(ids) && !ids.includes(c.id)) continue;
        const current = (c as any)[targetField];
        if (typeof current !== "string" || !current.includes(search)) continue;
        const updated = current.replaceAll(search, replace ?? "");
        if (updated === current) continue;
        modified++;
        store.channels.update(c.id, userId, { [targetField]: updated } as Partial<Channel>);
      }
    });

    res.json({ success: true, modified });
  });

  app.post("/api/playlists/:playlistId/channels/bulk-delete", (req, res) => {
    const { playlistId } = req.params;
    const { ids } = req.body;
    const userId = actingUserId(req);
    if (!store.playlists.byId(playlistId, userId)) {
      return res.status(404).json({ error: "Not found" });
    }
    // Scoped to the playlist, matching the previous filter.
    const idSet = new Set<string>(ids ?? []);
    const toDelete = store.channels
      .byPlaylist(playlistId, userId)
      .filter(c => idSet.has(c.id))
      .map(c => c.id);
    store.inTransaction(() => store.channels.deleteMany(toDelete, userId));
    res.json({ success: true });
  });

  app.post("/api/playlists/:playlistId/channels/reorder", (req, res) => {
    const { playlistId } = req.params;
    const { orders } = req.body; // { id: newOrder }
    const userId = actingUserId(req);
    if (!store.playlists.byId(playlistId, userId)) {
      return res.status(404).json({ error: "Not found" });
    }
    // One transaction for the whole reorder, so a drag can't half-apply.
    store.inTransaction(() => {
      const now = Date.now();
      for (const c of store.channels.byPlaylist(playlistId, userId)) {
        if (orders[c.id] !== undefined) store.channels.setOrder(c.id, orders[c.id], now);
      }
    });
    res.json({ success: true });
  });

  app.post("/api/health-check", async (req, res) => {
    const { channels } = req.body as { channels: { id: string; url: string }[] };
    if (!Array.isArray(channels)) return res.status(400).json({ error: 'Invalid input' });
    const TIMEOUT_MS = 8000;
    const results = await Promise.all(
      channels.map(async ({ id, url }) => {
        if (!url) return { id, ok: false, code: null, skipped: true };
        if (!/^https?:\/\//i.test(url)) return { id, ok: false, code: null, skipped: true };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const r = await fetch(url, { method: 'HEAD', signal: controller.signal });
          clearTimeout(timer);
          return { id, ok: r.status < 400, code: r.status };
        } catch (e: any) {
          clearTimeout(timer);
          if (e.name === 'AbortError') return { id, ok: false, code: null, timeout: true };
          // Some servers reject HEAD — try a GET that we abort immediately after headers
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), TIMEOUT_MS);
          try {
            const r2 = await fetch(url, { method: 'GET', signal: c2.signal });
            clearTimeout(t2);
            c2.abort();
            return { id, ok: r2.status < 400, code: r2.status };
          } catch (e2: any) {
            clearTimeout(t2);
            if (e2.name === 'AbortError') return { id, ok: false, code: null, timeout: true };
            return { id, ok: false, code: null };
          }
        }
      })
    );
    res.json({ results });
  });

  // Searches across all three feature surfaces (playlists, channel pool sources, EPG
  // sources) so Spotlight can index the whole app, not just the active playlist. Each
  // result carries a `kind` discriminator plus a generic container/category shape — the
  // frontend groups by kind, then container, then category (EPG results get `category:
  // null` since EPG channels aren't categorized). Results are capped at 50 per kind,
  // matching the cap the single-surface search and /api/epg/tvg-ids already used.
  app.get("/api/search", (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);
    const userId = actingUserId(req);
    const allPlaylists = store.playlists.all(userId);
    const allChannels = store.channels.allForUser(userId);
    const allPoolSources = store.poolSources.all(userId);
    const allEpgSources = store.epgSources.all(userId);
    const matches = (...fields: (string | null | undefined)[]) => fields.some(f => f?.toLowerCase().includes(q));

    const playlistResults = allChannels
      .filter(c => matches(c.name, c.url, c.tvgId))
      .slice(0, 50)
      .map(c => ({
        kind: "playlist",
        id: c.id,
        containerId: c.playlistId,
        containerName: allPlaylists.find(p => p.id === c.playlistId)?.name ?? '',
        category: c.category,
        name: c.name,
        url: c.url,
        tvgId: c.tvgId,
        logo: c.logo,
        isHidden: c.isHidden,
      }));

    const allPoolEntries = allPoolSources.flatMap(s => store.poolEntries.bySource(s.id));
    const channelPoolResults = allPoolEntries
      .filter(e => matches(e.name, e.url, e.tvgId))
      .slice(0, 50)
      .map(e => ({
        kind: "channelPool",
        id: e.id,
        containerId: e.sourceId,
        containerName: allPoolSources.find(s => s.id === e.sourceId)?.name ?? '',
        category: e.category,
        name: e.name,
        url: e.url,
        tvgId: e.tvgId,
        logo: e.logo,
      }));

    // EPG channels only ever live in the in-memory cache (never persisted), so this
    // walks it the same way /api/epg/tvg-ids does — including its trick of returning
    // as soon as the cap is hit instead of scanning every remaining source.
    const epgResults: any[] = [];
    for (const [sourceId, cache] of epgCache.entries()) {
      const source = allEpgSources.find(s => s.id === sourceId);
      if (!source) continue;
      for (const ch of cache.channels) {
        if (!matches(ch.id, ch.displayName)) continue;
        epgResults.push({
          kind: "epg",
          id: ch.id,
          containerId: source.id,
          containerName: source.name,
          category: null,
          name: ch.displayName,
          url: null,
          tvgId: ch.id,
          logo: ch.icon,
        });
        if (epgResults.length >= 50) return res.json([...playlistResults, ...channelPoolResults, ...epgResults]);
      }
    }

    res.json([...playlistResults, ...channelPoolResults, ...epgResults]);
  });

  // Legacy long-form URL (kept for backwards compatibility)
  app.get("/api/playlists/:exportId.m3u", (req, res) => {
    const playlist = store.playlists.byExportId(req.params.exportId, actingUserId(req));
    if (!playlist) return res.status(404).send("Playlist not found");
    serveM3U(playlist, res);
  });

  // Proxy endpoint for downloading external M3U Links
  app.get("/api/proxy", async (req, res) => {
    const targetUrl = req.query.url as string;
    if (!targetUrl) return res.status(400).send("Missing URL");
    try {
      const response = await fetch(targetUrl);
      if (!response.ok) throw new Error("Failed to fetch");
      const text = await response.text();
      res.setHeader("Content-Type", "text/plain");
      res.send(text);
    } catch (e) {
      res.status(500).send("Error fetching URL");
    }
  });

  // Builds the XMLTV document for one playlist. Shared by the token export
  // route and the legacy short-id route.
  function serveEpgXml(playlist: Playlist, res: any) {
    const channels = store.channels
      .byPlaylistForExport(playlist.id)
      .filter(c => !c.isHidden && c.tvgId);
    const tvgIds = new Set(channels.map(c => c.tvgId));
    // epgCache is global and keyed by source id, so it has to be filtered to the
    // playlist owner's sources — otherwise a matching tvg-id would pull another
    // account's programme data into this document.
    const ownSourceIds = new Set(store.epgSources.all(playlist.userId).map(src => src.id));

    res.setHeader("Content-Type", "application/xml");
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="m3u4me">\n`;
    
    for (const [sourceId, cache] of epgCache.entries()) {
      if (!ownSourceIds.has(sourceId)) continue;
      for (const c of cache.channels) {
        if (tvgIds.has(c.id)) {
          xml += `  <channel id="${escapeXmlAttr(c.id)}">\n`;
          xml += `    <display-name><![CDATA[${escapeCData(c.displayName)}]]></display-name>\n`;
          if (c.icon) xml += `    <icon src="${escapeXmlAttr(c.icon)}"/>\n`;
          xml += `  </channel>\n`;
        }
      }
      for (const p of cache.programmes) {
        if (tvgIds.has(p.channel)) {
          xml += `  <programme start="${escapeXmlAttr(p.start)}" stop="${escapeXmlAttr(p.stop)}" channel="${escapeXmlAttr(p.channel)}">\n`;
          xml += `    <title><![CDATA[${escapeCData(p.title)}]]></title>\n`;
          if (p.desc) xml += `    <desc><![CDATA[${escapeCData(p.desc)}]]></desc>\n`;
          if (p.category) xml += `    <category><![CDATA[${escapeCData(p.category)}]]></category>\n`;
          if (p.icon) xml += `    <icon src="${escapeXmlAttr(p.icon)}"/>\n`;
          xml += `  </programme>\n`;
        }
      }
    }
    xml += `</tv>`;
    res.send(xml);
  }

  // ── Public export URLs ────────────────────────────────────────────────
  //
  // These are the only routes IPTV players and EPG grabbers can use, since
  // those clients cannot send a bearer token. Authorisation is therefore the
  // unguessable per-playlist export token (256 bits), which the owner can
  // rotate to invalidate a leaked link.
  app.get("/e/:token", (req, res) => {
    const playlist = store.playlists.byExportToken(req.params.token);
    if (!playlist) return res.status(404).send("Playlist not found");
    serveM3U(playlist, res);
  });

  app.get("/e/:token/epg", (req, res) => {
    const playlist = store.playlists.byExportToken(req.params.token);
    if (!playlist) return res.status(404).send("Playlist not found");
    serveEpgXml(playlist, res);
  });

  // Legacy short numeric URLs: /1  /2  /3 …
  //
  // OFF BY DEFAULT. shortId is a small incrementing integer and these routes
  // are necessarily unauthenticated, so with more than one account anyone on
  // the network could walk /1, /2, /3 … and read every playlist — including
  // stream URLs, which in IPTV routinely embed the provider's credentials.
  // Set ALLOW_INSECURE_SHORT_IDS=1 to re-enable them for a migration window
  // while players are repointed at their /e/:token URLs.
  const allowShortIds = process.env.ALLOW_INSECURE_SHORT_IDS === '1';
  if (allowShortIds) {
    console.warn(
      'ALLOW_INSECURE_SHORT_IDS=1: /:shortId playlist URLs are enabled and are ' +
        'unauthenticated and enumerable. Repoint players at their /e/:token URL and unset this.',
    );
  }

  const shortIdRoute = (handler: (playlist: Playlist, res: any) => void) =>
    (req: express.Request, res: express.Response) => {
      if (!allowShortIds) {
        return res
          .status(410)
          .send(
            'Numeric playlist URLs are disabled because they are enumerable. Use the ' +
              "playlist's /e/<token> export URL instead, or set ALLOW_INSECURE_SHORT_IDS=1.",
          );
      }
      const playlist = store.playlists.byShortIdUnscoped(parseInt(req.params[0], 10));
      if (!playlist) return res.status(404).send("Playlist not found");
      handler(playlist, res);
    };

  app.get(/^\/(\d+)\/epg$/, shortIdRoute(serveEpgXml));
  app.get(/^\/(\d+)$/, shortIdRoute(serveM3U));

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
