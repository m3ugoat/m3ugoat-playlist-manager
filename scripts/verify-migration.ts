// Proves migrateFromJson() copies data/db.json into SQLite losslessly.
//
//   npm run verify:migration
//
// Runs against a throwaway database in the system temp directory, so it never
// touches data/m3u4me.db. Exits non-zero if any check fails.

import fs from "fs";
import os from "os";
import path from "path";

const legacy = process.env.M3U4ME_LEGACY_JSON || path.join(process.cwd(), "data", "db.json");
if (!fs.existsSync(legacy)) {
  console.error(`No legacy JSON at ${legacy} — nothing to verify.`);
  process.exit(1);
}

// Point the store at a scratch database before importing it, since it opens the
// connection at module load.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "m3u4me-verify-"));
process.env.M3U4ME_DB_PATH = path.join(scratch, "verify.db");
process.env.M3U4ME_LEGACY_JSON = legacy;

const store = await import("../db.ts");

const json = JSON.parse(fs.readFileSync(legacy, "utf-8"));

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const res = store.migrateFromJson();
console.log(`\nmigrated: ${res.migrated}`, res.counts ?? "");
console.log("");

// ── Counts ──────────────────────────────────────────────────────────────────

const UID = store.LEGACY_USER_ID;
const gotPlaylists = store.playlists.all(UID);
const gotChannels = store.channels.allForUser(UID);
const gotEpg = store.epgSources.all(UID);
const gotPoolSrc = store.poolSources.all(UID);
const gotLogs = store.poolChangeLogs.all(UID);
const allEntries: any[] = [];
for (const s of gotPoolSrc) allEntries.push(...store.poolEntries.bySource(s.id));

const counts: [string, number, number][] = [
  ["playlists", gotPlaylists.length, (json.playlists ?? []).length],
  ["channels", gotChannels.length, (json.channels ?? []).length],
  ["epgSources", gotEpg.length, (json.epgSources ?? []).length],
  ["channelPoolSources", gotPoolSrc.length, (json.channelPoolSources ?? []).length],
  ["channelPoolEntries", allEntries.length, (json.channelPoolEntries ?? []).length],
  ["channelPoolChangeLogs", gotLogs.length, (json.channelPoolChangeLogs ?? []).length],
];
for (const [label, got, want] of counts) {
  check(`${label} count`, got === want, `sqlite ${got} / json ${want}`);
}

// ── Field-for-field comparison ──────────────────────────────────────────────

const sortKeys = (o: any) =>
  JSON.stringify(o, Object.keys(o).sort() as any);

function compareSet(
  label: string,
  original: any[],
  got: any[],
  normalise: (x: any) => any = (x) => x,
) {
  const byId = new Map(got.map((r: any) => [r.id, r]));
  let mismatch: string | null = null;
  for (const o of original) {
    const g = byId.get(o.id);
    if (!g) {
      mismatch = `missing id ${o.id}`;
      break;
    }
    const a = sortKeys(normalise(o));
    const b = sortKeys(normalise(g));
    if (a !== b) {
      mismatch = `id ${o.id}\n            json:   ${a}\n            sqlite: ${b}`;
      break;
    }
  }
  check(`${label} field-for-field`, mismatch === null, mismatch ?? `${original.length} records`);
}

// isHidden was optional in the JSON store; SQLite always materialises it as a
// boolean, so normalise both sides before comparing.
const normChannel = (c: any) => ({ ...c, isHidden: !!c.isHidden });
// exportToken is generated during the migration, so it has no JSON counterpart.
const normPlaylist = (p: any) => {
  const { exportToken, ...rest } = p;
  return rest;
};
// Likewise userId: the source tables gained it when accounts were introduced,
// and the migration stamps the legacy account onto pre-existing rows.
const normSource = (x: any) => {
  const { userId, ...rest } = x;
  return rest;
};

compareSet("playlists", json.playlists ?? [], gotPlaylists, normPlaylist);
compareSet("channels", json.channels ?? [], gotChannels, normChannel);
compareSet("epgSources", json.epgSources ?? [], gotEpg, normSource);
compareSet("channelPoolSources", json.channelPoolSources ?? [], gotPoolSrc, normSource);
compareSet("channelPoolChangeLogs", json.channelPoolChangeLogs ?? [], gotLogs);
compareSet("channelPoolEntries", json.channelPoolEntries ?? [], allEntries);

check(
  "every migrated playlist got an export token",
  gotPlaylists.every((p) => typeof p.exportToken === "string" && p.exportToken.length >= 40),
);
check(
  "migrated sources are owned by the legacy account",
  [...gotEpg, ...gotPoolSrc].every((x: any) => x.userId === UID),
);
check(
  "export tokens are unique",
  new Set(gotPlaylists.map((p) => p.exportToken)).size === gotPlaylists.length,
);

