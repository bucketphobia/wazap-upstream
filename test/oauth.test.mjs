/**
 * The OAuth flow a hosted agent walks: discover, register, send the person to
 * the consent page, trade the code for tokens, call /mcp. The SDK router is
 * exercised for real over loopback; only WhatsApp is a stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpEndpoint } from "../dist/server.js";
import { WazapOAuthProvider, oauthProblem } from "../dist/oauth.js";
import { draftStub, offlineConfig, stubAccountSource, waitFor } from "./helpers.mjs";

// The SDK refuses a plain-http issuer unless told this is a test.
process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL = "1";

const PASSWORD = "correct horse battery";
const CHAT = "40722123456@s.whatsapp.net";

const stubWa = {
  getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), account_id: "default" }),
};

async function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

/** One server, one provider, torn down by the caller. */
async function boot(
  t,
  {
    password = PASSWORD,
    credentials = [{ token: "static-read", write: false }],
    readOnly = false,
    now,
    trustedProxies,
    wa = stubWa,
  } = {}
) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-oauth-"));
  const port = await freePort();
  const publicUrl = new URL(`http://127.0.0.1:${port}`);
  const oauth = new WazapOAuthProvider({ publicUrl, password, stateFile: join(dataDir, "oauth.json"), now });
  const config = offlineConfig("wazap-oauth-cfg-", { readOnly, transport: "http", dataDir, trustedProxies });
  const stop = new AbortController();
  await startHttpEndpoint(stubAccountSource(wa), config, {
    host: "127.0.0.1",
    port,
    credentials,
    openRead: credentials.length === 0,
    oauth,
    signal: stop.signal,
  });
  t.after(() => {
    stop.abort();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = publicUrl.href.replace(/\/$/, "");
  const fetchJson = async (path, init) => {
    const res = await fetch(`${base}${path}`, { ...init, redirect: "manual" });
    return { res, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  };
  return { base, dataDir, oauth, fetchJson };
}

/** Register a public client and open the consent page, approving nothing yet. */
async function begin(ctx, { scope, clientName = "Poke", authMethod = "none" } = {}) {
  const redirectUri = "https://agent.example/callback";
  const { body: client } = await ctx.fetchJson("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: clientName,
      token_endpoint_auth_method: authMethod,
    }),
  });
  assert.ok(client.client_id, "registration returns a client_id");

  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s-123",
    ...(scope ? { scope } : {}),
  });
  const { res: page, body: html } = await ctx.fetchJson(`/authorize?${query}`);
  assert.equal(page.status, 200);
  const request = /name="request" value="([0-9a-f]+)"/.exec(html)?.[1];
  assert.ok(request, "consent page carries the pending request id");
  return { client, redirectUri, verifier, challenge, html, request, page };
}

function approve(ctx, request, fields) {
  return ctx.fetchJson("/oauth/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ request, ...fields }),
  });
}

/** The approve POST the way a tunnel on this machine forwards it: from loopback, naming the real caller. */
function approveFrom(ctx, address, request, fields) {
  return ctx.fetchJson("/oauth/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": address },
    body: form({ request, ...fields }),
  });
}

/** The whole consent step: what the redirect back to the agent carried. */
async function grant(ctx, { access = "write", password = PASSWORD, ...rest } = {}) {
  const started = await begin(ctx, rest);
  const { res: redirect } = await approve(ctx, started.request, { password, access, decision: "allow" });
  return { ...started, redirect };
}

async function exchange(ctx, { client, redirectUri, verifier, code, resource }) {
  return ctx.fetchJson("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      ...(client.client_secret ? { client_secret: client.client_secret } : {}),
      redirect_uri: redirectUri,
      ...(resource ? { resource } : {}),
    }),
  });
}

/** Register, consent and exchange in one go. */
async function signIn(ctx, options) {
  const g = await grant(ctx, options);
  const code = new URL(g.redirect.headers.get("location")).searchParams.get("code");
  const { body: tokens } = await exchange(ctx, { ...g, code });
  return { ...g, tokens };
}

async function listTools(ctx, token) {
  const init = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  if (init.status !== 200) return { status: init.status };
  const session = init.headers.get("mcp-session-id");
  await init.text();
  const res = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-session-id": session,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const text = await res.text();
  const data =
    text
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5) ?? text;
  const names = JSON.parse(data).result.tools.map((tool) => tool.name);
  return { status: res.status, names };
}

test("OAuth sessions reject other grants and require reinitialization after token rotation", async (t) => {
  const ctx = await boot(t);
  const owner = await signIn(ctx, { access: "write", clientName: "Owner" });
  const other = await signIn(ctx, { access: "write", clientName: "Other" });
  const reader = await signIn(ctx, { access: "read", clientName: "Reader" });
  async function call(token, sid, method = "ping") {
    const res = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...(sid ? { "mcp-session-id": sid } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(method === "initialize"
          ? {
              params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "isolation", version: "1" },
              },
            }
          : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
    await res.text();
    return { status: res.status, sid: res.headers.get("mcp-session-id") };
  }
  const session = await call(owner.tokens.access_token, undefined, "initialize");
  assert.equal(session.status, 200);
  for (const token of [other.tokens.access_token, reader.tokens.access_token, "static-read"]) {
    assert.equal((await call(token, session.sid)).status, 404);
  }
  assert.equal((await call(owner.tokens.access_token, session.sid)).status, 200);
  const { body: rotated, res } = await ctx.fetchJson("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      refresh_token: owner.tokens.refresh_token,
      client_id: owner.client.client_id,
    }),
  });
  assert.equal(res.status, 200);
  assert.equal((await call(rotated.access_token, session.sid)).status, 404);
  const fresh = await call(rotated.access_token, undefined, "initialize");
  assert.equal(fresh.status, 200);
  assert.equal((await call(rotated.access_token, fresh.sid)).status, 200);
  await ctx.fetchJson("/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ token: owner.tokens.refresh_token, client_id: owner.client.client_id }),
  });
  assert.equal((await call(rotated.access_token, fresh.sid)).status, 401);
});

