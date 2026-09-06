// ── OpenAPI 3.1 description of the m3ugoat HTTP API ─────────────────────────
//
// This is the contract client devices code against. It is authored here as a
// plain object rather than a .yaml file for three reasons: the repo has no YAML
// parser and this avoids adding one, `tsc` catches structural typos, and
// scripts/verify-openapi.ts can import it directly to cross-check the declared
// paths against the routes server.ts actually registers — so the spec cannot
// quietly drift from the implementation.
//
// Served at GET /api/openapi.json (unauthenticated, so a client author can read
// it before having credentials). `npm run openapi:write` also emits
// openapi.json for external tooling.

const VERSION = "1.0.0";

// ── Reusable pieces ─────────────────────────────────────────────────────────

const timestamps = {
  createdAt: { type: "integer", format: "int64", description: "Unix epoch milliseconds." },
  updatedAt: { type: "integer", format: "int64", description: "Unix epoch milliseconds." },
} as const;

const versionProp = {
  type: "integer",
  minimum: 1,
  description:
    "Incremented on every write. Send it back as `If-Match` on the next write to detect a lost update. Also returned as the `ETag` on single-resource writes.",
} as const;

/** `$ref` shorthand. */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errRef = (name: string) => ({ $ref: `#/components/responses/${name}` });

const jsonBody = (schema: unknown, required = true) => ({
  required,
  content: { "application/json": { schema } },
});

const jsonResponse = (description: string, schema: unknown) => ({
  description,
  content: { "application/json": { schema } },
});

/** A single-resource response that carries a version, hence an ETag. */
const versionedResponse = (description: string, schema: unknown) => ({
  description,
  headers: {
    ETag: {
      description: "The resource's new version, quoted. Pass as `If-Match` on the next write.",
      schema: { type: "string", examples: ['"4"'] },
    },
  },
  content: { "application/json": { schema } },
});

const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});

const ifMatchParam = {
  name: "If-Match",
  in: "header",
  required: false,
  schema: { type: "string" },
  description:
    "The `version` this client last read. Omit for last-write-wins. Accepts `3`, `\"3\"` or `W/\"3\"`; `*` means no precondition. A stale value returns 409, a malformed one 400.",
} as const;

/**
 * Optional per-item preconditions for the bulk routes. A single If-Match cannot
 * express a precondition over many rows with independent versions, so these
 * take a map instead and skip-and-report rather than refusing the batch.
 */
const versionsProp = {
  type: "object",
  additionalProperties: { type: "integer", minimum: 1 },
  description:
    "Optional map of channel id to the `version` you last read. Items whose version has moved on are skipped and listed in `conflicts`; the rest still apply. Omit for last-write-wins.",
} as const;

const bulkConflictSchema = {
  type: "object",
  required: ["id", "expected", "current"],
  properties: {
    id: { type: "string" },
    expected: { type: "integer", description: "The version you sent." },
    current: { type: ["integer", "null"], description: "The version now stored, or null if the row is gone." },
  },
} as const;

// Routes that mutate a single resource share this set of failure modes.
const conditionalErrors = {
  "400": errRef("BadIfMatch"),
  "401": errRef("Unauthorized"),
  "404": errRef("NotFound"),
  "409": errRef("Conflict"),
};

/**
 * Stable operation ids, kept in one table rather than scattered inline so they
 * are easy to review as a set — generated clients turn these into method names,
 * so they should read well and never change once published.
 *
 * applyOperationIds() throws if an operation has no entry here, or if this table
 * names one that does not exist, so adding a route without naming it is a build
 * failure rather than a silently unnamed client method.
 */
