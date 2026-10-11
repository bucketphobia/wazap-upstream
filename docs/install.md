# Install and connect

Everything `npx wazap-mcp setup` does, one step at a time, plus the paths for
each harness and the skills that come with them. The short version is in the
[README](../README.md#get-started).

## Get started

The npm package is `wazap-mcp`; the command it installs is `wazap`.

```bash
npx wazap-mcp setup
```

That is the whole install. It links your account, finds the MCP clients
installed on this machine, writes their config, copies the five skills where
that client reads them, and tells you what to restart. At a terminal it is one
black, centered screen per step: ghosted ASCII logo, step number, then the
QR or the question. Piped output stays a log. When you
started through `npx`, `setup` offers to install wazap globally so Claude
Desktop and the background service have a path that does not change. It also
offers to `brew install` whisper-cpp, ffmpeg or Tailscale when a step needs one
and it is missing, and to restart Claude Desktop itself once it has connected it.

### Or the path your harness prefers

| Harness | Fastest path |
| --- | --- |
| Claude Code | `/plugin marketplace add razvangirgiz/wazap`, then `/plugin install wazap@wazap` |
| Claude Desktop | download `wazap-<version>.mcpb` from [Releases](https://github.com/razvangirgiz/wazap/releases) and double-click it |
| Gemini CLI | `npx wazap-mcp connect gemini` |
| Cursor | the [Install in Cursor](#other-mcp-clients) badge, then `npx wazap-mcp skills install cursor` |
| Codex CLI | `npx wazap-mcp connect codex`, then `npx wazap-mcp skills install codex` |
| A hosted agent (claude.ai, ChatGPT) | a URL it signs in to: [Keep it running](#keep-it-running) |
| Anything else | the MCP entry `npx -y wazap-mcp` over stdio |

Each local harness registers the server; a hosted agent gets a URL. Linking
the WhatsApp account is a separate, one-time step: `npx wazap-mcp login`.

Or have your agent do it. Paste this:

*Set up WhatsApp for me: run `npx wazap-mcp setup --agent` and follow what it prints.*

Then ask your agent: *"what did I miss on WhatsApp today?"*

Below are the steps `setup` runs for you. Each is still its own command when you
want to run it by hand.

`npx wazap-mcp login` shows a QR code; scan it from **Settings → Linked devices
→ Link a device**. No camera handy, or linking over SSH? `npx wazap-mcp login --phone +15550100`
prints an 8-character code you type under *Link with phone number instead*.
The QR is 32 rows tall, so its screen needs a window of about 36 rows. A shorter
window is told so instead of being shown half a code, and the question before it
offers the pairing code first; making the window taller draws the QR at once.
It ends by asking whether the agent may send messages; the answer is no unless
you say yes, and `npx wazap-mcp config writes on` changes it later.

`npx wazap-mcp connect claude-code` writes the MCP entry for one client. The
table under **Connect a client** has the rest.

`npx wazap-mcp` on its own is safe to run: it prints where you stand and what to do
next, and starts no server. When something is off, `npx wazap-mcp status` is the
first thing to run — it checks Node, the data directory, the lock, the
credentials and whether a newer version is out, and prints the fix next to
anything broken.

### Connect a client

`wazap connect <client>` writes the entry for you, keeping whatever else is in
the file and backing it up once before the first change. `--dry-run` shows what
it would write.

| Client | What `connect` writes |
| --- | --- |
| `claude-code` | runs `claude mcp add whatsapp` for you |
| `claude-desktop` | `claude_desktop_config.json` in the Claude application directory |
| `cursor` | `~/.cursor/mcp.json` |
| `codex` | `[mcp_servers.whatsapp]` in `~/.codex/config.toml` |
| `gemini` | `~/.gemini/settings.json` |
| anything remote | client's MCP URL field: `https://your-host/mcp`, signed in with [OAuth](self-host.md#hosted-agents-oauth) (see [Keep it running](#keep-it-running)) |

### Other MCP clients

Cursor installs from a link:

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.png)](cursor://anysphere.cursor-deeplink/mcp/install?name=whatsapp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIndhemFwLW1jcCJdfQ)

It carries the same entry `connect` writes; `node scripts/badges.mjs` reprints it.

Any other MCP client works the same way: the command is `npx -y wazap-mcp`, the
transport is stdio. Tell the agent to call `learn` first — it returns the id
formats, the workflows and every error code with what to do about it.

<details>
<summary>The raw entries, for editing by hand</summary>

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npx",
      "args": ["-y", "wazap-mcp"]
    }
  }
}
```

Claude Desktop, Cursor and Gemini CLI take exactly that. Codex CLI is TOML:

```toml
[mcp_servers.whatsapp]
command = "npx"
args = ["-y", "wazap-mcp"]
```

</details>

The `skills/` folder follows the [Agent Skills](https://agentskills.io) format, so Codex, Cursor and other skill-aware agents can load the same five skills.

### Claude Desktop, without a terminal

Download `wazap-<version>.mcpb` from [Releases](https://github.com/razvangirgiz/wazap/releases)
and double-click it. Claude Desktop installs the server, its Node dependencies
and the icon, and shows two settings: **Read-only**, ticked, and **Data
directory**, empty. `wazap connect claude-desktop` does the same job by editing
`claude_desktop_config.json`. Claude Desktop starts its servers without your
shell PATH, so that entry is the absolute path to `node` when wazap is installed
globally, and `npx` otherwise; `wazap setup` checks that the entry it wrote is
one Claude Desktop can actually launch.

Then ask Claude to link your WhatsApp. It calls `link_account` with your number,
hands back an 8-character code, and you type that code into **WhatsApp →
Settings → Linked devices → Link a device → Link with phone number instead**.
No terminal at any point. `npx wazap-mcp login` does the same job from a shell
when you have one.

Untick **Read-only** to let Claude send. It ships ticked because a bundle that
can message people from your number before you have said so is the wrong
default, and because the setting cannot be left unanswered: the manifest format
has no way to omit an argument, so the box you see is the answer the server gets.
`link_account` is registered either way. Read-only exists to stop Claude
messaging people from your number, and relinking your own dead session messages
nobody.

Build it yourself with `npm run bundle:mcpb`, which stages `dist/`, the
manifest, the icon and a fresh production `node_modules`, then packs them with
[`@anthropic-ai/mcpb`](https://github.com/modelcontextprotocol/mcpb).

### Keep it running

A wazap started by a client lives as long as that client does. Quit Claude Code
and the session is gone until you open it again. Two commands change that.
Staying up and being reachable are separate choices.

```bash
npx wazap-mcp service install
```

That writes a launchd agent on macOS (`~/Library/LaunchAgents/com.wazap.server.plist`)
or a systemd user unit on Linux (`~/.config/systemd/user/wazap.service`), starts
it, and waits for `/healthz` to answer. The unit runs `serve --http` on
`127.0.0.1:8766` with the absolute path of this Node and this install, so it
survives a reboot and a logout. Point any client at
`http://127.0.0.1:8766/mcp`, or keep using the stdio entry. A second wazap on
the same data directory becomes a bridge onto the session this one holds.

