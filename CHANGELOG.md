# Changelog

## 1.3.7

### Added

- **A read-only account can transcribe through an API, when you say so.**
  `WAZAP_TRANSCRIBE_ALLOW_API=1` separates uploading audio (and paying for it)
  from WhatsApp writes, which stay off. Allowed this way, notes are transcribed
  when asked; `WAZAP_TRANSCRIBE_AUTO=1` makes it automatic again.
- **`WAZAP_TRANSCRIBE_AUTO=all`** sends the user's own voice notes to the API
  too, with `WAZAP_TRANSCRIBE_ALLOW_API=1`: only new ones recorded live after
  the server started, never history or stored notes. Thanks @bucketphobia.
- **A Docker image with every release.** `ghcr.io/razvangirgiz/wazap`, for
  amd64 and arm64, tagged with the version, the minor line and `latest`. The
  compose file pulls it, so self-hosting no longer builds from source; see
  [docs/self-host.md](docs/self-host.md#with-docker). Asked for in #63.

## 1.3.6

### Changed

- **Local transcription takes every voice note, not just incoming live ones.**
  With `WAZAP_TRANSCRIBE=local`, the user's own voice notes are transcribed
  too, and each time the account connects the stored notes still without a
  transcript are queued (the newest 500, behind anything new). It costs nothing
  on this machine; an API provider keeps the old rule, so nothing new is billed.

## 1.3.5

### Added

- **`bge-m3` as an embedding model, for a history in more than one language.**
  Set `WAZAP_EMBED_MODEL=bge-m3` and run `wazap embed download --model bge-m3`
  (~635 MB). Measured on real messages, it finds an answer asked in another
  language that the default model misses ("where is my package" finds "A ajuns
  coletul?"), and ranks the answer in the top five more often (7 of 10 against
  4). It carries its own floor, 0.55. Gemma stays the default: bge-m3 is twice
  its size and embed time.

## 1.3.4

### Fixed

- **Search finds old messages by meaning again.** The similarity floor was
  applied after age had lowered the score, so a message two months old needed a
  0.50 match to count and most real paraphrases (0.40-0.50) were dropped. The
  floor now reads the similarity itself; age only orders the results.
- **One shared word no longer puts a long, unrelated message at the top.** For
  a two-word query, a hit that carries one of the words now needs part of the
  query's meaning (70% of the floor). Without meaning search it stays, as
  before.

### Changed

- The `search` tool, its docs and the recall skill no longer promise that a
  question in another language finds the message: with the default model such
  matches sit under the floor. Ask in the chat's language.

## 1.3.3

### Added

- **`list_chats` can return each chat's profile photo.** With
  `include_pictures: true` every chat gets `picture_url`, or `null` when there
  is none or WhatsApp does not answer in time. Lookups go a few at a time and a
  link is reused for six hours; a contact tagged `#private` gets none. Off by
  default, so agents that do not ask see no change.

## 1.3.2

### Fixed

- **A chat marked read with `manage_chat` stays read.** WhatsApp sends the
  account no echo of its own read, so the chat kept its unread count and showed
  as unread again at the next `list_chats`. `mark_read` now clears it.

## 1.3.1

### Fixed

- **A chat read on the phone no longer shows as unread.** `list_chats` took
  WhatsApp's own unread count, which stays where it was when the user reads on
  the phone. A chat where the user had the last word, or where the phone's read
  receipts reached the last message, now has `unread_count` 0 and leaves the
  `unread` filter.

## 1.3.0

### Added

- **`get_status` can return the account's own profile photo.** With
  `include_picture: true` it adds `picture_url`, the link WhatsApp gives for
  the photo, or `null` when there is none or it cannot be read; the status
  answers either way. Off by default, so nothing changes for agents that do not
  ask. The link expires: a client that shows it keeps its own copy.
- **The webhook can post only some chats.** `WAZAP_WEBHOOK_CHATS` lists chat
  ids and phone numbers, and `WAZAP_WEBHOOK_TAG` names a contact tag such as
  `autopeloc`. Set either and only a matching chat is posted. A direct chat
  matches the tag when `remember` has filed it on that contact, so the set
  changes without a restart, and a pending event for someone just removed is
  cancelled. A group is posted only when its chat id is listed. An empty filter
  posts no message events. With neither setting, every chat is posted except
  contacts tagged `#private`. An account's `webhook_chats` or `webhook_tag`
  replaces the global filter. `wazap config webhook chats`, `tag` and
  `filter off` write them, and `wazap config` prints the filter.
- **Messages in one chat can share one POST.** `WAZAP_WEBHOOK_COALESCE` is a
  quiet window in seconds, from 1 to 300. Several messages in that chat become
  one signed body. A conversation that keeps going is still delivered by twice
  the window, and never later than 5 minutes after the first message of the
  burst. The existing fields name the latest message. A burst also carries
  `count`, `message_ids`, `texts`, `first_ts` and `first_timestamp`. One
  message is the same body as before. Order inside the chat, retries, the
  signature and the outbox across a restart are unchanged.
- **A 401 can be retried.** `WAZAP_WEBHOOK_RETRY_401=on` retries a 401 on the
  same schedule as a 5xx. Unset, a 401 still fails the event at once.

### Changed

- **The webhook never posts a contact tagged `#private`.** Their direct chat
  is left out, including messages the owner sent there, and so is a message
  they wrote in a group. Listing the chat or also giving them the allow tag
  does not put them back. The owner's own messages in a group are still
  posted when that group is. This holds with no chat filter, with an empty
  one, and with a filter set. Earlier versions posted those chats when no
  filter was set. `connection` events are unchanged: they carry no message
  content, and the chat filter and `#private` do not apply to them.

## 1.2.0

### Added

- **`list_contacts`: the phone's address book, a page at a time.** For a
  program that lets its user pick people out of the address book — importing
  clients, say — or an assistant asked who is in it. Each person comes with
  their saved name, the number in E.164, `chat_id`, the `contact_id` the
  webhook names them by, and `last_message`: when the newest message of the
  direct chat that is not a notice was and its `direction` (`in` or `out`), or
  `null` when you never talked. Never a word of any message. `order: "recent"`
  (the default) puts whoever you talked to last first and everyone else after,
  in the address book's order; `order: "address_book"` keeps that order alone.
  Up to 500 a page, with `total` and an opaque `next` to pass as `cursor`; the
  pages read the conversations as the first one saw them, so someone writing
  to you meanwhile is not skipped. Only people with a saved name and a number
  are listed: not someone known by their push name alone, a privacy id without
  a number, a group, the account itself, or anyone tagged `#private` on any
  linked account. `address_book_synced` stays `false` until the address book
  itself has arrived — someone saved with a name and no chat with you — so an
  app can show that it is still syncing right after linking, when only the
  history's names of the people of your chats are in. It reads what wazap
  stores, so it answers while the link is down. It joins the integration
  contract (`docs/stability.md`) and, like the other tools there, declares no
  output schema, so a refusal keeps its `structuredContent.error`.

## 1.1.1

### Added

- **A logo:** a chat bubble with a bolt beside the wordmark, in the README and
  in the terminal for bare `wazap` and a login without the wizard, when the
  window is at least 62 columns wide. A narrower window, a pipe and the login
  wizard keep the wordmark alone.

### Security

- Patched transitive dependencies in the lockfile: sharp 0.35.5 (librsvg
  advisory), proxy-addr 2.0.8 (IPv4-mapped IPv6 trust check) and ip-address
  10.7.3 (link-local, NAT64, subnet and parse-length advisories).

- Require `@modelcontextprotocol/sdk` 1.30.0 or newer on the 1.x line and
  `express-rate-limit` 8.6.2 or newer on the 8.x line, excluding older releases
  covered by known security advisories. These are the versions already used
  by the repository lockfile; the resolved dependencies and runtime behavior
  are unchanged.

## 1.1.0

### Added

- **wazap recognises when WhatsApp restricts or bans the account, and stops.**
  A close WhatsApp means as a ban (403, 406), a temporary ban (402, with its
  end), a session another client took over (440) or a client it no longer
  takes (405, 409) used to be retried like a dropped link, over and over. Now
  the account goes to `auth_failure` without reconnecting, a temporary ban gets
  one try a minute after it ends, and every write — and a read that needs the
  link — answers the new `ACCOUNT_RESTRICTED` (do not retry). `link_account`
  refuses while the session would come back on its own (a temporary ban, a
  session taken over, an outdated client), since pairing clears it. Only
  WhatsApp's own `<failure>` and stream errors count: a proxy that refuses the
  WebSocket with the same status is still a dropped link.
- **The reachout timelock is read and respected.** WhatsApp can stop a
  restricted account starting chats with people it has never written to; wazap
  asks at every connect, listens for WhatsApp's own updates, and asks again
  when a send comes back refused with 463. While it holds, a first message to
  someone the account holds no privacy token for, and who never wrote to it,
  is refused before it leaves, since each attempt counts against the account;
  chats WhatsApp would take go on.
- **`get_status` has a `health` block:** `state`, `since`, `until`, `reason`,
  `detail` (WhatsApp's own words, when it gave any), `last_send_error` and
  `new_chat_cap`.
- **WhatsApp's cap on first messages to new people is read.** wazap asks for it
  at every connect and takes WhatsApp's own updates. Its first and second
  warnings show in `get_status` (`health.new_chat_cap` and the hint), so an
  integration that reads them can slow down before the cap; once it is used up
  (`new_chats_capped`), a first message to someone who never wrote is refused
  before it leaves until the cycle ends.
- **The webhook's `connection` event carries `health`** (`state`, `until`,
  `reason`), and a restriction that comes or goes while the link stays up —
  including one that ends on its own clock — is a `connection` event too.
- **`wazap account add <id> --json`** prints `{ account_id, created, enabled }` on stdout
  and exits 0 for an account already there (`created: false`), so a program
  making sure an account exists reads an answer instead of recognising an
  error by its wording. Without `--json` nothing changes.
- **The HTTP session statuses are promised.** A session id wazap does not hold
  answers 404, as the MCP specification says, a request with no session answers
  400 and, with a read token set as well as the write token, an unknown token
  401, each a JSON-RPC error: an integration tells them apart by the status,
  not by the message.
- **`wazap --version --json`** prints one JSON object on stdout, with `version`,
  `baileys` and `node`, for an install script to read. Plain `--version` stays a
  line for a person, on stderr like every other one.
- **The integration contract says more of what it promised in practice.**
  `docs/stability.md` now lists the answer fields of `send_message`,
  `confirm_send` and `link_account`, and `from` among the message-event fields,
  all of which the contract test already held.
- **The webhook can send the header a receiver asks for.** Cursor Automations,
  n8n and most hosted webhooks accept a POST only with a header of their own,
  usually `Authorization: Bearer …`, so they could not take wazap's events
  without the bridge script in the docs. `WAZAP_WEBHOOK_AUTH` now carries it:
  `Bearer <token>` goes out as `Authorization`, `X-Api-Key: <key>` as that
  header, beside `X-Wazap-Signature`, which is still sent.
  `wazap config webhook auth` asks for it at a prompt that does not echo it and
  `wazap config webhook no-auth` drops it; with `--account` it is that
  account's `webhook_auth` in `accounts.json`. The value never appears in
  `wazap status`, a log line or an error, and the headers wazap sets itself
  cannot be replaced.

### Fixed

- **`confirm_send` over a fresh HTTP session no longer loses the draft.**
  A draft's owner was the MCP session's own id, so when a client confirmed it
  over a reinitialized connection — a dropped HTTP session, a restart of the
  client, an OAuth access-token rotation — `confirm_send` answered
  `DRAFT_NOT_FOUND` for a draft the user had just approved. Remote sessions now
  answer to their credential's identity instead: every session on one static
  token shares its drafts, and an OAuth client's drafts answer to the grant's
  client. A session on another credential is still told `DRAFT_NOT_FOUND`, and
  stdio, the daemon's own channel and each bridge's upstream session keep
  per-session drafts.

### Changed

- **Marking a chat read no longer spends the sends' budget.** `manage_chat`
  `mark_read` has a bucket of its own, three times the account's writes a
  minute (60 at the default 20), beside the writes' bucket every send and other
  write keeps. A program that marks each chat read before it replies could
  otherwise run out of sends at half the rate. It follows an account's
  `rate_limit`, and is off when that is 0.

## 1.0.3

### Changed

- **The service is split into parts, with nothing a user can see changing.**
  `src/whatsapp.ts` held one account's whole service in a single 6 000-line
  class. It now keeps the socket, the connection's state, the lifecycle and
  the event wiring, and each thing it does is a part in `src/service/`:
  identity and names, message views, groups, voice notes, recall, waits,
  sending, the account database, ingest, contacts, reads, media, chat actions
  and the webhook. Every part reaches the service through a small host it is
  lent, so a change to sending, say, reads in one file. The tools, their
  answers, the settings and the files on disk are as they were; the 1 978
  tests pass unchanged apart from reaching into the part a member moved to.
  `AGENTS.md` says where things live now.

## 1.0.2

### Fixed

- **`wazap config webhook on` says what the webhook posts.** It said "messages
  both ways and link changes POST to …", but unless `WAZAP_WEBHOOK_EVENTS` asks
  for more only the messages you receive are posted, as the documentation and
  the tests say. The line now names the events that are configured (the
  account's own list, else the global one), and with the default list adds how
  to ask for the rest.
- **The setup skill states the Node range wazap enforces.** One row of its
  diagnosis table said the Node version was "below 20", while another said 22.16
  or 24, and `wazap status` refuses the 23 line: an agent reading the first would
  tell a user with Node 20 that it was enough. It also names the way to link from
  a terminal when the QR screen is too tall for the window or there is no camera:
  `npx wazap-mcp login --phone +15550100`. `test/skills.test.mjs` ties the Node
  floor in the skill to `engines`.

### Added

- **A receiver for services that want their own `Authorization` header.**
  wazap signs its webhook events and sends nothing else, so Cursor Automations,
  n8n and most hosted webhooks could not take them directly.
  `docs/api-and-webhooks.md` now prints a 35-line, dependency-free Node script
  that checks wazap's signature and passes the same body on with the header the
  service wants, and hands the service's status back so wazap's retry rules
  still apply. `test/webhook-bridge-doc.test.mjs` extracts the script from the
  document and runs it against a local service, signed with wazap's own
  function, so the recipe cannot rot.

## 1.0.1

### Fixed

- **`wazap setup` and `wazap login` no longer leave in silence after the
  QR-or-pairing-code question.** Answering it closes stdin, and the typing of
  the next screen ran on timers that did not keep the process open, so with
  nothing else pending Node left in the middle of the screen, with exit code 0,
  one character into the title (`1 / 3`, `S▍`), and nothing was linked. It
  reproduced on macOS and Linux, on 1.0.0 and 0.23.1. The timers now hold the
  process open until the screen is drawn.
- **A window too short for the QR is told so, not shown half a code.** The QR
  is 32 rows tall and its screen needs about 36; a window of the usual 24 rows
  cut the top of the code, and a code cut at the top cannot be scanned. The
  screen now says how many rows it needs and how to link with a pairing code
  instead, draws the QR as soon as the window is tall enough, and the question
  before it makes the pairing code the default when the window is too short.

## 1.0.0

wazap 1.0 fixes the tool surface at 20 tools and writes down what it keeps
stable and what it does not, in [docs/stability.md](docs/stability.md). Coming
from 0.23, three things change under you: the tool names below, the account
database (schema version 5, with a copy taken beside it first — there is no
way back except that copy), and the Node range (22.16 or newer on the 22 line,
or 24; the 23 line was already refused by `wazap status`). `npx wazap-mcp
update` installs the package, restarts the service and refreshes the skills;
clients read the tool list when they connect. On a 50 MB database of some
21,000 messages, the upgrade and its copy took under a second. How models
behave with the tools was evaluated on Claude only; ChatGPT and the others are
not measured yet (README, Known limitations).

### 20 tools instead of 40

The tool surface 1.0 promises to keep stable. Every capability of the 40 tools
has a place among the 20, or is listed under *Removed* with the reason. There
are no aliases for the old names: clients read the tool list when they connect,
and the five tools Calfa calls (`send_message`, `confirm_send`, `manage_chat`
with `mark_read`, `link_account`, `get_status`) keep their names, arguments and
answers.

| 0.23 | 1.0 |
| --- | --- |
| `learn`, `link_account`, `list_chats`, `wait_for_messages`, `get_message`, `get_group_info`, `edit_message`, `react_to_message`, `delete_message`, `confirm_send`, `manage_chat`, `catch_up`, `find_contact` | the same name |
| `get_status` | `get_status`, whose `accounts` now lists every configured account, disabled ones too, next to `default` |
| `list_accounts` | `get_status` (`accounts`, `default`) |
| `get_recent_messages` | `catch_up`; one chat in full with `read_messages` |
| `get_unanswered` | `catch_up`'s `waiting` |
| `get_stories` | `read_messages` with `chat_id: "status"` (and `hours`); `catch_up` counts them |
| `set_contact_note` | `remember` with `note` |
| `update_contact_details` | `remember` with `add_tags`, `remove_tags`, `fields`, `remove_fields` |
| `mark_handled` | `remember` with `handled: true` |
| `search_messages` | `search` with `match: "words"` |
| `recall` | `search` (by meaning and words by default; when meaning search cannot run — off, a failing embedding server, a sidecar not up within 8 s — it matches words and says `mode: "keyword_fallback"`, with `recall_unavailable.code`) |
| `search_contacts` | `find_contact` by `name` (a name, or a number however it is written), or with `tag` to list everyone filed under it (the limit shared between accounts, `omitted` counting the rest on each) |
| `get_contact` | `find_contact` with the number or the id as `name`: a resolved person carries their number, note, tags and details; `about`, the profile picture and `is_blocked` are removed (below) |
| `sync_contacts` | automatic: `find_contact` asks for an address book that looks empty; `wazap contacts resync` while no server runs |
| `download_media` | `get_media` (`save_to`); on a voice note or audio, `save_to` gives the file and starts no transcription |
| `transcribe_audio` | `get_media` on a voice note or audio without `save_to` (`language`); a transcription that cannot run (off, failing, timed out, over ten a minute) answers the file with `transcript_unavailable.code`, and only a provider run counts toward the ten |
| `send_media` | `send_message` with `file_path` or `url`, the caption as `text`, `as: "document" \| "voice" \| "gif"` |
| `send_poll` | `send_message` with `options` (and `multi_select`), the question as `text` |
| `send_location` | `send_message` with `latitude` and `longitude`, the place name as `text`, `address` |
| `forward_message` | `send_message` with `forward` (the message_id) and `text: ""`, `chat_id` the destination; without `account_id` it goes from the account that holds the message, as before |
| `create_group` | `manage_group` with `action: "create"`, the name as `value`, `participant_ids` |
| `join_group` | `manage_group` with `action: "join"`, `invite` or `message_id`, `confirm` |
| `save_contact`, `remove_contact`, `set_profile_picture` | removed, see below |

- **What an assistant is sent is 4,786 tokens instead of 14,397**: the names,
  descriptions, input schemas and annotations of a session that can write, as
  an SDK client lists them (2,937 in a read session). Every description fits in
  300 characters, `account_id` is explained once, in the server's instructions
  and in `learn`, and `learn`'s guide is 1,944 tokens of text with no copy in
  structured content. `node scripts/tool-budget.mjs` prints the table per tool,
  and a test holds the budget.
- **Output schemas on every tool** but the five Calfa calls and `learn`:
  6,473 tokens in all, 2,293 of them `catch_up`'s and 1,576 `find_contact`'s.
  A refusal from such a tool is `{ error, message, fix, account_id }` as text.
- **Annotations stated per tool**, for its most far-reaching action, on one
  rule: read-only means it changes nothing on WhatsApp and nothing the user
  keeps in wazap (notes, tags, details, `handled`). wazap's own bookkeeping
  (`catch_up`'s mark, caches), a file saved where a local call asked and a
  transcript the user configured are not changes, so `catch_up` and
  `get_media` are read-only and `remember` is not. `link_account` (it starts a
  pairing) is not read-only either; `get_media` is not idempotent (each
  `save_to` writes another file); `learn`, `get_status` and `remember` are
  closed-world; `manage_chat` stays destructive, for `clear`, `delete` and
  `block`; `edit_message` is destructive. `get_media` read-only departs from
  the 1.0 design, which counted a billable transcription against it: a session
  over OAuth (ChatGPT, claude.ai) cannot pass `save_to`, so there it only
  reads; the transcript is the one the user set up, at most ten a minute; and a
  confirmation on every voice note would break "what does it say?".
- **`send_message` refuses what does not belong to its draft** instead of
  dropping it: two kinds at once, `reply_to` or `mention_ids` on media, a poll
  without its question, a forward with text, text on a voice note or an audio
  file. WhatsApp shows no caption there, so the preview no longer shows one and
  `confirm_send` no longer reports words that never went.
- **The eval tool map 1.0** names the 20 tools and is the default of
  `run-claude`, `score` and `manual`; a run recorded against 0.23.x scores with
  `--tool-map 0.23`.

### Added

- **What an answer asks of the assistant is in its structured content.**
  Claude Code hands the model a tool's structured content, not its text, so
  guidance that lived only in the text never reached it. Short fields now carry
  it: `next` on a `send_message` draft and on a `manage_group` join preview;
  `notes` on `search` (meaning search unavailable, weak matches, a capped scan,
  people tagged `#private` left out, stale history), on `read_messages`
  (photos without a preview, stories left out), on `catch_up` (an account not
  connected, a sync still running, entries left for `more.cursor`), on a
  `find_contact` tag list cut by `limit`, and on a draft to someone not saved
  or written off the user's style. The output schemas declare them; the five
  tools Calfa calls only gain keys.
- **A draft comes before the question.** `send_message`'s description and the
  server's instructions say it sends nothing, so an assistant drafts as soon as
  it has the recipient and the text and shows the preview the draft returns,
  instead of writing a preview of its own and asking first; a contact
  `find_contact` resolves in a session that can write says the same in `next`.
- **The yes is a yes to one draft: this text, this recipient.** A send asked in
  the same request that gave the text ("change it to «ajung la 6» and send") is
  that yes, and asking again only leaves the message unsent; a yes about
  something else, or one that comes after the talk moved to another subject, is
  not, and the preview is shown again instead. The rule reads the same in the
  draft's `next`, in `send_message`'s and `confirm_send`'s descriptions, in the
  server's instructions and in the send skill. `confirm_send` keeps its
  arguments and its idempotence; what words are approval it still reads from
  the conversation, with the one stop below.
- **A draft the talk moved past is refused, not sent** (`DRAFT_STALE`, new
  code). When the session made any other tool call after a draft, the yes it
  now has answered that call, not this preview: `confirm_send` refuses without
  sending, the draft is left untouched, and the fix says to call `send_message`
  again, show the new preview and ask for a yes to it — words alone had an
  assistant answer another question and then send on the "yes, great" that
  followed. A draft confirmed with nothing in between sends as before, so does
  a message whose request already carried the send, and a confirm that reached
  WhatsApp keeps answering its receipt or `SEND_OUTCOME_UNKNOWN`. Several
  messages are drafted and confirmed one at a time, not all drafted and then
  all confirmed. **Sessions on a static token are not held to it:** a builder's
  own program (Calfa and the like) has its own approval flow, and the five
  tools it calls keep their behavior. The stop applies to an assistant's
  session — stdio and the daemon's bridge (`local`, `local:<client>`) and a
  hosted agent that signed in (`oauth:<client_id>`).
- **A session that only reads says so.** Its server instructions say it
  cannot draft or send, and that a request to send is answered by saying so and
  offering the text for the user to send from their phone; a contact
  `find_contact` resolves there carries `can_draft: false` with the same words
  in `next`.
- **An expired draft asks for a new yes.** `DRAFT_EXPIRED`'s `fix`, its line in
  `learn` and `confirm_send`'s description say to draft again, show the new
  preview and wait for a new yes: the yes given to the expired draft does not
  carry over to the new one. `DRAFT_NOT_FOUND` says the same. The codes are
  unchanged.
- **A send whose outcome is unknown is not reported as failed.**
  `SEND_OUTCOME_UNKNOWN`'s `fix` and its line in `learn` say to tell the user
  it may or may not have arrived, never to confirm or draft it again unasked,
  and that a chat not showing it yet does not mean it failed. `read_messages`
  on the newest page of that chat lists it in `unconfirmed_sends`
  (`draft_id`, `text`, `handed_at`, `state: "unknown"`) with a note, until
  WhatsApp echoes it and it reads as the user's own message.
- **Older history the phone did not send is not "no messages".** When
  `read_messages` with `before` runs past what wazap holds and asks the phone,
  its answer carries `older: { asked_phone: true, received }`; with nothing
  received, a note says older history may still exist on the phone.
- **A role filed with `remember` finds the person.** A `relatie` or `role`
  detail that is not a relationship word ("dentist", "contabil") is matched as
  a name, whole words only, in the forms a role is said in: "dentista",
  "dentistei" and "dentistul" find `relatie: dentist`, "profesoarei" finds
  `role: profesor`. Such a match resolves like a name.
- **An account's name leads to its `account_id`.** With several accounts, the
  server's instructions name each one (`Accounts: personal (Personal,
  default), work (Business).`, or only how many past eight); `find_contact`
  asked for an account's name or id answers `not_found` with a `fix` naming
  the `account_id` to pass; `catch_up`'s description says `account_id`
  narrows it to one account.
- **`catch_up` over an explicit window tells old asks from new.** With `hours`
  or an ISO `since`, `waiting` still lists every ask open in the last 14 days,
  and one asked before the window carries `before_window: true` and says "from
  before this window"; when nothing arrived in the window, the answer says so
  first, in the text and in `notes`. The description says `waiting` is every
  open ask, whatever the window.
- **One name on several accounts: look before asking.** Each `find_contact`
  candidate with an ask of theirs still open carries `waiting`
  (`since`, `ago`), the one `catch_up` lists — open until the user answers it,
  files it `handled` or it is 14 days old — with no word of what they wrote.
  When the candidates are one name with one on each account, the `fix` names
  the two things that decide it, either one enough: exactly one candidate has
  `waiting`, an open ask of theirs, and the request answers it; or what the
  request is about (a file, a topic) is in one candidate's conversation, read
  with `search` and `from`, or with `find_contact` again on a candidate's
  `number_tail` and `account_id`. Then it says to go on with that account and
  say which one, and to ask only when nothing tells them apart. People with different names stay the user's to settle:
  "ask, never pick one yourself". Nothing goes out on a guess either way — a
  draft's preview names the recipient, the number and the account, and the
  user says yes to that. `find_contact`'s description points at the `fix`, and
  the output schema declares `waiting`.
- **`find_contact`: who "mama", "Ana de la contabilitate" or "Mișu" is.** A
  read tool, in every session. It matches saved, business and self-given names, the
  `nickname` and `relatie` details, tags, and a note that is only the
  relationship; diacritics and Romanian case endings do not matter, short forms
  find the full name, groups are found by name. It answers `resolved` with the
  `chat_id`, `ambiguous` with what tells the candidates apart (last exchange,
  messages in 90 days, groups in common, note, tags, the number's last four
  digits), or `not_found` with the closest names, and never shows a message's
  words or a full number for anyone it is not sure of. `qualifier` narrows by a
  tag, detail, note, business or group, or by the last four digits. Without
  `account_id` it searches every account and labels each candidate. It has an
  output schema.
- **Draft context.** A contact `find_contact` resolves, in a session that can
  send, carries the last 8 messages both ways and how the user writes there
  (language, diacritics, tu or dumneavoastră, length, emoji), from the user's
  own messages, never from what wazap sent. On by default; a contact tagged
  `#private` on any linked account gets the style only, a group's context
  leaves out what they wrote, and `wazap config draft-context off
  [--account <id>]` turns it off for an account (`draft_context: false` in
  `accounts.json`).
- **`style_check` on `send_message` drafts.** A text draft to someone the user
  has written to at least five times in 90 days carries `style_check`:
  `warnings` among `language_mismatch`, `diacritics_mismatch`,
  `address_mismatch` and `length_outlier`, with the `basis` they were measured
  on, and the preview says what does not match. Additive: the arguments and
  every field `send_message` returned before are unchanged, and it never
  blocks a draft.
- **A chat the user has hardly written in takes its language from the
  recipient.** With fewer than five of the user's own messages there, their
  style falls back to the whole account, which says nothing about that one
  chat — a draft to someone who writes another language had nothing saying so.
  `find_contact`'s draft context now carries `style.their_language`, what the
  recipient writes there, read off their own messages by the same function-word
  tables (never by diacritics) and only once three of them agree; and
  `style_check` answers `language_mismatch` against it, judging nothing else.
  **`style_check.basis` now carries `from`**: `"user"` for the basis as it was,
  `"recipient"` for this one, where the fields are `messages`, `days` and
  `language`. The user's own messages in the chat win whenever there are five
  of them, a `#private` contact on any linked account gives no language either,
  and the warning still blocks nothing: the draft's `next` asks for it again in
  that language before any preview is shown.
- **The address book is asked for when `find_contact` needs it.** With no
  contact carrying a saved name, the first `find_contact` of a server run asks
  WhatsApp for the address book, as `wazap contacts resync` does, and waits up to 15
  seconds before answering, at most once a week.
- **`catch_up`: what the user missed, in one call.** Ranked sections — who is
  waiting on a reply (the ask quoted, a voice note by its transcript, and what
  they said after it), mentions, replies and unanswered polls (muted groups
  included), missed calls per person, people who wrote, groups one line each,
  stories — with a footer for untranscribed voice notes and what was left out.
  It fits `budget_tokens` (2,500 by default, 500 to 8,000): the lines first,
  then quotes by priority, and a `more.cursor` for the rest: the first page
  holds the whole digest for 15 minutes past each page, so the next pages give
  exactly what it worked out, whatever arrives or is read in between. A cursor
  only its own client can use, and an expired one is `CURSOR_EXPIRED`, with the
  mark not moved. A chat's messages count as missed
  after the user's own last message there and after what their phone already
  read. Without `account_id` it covers every linked account, each labelled.
  See *Catching up* in the README.
- **A catch-up mark per client.** Each OAuth client, each token
  (`token:read`, `token:write`) and each local MCP client by its name
  (`local:claude-code`, over stdio or sharing a running wazap) keeps its own
  mark per account. A catch-up moves it once all of it was given, before the
  answer is sent, so `since: "previous"` repeats the last one, a lost answer
  included; `hours`, an ISO `since` from the last 14 days and a partial
  `include` leave it where it is. The mark follows the order messages reached
  wazap, not their timestamps, so a message filed late (a missed call stored
  when it stops ringing, a retried decryption, a clock ahead) is in the next
  catch-up instead of under the mark.
- **`#no-catchup`**: a person tagged with it through `remember`
  stays out of every catch-up: their chat is left out and counted in the
  footer, and nothing they send in a group or post as a story shows.
- **`#private` in a catch-up**: a person tagged with it is counted and never
  quoted — their asks, what followed, their messages, their mentions and polls
  in groups, a group's quote — and their entries say `private`; their unheard
  voice notes are counted in the footer, never named for transcription. Both
  tags filed on one linked account hold on every account a catch-up reads, with
  `account_id` or without.
- **`#private` in every read that does not name the person.** Their words
  (text, caption, transcript, quote, a link's or file's preview, a poll's text)
  reach the assistant only when a call names them: their `chat_id`, a
  `message_id` of theirs, or `search` with `from`; a group named by `chat_id`
  reads whole. `search` without `chat_id` leaves their chat and what they write
  in groups out before `limit`, by meaning and words, by words and on the
  fallback, and counts them in `private_omitted`; a quote of theirs keeps its
  author, not its words. `wait_for_messages` without `chat_id`,
  `list_chats`' last message and `read_messages` on `"status"` keep the entry,
  with `text: "[private]"`, `private: true` and no preview. Filed on one
  account, the tag holds in these reads on every other account. `remember`, `learn`, the
  inbox and recall skills and the README (*Keeping someone private*) state the
  rule; the output schemas declare `private_omitted` and `private`. The webhook
  is unchanged.
- **An upgrade copies the database before it migrates it.** The first start on
  a data dir an older wazap wrote leaves
  `accounts/<id>/wazap.<old version>.pre-migration.sqlite` beside the account
  database — the file as it was, whole, openable by the wazap that wrote it —
  and only then migrates. The copy is taken under the write lock the migration
  itself takes, so two wazaps starting at once leave one copy and never one of
  a half-migrated file, and a copy a run already left is kept rather than taken
  again. **If it cannot be taken, the upgrade does not start** (`BACKUP_FAILED`,
  a storage code): a full disk is refused before the first byte, and the message
  says what failed without naming a path. `WAZAP_PRE_MIGRATION_BACKUP=0` upgrades
  without one, for someone who means it. The copy is deleted a week later at a
  start — never while the upgrade it belongs to has not landed, at once under
  `WAZAP_RETENTION=1` — and `wazap status` shows it per account, in `--json` as
  `storage.accounts[].pre_migration` and on screen as a `pre-migration copy`
  check with the schema it was taken from, its age and when it goes.
- **`wazap backup <path>`** writes one copy of an account database where you
  ask, online and read-only, with the server running or stopped: `0600`, the
  whole account, `--account <id>` to pick one, `--force` to replace a file
  already there, and a refusal rather than a write over the live database or a
  link to it. The file is not encrypted and holds every message the account has.
- **Two wazaps opening the same database that is not in WAL yet wait for each
  other** instead of one of them failing to start with "database is locked".
  Switching a file's journal mode needs the whole file, and SQLite refuses at
  once rather than waiting the way it waits for everything else; now the wait is
  wazap's own, bounded by the same busy timeout. It comes up for a database
  restored from a backup, which a copy leaves in the plain journal mode.
- **`docs/stability.md` states what 1.0 keeps and what it does not**: the tool
  surface, the Calfa five, the safety behaviours, the CLI, the webhook, the
  on-disk data, the settings and the version policy, each line naming the test
  that holds it or saying there is none. `test/stability-doc.test.mjs` reads it
  back against the registry, the schema version and the constants, so a promise
  the code cannot keep fails the suite.

### Removed

- **`save_contact`, `remove_contact` and `set_profile_picture`.** An
  assistant filing people does it with `remember`, which stays on this machine;
  editing the phone's address book or the account's own photo is something the
  user does on the phone. A group's photo stays in `manage_group`.
- **What the old catch-up tools did beyond `catch_up`:** `get_recent_messages`
  with `compact`, `include_system`, `types` or `include_previews` over a whole
  window (`read_messages` keeps `types` and `include_previews` for one chat),
  and `get_unanswered`'s `min_age_hours` and `max_age_hours` (`catch_up`'s
  `waiting` keeps asks for 14 days). A digest within a token budget replaces a
  dump that ran to 100k tokens over a week.
- **`sync_contacts` on demand, and `get_contact`'s `about`, `profile_pic_url`
  and `is_blocked`.** `find_contact` asks WhatsApp for an address book that
  looks empty on its own, and `wazap contacts resync` still forces it while no
  server runs.
- **The Gemini CLI extension.** `gemini-extension.json`, the generated
  `GEMINI.md` and `npm run context:build` are gone. `wazap connect gemini`
  still writes the MCP entry, and the Gemini CLI gets the five workflows from
  the server as MCP prompts, like every client without a skills directory.
- **`wazap connect vscode`, `windsurf` and `opencode`, and
  `wazap skills install opencode`.** `connect` knows `claude-code`,
  `claude-desktop`, `cursor`, `codex` and `gemini`; `skills install` knows
  `claude-code`, `codex`, `cursor` and `agents`. `setup` offers the same five
  clients.
- **The Install in VS Code badge**, and its https form. The Cursor link stays.
- **The Grok Bot guide, and `setup`'s `Remote client (Grok Bot / HTTP MCP)?`
  question** with the URL and header notes it printed.
- **Bearer-token notes aimed at agents.** `get_status`, `wazap status`, doctor,
  `setup`, `connect`, `expose` and the `wazap-setup` skill no longer explain
  that a write token is not writes being enabled, and the skill sends a remote
  agent to `wazap expose` instead of to tokens. `WAZAP_READ_TOKEN` and
  `WAZAP_WRITE_TOKEN` work exactly as before; the README describes them once,
  under *Building on wazap (HTTP API for products)*.
- **Link previews.** Text sent, confirmed or edited goes out without a preview
  card, and nothing fetches the linked page: wazap's bounded preview fetcher is
  gone, and both text paths still hand Baileys an explicit `linkPreview: null`
  so its own unrestricted fetcher stays off. Forwarding still keeps a preview a
  message already carries.
- **Nine settings, now fixed.** Each one still set in the environment or in
  `.env` prints one warning at startup saying what replaced it, and is ignored;
  nothing refuses to start.

  | Setting | Now |
  | --- | --- |
  | `WAZAP_SYNC_FULL_HISTORY` | WhatsApp's default history sync; `read_messages` with `before` pulls older messages |
  | `WAZAP_RATE_LIMIT` | 20 writes a minute, unless the account sets `rate_limit` in `accounts.json` |
  | `WAZAP_MAX_INFLIGHT` / `WAZAP_MAX_INFLIGHT_TOTAL` | 8 tool calls per MCP session, 32 in all |
  | `WAZAP_HTTP_BUDGET` | 240 requests a minute per HTTP credential |
  | `WAZAP_TRANSCRIBE_LANGUAGE` | the language is detected; `get_media` still takes `language` |
  | `WAZAP_EMBED_IDLE_MINUTES` | the embedding server stops after 30 idle minutes |
  | `WAZAP_RECALL_MAX` | nothing: it capped nothing since 0.22 |
  | `WAZAP_TYPEWRITER` | the setup screens always type out at a terminal |

- **Settings documentation, down to what a user sets.** The README's Settings
  table, `.env.example` and `wazap --help` list `WAZAP_DATA_DIR`,
  `WAZAP_READ_ONLY`, `WAZAP_PERSIST_HISTORY`, `WAZAP_HOST`/`WAZAP_PORT`, `WAZAP_PUBLIC_URL`/
  `WAZAP_OAUTH_PASSWORD`, `WAZAP_READ_TOKEN`/`WAZAP_WRITE_TOKEN`,
  `WAZAP_TRANSCRIBE` with `WAZAP_TRANSCRIBE_API_KEY`, `WAZAP_RECALL`,
  `WAZAP_WEBHOOK` with its URL, secret and events, `WAZAP_RETENTION` and
  `WAZAP_TRUST_PROXY`. `WAZAP_NO_SHARE`, `WAZAP_NO_UPDATE_CHECK`,
  `WAZAP_TRANSCRIBE_AUTO`, `WAZAP_TRANSCRIBE_URL`, `WAZAP_TRANSCRIBE_MODEL`,
  `WAZAP_WHISPER_MODEL`, `WAZAP_WHISPER_BIN`, `WAZAP_EMBED_MODEL`,
  `WAZAP_EMBED_BIN` and `WAZAP_RECALL_MIN_SIMILARITY` are still read, for the
  tests, and are no longer documented as settings.
- **Tool counts** in the package description and the README, which had gone
  stale, and the unused `scripts/smoke-distribution.mjs`.

### Deprecated

- **`WAZAP_TRANSPORT`.** `WAZAP_TRANSPORT=http` still serves HTTP through
  1.x, and prints one warning at startup that `--http` is the supported way;
  the variable goes away in 2.0.

### Changed

- **The README is short; the reference moved to `docs/`.** What wazap is, how
  to start it, the 20 tools in a line each, what it does about privacy and what
  it cannot do, and nothing else. Everything the README used to carry is in
  `docs/` word for word — install, tools, voice, recall, data, accounts, send
  rules, self-hosting, the HTTP API and webhook, settings — linked from the
  README's own index. `test/docs-links.test.mjs` fails on a relative link or an
  anchor that does not resolve.
- **The five skills use the 1.0 tools.** `whatsapp-inbox` collects with
  `catch_up` and reads a busy chat with `read_messages`; `whatsapp-send` drafts
  every kind with `send_message` and files people with `remember`;
  `whatsapp-recall` searches with `search` and opens files with `get_media`.
- **The account database moves to schema version 5** the first time the server
  starts, in one transaction. It adds what the coming `catch_up` and
  `find_contact` read: whether a message mentions the account or was sent
  through wazap, the order messages reached the account in, each chat's newest
  message of the account's own and how far the phone has read it, and where
  each client's catch-up left off. Messages of the
  last 14 days get their mentions in the background after the start. A build
  before this one refuses a version 5 file (`SCHEMA_TOO_NEW`), so the way back
  is the copy the upgrade takes first (`wazap.4.pre-migration.sqlite`, kept
  seven days) or one made with `wazap backup`.
- **`get_status` counts the read receipts the phone sends**
  (`diagnostics.read_self`), so it can be checked that they arrive; nothing acts
  on them yet.
- **`wazap status` shows OAuth sign-ins when the background service is
  installed.** It used to say OAuth was only served with
  `WAZAP_TRANSPORT=http`, even while the service served it; without the
  service, it now names `wazap serve --http`.
- **A read of an account database counts what its write-ahead log holds,
  even when the shared memory beside it is gone.** After a crash the log can
  outlive its `-shm` index, and `status` then reported the counts of the last
  checkpoint as if they were current. It reads the log now; it still writes
  nothing, and still leaves no file beside a database nothing has open.

### Upgrade notes

- **Node.** `engines` is now `^22.16.0 || >=24.0.0`. The 23 line lacks
  `node:sqlite` features wazap needs, and `wazap status` already refused it;
  npm now says so at install.
- **A client whose `connect` target is gone** (VS Code, Windsurf, OpenCode)
  takes the generic entry by hand: command `npx`, args `["-y", "wazap-mcp"]`,
  over stdio, in that client's own MCP config. A client that reaches a running
  server by URL uses `https://your-host/mcp` and signs in with OAuth. The
  entries `connect` already wrote keep working.
- **OpenCode**: delete the skill copies wazap put there, which `update` no
  longer refreshes: `rm -rf ~/.config/opencode/skills/wazap-setup
  ~/.config/opencode/skills/whatsapp-*`. Register the generic MCP entry in
  `~/.config/opencode/opencode.json` (under `mcp.whatsapp`:
  `{ "type": "local", "command": ["npx", "-y", "wazap-mcp"] }`) if `connect`
  did not already write it. The server hands OpenCode the five workflows as MCP
  prompts, and `wazap skills install codex` copies them to `~/.agents/skills`,
  which OpenCode reads too.
- **The Gemini extension**: `gemini extensions uninstall wazap`, then
  `npx wazap-mcp connect gemini`.
- **Grok Bot, or any agent on a static header**: give it a URL instead.
  `wazap service install`, then `wazap expose`, prints it, and the agent signs
  in on the consent page. Code of your own keeps its tokens.
- **`WAZAP_TRANSPORT=http`** keeps working, with a warning. Before 2.0, add
  `--http` to the command your supervisor or container runs
  (`wazap serve --http`) and drop the variable. `wazap service install`,
  `deploy/wazap.service` and the Docker image already pass `--http`.
- **`WAZAP_PERSIST_HISTORY=0`** is unchanged: it stays a documented setting,
  and no messages are kept on disk.
- **`WAZAP_RATE_LIMIT`**: set `rate_limit` (writes a minute, `0` for none) on
  the account in `accounts.json`.
- **Silence the warnings** by deleting the retired lines from `.env` or the
  environment, and by moving `WAZAP_TRANSPORT=http` to `--http`.

## 0.23.1
### Fixed

- **`recall` again answers a short question padded with function words.** The
  two-word rule for long queries counts only content words, so "what time are
  we meeting" keeps a hit sharing one of them; "the", „când” or „este” never
  count as a match, and a query made only of such words needs its hits'
  meaning to clear the floor.
- **`recall` finds an old message that matches closely again.** Meaning
  candidates were cut after an age decay that halved a match every month, so
  fresh weak matches crowded out an older close one, and a hit sharing a word
  was lifted by a meaning under the floor. Candidates are now the most similar
  messages, age weighs a match down to 85% a month on and never under 70%, for
  its rank and for the floor, and a meaning under the floor adds nothing to a
  hit's score.

## 0.23.0
### Changed

- **`confirm_send` sends a draft at most once.** Drafts live in the account
  database with the WhatsApp message id they go out under. Confirming a sent
  draft again answers its receipt with `already_sent: true` instead of
  `DRAFT_NOT_FOUND`, for 24 hours, and two confirms at once send once. A
  failure once the message is handed to WhatsApp's relay answers the new
  `SEND_OUTCOME_UNKNOWN`, a stop in the middle included, and never sends that
  draft again; it used to put the draft back, so a timeout could become a
  second message. The draft counts as sent once WhatsApp echoes its id, and a
  send a crash interrupted is unknown after the restart. A failure before the
  relay (not connected, the write budget, the number lookup, a media upload)
  still keeps the draft, with the same code as before. Drafts are capped at 20
  per MCP session, instead of 20 per account, and 200 per account. Deleting a
  sent message or clearing its chat takes its words out of the send record, and
  `WAZAP_PERSIST_HISTORY=0` keeps no drafts and no send words across a restart.
- **A number lookup WhatsApp does not answer is `NOT_CONNECTED`**, not
  `NOT_ON_WHATSAPP`: only an answer says a number has no WhatsApp.
- **Echoes of wazap's own sends stay quiet after a restart.** The webhook
  recognises them by the message ids confirmed drafts recorded, not only by
  the last ten minutes of sends in memory.
- **Voice notes are transcribed from a durable queue.** The queue is kept in
  the account database, queued in the transaction that stores the note, so a
  restart or a crash resumes it instead of losing what was waiting. A failed
  download, a provider answering 429 or 5xx, or a whisper.cpp crash is retried
  after 10 s and a minute, three attempts in all; expired media, audio the
  provider refuses and files too large give up at once and record why. A note
  deleted or expired while it waits is dropped, and one still waiting a day
  after it was queued is given up on (`too_old`). A note queued under `local`
  is never uploaded to an API provider configured later (`provider_changed`).
  One transcriber serves every account in turn, only in the server, and a
  note that just arrived starts ahead of any backlog, so its webhook event
  carries the words. A provider that cannot take any note (not ready, key
  refused) pauses transcription for 30 s up to 15 minutes instead of
  downloading and uploading every note again, and events post the placeholder
  at once meanwhile. A stop waits up to 30 s for a transcription under way;
  removing an account cancels it. Notes a history sync brings are now
  transcribed when less than a day old (before, never). `get_status` has a
  `transcription` block and `wazap status` a `voice queue` line: counts, the
  current run's age, a pause and the latest reason, never content.
- **Webhook events survive a restart.** Each event waits in an outbox inside
  the account database, written with the message it announces, and is posted
  one at a time per account, in the order it was queued within its chat; a
  chat waiting for a retry or a transcript holds back no other chat. A
  timeout, an unreachable receiver, `408`, `425`, `429` or `5xx` is retried
  after 1 s, 5 s, 30 s, 2 min, then every 5 min and a last time at 24 hours,
  and at once when new traffic shows the receiver may be back; any other
  `4xx` still fails at once. After an outage only the newest `connection`
  status is posted. A POST a crash interrupted is sent again, so a receiver
  may see an event twice: dedupe on `message_id`. A message event carries the
  message as it is when posted, with an edit or transcript that arrived
  meanwhile, and is not posted at all once the message is deleted, expired or
  cleared. A voice note's event waits on the transcription queue, a restart
  included, and goes at once when its transcription fails or the provider is
  paused. Nothing waits in memory any more, so no event is dropped for a full
  backlog.
- **Webhook message events carry `contact_id` and `phone`.** `contact_id` is
  the sender's stable contact in the account database, and `phone` their
  number in E.164, `null` while unknown. `read_messages` and the other message
  views add `sender.contact_id`; `list_chats` adds `contact_id` and `phone`
  for one-to-one chats. No existing field changed.
- **`webhook.delivery` counts the outbox.** `delivered` covers the last 7
  days, `failed` and `cancelled` the last 30; `cancelled`, `pending`,
  `retrying`, `last_status` and `oldest_pending_at` are new. `wazap status` and
  doctor read it from the account database, server running or not; they warn
  while an event is being retried and fail once the oldest has been retried
  for 10 minutes. `accounts/<id>/webhook.json` is no longer written.

### Fixed

- **`recall` no longer answers a long question with one-word coincidences.**
  When a query has three or more words, a hit found only by its words must
  share at least two of them, or its meaning must clear the similarity floor;
  a question with no answer comes back empty again. An exact copy of a
  better-ranked hit, such as the same message forwarded to two chats, is
  listed once.

### Upgrade notes

- The account database moves to schema version 4 on the first start: version
  2 holds the drafts and sends, version 3 the voice-note transcription queue,
  which starts empty (nothing stored before the upgrade is transcribed on its
  own), version 4 the webhook outbox, which starts empty too. 0.22 refuses a
  version 2, 3 or 4 database (`SCHEMA_TOO_NEW`), and there is no downgrade:
  going back means restoring a copy taken before the upgrade.

## 0.22.0
### Changed

- **Every account is served from one database.** Chats, contacts, messages,
  reactions, votes, receipts, transcripts, notes, recall vectors and deletion
  barriers live in `accounts/<id>/wazap.sqlite`, and no history is held in
  memory: a restart, a chat with thousands of messages and an edit to an old
  message read the same file. The first start after the upgrade imports
  `store.json`, `history/`, `retention.json`, `notes.json`, `recall/` and the
  beta archive once, resuming if it is stopped; meanwhile the account's tools
  answer `NOT_CONNECTED` and `get_status` says it is preparing. Once imported,
  the legacy files move into `accounts/<id>/legacy/`, and the beta archive into
  `<data-dir>/legacy/` once every enabled account linked to its number has
  imported it; both are deleted a week later, at once with
  `WAZAP_RETENTION=1`. Only what wazap moved is deleted, never through a link.
  An import whose check found differences it could not explain keeps its
  legacy files until you delete them. An account not linked at the upgrade
  imports the beta archive once its number links; until an account has, the
  archive stays where it is.
- **`search_messages` has no per-chat window.** Every kept message is
  searched, and `coverage.per_chat_cap` is `null`. A query so short or so
  common that the search reaches its scan limit answers `scan_capped: true`
  and `searched_back_to`, with a line saying to narrow it.
- **`recall` matches by words and meaning at once**, fusing the two rankings;
  each hit says which matched, and `similarity` is `null` for a hit found by
  its words alone. A match found by meaning still fades with age, one chat
  still takes at most three leading places and a near-duplicate still trails.
  The index is kept in the database and indexing resumes where it stopped; a
  text the embedding server refuses is skipped until its words change.
  `WAZAP_RECALL_MAX` no longer caps anything.
- **`WAZAP_PERSIST_HISTORY=0` removes stored messages at every start and
  stop**, not only under `WAZAP_RETENTION=1`; barriers, chats, contacts and
  notes stay.
- **Logout deletes only the credentials.** The account database stays, tied
  to the number, so the same number linking again finds its history, and an
  earlier wazap's `store.json` is left to the legacy files' week instead of
  being deleted. A different number linking sets the database aside as
  `wazap.<time>.previous-owner.sqlite` and never imports the earlier number's
  files; the earlier number linking again gets its database back. A set-aside
  database nobody links is deleted a week later, whatever `WAZAP_RETENTION`
  says. `account remove` still deletes the whole folder.
- **`wazap status` reports each account's storage**, read-only, with the
  server running or not: preparing (with the import phase), ready, imported
  with unexplained differences (by category and count) or failing to open;
  the database's size, messages, chats and embedding queue; the legacy files
  and when they are deleted; set-aside databases; and the beta archive.
  `status --json` carries it as `storage`, and `get_status` as `storage`.
- **A handled chat reopens only when the other side writes after the ask**
  that was marked, and a receipt keeps the latest time it was reported.
- **Accounts come and go without a restart.** A running server follows
  `accounts.json`: `wazap account add`, `enable`, `disable`, `default` and
  `remove` apply to it at once, and a tool that names an account added since
  it last looked reads the registry again before answering
  `ACCOUNT_NOT_FOUND`. An added or enabled account gets its own socket; a
  disabled or removed one is stopped, and calls that name it answer
  `ACCOUNT_DISABLED` or `ACCOUNT_NOT_FOUND`. `account remove` stops the
  account before its folder is deleted. The last account a server runs keeps
  running until it stops, since a server with none refuses to start.
- **`wazap logout` works while a server runs.** Instead of refusing with
  `wazap is running (pid N)` unless the server was the `wazap service`, logout
  asks the running server to log the account out: it closes that account's
  socket and any pairing in flight, unlinks it from WhatsApp and deletes its
  credentials as an offline logout does, and keeps serving the
  other accounts. The account comes back not linked, so `link_account` can
  link it again. Output and exit codes are the offline ones.

### Security

- **The CLI reaches the running server over a private control line.** It is
  its own listener on an ephemeral `127.0.0.1` port, opened only by a random
  token the server writes to `<data-dir>/control.json` (`0600`). It is not the
  MCP listener a tunnel or proxy points at; `WAZAP_READ_TOKEN`,
  `WAZAP_WRITE_TOKEN`, OAuth grants, the bridge token and anonymous callers
  are refused; requests with an `Origin` or a non-loopback `Host` are refused;
  and no MCP tool reaches it. It exists with or without `WAZAP_NO_SHARE`.

### Upgrade notes

- **The first start imports each account once**, before serving it (see
  above); `wazap status` shows the phase. A rollback to 0.21 loses everything
  from the 0.22 period (messages, edits, notes, deletions: messages deleted
  meanwhile show again) and is impossible with `WAZAP_RETENTION=1` or once the
  legacy files' week is over. Back up the data dir first; the order of steps,
  and how to upgrade again without losing the 0.22 database, are in README,
  "Rolling back to 0.21".
- A server started by an older wazap has no control line: against it,
  `account` changes still say to restart, and `logout` and `account remove`
  still refuse. Restart it once on the new version.

## 0.21.0
### Security

- **An HTTP session belongs to the credential that opened it.** A session id
  used to select its transport whatever token came with it, so a read token, a
  different write token or an anonymous reader holding the id could drive a
  write session. Sessions are now bound to a fingerprint of the exact
  credential and its permissions; anyone else gets 404.
- **A draft can only be confirmed from the MCP session that made it.** Any
  write client could confirm another client's draft by id. A foreign or
  unknown draft now answers `DRAFT_NOT_FOUND` without revealing the recipient
  or consuming it. A new session, including one opened after an OAuth token
  rotation, drafts again.
- **Remote clients cannot read files off the server.** An HTTP write token
  could send any local file as media or a picture, and any client could pick
  the `download_media` directory. HTTP sessions, static tokens and OAuth alike,
  now refuse `file_path` and `save_to`; public URLs, forwards and the default
  download directory still work. Local stdio and the private daemon token used
  by bridges keep file access.
- **Forwarded addresses are trusted only from named proxies.** Every private
  peer counted as a proxy, and `CF-Connecting-IP` alone could pick the password
  lockout identity. `WAZAP_TRUST_PROXY` now lists the proxies that may supply
  `X-Forwarded-For` (default `loopback`, `none` for none), and the compose file
  trusts its own gateway.
- **Transcription endpoints no longer follow redirects**, and provider errors,
  signed URLs and decoder output no longer reach errors or logs; failures keep
  their HTTP status or error code (`ECONNREFUSED`, `CERT_HAS_EXPIRED`, exit codes).
- **ffmpeg reads only local media files**, never network protocols, playlists
  or image sequences, for previews, GIFs and transcription.
- **HTTP logs name only known routes and RPC methods**, never query strings,
  arbitrary paths or request body excerpts.
- **A revoke only removes a message in the chat it arrived in.** A protocol
  message could name a message in another chat as its target.
- **OAuth refresh tokens rotate**, and a consumed one replayed after a 60-second
  grace window revokes its grant. Registrations, grants, consent pages and
  codes have hard caps, and a damaged `oauth.json` signs every agent out
  instead of being trusted.
- **A lost account policy fails closed.** Saving `accounts.json` writes an empty
  `accounts.json.required` marker; if the policy then disappears, wazap refuses
  to start with open defaults. Write tools read the policy from disk and never
  fall back to cached send rules. A malformed `WAZAP_READ_ONLY` is an error
  instead of meaning writes on.

### Added

- **Link previews on sent and edited text.** wazap builds the card itself from
  the first link: page and thumbnail fetched through the same DNS-pinned,
  size-capped path as media URLs, four seconds at most, JPEG thumbnails only,
  never while drafting. The sites see the server's public IP. Baileys' own
  unrestricted fetcher stays off.
- **`WAZAP_RETENTION=1`, strict retention, off by default.** Messages marked as
  disappearing expire locally at their earliest known deadline, from memory,
  history, snapshots, previews, transcripts and the recall index; keep-in-chat
  is not an exemption. With it, starting with `WAZAP_PERSIST_HISTORY=0` also
  discards caches an earlier history-on run left.
- **Request budgets**, configurable: eight running tool calls per MCP session
  and 32 in total (`WAZAP_MAX_INFLIGHT`, `WAZAP_MAX_INFLIGHT_TOTAL`), 240 POSTs a
  minute per credential (`WAZAP_HTTP_BUDGET`), 100 KiB request bodies, 32
  sessions per credential, and listener timeouts.

### Changed

- **Deleted messages leave no bytes behind.** An observed delete, revoke or
  chat clear now also removes the message from history files, the snapshot,
  automatic previews, transcripts and the recall index straight away, not at
  the next restart. `retention.json` keeps the deleted ids and clear cutoffs,
  without content, so a history sync cannot bring them back. Delete and clear
  tools wait for that cleanup and report a disk failure.
- **The recall index moves to format 3 in place.** Rows and progress are kept;
  nothing is re-embedded on upgrade.
- **Model downloads are bounded and exclusive.** Bytes are counted as they
  arrive and stop at the model's size, a stalled transfer times out after 30
  seconds, and the whole download gets 30 minutes or the model's size at
  100 KiB/s, whichever is longer. Two downloads of the same model no longer
  write one file: the second fails at once and names the lock directory.
- **Anonymous loopback reads require a loopback `Host` and same-origin
  requests**, which stops browser DNS rebinding; any port is accepted.

### Upgrade notes

- HTTP clients that sent `file_path` or `save_to` get an error; send a public
  URL instead, or use stdio.
- Behind a reverse proxy or tunnel that is not on loopback, set
  `WAZAP_TRUST_PROXY` to its address, or every OAuth caller shares one lockout.
  With the compose file, pull it: it pins its network and trusts that gateway.
- Drafts do not survive a new MCP session or an OAuth token rotation.
- Do not delete `accounts.json` to reset it: restore a backup, or delete
  `accounts.json.required` as well to start over on purpose.

## 0.20.2
### Fixed

- **A number WhatsApp moved away from no longer answers as someone else.**
  When WhatsApp pairs a lid with a new number, the old number kept pointing at
  that lid, so it could be named as the other person and deleting its chat
  reached their history too. The old number is now let go, while a number that
  gains a new lid keeps working for the older one, as WhatsApp's own table does.

### Changed

- **One table decides who a lid is.** The lid-to-number pairings lived in
  three maps plus the snapshot copy, and each resolver read a different one.
  They now live in one registry (`src/identity.ts`) with one set of rules for
  ids, names, votes and the account itself. A run comparing the old and new
  code over 400 scenarios found no other change in behavior.

## 0.20.1
### Fixed

- **A disappearing-messages change says who made it and for how long.**
  WhatsApp sends the timer as a protocol message, in a group and a one-to-one
  chat alike, and it read as a bare `[system message]`. It now reads
  "[Ana turned on disappearing messages: 7 days]" or "turned off", with
  `system.action` `set_disappearing` and the seconds as its value.
- **A request to join a group says who asked and what became of it.** It read
  as `[system message · GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD]`
  and now reads "[Ana asked to join]", "[Ana withdrew their request to join]"
  or "[Dan rejected Ana's request to join]", with `system.action`
  `join_request`.

Both were found testing 0.20.0 on a real account: read receipts, group
settings, join requests, poll votes from another number, admin deletes,
mentions, pins, stars, delete-for-me, block and `join_group` all behaved as
documented.

## 0.20.0
### Added

- **Poll votes and event responses land on their poll or event.** A vote is
  encrypted under the poll's secret and bound to the creator's and voter's
  jids exactly as WhatsApp spelled them, lid or number; wazap tries the
  spellings it knows until one authenticates and matches the option hashes to
  the poll's options. A poll carries `poll: {question, options: [{name, votes,
  voters}], voters}`, read_messages tags it "3 votes" and get_message lists who
  chose each option; an event carries `event_responses: {going, maybe,
  not_going}`. A newer vote replaces an older one, a withdrawal sticks, votes
  survive a restart, and votes stored before as lines of their own fold onto
  their poll. A vote whose poll is not loaded reads as "[vote on a poll that is
  not loaded]" until the poll arrives. `send_poll` no longer says votes cannot
  be read.
- **The user's own messages say how far they got.** One-to-one receipts raise
  `delivery.status` from sent to delivered, read and played and never lower
  it; in a group each member's receipt is kept, and `delivery.read_by` and
  `delivery.delivered_to` name who, with the time. A synced message's own
  status and receipts are the floor. read_messages tags "read" or "read by 3",
  get_message lists who.
- **Group admins run the group from wazap.** `manage_group` lists pending join
  requests and approves or rejects them, and sets announcement-only, locked
  info, who adds members, join approval and disappearing messages (`off`,
  `24h`, `7d`, `90d`). `get_group_info` reports those settings and whether the
  group is or belongs to a community. `delete_message` takes someone else's
  message in a group where the linked account is an admin.

- **`join_group` joins a group from an invite.** It takes a link, a code, or
  the `message_id` of an invite someone sent; without `confirm: true` it only
  previews the group (name, description, size, whether an admin must approve),
  and with it joins, or says the request waits for an admin. The invite code
  never reaches the logs. wazap now has 38 tools.
- **More of what the phone does, from `manage_chat`.** Pin and unpin a message
  for everyone (24 hours, 7 days or 30 days), star and unstar a message, clear a
  chat, delete a chat, and block or unblock a contact. The blocklist is read
  when the account connects, so `get_contact`'s `is_blocked` is right from the
  start.
- **Mentions are visible and actually mention.** A message that @-mentions
  people carries `mentions: [{id, name}]`. `send_message` with `mention_ids`
  puts the `@<number>` token WhatsApp needs into the text when it is missing,
  and the draft preview shows exactly the text that will be sent.

### Changed

- **`delete_message` needs `for_everyone`.** `true` retracts the message for
  everyone; `false` now deletes it only for the linked account instead of
  failing. There is no default, so an agent always says which one it means.

### Fixed

- **A deleted chat is gone, and stays gone.** Deleting or clearing a chat,
  from wazap or from the phone, removes its messages instead of leaving the chat
  in `list_chats`; they no longer come back when the server restarts, and
  `recall` forgets the whole chat, older indexed messages included. A message
  deleted only for the linked account stays deleted after a restart too.
- **A mentioned person, a reactor or a voter no longer borrows the sender's
  name** when wazap knows no name for them.
- **A receipt no longer moves a message in time.** A delivery or read receipt
  carries the moment it happened, and wazap wrote it over the message's own
  timestamp: a sent message jumped to when it was read, and a received one to
  when the phone read it, which reordered chats and aged asks wrongly.

## 0.19.1
### Fixed

- **Reinstalling or restarting the macOS service now runs what the unit
  says.** launchd keeps the plist it read when the job was loaded, and a
  restart used `kickstart -k`, which reruns that copy. So `wazap service
  install` over an existing service, `wazap service restart` after an update
  and `wazap expose` rewrote the unit and kept running the old command — an
  upgrade to a global install could go on serving the previous build. A
  restart now boots the job out, waits for launchd to release it, and loads
  the unit file again. If `wazap status` reports a version older than the one
  you installed, run `wazap service restart` once.

### Added

- **Group notices, pins and business messages read as what they are.**
  Templates, buttons, lists and interactive messages from businesses read and
  search as text, with their button labels; a tap reads as the choice. Pins,
  keeps and a shared chat history say who did it, and a pin carries the pinned
  message's id. Events and group invites have types of their own (`event`,
  `invite`); an invite's code and an event's call link never show. Orders,
  products, status mentions, scheduled calls, poll results, channel admin
  invites and sticker packs get short tags, a message kept off linked devices
  says to read it on the phone, and undecryptable, disappearing-mode, block,
  username, community and business-privacy notices are spelled out instead of
  `[system message · …]`.

## 0.19.0
### Security

- **Private encryption keys no longer reach stdout or the logs.** The Signal
  library prints whole session records, private and root keys included, with
  `console.info`. Over stdio that corrupted the MCP stream; under the service
  it landed in a world-readable log. Every console line from a dependency now
  goes to stderr, and a session record is cut down to the phrase that
  announced it. The service's log directory is `0700` and its logs `0600`,
  including logs launchd already created. Delete old `*.out.log` files that
  may still hold keys.
- **The OAuth consent page names who is really asking.** Client registration
  is open, so a client's name is only its own claim: the page and its tab now
  name the host the code goes back to, and show the client's name as unchecked.
  OAuth pages cannot be framed (`frame-ancestors 'none'`, `X-Frame-Options`),
  send no referrer and are never cached.
- **A stranger's wrong passwords no longer lock the owner out.** Behind a
  tunnel, the caller is taken from `X-Forwarded-For`, or `CF-Connecting-IP`
  when that is all cloudflared sends, and twenty misses from everywhere pause
  consent for a minute instead of fifteen.
- **A tunnel keeps sign-in on.** `wazap expose off` leaves `WAZAP_PUBLIC_URL`
  set while any unit still tunnels to the port, naming it and how to stop it,
  and `serve --http` refuses to start with no token and no sign-in when a
  tunnel reaches its port.
- **`/healthz` tells a stranger only whether wazap is up.** Without a token it
  answers `{ ok, status, since }`; the account list needs a read or write token.
- **Dependencies.** `npm audit fix` for sharp, express, body-parser, qs,
  fast-uri and hono; `npm audit --omit=dev` reports nothing, and CI now checks it.

### Fixed

- **A lost MCP session is a 404.** An `Mcp-Session-Id` wazap no longer holds,
  expired, evicted or lost to a restart, now gets `404`, which tells a client
  to start a fresh session, instead of a `400` it could not recover from.
- **A refused token says so.** A `401` for a token that was sent and refused
  carries `error="invalid_token"`, so a client knows to refresh or sign in
  again, and the request log names the client's User-Agent and OAuth client id.
- **A webhook receiver that refuses is no longer hammered or ignored.** A `4xx`
  other than `408`, `425` and `429` is posted once, with the status and a hint
  in the error, instead of three times per event. Events nobody subscribed to
  no longer take a place in the backlog.
- **The server lock holds under a race.** Two servers that find the same stale
  lock no longer both take it.
- **`.env` is written in one step**, so a failed write never leaves half of it.

### Added

- **Webhook delivery is visible.** `get_status` reports `webhook.delivery`:
  delivered, failed and dropped events, the failing run and the last failure.
  The server keeps them in `accounts/<id>/webhook.json`, so `wazap status`
  fails the webhook check after three failed events in a row and warns on a
  recent failure or drop. A run of identical failures logs a few lines, not one
  per event.
- **Releases ship everywhere from the tag.** The publish workflow checks the
  tag and the CHANGELOG, lints and typechecks, publishes to npm with
  provenance, publishes to the MCP Registry through GitHub OIDC with a
  hash-pinned publisher, and creates the GitHub Release with the Claude Desktop
  bundle `wazap-X.Y.Z.mcpb` attached.

### Changed

- **Node 22 is the minimum** (`engines`, the Claude Desktop manifest, doctor
  and the setup skill). CI tests Node 22 and 24, and a weekly canary runs the
  suite against the newest Baileys.

## 0.18.6
### Added

- **Group notices say who did what.** A group's system messages used to
  read as `[system message]`, so nobody could tell who added whom.
  Additions, removals, leaves, promotions, renames, description, photo and
  invite-link changes, the admin-only settings and member label changes
  now read as `[Medeea added Ana (40723124956)]`, and carry
  `system: {action, actor, targets, value}` with the people put to names
  and numbers. A stub wazap does not spell out yet names its type instead
  of hiding behind `[system message]`.
- **Reactions name who left them.** `read_messages` tags them as
  `❤️×2 😍` instead of a run of emoji, `get_message` lists each one with
  its author, and every reaction in a view carries `name`.
- **`manage_group` sets and removes the group photo.** `set_picture` takes
  `file_path` or `url` under the same JPEG, PNG or WebP, 10 MB rules as
  `set_profile_picture`; `remove_picture` takes the photo down. Both need
  admin rights and reach WhatsApp at once, so the agent shows the image and
  waits for a yes.

### Changed

- **`NOT_ADMIN` carries a fix** on every group action: ask an admin to make
  the linked account an admin, or to make the change themselves.

## 0.18.5
### Added

- **Per-account send rules — `wazap config send`.** An account can now be
  limited in who it may message: `send allow` makes a list exhaustive (and
  `allow none` locks the account to nobody), `send deny` refuses its
  entries whatever else is allowed, `send open` lifts every restriction.
  The rules live on the account record and are re-read when a draft is made
  and again at `confirm_send`, so one written while a draft waits still
  applies to it. A refused send fails `SEND_BLOCKED` naming the rule that
  fired, before the socket is touched — and the agent is told to tell you,
  not to retry or route around it.
- **Read tools say who the sender actually is.** `get_message`,
  `search_messages`, recall and `download_media` add the number behind the
  sender's id and a `name_source` — `contact` when the shown name is your
  own address-book entry, `pushname` when it is the name the sender
  publishes, `none` — with `is_saved` alongside, so a shown name is no
  longer mistaken for a saved contact.
- **Every `search_messages` answer reports its coverage.** How many held
  messages were scanned, across how many chats, and the oldest/newest
  bounds of the window — so "nothing found" no longer reads as "nothing
  synced". The keyword scan covers the whole disk window, not only what
  memory holds.
- **`get_status` reports how fresh the local history is.** The initial-sync
  state and the newest inbound message wazap holds, flagged stale past
  24 h; a scoped query adds the newest message held for that chat.
- **`download_media` returns the media contract.** The saved file now names
  the caption and the original filename the envelope carried.
- **A message id survives re-identification.** A chat first seen under a
  lid keeps its messages findable under both spellings once the number
  pairs, raw `<chat>_<stanza>` ids still reach the record, and an id the
  resolved account cannot file is tried on every other binding before it
  misses.
- **Send drafts render the full preview.** Every send tool's draft shows
  Not sent, the resolved recipient (name + number, or the group), the exact
  body for its kind, and the `confirm_send` instruction. A draft to someone
  known only by a pushName flags `unnamed_recipient` until `save_contact`
  files them under a real name, and `get_group_info` marks digit-named and
  unresolved-lid participants `[unnamed]`. `confirm_send` on a missing or
  expired draft names the recovery instead of failing bare.

### Changed

- **`wazap update` no longer puts back skills you removed.** It used to copy
  the skills into every detected client that lacked them, so deleting them
  from `~/.claude/skills` lasted until the next update. Now it refreshes only
  clients that already hold a copy, stale or upgraded; a client with none is
  left alone. `wazap setup` and `wazap skills install` still install them, and
  a copy missing only some skills, such as one a release added, still counts
  as stale and is refreshed.

### Fixed

- **`wazap config <setting>` with no value is the arity complaint again.**
  `config send` had widened the gate to one positional, so a bare
  `wazap config writes` reached the setter and failed "Cannot set" instead
  of being told a value is missing.

## 0.18.4
### Added

- **The embedding sidecar now sleeps when unused.** An idle `llama-server`
  held ~330-500 MB of RAM for the life of the service even when recall was
  queried once a week. `WAZAP_EMBED_IDLE_MINUTES` (default 30, `0` keeps it
  resident) reaps a quiet server; the next embed re-spawns it transparently.
  The shared registry from 0.18.3 means one clock and one respawn for every
  account on the same model.
- **Recall results are diversified and keyword-aware.** A single chat used
  to fill every slot of a clustered answer; now it holds at most three
  leading slots and near-duplicates trail the list. A query token a hit
  carries verbatim — a name, a number, a time — earns a small bounded bonus,
  since embeddings are weakest exactly where `search_messages` is strongest.
  Raw `similarity` and the similarity floor are untouched; only `score`
  carries the bonus, capped so it reorders neighbours and never rescues
  noise.

### Fixed

- **One unembeddable message no longer stalls the index.** A text over the
  model's context window gets a deterministic 400 from llama-server, which
  the queue used to retry until it declared the whole backend dead — and
  every restart re-fed the same poison. A 4xx now surfaces as
  `RECALL_BAD_INPUT`; the queue bisects the batch, drops the offending
  message, and keeps going.
- **e5 is honestly calibrated instead of a guess.** Measured on a real 12k
  index, e5's noise and real hits overlap (~0.84 vs 0.82-0.88), so its floor
  moves to 0.85 — erring toward silence — and `wazap status` no longer
  flags it uncalibrated. A per-model `maxChars` (e5's window is 512 tokens)
  keeps over-context messages out of the server entirely. Gemma stays the
  recommended model.

### Changed

- **Faster boots.** OAuth, express, QR and bridge modules load lazily —
  spawn to ready is ~14% faster on a warm machine, and bridge-mode children
  skip the HTTP stack entirely.

## 0.18.3
### Added

- **One llama-server for every account.** Recall used to spawn an embedding
  sidecar per account — ~330 MB of model and runtime RAM each. The
  /embedding API is stateless, so accounts on the same binary and model now
  share a single server through a refcounted registry; the last account to
  stop is the one that kills it. Concurrent boot backfills join the same
  spawn, never two.
- **`scripts/recall-eval.mjs`: a fixed case set scored against the live
  daemon.** Each case pairs a query with an expected hit or `expectNone`;
  the run reports rank, raw similarity and the floor band between worst
  expected hit and best noise hit, exiting non-zero on any failure — so a
  prompt, model or floor change gets measured instead of eyeballed.

### Fixed

- **The similarity floor is per-model now.** It travels with the model spec:
  embeddinggemma-300m keeps its measured 0.35, e5-base-multilingual gets a
  conservative 0.7 flagged `uncalibrated` in `wazap status` — e5's prompted
  cosines sit in a higher band and silently inheriting gemma's floor would
  pass noise as answers. `WAZAP_RECALL_MIN_SIMILARITY` still overrides both.
- **The daemon stdin-shutdown test no longer flakes under load.** A spawned
  child pays Node boot plus the whole module graph before it can write
  daemon.json — under a second idle, several seconds when the suite runs
  children in parallel. Startup/shutdown budgets widened to 30s/10s, and a
  timeout now carries the child's last stderr lines instead of an opaque
  wait.

## 0.18.2
### Fixed

- **Recall embeds with the model's own task prompts.** llama-server was fed
  raw text while embeddinggemma was trained on asymmetric retrieval prompts
  (`task: search result | query:` for the query, `title: none | text:` for
  documents). A/B on a real index: noise drops from 0.45-0.54 cosine to
  under 0.31, nonsense queries return nothing, and true paraphrases surface
  again — so `WAZAP_RECALL_MIN_SIMILARITY` is recalibrated to 0.35. e5 gets
  its documented `query:`/`passage:` prefixes too. Existing indexes are
  wiped and rebuilt on first boot: mixed embedding spaces would rank
  garbage.

## 0.18.1
### Fixed

- **Recall no longer ranks noise as answers.** On the live index, unrelated
  queries matched ultra-short texts ("Da", "Ceau") at 0.45-0.54 cosine while
  real matches start around 0.5, so a nonsense query returned confident
  junk. Hits must now clear `WAZAP_RECALL_MIN_SIMILARITY` (default 0.5,
  calibrated on embeddinggemma-300m; another model needs its own value),
  texts under five letters or digits never enter the index, and results
  surviving but staying weak are flagged in the output instead of being
  listed like found facts.

## 0.18.0
### Added

- **Local semantic recall ("living memory").** A new read tool, `recall`,
  searches the whole indexed WhatsApp history by meaning rather than exact
  words — a paraphrase or another language still hits, and it keeps finding
  messages too old for `search_messages` to see. Off by default: turn it on
  with `wazap config recall local`, install llama.cpp
  (`brew install llama.cpp`) and fetch the model with `wazap embed download`.
  Embedding runs on-device — a `llama-server` sidecar bound to loopback — and
  the index lives per account under `accounts/<id>/recall/` with history's
  permissions (0700/0600). Hits rank by similarity scaled by recency and each
  carries its date; one that fell out of the live store is marked "index
  only" and answers from the index's own copy. `chat_id`, `since`, `until`
  and `from` narrow a search the way they narrow `search_messages`. Recall
  requires `persistHistory` — the index never outlives its source — and
  deletes, edits, revokes and expired stories leave it. `get_status` reports
  the index as `off`, `indexing`, `ready` or `degraded`; `wazap doctor`
  checks the binary and the model file. Knobs: `WAZAP_RECALL`,
  `WAZAP_EMBED_MODEL` (`embeddinggemma-300m` default, `e5-base-multilingual`
  fallback for older llama.cpp), `WAZAP_EMBED_BIN`, `WAZAP_RECALL_MAX`.

## 0.17.0
### Added

- **The new webhook events are opt-in.** `WAZAP_WEBHOOK_EVENTS` names what
  gets posted, comma-separated, and unset means `message_received` only, so
  an existing endpoint sees nothing new unless it asks for it. Say `all` for
  every event. An account overrides the list with `webhook_events` in
  `accounts.json`, beside `webhook_url` and `webhook_secret`, and
  `config webhook off --account <id>` clears all three. An unknown name
  fails `wazap status`, doctor and setup.

- **The webhook posts messages you send, too.** A message typed on the phone
  or on another linked device arrives as `event: "message_sent"`. A message
  wazap sent through its own tools is not announced, so a consumer cannot be
  made to answer itself. History sync is still not posted.

- **Connection changes are an event.** `event: "connection"` carries a
  `status` of `linked`, `disconnected` or `expired`. `not_linked`, `linking`
  and `connecting` post nothing, and two changes that mean the same status
  post once.

- **Five payload fields.** `timestamp` is the same instant as `ts` in ISO
  8601 UTC, `truncated` says whether `text` was cut, `kind` is `text`,
  `audio`, `image` or `other`, and `from_me` and `is_self_chat` say who sent
  it and where. Existing consumers keep every field they had, `ts` included,
  with the meaning it had.

- **`wazap webhook test --event <name>`** posts `message_received` (the
  default), `message_sent` or `connection`. An unknown name exits 1. An event
  you have not enabled posts nothing and exits non-zero.

### Changed

- **An existing webhook endpoint receives exactly what it received before.**
  `message_sent` and `connection` stay off until `WAZAP_WEBHOOK_EVENTS` asks
  for them. Once you do ask, branch on `event`. `message_sent` is a message
  this account sent, not one to reply to, and `connection` carries no `from`,
  `text` or `message_id`.

- **The webhook text preview is cut at 2000 characters, not 500.** A cut
  preview ends in a single `…`, and `truncated` is true.

- **A voice note's webhook waits for its transcript.** The event of an
  auto-transcribed voice note carries the words in `text` instead of the
  `[voice message · 0:42]` placeholder.

## 0.16.0
### Added

- **`wazap account default <id>`** picks the account tools use when a call
  does not say otherwise. `config webhook on|off --account <id>` sets or
  clears that account's webhook URL/secret in `accounts.json` (the on/off
  switch stays global in `.env`). `account list` and `list_accounts` show the
  persisted `owner`, masked, for accounts with no live socket.

### Fixed

- **Account changes while a server runs now say so.** `account
  add|enable|disable|default` warn that the running server needs a restart,
  and a tool given an `account_id` that exists on disk but not in the
  server's snapshot answers ACCOUNT_NOT_FOUND with "restart the server"
  instead of "run `wazap account add`".
- **`wazap logout` yields the session the way `login` does.** When the
  background service holds the lock, logout stops it, unlinks, and starts it
  again instead of refusing with a `kill` that the supervisor would respawn.
  `account remove` refuses with `wazap service stop` in the same case.
- **The layout migration refuses while a process holds the session.** A
  `status` against a flat `~/.wazap` used to move `auth/` out from under a
  running pre-0.15 server. Now it says to stop the holder first;
  `migrate rollback` refuses the same way, and commands that never open
  account state (`service`, `connect`, `skills`, `expose`, `update`,
  `transcribe`) skip the migration so `wazap service stop` can free the lock.
- **`status --json` `linked` is true when any account is linked**, not only
  the selected one; `accounts[]` still carries each account's own state, and
  the credentials check names the linked ids. A linked `work` no longer
  sends a setup flow back through pairing because `default` is unlinked.
- **`config writes on --account x` warns when global read-only still wins.**
  The account flag is stored, but the message no longer claims writes are on.
- **`wazap status` tells a newer service from an older one.** A service
  ahead of the installed wazap gets `wazap update`, not a restart that keeps
  the same build.
- **`link_account` persists `owner`** on the account's record once the
  pairing settles, so `list_accounts` and `account list` can name it later.

## 0.15.0
### Added

- **Several WhatsApp accounts in one process.** `accounts.json` names each
  account; auth, store, history, media, previews and notes live under
  `accounts/<id>/`. A flat `~/.wazap` moves into `accounts/default/` on the
  first command (`wazap migrate rollback` undoes it). `wazap account
  add|remove|list|enable|disable` manages slots. `--account` picks one on
  `login`, `logout`, `status`, `config writes` and `webhook test`. One
  `wazap serve` starts a socket per enabled account. MCP tools take optional
  `account_id`; `list_accounts` lists them. A chat only one account knows
  selects that account. A send to a chat no account knows, with two or more
  accounts, fails `AMBIGUOUS_ACCOUNT`. `get_status` keeps today's top-level
  fields and adds `accounts[]`.

- **Webhook payload names the account.** Each `message_received` body includes
  `account_id` and `account_name`. An account may set `webhook_url` and
  `webhook_secret` in `accounts.json`; those win over the global `.env`
  values. `wazap webhook test --account x` posts with that account's override
  and id.

## 0.14.0
### Added

- **`set_profile_picture`.** Write tool that updates the linked account's own
  profile photo via Baileys `updateProfilePicture`. Exactly one of `file_path`
  or `url` (same loader as `send_media`). JPEG, PNG or WebP, at most 10 MB.
  Hidden when writes are off. No draft, no remove, no group avatars. Show the
  image and wait for a yes first; the call hits WhatsApp immediately.

- **Outbound webhook (`message_received`).** `wazap config webhook on|off`
  sets one URL and an HMAC secret. Each live inbound message POSTs a small
  JSON body (`event`, `from`, `chat_id`, `ts`, `text`, `message_id`). On
  without a URL or secret fails `status` / doctor / setup. A failed delivery
  retries twice, then sets `webhook.last_error` and leaves the WhatsApp and
  MCP paths up. `wazap webhook test` sends a probe. History sync is not
  posted. Stubs and system notices are not posted. Signature: see README.

- **Grok Bot / remote MCP.** README and `wazap setup` now have the four-step
  HTTP path: `wazap login` on the host until the CLI says linked, answer
  writes at login, `serve --http` with `WAZAP_READ_TOKEN` (set
  `WAZAP_WRITE_TOKEN` only if this client should send), then connect that
  URL on Grok Bot and call `learn`, `get_status`, read. Missing write tools
  on HTTP need writes on and a write Bearer on the session; config alone is
  not enough. `connected` is the socket; `write_tools` (or send tools in
  the list) is whether this session can send. Setup asks "remote client?"
  and prints the URL template; it does not start `expose`.

### Fixed

- **`.env` writes quote values dotenv would otherwise cut.** A secret with
  `#` (or spaces, quotes) is written quoted so it round-trips through
  dotenv. Unquoted `p@ss#word` used to load as `p@ss`.