test("an unauthenticated call is told where to sign in", async (t) => {
  const ctx = await boot(t);
  const { res } = await ctx.fetchJson("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 401);
  assert.equal(
    res.headers.get("www-authenticate"),
    `Bearer resource_metadata="${ctx.base}/.well-known/oauth-protected-resource/mcp"`
  );

  const { body: resource } = await ctx.fetchJson("/.well-known/oauth-protected-resource/mcp");
  assert.equal(resource.resource, `${ctx.base}/mcp`);
  assert.deepEqual(resource.authorization_servers, [`${ctx.base}/`]);

  const { body: as } = await ctx.fetchJson("/.well-known/oauth-authorization-server");
  assert.equal(as.registration_endpoint, `${ctx.base}/register`);
  assert.deepEqual(as.scopes_supported, ["read", "write"]);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("a refused token is told invalid_token, and still where to sign in", async (t) => {
  let now = Date.now();
  const ctx = await boot(t, { now: () => now });
  const metadata = `${ctx.base}/.well-known/oauth-protected-resource/mcp`;
  const refused = `Bearer error="invalid_token", error_description="The bearer token is unknown or has expired", resource_metadata="${metadata}"`;
  const call = (token) =>
    fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
    });

  const unknown = await call("not-a-token");
  assert.equal(unknown.status, 401);
  assert.equal(unknown.headers.get("www-authenticate"), refused, "an unknown token");

  const { tokens } = await signIn(ctx);
  assert.equal((await listTools(ctx, tokens.access_token)).status, 200);
  now += 25 * 60 * 60 * 1000;
  const expired = await call(tokens.access_token);
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get("www-authenticate"), refused, "an expired token");

  // The SDK's own client still reads where to sign in next to the error.
  const params = extractWWWAuthenticateParams(expired);
  assert.equal(params.error, "invalid_token");
  assert.equal(params.resourceMetadataUrl?.href, metadata);
});

test("the request log names the caller by User-Agent and OAuth client, never by its token", async (t) => {
  const ctx = await boot(t);
  const { client, tokens } = await signIn(ctx);
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const signedIn = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens.access_token}`,
        "user-agent": `Claude-User "quoted"\tagent/${"x".repeat(80)}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    assert.equal(signedIn.status, 200);
    await signedIn.text();
    const oauthLine = await waitFor(
      () => lines.find((line) => line.includes("rpc=initialize") && line.includes("-> 200")),
      5_000,
      "the initialize log line"
    );
    const agent = "Claude-User quotedagent/".padEnd(60, "x");
    assert.ok(oauthLine.endsWith(` client="${agent}" oauth_client=${client.client_id}`), oauthLine);

    const staticRes = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer static-read", "user-agent": "curl/8.7.1" },
      body: "{}",
    });
    await staticRes.text();
    const staticLine = await waitFor(
      () => lines.find((line) => line.includes("rpc=-") && line.includes(`-> ${staticRes.status}`)),
      5_000,
      "the static token's log line"
    );
    assert.ok(staticLine.endsWith(' client="curl/8.7.1"'), `a static token has no OAuth client: ${staticLine}`);

    assert.ok(
      lines.every((line) => !line.includes(tokens.access_token) && !line.includes("static-read")),
      "no token reaches a log line"
    );
  } finally {
    console.error = original;
  }
});

test("OAuth write grants never authorize host file access, and consent labels cannot inject log lines", async (t) => {
  const ctx = await boot(t);
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const { tokens } = await signIn(ctx, { access: "write", clientName: 'Test"\nFORGED\u001b[31m' });
    const client = new Client({ name: "oauth-files", version: "1" });
    t.after(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ctx.base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      })
    );
    const result = await client.callTool({
      name: "send_message",
      arguments: { chat_id: "40722123456@s.whatsapp.net", text: "", file_path: "/synthetic/private.png" },
    });
    assert.equal(result.structuredContent.error, "MEDIA_ACCESS_DENIED");
    assert.ok(lines.some((line) => line.includes("oauth: registered client")));
    assert.ok(
      lines.every((line) => !["\n", "\r", "\u001b"].some((control) => line.includes(control))),
      "no injected line or terminal escape"
    );
    assert.ok(lines.every((line) => !line.includes(tokens.access_token) && !line.includes(tokens.refresh_token)));
  } finally {
    console.error = original;
  }
});

test("the static token still works with OAuth on", async (t) => {
  const ctx = await boot(t);
  const { status, names } = await listTools(ctx, "static-read");
  assert.equal(status, 200);
  assert.ok(names.includes("get_status"));
  assert.ok(!names.includes("send_message"));
  assert.ok(!names.includes("confirm_send"));
});

