```
╭───────────────╮
│        ▄██▀   │   ██╗    ██╗ █████╗ ███████╗ █████╗ ██████╗
│      ▄██▀     │   ██║    ██║██╔══██╗╚══███╔╝██╔══██╗██╔══██╗
│    ▄███████▀  │   ██║ █╗ ██║███████║  ███╔╝ ███████║██████╔╝
│       ▄██▀    │   ██║███╗██║██╔══██║ ███╔╝  ██╔══██║██╔═══╝
│     ▄█▀       │   ╚███╔███╔╝██║  ██║███████╗██║  ██║██║
╰─╮╭────────────╯    ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝
  ╰╯                WhatsApp for your AI agent.
```

[![npm](https://img.shields.io/npm/v/wazap-mcp)](https://www.npmjs.com/package/wazap-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![M8ven Score](https://m8ven.ai/badge/mcp/razvangirgiz/wazap)](https://m8ven.ai/mcp/razvangirgiz/wazap)

**wazap** is an MCP server for your own WhatsApp account. It links as a device,
the way WhatsApp Web does, keeps what it sees on your machine, and gives any
MCP client — Claude, ChatGPT, Gemini, Cursor, Codex — 21 tools over your chats,
messages, media, contacts and groups.

You stop opening WhatsApp to find things and ask instead:

- *"What did I miss on WhatsApp today?"* — one answer across every linked
  account: who is waiting on you, mentions, missed calls, busy groups condensed.
- *"Find the invoice Dan sent in spring."* — search by meaning and by words at
  once, then open the file.
- *"What did the voice note from mama say?"* — voice notes come back as text.
- *"Tell Ana I'll be twenty minutes late."* — you see the recipient and the
  exact words first. Nothing leaves until you say yes.

No browser, no business account, no third-party service. There is no wazap
cloud: it runs where you run it.

## Get started

You need Node.js 22.16+ on the 22 line, or 24+, and a phone with WhatsApp.

```bash
npx wazap-mcp setup
```

`setup` links your account, finds the MCP clients installed on this machine
(Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI), writes their config,
installs the five skills where the client reads them, and tells you what to
restart. Then ask your assistant: *"what did I miss on WhatsApp today?"*

Rather let your agent do it? Paste this into it:

> Set up WhatsApp for me: run `npx wazap-mcp setup --agent` and follow what it prints.

`npx wazap-mcp` on its own, in a terminal, starts nothing: it prints where you
stand and the next command. When something is off, `npx wazap-mcp status` is
the first thing to run; it prints a fix next to anything broken.

### Per client

| Client | Fastest path |
| --- | --- |
| Claude Code | `/plugin marketplace add razvangirgiz/wazap`, then `/plugin install wazap@wazap` |
| Claude Desktop | download `wazap-<version>.mcpb` from [Releases](https://github.com/razvangirgiz/wazap/releases) and double-click it |
| Cursor | the badge below, then `npx wazap-mcp skills install cursor` |
| Codex CLI | `npx wazap-mcp connect codex`, then `npx wazap-mcp skills install codex` |
| Gemini CLI | `npx wazap-mcp connect gemini` |
| claude.ai, ChatGPT, other hosted agents | a URL they sign in to with OAuth: see [Remote access](#remote-access) |
| Anything else | command `npx -y wazap-mcp`, transport stdio |

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.png)](cursor://anysphere.cursor-deeplink/mcp/install?name=whatsapp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIndhemFwLW1jcCJdfQ)

The hand-written entry, for any client that takes the usual JSON:

```json
{
  "mcpServers": {
    "whatsapp": { "command": "npx", "args": ["-y", "wazap-mcp"] }
  }
}
```

Every step `setup` takes, each file `connect` writes, and upgrading are in
[docs/install.md](docs/install.md).

## Linking your account

Linking is a one-time step. `setup` does it for you; on its own it is:

```bash
npx wazap-mcp login                      # QR code: Settings → Linked devices → Link a device
npx wazap-mcp login --phone +15550100    # pairing code instead, no camera needed
```

With `--phone`, wazap prints an 8-character code. On the phone, go to
**WhatsApp → Settings → Linked devices → Link a device → Link with phone number
instead** and type it in. The pairing code works over SSH and on a headless
server, where a QR is impractical.

An assistant can link the account itself, too: the `link_account` tool returns
the same code, so a Claude Desktop user never needs a terminal.

Several WhatsApp accounts can live in one wazap (`wazap account add <id>`, then
`wazap login --account <id>`); see [docs/accounts.md](docs/accounts.md).

## The 21 tools

What every argument means, and every error code, is in
[docs/tools.md](docs/tools.md). The assistant gets all of it by calling `learn`.

| Tool | Kind | What it does |
| --- | --- | --- |
| `learn` | read | The guide to every tool, id format, workflow and error code. Call it first. |
| `get_status` | read | Connection, sync, linked accounts, how fresh the history is, webhook delivery, versions. |
| `link_account` | read | Link an account from the assistant; returns the 8-character code to type into the phone. |
| `list_chats` | read | Conversations newest-first: `all`, `unread`, `groups`, `individual` or `archived`. |
| `read_messages` | read | One chat, paging back into the phone's history; `chat_id: "status"` reads the stories. |
| `catch_up` | read | "What did I miss?" across every account, in one call and within a token budget. |
| `search` | read | Messages by meaning and by words at once, narrowed by chat, sender or date. |
| `get_message` | read | One message in full: its quote, reactions and who left them, poll votes, delivery and read receipts. |
| `find_contact` | read | Who "mama", a nickname, a group name or a number means, before anything is drafted. |
| `list_contacts` | read | The phone's address book a page at a time: saved name, number, when you last talked. |
| `get_group_info` | read | Participants, admins, group settings, the invite link for an admin. |
| `get_media` | read | A voice note as its transcript, a photo as an image, any file saved to disk; served from the copy kept on arrival first. |
| `wait_for_messages` | read | Block up to 55 s until a message arrives, with a cursor so nothing is missed between calls. |
| `remember` | local | A note, tags or details about a person, kept on this machine. Nothing changes on WhatsApp. |
| `send_message` | write | Draft a message, media, poll, location or forward — and send nothing. |
| `confirm_send` | write | Send that draft, once, after the user has seen the preview and said yes. |
| `edit_message` | write | Edit your own message, within WhatsApp's 15-minute window. |
| `react_to_message` | write | Add or remove an emoji reaction. |
| `delete_message` | write | Delete for everyone (your own message, or anyone's in a group you admin), or only on this account. |
| `manage_chat` | write | Archive, pin, mute, mark read or unread, star, clear, delete, block. |
| `manage_group` | write | Create, join, rename, add, remove, promote, invite links, join requests, settings, leave. |

Two features are off by default and can run entirely on your machine:
**voice transcription** with whisper.cpp ([docs/voice.md](docs/voice.md)) and
**semantic recall**, so `search` matches meaning and not only words
([docs/recall.md](docs/recall.md)). Turn them on with
`wazap config transcribe local` and `wazap config recall local`.

## Skills

Tools say what is possible; the five [Agent Skills](https://agentskills.io) in
[`skills/`](skills) say how to do the job well.

| Skill | What the agent does |
| --- | --- |
| `whatsapp-inbox` | Triage: needs you / FYI / noise, plus replies you forgot. Read-only. |
| `whatsapp-recall` | Find an address, an invoice, a photo, a thing someone said. Read-only. |
| `whatsapp-groups` | Catch up on a busy group: decisions, dates, what is asked of you. Read-only. |
| `whatsapp-send` | Find who you mean, draft in the chat's own tone, show it, send on a yes. |
| `wazap-setup` | Diagnose, link or repair the connection. |

`setup` installs them for Claude Code, Codex and Cursor
(`npx wazap-mcp skills install <harness>` does it by hand). Every other client
gets the same five as MCP prompts from the server, with nothing to install.

## Transports

**stdio** is the default: the client starts `npx -y wazap-mcp` and talks to it
over stdin/stdout. Nothing listens on the network.

**HTTP** (Streamable HTTP) is for a server that outlives the client, or one
another machine reaches:

```bash
npx wazap-mcp serve --http                 # http://127.0.0.1:8766/mcp, health at /healthz
```

`--host`/`--port` (or `WAZAP_HOST`/`WAZAP_PORT`) move it. wazap refuses to bind
anything but loopback without `WAZAP_READ_TOKEN`. Clients authenticate with a
static bearer token (`WAZAP_READ_TOKEN`, plus `WAZAP_WRITE_TOKEN` for the write
tools) or with OAuth 2.1, which wazap serves itself. Details in
[docs/self-host.md](docs/self-host.md).

### Remote access

Two commands keep wazap running and reachable from hosted agents:

```bash
npx wazap-mcp service install   # a launchd agent (macOS) or systemd user unit (Linux)
npx wazap-mcp expose            # a public https URL through Tailscale Funnel or Cloudflare Tunnel
```

`expose` prints the URL and a consent password. Give the agent only the URL;
it registers itself, and the consent page asks you for the password and
whether that agent may only read or also send. See
[Keep it running](docs/install.md#keep-it-running).

## Deployment

On a server of your own, the session never leaves it. With Docker (images for
amd64 and arm64 at `ghcr.io/razvangirgiz/wazap`):

```bash
mkdir wazap && cd wazap
curl -fsSLO https://raw.githubusercontent.com/razvangirgiz/wazap/main/docker-compose.yml
printf 'WAZAP_READ_TOKEN=%s\nWAZAP_WRITE_TOKEN=%s\n' $(openssl rand -hex 32) $(openssl rand -hex 32) > .env
docker compose run --rm wazap login --phone +15550100   # once; the session lands in the volume
docker compose up -d
curl -s http://127.0.0.1:8766/healthz
```

The container publishes port 8766 on loopback only; put TLS in front
([`deploy/Caddyfile`](deploy/Caddyfile) is two lines). A systemd unit is in
[`deploy/wazap.service`](deploy/wazap.service). Both setups, reverse-proxy
trust and the OAuth server are in [docs/self-host.md](docs/self-host.md).
Calling wazap from your own product, and receiving signed webhooks for incoming
messages, is in [docs/api-and-webhooks.md](docs/api-and-webhooks.md).

## Configuration

Every setting is optional. They are environment variables, read from the
process or from `~/.wazap/.env` (a real environment variable wins, a flag wins
over both). You rarely edit them by hand: `wazap config` shows the effective
settings and changes one.

| Setting | Default | What it does |
| --- | --- | --- |
| `WAZAP_DATA_DIR` | `~/.wazap` | Where credentials, databases and models live (`--data-dir` too). |
| `WAZAP_READ_ONLY` | unset | `1` does not register the write tools at all. `wazap config writes on\|off`. |
| `WAZAP_PERSIST_HISTORY` | `1` | `0` keeps no messages on disk across restarts. |
| `WAZAP_HOST` / `WAZAP_PORT` | `127.0.0.1` / `8766` | Where `serve --http` listens. |
| `WAZAP_READ_TOKEN` / `WAZAP_WRITE_TOKEN` | unset | Static bearer tokens for HTTP; only the write token gets the write tools. |
| `WAZAP_PUBLIC_URL` / `WAZAP_OAUTH_PASSWORD` | unset | Both together turn on OAuth for hosted agents. `wazap expose` sets them. |
| `WAZAP_TRANSCRIBE` | `off` | `local` (whisper.cpp) or `openai` (an OpenAI-compatible API). |
| `WAZAP_RECALL` | `off` | `local` turns on semantic search with a local embedding model. |
| `WAZAP_WEBHOOK` | `off` | `on` posts incoming messages to `WAZAP_WEBHOOK_URL`, signed with `WAZAP_WEBHOOK_SECRET`. |
| `WAZAP_MEDIA_KEEP` | `unmuted` | Which chats' media is downloaded on arrival and kept, so `get_media` outlives WhatsApp's copy: `unmuted`, `all`, `chats` or `off`. Limits: `WAZAP_MEDIA_KEEP_MAX_MB`, `WAZAP_MEDIA_KEEP_QUOTA_MB`, `WAZAP_MEDIA_KEEP_DAYS`. |

The full list, including the webhook filters, kept-media limits, retention and proxy trust, is in
[docs/settings.md](docs/settings.md); [`.env.example`](.env.example) is the
same list as a commented file.

## Security and privacy

- **Nothing is sent without a yes.** `send_message` only drafts: it returns the
  recipient and the exact text and touches no network. Only `confirm_send`
  sends, and a draft goes out at most once, even across a crash. Draft-then-
  confirm is a workflow, not proof of consent: an agent can call both tools
  unless your client makes you approve the second one.
- **Read-only is a real switch.** With `WAZAP_READ_ONLY=1`, `--read-only` or
  `wazap config writes off`, the write tools are not registered, so the
  assistant cannot message anyone even by mistake. The Claude Desktop bundle
  ships with read-only ticked.
- **Recipients can be pinned.** `wazap config send allow +15550100,…` limits an
  account to a list, `deny` refuses the ones named; both are checked at draft and again at
  send ([docs/send-rules.md](docs/send-rules.md)).
- **Writes are rate limited**, 20 a minute per account by default, because
  sending faster than a human is how numbers get banned.
- **Your data stays on your machine.** Credentials, messages, media and notes
  live in `~/.wazap` (`0700`, credential files `0600`). No account, no telemetry.
  What leaves the machine: WhatsApp traffic; the npm registry, for the version
  check; Hugging Face, when you download a transcription or embedding model; a
  transcription API, only if you chose `openai`; your own webhook, if you set
  one ([docs/data.md](docs/data.md)).
- **Some people can be kept out.** Tag a contact `#private` and their words stay
  out of everything the assistant did not ask about them by name, and out of
  the webhook. `#no-catchup` keeps their chat out of `catch_up`.
- **What it does not do.** No bulk send, no scheduler, no campaigns. It never
  marks anything read on its own, and sends text without link previews, so
  nothing fetches the pages you link.

Threat model, findings and the limits of each of these:
[docs/security-audit.md](docs/security-audit.md).

## Known limitations

- **The protocol is unofficial.** wazap is built on
  [Baileys](https://github.com/WhiskeySockets/Baileys), a reverse-engineered
  implementation of WhatsApp's multi-device protocol. It is not the WhatsApp
  Business API and Meta does not support it. A protocol change can break wazap
  until Baileys catches up, and an account that sends in bulk or to people who
  did not ask can be restricted or banned. The safeguards above reduce that
  risk; they do not remove it, and the risk is yours.
- **Model behaviour is measured on Claude only.** The evaluation in `eval/`
  (58 cases, each run three times) has been run on Claude. Other clients get
  the same tools and the same server-side guards, but nobody has measured how
  their models use them. The manual protocol for ChatGPT is
  `eval/chatgpt-protocol.md`.
- **History is what the phone syncs** to a linked device, not your whole
  archive. `read_messages` with `before` asks the phone for more, within what
  WhatsApp still keeps.
- **Old media expires.** WhatsApp drops old attachments from its servers;
  `get_media` then returns `MEDIA_UNAVAILABLE`, unless wazap
  [kept a copy](docs/data.md#kept-media) when it arrived. By default it keeps
  the photos, voice notes, audio and documents of unmuted chats, up to 16 MB
  each, 1 GB in all and 90 days, while `wazap serve` runs; media that arrived
  and expired while nothing was keeping it cannot be brought back.
- **Names come from the phone's address book**, which WhatsApp only sends to a
  fresh connection. If contacts read as numbers (`contacts_named: 0` in
  `get_status`), `wazap contacts resync` asks again while no server runs.
- **`@lid` ids.** Newer accounts are addressed by a privacy id; wazap maps it
  back to a number when it has learned the mapping.
- **Calls are WhatsApp calls only**, and a call that starts and ends while
  wazap is stopped may be missing. Cellular calls are never visible.
- **The phone must stay reachable.** A linked device stops receiving once the
  phone has been offline too long; `get_status` says so.

What the 1.x line promises not to break is in [docs/stability.md](docs/stability.md).

## Documentation

| | |
| --- | --- |
| [docs/install.md](docs/install.md) | `setup` step by step, each client, the background service, `expose`, upgrading, skills |
| [docs/tools.md](docs/tools.md) | The 21 tools in full, the workflows, every error code |
| [docs/accounts.md](docs/accounts.md) | Several WhatsApp accounts, several MCP clients on one server |
| [docs/voice.md](docs/voice.md) | Voice notes as text: whisper.cpp locally, or an OpenAI-compatible API |
| [docs/recall.md](docs/recall.md) | Semantic search with a local embedding model |
| [docs/data.md](docs/data.md) | The data directory, `wazap backup`, retention, deleted and disappearing messages |
| [docs/send-rules.md](docs/send-rules.md) | Read-only mode, per-account send rules, rate limits |
| [docs/self-host.md](docs/self-host.md) | HTTP mode, systemd, Docker, tunnels, proxy trust, OAuth |
| [docs/api-and-webhooks.md](docs/api-and-webhooks.md) | Static tokens in, signed webhook events out |
| [docs/settings.md](docs/settings.md) | Every `WAZAP_*` setting and its default |
| [docs/security-audit.md](docs/security-audit.md) | The security audit |
| [docs/stability.md](docs/stability.md) | What 1.0 promises to keep stable |
| [CHANGELOG.md](CHANGELOG.md) | Release by release |

## Contributing

```bash
git clone https://github.com/razvangirgiz/wazap && cd wazap
npm ci
npm run check                  # lint, typecheck, then build and test
node test/smoke-stdio.mjs      # drives the built binary over MCP stdio
npm run dev -- status          # run from source with tsx
```

The tests need no WhatsApp account. [CLAUDE.md](CLAUDE.md) is the contributor's
map: layout, the rules that must never break, and the release procedure.
Issues and pull requests are welcome at
[github.com/razvangirgiz/wazap](https://github.com/razvangirgiz/wazap).

## License

[MIT](LICENSE) © Răzvan Girgiz
