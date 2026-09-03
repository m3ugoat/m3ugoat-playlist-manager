// End-to-end check of accounts and device tokens.
//
//   npm run verify:auth
//
// Boots a real server against a throwaway database on a spare port, so the auth
// middleware is exercised over HTTP rather than by poking the store directly.
// Restarts that server midway to prove device tokens survive it.

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const PORT = 8123;
const BASE = `http://localhost:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "m3u4me-auth-"));
const DB = path.join(scratch, "auth-test.db");

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
      M3U4ME_DB_PATH: DB,
      // Keep the real data/db.json and data/auth.json out of this entirely.
      M3U4ME_LEGACY_JSON: path.join(scratch, "no-such-db.json"),
      M3U4ME_LEGACY_AUTH: path.join(scratch, "no-such-auth.json"),
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/status`);
      if (r.ok) return;
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
  try {
    json = await res.json();
  } catch {
    /* some responses have no body */
  }
  return { status: res.status, body: json };
};

try {
  await startServer();

  // ── With no account, the API is wide open (unchanged legacy behaviour) ──
  let r = await call("GET", "/api/auth/status");
  check("status: auth disabled on a fresh database", r.body?.enabled === false, JSON.stringify(r.body));
  r = await call("GET", "/api/playlists");
  check("no account: /api/playlists needs no token", r.status === 200);

  // ── First-run bootstrap ──
  r = await call("POST", "/api/auth/set-password", { password: "hunter2", username: "owner" });
  const recoveryKey: string = r.body?.recoveryKey;
  check("set-password: creates the first account", r.status === 200 && !!recoveryKey);
  check("set-password: returns a formatted recovery key", /^([A-Z0-9]{4}-){5}[A-Z0-9]{4}$/.test(recoveryKey || ""), recoveryKey);

  r = await call("GET", "/api/auth/status");
  check("status: auth now enabled", r.body?.enabled === true && r.body?.userCount === 1);

  // ── The API is now closed ──
  r = await call("GET", "/api/playlists");
  check("no token: /api/playlists is 401", r.status === 401, `got ${r.status}`);
  r = await call("GET", "/api/playlists", undefined, "not-a-real-token");
  check("bogus token: 401", r.status === 401, `got ${r.status}`);

  // ── Login ──
  r = await call("POST", "/api/auth/login", { password: "wrong" });
  check("wrong password: 401", r.status === 401, `got ${r.status}`);

  r = await call("POST", "/api/auth/login", { password: "hunter2", deviceName: "Test Laptop" });
  const token: string = r.body?.token;
  check("login without a username works (single account)", r.status === 200 && !!token);
  check("login reports the user", r.body?.user?.username === "owner" && r.body?.user?.isAdmin === true);

  r = await call("GET", "/api/playlists", undefined, token);
  check("valid token: /api/playlists is 200", r.status === 200, `got ${r.status}`);

  r = await call("GET", "/api/auth/me", undefined, token);
  check("me: identifies the user and device", r.body?.user?.username === "owner" && r.body?.device?.name === "Test Laptop");

  // ── Token hashes only ──
  const dbBytes = fs.readFileSync(DB);
  check("the raw token is NOT stored in the database", !dbBytes.includes(Buffer.from(token)));

  // ── Durability across a restart: the entire point of this phase ──
  await stopServer();
  await startServer();
  r = await call("GET", "/api/playlists", undefined, token);
  check("token still valid AFTER a server restart", r.status === 200, `got ${r.status}`);

  // ── A second device, then remote revocation ──
  r = await call("POST", "/api/auth/login", { password: "hunter2", deviceName: "Test Phone" });
  const phoneToken: string = r.body?.token;
  check("second device can log in", r.status === 200 && !!phoneToken);

  r = await call("GET", "/api/auth/devices", undefined, token);
  check("device list shows both devices", Array.isArray(r.body) && r.body.length === 2, JSON.stringify(r.body?.map?.((d: any) => d.name)));
  check("device list marks the calling device as current", r.body?.some((d: any) => d.current && d.name === "Test Laptop"));

  const phoneId = r.body?.find((d: any) => d.name === "Test Phone")?.id;
  r = await call("DELETE", `/api/auth/devices/${phoneId}`, undefined, token);
  check("revoking the other device succeeds", r.status === 200);
  r = await call("GET", "/api/playlists", undefined, phoneToken);
  check("revoked device is immediately 401", r.status === 401, `got ${r.status}`);
  r = await call("GET", "/api/playlists", undefined, token);
  check("revoking one device leaves the other working", r.status === 200);

  // ── Admin gating ──
  r = await call("POST", "/api/users", { username: "second", password: "sesame1" }, token);
  const secondRecovery = r.body?.recoveryKey;
  check("admin can create a second user", r.status === 200 && !!secondRecovery);

  r = await call("POST", "/api/auth/login", { password: "sesame1" });
  check("username now required (more than one account)", r.status === 400, `got ${r.status}`);

  r = await call("POST", "/api/auth/login", { username: "second", password: "sesame1" });
  const secondToken: string = r.body?.token;
  check("second user can log in with a username", r.status === 200 && !!secondToken);
  check("second user is not an admin", r.body?.user?.isAdmin === false);

  r = await call("GET", "/api/users", undefined, secondToken);
  check("non-admin is 403 on /api/users", r.status === 403, `got ${r.status}`);
  r = await call("GET", "/api/users", undefined, token);
  check("admin can list users", r.status === 200 && r.body?.length === 2);

  // A device list must never leak another account's devices.
  r = await call("GET", "/api/auth/devices", undefined, secondToken);
  check("device list is scoped to the calling account", r.body?.length === 1 && r.body[0].name !== "Test Laptop");

  // ── remove-password is refused while several accounts exist ──
  r = await call("POST", "/api/auth/remove-password", { currentPassword: "hunter2" }, token);
  check("remove-password refused with >1 account", r.status === 409, `got ${r.status}`);

  // ── Recovery rotates the key and logs every device out ──
  r = await call("POST", "/api/auth/recover", {
    username: "owner",
    recoveryKey,
    newPassword: "newpass1",
  });
  const newToken: string = r.body?.token;
  check("recover with the correct key succeeds", r.status === 200 && !!newToken);
  check("recover issues a fresh recovery key", !!r.body?.recoveryKey && r.body.recoveryKey !== recoveryKey);
  r = await call("GET", "/api/playlists", undefined, token);
  check("recovery logs the old device out", r.status === 401, `got ${r.status}`);
  r = await call("GET", "/api/playlists", undefined, newToken);
  check("recovery's new token works", r.status === 200);
  r = await call("POST", "/api/auth/login", { username: "owner", password: "hunter2" });
  check("old password no longer works", r.status === 401, `got ${r.status}`);

  // Recovery must not have touched the other account.
  r = await call("GET", "/api/playlists", undefined, secondToken);
  check("other account's device is unaffected by the recovery", r.status === 200, `got ${r.status}`);

  // ── Logout is durable ──
  r = await call("POST", "/api/auth/logout", undefined, secondToken);
  check("logout succeeds", r.status === 200);
  r = await call("GET", "/api/playlists", undefined, secondToken);
  check("logged-out token is 401", r.status === 401, `got ${r.status}`);
  await stopServer();
  await startServer();
  r = await call("GET", "/api/playlists", undefined, secondToken);
  check("logged-out token stays dead after a restart", r.status === 401, `got ${r.status}`);

  // ── Deleting accounts ──
  const secondId = (await call("GET", "/api/users", undefined, newToken)).body?.find(
    (u: any) => u.username === "second",
  )?.id;
  r = await call("DELETE", `/api/users/${secondId}`, undefined, newToken);
  check("admin can delete the other account", r.status === 200);
  r = await call("POST", "/api/auth/remove-password", { currentPassword: "newpass1" }, newToken);
  check("remove-password now allowed (one account left)", r.status === 200, `got ${r.status}`);
  r = await call("GET", "/api/auth/status");
  check("auth disabled again after removing the last account", r.body?.enabled === false);
  r = await call("GET", "/api/playlists");
  check("API open again with no accounts", r.status === 200);
} finally {
  await stopServer();
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