test("a write bearer does not unlock write tools while the server is read-only", async (t) => {
  const ctx = await boot(t, { credentials: [{ token: "writer", write: true }], readOnly: true });
  const { status, names } = await listTools(ctx, "writer");
  assert.equal(status, 200);
  assert.ok(names.includes("get_status"));
  assert.ok(!names.includes("send_message"));
  assert.ok(!names.includes("confirm_send"));
});

test("a write grant walks discovery, consent, code and token, then sees the write tools", async (t) => {
  const ctx = await boot(t);
  const g = await grant(ctx, { access: "write" });
  assert.equal(g.redirect.status, 302);
  const location = new URL(g.redirect.headers.get("location"));
  assert.equal(location.origin + location.pathname, g.redirectUri);
  assert.equal(location.searchParams.get("state"), "s-123");
  const code = location.searchParams.get("code");
  assert.ok(code);

  const { res, body: tokens } = await exchange(ctx, { ...g, code });
  assert.equal(res.status, 200, JSON.stringify(tokens));
  assert.equal(tokens.token_type, "bearer");
  assert.equal(tokens.scope, "read write");
  assert.ok(tokens.refresh_token);

  const { status, names } = await listTools(ctx, tokens.access_token);
  assert.equal(status, 200);
  assert.ok(names.includes("send_message"));
  assert.ok(names.includes("confirm_send"));

  // A code is one use.
  const replay = await exchange(ctx, { ...g, code });
  assert.equal(replay.res.status, 400);

  // The file holds hashes, never the tokens.
  const onDisk = readFileSync(join(ctx.dataDir, "oauth.json"), "utf8");
  assert.ok(!onDisk.includes(tokens.access_token));
  assert.ok(!onDisk.includes(tokens.refresh_token));
});

test("a read grant never sees a write tool, whatever the client asked for", async (t) => {
  const ctx = await boot(t);
  const g = await grant(ctx, { access: "read", scope: "read write" });
  const code = new URL(g.redirect.headers.get("location")).searchParams.get("code");
  const { body: tokens } = await exchange(ctx, { ...g, code });
  assert.equal(tokens.scope, "read");
  const { names } = await listTools(ctx, tokens.access_token);
  assert.ok(names.includes("get_status"));
  assert.ok(!names.includes("send_message"));
  assert.ok(!names.includes("confirm_send"));
});

test("the consent page preselects what the client asked for", async (t) => {
  const ctx = await boot(t);
  const asksWrite = await grant(ctx, { scope: "read write" });
  assert.match(asksWrite.html, /value="write" checked/);
  const asksNothing = await grant(ctx);
  assert.match(asksNothing.html, /value="read" checked/);
});

test("a wrong password stays on the page twice, the third throws the page away, five lock the caller out", async (t) => {
  const ctx = await boot(t);
  const g = await grant(ctx, { password: "nope" });
  assert.equal(g.redirect.status, 401);

  const again = (request) => approve(ctx, request, { password: "nope", access: "read", decision: "allow" });
  assert.equal((await again(g.request)).res.status, 401);
  const third = await again(g.request);
  assert.equal(third.res.status, 401);
  assert.match(third.body, /three times/);
  // The page is gone: the right password on it goes nowhere.
  assert.equal(
    (await approve(ctx, g.request, { password: PASSWORD, access: "read", decision: "allow" })).res.status,
    400
  );

  const fresh = await begin(ctx);
  assert.equal((await again(fresh.request)).res.status, 401);
  assert.equal((await again(fresh.request)).res.status, 401);
  assert.equal((await again((await begin(ctx)).request)).res.status, 429);
});

test("untrusted proxy headers cannot rotate the password-lockout identity", async (t) => {
  const ctx = await boot(t, { trustedProxies: [] });
  const wrong = { password: "nope", access: "read", decision: "allow" };
  let page = await begin(ctx);
  for (let miss = 0; miss < 5; miss++) {
    if (miss === 3) page = await begin(ctx);
    const { res } = await approveWith(
      ctx,
      { "x-forwarded-for": `203.0.113.${miss + 1}`, "cf-connecting-ip": `198.51.100.${miss + 1}` },
      page.request,
      wrong
    );
    assert.equal(res.status, 401);
  }
  const next = await begin(ctx);
  const { res } = await approveWith(
    ctx,
    { "x-forwarded-for": "203.0.113.99", "cf-connecting-ip": "198.51.100.99" },
    next.request,
    { ...wrong, password: PASSWORD }
  );
  assert.equal(res.status, 429);
});

test("CF-Connecting-IP alone cannot rotate the caller behind a trusted local proxy", async (t) => {
  const ctx = await boot(t);
  const wrong = { password: "nope", access: "read", decision: "allow" };
  let page = await begin(ctx);
  for (let miss = 0; miss < 5; miss++) {
    if (miss === 3) page = await begin(ctx);
    assert.equal(
      (await approveWith(ctx, { "cf-connecting-ip": `203.0.113.${miss + 1}` }, page.request, wrong)).res.status,
      401
    );
  }
  assert.equal(
    (await approveWith(ctx, { "cf-connecting-ip": "203.0.113.99" }, (await begin(ctx)).request, wrong)).res.status,
    429
  );
});

