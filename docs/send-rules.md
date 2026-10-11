# Read-only mode, send rules and link previews

What stops a message going out: the server-wide read-only switch, the per-account
list of who may be messaged, and what wazap does not fetch on your behalf.

## Read-only mode

Writes are opt-in at `login` (the question defaults to no and stores the
answer in `<data-dir>/.env`). `wazap config writes on|off` changes it later.
`wazap config` and `wazap status` print the effective setting and where it
came from. If that line says off, write tools are not registered: run
`wazap config writes on` and restart the server.

An unset `WAZAP_READ_ONLY` and `WAZAP_READ_ONLY=0` both register write tools
(`wazap config` then says "writes: on"). `WAZAP_READ_ONLY=1` or
`wazap serve --read-only` does not register them at all. The agent never
sees them, so it cannot message anyone from your number even by mistake.

Writes are also rate limited to 20 a minute per account, or the account's
`rate_limit` in `accounts.json`. Sending faster than a human is how accounts
get banned. Marking a chat read (`manage_chat` `mark_read`) has a budget of its
own, three times that (60 a minute by default), so a program that marks each
chat read before it replies does not spend the sends' budget on it. It follows
the account's `rate_limit`, and is off when that is 0.

## Link previews and media processing

Text sent or edited by wazap goes out without a link preview, and nothing
fetches the page: not wazap, and not Baileys, whose own fetcher is kept off
explicitly on every send, confirm and edit. The link itself arrives intact, as
text. Forwarding an existing message may keep the preview already embedded in
it, without fetching it again.

Photo previews are decoded locally. Video frames, outgoing video thumbnails,
GIF conversion and local transcription use restricted ffmpeg inputs: local-file
protocol only, with a media-format allowlist that excludes playlists and image
sequences. GIF conversion also requires the GIF demuxer. An unavailable video
thumbnail does not fall back to Baileys's unrestricted ffmpeg command.

These checks are not a codec sandbox. Keep ffmpeg and image decoders updated;
exotic formats outside the allowlist may no longer work. Decoder errors omit
raw stderr, which can contain untrusted metadata or private content.

## Send rules

An account can also be limited in *who* it may message — the case where the
agent may send, but only to the people you run it for. The rules live on the
account record in `accounts.json` and are edited per account with
`wazap config send` (`--account` picks which; run without a verb to print them).
Entries are chat ids or numbers in international format, comma-separated:

- `wazap config send deny 40722123456,120363000000000001@g.us` refuses those
  recipients, whatever else is allowed.
- `wazap config send allow +15550100,40722123456` makes the list exhaustive —
  only those may be messaged. `allow none` locks the account to nobody.
- `wazap config send open` lifts every restriction.

The send tools check the rules when a message is drafted and again at
`confirm_send`, so a rule written while a draft waits still applies to it. A
scheduled message (`send_message` with `send_at`) is checked a third time when
it is due, against `accounts.json` as it is then: a rule written, writes turned
off, or the account disabled or removed after the yes refuses it, and it is
closed as failed with the code, never sent. A server started read-only sends
none of the scheduled messages a writable run left, and every one still goes
through the account's write rate limit when it is sent; see
[Scheduling a message](tools.md#scheduling-a-message). A
refused send fails `SEND_BLOCKED` naming the rule that fired; the agent is
told to tell you, not to retry or route around it.

Saving policy or starting the account hub writes an empty `0600`
`accounts.json.required` marker. If that known policy disappears, wazap refuses
unrestricted defaults. Restore the policy from a trusted backup. To start over
on purpose with one default account and no send rules, delete the marker too;
never do it just to get past the error. Fresh/legacy directories without a marker keep
their bootstrap behavior. Explicit layout rollback removes the modern registry
and marker; old flat-layout versions do not enforce per-account rules.

Every write tool checks the current disk policy before preparing work. Corrupt,
missing, disabled or newly read-only accounts refuse the write without consuming
an owned draft. Cached rules are not a fallback. The running account roster
follows the registry (see [Several accounts](accounts.md#several-accounts)); relaxing
startup read-only settings still needs a restart, and these checks cannot undo
an already-started operation. A registry that is missing or malformed is never
applied: the running roster stays as it was and the calls that need it fail. Malformed `WAZAP_READ_ONLY`
values are refused. Unset global settings still mean writes on; for a durable
account-level prohibition use `wazap config writes off --account <id>`.
