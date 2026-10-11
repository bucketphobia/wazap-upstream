# Data directory

Everything lives in `~/.wazap` (override with `--data-dir` or `WAZAP_DATA_DIR`),
created `0700` with credentials written `0600`. A data dir from before several
accounts moves into `accounts/default/` the first time a wazap command runs.

```
~/.wazap/
  accounts.json     which accounts exist, and which is default
  accounts.json.required  empty marker: missing policy must not reset permissions
  accounts/<id>/
    auth/           WhatsApp credentials — treat this like a password
    media/          files saved by get_media
    wazap.sqlite    the account database: chats, contacts, messages, reactions,
                    receipts, transcripts, notes, recall vectors, deletion
                    barriers, the webhook outbox (plus -wal and -shm beside it)
    previews/       one small JPEG per photo or video already previewed
    kept/           media kept as it arrived, so get_media outlives WhatsApp's copy
    qr.png          last QR, when login showed one
    legacy/         an earlier wazap's store.json, history/, retention.json,
                    notes.json and recall/, once imported; deleted a week later
    wazap.<time>.previous-owner.sqlite
                    the database a different number's link set aside; deleted a week later
    wazap.<version>.pre-migration.sqlite
                    the database as an upgrade found it, copied before it migrated;
                    deleted a week later
  legacy/           the 0.15 beta archive.sqlite, once imported; deleted a week later
  models/           whisper.cpp and embedding models, when transcription or recall run locally
  server.lock       pid of the running server
  daemon.json       loopback endpoint a second wazap bridges to
  control.json      private loopback line the CLI uses to change the running server
  oauth.json        registered agents and hashed OAuth grants, when OAuth is on
  .env              optional settings, see .env.example
  migration.json    written once when a flat dir moved into accounts/default
```

Credential writes go to a temp file and are renamed into place, so killing the
process mid-write cannot leave you re-linking your phone.

## The account database

Each account keeps what it has seen in one SQLite file, `wazap.sqlite` (`0600`,
in a `0700` folder), written with a full sync on every commit. Nothing of the
history is held in memory: every read, search and restart goes to the file, and
only small bounded caches stay in the process.