test("the default proxy chain stops at a private client instead of trusting its spoofed prefix", async (t) => {
  const ctx = await boot(t);
  const wrong = { password: "nope", access: "read", decision: "allow" };
  let page = await begin(ctx);
  for (let miss = 0; miss < 5; miss++) {
    if (miss === 3) page = await begin(ctx);
    const headers = { "x-forwarded-for": `198.51.100.${miss + 1}, 10.9.0.3` };
    assert.equal((await approveWith(ctx, headers, page.request, wrong)).res.status, 401);
  }
  assert.equal(
    (await approveWith(ctx, { "x-forwarded-for": "198.51.100.99, 10.9.0.3" }, (await begin(ctx)).request, wrong)).res
      .status,
    429
  );
});

test("OAuth metadata never takes its issuer/resource from forwarded Host or scheme", async (t) => {
  const ctx = await boot(t);
  const { body } = await ctx.fetchJson("/.well-known/oauth-protected-resource/mcp", {
    headers: { host: "other.example", "x-forwarded-host": "other.example", "x-forwarded-proto": "https" },
  });
  assert.equal(body.resource, `${ctx.base}/mcp`);
  assert.deepEqual(body.authorization_servers, [`${ctx.base}/`]);
});

test("OAuth codes and refresh grants cannot be exchanged or revoked by another client", async (t) => {
  const ctx = await boot(t);
  const g = await grant(ctx);
  const other = await begin(ctx);
  const code = new URL(g.redirect.headers.get("location")).searchParams.get("code");
  assert.equal((await exchange(ctx, { ...g, code, client: other.client })).res.status, 400);
  assert.equal((await exchange(ctx, { ...g, code, redirectUri: "https://other.example/callback" })).res.status, 400);
  const valid = await exchange(ctx, { ...g, code });
  assert.equal(valid.res.status, 200);
  const tokens = valid.body;
  const wrongRefresh = await ctx.fetchJson("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", client_id: other.client.client_id, refresh_token: tokens.refresh_token }),
  });
  assert.equal(wrongRefresh.res.status, 400);
  for (const token of [tokens.access_token, tokens.refresh_token]) {
    const revoke = await ctx.fetchJson("/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ client_id: other.client.client_id, token }),
    });
    assert.equal(revoke.res.status, 200);
    assert.equal((await listTools(ctx, tokens.access_token)).status, 200);
  }
});

test("access token is invalid at its exact expiration instant", async (t) => {
  let now = Date.now();
  const ctx = await boot(t, { now: () => now });
  const { tokens } = await signIn(ctx);
  now += tokens.expires_in * 1000;
  assert.equal((await listTools(ctx, tokens.access_token)).status, 401);
});

test("authorization rejects a resource other than this MCP endpoint", async (t) => {
  const ctx = await boot(t);
  const started = await begin(ctx);
  for (const resource of ["https://other.example/mcp", `${ctx.base}/other`, `${ctx.base}/mcp?extra=1`]) {
    const query = new URLSearchParams({
      client_id: started.client.client_id,
      redirect_uri: started.redirectUri,
      response_type: "code",
      code_challenge: started.challenge,
      code_challenge_method: "S256",
      resource,
    });
    const { res } = await ctx.fetchJson(`/authorize?${query}`);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("location")).searchParams.get("error"), "invalid_target");
  }
});

test("token exchange rejects a different resource without consuming the valid code", async (t) => {
  const ctx = await boot(t);
  const g = await grant(ctx);
  const code = new URL(g.redirect.headers.get("location")).searchParams.get("code");
  const bad = await exchange(ctx, { ...g, code, resource: "https://other.example/mcp" });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.body.error, "invalid_target");
  assert.equal((await exchange(ctx, { ...g, code, resource: `${ctx.base}/mcp` })).res.status, 200);
});

test("refresh refuses foreign resources and scopes with nothing in the consent grant", async (t) => {
  const ctx = await boot(t);
  const { client, tokens } = await signIn(ctx, { access: "read" });
  for (const [extra, error] of [
    [{ resource: "https://other.example/mcp" }, "invalid_target"],
    [{ scope: "write" }, "invalid_scope"],
  ]) {
    const { res, body } = await ctx.fetchJson("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
        ...extra,
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(body.error, error);
  }
  assert.equal(
    (await listTools(ctx, tokens.access_token)).status,
    200,
    "invalid refresh requests do not revoke the valid grant"
  );
  // Asking for more than the grant narrows to it rather than signing the client out.
  const { res, body } = await ctx.fetchJson("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, scope: "read write" }),
  });
  assert.equal(res.status, 200);
  assert.equal(body.scope, "read");
});

test("behind a tunnel on this machine, the forwarded address is the caller a lockout counts", async (t) => {
  const ctx = await boot(t);
  const wrong = { password: "nope", access: "read", decision: "allow" };
  let page = await begin(ctx);
  for (let miss = 0; miss < 5; miss++) {
    if (miss === 3) page = await begin(ctx);
    assert.equal((await approveFrom(ctx, "203.0.113.9", page.request, wrong)).res.status, 401, `miss ${miss + 1}`);
  }
  const locked = await approveFrom(ctx, "203.0.113.9", (await begin(ctx)).request, wrong);
  assert.equal(locked.res.status, 429, "that caller is locked out");

  const owner = await begin(ctx);
  const { res } = await approveFrom(ctx, "198.51.100.7", owner.request, { ...wrong, password: PASSWORD });
  assert.equal(res.status, 302, "the owner, reaching the same tunnel from elsewhere, is not");
});