- **Outbound webhook skips stubs and system notices.** Only a person sending
  something fires `message_received`. Group-join stubs and protocol
  machinery stay in the store, they are not POSTed.
- **`wazap config` and `readOnlySetting` agree.** Unset `WAZAP_READ_ONLY`
  means writes are on, which is what config already printed as
  "writes: on (default)". One function now decides that, so the two cannot
  drift. When writes are off, `status` / doctor / setup say the write tools
  are missing and to run `wazap config writes on` then restart. On HTTP or
  a public URL they also say a Bearer write token is not writes being
  enabled, and that a read token never registers write tools.
- **`get_status` last message after a restart.** `last_message_received_at`
  no longer stays `never` when the store or history already has inbound
  messages; it reports the latest of those until a live message arrives.

## 0.13.0
### Added

- **`wait_for_messages`.** Blocks up to 55 s until a message from someone else
  arrives, then returns it with a `cursor`; the next call with that cursor
  replays what landed in between. `addressed_to_me` wakes only for direct
  messages, @-mentions and replies to the user. An agent can stay on the line
  instead of polling every few minutes and reporting nothing.
- **`include_previews` on `get_recent_messages` and `read_messages`.** A
  small JPEG of each photo comes back as an image block, newest first, up to
  12 per call, with the message line labelled. WhatsApp almost never ships a
  preview inside the message any more, so the photo is downloaded once and
  shrunk to 320 px here with jpeg-js (pure JavaScript, no native build), and
  the result is kept on disk, one file per message under `previews/`, across
  restarts. A video gets one frame, taken by ffmpeg a second in. A catch-up
  can tell a receipt from a baby without asking for a download.
