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
reconnect in progress. How the server recovers on its own, and how it tells
the owner about an outage or a device WhatsApp unlinked, is in
[Keep it running](install.md#keep-it-running) and
[Link alerts](api-and-webhooks.md#link-alerts).

An agent reaches it by URL and signs in with [OAuth](#hosted-agents-oauth);
`wazap expose` sets that up. A product calling wazap from its own code uses a
static token instead: see [Building on wazap](api-and-webhooks.md#building-on-wazap-http-api-for-products).
wazap refuses to bind a non-loopback address without a read token.

### Client isolation

HTTP MCP sessions are bound to the credential that initialized them,
including its read/write permissions: a static token by its SHA-256
fingerprint, an OAuth agent by its grant (its client id and granted scopes)
rather than the access token of the day, so the daily rotation keeps its
sessions, and its POST budget, as they were. A refresh that narrows the scopes
is a different owner. Another credential cannot use that session's POST, GET
or DELETE endpoint, even if it knows the session id; it receives
`404 Session not found`. Each request still validates the token, so expiry or
revocation returns 401.

A session outlives the process holding it. Its id is `<uuid>.<mark>`, the mark
an HMAC over the uuid, the credential and what the session handed its client
at `initialize` (the tools, workflows and instructions, as one digest), keyed
by `<data-dir>/session.key` (made on first use, `0600`). When a POST or GET
arrives with an id this process does not hold — after a restart, after the
idle sweep, after an eviction — and the mark matches the credential presenting
it and what wazap would hand that client now, wazap opens the session again
under that id and serves the request: the client never sees a 404 or redoes
its handshake. A revived session has the credential's tools and drafts; what
it loses is what the client said in its first `initialize` (its name and
capabilities, which wazap does not use). When what the client was handed has
changed — an update to another version, writes switched on or off, an account
added or renamed — the session is not revived: the client gets the 404, and
the fresh `initialize` it answers with gives it the new tools and
instructions. Any other credential still gets 404,
as does an id wazap did not mint; anonymous loopback sessions are never
revived, and neither is a session its client ended with DELETE (the process
remembers the last 1,024 ended ids; a restart forgets them). Revived sessions count against the caps below, and each revival is
logged without the id. Deleting `session.key` and restarting makes every
outstanding id unrevivable.

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
compressed bodies. The one exception is a write credential's POST that
declares its length, which may carry up to 8 MiB: enough for `send_message`'s
`data_base64` at its 5 MB, line-wrapped with CRLF too, and no more. Those large
bodies are read and served at most 32 MiB at a time across every credential
(four of the largest); past that a POST gets 503 with `Retry-After: 2`, and a
read credential's, or a body sent without a length, keeps the 100 KiB limit.
A body past its limit gets 413 with a JSON-RPC error that names the limit, and
for a write credential the 5 MB of `data_base64` and the fix of passing a
larger file as a `url`: an MCP client shows the agent those words. Measured on the
development machine: one 5 MB `data_base64` draft raises the server's peak RSS
by about 26 MB, four at once by about 85 MB. Each credential has 240 POSTs/minute across its sessions;
429 responses include `Retry-After`. The session registry holds at most 64
sessions overall and 32 per credential, evicting that credential's least
recently used session first, and never one answering a request while another
can go; it drops a session nobody has used for 24 hours. Either way a session
comes back on its owner's next call (see [Client isolation](#client-isolation)),
within the same caps: a POST revives it if that closes no session answering a
request, and a GET (a client reconnecting its notification stream) only into a
free place, so clients past the cap do not evict one another round and round.
Otherwise the call gets the 404, and a fresh `initialize` takes the idlest
place.
Tool work is capped at eight concurrent operations per MCP session and 32
across the process, including stdio/bridges. Slots remain held until work settles,
not merely until a client disconnects. A call the client cancels
(`notifications/cancelled`), or one whose session is closed, stops waiting,
and the stream its answer would have taken ends at once:
`wait_for_messages` answers at once, a media download stops at its next chunk
(or leaves the line for a download slot, or stops waiting for the phone to
upload expired media), a document read ends its worker, a frame grab, page
render or SVG drawing is killed or leaves its queue, and a transcription stops
being waited on. A transcription several callers
share (two sessions, or a call and the auto queue) goes on for the others; its
download stops only when every one of them has cancelled, and a provider
already running finishes and keeps its transcript. Its slot comes back as soon
as it has stopped. A disconnect alone is not a cancel, as the MCP
specification says. Retry once after pending work completes.

Answers to a POST are gzip-compressed when the client's `Accept-Encoding`
takes gzip (Node's `fetch`, and so every TypeScript MCP client, does; so does
`curl --compressed`), with a flush after every SSE event so a streamed answer
is not held back. An answer under 1 KiB that is complete within 20 ms goes as
it is; one still being written after 20 ms (a `wait_for_messages`, a slow
tool) is streamed compressed whatever its size, which costs it about 20 bytes
of framing. Nothing is compressed for a client that did not ask. The tool catalogue crosses the wire as 11 KB
instead of 56 KB. The GET notification stream is never compressed, and neither is a download
link's file (`/media/<token>`), which goes out as it is with its own headers.

A restart (`SIGTERM` or `SIGINT`: `wazap update`, `wazap service restart`, a
supervisor stopping the service) drains HTTP first. The listener closes at
once, so a new connection is refused (through a tunnel, a 502); a request on
a connection that was already open gets 503 with `Retry-After`. A
`wait_for_messages` under way answers at once with what it has, and every
other call under way, one whose client has left included, and every download
link's file still being fetched, gets up to ten seconds to finish before the
accounts stop. A call its client cancelled holds
nothing up: its answer stream has already ended. The client's session is
revived by the next process. The units `wazap service
install` writes allow 15 seconds for that (launchd's `ExitTimeOut`, systemd's
`TimeoutStopSec`), as does the compose file. launchd kills a job whose plist
sets no `ExitTimeOut` about five seconds after `SIGTERM`, so under a unit
written by an older wazap the drain lasts one second, and the log says so at
startup, with the command that rewrites the unit: `service install` run by the
service's own node and script, since a `wazap` on the shell's PATH may be
another install, and with the service's `--port`, since a `WAZAP_PORT` left
in `.env` (which the unit's own `--port` overrides while it runs) would move
it. A reinstall keeps the service's port unless `--port` or `WAZAP_PORT`
names another; an empty `WAZAP_PORT` names none. The next
process warms its catalogue and transport right after it binds, so the first
`initialize` after a restart costs about half what it did: 22–39 ms instead
of 40–72 measured side by side on a loaded laptop over loopback, and 8–10 ms
when the laptop was quieter.

The HTTP listener caps connections at 256, header receipt at ten seconds and
request-body receipt at thirty seconds; this does not time out legitimate SSE
streams or long-running tools. An idle keep-alive connection stays open for
120 seconds, longer than a tunnel keeps one in its pool (cloudflared: 90), so
the tunnel never sends a request on a socket wazap is closing. Anonymous loopback requests must have a loopback
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

Remote clients can use public HTTP(S) media URLs (fetched and kept when the
message is drafted, so the preview names the real file and the send sends
exactly that; see [Media from a URL](tools.md#media-from-a-url)), send a file of
their own of up to 5 MB in the call (`data_base64`, write credentials only), forward existing WhatsApp
messages, and see attachments through `get_media`: an image as a view, a video as
a contact sheet, a document as its text (see [Media for remote agents](tools.md#media-for-remote-agents)).
Nothing is written to the server's disk for a remote read, and no server path is
returned; a draft's media waits in `accounts/<id>/outgoing/` until it is sent,
expires or is cancelled. There is no arbitrary-file upload/download endpoint.

With `WAZAP_PUBLIC_URL` set, a remote `get_media` also returns `link`: the
original file at `<public URL>/media/<token>`, valid for 30 minutes. The token
is the only credential the route takes (it is signed with a secret kept in
`media-links.key` in the data dir), so treat a link like the file. It is mainly
for the person, who can tap it in the chat: claude.ai, ChatGPT and the API's MCP
connector do not fetch URLs that came from a tool result, and Claude Code on the
web reaches the tunnel only if its network access allows the host. Cursor's
cloud agents and local CLIs can download it. A deleted or expired message, an
expired link and a forged one all answer 404; the file always comes as a
download, never rendered by the browser. A `HEAD` on a link answers with the
file's type and name without fetching it.

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

What the log does say, so the owner can tell which cloud clients connect and
what crosses the tunnel: each `initialize` logs the client's own name and
version, the protocol version, the kind of credential (`oauth`, `token`,
`local` or `anonymous`, never which one), the `Host` it came through and the
answer format the session got (`answers=text` for an assistant, `full`
otherwise; see `WAZAP_ANSWER_FORMAT` in [settings](settings.md)); each
request line ends with the body bytes sent, their encoding (`gzip` or
`identity`) and what became of the session (`new`, `reused`, `revived`,
`lost`). For example:

```text
MCP initialize: client="claude-ai 0.1.0" protocol=2025-06-18 credential=oauth host=wazap.example.com answers=text
HTTP POST /mcp rpc=tools/list auth accept="json+sse" -> 200 (3ms) bytes=10953 enc=gzip session=reused client="node"
```

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

The image carries poppler and ffmpeg, so `get_media` shows a PDF's pages (a
scan has nothing else to read) and a video as a sheet of frames, as on a Mac
with them installed, and the Liberation fonts, which stand in for the standard
PDF fonts (Helvetica, Times, Courier) a file names without embedding them.

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
cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:8766 wazap
```

Set `WAZAP_PUBLIC_URL=https://wazap.example.com` for OAuth and keep `cloudflared` running the way you keep wazap running (a systemd unit, a launchd agent). `--no-autoupdate` leaves updates to your package manager: a self-update restarts the tunnel whenever it lands, cutting off every call it carries. Tailscale Funnel or ngrok work the same way: whatever ends at `https://your-host` with `/mcp` behind it.

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
- The OAuth routes (`/authorize`, `/token`, `/register`, `/revoke` and the
  consent page) read a body before anyone has signed in, so they refuse a
  compressed one (415) and one declared larger than 64 KiB (413) before
  reading a byte of it; a body sent without a length still meets the parsers'
  100 KiB limit.
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