/** The approve POST from loopback, carrying whatever headers a tunnel on this machine added. */
function approveWith(ctx, headers, request, fields) {
  return ctx.fetchJson("/oauth/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: form({ request, ...fields }),
  });
}

test("CF-Connecting-IP is ignored; trusted X-Forwarded-For chooses the caller", async (t) => {
  const ctx = await boot(t);
  const wrong = { password: "nope", access: "read", decision: "allow" };
  const right = { ...wrong, password: PASSWORD };

  /** Five misses from these headers, over two pages, since a page takes three. */
  const lockOut = async (headers) => {
    let page = await begin(ctx);
    for (let miss = 0; miss < 5; miss++) {
      if (miss === 3) page = await begin(ctx);
      assert.equal((await approveWith(ctx, headers, page.request, wrong)).res.status, 401, `miss ${miss + 1}`);
    }
  };

  await lockOut({ "cf-connecting-ip": "203.0.113.9" });
  const locked = await approveWith(ctx, { "cf-connecting-ip": "203.0.113.9" }, (await begin(ctx)).request, right);
  assert.equal(locked.res.status, 429, "that address is locked out");
  const owner = await approveWith(ctx, { "cf-connecting-ip": "198.51.100.7" }, (await begin(ctx)).request, right);
  assert.equal(owner.res.status, 429, "changing only a CF header cannot change the caller");

  await lockOut({ "x-forwarded-for": "203.0.113.20" });
  const spoofed = await approveWith(
    ctx,
    { "x-forwarded-for": "203.0.113.20", "cf-connecting-ip": "198.51.100.8" },
    (await begin(ctx)).request,
    right
  );
  assert.equal(spoofed.res.status, 429, "a CF-Connecting-IP next to X-Forwarded-For does not choose the caller");
});

test("twenty wrong passwords from strangers pause consent for a minute, not the owner for fifteen", async (t) => {
  let now = Date.now();
  const ctx = await boot(t, { now: () => now });
  const wrong = { password: "nope", access: "read", decision: "allow" };
  let page = null;
  for (let miss = 0; miss < 20; miss++) {
    // A page takes three wrong passwords, and every stranger comes from a different address.
    if (miss % 3 === 0) page = await begin(ctx);
    const { res } = await approveFrom(ctx, `203.0.113.${miss + 1}`, page.request, wrong);
    assert.equal(res.status, 401, `miss ${miss + 1}`);
  }

  const owner = await begin(ctx);
  const right = { ...wrong, password: PASSWORD };
  const paused = await approveFrom(ctx, "198.51.100.7", owner.request, right);
  assert.equal(paused.res.status, 429, "everyone waits out the brake");
  assert.match(paused.body, /Try again in a minute\./);

  now += 61_000;
  const { res } = await approveFrom(ctx, "198.51.100.7", owner.request, right);
  assert.equal(res.status, 302, "a minute later the owner signs in");
  assert.ok(new URL(res.headers.get("location")).searchParams.get("code"));
});

test("the consent page names the host the code goes to, and the client's name only as its claim", async (t) => {
  const ctx = await boot(t);
  const { html } = await begin(ctx, { clientName: "Claude" });
  assert.match(html, /<h1>An agent wants to connect from <strong>agent\.example<\/strong><\/h1>/);
  assert.match(
    html,
    /It calls itself <strong>Claude<\/strong>\. The agent chose that name; wazap has not checked it\./
  );
});

test("every OAuth page refuses to be framed, loads nothing of its own, and sends no referrer", async (t) => {
  const ctx = await boot(t);
  const started = await begin(ctx);
  const wrong = await approve(ctx, started.request, { password: "nope", access: "read", decision: "allow" });
  const expired = await approve(ctx, "0".repeat(48), { password: PASSWORD, access: "read", decision: "allow" });
  assert.equal(wrong.res.status, 401);
  assert.equal(expired.res.status, 400);

  const policy = (formAction) =>
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;
  for (const [what, res, csp] of [
    // Approving redirects to the agent, and a browser checks that redirect against form-action too.
    ["the consent page", started.page, policy("'self' https://agent.example")],
    ["the consent page after a wrong password", wrong.res, policy("'self' https://agent.example")],
    ["a message page", expired.res, policy("'self'")],
  ]) {
    assert.equal(res.headers.get("content-security-policy"), csp, what);
    assert.equal(res.headers.get("x-frame-options"), "DENY", what);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer", what);
    assert.equal(res.headers.get("cache-control"), "no-store", what);
  }
});

test("cancel sends the agent back with access_denied and no code", async (t) => {
  const ctx = await boot(t);
  const started = await begin(ctx);
  const { res } = await approve(ctx, started.request, { decision: "deny" });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "s-123");
  assert.equal(location.searchParams.get("code"), null);

  // The request is spent: approving it afterwards with the right password goes nowhere.
  const { res: late } = await approve(ctx, started.request, { password: PASSWORD, access: "read", decision: "allow" });
  assert.equal(late.status, 400);
});

