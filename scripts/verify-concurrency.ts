// Proves the If-Match / ETag / 409 optimistic-concurrency contract.
//
//   npm run verify:concurrency
//
// Boots a real server against a throwaway database on a spare port. The point
// of these checks is the lost-update case: two clients read the same version,
// both write, and the second must be rejected rather than silently clobbering
// the first.

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const PORT = 8127;
const BASE = `http://localhost:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "m3u4me-conc-"));

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

let server: ChildProcess | null = null;

async function startServer() {
  server = spawn("npx", ["tsx", "server.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      M3U4ME_DB_PATH: path.join(scratch, "conc.db"),
      M3U4ME_LEGACY_JSON: path.join(scratch, "none.json"),
      M3U4ME_LEGACY_AUTH: path.join(scratch, "none-auth.json"),
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

const call = async (
  method: string,
  url: string,
  body?: any,
  headers: Record<string, string> = {},
) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, etag: res.headers.get("etag") };
};

try {
  await startServer();

  // ── Versions are exposed on reads ──
  let r = await call("POST", "/api/playlists", { name: "Conc" });
  const pid = r.body.id;
  r = await call("GET", "/api/playlists");
  const p0 = r.body.find((p: any) => p.id === pid);
  check("a new playlist starts at version 1", p0?.version === 1, `version ${p0?.version}`);

  // ── A write returns the new version as an ETag ──
  r = await call("PUT", `/api/playlists/${pid}`, { name: "Conc v2" });
  check("update with no If-Match succeeds (no precondition)", r.status === 200, `got ${r.status}`);
  check("update bumps the version to 2", r.body.version === 2, `version ${r.body.version}`);
  check("response carries the version as an ETag", r.etag === '"2"', String(r.etag));

  // ── The lost-update case ──
  r = await call("GET", "/api/playlists");
  const shared = r.body.find((p: any) => p.id === pid).version;
  const first = await call("PUT", `/api/playlists/${pid}`, { name: "Client A" }, { "If-Match": String(shared) });
  check("client A's conditional write succeeds", first.status === 200 && first.body.version === shared + 1, `got ${first.status}`);
  const second = await call("PUT", `/api/playlists/${pid}`, { name: "Client B" }, { "If-Match": String(shared) });
  check("client B writing the SAME version is rejected with 409", second.status === 409, `got ${second.status}`);
  check("the 409 reports the current version", second.body?.currentVersion === shared + 1, JSON.stringify(second.body?.currentVersion));
  check("the 409 carries the current server state to merge from", second.body?.current?.name === "Client A", String(second.body?.current?.name));
  check("the 409 also sets the current ETag", second.etag === `"${shared + 1}"`, String(second.etag));

  r = await call("GET", "/api/playlists");
  check("the rejected write did NOT modify anything", r.body.find((p: any) => p.id === pid).name === "Client A");

  // ── Retrying with the version from the 409 succeeds ──
  const retry = await call("PUT", `/api/playlists/${pid}`, { name: "Client B retry" }, { "If-Match": String(second.body.currentVersion) });
  check("client B's retry with the fresh version succeeds", retry.status === 200, `got ${retry.status}`);
  check("the retry's value landed", retry.body.name === "Client B retry");

  // ── Header forms and malformed input ──
  r = await call("GET", "/api/playlists");
  let v = r.body.find((p: any) => p.id === pid).version;
  r = await call("PUT", `/api/playlists/${pid}`, { name: "quoted" }, { "If-Match": `"${v}"` });
  check('a quoted If-Match ("3") is accepted', r.status === 200, `got ${r.status}`);
  v = r.body.version;
  r = await call("PUT", `/api/playlists/${pid}`, { name: "weak" }, { "If-Match": `W/"${v}"` });
  check('a weak If-Match (W/"3") is accepted', r.status === 200, `got ${r.status}`);
  v = r.body.version;
  r = await call("PUT", `/api/playlists/${pid}`, { name: "star" }, { "If-Match": "*" });
  check("If-Match: * means no precondition", r.status === 200, `got ${r.status}`);
  r = await call("PUT", `/api/playlists/${pid}`, { name: "bad" }, { "If-Match": "not-a-version" });
  check("a malformed If-Match is 400", r.status === 400, `got ${r.status}`);
  r = await call("PUT", `/api/playlists/${pid}`, { name: "stale" }, { "If-Match": "1" });
  check("a stale version is 409, not 400", r.status === 409, `got ${r.status}`);

  // ── Channels ──
  await call("POST", `/api/playlists/${pid}/channels/bulk`, {
    channels: [{ name: "Ch1", url: "http://c.test/1", category: "A" }],
  });
  r = await call("GET", `/api/playlists/${pid}/channels`);
  const ch = r.body[0];
  check("a new channel starts at version 1", ch.version === 1, `version ${ch.version}`);
  r = await call("PUT", `/api/playlists/${pid}/channels/${ch.id}`, { name: "Ch1 edited" }, { "If-Match": "1" });
  check("channel conditional update succeeds", r.status === 200 && r.body.version === 2, `got ${r.status}`);
  r = await call("PUT", `/api/playlists/${pid}/channels/${ch.id}`, { name: "clobber" }, { "If-Match": "1" });
  check("channel stale write is 409", r.status === 409, `got ${r.status}`);
  r = await call("GET", `/api/playlists/${pid}/channels`);
  check("channel value unchanged by the rejected write", r.body[0].name === "Ch1 edited", r.body[0].name);

  // ── Conditional deletes ──
  r = await call("DELETE", `/api/playlists/${pid}/channels/${ch.id}`, undefined, { "If-Match": "1" });
  check("stale conditional DELETE is 409", r.status === 409, `got ${r.status}`);
  r = await call("GET", `/api/playlists/${pid}/channels`);
  check("the channel still exists after the rejected delete", r.body.length === 1);
  r = await call("DELETE", `/api/playlists/${pid}/channels/${ch.id}`, undefined, { "If-Match": "2" });
  check("conditional DELETE with the right version succeeds", r.status === 200, `got ${r.status}`);
  r = await call("GET", `/api/playlists/${pid}/channels`);
  check("the channel is gone", r.body.length === 0);

  // ── 404 vs 409 stay distinct ──
  r = await call("PUT", "/api/playlists/does-not-exist", { name: "x" }, { "If-Match": "1" });
  check("a missing resource is 404 even with If-Match", r.status === 404, `got ${r.status}`);

  // ── Sources ──
  r = await call("POST", "/api/channel-pool/sources/upload", {
    name: "Pool",
    filename: "p.m3u",
    content: "#EXTM3U\n#EXTINF:-1,A\nhttp://a.test/1\n",
  });
  const sid = r.body.id;
  r = await call("PUT", `/api/channel-pool/sources/${sid}`, { name: "Pool v2" }, { "If-Match": "1" });
  check("pool source conditional update succeeds", r.status === 200, `got ${r.status}`);
  r = await call("PUT", `/api/channel-pool/sources/${sid}`, { name: "clobber" }, { "If-Match": "1" });
  check("pool source stale write is 409", r.status === 409, `got ${r.status}`);
  r = await call("DELETE", `/api/channel-pool/sources/${sid}`, undefined, { "If-Match": "1" });
  check("pool source stale delete is 409", r.status === 409, `got ${r.status}`);
  r = await call("GET", "/api/channel-pool/sources");
  check("pool source survived the rejected delete", r.body.length === 1 && r.body[0].name === "Pool v2");

  // ── A burst of concurrent conditional writes on one version: exactly one wins ──
  r = await call("GET", "/api/playlists");
  const base = r.body.find((p: any) => p.id === pid).version;
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      call("PUT", `/api/playlists/${pid}`, { name: `racer-${i}` }, { "If-Match": String(base) }),
    ),
  );
  const wins = results.filter((x) => x.status === 200).length;
  const conflicts = results.filter((x) => x.status === 409).length;
  check("of 10 racing conditional writes, exactly one wins", wins === 1, `${wins} won`);
  check("the other nine get 409", conflicts === 9, `${conflicts} conflicted`);
  r = await call("GET", "/api/playlists");
  check("the version advanced by exactly one", r.body.find((p: any) => p.id === pid).version === base + 1, `version ${r.body.find((p: any) => p.id === pid).version}`);
} finally {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1000));
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