- **`get_stories`.** The status updates received in the last day, by author,
  newest first, with `include_previews` for the photos. WhatsApp keeps a story
  for a day and so does wazap; they never appear in chats, catch-ups or waits.
- **`set_contact_note` and `mark_handled`.** Two tools that change wazap's
  own notes on this machine and nothing on WhatsApp, so they are there in
  read-only mode too. A note on a person ("Hermi, my own agent") shows next
  to their name in every list; "handled" takes a chat off `get_unanswered`
  until the other side writes again. Kept in `notes.json`. In a chat or a
  group the note introduces the sender once, then the name stands alone.
- **`search_messages` takes `since`, `until` and `from`**, so "what did Sorin
  say about RCA last week" is one call.
- **`compact` on `get_recent_messages`.** Media without a caption and
  messages without a word in them are left out and counted, a run of
  messages from one person folds into one line. About half the size.
- **`get_unanswered`.** Chats whose last word is the other side's and reads as
  an ask (a question mark, a request word, an unheard voice note), people
  first, oldest wait first, with the ask quoted. A link is not a question, an
  ask older than two weeks is abandoned rather than waiting, a business
  account is marked. Groups count only when the user was @-mentioned or
  replied to. The inbox skill uses it instead of guessing from `list_chats`.

- **`as_gif` on `send_media`.** An mp4 goes out looping, the way WhatsApp
  plays a GIF; a .gif file is turned into that mp4 first with ffmpeg on the
  machine running wazap. The draft preview says `[gif]`.