test("a refresh keeps the grant, a revoke ends it, and a restart remembers both", async (t) => {
  const ctx = await boot(t);
  const g = await grant(ctx);
  const code = new URL(g.redirect.headers.get("location")).searchParams.get("code");
  const { body: first } = await exchange(ctx, { ...g, code });

  const { res, body: second } = await ctx.fetchJson("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: g.client.client_id }),
  });
  assert.equal(res.status, 200, JSON.stringify(second));
  assert.notEqual(second.access_token, first.access_token);
  assert.equal(second.scope, "read write");

  // Another process reading the same file sees the grant.
  const reloaded = new WazapOAuthProvider({
    publicUrl: new URL(ctx.base),
    password: PASSWORD,
    stateFile: join(ctx.dataDir, "oauth.json"),
  });
  const info = await reloaded.verifyAccessToken(second.access_token);
  assert.deepEqual(info.scopes, ["read", "write"]);
  assert.equal(reloaded.grants().length, 1);
  assert.equal(reloaded.grants()[0].client, "Poke");

  const { res: revoked } = await ctx.fetchJson("/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ token: second.access_token, client_id: g.client.client_id }),
  });
  assert.equal(revoked.status, 200);
  assert.equal((await listTools(ctx, second.access_token)).status, 401);
  assert.ok(existsSync(join(ctx.dataDir, "oauth.json")));
});

test("an expired access token is refused and swept", async (t) => {
  let now = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-oauth-exp-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const provider = new WazapOAuthProvider({
    publicUrl: new URL("https://wazap.example"),
    password: PASSWORD,
    stateFile: join(dataDir, "oauth.json"),
    now: () => now,
  });
  const client = await provider.clientsStore.registerClient({
    redirect_uris: ["https://a.example/cb"],
    client_name: "x",
  });
  // Reach into the flow the way /oauth/approve does, without HTTP.
  const tokens = provider["issue"](client.client_id, ["read"]);
  assert.deepEqual((await provider.verifyAccessToken(tokens.access_token)).scopes, ["read"]);
  now += 25 * 60 * 60 * 1000;
  await assert.rejects(() => provider.verifyAccessToken(tokens.access_token), /expired/);
  provider["sweep"]();
  const onDisk = JSON.parse(readFileSync(join(dataDir, "oauth.json"), "utf8"));
  assert.deepEqual(onDisk.access, {});
  assert.equal(Object.keys(onDisk.refresh).length, 1);
});

test("with no static token and OAuth on, nobody gets in without signing in", async (t) => {
  const ctx = await boot(t, { credentials: [] });
  const { res } = await ctx.fetchJson("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 401);
  assert.equal((await listTools(ctx, "anything")).status, 401);

  const { tokens } = await signIn(ctx, { access: "write" });
  const { names } = await listTools(ctx, tokens.access_token);
  assert.ok(names.includes("send_message"), "a write grant is not downgraded by the missing read token");
  assert.ok(names.includes("confirm_send"));
});

test("revoking the refresh token ends the access tokens it minted", async (t) => {
  const ctx = await boot(t);
  const { client, tokens } = await signIn(ctx);
  assert.equal((await listTools(ctx, tokens.access_token)).status, 200);
  const { res } = await ctx.fetchJson("/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ token: tokens.refresh_token, client_id: client.client_id }),
  });
  assert.equal(res.status, 200);
  assert.equal((await listTools(ctx, tokens.access_token)).status, 401);
  assert.equal(ctx.oauth.grants().length, 0);
});

test("deleting oauth.json signs everyone out of a running server", async (t) => {
  const ctx = await boot(t);
  const { tokens } = await signIn(ctx);
  assert.equal((await listTools(ctx, tokens.access_token)).status, 200);
  rmSync(join(ctx.dataDir, "oauth.json"));
  assert.equal((await listTools(ctx, tokens.access_token)).status, 401);
  assert.equal(ctx.oauth.grants().length, 0);
  // The next write must not resurrect the old grants.
  const second = await signIn(ctx);
  assert.equal(ctx.oauth.grants().length, 1);
  assert.equal((await listTools(ctx, second.tokens.access_token)).status, 200);
  assert.equal((await listTools(ctx, tokens.access_token)).status, 401);
});

test("a confidential client keeps its secret for good", async (t) => {
  const ctx = await boot(t);
  const { client, tokens } = await signIn(ctx, { authMethod: "client_secret_post" });
  assert.ok(client.client_secret);
  assert.equal(client.client_secret_expires_at, 0);
  assert.equal(tokens.scope, "read write");
});

test("a client name with markup is shown, not run, and escaped once", async (t) => {
  const ctx = await boot(t);
  const { html } = await begin(ctx, { clientName: "Poke & <Co>" });
  assert.match(html, /<title>Connect agent\.example · wazap<\/title>/);
  assert.match(html, /<strong>Poke &amp; &lt;Co&gt;<\/strong>/);
  assert.ok(!html.includes("<Co>"));
});

