# What 1.0 keeps stable

This file is the contract: what wazap 1.0 promises not to break without a new
major, and what it does not promise at all. Every line is derived from the code
and the tests here, not from intentions — where a promise has a test behind it
the test is named, and where it has none the line says so. "Break" means remove,
rename, or change the meaning of something listed as stable; adding is not
breaking.

| Area | Stable | Additive-only | Not promised |
| --- | --- | --- | --- |
| MCP tools | the 21 names, their required arguments, their error codes | new optional arguments, new enum values, new answer fields | description wording, field order, rendered text |
| Safety | draft-then-confirm, send rules, read-only mode, session isolation | new codes for new refusals | the exact error sentences |
| CLI | command and flag names, exit code 0 vs non-zero, `status --json`, `--version --json`, `account add --json` | new commands, flags and JSON keys | the human text on stderr |
| Webhook | event names, signature scheme, the payload fields below | new events (opt-in), new payload fields | delivery latency, retry timing |
| Storage | forward-only migrations, released migrations frozen, the pre-migration copy | new schema versions | the SQLite schema as a format for other tools |
| Settings | the 24 `WAZAP_*` in `.env.example` and `docs/settings.md` | new settings | anything not listed there |

## 1. The MCP surface

wazap registers exactly 21 tools — the 20 of 1.0 and `list_contacts`, added in
1.2 — a session without writes sees 14 of them, and every tool also takes an
optional `account_id`. Guarded by: `test/tools.test.mjs`,
`test/tool-names.test.mjs`.

The 21, each with what it requires: `learn` (), `get_status` (),
`list_chats` (), `catch_up` (), `wait_for_messages` (), `find_contact` (),
`list_contacts` (), `link_account` (`phone`), `search` (`query`), `get_group_info` (`group_id`),
`confirm_send` (`draft_id`), `manage_group` (`action`),
`read_messages` (`chat_id`), `remember` (`chat_id`), `get_message`
(`message_id`), `get_media` (`message_id`), `send_message` (`chat_id`, `text`),
`edit_message` (`message_id`, `text`), `react_to_message` (`message_id`,
`emoji`), `delete_message` (`message_id`, `for_everyone`), `manage_chat`
(`chat_id`, `action`).
An empty argument list means the tool requires nothing.

Fourteen declare an output schema and answer in that shape, as an SDK client's
own validator checks it; the seven without one are the six of the integration
contract and `learn` (`test/output-schema.test.mjs`). A refusal is an error result carrying
`{ error, message, fix }`, with `account_id` added when the tool declares an
output schema; `error` is one of the 46 codes, and `learn` documents every one
of them. Guarded by: `test/tools.test.mjs`.

**What "stable" means here.** A new optional argument, a new value in an enum
such as `manage_chat`'s or `manage_group`'s `action`, and a new field in an
answer are additive and may land in a minor — so a client must tolerate fields
it does not know. Removing or renaming a tool, an argument or an answer field,
making an optional argument required, or removing an error code needs a major.

### The integration contract

An integration is a program that runs `wazap serve --http` with a static token
as the WhatsApp channel of its own product: one account per customer, drafts
and confirmations, read receipts, pairing and a health probe.

Six tools are an exact contract for an integration: `send_message`,
`confirm_send`, `manage_chat` with the `mark_read` action, `link_account`,
`get_status` and `list_contacts`.

- They keep their names, keep accepting the arguments an integration passes,
  and never gain a required argument it does not pass. `manage_chat` keeps
  `mark_read` in its `action` enum and answers `chat_id`, `action` and
  `applied`, and `get_status` answers a `status` from the eight statuses an
  integration maps, with `status_since` and `account_id`.
- Their answers keep the fields an integration reads: `send_message` answers
  `draft_id` and `account_id`; `confirm_send` answers `message_id`, `chat_id`,
  `text`, `timestamp` and `account_id`; `link_account` answers `code`,
  `expires_at`, `phone_masked` and `account_id`; `list_contacts` answers
  `contacts`, `total`, `next`, `address_book_synced`, `sync` and `account_id`,
  each contact with `name`, `phone` in E.164, `chat_id`, `contact_id` and
  `last_message` (`null`, or `at` and `direction` `in` or `out`), and takes
  `order`, `limit` up to 500 and `cursor`.