- **Upgrade.** A data dir an earlier wazap wrote has `store.json`, `history/`,
  `retention.json`, `notes.json`, `recall/` and perhaps the beta
  `archive.sqlite`. The first start imports them once, before the account is
  served; meanwhile its tools answer `NOT_CONNECTED` and `get_status` says it is
  preparing its database. A stop in the middle resumes where it left off at the
  next start. The import checks the database against what those files showed;
  a difference it cannot explain is logged by category and count, shown by
  `wazap status`, and the account is served from the database anyway. An
  unreadable `retention.json` stops the import, since history without its
  deletion barriers could bring deleted messages back. Once imported, the legacy
  files move into `legacy/` and are never read again; see
  [Upgrading to 0.22](#upgrading-to-022).
- **Logout** deletes the credentials, and nothing else: the database stays,
  tied to the number, so the same number linking again finds its history.
  **A different number linking** sets the earlier database aside as
  `wazap.<time>.previous-owner.sqlite` and starts an empty one: one person's
  history never shows under another's, and legacy files the earlier number
  never imported stay for it. When the earlier number links again, its
  set-aside database comes back. A set-aside file nobody links is deleted a
  week later; `WAZAP_RETENTION=1` does not shorten that week.
  **`wazap account remove`** stops the account, closes its database and deletes
  the whole folder with it.
- **`WAZAP_PERSIST_HISTORY=0`** removes every stored message at each start and
  stop, whatever `WAZAP_RETENTION` says, and with them every draft and the words
  of every send record; chats, contacts, notes, deletion barriers and the send
  records themselves stay, and recall is off.
- **A schema upgrade copies the file first.** When a start finds a database an
  older wazap wrote, it writes `wazap.<old version>.pre-migration.sqlite` beside
  it — the file as it was, whole — and only then migrates. If the copy cannot be
  taken (no disk space, a folder it cannot write), the upgrade does not start and
  the error says why; `WAZAP_PRE_MIGRATION_BACKUP=0` upgrades without one. The
  copy is deleted a week later at a start, at once with `WAZAP_RETENTION=1`, and
  never while the upgrade it belongs to has not landed. `wazap status` shows it.
  It holds every message the account had at that moment, unencrypted: a message
  deleted afterwards is still in the copy until the copy goes.
- **`wazap backup <path>`** writes one copy of an account database where you ask
  — `0600`, the whole account, `--account <id>` for a particular one, `--force`
  to replace a file already there. It is taken online and read-only, so it works
  with the server running or stopped and never migrates or changes the database;
  it refuses to write over the live file or a link to it. **The copy is not
  encrypted and holds every message the account has.** Restoring one is putting
  it back as `accounts/<id>/wazap.sqlite` with the server stopped.

- **`wazap status`** reads each database read-only, with the server running or
  not: whether it is preparing (and the import phase), ready or imported with
  unexplained differences, its size, messages, chats and embedding queue, the
  legacy files and when they go, set-aside databases, the copy an upgrade left
  and the beta archive. `--json` carries the same as `storage`.

## Kept media

WhatsApp drops old attachments from its servers, and a file it no longer has
cannot be downloaded: `get_media` says `MEDIA_UNAVAILABLE`. So the server
(`wazap serve`) downloads the media of the chats you choose the moment it
arrives, and keeps it in `accounts/<id>/kept/` (`0600` files in a `0700`
folder). `get_media` serves that copy first, with or without a link to
WhatsApp, and says so with `source: "kept"`; a voice note's transcript is made
from it too, even with the link down, and so is a photo's preview while linked. Without a copy it downloads from WhatsApp
as before (`source: "whatsapp"`), and keeps what it downloaded when the
settings want it.

- **Which media.** By default the photos, voice notes, audio and documents of
  every direct or group chat that is not muted (`WAZAP_MEDIA_KEEP=unmuted`);
  `all` takes muted chats too, `chats` only the ones in
  `WAZAP_MEDIA_KEEP_CHATS`, and `WAZAP_MEDIA_KEEP_TYPES` adds video or
  stickers. Channels and broadcast lists are kept only when listed in
  `WAZAP_MEDIA_KEEP_CHATS`, which also keeps a listed chat while it is muted.
  Stories and view-once media are never kept.
- **When.** What arrives live is downloaded at once, one file at a time. When
  the server connects, and whenever the queue of 200 downloads was full, what
  arrived in the last two days that the settings want and nothing kept yet is
  fetched as well. A download cut short (the link dropped) is tried again at
  the next of those, up to three times; one WhatsApp no longer has, or that is
  too big, is not.
- **Bounded.** No file over `WAZAP_MEDIA_KEEP_MAX_MB` (16 MB). All kept files
  of an account together stay under `WAZAP_MEDIA_KEEP_QUOTA_MB` (1 GB): the
  oldest are removed first to make room. A file kept longer than
  `WAZAP_MEDIA_KEEP_DAYS` (90) is removed at start and hourly. Nothing is
  written that would leave the disk with less than 1 GB, or 5% of it, free; the
  log says so once.
- **A file goes with its message.** Each kept file is recorded against its
  message in the database, so a delete for everyone, an expiry under
  `WAZAP_RETENTION=1`, a cleared or deleted chat and `WAZAP_PERSIST_HISTORY=0`
  remove it through the same crash-safe queue as previews. Nothing is kept with
  `WAZAP_PERSIST_HISTORY=0`.
- **Across restarts.** The files and their records survive a restart, and a
  move of the data dir: a record is matched by its file's name in the kept
  folder, wherever the data dir is now. A file is written under a temporary
  name and recorded only once it is whole, so a crash leaves at most a file
  nobody recorded, which the next start removes; a record whose file has gone
  is forgotten. That start-up sweep removes only files named the way wazap
  names kept files, so anything else you put in `kept/` stays. A kept file that no longer matches
  the hash the sender stated is not served: WhatsApp is asked instead.
- **Turning it off.** `WAZAP_MEDIA_KEEP=off` keeps nothing new and removes the
  copies kept earlier at the next start. A value that does not parse keeps
  nothing new and removes nothing, with a warning at startup. A short-lived
  command (`wazap status --live`, `contacts resync`) neither downloads nor
  removes.

The quota is shared by every kept chat, so anyone who can send you media in a
kept chat can push older files out by sending a lot of it; the chats that
matter most are safest under `WAZAP_MEDIA_KEEP=chats`.

Kept files are copies of what people sent you, unencrypted on your disk like
the database. `wazap backup` copies the database only. A restored database
forgets the kept files it no longer finds, and the files kept after the backup
was taken are removed at the next start, since no record names them; the same
goes for a different number linking, whose fresh database records none.

## Upgrading to 0.22

0.22 moves each account from its files to the account database, once.

1. **The first start imports.** Each account imports `store.json`, `history/`,
   `retention.json`, `notes.json`, `recall/` and, for the number it is linked
   to, the 0.15 beta `archive.sqlite`. Until that is done the account's tools
   answer `NOT_CONNECTED`, and `get_status` and `wazap status` say it is
   preparing, with the phase it reached. A stop resumes at the next start. An
   account not linked at the upgrade imports the beta archive at the first
   start after its number links.
2. **The files move aside.** Once imported, an account's files move into
   `accounts/<id>/legacy/`, and the beta archive into `<data-dir>/legacy/` once
   every enabled account linked to its number has imported it. They are deleted
   a week after the move (`wazap status` shows the date), or at once with
   `WAZAP_RETENTION=1`. Only what wazap moved is deleted. An import whose check
   found differences it could not explain keeps its files until you delete
   them, and `wazap status` says how. A beta archive nobody linked to its
   number has imported stays where it is.

### Rolling back to 0.21

A rollback trades what happened since the upgrade for the old files, and is
only possible while those files exist.

- **What you lose on 0.21:** every message, edit, reaction and note from the
  time you ran 0.22, and every deletion made then. Messages deleted while you
  ran 0.22 show again on 0.21, because its files predate the deletion.
- **When you cannot:** with `WAZAP_RETENTION=1` (the files were deleted at the
  upgrade), and once the week after the move is over. `wazap status` tells you
  whether `legacy/` still exists.

In this order:

1. Stop the server: `wazap service stop`, or stop the process that runs it.
2. Back up the whole data dir (`cp -a ~/.wazap ~/.wazap-backup`) and keep that
   copy until you are sure.
3. For each account, move everything in `accounts/<id>/legacy/` back into
   `accounts/<id>/`. Leave `wazap.sqlite` where it is: 0.21 ignores it.
4. Install 0.21.0 (`npm i -g wazap-mcp@0.21.0`) and start it.

To upgrade again later: stop the server, move `wazap.sqlite` with its `-wal`
and `-shm` out of `accounts/<id>/` (into your backup; do not delete it, it
holds what arrived while you ran 0.22), put the beta archive back at
`<data-dir>/archive.sqlite` if you want it imported again, and start 0.22. It
imports the files as 0.21 left them. Never remove `wazap.sqlite` while part of
the legacy files is still in `legacy/` or already deleted: the next start would
build the account from what is left.

## Deleted and disappearing messages

An observed delete or revoke tombstones the message in the database in one
transaction: its text, protobuf, transcript, reactions, votes, receipts and
recall vector go, a reply quoting it loses the quoted copy, and reads stop
showing it at once. Its preview file and its [kept copy](#kept-media) are
removed through a queue kept in the database, so a crash between the two
finishes the removal at the next start. Successful delete/clear tools wait for that cleanup; a disk failure is
reported even if WhatsApp already accepted the deletion. Pending
preview/transcription results cannot restore a deleted message. A revoke only
ever removes a message in the chat it arrived in. Chat metadata never keeps an
embedded copy of a message.

The tombstones and each chat's clear time are the barriers: message IDs and
times, no bodies. They keep replay and backfill from resurrecting a deleted
message, and they remain even with `WAZAP_PERSIST_HISTORY=0`. Clearing a chat
hides it at once and purges it in chunks that resume after a crash; backfill
dated at or before the local clear time is refused. WhatsApp timestamps have
second precision, so a message in the same second can be suppressed. A
database that cannot be opened keeps the account from being served rather than
replay deleted messages.

### Strict retention (`WAZAP_RETENTION=1`, off by default)

Without it, wazap keeps what it has seen, as before 0.21: disappearing-message
timers are not enforced locally. With it:

- For messages carrying disappearing-message metadata, wazap keeps the earliest
  observed deadline across edits, aliases, backfill and restarts. Reads refuse
  the message at that instant; one background timer per account tombstones it
  in the database the way a deletion does. Preview/transcription results,
  forwards, quoted replies and queued/retried webhooks recheck retention before
  publication. Already-started operations cannot be recalled.
- The policy is conservative: a marked ephemeral message without a computable
  deadline is refused, and **keep-in-chat hints are not an indefinite exemption**.
  Current chat settings are not retroactively applied to unmarked messages. Keep
  the system clock synchronized.
- A text-only row carried over from an older recall index keeps the deadline
  the legacy files knew for it; one they knew none for stays.

The database overwrites what it deletes (`secure_delete`), but this is not
secure erasure of heap pages, backups or filesystem snapshots. Explicit exports,
independent quotes/forwards and data already returned or sent are not recalled.
While wazap is stopped or suspended, disk cleanup waits until it runs again. Old
unrecorded deletions cannot be reconstructed. See [the audit report](security-audit.md).
