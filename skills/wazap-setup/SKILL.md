---
name: wazap-setup
description: Install, link or repair the WhatsApp connection. Use when the user wants to connect WhatsApp to Claude, when a WhatsApp tool returns NOT_LINKED, SESSION_EXPIRED or SESSION_CORRUPT, when `get_status` is anything but connected, or when the user asks how wazap works with Claude Desktop, Claude Code or HTTP.
---

# wazap setup

wazap links the user's own WhatsApp account as a "linked device" and exposes it as MCP tools. The phone must stay online; the link needs the user's hands once.

## Diagnose first

Run `npx wazap-mcp status` and branch on its output. It never contacts WhatsApp, so it is safe at any point.

| `status` says | Do |
| --- | --- |
| `wazap: command not found` / npx fails | Node 22.16+ (or 24) is required. `node --version`; install from nodejs.org if older. |
| `linked: no` | Go to **Link**. |
| `linked: yes`, `server: running` | The server is up. If tools still fail, call `get_status` and follow its `fix`. |
| `linked: yes`, `server: not running` | Go to **Connect a client**. |

Below those lines is a `checks:` section. Every `✗` carries the command that
fixes it; run that command rather than improvising.

| `checks:` line | What it means |
| --- | --- |
| `✗ node` | The Node version is not supported: below 22.16 on the 22 line, or the 23 line, which lacks `node:sqlite` features wazap needs. Node 24 LTS or 22.16+ is what works; nothing else will until it is upgraded. |
| `✗ data dir` | Missing, not a directory, mode other than 0700, or not writable. The line names the `chmod` to run. |
| `– lock: stale` | A previous server died without cleaning up. Harmless; the next start reclaims it. |
| `✓ lock: held` | A server is running. Do not run `logout` or `status --live`; ask through the client with `get_status`. |
| `✗ credentials` | Unreadable. Call `link_account`, or `npx wazap-mcp logout` then `npx wazap-mcp login`. |
| `writes: off` | Write tools are not registered. Enabling them is **Allow writes**. |
| `– update` | A newer wazap exists, or the check could not reach npm. Never blocking. |

`npx wazap-mcp status --live` reaches WhatsApp for real and reports whether the
phone is reachable, how many chats synced and how old the last message is. It
refuses while a server holds the lock, because one process owns the session.
`--json` gives the same report as one object.

## Link

The account must already exist (`npx wazap-mcp account add <id>`). `link_account`
does not create one. When more than one account is configured, `get_status`
lists them under `accounts`; pass `account_id`. An unknown id is `ACCOUNT_NOT_FOUND`.

Inside an MCP client that already has the `whatsapp` tools, call `link_account`
with the user's number in international format. No terminal is involved. It
returns an 8-character code, and `get_status` reports `linking` with that code
until the phone accepts it. Tell the user: WhatsApp → Settings → Linked devices
→ Link a device → Link with phone number instead, then type the code. Poll
`get_status` every 10 seconds until it says `connected`, for up to 3 minutes.
Codes expire, so call `link_account` again for a fresh one if the status falls
back to `not_linked`.

Without those tools, run `npx wazap-mcp setup --agent` and follow what it prints.
That procedure starts `login` in the background and reads the
`pairing code: XXXX-XXXX` line out of its output, so the user is left with the
one part of linking a machine cannot do, typing the code into the phone.

At a terminal, `npx wazap-mcp login` asks whether to link with a QR or a pairing
code. The QR screen is 32 rows tall and needs a window of about 36; in a shorter
one it says so instead of drawing half a code, and offers the pairing code first.
When the user has no camera to hand or the window is short, run
`npx wazap-mcp login --phone +15550100`: it prints the 8-character code the user
types into the phone.

`SESSION_EXPIRED` means the phone removed the device, and `NOT_LINKED` that
nothing was ever linked. Both are `link_account`, or `npx wazap-mcp login` where
the tool is unavailable. `SESSION_CORRUPT` means unreadable credentials, which
`link_account` clears before it pairs; from a terminal that is
`npx wazap-mcp logout` then `npx wazap-mcp login`.

## Connect a client

Run `npx wazap-mcp connect <client>`, where the client is one of `claude-code`,
`claude-desktop`, `cursor`, `codex` or `gemini`. It writes the entry,
keeps whatever else is in the file, backs it up once, and prints the next step
(restart, reload window, or `claude mcp list`). Running it twice is safe.

- Add `--dry-run` first if the user wants to see the entry before it is written.
- Claude Code users can install this plugin instead, which registers the server.
- An agent on another machine (claude.ai, ChatGPT, a cloud agent) reaches wazap by URL: `npx wazap-mcp service install`, then `npx wazap-mcp expose`, and give the agent the URL only; the person signs in on its consent page. If `get_status` says write tools are missing, run `npx wazap-mcp config writes on` and restart the server.

Done when `get_status` returns `status: "connected"`. `learn` gives the id formats, the workflows and every error code, a topic at a time, whenever they are needed.

## Allow writes

Writes are on when `WAZAP_READ_ONLY` is unset (the same as `0`). The write
tools are missing only when someone turned them off: `WAZAP_READ_ONLY=1`,
`--read-only`, or `login` answering no, which persists `1` in
`<data-dir>/.env`. `npx wazap-mcp config` prints the effective setting and
where it came from.

Turn them on with `npx wazap-mcp config writes on`, off again with
`npx wazap-mcp config writes off`. A running server has to be restarted for
the change to take effect.

## Limits the user should hear once

Baileys is an unofficial WhatsApp client; Meta can flag accounts, so heavy automated sending is the user's risk. One process owns the session: two wazap servers on the same data dir refuse to start.