- Over HTTP, a well-formed request carrying a session id wazap does not hold
  (expired, evicted or lost to a restart) answers 404, as the MCP
  specification says, and a fresh `initialize` recovers; one with no session
  id that is not `initialize` answers 400. With `WAZAP_READ_TOKEN` set as well
  as `WAZAP_WRITE_TOKEN`, a token wazap does not hold answers 401; with the
  write token alone, a request without it is served as the anonymous reader,
  which only loopback allows. Each of these is a JSON-RPC error, and an
  integration tells them apart by the status, not by the message. Budgets and
  malformed bodies answer as §8 says.
- The codes an integration sorts as "definitely not sent" — `NOT_CONNECTED`,
  `NOT_LINKED`, `SESSION_EXPIRED`, `SESSION_CORRUPT`, `RATE_LIMITED`,
  `DRAFT_EXPIRED`, `ACCOUNT_RESTRICTED` — keep that meaning: nothing left
  wazap. The last also means do not retry: WhatsApp restricts or banned the
  account, and the status tool says what and until when.

Guarded by: `test/integration-contract.test.mjs`, and for the last one also
`test/sends.test.mjs`.

## 2. Safety behaviours

- A send is two steps: `send_message` only drafts, and `confirm_send` is the
  only thing that sends. Guarded by: `test/tools.test.mjs`, `test/sends.test.mjs`.
- A draft belongs to the MCP session that made it; every other session is told
  `DRAFT_NOT_FOUND`, a re-initialized session cannot confirm the old one, and a
  draft the session did something else after is refused with `DRAFT_STALE`
  without sending. Guarded by: `test/draft-isolation.test.mjs`,
  `test/session-isolation.test.mjs`.
- A draft lapses after 15 minutes as `DRAFT_EXPIRED`, once, and sends nothing;
  a confirmed one is spent, so confirming again answers the same receipt and
  sends nothing, and two concurrent confirms send once. Guarded by:
  `test/drafts.test.mjs`, `test/sends.test.mjs`, `test/integration-contract.test.mjs`.
- A send whose outcome wazap does not know is `SEND_OUTCOME_UNKNOWN` and is
  never sent again on its own. Guarded by: `test/sends.test.mjs`.
- Per-account send rules are enforced at draft time and re-checked at confirm
  time; an empty allowlist means nobody, and deny wins over allow. Guarded by:
  `test/send-guard.test.mjs`.
- In read-only mode the write tools are not registered at all, and a write
  bearer does not unlock them. Guarded by: `test/tools.test.mjs`,
  `test/oauth.test.mjs`.
- Over HTTP, sessions are isolated: another credential cannot reinitialize a
  session, independent sessions cannot exchange draft ids, each keeps its own
  tool permissions, and only the private local bridge reaches host files.
  Guarded by: `test/session-isolation.test.mjs`, `test/draft-isolation.test.mjs`,
  `test/oauth.test.mjs`, `test/http-security.test.mjs`.

## 3. The CLI

- The command names and the flag names `wazap --help` prints, and the exit
  code — 0 on success, non-zero on failure.
  Guarded by: `test/cli.test.mjs`, `test/integration-contract.test.mjs`.
- `wazap status --json` prints one parseable JSON object on stdout; its keys are
  additive. Guarded by: `test/doctor.test.mjs`, `test/accounts.test.mjs`,
  `test/pre-migration-backup.test.mjs`.
- `wazap --version --json` prints one JSON object on stdout with `version`,
  `baileys` and `node`; its keys are additive. Guarded by:
  `test/integration-contract.test.mjs`.
- `wazap account add <id>` and `wazap logout --account <id>` work while a server
  holds the data dir. `wazap account add <id> --json` prints one JSON object on
  stdout, `account_id`, `created` and `enabled`, and exits 0 for an account
  already there (`created` false), so a program making sure an account exists
  reads an answer rather than an error's wording. Either way a running server
  is told to pick the account up. Two `account add` run at the same moment are
  not serialized: provision accounts one at a time. Guarded by: `test/integration-contract.test.mjs`.

Not promised: the human-readable text. Everything printed for a person goes to
stderr, and its wording, layout, ordering and colour may change in any release —
only `--json` and exit codes are for scripts. That stdout stays protocol-clean
under `serve` is guarded by: `test/hygiene.test.mjs`.

## 4. The outbound webhook