test("a forgotten refresh token and an orphaned registration are swept", async (t) => {
  let now = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-oauth-sweep-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const provider = new WazapOAuthProvider({
    publicUrl: new URL("https://wazap.example"),
    password: PASSWORD,
    stateFile: join(dataDir, "oauth.json"),
    now: () => now,
  });
  const used = await provider.clientsStore.registerClient({
    redirect_uris: ["https://a.example/cb"],
    client_name: "used",
  });
  await provider.clientsStore.registerClient({ redirect_uris: ["https://b.example/cb"], client_name: "orphan" });
  provider["issue"](used.client_id, ["read"]);
  assert.equal(provider.grants().length, 1);

  now += 2 * 60 * 60 * 1000;
  provider["sweep"]();
  let onDisk = JSON.parse(readFileSync(join(dataDir, "oauth.json"), "utf8"));
  assert.deepEqual(
    Object.values(onDisk.clients).map((c) => c.client_name),
    ["used"]
  );
  assert.equal(Object.keys(onDisk.refresh).length, 1);

  now += 91 * 24 * 60 * 60 * 1000;
  provider["sweep"]();
  onDisk = JSON.parse(readFileSync(join(dataDir, "oauth.json"), "utf8"));
  assert.deepEqual(onDisk.refresh, {});
  assert.deepEqual(onDisk.clients, {});
});

test("registration after oauth.json removal cannot resurrect grants or consent pages", async (t) => {
  const ctx = await boot(t);
  const { tokens } = await signIn(ctx);
  const waiting = await begin(ctx);
  rmSync(join(ctx.dataDir, "oauth.json"));
  await begin(ctx);
  await assert.rejects(ctx.oauth.verifyAccessToken(tokens.access_token));
  assert.equal((await approve(ctx, waiting.request, { password: PASSWORD, decision: "allow" })).res.status, 400);
});

test("refresh rotates one-use tokens; replay revokes only that grant family", async (t) => {
  let now = Date.now();
  const ctx = await boot(t, { now: () => now });
  const first = await signIn(ctx);
  const other = { tokens: ctx.oauth.issue(first.client.client_id, ["read"]) };
  const second = await ctx.oauth.exchangeRefreshToken(first.client, first.tokens.refresh_token);
  assert.notEqual(second.refresh_token, first.tokens.refresh_token);
  assert.equal(ctx.oauth.grants().length, 2);
  now += 60_001;
  await assert.rejects(ctx.oauth.exchangeRefreshToken(first.client, first.tokens.refresh_token));
  await assert.rejects(ctx.oauth.verifyAccessToken(second.access_token));
  await assert.rejects(ctx.oauth.exchangeRefreshToken(first.client, second.refresh_token));
  assert.ok(await ctx.oauth.verifyAccessToken(other.tokens.access_token));
});

test("a refresh retried within 60 seconds of rotation keeps the grant, and the window does not slide", async (t) => {
  let now = Date.now();
  const ctx = await boot(t, { now: () => now });
  const first = await signIn(ctx);
  const second = await ctx.oauth.exchangeRefreshToken(first.client, first.tokens.refresh_token);
  now += 30_000;
  const retried = await ctx.oauth.exchangeRefreshToken(first.client, first.tokens.refresh_token);
  assert.notEqual(retried.refresh_token, second.refresh_token);
  assert.ok(await ctx.oauth.verifyAccessToken(second.access_token), "the concurrent refresh keeps its tokens");
  assert.ok(await ctx.oauth.verifyAccessToken(retried.access_token));
  now += 30_001;
  await assert.rejects(ctx.oauth.exchangeRefreshToken(first.client, first.tokens.refresh_token), /replay/);
  await assert.rejects(ctx.oauth.verifyAccessToken(retried.access_token), "a late replay still ends the family");
  const stateFile = join(ctx.dataDir, "oauth.json");
  assert.ok(new WazapOAuthProvider({ publicUrl: new URL(ctx.base), password: PASSWORD, stateFile }), "spentAt persists validly");
});

test("rotated refresh chains and active access tokens remain bounded across restart", async (t) => {
  const ctx = await boot(t);
  const first = await signIn(ctx);
  let tokens = first.tokens;
  for (let i = 0; i < 45; i++) tokens = await ctx.oauth.exchangeRefreshToken(first.client, tokens.refresh_token);
  const stateFile = join(ctx.dataDir, "oauth.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.ok(Object.keys(state.refresh).length <= 33);
  assert.ok(Object.keys(state.access).length <= 8);
  const next = new WazapOAuthProvider({ publicUrl: new URL(ctx.base), password: PASSWORD, stateFile });
  assert.equal(next.grants().length, 1);
  assert.ok(await next.verifyAccessToken(tokens.access_token));
  await assert.rejects(next.verifyAccessToken(first.tokens.access_token));
  const rotated = await next.exchangeRefreshToken(first.client, tokens.refresh_token, ["read"]);
  assert.equal(rotated.scope, "read");
  assert.equal((await next.exchangeRefreshToken(first.client, rotated.refresh_token)).scope, "read write");
});

for (const change of [entry => { delete entry.expiresAt; }, entry => { entry.expiresAt = "never"; }, entry => { entry.scopes = ["administrator"]; }]) {
  test("malformed persisted access grants fail closed instead of becoming unexpiring", async (t) => {
    const ctx = await boot(t);
    const { tokens } = await signIn(ctx);
    const stateFile = join(ctx.dataDir, "oauth.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8")); change(Object.values(state.access)[0]);
    writeFileSync(stateFile, JSON.stringify(state));
    const next = new WazapOAuthProvider({ publicUrl: new URL(ctx.base), password: PASSWORD, stateFile });
    await assert.rejects(next.verifyAccessToken(tokens.access_token));
  });
}