- **A catch-up names the senders in a busy group.** `get_recent_messages`
  fetches the metadata of the groups that spoke in the window, once each, so
  someone the address book does not know reads by the name the group carries
  instead of "unknown (lid …)".
- **A message filed under a lid keeps its sender after a restart.** The
  pairings WhatsApp's own lid table taught are written to the snapshot, and
  in a one-to-one chat the other side is the sender whatever id the key
  carries, so "unknown (lid …)" is gone from direct chats.
- **A photo or video sent inside an album, or in reply to a story, is a photo
  or video again** (`associatedChildMessage` is an envelope, now unwrapped like
  the others), and an encrypted edit notice reads as `[edited a message]`, a
  notice, instead of `[unsupported: …]`.
- **Animated stickers read as `[sticker]`, an album header as `[album · 4
  items]`** and is a notice, hidden from the catch-up like the other notices,
  since the photos follow as messages of their own.

### Changed

- `whatsapp.ts` gave up its store (`store.ts`) and the outgoing media helpers
  (`outgoing-media.ts`), 2.9k lines down to 2.5k. No behaviour changed.

### Fixed

- **Reactions vanished on restart and showed up as messages of their own.** A
  reaction now goes onto the message it answers the moment it arrives, live,
  from a history sync or back from disk, is written to the snapshot, and never
  appears as a "[reaction] 👍" line. A withdrawn reaction comes off. An older
  snapshot's loose reaction lines fold onto their targets on load.
