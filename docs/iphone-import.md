# Import an iPhone archive

Restore history from an extracted WhatsApp iPhone `ChatStorage.sqlite` into an
already linked wazap account. Start with a text-only import, check its report,
and add voice transcription when you are ready. Existing messages and transcripts
win over archive content; source files are never rewritten or removed.

Choose either the explicit CLI command or automatic folder-drop import:

| Method | Activation | When it runs |
| --- | --- | --- |
| CLI | `wazap import ios <file>` | On demand, with the server stopped for writes |
| Folder drop | `WAZAP_IMPORT_IOS=1` and a selected archive in the account's import folder | At server startup; voice work follows connection, with a `local` provider only |

Automatic importing defaults off. The CLI works with `WAZAP_IMPORT_IOS=0`.

## Before importing

1. Link the target account to the phone number whose archive you are importing.
   Use the correct `--account <id>`; examples below use `default`.
2. Keep a backup of the original archive and the complete wazap data directory.
   A [database backup](data.md#the-account-database) alone does not include account
   credentials, media or the importer ownership file. Stop wazap before making
   a plain filesystem copy of the full data directory.
3. Prepare an extracted, unencrypted, standalone SQLite database. ZIP files,
   encrypted backups and other database layouts are not accepted directly.
4. Keep the extracted source stable while importing. Leave free space in the
   account's data directory for history and a temporary work index (a private
   `.ios-scratch-*` folder beside the account database; a run removes any more than a
   day old that an interrupted run left).