test("OAuth registrations, pending pages and grants have finite capacity", async (t) => {
  let now = Date.now();
  const ctx = await boot(t, { now: () => now });
  const metadata = { redirect_uris: ["https://synthetic.example/callback"] };
  let client;
  for (let i = 0; i < 256; i++) client = await ctx.oauth.clientsStore.registerClient(metadata);
  await assert.rejects(async () => ctx.oauth.clientsStore.registerClient(metadata), /capacity/);
  const params = { redirectUri: metadata.redirect_uris[0], codeChallenge: "synthetic" };
  const res = { setHeader() {}, status() { return this; }, type() { return this; }, send() {} };
  for (let i = 0; i < 128; i++) await ctx.oauth.authorize(client, params, res);
  await assert.rejects(ctx.oauth.authorize(client, params, res), /pending/);
  now += 10 * 60_000;
  await ctx.oauth.authorize(client, params, res);
  assert.equal(ctx.oauth.pending.size, 1, "expired pages free capacity at the exact boundary");
  for (let i = 0; i < 256; i++) ctx.oauth.issue(client.client_id, ["read"]);
  assert.throws(() => ctx.oauth.issue(client.client_id, ["read"]), /capacity/);
});

test("public issuer configuration refuses credentials and unsupported schemes without echo", () => {
  for (const publicUrl of ["https://u:SYNTHETIC-SECRET@host.example", "ftp://127.0.0.1", "SYNTHETIC-SECRET"]) {
    const error = oauthProblem({ publicUrl, oauthPassword: PASSWORD });
    assert.ok(error); assert.ok(!error.includes("SYNTHETIC-SECRET"));
  }
});

test("oauthProblem names what is missing or wrong", () => {
  assert.equal(oauthProblem({ publicUrl: null, oauthPassword: null }), null);
  assert.match(oauthProblem({ publicUrl: null, oauthPassword: "x".repeat(12) }), /WAZAP_PUBLIC_URL is not/);
  assert.match(oauthProblem({ publicUrl: "https://h.example", oauthPassword: null }), /WAZAP_OAUTH_PASSWORD is not/);
  assert.match(oauthProblem({ publicUrl: "http://h.example", oauthPassword: "x".repeat(12) }), /https/);
  assert.match(oauthProblem({ publicUrl: "https://h.example/wazap", oauthPassword: "x".repeat(12) }), /bare origin/);
  assert.match(oauthProblem({ publicUrl: "https://h.example", oauthPassword: "short" }), /shorter/);
  assert.equal(oauthProblem({ publicUrl: "https://h.example", oauthPassword: "x".repeat(12) }), null);
  assert.equal(oauthProblem({ publicUrl: "http://127.0.0.1:8766", oauthPassword: "x".repeat(12) }), null);
});

test("a draft answers to its OAuth client across sessions and token rotations, not another client's", async (t) => {
  const store = draftStub();
  const receipts = new Map();
  const wa = {
    getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), read_only: false }),
    draft: async (payload) => store.view(store.put({ chat_id: CHAT, name: "Test" }, payload)),
    confirm: async (id) => {
      if (receipts.has(id)) return { ...receipts.get(id), already_sent: true };
      const draft = store.take(id);
      const receipt = { chat_id: CHAT, message_id: "sent", text: draft.preview, timestamp: "now" };
      receipts.set(id, receipt);
      return receipt;
    },
  };
  const ctx = await boot(t, { wa });
  const owner = await signIn(ctx, { access: "write", clientName: "Owner" });
  const other = await signIn(ctx, { access: "write", clientName: "Other" });
  const mcp = async (token) => {
    const client = new Client({ name: "oauth-draft", version: "1" });
    t.after(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ctx.base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      })
    );
    return client;
  };
  const first = await mcp(owner.tokens.access_token);
  const draft = await first.callTool({ name: "send_message", arguments: { chat_id: CHAT, text: "hello" } });
  assert.equal(draft.structuredContent.status, "draft");
  const args = { draft_id: draft.structuredContent.draft_id };

  // The same grant's rotated access token is the same identity.
  const { res, body: rotated } = await ctx.fetchJson("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      refresh_token: owner.tokens.refresh_token,
      client_id: owner.client.client_id,
    }),
  });
  assert.equal(res.status, 200);
  assert.notEqual(rotated.access_token, owner.tokens.access_token);
  await first.close();
  const fresh = await mcp(rotated.access_token);
  assert.equal((await fresh.callTool({ name: "confirm_send", arguments: args })).structuredContent.message_id, "sent");
  assert.equal((await fresh.callTool({ name: "confirm_send", arguments: args })).structuredContent.already_sent, true);

  // Another client's grant is a different identity.
  const next = await fresh.callTool({ name: "send_message", arguments: { chat_id: CHAT, text: "again" } });
  const otherSession = await mcp(other.tokens.access_token);
  assert.equal(
    (await otherSession.callTool({ name: "confirm_send", arguments: { draft_id: next.structuredContent.draft_id } }))
      .structuredContent.error,
    "DRAFT_NOT_FOUND"
  );
});
