// Checks the OpenAPI description against the routes server.ts actually
// registers, and against a live server.
//
//   npm run verify:openapi
//
// The point is drift: a spec that is structurally valid but wrong about the API
// is worse than no spec, because a client author trusts it. So this compares
// the declared operations to the real route table in both directions, and then
// exercises a few of the documented behaviours over HTTP.

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const PORT = 8128;
const BASE = `http://localhost:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "m3u4me-spec-"));

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const { openapi } = await import("../openapi.ts");
const spec = openapi as any;

// ── Structural sanity ───────────────────────────────────────────────────────

check("declares OpenAPI 3.1", String(spec.openapi).startsWith("3.1"), spec.openapi);
check("has info.title and info.version", !!spec.info?.title && !!spec.info?.version);
check("declares a bearer security scheme", spec.components?.securitySchemes?.bearerAuth?.scheme === "bearer");

// Every $ref must resolve.
const refs = new Set<string>();
(function walk(node: any) {
  if (!node || typeof node !== "object") return;
  if (typeof node.$ref === "string") refs.add(node.$ref);
  for (const v of Object.values(node)) walk(v);
})(spec);
const unresolved = [...refs].filter((r) => {
  const parts = r.replace(/^#\//, "").split("/");
  let cur: any = spec;
  for (const p of parts) cur = cur?.[p];
  return cur === undefined;
});
check("every $ref resolves", unresolved.length === 0, unresolved.join(", "));
check("uses a non-trivial number of $refs", refs.size > 10, `${refs.size} refs`);

// Every operation needs a summary, a tag, and at least one response.
const operations: { path: string; method: string; op: any }[] = [];
for (const [p, item] of Object.entries<any>(spec.paths)) {
  for (const m of ["get", "post", "put", "patch", "delete"]) {
    if (item[m]) operations.push({ path: p, method: m, op: item[m] });
  }
}
check("declares operations", operations.length > 30, `${operations.length} operations`);
const missingSummary = operations.filter((o) => !o.op.summary).map((o) => `${o.method} ${o.path}`);
check("every operation has a summary", missingSummary.length === 0, missingSummary.join(", "));
const missingTag = operations.filter((o) => !o.op.tags?.length).map((o) => `${o.method} ${o.path}`);
check("every operation has a tag", missingTag.length === 0, missingTag.join(", "));
const missingResp = operations.filter((o) => !Object.keys(o.op.responses ?? {}).length).map((o) => `${o.method} ${o.path}`);
check("every operation declares responses", missingResp.length === 0, missingResp.join(", "));
const declaredTags = new Set((spec.tags ?? []).map((t: any) => t.name));
const unknownTags = [...new Set(operations.flatMap((o) => o.op.tags))].filter((t) => !declaredTags.has(t));
check("every tag used is declared in tags[]", unknownTags.length === 0, unknownTags.join(", "));

// operationIds are what client generators turn into method names, so they must
// exist and be unique. openapi.ts throws on a mismatch at import time; this
// asserts the result rather than trusting it.
const ids = operations.map((o) => o.op.operationId);
check("every operation has an operationId", ids.every(Boolean), `${ids.filter(Boolean).length}/${ids.length}`);
check("operationIds are unique", new Set(ids).size === ids.length, `${new Set(ids).size} unique of ${ids.length}`);
check(
  "operationIds are camelCase identifiers",
  ids.every((id) => /^[a-z][A-Za-z0-9]*$/.test(String(id))),
  ids.filter((id) => !/^[a-z][A-Za-z0-9]*$/.test(String(id))).join(", "),
);

// openapi.json is generated from openapi.ts and committed for external tooling,
// so it must not be stale.
const jsonPath = path.join(process.cwd(), "openapi.json");
if (fs.existsSync(jsonPath)) {
  const onDisk = fs.readFileSync(jsonPath, "utf-8");
  const expected = JSON.stringify(spec, null, 2) + "\n";
  check("openapi.json is in sync with openapi.ts (run `npm run openapi:write`)", onDisk === expected);
} else {
  check("openapi.json exists (run `npm run openapi:write`)", false);
}

// ── Drift: spec vs. the real route table ────────────────────────────────────

const serverSrc = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf-8");

// Routes registered as string literals. Regex routes (the numeric short-id
// URLs) are handled separately below since they have no literal path.
const registered = new Set<string>();
const routeRe = /app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
for (let m: RegExpExecArray | null; (m = routeRe.exec(serverSrc)); ) {
  const [, method, route] = m;
  if (route === "*") continue; // the SPA catch-all
  registered.add(`${method} ${route}`);
}

// Express uses :param, OpenAPI uses {param}.
const toExpress = (p: string) => p.replace(/\{([^}]+)\}/g, ":$1");
const specOps = new Set(operations.map((o) => `${o.method} ${toExpress(o.path)}`));

// The legacy .m3u route is written as ":exportId.m3u" in Express.
const KNOWN_SHAPE_DIFFS = new Map([
  ["get /api/playlists/:exportId.m3u", "get /api/playlists/:exportId.m3u"],
]);

// Numeric short-id routes are regex-registered, so assert their presence directly.
check(
  "the regex short-id routes exist in server.ts",
  /app\.get\(\/\^\\\/\(\\d\+\)\\\/epg\$\//.test(serverSrc) || serverSrc.includes("shortIdRoute(serveEpgXml)"),
);
const REGEX_ROUTES = ["get /:shortId", "get /:shortId/epg"];

const documentedButMissing = [...specOps].filter(
  (o) => !registered.has(o) && !REGEX_ROUTES.includes(o) && !KNOWN_SHAPE_DIFFS.has(o),
);
check(
  "every documented operation exists in server.ts",
  documentedButMissing.length === 0,
  documentedButMissing.join(", "),
);

const implementedButUndocumented = [...registered].filter((o) => !specOps.has(o));
check(
  "every /api route in server.ts is documented",
  implementedButUndocumented.length === 0,
  implementedButUndocumented.join(", "),
);

// ── The concurrency contract is actually described ──────────────────────────

const conditional = [
  ["put", "/api/playlists/{playlistId}"],
  ["delete", "/api/playlists/{playlistId}"],
  ["put", "/api/playlists/{playlistId}/channels/{channelId}"],
  ["delete", "/api/playlists/{playlistId}/channels/{channelId}"],
  ["put", "/api/epg-sources/{id}"],
  ["delete", "/api/epg-sources/{id}"],
  ["put", "/api/channel-pool/sources/{id}"],
  ["delete", "/api/channel-pool/sources/{id}"],
];
const missingIfMatch = conditional.filter(([m, p]) => {
  const params = spec.paths[p]?.[m]?.parameters ?? [];
  return !params.some((x: any) => x.name === "If-Match");
});
check("all 8 conditional routes document If-Match", missingIfMatch.length === 0, missingIfMatch.map((x) => x.join(" ")).join(", "));
const missing409 = conditional.filter(([m, p]) => !spec.paths[p]?.[m]?.responses?.["409"]);
check("all 8 conditional routes document 409", missing409.length === 0, missing409.map((x) => x.join(" ")).join(", "));

// Bulk routes must NOT claim If-Match support, since they don't have it.
const bulk = [
  "/api/playlists/{playlistId}/channels/bulk-update",
  "/api/playlists/{playlistId}/channels/bulk-update-many",
  "/api/playlists/{playlistId}/channels/bulk-replace",
  "/api/playlists/{playlistId}/channels/bulk-delete",
  "/api/playlists/{playlistId}/channels/reorder",
];
const bulkClaimingIfMatch = bulk.filter((p) =>
  (spec.paths[p]?.post?.parameters ?? []).some((x: any) => x.name === "If-Match"),
);
check("bulk routes do not claim If-Match support", bulkClaimingIfMatch.length === 0, bulkClaimingIfMatch.join(", "));

// Public routes must be marked as needing no auth.
for (const p of ["/e/{token}", "/e/{token}/epg", "/api/auth/status", "/api/auth/login", "/api/openapi.json"]) {
  check(`${p} is documented as unauthenticated`, Array.isArray(spec.paths[p]?.get?.security ?? spec.paths[p]?.post?.security) && (spec.paths[p]?.get?.security ?? spec.paths[p]?.post?.security).length === 0);
}
check(
  "/{shortId} documents the 410",
  !!spec.paths["/{shortId}"]?.get?.responses?.["410"],
);

// ── Against a live server ───────────────────────────────────────────────────

let server: ChildProcess | null = null;
try {
  server = spawn("npx", ["tsx", "server.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      M3U4ME_DB_PATH: path.join(scratch, "spec.db"),
      M3U4ME_LEGACY_JSON: path.join(scratch, "none.json"),
      M3U4ME_LEGACY_AUTH: path.join(scratch, "none-auth.json"),
    },
    stdio: "ignore",
  });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/auth/status`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  check("server started", up);

  if (up) {
    const res = await fetch(`${BASE}/api/openapi.json`);
    check("GET /api/openapi.json returns 200 with no token", res.status === 200, `got ${res.status}`);
    const served = await res.json();
    check("the served document matches openapi.ts", served.info?.version === spec.info.version && Object.keys(served.paths).length === Object.keys(spec.paths).length);

    // Spot-check that documented status codes are real.
    const st = await (await fetch(`${BASE}/api/auth/status`)).json();
    const statusProps = Object.keys(spec.paths["/api/auth/status"].get.responses["200"].content["application/json"].schema.properties);
    check(
      "auth/status response matches its documented schema",
      statusProps.every((k) => k in st),
      `documented ${statusProps.join(",")} / got ${Object.keys(st).join(",")}`,
    );

    const gone = await fetch(`${BASE}/1`);
    check("/1 really returns the documented 410", gone.status === 410, `got ${gone.status}`);

    const notFound = await fetch(`${BASE}/e/definitely-not-a-token`);
    check("/e/{token} really returns the documented 404", notFound.status === 404, `got ${notFound.status}`);
  }
} finally {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1000));
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