- **A GIF reads as `[gif]`**, not `[video]`.
- **`search_contacts` listed a person twice**, once by number and once by lid.
  The lid entry now moves in with the phone entry as soon as the pairing is
  known, and the search never returns the same person under two ids.
- **A name learned earlier survived a later contact update that knew less.**
  Baileys sends a contact with unknown fields set to undefined; spread as they
  were, they erased the name. And a number is now named from what arrived
  under its lid, and the lid from what arrived under the number.
- **`wazap service restart` now records the version it started**, so `status` stops saying an older one runs.
- **`list_chats` showed some people twice.** WhatsApp files a contact under a
  `@lid` chat and a phone chat, and once the pairing is known both rows
  canonicalised to the same `chat_id`. The list now merges the aliases: the
  newer row keeps its flags, the unread count is the larger of the two.
- **`get_contact` on a number WhatsApp does not know hung for 60 s.** The
  about-text and profile-picture lookups never answered. They now give up
  after 8 s and the contact comes back from the store with both set to null.
- **`search_contacts` matches a number typed with the national leading zero**
  (`0734 404…` finds `40734404…`).
- **`get_recent_messages` listed the same conversation twice after a restart.**
  The history file was read before the snapshot that knows which number a
  lid belongs to, so a message that arrived under a lid was filed under the
  lid and under the phone. The snapshot now loads first, a ring left under a
  lid folds into the phone chat, and a pairing learned later folds the chat
  the moment it arrives, from a contact or from WhatsApp's own lid table.