5. Keep history persistence enabled: `WAZAP_PERSIST_HISTORY=1` (the default).
6. Leave [strict retention](data.md#strict-retention-wazap_retention1-off-by-default)
   off. Imported messages carry no expiry, so with `WAZAP_RETENTION=1` the importer
   refuses to run (`retention_unsupported`) from both the CLI, dry runs included,
   and the folder drop. The CLI reads `WAZAP_RETENTION` from its own environment
   and `<data-dir>/.env`; the account database does not record the mode. Give a
   shell or one-off container the same value as the server.

A nonempty `ChatStorage.sqlite-wal` or `ChatStorage.sqlite-journal` causes refusal.
Committed messages may still exist only in a WAL file. **Do not delete companion
files to bypass this check.** Use your backup application's supported export or
SQLite tooling on a separate working copy to produce a complete, checkpointed
standalone export. Preserve the original database and all its companions.

Compatibility is based on the [source structure](#supported-source-structure),
not a tested list of every WhatsApp/iOS release. The importer does not decrypt,
extract or repair a backup.

## Import text with the CLI

The target account database must already exist. A dry run reads it without
creating or migrating it, does not change the archive selection or progress,
and makes no transcription calls:

```sh
wazap import ios /archive/ChatStorage.sqlite --account default --dry-run --json
```

Review the counts, then stop the server and run the writing command:

```sh
wazap import ios /archive/ChatStorage.sqlite --account default --json
```

Omitting `--media` keeps this command free of transcription calls. Start the
server again after the command finishes. Text-only CLI import does not require
an enabled transcription provider or automatic importer.

| Option | Use |
| --- | --- |
| `--account <id>` | Select the already linked target account |
| `--dry-run` | Inventory without writing import state or messages |
| `--json` | Print the aggregate report as one JSON line on stdout (no other summary is printed) |
| `--media <dir>` | Explicitly request voice transcription using extracted files |
| `--reset` | Reselect the archive and rebuild import progress; see [recovery](#resume-reset-and-change-archives) |

`--reset` cannot be combined with `--dry-run`. A writing command takes the same
exclusive data-directory lock as the server; stop every server using that data
directory first.

## Automatic folder-drop import

Set these in the server environment or its data directory's `.env`:

```dotenv
WAZAP_IMPORT_IOS=1
WAZAP_PERSIST_HISTORY=1
```

If the account has no selected archive yet, start/link it once with the setting
enabled and **no archive present**, then stop it before copying files. This
establishes the owner who may supply the first archive. Alternatively, use the
explicit CLI import once to select the archive for the linked account.

Place the source under the target account:

```text
<data-dir>/accounts/default/
  ios-import-binding.json
  import/
    ChatStorage.sqlite
    voice-skip.txt          optional for text; required for voice uploads
    Message/               extracted voice files, when available
```

Restart the server after copying. There is no folder watcher. Text imports before
WhatsApp connects (only in `serve`, so `status --live` does not wait for it). With
a `local` provider, voice work runs in the background after connection, only in
`serve`. With an API provider the folder drop uploads no archive voice at all, as
`WAZAP_TRANSCRIBE_AUTO` stays for live notes (see [voice](voice.md)); use
`wazap import ios --media` for that. Short commands such as `status --live` do not
start archive transcription. To start with text only, leave out `voice-skip.txt` or
set `WAZAP_TRANSCRIBE_AUTO=0` for that run.

If an archive already exists when you first enable the setting, wazap may require
explicit CLI selection. Enabling automatic importing does not authorize an unknown
archive or one selected for a previous owner.

With `WAZAP_IMPORT_IOS=0`, the service skips archive detection, ownership-file
initialization/sealing and automatic imports. Existing selection, progress and
errors remain preserved and visible; turning it off does not undo imported rows.
Shutdown still drains work already accepted. After upgrading from a build with
automatic import enabled implicitly, set `WAZAP_IMPORT_IOS=1` to resume that behavior.

## Docker

Keep the full existing `/data` mount. The default account's folder-drop path is:

```text
/data/accounts/default/import/ChatStorage.sqlite
```

In the container environment, set `WAZAP_IMPORT_IOS=1` and keep
`WAZAP_PERSIST_HISTORY=1`. Keep your provider settings; `WAZAP_TRANSCRIBE_AUTO=on`
is valid for automatic voice work. Read-only accounts using an API also need
`WAZAP_TRANSCRIBE_ALLOW_API=1`.

Follow the first-selection procedure above, copy the extracted files into the
corresponding host appdata folder, then restart the container. Files must be
readable by the container user. Preserve `ios-import-binding.json` alongside the
account database when moving or restoring the container's data.

For a manual import, stop the normal container and use a one-off container with
its same data directory. A command cannot run inside a stopped container.
The example below runs from the Docker host terminal. Replace both example host
paths and `YOUR_WAZAP_IMAGE` with your actual paths and the image containing this
importer. The container user needs write access to appdata and read access to the
extracted archive; the archive mount stays read-only.

```sh
docker run --rm --network none \
  --mount type=bind,src=/srv/wazap,dst=/data \
  --mount type=bind,src=/srv/iphone-export,dst=/archive,readonly \
  YOUR_WAZAP_IMAGE \
  import ios /archive/ChatStorage.sqlite --account default --dry-run --json
```

Remove only `--dry-run` to perform the text import. Then start the normal container
again. This example deliberately has no `--media` and needs no network. If you
adapt it for API transcription, allow network access and supply the same provider
and policy settings as your regular container, including `WAZAP_READ_ONLY`,
`WAZAP_RETENTION` and `WAZAP_TRANSCRIBE_ALLOW_API`. Your regular container's environment values are not
automatically inherited by a separate container.

## Add voice transcription

Configure a [local or OpenAI-compatible provider](voice.md) first. API transcription
uploads audio and can incur charges. Keep keys/auth in the normal provider
configuration, never in importer command-line arguments.

Place `voice-skip.txt` beside `ChatStorage.sqlite`. It contains one excluded chat
JID per line, for example:

```text
40700000002@s.whatsapp.net
120363000000000001@g.us
```

An empty file permits all eligible chats. Blank lines are ignored; every other line
must be an exact JID as shown above (no `+`, device suffix or spaces inside) that
names a chat in the archive. A line that is not, or that names no chat, stops the voice
pass before any upload and the command reports its line number only
(`voice_skip_invalid`). A missing file stops `--media` with an error and a non-zero
exit; the folder drop waits for it and transcribes nothing. Create
an empty file only when you intend that consent; review an existing file before
changing its exclusions. Then explicitly request voice work:

```sh
wazap import ios /archive/ChatStorage.sqlite --account default --media /archive --json
```

`--media` accepts either a directory containing `Message/` or the `Message/`
directory itself. Extracted relative media paths must remain intact. Text can
import even when voice files are absent; missing files are counted in the report.
No media is copied into wazap. Normal WhatsApp media retrieval is unavailable for
archive-only rows.

With an API provider, `--media` is the only way archive voice reaches it: the
command you type is the consent. Before the first upload it prints, on stderr,
how many notes it will send and to which provider (`--json` keeps stdout to the
report). The archive does not say whether a type-3 row is a voice note or an audio
file, so an API gets only notes whose recorded length is known and at most ten
minutes (the live limit in [voice](voice.md)). Others, and every note when the
archive has no length column, count as `skipped`. A `local` provider has no such limit.

If `--media` is given but no provider is usable (none configured, or an API provider
that a read-only account is not allowed to use), the command stops with an error
and exit code 1 after the text import; the import stays in the `voice` state
(`voice_unavailable`). Without `--media`, transcription settings are not read.

The manual `--media` command requests voice even when `WAZAP_TRANSCRIBE_AUTO=0`.
Folder-drop voice requires automatic import enabled, the `local` provider and
`WAZAP_TRANSCRIBE_AUTO=on` (or `1`/`true`). On an account made read-only globally or
with `writes: false`, `--media` with an API additionally requires
`WAZAP_TRANSCRIBE_ALLOW_API=1`. `all` is not required for archive voice work; its
special handling of the user's own new live notes is described in the voice settings.

Up to three calls run concurrently. After a provider failure that may clear
(rate limit, server error, network), no new upload starts in that run; uploads
already accepted still finish and are saved, and the next run resumes the rest.
There is no stored backoff. A failure that belongs to one note (a whisper crash
or timeout, an answer with no text) is counted with that note and does not stop
the pass; the third failure in as many runs stores the note as failed (it stays
excluded until `--reset`). The count is kept per note, not per provider, so notes
that failed twice with one provider have one attempt left with another. An API
that times out on a note counts it and also stops the pass. If the first three
notes of a run all fail for their own sake before any note succeeds, the host is
suspected (a full temporary disk, whisper killed for memory): the pass stops and
those failures are not counted. After three such runs in a row the notes are held
to blame, and later runs count them until a note succeeds. A stop in the middle of
a run drops the held failures uncharged. An API outage that shows up as timeouts
counts up to three notes per run. A file the process is not allowed to read, or
cannot find, is stored as failed at once; other read errors count like any
failure of the note. Existing transcripts win, including one that
arrives during an upload. Background importing leaves live-provider-owned notes
to the normal voice worker. Archive transcription stays bound to the original
target voice row rather than following a reused message identity.

## Read the report and check progress

The CLI report and the account's `get_status` → `storage.ios_import` contain:

| Field | Meaning |
| --- | --- |
| `state` | `rows`, `replies`, `voice` or `done` |
| `sourceRows`, `sourceByType` | Source rows examined and aggregate type counts |
| `inserted`, `skippedExisting` | New rows versus identities already stored |
| `skippedByType`, `skippedByBarrier` | Unsupported types and existing history/deletion barriers |
| `quarantined`, `quarantineReasons` | Invalid or ambiguous source identities |
| `voice` | Counts for `transcribed`, `skipped`, `missing` and `failed` notes |

Skipped existing messages are expected on reruns. A `done` report does not mean
every source row became a message or every voice file was available. Check the
skip, quarantine and voice counts, and `storage.ios_import_error` when present.
A refused archive leaves the account usable. So does an ownership file that
cannot be written or sealed (`ownership_file_failed`, for example a full disk):
iPhone import stays off until the server restarts. If the failure came while a
different number was linking, the old archive stays refused for the new number
after restarts too; only `wazap import ios <file> --reset`, after you confirm the
archive belongs to the linked account, lifts that.

Imports use bounded pages and commit progress with each text chunk. An interrupted
run resumes from committed progress; it need not start again from the first row.
A completed text import can repair blank labels on rerun without replaying messages.

## Resume, reset and change archives

For an interruption or transient provider failure, rerun the same command against
the same stable source, or restart with automatic importing enabled. No reset is
normally needed. Source bytes are hashed when an unfinished import starts; do not edit
a selected archive in place between runs and expect its old progress to apply. A `done`
import whose archive file is unchanged (same path, size and times) is not hashed
again, and neither is one left in the `voice` state. Once a voice pass has finished
on it, it is not repeated either, so voice files that appear later, or an edited
`voice-skip.txt`, need `--reset` to be picked up. A finished background pass counts
only for background passes: a text-only or background-only `done` import still runs
its voice pass when you add `--media`.

Use `--reset` only after confirming that the source belongs to the currently linked
account, for example when selecting a replacement source or retrying terminal
voice failures:

```sh
wazap import ios /archive/ChatStorage.sqlite --account default --reset --json
```

Stop the server first. Reset replaces the account's source selection and clears
import progress and terminal voice errors. It does **not** delete existing messages,
transcripts or source files, and does not bypass provider consent. Existing rows
still win. Add `--media` only if you also intend to request voice work; retrying
failed notes can incur provider charges.

The owner and source hash are kept in `ios-import-binding.json`, outside the
rotating account database. Keep that file; do not delete it to bypass selection
errors. Switching the linked number does not silently authorize the previous
owner's archive. A checkpoint in a format this build does not know is refused
(`checkpoint_unsupported`) until `--reset`. Back up the complete account directory
before downgrading; an older build may not understand newer import progress.

## Troubleshooting

These are sanitized `storage.ios_import_error` reasons; the CLI may show the
corresponding explanatory message instead.

| Reason or symptom | Action |
| --- | --- |
| Nothing starts automatically | Check `WAZAP_IMPORT_IOS=1`, history persistence, account folder and a restart after copying. There is no watcher. |
| `archive_selection_required` | Confirm the linked owner and select the correct source with the CLI; use `--reset` when replacing a selection. |
| `source_incomplete` | Re-export a complete standalone copy with its WAL/journal state incorporated. Do not delete sidecars. |
| `source_not_database` | Supply an extracted, unencrypted SQLite database rather than an encrypted backup, ZIP or other file. |
| `source_schema_unsupported` | The layout or key domain is unsupported; retain the original and use a compatible export. |
| `source_unreadable` | Check the mounted path and the container/process user's read permissions. |
| `source_changed` | Stop changes to the source and use a stable export. Review the intended selection before resetting. |
| `source_corrupt` | Restore or re-export from the original backup; reset does not repair source corruption. |
| `retention_unsupported` | Turn off `WAZAP_RETENTION` for the import; imported messages cannot expire. |
| `voice_skip_invalid` | Fix the line number the command names in `voice-skip.txt` (not an exact JID, or no such chat in the archive), then rerun. |
| `voice_unavailable` | Configure a usable provider (and API consent on a read-only account) or drop `--media`. |
| `ownership_file_failed` | Free disk space or fix permissions on the account folder (and an `import` path that is a file), then restart. If it appeared when another number linked, also confirm the archive belongs to the linked account and run the import with `--reset` (`archive_selection_required` until then). A successful CLI import clears the notice. |
| `owner_missing` / `history_disabled` | Link the target account / enable history persistence before writing. |
| `voice_target_bindings_missing` or `checkpoint_unsupported` | A saved checkpoint cannot prove safe ownership or is in an unknown format. Confirm the archive and use an explicit reset; existing rows remain. |
| Text imports but voice does not | Check provider configuration, `--media` or automatic settings, `voice-skip.txt`, API consent and media paths. |
| Writer-lock refusal | Stop every server using this data directory before a writing CLI import. |
| `import_failed` | Check the local log, source accessibility, provider configuration and free disk space; resetting is not a general repair. |

## Supported source structure

The standalone source must contain physical Core Data tables `ZWAMESSAGE`,
`ZWACHATSESSION`, `ZWAGROUPMEMBER` and `ZWAMEDIAITEM`, with the columns consumed by
the importer. Every table needs a positive, JavaScript-safe rowid-alias
`INTEGER PRIMARY KEY` named `Z_PK`; `WITHOUT ROWID` and column-level
`PRIMARY KEY DESC` are unsupported. Extra tables and columns are allowed.

Text, links, captions and typed media markers become ordinary history rows.
Deleted, system, view-once and unsupported rows are skipped; invalid identities
and identity collisions are counted instead of guessed. Archive names fill only
blank chat/contact labels and preserve live names. Rows have no fabricated
WhatsApp protobuf or media credentials.

Preflight checks precede source selection and reset, preserving existing progress
when they refuse a source. Reads use SQLite read-only/immutable access; no source
index is created. Corruption discovered later while reading can still stop a run.
Collision preparation and media lookup use a temporary private disk index in the account directory. Text,
name, reply and voice scans use bounded pages, with paged checkpoints.
