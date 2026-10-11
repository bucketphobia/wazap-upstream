# HTTP mode and self-hosting

Running wazap somewhere other than the laptop the agent runs on: the HTTP
transport, its limits, a systemd or Docker host, a tunnel, and the OAuth server
hosted agents sign in to.

## HTTP mode

```bash
npx wazap-mcp serve --http
```

Streamable HTTP at `/mcp` on `127.0.0.1:8766` (`--host` and `--port`, or
`WAZAP_HOST` and `WAZAP_PORT`), with a health check at `/healthz`. That check
answers `{ ok, status, since }`; the list of accounts and their status needs a
credential. It turns 503 once the socket has been anything but connected for
two minutes, so a tunnel or a monitor sees a real outage rather than a
reconnect in progress.

An agent reaches it by URL and signs in with [OAuth](#hosted-agents-oauth);
`wazap expose` sets that up. A product calling wazap from its own code uses a
static token instead: see [Building on wazap](api-and-webhooks.md#building-on-wazap-http-api-for-products).
wazap refuses to bind a non-loopback address without a read token.

### Client isolation

HTTP MCP sessions are bound to the exact bearer credential that initialized
them (stored in memory as a SHA-256 fingerprint), including its read/write
permissions. Another credential cannot use that session's POST, GET or DELETE
endpoint, even if it knows the session id; it receives `404 Session not found`.
Each request still validates the token, so expiry or revocation returns 401.
After an OAuth access token rotates, initialize a new MCP session when the old
session returns 404.

Clients sharing a static token share an identity, and unauthenticated readers
share an anonymous identity. Use distinct credentials/OAuth grants for isolation;
do not enable anonymous access on a sensitive endpoint. This is not per-client
account isolation: authorized clients still share account data and account-level
policies.

Drafts answer to an identity, not a connection. On the remote endpoint that
identity is the credential's: every session on a static token shares its
drafts, and an OAuth client's drafts survive both a new session and an
access-token rotation — so an async confirm that arrives over a reinitialized
connection still lands. A session on another credential is told
`DRAFT_NOT_FOUND`, without consuming the draft. stdio servers, anonymous
sessions and the daemon's own credential keep per-session drafts, so each
bridge's upstream session is still distinct and a new initialize there requires
a new draft and fresh user approval. Sharing a token is still sharing an
identity: use distinct credentials/OAuth grants for isolation. Draft/confirm is
a workflow, not independent proof of human consent; the agent can call both
tools unless a trusted harness enforces approval.

### Request budgets

MCP POSTs authenticate before JSON parsing, accept at most 100 KiB and refuse
compressed bodies. Each credential has 240 POSTs/minute across its sessions;
429 responses include `Retry-After`. The session registry holds at most 128
sessions overall and 32 per credential, evicting that credential's oldest first.
Tool work is capped at eight concurrent operations per MCP session and 32
across the process, including stdio/bridges. Slots remain held until work settles,
not merely until a client disconnects. Retry once after pending work completes.

The HTTP listener caps connections at 256, header receipt at ten seconds and
request-body receipt at thirty seconds; this does not time out legitimate SSE
streams or long-running tools. Anonymous loopback requests must have a loopback
Host name (on any port, so a mapped container port works) and, when supplied, a
matching Origin; browser rebinding/cross-origin
requests are refused. Always configure credentials for a proxy/tunnel. These
bounds are not a DDoS shield or per-tenant fairness guarantee.

### Host files and remote media

HTTP clients — static read/write tokens and OAuth grants — cannot use
`file_path` or override `get_media`'s directory with `save_to`. This applies even on
loopback: a reverse proxy or tunnel also reaches the server from localhost.
The tools return `MEDIA_ACCESS_DENIED` before looking up a path or touching a
file. A write token grants WhatsApp writes, not access to the host filesystem.

Remote clients can use public HTTP(S) media URLs, forward existing WhatsApp
messages, and download attachments into the account's default media directory.
Small downloaded images still return inline. Other attachments are saved on the
server; there is no arbitrary-file upload/download endpoint.

Local stdio clients retain local file access. A local bridge gets it only through
the private daemon credential stored in `daemon.json`, never through a public
read/write token or OAuth grant. Keep that credential private; it is a local
filesystem capability as well as a WhatsApp credential. No client-provided flag
or argument enables it.

URL media fetches check every DNS answer and redirect, pin the validated address
for the connection, check the peer address, and cap response size. Fetch errors
do not echo signed URLs. HTTP request logs omit queries, arbitrary URL paths,
request bodies and raw Accept headers; malformed-request errors are sanitized.
Client labels are bounded and stripped of log/terminal control characters. Do
not place secrets in client names or User-Agent labels, which remain diagnostic
metadata.

## Self-host

Run wazap on a server of your own when the agent is not on your laptop: another machine, a VPS, a client's infrastructure. The session stays on that server; nothing goes through a third party.

### With systemd

```bash
npm install -g wazap-mcp
sudo useradd --system --home /var/lib/wazap --create-home wazap
sudo -u wazap WAZAP_DATA_DIR=/var/lib/wazap wazap login --phone +15550100   # pairing code works over SSH
sudo -u wazap tee /var/lib/wazap/.env >/dev/null <<END
WAZAP_READ_TOKEN=$(openssl rand -hex 32)
WAZAP_WRITE_TOKEN=$(openssl rand -hex 32)
END
sudo curl -fsSL https://raw.githubusercontent.com/razvangirgiz/wazap/main/deploy/wazap.service -o /etc/systemd/system/wazap.service
sudo systemctl enable --now wazap
curl -s http://127.0.0.1:8766/healthz
```

The unit binds loopback only. Put TLS in front with the two-line [`deploy/Caddyfile`](../deploy/Caddyfile) (`caddy run --config deploy/Caddyfile` after editing the hostname) or any reverse proxy, then turn on [OAuth](#hosted-agents-oauth) and give agents `https://your-host/mcp`. The tokens are for [your own code](api-and-webhooks.md#building-on-wazap-http-api-for-products).

### With Docker

Each release is published as `ghcr.io/razvangirgiz/wazap` for amd64 and
arm64, tagged with its version (`1.3.7`), its minor line (`1.3`) and `latest`.
The compose file is all you need:

```bash
mkdir wazap && cd wazap
curl -fsSLO https://raw.githubusercontent.com/razvangirgiz/wazap/main/docker-compose.yml
printf 'WAZAP_READ_TOKEN=%s\nWAZAP_WRITE_TOKEN=%s\n' $(openssl rand -hex 32) $(openssl rand -hex 32) > .env
docker compose run --rm wazap login --phone +15550100   # once; the session lands in the wazap-data volume
docker compose up -d
curl -s http://127.0.0.1:8766/healthz
```

The container publishes `8766` on loopback only; add the same TLS proxy in front. Upgrading is `docker compose pull && docker compose up -d`; the volume keeps the session. To stay on one line, change `latest` in the compose file to `1.3`. To build from source instead, run `docker build -t ghcr.io/razvangirgiz/wazap:latest .` in a clone.

A proxy on the host reaches the container through the published port, so inside
the container its address is the compose network's gateway, not loopback. The
compose file pins that network to `172.30.87.0/24` and trusts its gateway,
`172.30.87.1`, for `X-Forwarded-For`; without that, every OAuth caller would
share one password lockout. If the subnet clashes with one of yours, change both
together, or set `WAZAP_TRUST_PROXY` in `.env`.

### From a machine without a public address

A laptop or a box behind NAT can still serve hosted agents through a tunnel, with no port opened and TLS done at the edge. `npx wazap-mcp expose` does the whole thing with Tailscale Funnel or Cloudflare Tunnel, whichever is installed. See [Keep it running](install.md#keep-it-running).

wazap keeps binding loopback either way; only the tunnel reaches it.

<details>
<summary>By hand, with Cloudflare Tunnel and a domain on Cloudflare</summary>

```bash
cloudflared tunnel login
cloudflared tunnel create wazap
cloudflared tunnel route dns wazap wazap.example.com
cloudflared tunnel run --url http://127.0.0.1:8766 wazap
```

Set `WAZAP_PUBLIC_URL=https://wazap.example.com` for OAuth and keep `cloudflared` running the way you keep wazap running (a systemd unit, a launchd agent). Tailscale Funnel or ngrok work the same way: whatever ends at `https://your-host` with `/mcp` behind it.

</details>

### Which clients can reach it

Agents sign in with [OAuth](#hosted-agents-oauth): claude.ai Connectors, ChatGPT, Poke and any MCP client that signs in to a URL. Your own code calling wazap uses a static token instead; see [Building on wazap](api-and-webhooks.md#building-on-wazap-http-api-for-products).

### Reverse proxy trust

With OAuth enabled, `WAZAP_TRUST_PROXY` controls which peers may supply
`X-Forwarded-For` for password lockouts and request limits. The default is
`loopback`, not every private or Docker address. Set it to `none` for direct
connections without a proxy, or to a comma-separated list of exact proxy IPs
or CIDRs, for example `loopback,172.20.0.2/32`. Restart after changing it.
Do not trust a whole LAN just because the proxy runs there.

The trusted proxy must remove or sanitize incoming `X-Forwarded-For` and append
the actual client address. `CF-Connecting-IP` alone is ignored; configure a
Cloudflare/tunnel ingress to produce a trustworthy `X-Forwarded-For` chain.
Otherwise callers behind that ingress share the proxy's rate-limit identity.
Check the real header chain before exposing the service. Proxy trust does not
grant authentication, write permissions, or local-file access.

### Hosted agents (OAuth)

Two more lines in the same `.env` turn wazap into its own OAuth 2.1 server:

```bash
WAZAP_PUBLIC_URL=https://wazap.example.com
WAZAP_OAUTH_PASSWORD=$(openssl rand -base64 18)
```

Then give an agent nothing but `https://wazap.example.com/mcp`. It finds the
authorization server at `/.well-known/oauth-protected-resource/mcp`, registers
itself (RFC 7591, so there is no client id to paste anywhere), and sends you to
a page on your own host that asks two things: the password above, and whether
this agent may only read or also send. A refresh token keeps the agent signed
in until you revoke it; access tokens rotate every 24 hours on their own.

Tested against the flow claude.ai, ChatGPT and Poke use: S256 PKCE, public
clients, `/token` with refresh, `/revoke`. The bearer tokens keep working next
to it, so a laptop client on a header and a hosted agent on OAuth share one
server.

What to know before exposing it:

- `WAZAP_PUBLIC_URL` must be `https` and a bare origin, no path: the
  endpoints live at its root. The password travels to it.
- The password is the whole identity layer. Use a long one. A consent page
  takes three wrong guesses and is gone; five from one address lock that
  address out for fifteen minutes; twenty from anywhere pause consent for
  everyone for one minute.
- With OAuth on, `/mcp` never answers an unauthenticated request, whether or
  not a read token is set.
- Grants live in `<data-dir>/oauth.json` as hashes. Delete the file to sign
  every agent out at once, running server included; `wazap status` lists who
  holds one. Disconnecting an agent on its side revokes its refresh token and
  every access token in that grant family. Refresh tokens rotate on every use:
  clients must save the returned token. A consumed token still works for 60
  seconds from its rotation, so two refreshes at once or a lost response do not
  sign the agent out; replaying it later, within the last 32 consumed tokens,
  revokes the family, and older tokens are simply invalid. At most eight access
  tokens per grant remain active. A refresh token unused for ninety days is dropped. Damaged persisted grants require sign-in
  again rather than becoming unexpiring.
- A read grant never sees a write tool, whatever scope the agent requested.
  The radio button on the consent page is the only thing that decides. Refresh
  requests may narrow scopes; asking for more gets the grant's scopes, and a
  request with none of them is rejected.
- A supplied OAuth `resource` must be this server's exact MCP URL, including
  `/mcp`. A different path, origin, query or fragment is rejected at authorization,
  code exchange and refresh. Older clients may omit `resource`.
- Write tools may be visible because one linked account allows them. Each write
  still checks the resolved account's read-only policy before draft creation or
  media preparation, as well as the existing service-level send check. This is
  account policy enforcement, not per-client account ACLs; policy changes still
  require the documented server restart.