const OPERATION_IDS: Record<string, string> = {
  "get /api/auth/status": "getAuthStatus",
  "post /api/auth/login": "login",
  "post /api/auth/logout": "logout",
  "get /api/auth/me": "getCurrentUser",
  "post /api/auth/set-password": "setPassword",
  "post /api/auth/recover": "recoverPassword",
  "post /api/auth/remove-password": "removePassword",
  "get /api/auth/devices": "listDevices",
  "delete /api/auth/devices/{id}": "revokeDevice",
  "get /api/users": "listUsers",
  "post /api/users": "createUser",
  "delete /api/users/{id}": "deleteUser",
  "get /api/playlists": "listPlaylists",
  "post /api/playlists": "createPlaylist",
  "post /api/playlists/import": "importPlaylist",
  "put /api/playlists/{playlistId}": "updatePlaylist",
  "delete /api/playlists/{playlistId}": "deletePlaylist",
  "post /api/playlists/{playlistId}/rotate-export-token": "rotateExportToken",
  "get /api/playlists/{playlistId}/channels": "listChannels",
  "post /api/playlists/{playlistId}/channels/bulk": "addChannels",
  "put /api/playlists/{playlistId}/channels/{channelId}": "updateChannel",
  "delete /api/playlists/{playlistId}/channels/{channelId}": "deleteChannel",
  "post /api/playlists/{playlistId}/channels/bulk-update": "bulkUpdateChannels",
  "post /api/playlists/{playlistId}/channels/bulk-update-many": "bulkUpdateChannelsIndividually",
  "post /api/playlists/{playlistId}/channels/bulk-replace": "bulkReplaceChannelField",
  "post /api/playlists/{playlistId}/channels/bulk-delete": "bulkDeleteChannels",
  "post /api/playlists/{playlistId}/channels/reorder": "reorderChannels",
  "get /api/playlists/{exportId}.m3u": "exportPlaylistLegacy",
  "get /api/epg-sources": "listEpgSources",
  "post /api/epg-sources": "createEpgSource",
  "put /api/epg-sources/{id}": "updateEpgSource",
  "delete /api/epg-sources/{id}": "deleteEpgSource",
  "post /api/epg-sources/{id}/refresh": "refreshEpgSource",
  "get /api/epg-sources/{id}/channels": "searchEpgChannels",
  "get /api/epg-sources/{id}/programs/{channelId}": "listEpgProgrammes",
  "get /api/epg-sources/{id}/now": "getEpgNow",
  "get /api/epg/tvg-ids": "searchTvgIds",
  "post /api/epg/resolve-tvg-ids": "resolveTvgIds",
  "get /api/channel-pool/sources": "listChannelPoolSources",
  "post /api/channel-pool/sources": "createChannelPoolSource",
  "post /api/channel-pool/sources/upload": "uploadChannelPoolSource",
  "put /api/channel-pool/sources/{id}": "updateChannelPoolSource",
  "delete /api/channel-pool/sources/{id}": "deleteChannelPoolSource",
  "post /api/channel-pool/sources/{id}/refresh": "refreshChannelPoolSource",
  "get /api/channel-pool/sources/{id}/channels": "listChannelPoolEntries",
  "get /api/channel-pool/sources/{id}/categories": "listChannelPoolCategories",
  "post /api/channel-pool/validate-url": "validatePlaylistUrl",
  "get /api/channel-pool/changelog": "getChannelPoolChangelog",
  "get /api/version": "getVersion",
  "get /api/search": "search",
  "post /api/health-check": "checkStreamHealth",
  "get /api/proxy": "proxyFetch",
  "get /api/openapi.json": "getOpenApiDocument",
  "get /e/{token}": "exportPlaylistM3u",
  "get /e/{token}/epg": "exportPlaylistEpg",
  "get /{shortId}": "exportPlaylistM3uByShortId",
  "get /{shortId}/epg": "exportPlaylistEpgByShortId",
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Injects operationId into every operation, failing loudly on any mismatch. */
function applyOperationIds<T>(doc: T): T {
  const paths = (doc as any).paths as Record<string, any>;
  const used = new Set<string>();
  for (const [route, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const key = `${method} ${route}`;
      const id = OPERATION_IDS[key];
      if (!id) throw new Error(`openapi.ts: no operationId defined for "${key}"`);
      if (used.has(id)) throw new Error(`openapi.ts: duplicate operationId "${id}"`);
      used.add(id);
      op.operationId = id;
    }
  }
  const unusedIds = Object.keys(OPERATION_IDS).filter((k) => {
    const idx = k.indexOf(" ");
    const [method, route] = [k.slice(0, idx), k.slice(idx + 1)];
    return !paths[route]?.[method];
  });
  if (unusedIds.length) {
    throw new Error(`openapi.ts: operationId defined for missing route(s): ${unusedIds.join(", ")}`);
  }
  return doc;
}

const document = {
  openapi: "3.1.0",
  info: {
    title: "m3ugoat API",
    version: VERSION,
    summary: "Self-hosted, local-network IPTV playlist manager and multi-device sync API. A fork of m3u4me.",
    description: [
      "## Authentication",
      "",
      "Every `/api/*` route requires `Authorization: Bearer <token>` except `/api/auth/status`,",
      "`/api/auth/login` and `/api/auth/recover`.",
      "",
      "**If no account exists, authentication is disabled entirely** and every route is open —",
      "this is the default for a fresh single-user install. Call `GET /api/auth/status` first:",
      "`enabled: false` means no token is needed. Create the first account with",
      "`POST /api/auth/set-password`.",
      "",
      "Obtain a token with `POST /api/auth/login`. Tokens are per-device, survive a server",
      "restart, and can be revoked individually via `DELETE /api/auth/devices/{id}`. Pass a",
      "`deviceName` at login so the device is identifiable in that list.",
      "",
      "`username` is optional on login while exactly one account exists, and required once a",
      "second is created.",
      "",
      "## Data isolation",
      "",
      "Every resource belongs to one account. Requests only ever see and modify their own",
      "account's data. Referencing another account's id returns **404, not 403**, so a probe",
      "cannot confirm that the id exists.",
      "",
      "## Optimistic concurrency",
      "",
      "Mutable resources carry a `version`, returned on reads and as an `ETag` on writes.",
      "",
      "1. Read the resource and keep its `version`.",
      "2. Send it as `If-Match` on your next write.",
      "3. On **409**, the response body contains `currentVersion` and the full `current` server",
      "   state — merge from that and retry. No extra round trip is needed.",
      "",
      "`If-Match` is optional (RFC 9110 treats a missing precondition as no precondition), but",
      "a syncing client SHOULD always send it. Without it, the last write wins.",
      "",
      "**The bulk routes take no `If-Match`** — a single precondition cannot express one over",
      "many rows with independent versions. They accept a `versions` map instead (or a",
      "per-entry `version` on `bulk-update-many`). Items whose version has moved on are",
      "**skipped and returned in `conflicts`**, while the rest still apply — failing a whole",
      "batch because one row changed would be hostile, and a sync client needs to know which",
      "items to re-merge. Omit `versions` for last-write-wins.",
      "",
      "## Public export URLs",
      "",
      "IPTV players and EPG grabbers cannot send an `Authorization` header, so playlist export",
      "lives outside `/api` and is authorised by the playlist's unguessable `exportToken`:",
      "`GET /e/{token}` and `GET /e/{token}/epg`. Rotate the token to invalidate a leaked link.",
      "",
      "The older numeric URLs (`GET /{shortId}`) are **disabled by default and return 410**,",
      "because `shortId` is a small incrementing integer and those routes are unauthenticated —",
      "they would let anyone on the network enumerate every account's playlists, including",
      "stream URLs, which in IPTV routinely embed provider credentials.",
    ].join("\n"),
    license: { name: "GPL-3.0", identifier: "GPL-3.0-only" },
  },

  servers: [
    { url: "http://localhost:8080", description: "Local install (default port)." },
    { url: "http://{host}:{port}", description: "Any install on the local network.", variables: { host: { default: "192.168.1.10" }, port: { default: "8080" } } },
  ],

  tags: [
    { name: "Auth", description: "Accounts, tokens and devices." },
    { name: "Users", description: "Account administration. Admin only." },
    { name: "Playlists", description: "Playlists and their channels." },
    { name: "EPG", description: "XMLTV / Xtream programme-guide sources." },
    { name: "Channel pool", description: "Bulk sources to cherry-pick channels from." },
    { name: "Export", description: "Unauthenticated, token-authorised playlist export." },
    { name: "Utility", description: "Search, health checks, version, proxy." },
  ],

  security: [{ bearerAuth: [] }],

  paths: {
    // ── Auth ──────────────────────────────────────────────────────────────
    "/api/auth/status": {
      get: {
        tags: ["Auth"],
        summary: "Whether authentication is required",
        description: "Call this first. `enabled: false` means no account exists and the API is open.",
        security: [],
        responses: {
          "200": jsonResponse("Auth state.", {
            type: "object",
            required: ["enabled", "userCount", "multiUser"],
            properties: {
              enabled: { type: "boolean", description: "True if at least one account exists." },
              userCount: { type: "integer" },
              multiUser: { type: "boolean", description: "True if `username` is required at login." },
            },
          }),
        },
      },
    },

    "/api/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Exchange a password for a device token",
        security: [],
        requestBody: jsonBody({
          type: "object",
          required: ["password"],
          properties: {
            password: { type: "string" },
            username: { type: "string", description: "Optional while one account exists; required once there are two." },
            deviceName: { type: "string", maxLength: 100, description: "Shown in the device list. Strongly recommended." },
          },
        }),
        responses: {
          "200": jsonResponse("A token, or `token: null` if auth is disabled.", {
            type: "object",
            properties: {
              token: { type: ["string", "null"] },
              message: { type: "string" },
              user: ref("UserSummary"),
              device: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
            },
          }),
          "400": errRef("BadRequest"),
          "401": jsonResponse("Wrong username or password. The message does not distinguish the two.", ref("Error")),
        },
      },
    },

    "/api/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Revoke the presenting token",
        description: "Durable: the token stays dead across a server restart.",
        responses: { "200": jsonResponse("Revoked.", ref("Success")), "401": errRef("Unauthorized") },
      },
    },

    "/api/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Identify the caller",
        responses: {
          "200": jsonResponse("The calling account and device, or `authDisabled` when no account exists.", {
            type: "object",
            properties: {
              user: { oneOf: [ref("UserSummary"), { type: "null" }] },
              device: { type: ["object", "null"], properties: { id: { type: "string" }, name: { type: "string" } } },
              authDisabled: { type: "boolean" },
            },
          }),
          "401": errRef("Unauthorized"),
        },
      },
    },

    "/api/auth/set-password": {
      post: {
        tags: ["Auth"],
        summary: "Create the first account, or change your own password",
        description: [
          "With no account yet this bootstraps an **admin** account and needs no token.",
          "Otherwise it changes the calling account's password and requires `currentPassword`.",
          "",
          "Changing a password revokes this account's other device tokens; the calling device is",
          "re-issued a token, returned as `token`. The `recoveryKey` is shown **once** and is not",
          "recoverable afterwards.",
        ].join("\n"),
        security: [],
        requestBody: jsonBody({
          type: "object",
          required: ["password"],
          properties: {
            password: { type: "string", minLength: 4 },
            currentPassword: { type: "string", description: "Required unless this is the first account." },
            username: { type: "string", description: "First account only. Defaults to `admin`." },
          },
        }),
        responses: {
          "200": jsonResponse("Password set.", {
            type: "object",
            required: ["recoveryKey"],
            properties: {
              recoveryKey: { type: "string", description: "Shown once. Format `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`." },
              username: { type: "string" },
              token: { type: "string", description: "Replacement token for the calling device." },
            },
          }),
          "400": errRef("BadRequest"),
          "401": errRef("Unauthorized"),
        },
      },
    },

    "/api/auth/recover": {
      post: {
        tags: ["Auth"],
        summary: "Reset a password using its recovery key",
        description: "Revokes every device token for the account and issues a new recovery key.",
        security: [],
        requestBody: jsonBody({
          type: "object",
          required: ["recoveryKey", "newPassword"],
          properties: {
            recoveryKey: { type: "string", description: "Dashes optional, case-insensitive." },
            newPassword: { type: "string", minLength: 4 },
            username: { type: "string", description: "Optional while one account exists." },
            deviceName: { type: "string" },
          },
        }),
        responses: {
          "200": jsonResponse("Reset. Contains a new token and a new recovery key.", {
            type: "object",
            properties: { token: { type: "string" }, recoveryKey: { type: "string" } },
          }),
          "400": errRef("BadRequest"),
          "401": jsonResponse("Invalid recovery key.", ref("Error")),
        },
      },
    },

    "/api/auth/remove-password": {
      post: {
        tags: ["Auth"],
        summary: "Disable authentication by deleting the only account",
        description:
          "Refused with **409** while more than one account exists — dropping auth would expose every account's data to anyone on the network. Delete the others first.",
        requestBody: jsonBody({ type: "object", required: ["currentPassword"], properties: { currentPassword: { type: "string" } } }),
        responses: {
          "200": jsonResponse("Authentication disabled.", ref("Success")),
          "400": errRef("BadRequest"),
          "401": errRef("Unauthorized"),
          "409": jsonResponse("More than one account exists.", ref("Error")),
        },
      },
    },

    "/api/auth/devices": {
      get: {
        tags: ["Auth"],
        summary: "List this account's signed-in devices",
        responses: {
          "200": jsonResponse("Devices, most recently seen first.", { type: "array", items: ref("Device") }),
          "401": errRef("Unauthorized"),
        },
      },
    },

    "/api/auth/devices/{id}": {
      delete: {
        tags: ["Auth"],
        summary: "Revoke one device",
        description: "How a lost phone or TV box is signed out remotely. Takes effect immediately.",
        parameters: [pathParam("id", "Device id from `GET /api/auth/devices`.")],
        responses: {
          "200": jsonResponse("Revoked.", ref("Success")),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    // ── Users ─────────────────────────────────────────────────────────────
    "/api/users": {
      get: {
        tags: ["Users"],
        summary: "List accounts",
        description: "Admin only.",
        responses: {
          "200": jsonResponse("Accounts.", { type: "array", items: ref("UserListEntry") }),
          "401": errRef("Unauthorized"),
          "403": errRef("Forbidden"),
        },
      },
      post: {
        tags: ["Users"],
        summary: "Create an account",
        description: "Admin only. The `recoveryKey` is shown once.",
        requestBody: jsonBody({
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string" },
            password: { type: "string", minLength: 4 },
            isAdmin: { type: "boolean", default: false },
          },
        }),
        responses: {
          "200": jsonResponse("Created.", {
            type: "object",
            properties: { user: ref("UserSummary"), recoveryKey: { type: "string" } },
          }),
          "400": errRef("BadRequest"),
          "401": errRef("Unauthorized"),
          "403": errRef("Forbidden"),
          "409": jsonResponse("That username is taken.", ref("Error")),
        },
      },
    },

    "/api/users/{id}": {
      delete: {
        tags: ["Users"],
        summary: "Delete an account",
        description:
          "Admin only. Revokes that account's device tokens. **Its playlists are left in place**, not deleted or reassigned. You cannot delete the account you are signed in with, nor the last remaining account.",
        parameters: [pathParam("id", "Account id.")],
        responses: {
          "200": jsonResponse("Deleted.", ref("Success")),
          "400": jsonResponse("Refused: that is the calling account.", ref("Error")),
          "401": errRef("Unauthorized"),
          "403": errRef("Forbidden"),
          "404": errRef("NotFound"),
          "409": jsonResponse("Refused: that is the last account.", ref("Error")),
        },
      },
    },

    // ── Playlists ─────────────────────────────────────────────────────────
    "/api/playlists": {
      get: {
        tags: ["Playlists"],
        summary: "List your playlists",
        description: "There is no single-playlist GET; take each `version` from this list.",
        responses: {
          "200": jsonResponse("Your playlists, ordered by `shortId`.", { type: "array", items: ref("Playlist") }),
          "401": errRef("Unauthorized"),
        },
      },
      post: {
        tags: ["Playlists"],
        summary: "Create an empty playlist",
        requestBody: jsonBody({ type: "object", properties: { name: { type: "string", default: "Unnamed Playlist" } } }, false),
        responses: { "200": jsonResponse("Created, with one `General` category.", ref("Playlist")), "401": errRef("Unauthorized") },
      },
    },

    "/api/playlists/import": {
      post: {
        tags: ["Playlists"],
        summary: "Create a playlist from an M3U or XSPF source",
        description:
          "Give either `url` or `content`. A source that looks like a raw stream rather than a channel list is rejected with a warning; resend with `confirmWarning: true` to accept it anyway.",
        requestBody: jsonBody({
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            url: { type: "string", format: "uri" },
            content: { type: "string", description: "Raw M3U or XSPF text." },
            confirmWarning: { type: "boolean", default: false },
          },
        }),
        responses: {
          "200": jsonResponse("Created, pre-populated with the source's channels.", ref("Playlist")),
          "400": jsonResponse("Missing name/source, no channels found, or an unconfirmed warning.", ref("Error")),
          "401": errRef("Unauthorized"),
        },
      },
    },

    "/api/playlists/{playlistId}": {
      put: {
        tags: ["Playlists"],
        summary: "Update a playlist",
        description: "Supports `If-Match`. Renaming and reordering categories both go through here.",
        parameters: [pathParam("playlistId", "Playlist id."), ifMatchParam],
        requestBody: jsonBody({
          type: "object",
          properties: {
            name: { type: "string" },
            categories: {
              type: "array",
              items: { type: "string" },
              description: "Order is significant — it drives display order. Duplicates are rejected with 400.",
            },
          },
        }),
        responses: { "200": versionedResponse("Updated.", ref("Playlist")), ...conditionalErrors },
      },
      delete: {
        tags: ["Playlists"],
        summary: "Delete a playlist and all its channels",
        parameters: [pathParam("playlistId", "Playlist id."), ifMatchParam],
        responses: { "200": jsonResponse("Deleted.", ref("Success")), ...conditionalErrors },
      },
    },

    "/api/playlists/{playlistId}/rotate-export-token": {
      post: {
        tags: ["Playlists"],
        summary: "Issue a new export token",
        description: "Immediately invalidates the previous `/e/{token}` link. Use this if a link leaks.",
        parameters: [pathParam("playlistId", "Playlist id.")],
        responses: {
          "200": jsonResponse("Rotated.", { type: "object", required: ["exportToken"], properties: { exportToken: { type: "string" } } }),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/playlists/{playlistId}/channels": {
      get: {
        tags: ["Playlists"],
        summary: "List a playlist's channels",
        description: "Ordered by `order`. Take each channel's `version` from here.",
        parameters: [pathParam("playlistId", "Playlist id.")],
        responses: {
          "200": jsonResponse("Channels.", { type: "array", items: ref("Channel") }),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/playlists/{playlistId}/channels/bulk": {
      post: {
        tags: ["Playlists"],
        summary: "Append channels",
        description:
          "Appends after the current highest `order`. Any category not already on the playlist is appended to its category list. No `If-Match`.",
        parameters: [pathParam("playlistId", "Playlist id.")],
        requestBody: jsonBody({
          type: "object",
          required: ["channels"],
          properties: { channels: { type: "array", items: ref("ChannelInput") } },
        }),
        responses: {
          "200": jsonResponse("Added.", {
            type: "object",
            properties: {
              success: { type: "boolean" },
              added: { type: "integer" },
              ids: { type: "array", items: { type: "string" } },
            },
          }),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/playlists/{playlistId}/channels/{channelId}": {
      put: {
        tags: ["Playlists"],
        summary: "Update one channel",
        description: "Supports `If-Match`.",
        parameters: [pathParam("playlistId", "Playlist id."), pathParam("channelId", "Channel id."), ifMatchParam],
        requestBody: jsonBody(ref("ChannelInput")),
        responses: { "200": versionedResponse("Updated.", ref("Channel")), ...conditionalErrors },
      },
      delete: {
        tags: ["Playlists"],
        summary: "Delete one channel",
        parameters: [pathParam("playlistId", "Playlist id."), pathParam("channelId", "Channel id."), ifMatchParam],
        responses: { "200": jsonResponse("Deleted.", ref("Success")), ...conditionalErrors },
      },
    },

    "/api/playlists/{playlistId}/channels/bulk-update": {
      post: {
        tags: ["Playlists"],
        summary: "Apply the same changes to many channels",
        description:
          "Takes no `If-Match` — a single precondition is meaningless across many rows. Pass `versions` for per-item preconditions instead.",
        parameters: [pathParam("playlistId", "Playlist id.")],
        requestBody: jsonBody({
          type: "object",
          required: ["ids", "updates"],
          properties: {
            ids: { type: "array", items: { type: "string" } },
            updates: ref("ChannelInput"),
            versions: versionsProp,
          },
        }),
        responses: {
          "200": jsonResponse("Applied. `conflicts` lists items skipped because their version had moved.", ref("BulkResult")),
          "400": jsonResponse("Malformed `versions`.", ref("Error")),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/playlists/{playlistId}/channels/bulk-update-many": {
      post: {
        tags: ["Playlists"],
        summary: "Apply per-channel changes",
        description:
          "Each entry may carry its own `version` — the natural place for it, since the payload is already per-channel. Entries whose version has moved on are skipped and listed in `conflicts`.",
        parameters: [pathParam("playlistId", "Playlist id.")],
        requestBody: jsonBody({
          type: "object",
          required: ["updates"],
          properties: {
            updates: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "changes"],
                properties: {
                  id: { type: "string" },
                  changes: ref("ChannelInput"),
                  version: { type: "integer", minimum: 1, description: "Optional precondition for this entry." },
                },
              },
            },
          },
        }),
        responses: {
          "200": jsonResponse("Applied. `conflicts` lists skipped entries.", ref("BulkResult")),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/playlists/{playlistId}/channels/bulk-replace": {
      post: {
        tags: ["Playlists"],
        summary: "Find and replace across one field",
        description: "Takes no `If-Match`. Pass `versions` for per-item preconditions.",
        parameters: [pathParam("playlistId", "Playlist id.")],
        requestBody: jsonBody({
          type: "object",
          required: ["search"],
          properties: {
            search: { type: "string" },
            replace: { type: "string", default: "" },
            field: { type: "string", default: "url", description: "Which channel field to rewrite." },
            ids: { type: "array", items: { type: "string" }, description: "Restrict to these channels. Omit for the whole playlist." },
            versions: versionsProp,
          },
        }),
        responses: {
          "200": jsonResponse("Applied. `conflicts` lists skipped items.", {
            type: "object",
            properties: {
              success: { type: "boolean" },
              modified: { type: "integer" },
              conflicts: { type: "array", items: ref("BulkConflict") },
            },
          }),
          "400": errRef("BadRequest"),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/playlists/{playlistId}/channels/bulk-delete": {
      post: {
        tags: ["Playlists"],
        summary: "Delete many channels",
        description: "Takes no `If-Match`. Pass `versions` for per-item preconditions.",
        parameters: [pathParam("playlistId", "Playlist id.")],
        requestBody: jsonBody({
          type: "object",
          required: ["ids"],
          properties: { ids: { type: "array", items: { type: "string" } }, versions: versionsProp },
        }),
        responses: {
          "200": jsonResponse("Deleted. `conflicts` lists items skipped because their version had moved.", ref("BulkResult")),
          "400": jsonResponse("Malformed `versions`.", ref("Error")),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/playlists/{playlistId}/channels/reorder": {
      post: {
        tags: ["Playlists"],
        summary: "Set channel order",
        description:
          "Applied in one transaction, so a reorder cannot half-apply. Takes no `If-Match`; pass `versions` for per-item preconditions.",
        parameters: [pathParam("playlistId", "Playlist id.")],
        requestBody: jsonBody({
          type: "object",
          required: ["orders"],
          properties: {
            orders: { type: "object", additionalProperties: { type: "integer" }, description: "Map of channel id to new `order`." },
            versions: versionsProp,
          },
        }),
        responses: {
          "200": jsonResponse("Reordered. `conflicts` lists skipped channels.", ref("BulkResult")),
          "400": jsonResponse("Malformed `versions`.", ref("Error")),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/playlists/{exportId}.m3u": {
      get: {
        tags: ["Export"],
        summary: "Legacy long-form M3U export",
        description:
          "Kept for links generated before export tokens existed. Being under `/api`, it needs a bearer token, so IPTV players cannot use it — prefer `GET /e/{token}`.",
        parameters: [pathParam("exportId", "The playlist's `exportId` UUID.")],
        responses: {
          "200": { description: "The playlist as M3U.", content: { "audio/x-mpegurl": { schema: { type: "string" } } } },
          "401": errRef("Unauthorized"),
          "404": { description: "No such playlist." },
        },
      },
    },

    // ── EPG ───────────────────────────────────────────────────────────────
    "/api/epg-sources": {
      get: {
        tags: ["EPG"],
        summary: "List your EPG sources",
        responses: { "200": jsonResponse("Sources.", { type: "array", items: ref("EpgSource") }), "401": errRef("Unauthorized") },
      },
      post: {
        tags: ["EPG"],
        summary: "Add an EPG source",
        description: "Fetched and parsed immediately; the response reflects the first refresh. Gzipped XMLTV is detected automatically.",
        requestBody: jsonBody(ref("EpgSourceInput")),
        responses: { "200": jsonResponse("Created.", ref("EpgSource")), "401": errRef("Unauthorized") },
      },
    },

    "/api/epg-sources/{id}": {
      put: {
        tags: ["EPG"],
        summary: "Update an EPG source",
        description: "Supports `If-Match`.",
        parameters: [pathParam("id", "Source id."), ifMatchParam],
        requestBody: jsonBody(ref("EpgSourceInput")),
        responses: { "200": versionedResponse("Updated.", ref("EpgSource")), ...conditionalErrors },
      },
      delete: {
        tags: ["EPG"],
        summary: "Delete an EPG source",
        parameters: [pathParam("id", "Source id."), ifMatchParam],
        responses: { "200": jsonResponse("Deleted.", ref("Success")), ...conditionalErrors },
      },
    },

    "/api/epg-sources/{id}/refresh": {
      post: {
        tags: ["EPG"],
        summary: "Re-fetch an EPG source now",
        parameters: [pathParam("id", "Source id.")],
        responses: { "200": jsonResponse("Refreshed.", ref("Success")), "401": errRef("Unauthorized"), "404": errRef("NotFound") },
      },
    },

    "/api/epg-sources/{id}/channels": {
      get: {
        tags: ["EPG"],
        summary: "Search a source's EPG channels",
        description: "Parsed guide data is held in memory only and rebuilt on restart, so this can be empty right after a boot.",
        parameters: [
          pathParam("id", "Source id."),
          { name: "q", in: "query", required: false, schema: { type: "string" }, description: "Substring match on id or display name." },
        ],
        responses: {
          "200": jsonResponse("Matching channels.", { type: "array", items: ref("EpgChannel") }),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/epg-sources/{id}/programs/{channelId}": {
      get: {
        tags: ["EPG"],
        summary: "Programmes for one EPG channel",
        parameters: [pathParam("id", "Source id."), pathParam("channelId", "EPG channel id (tvg-id).")],
        responses: {
          "200": jsonResponse("Programmes.", { type: "array", items: ref("EpgProgramme") }),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/epg-sources/{id}/now": {
      get: {
        tags: ["EPG"],
        summary: "What is on now, for the guide grid",
        parameters: [pathParam("id", "Source id.")],
        responses: { "200": jsonResponse("Current and upcoming programmes per channel.", { type: "object" }), "401": errRef("Unauthorized"), "404": errRef("NotFound") },
      },
    },

    "/api/epg/tvg-ids": {
      get: {
        tags: ["EPG"],
        summary: "Autocomplete tvg-ids across your sources",
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" }, description: "Substring to match. Capped at 50 results." }],
        responses: { "200": jsonResponse("Matches.", { type: "array", items: ref("EpgChannel") }), "401": errRef("Unauthorized") },
      },
    },

    "/api/epg/resolve-tvg-ids": {
      post: {
        tags: ["EPG"],
        summary: "Resolve tvg-ids to display names",
        requestBody: jsonBody({ type: "object", required: ["ids"], properties: { ids: { type: "array", items: { type: "string" } } } }),
        responses: {
          "200": jsonResponse("Map of tvg-id to display and source name. Unknown ids are omitted.", {
            type: "object",
            additionalProperties: { type: "object", properties: { displayName: { type: "string" }, sourceName: { type: "string" } } },
          }),
          "401": errRef("Unauthorized"),
        },
      },
    },

    // ── Channel pool ──────────────────────────────────────────────────────
    "/api/channel-pool/sources": {
      get: {
        tags: ["Channel pool"],
        summary: "List your channel-pool sources",
        responses: { "200": jsonResponse("Sources.", { type: "array", items: ref("ChannelPoolSource") }), "401": errRef("Unauthorized") },
      },
      post: {
        tags: ["Channel pool"],
        summary: "Add a channel-pool source",
        description: "Fetched immediately unless `type` is `playlist-file` (use the upload route for those).",
        requestBody: jsonBody(ref("ChannelPoolSourceInput")),
        responses: { "200": jsonResponse("Created.", ref("ChannelPoolSource")), "401": errRef("Unauthorized") },
      },
    },

    "/api/channel-pool/sources/upload": {
      post: {
        tags: ["Channel pool"],
        summary: "Create a source from uploaded playlist text",
        description: "M3U or XSPF, detected from the content. Sent as JSON, not multipart.",
        requestBody: jsonBody({
          type: "object",
          required: ["name", "content", "filename"],
          properties: { name: { type: "string" }, content: { type: "string" }, filename: { type: "string" } },
        }),
        responses: { "200": jsonResponse("Created.", ref("ChannelPoolSource")), "400": errRef("BadRequest"), "401": errRef("Unauthorized") },
      },
    },

    "/api/channel-pool/sources/{id}": {
      put: {
        tags: ["Channel pool"],
        summary: "Update a channel-pool source",
        description: "Supports `If-Match`.",
        parameters: [pathParam("id", "Source id."), ifMatchParam],
        requestBody: jsonBody(ref("ChannelPoolSourceInput")),
        responses: { "200": versionedResponse("Updated.", ref("ChannelPoolSource")), ...conditionalErrors },
      },
      delete: {
        tags: ["Channel pool"],
        summary: "Delete a channel-pool source",
        description: "Also deletes its entries and changelog.",
        parameters: [pathParam("id", "Source id."), ifMatchParam],
        responses: { "200": jsonResponse("Deleted.", ref("Success")), ...conditionalErrors },
      },
    },

    "/api/channel-pool/sources/{id}/refresh": {
      post: {
        tags: ["Channel pool"],
        summary: "Re-fetch a channel-pool source now",
        description: "Diffs against the stored entries and appends a changelog entry if anything changed.",
        parameters: [pathParam("id", "Source id.")],
        responses: {
          "200": jsonResponse("Refreshed.", {
            type: "object",
            properties: { success: { type: "boolean" }, channelCount: { type: "integer" }, changed: { type: "boolean" } },
          }),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/channel-pool/sources/{id}/channels": {
      get: {
        tags: ["Channel pool"],
        summary: "Browse or search a source's channels",
        parameters: [
          pathParam("id", "Source id."),
          { name: "q", in: "query", required: false, schema: { type: "string" }, description: "Substring match on name or URL." },
          { name: "category", in: "query", required: false, schema: { type: "string" } },
          { name: "sort", in: "query", required: false, schema: { type: "string", enum: ["name", "original"], default: "name" }, description: "`original` keeps the source's own order." },
        ],
        responses: {
          "200": jsonResponse("Entries.", { type: "array", items: ref("ChannelPoolEntry") }),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/channel-pool/sources/{id}/categories": {
      get: {
        tags: ["Channel pool"],
        summary: "Distinct categories in a source",
        parameters: [pathParam("id", "Source id.")],
        responses: {
          "200": jsonResponse("Category names, sorted.", { type: "array", items: { type: "string" } }),
          "401": errRef("Unauthorized"),
          "404": errRef("NotFound"),
        },
      },
    },

    "/api/channel-pool/validate-url": {
      post: {
        tags: ["Channel pool"],
        summary: "Check whether a URL looks like a channel playlist",
        description: "Advisory only. A `warning` means it looks like a raw stream instead.",
        requestBody: jsonBody({ type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } }),
        responses: {
          "200": jsonResponse("Verdict.", { type: "object", properties: { warning: { type: "string" } } }),
          "400": errRef("BadRequest"),
          "401": errRef("Unauthorized"),
        },
      },
    },

    "/api/channel-pool/changelog": {
      get: {
        tags: ["Channel pool"],
        summary: "Added/removed/renamed history for your sources",
        description: "Pruned to the last 90 days. 20 entries per page.",
        parameters: [{ name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } }],
        responses: {
          "200": jsonResponse("One page of changelog entries.", {
            type: "object",
            properties: {
              logs: { type: "array", items: ref("ChannelPoolChangeLog") },
              total: { type: "integer" },
              hasMore: { type: "boolean" },
            },
          }),
          "401": errRef("Unauthorized"),
        },
      },
    },

    // ── Utility ───────────────────────────────────────────────────────────
    "/api/version": {
      get: {
        tags: ["Utility"],
        summary: "Server version",
        responses: { "200": jsonResponse("Version from package.json.", { type: "object", properties: { version: { type: "string" } } }), "401": errRef("Unauthorized") },
      },
    },

    "/api/search": {
      get: {
        tags: ["Utility"],
        summary: "Search your playlists, pool entries and EPG channels",
        description: "Scoped to your own data. Capped at 50 results per kind.",
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": jsonResponse("Mixed results, discriminated by `kind`.", { type: "array", items: ref("SearchResult") }), "401": errRef("Unauthorized") },
      },
    },

    "/api/health-check": {
      post: {
        tags: ["Utility"],
        summary: "Check whether stream URLs respond",
        description: "Tries HEAD, falls back to GET. Network-bound, so send modest batches.",
        requestBody: jsonBody({
          type: "object",
          required: ["channels"],
          properties: {
            channels: {
              type: "array",
              items: { type: "object", required: ["id", "url"], properties: { id: { type: "string" }, url: { type: "string" } } },
            },
          },
        }),
        responses: {
          "200": jsonResponse("One result per channel.", { type: "array", items: ref("HealthCheckResult") }),
          "400": errRef("BadRequest"),
          "401": errRef("Unauthorized"),
        },
      },
    },

    "/api/proxy": {
      get: {
        tags: ["Utility"],
        summary: "Fetch an external playlist URL server-side",
        description: "Exists so the browser UI can sidestep CORS when importing.",
        parameters: [{ name: "url", in: "query", required: true, schema: { type: "string", format: "uri" } }],
        responses: {
          "200": { description: "The fetched body.", content: { "text/plain": { schema: { type: "string" } } } },
          "400": errRef("BadRequest"),
          "401": errRef("Unauthorized"),
        },
      },
    },

    "/api/openapi.json": {
      get: {
        tags: ["Utility"],
        summary: "This document",
        security: [],
        responses: { "200": jsonResponse("The OpenAPI description.", { type: "object" }) },
      },
    },

    // ── Public export ─────────────────────────────────────────────────────
    "/e/{token}": {
      get: {
        tags: ["Export"],
        summary: "The playlist as M3U",
        description:
          "**Unauthenticated** — the token is the credential. This is the URL to give an IPTV player. Hidden channels are omitted; channels are ordered by category then `order`.",
        security: [],
        parameters: [pathParam("token", "The playlist's `exportToken`.")],
        responses: {
          "200": { description: "M3U playlist.", content: { "audio/x-mpegurl": { schema: { type: "string", examples: ["#EXTM3U\n#EXTINF:-1 tvg-id=\"BBCOne.uk\",BBC One\nhttp://example/stream\n"] } } } },
          "404": { description: "No playlist has that token." },
        },
      },
    },

    "/e/{token}/epg": {
      get: {
        tags: ["Export"],
        summary: "XMLTV guide for the playlist",
        description:
          "**Unauthenticated** — the token is the credential. This is the URL to give an EPG grabber. Contains only the owner's EPG sources, filtered to the tvg-ids this playlist actually uses.",
        security: [],
        parameters: [pathParam("token", "The playlist's `exportToken`.")],
        responses: {
          "200": { description: "XMLTV document.", content: { "application/xml": { schema: { type: "string" } } } },
          "404": { description: "No playlist has that token." },
        },
      },
    },

    "/{shortId}": {
      get: {
        tags: ["Export"],
        summary: "Legacy numeric M3U URL (disabled by default)",
        description:
          "Returns **410 Gone** unless the server is started with `ALLOW_INSECURE_SHORT_IDS=1`. `shortId` is a small incrementing integer and this route is unauthenticated, so enabling it lets anyone on the network enumerate every account's playlists. Use `GET /e/{token}` instead.",
        security: [],
        parameters: [
          {
            name: "shortId",
            in: "path",
            required: true,
            schema: { type: "integer", pattern: "^\\d+$" },
            description:
              "Digits only. The server registers these as digit-only regex routes after /e/{token}, so `/e/epg` is not actually ambiguous with `/{shortId}/epg` at runtime — plain path templating just cannot express that, which is why a linter flags the pair.",
          },
        ],
        responses: {
          "200": { description: "M3U playlist (only when explicitly enabled).", content: { "audio/x-mpegurl": { schema: { type: "string" } } } },
          "404": { description: "No playlist has that shortId." },
          "410": { description: "Disabled. Use the token export URL.", content: { "text/plain": { schema: { type: "string" } } } },
        },
      },
    },

    "/{shortId}/epg": {
      get: {
        tags: ["Export"],
        summary: "Legacy numeric XMLTV URL (disabled by default)",
        description: "See `GET /{shortId}`. Returns **410 Gone** unless `ALLOW_INSECURE_SHORT_IDS=1`.",
        security: [],
        parameters: [
          { name: "shortId", in: "path", required: true, schema: { type: "integer", pattern: "^\\d+$" }, description: "Digits only. See `GET /{shortId}`." },
        ],
        responses: {
          "200": { description: "XMLTV document (only when explicitly enabled).", content: { "application/xml": { schema: { type: "string" } } } },
          "404": { description: "No playlist has that shortId." },
          "410": { description: "Disabled. Use the token export URL." },
        },
      },
    },
  },

  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "A device token from `POST /api/auth/login`. Not required at all while no account exists — check `GET /api/auth/status` first.",
      },
    },

    responses: {
      BadRequest: jsonResponse("Malformed request.", ref("Error")),
      BadIfMatch: jsonResponse("`If-Match` was present but not a version number.", ref("Error")),
      Unauthorized: jsonResponse("Missing, invalid or revoked token.", ref("Error")),
      Forbidden: jsonResponse("Authenticated but not permitted (admin-only route).", ref("Error")),
      NotFound: jsonResponse(
        "No such resource — also returned when it belongs to another account, so a probe cannot confirm the id exists.",
        ref("Error"),
      ),
      Conflict: {
        description:
          "The resource changed since the version given in `If-Match`. The body carries the current server state so you can merge and retry.",
        headers: {
          ETag: { description: "The resource's current version.", schema: { type: "string" } },
        },
        content: { "application/json": { schema: ref("ConflictError") } },
      },
    },

    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: { error: { type: "string", description: "Human-readable message. Not a stable machine code." } },
      },

      ConflictError: {
        type: "object",
        required: ["error", "currentVersion", "current"],
        properties: {
          error: { type: "string" },
          currentVersion: { type: "integer", description: "The version now stored. Retry with this as `If-Match`." },
          current: { type: "object", description: "The full current server state, so no re-fetch is needed." },
        },
      },

      Success: { type: "object", properties: { success: { type: "boolean", const: true } } },

      BulkConflict: bulkConflictSchema,

      BulkResult: {
        type: "object",
        description:
          "Result of a bulk write. Non-conflicting items are applied even when others are skipped, so check `conflicts` and re-merge just those.",
        properties: {
          success: { type: "boolean" },
          applied: { type: "integer", description: "Items written." },
          deleted: { type: "integer", description: "Items removed (delete routes only)." },
          conflicts: { type: "array", items: ref("BulkConflict") },
        },
      },

      UserSummary: {
        type: "object",
        properties: { id: { type: "string" }, username: { type: "string" }, isAdmin: { type: "boolean" } },
      },

      UserListEntry: {
        type: "object",
        properties: {
          id: { type: "string" },
          username: { type: "string" },
          isAdmin: { type: "boolean" },
          createdAt: { type: "integer", format: "int64" },
          deviceCount: { type: "integer" },
        },
      },

      Device: {
        type: "object",
        properties: {
          id: { type: "string" },
          userId: { type: "string" },
          name: { type: "string" },
          createdAt: { type: "integer", format: "int64" },
          lastSeenAt: { type: "integer", format: "int64" },
          current: { type: "boolean", description: "True for the device making this request." },
        },
      },

      Playlist: {
        type: "object",
        required: ["id", "name", "userId", "categories", "exportId", "shortId", "exportToken", "version"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          userId: { type: "string", description: "Owning account." },
          categories: {
            type: "array",
            items: { type: "string" },
            description: "Ordered — this drives display order and M3U grouping.",
          },
          exportId: { type: "string", format: "uuid", description: "Legacy export identifier." },
          shortId: { type: "integer", description: "Small display number. Not a secret; not usable for export by default." },
          exportToken: {
            type: "string",
            description: "Secret for `/e/{token}`. Treat as a credential — it grants unauthenticated read of this playlist.",
          },
          version: versionProp,
          ...timestamps,
        },
      },

      Channel: {
        type: "object",
        required: ["id", "playlistId", "name", "url", "category", "order", "version"],
        properties: {
          id: { type: "string", format: "uuid" },
          playlistId: { type: "string", format: "uuid" },
          name: { type: "string" },
          url: { type: "string", description: "Stream URL. Often embeds provider credentials — treat as a secret." },
          logo: { type: ["string", "null"] },
          tvgId: { type: ["string", "null"], description: "Links this channel to an EPG channel id." },
          category: { type: "string" },
          order: { type: "integer", description: "Sort position within the playlist." },
          isHidden: { type: "boolean", description: "Hidden channels are omitted from export." },
          version: versionProp,
          ...timestamps,
        },
      },

      ChannelInput: {
        type: "object",
        description: "Writable channel fields. Omitted fields are left unchanged on update.",
        properties: {
          name: { type: "string" },
          url: { type: "string" },
          logo: { type: ["string", "null"] },
          tvgId: { type: ["string", "null"] },
          category: { type: "string", default: "General" },
          isHidden: { type: "boolean" },
        },
      },

      EpgSource: {
        type: "object",
        required: ["id", "userId", "name", "url", "type", "version"],
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string" },
          name: { type: "string" },
          url: { type: "string", description: "XMLTV URL, or the Xtream panel base URL." },
          type: { type: "string", enum: ["xml", "xtream"] },
          xtreamCredentials: ref("XtreamCredentials"),
          refreshIntervalHours: { type: "integer", default: 12 },
          lastFetched: { type: ["integer", "null"], format: "int64" },
          lastFetchError: { type: ["string", "null"], description: "Set when the last refresh failed; retried every 5 minutes until it succeeds." },
          channelCount: { type: "integer" },
          version: versionProp,
          ...timestamps,
        },
      },

      EpgSourceInput: {
        type: "object",
        required: ["name", "url", "type"],
        properties: {
          name: { type: "string" },
          url: { type: "string" },
          type: { type: "string", enum: ["xml", "xtream"] },
          xtreamCredentials: ref("XtreamCredentials"),
          refreshIntervalHours: { type: "integer", default: 12 },
        },
      },

      ChannelPoolSource: {
        type: "object",
        required: ["id", "userId", "name", "type", "version"],
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["xtream", "playlist-url", "playlist-file"] },
          url: { type: ["string", "null"] },
          xtreamCredentials: ref("XtreamCredentials"),
          refreshIntervalHours: { type: "integer", default: 24 },
          lastFetched: { type: ["integer", "null"], format: "int64" },
          lastFetchError: { type: ["string", "null"] },
          channelCount: { type: "integer" },
          version: versionProp,
          ...timestamps,
        },
      },

      ChannelPoolSourceInput: {
        type: "object",
        required: ["name", "type"],
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["xtream", "playlist-url", "playlist-file"] },
          url: { type: ["string", "null"] },
          xtreamCredentials: ref("XtreamCredentials"),
          refreshIntervalHours: { type: "integer", default: 24 },
        },
      },

      ChannelPoolEntry: {
        type: "object",
        required: ["id", "sourceId", "name", "url", "category"],
        properties: {
          id: { type: "string", format: "uuid" },
          sourceId: { type: "string", format: "uuid" },
          name: { type: "string" },
          url: { type: "string" },
          logo: { type: ["string", "null"] },
          category: { type: "string" },
          tvgId: { type: ["string", "null"] },
        },
      },

      ChannelPoolChangeLog: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          sourceId: { type: "string", format: "uuid" },
          sourceName: { type: "string", description: "Denormalised, so history survives the source being renamed." },
          timestamp: { type: "integer", format: "int64" },
          added: { type: "array", items: ref("ChangeLogChannel") },
          removed: { type: "array", items: ref("ChangeLogChannel") },
          renamed: {
            type: "array",
            items: {
              type: "object",
              properties: { oldName: { type: "string" }, newName: { type: "string" }, category: { type: "string" } },
            },
          },
        },
      },

      ChangeLogChannel: {
        type: "object",
        properties: { name: { type: "string" }, category: { type: "string" } },
      },

      XtreamCredentials: {
        type: "object",
        description: "Xtream Codes login. Write-only in spirit — treat as a secret.",
        required: ["username", "password"],
        properties: { username: { type: "string" }, password: { type: "string", format: "password" } },
      },

      EpgChannel: {
        type: "object",
        properties: {
          id: { type: "string", description: "The tvg-id." },
          displayName: { type: "string" },
          icon: { type: ["string", "null"] },
          sourceId: { type: "string" },
          sourceName: { type: "string" },
        },
      },

      EpgProgramme: {
        type: "object",
        properties: {
          channel: { type: "string", description: "tvg-id this programme belongs to." },
          title: { type: "string" },
          desc: { type: ["string", "null"] },
          start: { type: "string", description: "XMLTV timestamp, e.g. `20260903180000 +0000`." },
          stop: { type: "string" },
          category: { type: ["string", "null"] },
          date: { type: ["string", "null"] },
          episodeNum: { type: ["string", "null"] },
          subTitle: { type: ["string", "null"] },
          icon: { type: ["string", "null"] },
          rating: { type: ["string", "null"] },
        },
      },

      SearchResult: {
        type: "object",
        required: ["kind", "id", "name"],
        properties: {
          kind: { type: "string", enum: ["playlist", "channelPool", "epg"], description: "Which corpus this came from." },
          id: { type: "string" },
          containerId: { type: "string", description: "Playlist id, pool source id, or EPG source id." },
          containerName: { type: "string" },
          name: { type: "string" },
          category: { type: "string" },
          url: { type: "string" },
          tvgId: { type: ["string", "null"] },
          logo: { type: ["string", "null"] },
          isHidden: { type: "boolean" },
        },
      },

      HealthCheckResult: {
        type: "object",
        required: ["id", "ok"],
        properties: {
          id: { type: "string", description: "The channel id you sent." },
          ok: { type: "boolean" },
          code: { type: ["integer", "null"], description: "HTTP status, when one was received." },
          timeout: { type: "boolean" },
          skipped: { type: "boolean", description: "True when the URL was missing or not http(s)." },
        },
      },
    },
  },
};

// Structural clone so the frozen literal above is not mutated in place.
export const openapi = applyOperationIds(JSON.parse(JSON.stringify(document)));

export default openapi;