`service status` prints the pid, the health check and whether the unit still
runs the version you have installed. `service logs` tails it. `service restart`
picks up an upgrade; `service uninstall` removes the unit and leaves your
session and credentials alone. `wazap login` needs the session to itself, so it
stops the service, pairs, and starts it again on its own. `wazap logout` and
`wazap account` changes do not stop anything: the running server applies them.

What it costs to leave running: on one account holding some 20,000 messages,
the service sits between 50 and 180 MB of resident memory, the spread coming
from what it is doing — an idle connection is at the low end, a history sync, a
search or a catch-up at the high end. A local transcription or embedding model
is a separate process and is not counted in that.

The service recovers on its own. A dropped link is retried with a growing,
jittered wait (2 s up to 5 min). A watchdog notices what the socket does not
say: after a sleep it pings the link and replaces a dead socket at once, and it
replaces one stuck opening or one that stops answering pings. When ten tries in
a row fail (about 20 minutes) on every enabled account, wazap exits with code 3
and launchd or systemd starts a fresh process; the unit restarts it whatever
way it ended. An account that gives up while another is still up keeps trying
every 30 minutes instead. None of
this touches the linked session: only WhatsApp unlinking the device makes it
need linking again, and `get_status` and the webhook's
[`alert` event](api-and-webhooks.md#link-alerts) say so. An outage longer than
5 minutes, and its end, are told the same way.

A sleeping Mac is an offline wazap until it wakes. On a Mac mini kept as a
server: System Settings → Energy (Battery → Options on a laptop), turn on
"Prevent automatic sleeping when the display is off" and "Wake for network
access", and "Start up automatically after a power failure". The launchd agent
starts at login, so the Mac also needs to log in on its own after a restart.

A unit written by an earlier wazap keeps its old settings until you run
`npx wazap-mcp service install` again, which rewrites it: the launchd agent now
runs as a Standard process rather than a throttled Background one, and the
systemd unit never stops restarting after a burst of exits.

```bash
npx wazap-mcp expose
```

That gives the running service a public `https` URL, for agents that are not on
this machine: a cloud agent, claude.ai, ChatGPT. It uses Tailscale Funnel if
`tailscale` is installed, Cloudflare Tunnel if `cloudflared` is, opens the
tunnel, writes `WAZAP_PUBLIC_URL` and a fresh `WAZAP_OAUTH_PASSWORD` into
`<data-dir>/.env`, restarts the service and checks the URL from here. It then
prints the MCP URL and the password once.

Give an agent the URL only. It signs in on a consent page on your own host with
that password and picks read or read-and-send there; `wazap status` lists who
holds a grant. See [Hosted agents (OAuth)](self-host.md#hosted-agents-oauth) for what that
page does. `npx wazap-mcp expose off` takes the tunnel down and keeps the
password, so the next `expose` hands agents the same one.

`npx wazap-mcp setup` asks all of this once, as its fourth step.

### Upgrade

```bash
npx wazap-mcp update
```

One command for what used to be three. It compares this install against the
registry, installs the new package when wazap is global, restarts the service so
it runs the new code, and copies the new skills into every harness that keeps
them. `--dry-run` prints the plan and touches nothing.


## Skills

wazap ships five [Agent Skills](https://agentskills.io) that teach an agent the workflows behind the tools, not just the tools:

| Skill | What the agent does |
| --- | --- |
| `wazap-setup` | Diagnose with `wazap status`, link by QR or pairing code, connect a client with `wazap connect`, repair an expired session |
| `whatsapp-inbox` | "What did I miss?" Triage into *needs you / FYI / noise*, ranked, plus forgotten replies. Read-only |
| `whatsapp-recall` | "Find the invoice Dan sent." Search with query variants, page back in time, download and read the file. Read-only |
| `whatsapp-groups` | Catch up on a 300-message group: decisions, dates, what is asked of you. Read-only |
| `whatsapp-send` | Find who the user means, draft in the chat's own register, show recipient and text, send only after the user says yes |

`wazap setup` copies them into every client it connects, so there is usually
nothing to run. The command behind it, for a harness `setup` never offered or
for a checkout you want to install by hand:

```bash
npx wazap-mcp skills install codex     # or claude-code, cursor, agents
```

With no harness named it installs into every client it finds on this machine.
For Claude Code the other route is the plugin, which carries the server as well:

```
/plugin marketplace add razvangirgiz/wazap
/plugin install wazap@wazap
```

| Harness | Where the five directories land |
| --- | --- |
| `claude-code` | `~/.claude/skills/` |
| `codex` | `~/.agents/skills/`, the directory Codex documents for user skills. Cursor reads it too |
| `cursor` | `~/.cursor/skills/` |
| `agents` | `./.agents/skills/`, in the current project, for anything that reads the cross-tool convention |

Re-running overwrites, so an upgrade is the same command. `--dry-run` lists
what it would copy.

A client with no skills directory is not left out. The server registers each of
the five as an MCP prompt of the same name, and sends a short `instructions`
block that names all five and says when each applies, so an agent that never saw
the skill files still follows them. That is how Claude Desktop, Gemini CLI and
any client wired by hand get the workflows. A bridged session and a self-hosted HTTP server
carry them the same way.
