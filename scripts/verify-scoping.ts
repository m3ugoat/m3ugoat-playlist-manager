// Proves per-user isolation and the public export-token routes.
//
//   npm run verify:scoping
//
// Boots a real server against a throwaway database on a spare port, creates two
// accounts, and tries to reach account A's data as account B through every route
// that takes an id. A leak here is a security bug, so each attempt is asserted
// individually rather than sampled.

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const PORT = 8126;
const BASE = `http://localhost:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "m3ugoat-scope-"));
const DB = path.join(scratch, "scope-test.db");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

let server: ChildProcess | null = null;

async function startServer(extraEnv: Record<string, string> = {}) {
  server = spawn("npx", ["tsx", "server.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      M3UGOAT_DB_PATH: DB,
      M3UGOAT_LEGACY_JSON: path.join(scratch, "none.json"),
      M3UGOAT_LEGACY_AUTH: path.join(scratch, "none-auth.json"),
      ...extraEnv,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/auth/status`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

async function stopServer() {
  if (!server) return;
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1200));
  server = null;
}

const call = async (method: string, url: string, body?: any, token?: string) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
};

try {
  await startServer();

  // ── Two accounts ──
  await call("POST", "/api/auth/set-password", { password: "alicepw", username: "alice" });
  let r = await call("POST", "/api/auth/login", { password: "alicepw" });
  const alice: string = r.body.token;
  await call("POST", "/api/users", { username: "bob", password: "bobpw123" }, alice);
  r = await call("POST", "/api/auth/login", { username: "bob", password: "bobpw123" });
  const bob: string = r.body.token;
  check("two accounts created and both logged in", !!alice && !!bob);

  // ── Alice's data ──
  r = await call("POST", "/api/playlists", { name: "Alice List" }, alice);
  const aPlaylist = r.body.id;
  const aToken = r.body.exportToken;
  check("new playlist carries an export token", typeof aToken === "string" && aToken.length >= 40);

  await call(
    "POST",
    `/api/playlists/${aPlaylist}/channels/bulk`,
    { channels: [{ name: "Secret Ch", url: "http://alice.test/secret", category: "Private" }] },
    alice,
  );
  const aChannel = (await call("GET", `/api/playlists/${aPlaylist}/channels`, undefined, alice)).body[0].id;

  r = await call("POST", "/api/playlists", { name: "Bob List" }, bob);
  const bPlaylist = r.body.id;

  // ── Listing is scoped ──
  r = await call("GET", "/api/playlists", undefined, bob);
  check("Bob's playlist list excludes Alice's", r.body.length === 1 && r.body[0].name === "Bob List", JSON.stringify(r.body.map((p: any) => p.name)));
  r = await call("GET", "/api/playlists", undefined, alice);
  check("Alice's playlist list excludes Bob's", r.body.length === 1 && r.body[0].name === "Alice List");

  // ── Reads by id are scoped: 404, not 403, so existence isn't confirmed ──
  r = await call("GET", `/api/playlists/${aPlaylist}/channels`, undefined, bob);
  check("Bob cannot read Alice's channels", r.status === 404, `got ${r.status}`);

  // ── Writes by id are scoped ──
  const writeAttempts: [string, string, string, any][] = [
    ["rename Alice's playlist", "PUT", `/api/playlists/${aPlaylist}`, { name: "pwned" }],
    ["delete Alice's playlist", "DELETE", `/api/playlists/${aPlaylist}`, undefined],
    ["add channels to Alice's playlist", "POST", `/api/playlists/${aPlaylist}/channels/bulk`, { channels: [{ name: "x", url: "http://x.test", category: "c" }] }],
    ["edit Alice's channel", "PUT", `/api/playlists/${aPlaylist}/channels/${aChannel}`, { name: "pwned" }],
    ["delete Alice's channel", "DELETE", `/api/playlists/${aPlaylist}/channels/${aChannel}`, undefined],
    ["bulk-update Alice's channels", "POST", `/api/playlists/${aPlaylist}/channels/bulk-update`, { ids: [aChannel], updates: { name: "pwned" } }],
    ["bulk-update-many Alice's channels", "POST", `/api/playlists/${aPlaylist}/channels/bulk-update-many`, { updates: [{ id: aChannel, changes: { name: "pwned" } }] }],
    ["bulk-replace in Alice's playlist", "POST", `/api/playlists/${aPlaylist}/channels/bulk-replace`, { search: "http://", replace: "evil://" }],
    ["bulk-delete Alice's channels", "POST", `/api/playlists/${aPlaylist}/channels/bulk-delete`, { ids: [aChannel] }],
    ["reorder Alice's channels", "POST", `/api/playlists/${aPlaylist}/channels/reorder`, { orders: { [aChannel]: 42 } }],
    ["rotate Alice's export token", "POST", `/api/playlists/${aPlaylist}/rotate-export-token`, undefined],
  ];
  for (const [label, method, url, body] of writeAttempts) {
    r = await call(method, url, body, bob);
    check(`Bob cannot ${label}`, r.status === 404, `got ${r.status}`);
  }

  // Alice's data must be untouched by all of that.
  r = await call("GET", `/api/playlists/${aPlaylist}/channels`, undefined, alice);
  check("Alice's channel survived every attempt intact", r.body.length === 1 && r.body[0].name === "Secret Ch" && r.body[0].url === "http://alice.test/secret", JSON.stringify(r.body.map((c: any) => c.name)));
  r = await call("GET", "/api/playlists", undefined, alice);
  check("Alice's playlist name unchanged", r.body[0].name === "Alice List");

  // ── Sources are scoped, credentials included ──
  r = await call("POST", "/api/channel-pool/sources/upload", { name: "Alice Pool", filename: "a.m3u", content: "#EXTM3U\n#EXTINF:-1,A\nhttp://a.test/1\n" }, alice);
  const aSource = r.body.id;
  check("Alice created a pool source", !!aSource);
  r = await call("GET", "/api/channel-pool/sources", undefined, bob);
  check("Bob's source list excludes Alice's", Array.isArray(r.body) && r.body.length === 0, JSON.stringify(r.body));
  for (const [label, method, url] of [
    ["read Alice's pool channels", "GET", `/api/channel-pool/sources/${aSource}/channels`],
    ["read Alice's pool categories", "GET", `/api/channel-pool/sources/${aSource}/categories`],
    ["refresh Alice's pool source", "POST", `/api/channel-pool/sources/${aSource}/refresh`],
    ["rename Alice's pool source", "PUT", `/api/channel-pool/sources/${aSource}`],
    ["delete Alice's pool source", "DELETE", `/api/channel-pool/sources/${aSource}`],
  ] as [string, string, string][]) {
    r = await call(method, url, method === "PUT" ? { name: "pwned" } : undefined, bob);
    check(`Bob cannot ${label}`, r.status === 404, `got ${r.status}`);
  }
  r = await call("GET", `/api/channel-pool/sources/${aSource}/channels`, undefined, alice);
  check("Alice's pool source still readable by Alice", r.status === 200 && r.body.length === 1);

  // ── Search must not cross accounts ──
  r = await call("GET", "/api/search?q=secret", undefined, bob);
  check("search does not leak Alice's channels to Bob", Array.isArray(r.body) && r.body.length === 0, JSON.stringify(r.body));
  r = await call("GET", "/api/search?q=secret", undefined, alice);
  check("search still finds Alice's own channel", Array.isArray(r.body) && r.body.length >= 1);

  // ── Public export token works without any auth ──
  r = await call("GET", `/e/${aToken}`);
  check("/e/:token serves the M3U with no token at all", r.status === 200 && String(r.body).startsWith("#EXTM3U"), `got ${r.status}`);
  check("/e/:token M3U contains the channel", String(r.body).includes("http://alice.test/secret"));
  r = await call("GET", `/e/${aToken}/epg`);
  check("/e/:token/epg serves XMLTV", r.status === 200 && String(r.body).includes("<tv "), `got ${r.status}`);
  r = await call("GET", "/e/not-a-real-token");
  check("a wrong export token is 404", r.status === 404, `got ${r.status}`);

  // ── Numeric short-id URLs are off by default ──
  r = await call("GET", "/1");
  check("/1 is 410 Gone by default", r.status === 410, `got ${r.status}`);
  r = await call("GET", "/1/epg");
  check("/1/epg is 410 Gone by default", r.status === 410, `got ${r.status}`);

  // ── Rotation invalidates the old link ──
  r = await call("POST", `/api/playlists/${aPlaylist}/rotate-export-token`, undefined, alice);
  const rotated = r.body.exportToken;
  check("Alice can rotate her own export token", r.status === 200 && !!rotated && rotated !== aToken);
  r = await call("GET", `/e/${aToken}`);
  check("the old export link is dead after rotation", r.status === 404, `got ${r.status}`);
  r = await call("GET", `/e/${rotated}`);
  check("the new export link works", r.status === 200 && String(r.body).startsWith("#EXTM3U"));

  // ── Opt back in to the legacy URLs ──
  await stopServer();
  await startServer({ ALLOW_INSECURE_SHORT_IDS: "1" });
  r = await call("GET", "/1");
  check("/1 works with ALLOW_INSECURE_SHORT_IDS=1", r.status === 200 && String(r.body).startsWith("#EXTM3U"), `got ${r.status}`);
  // And this is exactly the enumeration the flag re-opens.
  r = await call("GET", "/2");
  check("with the flag on, /2 reaches Bob's playlist unauthenticated (why it defaults off)", r.status === 200, `got ${r.status}`);
} finally {
  await stopServer();
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