- **A message from the other side showed as sent by you.** Baileys puts an
  empty `participant` on a direct message that arrives under a lid, and the
  empty string was taken as "absent", which handed the message to the
  linked account.

## 0.12.0
### Added

- **Outbound sends are a draft, then `confirm_send`.** `send_message`,
  `send_media`, `send_poll`, `send_location` and `forward_message` ask the
  session to resolve the recipient and return a `draft_id` plus a preview
  (`To: Ana (+40 722 …)` and the exact text). WhatsApp is reached only by
  `confirm_send`. A draft lasts 15 minutes, is one-shot, and lives on the
  session that owns the socket. Drafting does not spend the write rate
  limit; that bucket is taken when the session actually writes.
  `DRAFT_NOT_FOUND` and `DRAFT_EXPIRED` tell the agent to draft again.

### Fixed

- **`login` and `setup` print a leftover on the real screen.** A client-held
  lock used to fail inside the wizard alt buffer, so `close()` wiped
  `kill <pid>` and left `EXIT:1` on an empty terminal. They now refuse
  before the wizard opens, and `yieldSession` throws instead of
  `process.exit` so a later failure still lands on the main screen.
- **Unlinked `status` / greet no longer send you past setup.** Service,
  skills and transcribe still show as facts. The `→ run …` lines stay
  off until an account is linked, because setup is the next command.
