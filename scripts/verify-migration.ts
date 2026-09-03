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

const gotPlaylists = store.playlists.all();
const gotChannels = store.channels.all();
const gotEpg = store.epgSources.all();
const gotPoolSrc = store.poolSources.all();
const gotLogs = store.poolChangeLogs.all();
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

compareSet("playlists", json.playlists ?? [], gotPlaylists);
compareSet("channels", json.channels ?? [], gotChannels, normChannel);
compareSet("epgSources", json.epgSources ?? [], gotEpg);
compareSet("channelPoolSources", json.channelPoolSources ?? [], gotPoolSrc);
compareSet("channelPoolChangeLogs", json.channelPoolChangeLogs ?? [], gotLogs);
compareSet("channelPoolEntries", json.channelPoolEntries ?? [], allEntries);

// ── Ordering, which drag-reorder depends on ─────────────────────────────────

for (const p of gotPlaylists) {
  const orders = store.channels.byPlaylist(p.id).map((c) => c.order);
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
check("channel count unchanged after re-run", store.channels.all().length === gotChannels.length);

// ── Transaction rollback ────────────────────────────────────────────────────

const before = store.channels.all().length;
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
check("failed transaction rolls back", store.channels.all().length === before);

fs.rmSync(scratch, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
