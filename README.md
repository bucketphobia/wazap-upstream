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

[![M8ven Score](https://m8ven.ai/badge/mcp/razvangirgiz/wazap)](https://m8ven.ai/mcp/razvangirgiz/wazap)

**WhatsApp for your AI assistant.** wazap is an MCP server that puts your own
WhatsApp account — chats, messages, media, contacts, groups — behind 21 tools
any MCP client can call, so Claude, ChatGPT, Gemini, Cursor or Codex can read
your inbox and draft your replies.

## What it does

It links your account as a linked device, the way WhatsApp Web does, and keeps
what it sees on this machine. Then you talk to your assistant instead of to a
tool:

- *"What did I miss on WhatsApp today?"* — one answer across every linked
  account: who is waiting on a reply, mentions, missed calls, groups condensed.
- *"Find the invoice Dan sent in spring."* — search by meaning and by words at
  once, then open the file.
- *"What did the voice note from mama say?"* — voice messages come back as
  text.
- *"Tell Ana I'll be twenty minutes late."* — the assistant shows you the
  recipient and the exact words, and nothing leaves until you say yes.

Built on [Baileys](https://github.com/WhiskeySockets/Baileys), which speaks the
WhatsApp multi-device protocol over a WebSocket. No browser, no phone-number
reseller, no account with us — there is no us: wazap runs on your machine.

## Get started

The npm package is `wazap-mcp`; the command it installs is `wazap`.

```bash
npx wazap-mcp setup
```

That is the whole install. It links your account, finds the MCP clients
installed on this machine, writes their config, copies the five skills where
that client reads them, and tells you what to restart.

Or have your agent do it. Paste this:

*Set up WhatsApp for me: run `npx wazap-mcp setup --agent` and follow what it prints.*

Then ask your assistant: *"what did I miss on WhatsApp today?"*

### Or the path your harness prefers

| Harness | Fastest path |
| --- | --- |
| Claude Code | `/plugin marketplace add razvangirgiz/wazap`, then `/plugin install wazap@wazap` |
| Claude Desktop | download `wazap-<version>.mcpb` from [Releases](https://github.com/razvangirgiz/wazap/releases) and double-click it |
| Gemini CLI | `npx wazap-mcp connect gemini` |
| Cursor | the [Install in Cursor](docs/install.md#other-mcp-clients) badge, then `npx wazap-mcp skills install cursor` |
| Codex CLI | `npx wazap-mcp connect codex`, then `npx wazap-mcp skills install codex` |
| A hosted agent (claude.ai, ChatGPT) | a URL it signs in to: [Keep it running](docs/install.md#keep-it-running) |
| Anything else | the MCP entry `npx -y wazap-mcp` over stdio |

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.png)](cursor://anysphere.cursor-deeplink/mcp/install?name=whatsapp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIndhemFwLW1jcCJdfQ)

Each local harness registers the server; a hosted agent gets a URL. Linking
the WhatsApp account is a separate, one-time step: `npx wazap-mcp login`, which
shows a QR code to scan from **Settings → Linked devices → Link a device**, or
prints an 8-character code with `--phone +15550100`.

`npx wazap-mcp` on its own is safe to run: it prints where you stand and what
to do next, and starts no server. When something is off, `npx wazap-mcp status`
is the first thing to run — and it is what tells you if the Node you have is
too old: wazap needs 22.16 or newer on the 22 line, or 24.

Every step `setup` takes, every client it can write, the background service and
the upgrade command are in **[docs/install.md](docs/install.md)**.

## The 21 tools

Each one in a line. What every argument means, the workflows behind them and
every error code are in **[docs/tools.md](docs/tools.md)**; the assistant
itself gets all of it by calling `learn` first.

| Tool | Kind | What it does |
| --- | --- | --- |
| `learn` | read | The guide to every tool, id format and error code. Call it first. |
| `get_status` | read | Connection, sync, linked accounts, how fresh the history is, webhook delivery, versions. |
| `link_account` | read | Pair an account from the assistant; returns the 8-character code to type into the phone. |
| `list_chats` | read | Conversations newest-first: `all`, `unread`, `groups`, `individual` or `archived`. |
| `read_messages` | read | Messages in a chat, paging back into the phone's history; `chat_id: "status"` reads the stories. |
| `catch_up` | read | "What did I miss?" across every account, in one call and within a token budget. |
| `search` | read | Messages by meaning and by words at once, narrowed by chat, sender or date. |
| `get_message` | read | One message in full: its quote, each reaction with who left it, poll votes, delivery and read receipts. |
| `find_contact` | read | Who "mama", a nickname, a group name or a number means, before anything is drafted. |
| `list_contacts` | read | The phone's address book a page at a time: saved name, number, and when you last talked. |
| `get_group_info` | read | Participants, admins, who may post or edit, join requests, invite link. |
| `get_media` | read | A message's media: a voice note as its transcript, a photo as an image, any file saved to disk. |
| `wait_for_messages` | read | Block up to 55 s until a message arrives, then return it with a cursor for the next call. |
| `remember` | local | Keep a note, tags and details about a person, on this machine only. Nothing changes on WhatsApp. |
| `send_message` | write | Draft a message, media, poll, location or forward — and send nothing. |
| `confirm_send` | write | Send that draft, once, after the user has seen the preview and said yes. |
| `edit_message` | write | Edit your own message, within WhatsApp's 15-minute window. |
| `react_to_message` | write | Add or remove an emoji reaction. |
| `delete_message` | write | Retract your own message for everyone, or delete any message for this account only. |
| `manage_chat` | write | Archive, pin, mute, mark read or unread, star, clear, delete, block. |
| `manage_group` | write | Create, join, rename, add, remove, promote, invite links, join requests, settings. |

Voice messages become text when you switch transcription on
([docs/voice.md](docs/voice.md)), and `search` matches meaning as well as words
when you switch semantic recall on ([docs/recall.md](docs/recall.md)). Both are
off by default and both can run entirely on this machine.

## Security and privacy

- **Nothing is sent without your yes.** `send_message` only drafts: it returns
  the recipient and the exact text and touches no network. Only `confirm_send`
  sends, and a draft goes out at most once, even across a crash. Draft-then-
  confirm is a workflow, not independent proof of consent: an agent can call
  both tools unless the harness makes you approve the second one.
- **Read-only is a real switch.** With `WAZAP_READ_ONLY=1`, or
  `wazap config writes off`, the write tools are not registered at all — the
  assistant never sees them, so it cannot message anyone from your number even
  by mistake. The Claude Desktop bundle ships read-only ticked.
- **Who an account may message** can be pinned to a list:
  `wazap config send allow +15550100,…`, or `deny` for the reverse. The rules
  are checked when a message is drafted and again when it is confirmed
  ([docs/send-rules.md](docs/send-rules.md)).
- **Writes are rate limited** to 20 a minute per account, because sending
  faster than a human is how accounts get banned.
- **The data stays here.** Credentials, messages, media and notes live in
  `~/.wazap`, `0700`, with credentials `0600`. There is no wazap account, no
  server of ours and no telemetry. What does leave the machine: WhatsApp
  itself; the npm registry, for the version check; Hugging Face, when you ask
  for a transcription or embedding model; the transcription API, only if you
  chose the `openai` provider instead of the local one; and your own webhook
  URL, if you configured one ([docs/data.md](docs/data.md)).
- **Some people can be kept out of it.** Tag someone `#private` and their words
  stay out of everything the assistant did not ask about them by name, and the
  outbound webhook never posts them. Tag them `#no-catchup` and their chat is
  skipped entirely.
- **What it does not do.** There is no bulk send, no scheduler and no campaign
  tool. It never marks anything read on WhatsApp on its own. Text it sends goes
  out without a link preview, and nothing — not wazap, not Baileys — fetches
  the page.

Findings, threat model and the limits of each of these are in
[docs/security-audit.md](docs/security-audit.md).

## Known limitations

- **The protocol is unofficial.** wazap talks to WhatsApp through
  [Baileys](https://github.com/WhiskeySockets/Baileys), a reverse-engineered
  implementation of the WhatsApp multi-device protocol. This is not the
  WhatsApp Business API, Meta does not support it, and WhatsApp can change the
  protocol without warning — a change can break wazap until Baileys catches up.
  An account that sends in bulk, or sends to people who did not ask to hear
  from it, can be restricted or banned, and that is not recoverable from here.
  What wazap does about it is the whole of the section above: sends are drafted
  and confirmed one at a time, writes are capped at 20 a minute per account, an
  account can be locked to a list of recipients or to reading only, and there
  is no bulk or scheduled send to reach for. None of that is a guarantee, and
  the risk is yours.
- **How a model behaves with the tools is measured on Claude only.** The
  evaluation of how an assistant uses them (`eval/`: 58 cases, each run three
  times, with the sends that must never happen counted apart) has been run on
  Claude. ChatGPT, Gemini,
  Cursor and Codex connect and get the same 21 tools, but nobody has measured
  them yet, so what the section above promises is the server's doing, not the
  model's. The manual protocol for ChatGPT is `eval/chatgpt-protocol.md`.
- **Media keys expire.** WhatsApp drops old attachments from its servers, so
  `get_media` on an old message returns `MEDIA_UNAVAILABLE`.
- **History is what the phone syncs.** wazap sees the history WhatsApp hands the
  linked device, not your full phone archive. `read_messages` with `before` asks
  for more, within whatever WhatsApp still keeps.
- **`@lid` ids.** Newer accounts are addressed by a privacy id rather than a
  phone number. wazap translates them back to phone numbers when it has learned
  the mapping, and passes the `@lid` through when it has not.
- **Names come from the phone's address book.** WhatsApp delivers it as an app
  state sync, and only to a connection asking for it from scratch. If contacts
  read as phone numbers and `get_status` shows `contacts_named: 0`,
  `find_contact` asks for it once, and `wazap contacts resync` asks again while
  no server runs.
- **Calls are WhatsApp calls only.** A call shows up as a message with
  `type: "call"`, carrying its kind, direction, outcome and duration. WhatsApp's
  own call log and the missed-call notices arrive on their own; a call that
  starts and ends while wazap is running is recorded live, so calls placed or
  received while it is stopped can be missing entirely. A cellular call from the
  phone's dialler is never visible, on any device.
- **Your phone must stay reachable.** A linked device stops receiving once the
  phone has been offline long enough; `get_status` says so in `hint`.

**What 1.0 guarantees** — which names, shapes and settings are promised not to
move, and which are not — is in [docs/stability.md](docs/stability.md).

## Documentation

| | |
| --- | --- |
| [docs/install.md](docs/install.md) | Every step of `setup`, each client `connect` writes, the background service, `expose`, upgrading, and the five skills |
| [docs/tools.md](docs/tools.md) | The 21 tools in full: catching up, finding people, sending once, keeping someone private, and every error code |
| [docs/voice.md](docs/voice.md) | Voice messages as text: whisper.cpp here, or an OpenAI-compatible API |
| [docs/recall.md](docs/recall.md) | Semantic recall: `search` by meaning, with a local embedding model |
| [docs/data.md](docs/data.md) | The data directory, the account database, `wazap backup`, the copy an upgrade takes, deleted and disappearing messages, and upgrading from 0.21 |
| [docs/accounts.md](docs/accounts.md) | Several WhatsApp accounts in one wazap, and several MCP clients on one server |
| [docs/send-rules.md](docs/send-rules.md) | Read-only mode, per-account send rules, link previews and media processing |
| [docs/self-host.md](docs/self-host.md) | HTTP mode, systemd, Docker, tunnels, reverse-proxy trust and the OAuth server hosted agents sign in to |
| [docs/api-and-webhooks.md](docs/api-and-webhooks.md) | Building a product on wazap: static bearer tokens in, signed webhook events out |
| [docs/settings.md](docs/settings.md) | Every `WAZAP_*` setting, its default and what sets it |
| [docs/security-audit.md](docs/security-audit.md) | The audit report |
| [CHANGELOG.md](CHANGELOG.md) | What changed, release by release |

## Development

```bash
npm install
npm run typecheck
npm test                       # builds, then runs node --test
node test/smoke-stdio.mjs      # drives the built binary over MCP stdio
npm run dev -- status          # run from source with tsx
```

`npm test` needs no WhatsApp session. The stdio smoke test spawns the built
binary against a throwaway data directory and checks that an unlinked install
still answers `initialize`, `tools/list` and `get_status`.

[CLAUDE.md](CLAUDE.md) is the contributor's map: the layout, the rules that must
never break, the release procedure and the knobs only tests use. Issues and
pull requests go to
[github.com/razvangirgiz/wazap](https://github.com/razvangirgiz/wazap).

MIT licensed.
