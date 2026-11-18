# Accounts and clients

One `wazap serve` holds every account in the data dir, and every MCP client on
the machine shares one server.

## Several accounts

One `wazap serve` holds every enabled account in the data dir. Each account is
its own Baileys socket and its own folder under `accounts/<id>/`. The first
account is `default`. Add another with `wazap account add work --name Work`,
then `wazap login --account work`.

`--account` picks one on `login`, `logout`, `status`, `config writes` and
`webhook test`. MCP tools take an optional `account_id`; `get_status` lists
every account when more than one is linked. A chat only one account knows selects that
account. A send to a chat no account knows, with two or more accounts, fails
`AMBIGUOUS_ACCOUNT` instead of falling back to default.

Reads without a chat and without `account_id` use the default account; the
response still carries `account_id`. `find_contact` is the exception: without
`account_id` it searches every account and labels what it finds. `link_account` needs an account that
already exists. Five accounts is advice, not a cap. One phone number is one
account.

A running server follows the registry; there is nothing to restart.
`wazap account add`, `enable`, `disable`, `default` and `remove` tell it at
once: an added or enabled account gets its socket, a disabled one is stopped
and tools that name it answer `ACCOUNT_DISABLED`, a removed one is stopped
before its folder is deleted. A tool that names an account the server has not
seen yet reads `accounts.json` again before answering `ACCOUNT_NOT_FOUND`, so
`account add` followed by `link_account` works even when nothing told the
server. The last account a server runs stays up until the server stops,
because a server with no enabled account refuses to start: `account disable`
says so, and `account remove` refuses it.

`wazap logout --account work` unlinks one account. With a server running it
asks that server to do it: the account's socket closes (a pairing in flight is
cancelled), WhatsApp is told to unlink the device, its credentials and chat
snapshot are deleted, and the account stays in the registry, not linked, ready
for `link_account` or `login`. The other accounts are not touched. Without
`--account`, logout is for the default account. With no server running, logout
does the same work itself.

The CLI reaches the running server over a private line, not the MCP endpoint:
a listener on an ephemeral `127.0.0.1` port and a random token, both written
to `<data-dir>/control.json` (`0600`) by the server as it starts. Nothing else
opens it — not `WAZAP_READ_TOKEN` or `WAZAP_WRITE_TOKEN`, not an OAuth grant,
not the bridge token in `daemon.json`, not an anonymous caller — and no tool
exposes it to an agent. A tunnel or proxy pointed at `WAZAP_PORT` never
reaches it. It is there whether or not the session is shared. A server started
by an older wazap has no such line: against it, account changes print a
restart hint, and `logout` and `account remove` work as they used to (stop the
`wazap service` around the logout, or refuse while another server runs).

An account can override the global webhook URL, secret and event list in
`accounts.json` (`webhook_url`, `webhook_secret`, `webhook_events`).
`wazap webhook test --account work` posts with that account's id and name.

## Several clients at once

Claude Desktop, Claude Code and Cursor each launch their own `wazap`. The first
one on a data directory owns every enabled account, each on its own socket, and
opens an MCP endpoint on `127.0.0.1`; every later one bridges to it over that
endpoint. There is nothing to configure, and no client can tell the difference.
The owner publishes `<data-dir>/daemon.json` (`0600`) with its pid, its port
and the token a bridge authenticates with.

A bridge serves whatever the owner exposes, so an owner started `--read-only`
makes every client read-only, whatever flags that client was launched with.

When the owner exits, the bridges exit with it, and the next `wazap` a client
starts becomes the new owner. Beside an installed service (`wazap service
install`) a bridge waits for the service to come back instead (a restart, an
update) and carries on, and calls made meanwhile answer `NOT_CONNECTED`.

`wazap proxy` is that waiting bridge on purpose, for an agent that runs wazap as
a subprocess next to the service (Hermes, a cron job): it never owns the
session, so it can never keep the service from starting, it needs no OAuth (it
reads the loopback token from `daemon.json`), and it reconnects whenever the
service restarts. A tool call in flight when the service went away is never
replayed: it answers `NOT_CONNECTED` with its outcome unknown. In the client's
config: command `wazap`, args `["proxy"]`.

An explicit `--http` is a server of its own rather than a bridge: a second one
on the same directory exits with code 2 naming the pid of the one already
running.