- The three event names `message_received`, `message_sent` and `connection`; the
  last two are opt-in through `WAZAP_WEBHOOK_EVENTS`, and unset means
  `message_received` only.
- The signature is `x-wazap-signature: sha256=<hex>`, an HMAC-SHA256 over the
  exact raw request body with the configured secret; the body is JSON.
- With `WAZAP_WEBHOOK_AUTH` set (or an account's own), its header
  goes with every POST beside the signature: `Authorization` for a bare value,
  the named header for `<Header-Name>: <value>`.
- Message-event fields: `event`, `account_id`, `account_name`, `chat_id`, `from`,
  `message_id`, `text`, `truncated`, `kind`, `from_me`, `is_self_chat`,
  `timestamp`, `phone`, `contact_id`. `kind` is `text`, `audio`, `image` or
  `other` — a bucket, so a new message type falls into `other` rather than
  adding a value. `text` is cut at 2000 characters ending in an ellipsis, with
  `truncated` true. `timestamp` is the message's own instant, in UTC. When
  `WAZAP_WEBHOOK_COALESCE` groups more than one message into the POST, those
  fields name the latest message and the body also carries `count`,
  `message_ids`, `texts`, `first_ts` and `first_timestamp`. One message is
  the same body as before.
- Connection-event fields: `event`, `account_id`, `status` and `timestamp`,
  where `status` is `linked`, `disconnected` or `expired`, and `health` with
  its `state`, `until` and `reason`, as `get_status` says them. A health
  change while the link stays up is a connection event too. A connection
  event is not a chat: the allowlist and `#private` do not apply to it,
  because it carries no message content.
- A message wazap itself sent produces no `message_sent`, and history sync
  produces no events at all.

Guarded by: `test/webhook.test.mjs`, `test/webhook-auth.test.mjs`,
`test/webhook-filter.test.mjs`, `test/integration-contract.test.mjs`. Delivery is
at-least-once and ordered within a chat, retried on 408, 425, 429 and 5xx, and
on 401 when `WAZAP_WEBHOOK_RETRY_401` is on, and
given up on after 24 hours (`test/webhook-outbox.test.mjs`); the retry schedule
itself is current behaviour, not a promise. With neither `WAZAP_WEBHOOK_CHATS`
nor `WAZAP_WEBHOOK_TAG` set, every chat is posted except a contact tagged
`#private`. With either set, only a listed chat, or a direct chat whose
contact carries the tag, is posted, and a contact tagged `#private` is not.
Their own messages in a group are left out too. The owner's messages in that
group are still posted when the group is. `connection` events are posted
whenever that event is enabled.

## 5. Data on disk

- The account database carries its schema version in `PRAGMA user_version`; it
  is 5 in this release.
- Migrations run forward only, in order, and every released version has a chain
  test, so a new migration cannot ship without one. A released migration is
  never edited — a new shape is a new migration at the end — and the chain test
  is what holds that: every released version's file must still reach the schema
  a fresh file gets, object for object.
- All pending migrations run in one transaction, so a crash leaves the file at
  the whole version it started from.
- Before migrating, wazap copies the database to
  `wazap.<old version>.pre-migration.sqlite` beside it, under the migration's
  own lock, and fails closed: if the copy cannot be written, the upgrade does
  not start. `WAZAP_PRE_MIGRATION_BACKUP=0` upgrades without one.
  The copy is kept seven days from its own mtime, and only goes once the
  database has passed the version it holds (`test/pre-migration-backup.test.mjs`).
- There is no downgrade. A database written by a newer wazap is refused with
  `SCHEMA_TOO_NEW` and left byte-for-byte untouched; the way back is to install
  that newer wazap, or to restore the pre-migration copy by hand.
- `wazap backup <path>` writes an owner-only, complete, openable copy, works
  while another process holds the database, and refuses to write over the live
  file. Guarded by: `test/pre-migration-backup.test.mjs`, `test/db-open.test.mjs`.

Guarded by: `test/db-migration-chain.test.mjs`, `test/db-open.test.mjs`. A major
may change the schema in ways no 1.x can read; the copy above and `wazap backup`
are the way out.

**The file format is not promised.** The schema is internal — read through
wazap, not by other tools — and tables, columns and indexes may change in any
release, patches included, as long as the migration chain holds. Nothing in the
code or the tests supports a third-party reader.

## 6. Settings

Stable: the 24 `WAZAP_*` listed in `.env.example` and in the settings table of
`docs/settings.md` — `WAZAP_DATA_DIR`, `WAZAP_READ_ONLY`, `WAZAP_PERSIST_HISTORY`,
`WAZAP_HOST`, `WAZAP_PORT`, `WAZAP_READ_TOKEN`, `WAZAP_WRITE_TOKEN`,
`WAZAP_PUBLIC_URL`, `WAZAP_OAUTH_PASSWORD`, `WAZAP_TRUST_PROXY`,
`WAZAP_TRANSCRIBE`, `WAZAP_TRANSCRIBE_API_KEY`, `WAZAP_RECALL`,
`WAZAP_WEBHOOK`, `WAZAP_WEBHOOK_URL`, `WAZAP_WEBHOOK_SECRET`,
`WAZAP_WEBHOOK_EVENTS`, `WAZAP_WEBHOOK_AUTH`, `WAZAP_WEBHOOK_CHATS`,
`WAZAP_WEBHOOK_TAG`, `WAZAP_WEBHOOK_COALESCE`, `WAZAP_WEBHOOK_RETRY_401`,
`WAZAP_RETENTION`, `WAZAP_PRE_MIGRATION_BACKUP`.
Any other `WAZAP_*` a running wazap reads is a development knob, documented in
`AGENTS.md` and nowhere else; it may change or go at any time.

A setting that stops being read is not silently ignored: it moves into
`RETIRED_SETTINGS` and whoever still sets it gets one warning naming the
replacement. One still honoured until the next major moves into
`DEPRECATED_SETTINGS` and warns there — `WAZAP_TRANSPORT` is that one today,
honoured until 2.0. Guarded by: `test/config.test.mjs`, `test/cli.test.mjs`.

## 7. Versions and environment

Node 22.16.0 or newer on the 22 line, or 24 and newer, as `engines` in
`package.json` states; the 23 line lacks `node:sqlite` features wazap needs, and
`wazap status` refuses it. CI runs lint,
typecheck and the whole suite on Node 22.16.0 and on Node 24, on Linux
(`.github/workflows/ci.yml`). macOS is the daily development platform but is not
in CI. Windows has code paths of its own (client configuration, executable
extensions) that no test or CI run exercises, so it is not a supported platform
until one does.

Semver, with this file as the definition of the contract: a major changes
something listed as stable, a minor is additive, a patch fixes behaviour without
changing the contract. A release is one commit and one tag, and the tag has to
match `package.json` and to have its own CHANGELOG section or publishing refuses
(`.github/workflows/publish.yml`; the version files are guarded by
`test/distribution.test.mjs`).

How long the 1.x line is supported, and whether a tool or an argument gets a
deprecation minor before a major removes it, are deliberately not stated: the
project has a written deprecation path for settings only, and nothing in the
code or the process backs a wider one yet.

## 8. Not promised

- **Exact error text.** The `error` code is stable; `message` and `fix` are
  written to be read and may be rewritten at any time. Nor is field order in any
  answer, or the rendered text blocks tools return beside structured content.
- **Skill content.** The five skills under `skills/` are prompts, rewritten
  whenever they read better.
- **What an AI model does with any of this.** The cases under `eval/` measure
  how models use the tools. They measure; they do not guarantee. The harness
  under `eval/` and `scripts/` is development tooling, not part of the package.
- **Search and transcription quality.** Which messages `search` returns, its
  recall, whether meaning search runs at all, and whether a transcript is
  produced, depend on a model and an index; only the answer's shape is stable.
- **Everything under `src/`.** The package exposes one binary and one MCP
  server; importing a module out of `dist` is not supported.
- **WhatsApp itself.** wazap talks to WhatsApp through Baileys, which is
  unofficial. WhatsApp can change its protocol or restrict an account at any
  time, and no version of wazap can promise otherwise.
- **HTTP and OAuth as an integration surface.** The session statuses in §1 are
  guarded by `test/integration-contract.test.mjs`, and the security properties
  in §2 by `test/oauth.test.mjs` and `test/http-security.test.mjs`; both
  hold. What is not promised is the shape of the OAuth endpoints, the consent
  pages, the log lines and the discovery documents: they exist so a client can
  sign in, not to be built on.
- **Performance.** Rate limits and request budgets protect the account; they are
  not a fairness or throughput guarantee.