- **The QR screen no longer tells you to start setup over, and no longer
  draws two countdowns.** After you already picked QR, the `--phone` hint
  is gone. The saved-path line is omitted when it would wrap. A QR taller
  than the terminal keeps the last rows, so the spinner is not painted
  twice.

- **A leftover server no longer hides the next step.** Bare `wazap` on an
  unlinked data dir used to stop at "a server is already running" and
  `login` told you to quit the client that launched it, without a command.
  Greet now still says `Next wazap setup` and names `kill <pid>`. A second
  `wazap` that finds a `not_linked` owner answering `/healthz` 503 becomes a
  bridge instead of claiming the first process is an older version.
- **A command with no arguments names its own usage.** `wazap connect`,
  `skills`, `service`, `transcribe`, `contacts` and a half-typed `config`
  used to dump you into `--help`. They now list the clients, verbs or
  settings they accept. An unknown command still points at `--help`.
- **Setup asks QR or pairing code before it draws a QR.** Ctrl+C then
  `wazap login --phone` abandoned the rest of setup. `--phone` / `--code`
  and `--yes` skip the question. The QR hint, if you still get one, is
  `wazap setup --phone` from setup and `wazap login --phone` from login.

- **`setup` through npx can still install the service** when a global `wazap`
  already exists. npx puts its cache first on PATH, so after `npm i -g` (or a
  previous global install) the running process still looked like the throwaway
  copy and `service install` refused. Setup now asks `npm prefix -g` for the
  bin, and prints the repair instead of crashing if nothing stable is there.
  The unit's script is the realpath of that global bin, not `import.meta.url`
  of the npx process, which would have pointed launchd at a cache npm clears.

### Changed

- **`setup` and `login` are one screen at a time at a terminal.** Each step is
  a black, centered frame: the ASCII logo ghosted at the top, the step number,
  the title, then the QR or the question. Waiting states (QR, pairing
  countdown, chat sync, model download) run an 80ms spinner on one line
  instead of a once-a-second redraw. Titles, hints and menus type on from the
  left, like a keyboard; the QR and the ASCII logo appear at once. Piped
  output, tests and `setup --agent` stay a log, so agents still parse
  `Step N of M`.

## 0.11.0
### Added

- **`setup` installs the binaries it needs, and restarts Claude Desktop for
  you.** Local transcription used to stop at "run `wazap transcribe download`
  once whisper-cpp and ffmpeg are installed" and `expose` at "tailscale is not
  installed". Both now offer one `brew install` for the whole missing set and
  carry on in the same run; Tailscale still needs `tailscale up`, which setup
  prints as the next step rather than running. The keep-running menu offers a
  public URL when Homebrew could install a tunnel, not only when one is already
  there. Connecting Claude Desktop offers to quit and reopen it, so the last
  manual step of a macOS setup is gone. `--yes` accepts the install and
  `--no-brew` declines it; the restart takes a person at the prompt or
  `--relaunch`, because an agent running setup from inside Claude Desktop
  would otherwise quit itself.
- **`link_account` pairs WhatsApp from inside the chat**, so linking no longer
  needs a terminal. The server is already running and idle when nothing is
  linked, so it pairs itself: the tool takes a phone number, returns an
  8-character code and the steps to type it into the phone, and `get_status`
  reports `linking` with that code until WhatsApp accepts it. It stays
  registered in read-only mode, because read-only is there to stop the agent
  messaging people, and relinking a dead session messages nobody. `ALREADY_LINKED`
  is the new error for calling it on a live session. The pairing socket and the
  CLI's `login --phone` now run the same code, in `src/pairing.ts`.
- **`wazap update` is the whole upgrade.** It reads the registry, then does what
  this install needs: `npm i -g wazap-mcp@<latest>` when wazap is global, a
  restart of the background service so it runs the new code, and a fresh copy of
  the skills for every harness that keeps them, taken from the package it just
  installed rather than from the running one. A checkout is told to pull and
  build; an npx run is told to rerun `setup` through the new version.
  `--dry-run` prints the numbered plan and stops there. `status` now sends you
  here instead of to `npx wazap-mcp@latest`.
- **`wazap setup` installs wazap globally when npx is how it started.** The npx
  cache is a copy npm clears, so Claude Desktop could not launch what setup had
  just connected, and `service install` refused outright. Setup now asks once,
  before it connects anything, and `npm i -g wazap-mcp@<this version>` gives the
  rest of the run a path that lasts. `--yes` accepts, `--no-global` declines and
  setup carries on. `status` reports where this wazap lives, as
  `install: global|checkout|npx` with the script behind it.
- **`wazap service` keeps the session up without a client.**
  `wazap service install|status|start|stop|restart|logs|uninstall` writes a
  launchd agent or a systemd user unit, starts it and waits for `/healthz`.
  The unit runs
  `serve --http` on loopback with the absolute path of this Node and this
  install, so it survives a reboot and a logout, and `status` says when it still
  runs an older build than the one installed. `wazap login` needs the session to
  itself, so it now stops the service, pairs, and starts it again. `wazap status`
  gained a service check. A wazap running out of the npx cache refuses to install
  one, because npm clears that path.
- **`wazap expose` gives the service a public URL** for agents that are not on
  this machine. It uses Tailscale Funnel or Cloudflare Tunnel, whichever is
  installed, writes `WAZAP_PUBLIC_URL` and a fresh `WAZAP_OAUTH_PASSWORD`,
  restarts the service and checks the URL from here, then prints the MCP URL and
  the consent password once. `wazap expose off` takes the tunnel down and keeps
  the password.
- **`wazap setup` asks whether to keep wazap running**, as a fifth step: only
  while a client has it open, always on this machine, or always and reachable by
  cloud agents. `--service` and `--expose` answer it for `setup --yes`.
- **The workflows reach every client, with no second command.** `wazap setup`
  now copies the five skills into each client it connects, and the server
  carries them as well: it sends a short `instructions` block naming all five
  and registers each one as an MCP prompt of the same name. Claude Desktop, VS
  Code, Gemini and Windsurf keep no skills directory, so this is how they get
  the workflows. A bridged client sees the same prompts as the session holder,
  and the Claude Desktop bundle now ships `skills/` so it can serve them.
- **`wazap skills install` with no harness** installs into every client it finds
  on this machine.
- **`wazap setup` proves the install works before it says so.** The Finish step
  now connects the session once and reports the chat count, and checks that each
  client it connected can actually launch wazap. Claude Desktop starts its MCP
  servers with launchd's PATH, where neither `wazap` nor `npx` is found, so
  `connect claude-desktop` now writes the absolute `node` path and the script
  behind the global bin. A failing check exits 1 instead of printing "Setup
  complete".
- **`wazap status` reports the skills**, per detected harness, as installed,
  stale or missing. A global upgrade leaves the copies in `~/.cursor/skills` and
  the others behind, and until now nothing said so. Bare `wazap` and
  `status --json` carry the check too.

### Changed

- **`serve` exits 3 when WhatsApp keeps refusing the socket.** Ten failed
  reconnects used to leave a live MCP server answering NOT_CONNECTED forever.
  Now it logs and exits, so a supervisor restarts it and a client shows the
  error. An account unlinked from the phone is the exception and stays up in
  `auth_failure`: no restart brings that back.
- **`/healthz` answers 503 on a real outage**, with `{ ok, status, since }`. A
  socket that has been anything but connected for two minutes is down; a
  reconnect in progress is not.
- `wazap skills install claude-code` copies into `~/.claude/skills/` instead of
  printing the plugin command. The plugin is still the other route, and the
  README says so.

## 0.10.0
### Added

- **OAuth for hosted agents.** claude.ai Connectors, ChatGPT and Poke's OAuth
  mode would not take a static bearer token, so a self-hosted wazap was out of
  their reach. `WAZAP_PUBLIC_URL` plus `WAZAP_OAUTH_PASSWORD` now make wazap
  its own OAuth 2.1 server: discovery at `/.well-known`, dynamic client
  registration, S256 PKCE, `/token` with refresh, `/revoke`. An agent gets the
  `/mcp` URL and nothing else; the person lands on a consent page on their own
  host, types the password, and picks read or read-and-send for that agent.
  Grants live hashed in `<data-dir>/oauth.json`; deleting it signs everyone
  out. The bearer tokens still work next to it.
- **`wazap status` lists OAuth grants**, by agent name and scope.

### Changed

- A 401 from `/mcp` now carries `WWW-Authenticate` with the resource metadata
  URL when OAuth is on, which is how a client learns to start the flow.
- HTTP request logs show the full path again for routes mounted under a router.

## 0.9.8
### Added

- **Voice messages become text.** A voice note is the one message an agent could
  not read. With transcription on it reads as
  `[voice message · 0:42] "sunt la notar, ajung în 20 de minute"`, carries the
  bare words in a `transcript` field, and is findable by them:
  `search_messages` matches the rendered text, so a recording is searchable by
  what was said in it. A note nobody has transcribed still says how long it runs.
- **Two providers, both opt-in.** `wazap config transcribe local` runs
  whisper.cpp on this machine, free, and the audio never leaves. `wazap config
  transcribe openai` posts to any OpenAI-compatible `/audio/transcriptions`,
  which is fast and costs money and sends the audio away; Groq works unchanged.
  `wazap setup` asks the question between Link and Connect, defaulting to
  neither.
- **`transcribe_audio(message_id, language?)`.** One recording on demand, capped
  at ten calls a minute so a loop cannot run up a bill. The transcript is cached
  by message id and persisted in the snapshot and the chat's own JSONL, so a
  recording reaches a provider once and survives a restart, and two callers
  wanting the same one join a single upload instead of paying twice.
- **Transcribed as they arrive.** With a provider configured, incoming voice
  notes are transcribed in the background, one at a time, never holding up
  ingestion. "As they arrive" is meant strictly: a history sync replays a
  backlog and transcribing all of it is a bill nobody asked for, so the hook
  hangs off live delivery only. Notes the user recorded, audio files, anything
  past ten minutes and anything WhatsApp stated no length for are left for the
  tool to do deliberately. `WAZAP_TRANSCRIBE_AUTO=0` keeps the tool and stops
  the background work.
- **`wazap transcribe download` and `wazap transcribe test <file>`.** The model
  is fetched into `<data-dir>/models/` behind one progress line, resumes from
  its `.part` if you interrupt it, and is renamed into place only once its
  SHA-256 matches the digest pinned in the source. `transcribe test` runs the
  configured provider on a recording of your own, which is how you check a
  language before trusting it with your WhatsApp. `status` reports the provider,
  the binaries, the model and its size.
- **`turbo` is the default model** (`ggml-large-v3-turbo-q5_0.bin`, 574 MB),
  because it is the smallest one that still gets Romanian right. `medium` and
  below drop diacritics and mangle names, which is worse than no transcript at
  all: a missing transcript is a question, a wrong name is a wrong answer.
  `WAZAP_WHISPER_MODEL` picks `large-v3` or `medium` instead.
- **`whatsapp-inbox` and `whatsapp-recall` read voice notes.** A transcribed
  note is triaged and quoted as the text it is. Notes nobody transcribed are
  counted in one closing line, once, rather than an offer repeated per item.

### Security