// ── Ordering, which drag-reorder depends on ─────────────────────────────────

for (const p of gotPlaylists) {
  const orders = store.channels.byPlaylist(p.id, UID).map((c) => c.order);
  const ascending = orders.every((v, i) => i === 0 || orders[i - 1] <= v);
  check(`channel order ascending in "${p.name}"`, ascending);

  const originalCats =
    (json.playlists ?? []).find((x: any) => x.id === p.id)?.categories ?? [];
  check(
    `category order preserved in "${p.name}"`,
    JSON.stringify(p.categories) === JSON.stringify(originalCats),
  );
}

// ── Re-running must be a no-op rather than a duplicate ──────────────────────

const second = store.migrateFromJson();
check("second run is a no-op", second.migrated === false);
check("channel count unchanged after re-run", store.channels.allForUser(UID).length === gotChannels.length);

// ── Transaction rollback ────────────────────────────────────────────────────

const before = store.channels.allForUser(UID).length;
try {
  store.inTransaction(() => {
    const p = gotPlaylists[0];
    if (p) {
      store.channels.insert({
        id: "rollback-probe",
        playlistId: p.id,
        name: "probe",
        url: "http://example.invalid/probe",
        logo: null,
        tvgId: null,
        category: "probe",
        order: 9999,
        isHidden: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    throw new Error("deliberate rollback");
  });
} catch {
  /* expected */
}
check("failed transaction rolls back", store.channels.allForUser(UID).length === before);

// ── Upgrading an OLDER database in place ────────────────────────────────────
//
// The checks above all run against a database this process just created, which
// means they exercise the CREATE TABLE path and never the ALTER TABLE path. A
// real upgrade opens a database whose tables predate the newer columns — where
// CREATE TABLE IF NOT EXISTS is a no-op — so it is tested separately, in its own
// process (db.ts opens its connection at import time).

const legacyShaped = path.join(scratch, "old-shape.db");
{
  const { DatabaseSync } = await import("node:sqlite");
  const old = new DatabaseSync(legacyShaped);
  // Tables exactly as an earlier phase created them: no user_id on the source
  // tables, no export_token on playlists.
  old.exec(`
    CREATE TABLE playlists (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      categories TEXT NOT NULL DEFAULT '[]', export_id TEXT NOT NULL UNIQUE,
      short_id INTEGER NOT NULL UNIQUE, version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE epg_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, type TEXT NOT NULL,
      xtream_username TEXT, xtream_password TEXT,
      refresh_interval_hours INTEGER NOT NULL DEFAULT 12, last_fetched INTEGER,
      last_fetch_error TEXT, channel_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE TABLE channel_pool_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, url TEXT,
      xtream_username TEXT, xtream_password TEXT,
      refresh_interval_hours INTEGER NOT NULL DEFAULT 24, last_fetched INTEGER,
      last_fetch_error TEXT, channel_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
  `);
  old.prepare(
    `INSERT INTO playlists (id, user_id, name, categories, export_id, short_id, created_at, updated_at)
     VALUES ('p-old', 'local-user', 'Pre-upgrade', '["General"]', 'exp-old', 1, 1, 1)`,
  ).run();
  old.prepare(
    `INSERT INTO epg_sources (id, name, url, type, created_at, updated_at)
     VALUES ('e-old', 'Old EPG', 'http://old.test/x.xml', 'xml', 1, 1)`,
  ).run();
  old.close();
}

const { spawnSync } = await import("child_process");
const probe = spawnSync(
  process.execPath,
  [
    "-e",
    `const s = await import('${path.resolve("db.ts")}');
     const p = s.playlists.all('local-user')[0];
     const e = s.epgSources.all('local-user')[0];
     console.log(JSON.stringify({
       tokenLen: (p.exportToken || '').length,
       name: p.name,
       epgUserId: e ? e.userId : null,
     }));`,
  ],
  {
    env: { ...process.env, M3U4ME_DB_PATH: legacyShaped, M3U4ME_LEGACY_JSON: path.join(scratch, "none.json") },
    encoding: "utf-8",
  },
);
const upgraded = (() => {
  try {
    return JSON.parse((probe.stdout || "").trim().split("\n").pop() || "{}");
  } catch {
    return {};
  }
})();
check(
  "an older-shaped database opens without error",
  probe.status === 0,
  probe.status === 0 ? "" : (probe.stderr || "").split("\n").slice(0, 3).join(" | "),
);
check("upgrade backfills export_token on existing playlists", (upgraded.tokenLen ?? 0) >= 40, `len ${upgraded.tokenLen}`);
check("upgrade preserves existing rows", upgraded.name === "Pre-upgrade", String(upgraded.name));
check("upgrade defaults epg_sources.user_id to the legacy account", upgraded.epgUserId === "local-user", String(upgraded.epgUserId));

fs.rmSync(scratch, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