- **The API key is never a command-line argument**, and typing it as one is
  refused with the reason: an argument is kept in your shell history and
  readable in `ps` by anyone on the machine. It is asked for at a prompt that
  echoes nothing, not even asterisks, and stored only in `<data-dir>/.env` at
  mode 0600. `status`, `status --json`, `config`, `get_status` and any error a
  provider hands back show at most `api key: set (…abcd)`.
- **Read-only keeps its meaning.** It has always promised no side effect anyone
  outside this machine can see, so it refuses the API provider, which uploads
  the user's audio and spends their money, and leaves whisper.cpp alone, which
  does neither.
- **A plain-`http` `WAZAP_TRANSCRIBE_URL` is refused** unless it points back at
  this machine.

## 0.9.7
### Added

- **A call is a message.** A WhatsApp call now has `type: "call"` and a `call`
  field carrying kind, direction, outcome and, when someone picked up, the
  duration. It reads as `[voice call · 6 min]` or `[missed voice call]` where it
  used to read "[system message]" or "[unsupported]". Three shapes say the same
  thing and collapse into one: WhatsApp's own call log, the four CALL_MISSED_*
  notices, and the placeholder baileys writes for a group call offer.
  `getContentType` is blind to the proto field — WhatsApp spells it
  `callLogMesssage`, with three s's — so the check runs ahead of the table that
  types every other message.
- **Calls that happen while wazap runs.** Baileys reports a call as a stream of
  status events and never as a message, so wazap folds that stream into one
  entry per call and stores it the way any message is stored: snapshot, history
  file, digest, `list_chats.last_message`. A call whose closing event never
  arrives is settled two minutes after the last one; an answered call is not,
  because that would record a conversation still going on as two minutes long.
  The same call reaching the store from two directions is reconciled to
  whichever account of it says more.
- **`types` on `read_messages` and `get_recent_messages`.** Narrow a read to a
  subset of message types; `types: ["call"]` is the call log of a chat and
  nothing else. `limit` counts messages that matched, and paging with `before`
  is unaffected by the filter.
- **Triage reads calls as answers.** A question the user answered by calling
  back is no longer reported as unanswered: `whatsapp-inbox` moves it to
  *Probably handled by call* with the time and duration, and asks at the end
  about calls placed outside WhatsApp, which nothing on a linked device can see.
  `whatsapp-groups` treats an answered group call the same way.

## 0.9.6
### Added

- **MCP Registry.** `server.json` and `mcpName` in package.json, the two proofs
  the registry wants: the GitHub login for the `io.github.razvangirgiz/*`
  namespace, `mcpName` on the published npm version for the package.
  `scripts/release-registry.sh` publishes it, and refuses early when the
  versions disagree or npm's copy of this version has no `mcpName` — which
  cannot be added afterwards. `npm run registry:validate` checks the file
  against the schema it names.
- **A Claude Desktop bundle.** `npm run bundle:mcpb` produces
  `wazap-<version>.mcpb`: the server, a 512×512 icon and production
  `node_modules`, installed by double-clicking, with no npx and no config file
  to edit. Two settings in Claude Desktop's own UI, Read-only and Data
  directory. Read-only ships ticked, because a bundle that can message people
  from your number before you have said so is the wrong default.
- **A Gemini CLI extension.** `gemini extensions install
  https://github.com/razvangirgiz/wazap` registers the server and loads
  `GEMINI.md`, which is the five skills concatenated. It is generated by
  `npm run context:build`, and a test fails when it drifts from `skills/`, so a
  workflow is still only ever edited in its skill.
- **One-click install for Cursor and VS Code.** Two badges under *Other MCP
  clients*, both carrying the entry `connect` would write.
  `node scripts/badges.mjs` reprints them.
- **`wazap skills install <harness>`.** Copies the five skills into the
  directory that harness reads: `~/.agents/skills` for Codex, `~/.cursor/skills`
  for Cursor, `~/.config/opencode/skills` for OpenCode, `./.agents/skills` for
  the project. Re-running overwrites, so an upgrade is the same command.
  `--dry-run` lists without writing. Claude Code is pointed at the plugin.
- **`wazap connect windsurf` and `wazap connect opencode`.** Windsurf takes
  `~/.codeium/windsurf/mcp_config.json`; OpenCode wants the command and its
  arguments as one array under `mcp.whatsapp`, and its schema refuses anything
  else, so `connect` now writes the whole object each client asks for rather
  than merging fields into a fixed one.

### Fixed

- An unanswered setting in the Claude Desktop bundle arrives as the literal
  `${user_config.data_dir}` rather than as nothing. Any `WAZAP_` variable that
  is still a template is dropped, so an empty picker means `~/.wazap` instead of
  a directory named after the question.

## 0.9.5
### Fixed

- Contact names never arrived. WhatsApp hands a companion the phone's address
  book inside the app state sync, and it sends each collection's snapshot only
  to a connection asking from version zero. The socket that pairs has no store,
  so whatever it synced was thrown away — and by saving the versions it left
  every later connection resyncing from a point with nothing more to send.
  Contacts stayed bare phone numbers for the life of the session. That socket
  now runs on an auth state whose app-state-sync journal reads empty and refuses
  writes, and declines the history sync outright, so it can neither consume the
  delivery nor bump the counter that makes later connections skip their own sync.
- Sessions already linked heal themselves. A connection that settles with no
  address-book name in hand, while stored versions prove one was delivered
  somewhere, forgets those versions and resyncs all five collections. Once per
  process, and at most once a week per account, so a phone with genuinely no
  saved contacts is not asked again on every start. On the account this was
  found on: 0 named contacts before, 217 within three seconds.
- A name made only of digits and masking is no longer treated as a name.
  WhatsApp fills a contact it will not identify with the masked number
  `+40∙∙∙∙∙∙∙98`; `search_contacts`, `is_my_contact` and every sender line were
  taking that at face value and showing dots where the plain number belongs.

### Added

- `sync_contacts` — a read tool that asks WhatsApp for the address book and
  waits up to 15 seconds, returning `named_before` and `named_after`.
- `wazap contacts resync` — the same from a terminal. It refuses while a server
  owns the session and points at the tool instead.
- `get_status` reports `contacts_named`: contacts carrying a name from the phone,
  which is `0` exactly when the address book has not arrived.

### Changed

- "Synced N chats, N contacts, N messages" counts contacts from the address book
  rather than everyone the store has ever seen, which included every stranger in
  a group and every group itself. Login waits for those names before it calls the
  sync finished.

## 0.9.4
### Fixed

- Senders in a group rendered as a bare LID — fifteen digits that read as a
  phone number and are not one. One `displayName` ladder now names every sender,
  chat, contact and group participant: the saved contact, the business name, the
  name the sender publishes on their own profile, the chat title, the phone
  number, and only then `unknown (lid …7515)`. A LID is resolved to its number
  first, from the contact list, from group metadata, and from the table Baileys
  already holds and wazap never asked. Naming someone never renames their chat,
  so a chat id and the message ids under it stay what they were.
- The name a sender publishes arrives on their messages and nowhere else, and
  was being thrown away. It is kept per sender and persisted, so someone who is
  not in the address book still has a name after a restart, and
  `search_contacts` finds them by it.
- `0@s.whatsapp.net`, the pseudo-chat WhatsApp files its own notices under, sat
  at the top of `list_chats` and in the digest. It and the status feed are now
  refused at ingest, on load of a store an older version wrote, and where chats
  are listed.
- Linking a device left history-sync and peer-data payloads in the user's
  self-chat, shown as four `[system message]` rows and counted as conversation
  in the 24h digest. Payloads devices exchange with each other are dropped;
  everything a person did — a retraction, a disappearing-messages toggle, a
  group membership change — stays.
- An edited message no longer also appears as a `[system message]` row of its
  own. The edit is applied to the message it edits, as before.

### Changed

- `get_recent_messages` leaves WhatsApp's own notices out of its bodies and its
  counts, and takes `include_system: true` to put them back.
- An unsupported payload names itself, `[unsupported: <key>]` rather than
  `[unsupported message]`, so a bug report says which one to add. A payload
  wazap does not model yet is reported this way instead of being flattened into
  `[system message]`, which used to hide events, albums and orders.


## 0.9.3
### Added

- One session, many clients. The first `wazap serve` on a data directory owns
  the WhatsApp session and shares it over a loopback MCP endpoint; every later
  `wazap` on the same directory becomes a bridge onto it instead of exiting 2.
  Claude Desktop, Claude Code and Cursor can run at the same time, with nothing
  to configure. `WAZAP_NO_SHARE=1` keeps the old one-at-a-time behaviour, and so
  does an explicit `--http`.
- `<data-dir>/daemon.json` (`0600`), the record a bridge reads to find the owner:
  its pid, its loopback port, a per-run token and the version. It goes when the
  lock goes.

### Changed

- `wazap status` names the endpoint a shared session is reachable on, as
  `server: running (pid N, sharing on 127.0.0.1:PORT)`, and `--json` carries the
  same as a `daemon` object with the pid and the port. The token stays out of
  both, and out of every log line.


## 0.9.2
### Added

- `wazap setup`: the one command from nothing to a working agent. It links the
  account, detects which MCP clients are installed on this machine over the same
  client table `connect` writes from, writes their entries and prints what to
  restart. `--client <name>` overrides the detection; `-y` takes the detected
  set without asking.
- `wazap setup --agent` prints the procedure an AI agent follows to set wazap up
  for its user. That text is `AGENT.md`, and the command reads the file, so the
  document and the command cannot drift.
- `login` prints a `pairing code: XXXX-XXXX` line whenever its output is not a
  terminal, so an agent running `login` in the background can read the code and
  hand it to the user.

### Changed

- `login` and `setup` hold the session lock while they link. A server started
  meanwhile is refused instead of racing them for the credentials, and a killed
  `login` leaves no stale lock behind.
- `logout` says WhatsApp had already unlinked this device, instead of surfacing
  the pairing-code error that WhatsApp's 401 means at login time.


## 0.9.1
### Changed

- `login` shows a QR code by default; `--phone` or `--code` switches to the 8-character pairing code.
- `login` now stays up after linking until WhatsApp has delivered the chat history, so a fresh account no longer comes up with zero chats.
- `list_chats` lists any chat that has messages, even before WhatsApp describes it.
- The CLI draws for a human at a terminal: a brand-coloured banner, numbered
  steps through `login` with the pairing code in a box and a spinner counting it
  down, an aligned `status` block, and one `Next` line telling you the single
  command to run. Failures render as `✗ what happened` with `→ the repair`
  under them. Colour is on only when stderr is a terminal and `NO_COLOR` is
  unset; `FORCE_COLOR` decides either way, and piped output keeps the same
  words it had before.
- The linked account's number is masked wherever it is printed, so a `status`
  screenshot no longer carries it.


## 0.9.0

First release under the name `wazap`. The project was a developer's MCP server
for one machine; this turns it into something a stranger can install with
`npx wazap-mcp login`.

### Added

- `wazap` CLI with `login`, `status`, `logout` and `serve`. `login` uses a
  pairing code by default (`--qr` falls back to a QR code), so linking never
  needs a screenshot of a terminal.
- A single data directory, `~/.wazap` by default (`--data-dir` or
  `WAZAP_DATA_DIR`), holding credentials, media, history and the server lock.
  Nothing is written next to the installed package any more.
- Atomic credential writes: every auth file is written to a temp file and
  renamed into place, so a kill during a write can no longer corrupt the session
  and force a re-link.
- A lock file per data directory. A second server on the same directory exits
  with code 2 naming the pid of the one already running.
- A structured error model. Every tool returns `{ error, message, fix }` with
  one of 27 codes instead of a raw exception, and `learn` documents what an
  agent should do about each.
- A sync gate: read tools wait up to 10 seconds for the initial history sync and
  report `sync: "in_progress"` when they answer early.
- A write rate limiter, 20 calls per minute by default (`WAZAP_RATE_LIMIT`,
  `0` disables).
- New tools: `get_message`, `send_poll`, `send_location`, `edit_message`.
- `wazap connect <client>` for `claude-code`, `claude-desktop`, `cursor`,
  `codex`, `vscode` and `gemini`. It writes the MCP entry itself, keeps the rest
  of the file, backs it up once before the first change, refuses a config file
  it cannot parse rather than clobbering it, and is a no-op on a second run.
  `--dry-run` prints what it would write.
- Writes are opt-in. `login` asks once and stores the answer as
  `WAZAP_READ_ONLY` in `<data-dir>/.env`; `wazap config writes on|off` changes
  it later, and `wazap config` prints every effective setting together with
  where it came from (flag, environment, `.env` or default).
- Bare `wazap` at a terminal prints the banner, the status and the one command
  to run next instead of starting a silent MCP server on stdin. Explicit
  `wazap serve` always serves.
- `wazap status` became a doctor: it checks the Node version, the data
  directory's existence, mode and writability, the lock (none, held, or stale),
  the credentials, the writes setting, and whether npm has a newer version, and
  prints the fix beside anything broken. `--live` reaches WhatsApp for real and
  reports the phone, the chat count and the last message; `--json` prints the
  whole report as one object for scripts. `WAZAP_NO_UPDATE_CHECK=1` turns the
  registry call off.
- `Dockerfile`, `docker-compose.yml`, a systemd unit and a Caddyfile under
  `deploy/`, with a Self-host section in the README; a "Works with" table for
  Cursor, Codex, VS Code and Gemini CLI.
- Five Agent Skills under `skills/` (`wazap-setup`, `whatsapp-inbox`,
  `whatsapp-recall`, `whatsapp-groups`, `whatsapp-send`) and a Claude Code
  plugin manifest that installs them together with the MCP server.
- `send_media` gained `as_voice` for voice notes, `send_message` gained
  `mention_ids`, `manage_group` gained `revoke_invite_link` and per-participant
  results, `get_group_info` reports admin status, announcement mode and the
  invite link.

### Changed

- 22 tools, with schemas describing every field. `get_recent_chats` is now
  `list_chats`, and `load_older_history` is absorbed into `read_messages`
  through its `before` argument.
- Messages have a richer shape: typed `type`, a never-empty `text` with
  placeholders like `[voice message]` and `[poll] question`, quoted message,
  reactions, forwarded and edited flags, media metadata, ISO 8601 timestamps
  with a UTC offset, and a human `age`.
- Identifiers are canonicalized in one place. Tools always return
  `<digits>@s.whatsapp.net` or `<id>@g.us`, and accept phone numbers, `@c.us`
  and `@lid` on input.
- Read-only mode no longer registers the write tools at all, rather than failing
  them at call time.
- Environment variables use the `WAZAP_` prefix. The old `WHATSAPP_*` and `MCP_*`
  names are gone, with no compatibility layer.
- Requires Node 20.

### Removed

- The `whatsapp-web.js`-shaped adapter layer and its message hooks, unused since
  the move to Baileys.
- The separate message journal. History now comes from the store under the data
  directory.
- QR rendering inside the server. Linking is the `login` command's job.
