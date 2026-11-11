# The tools

What each of the 23 tools answers, the workflows behind them, and every error
code. The [README](../README.md#the-23-tools) has the one-line table.

## The 23 tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `learn` | read | The guide, as text, one `topic` at a time: `ids` (formats, several accounts, the message shape), `workflows`, `errors` (what to do about every code), or `all`; with no topic, the list of topics. An agent calls it when unsure, not before every conversation: what matters on every call is in the server's instructions and in each answer's notes and next step. |
| `get_status` | read | Connection status, sync state, linked account, how fresh the history is, webhook delivery, versions, data dir, and `health`: what WhatsApp says about the account itself (a reachout timelock, a ban, a session taken over, its cap on first messages to new people), with until when, and `link`: an outage under way (`down_since`, `alerted`), the last one, sleeps the server woke from and sockets its watchdog replaced. Top-level fields are the default account; `accounts` lists every configured one and `default` names it. `include_picture: true` adds `picture_url`, the account's own profile photo (a WhatsApp link that expires; `null` when there is none or it cannot be read). Optional `account_id` on this and every other tool. |
| `link_account` | read | Pair an account that already exists (`wazap account add`). Returns the code to type into the phone. Registered in read-only mode too. |
| `list_chats` | read | Conversations newest-first; filter `all`/`unread`/`groups`/`individual`/`archived`; `tag` keeps the chats of people filed under it ([Working by tag](#working-by-tag)). `include_pictures: true` adds `picture_url` per chat (a link that expires; none for `#private`). |
| `read_messages` | read | Messages in a chat; `before` pages further back, pulling older history from the phone; `since` and `until` read a time window (ISO dates or times, as `search` reads them: a bare `until` date is its whole day), saying `more_in_window` when it holds more than `limit` and when the chat's stored history starts inside it; `types` narrows to one or more message types, e.g. `["call"]`; `include_previews` attaches a small image of each photo; `full_text: true` shows each message's text whole instead of cut at 500 characters (300 for a story). `hours` reads the last 1 to 24 hours of the chat, a window that opens that long ago (pass it or `since`, not both). `chat_id: "status"` reads the stories of the last `hours`, which show nowhere else. `chat_id` may be a name, number or relationship that `find_contact` resolves to one chat ([Reading by name](#reading-by-name)). |
| `catch_up` | read | What the user missed, in one call and within a token budget, across every linked account: who is waiting on a reply, mentions, replies and open polls, missed calls, people, groups condensed, stories. Pages with a cursor. `ids: true` names the messages it quotes and each person's and group's newest media by `message_id`, for `get_media`, a reply or a reaction. See [Catching up](#catching-up). |
| `search` | read | Messages by meaning and by words at once, over everything the account keeps, so a paraphrase still hits (another language seldom does); `match: "words"` keeps only messages holding the words. `chat_id` (an id, a number, or a name that resolves to one chat), `since`, `until`, `from` and `tag` narrow it, and the answer says how much it searched. `full_text: true` shows each text whole instead of cut at 500 characters. Each hit carries its chat's name (`chat_name`) beside its id, so a group reads as its subject. Without `chat_id`, someone tagged `#private` is left out and counted in `private_omitted`. Without [semantic recall](recall.md#semantic-recall) it matches words and says so. |
| `get_message` | read | One message in full, its text never cut, with its chat's name, its quoted message, each reaction with who left it, and who voted for each option of a poll or answered an event. On your own messages, `delivery` says whether it was sent, delivered, read or played, and in a group who read it and when. |
| `find_contact` | read | Who a name, nickname, relationship ("mama"), group name, number or id means. Resolved: the `chat_id`, number, note, tags and details, plus the recent exchange and how you write there in a session that can send. Otherwise the candidates that tell people apart, to ask you. `tag` lists everyone filed under a tag, newest conversation first. See [Finding people](#finding-people). |
| `list_contacts` | read | The phone's address book on one account, a page at a time (up to 500, `next` as `cursor`): each person's saved name, number in E.164, `chat_id`, `contact_id`, and when the last direct message was and which way it went. `order: "recent"` (default) puts whoever you talked to last first; `address_book` keeps the phone's order. No message words. See [The address book](#the-address-book). |
| `get_group_info` | read | Participants, admins, announcement mode, who may edit the info or add members, join approval, disappearing messages, community, invite link (when you are admin). |
| `get_media` | read | A message's media as an agent can take it in: a voice note or audio as its transcript, a photo or sticker as a JPEG view (`detail`), a video as a contact sheet, a document as its text (`pages`) and a picture of its page; see [Media for remote agents](#media-for-remote-agents). `message_ids` (up to 8) opens several messages in one call, each answered in order. A local session also saves the file (`save_to` picks the directory). Transcription runs on the local or the API provider; with `save_to` a recording comes as its file, with a transcript only if one was already made, and when no transcript can be made the file comes instead, with `transcript_unavailable` saying why. A copy [kept when the media arrived](data.md#kept-media) answers first, even with the link down, and `source` says which: `kept` or `whatsapp`. |
| `wait_for_messages` | read | Block up to 55 s until a message arrives, then return it with a cursor for the next call. `addressed_to_me` wakes only for direct messages, @-mentions and replies. |
| `remember` | local | Keep what the user says about a person, on this machine only: a note, tags, details (`relatie`, `nickname`, "role": "contabil") that `find_contact` matches, and `handled: true` to take an ask off `catch_up`'s waiting list until they write again. A list of `chat_id`s files the same tags and details on all of them at once, or on none. `#private` keeps their words out of what the assistant did not ask about them by name ([Keeping someone private](#keeping-someone-private)). Nothing changes on WhatsApp. |
| `send_message` | write | Draft a message: text (a reply, @-mentions), media from a path, a URL or the call itself (`data_base64` with `filename`, up to 5 MB), fetched and kept when drafted so the preview names the real file ([Media from a URL](#media-from-a-url)) (`as`: document, voice note or GIF), a poll (`options`), a location (`latitude`, `longitude`) or a forward (`forward`). Does not send. A text draft to someone you write to often carries `style_check`: where it does not read like you. `send_at` (with `time_zone`) drafts it for later; see [Scheduling a message](#scheduling-a-message). |
| `confirm_send` | write | Send a draft after the user has seen the preview and said yes. A draft is sent at most once; see [Sending once](#sending-once). A draft with `send_at` is scheduled instead. |
| `edit_message` | write | Edit your own message, within WhatsApp's 15-minute window. |
| `react_to_message` | write | Add or remove an emoji reaction. |
| `delete_message` | write | `for_everyone: true` retracts your own message, within WhatsApp's 2-day window, and in a group where you are admin someone else's message too. `for_everyone: false` deletes any message for the linked account only, at any age. |
| `manage_chat` | write | Preview archive, pin, mute (8h default), message pins/stars, clear/delete, block and their undo actions; confirm with the preview id. `mark_read` alone remains direct for read-receipt integrations. |
| `manage_group` | write | Create a group; join one from an invite link or message (without `confirm: true` it only shows the group); add, remove, promote, demote, leave, rename, set or remove the group photo, invite links, list, approve or reject join requests, and change the settings. Every member sees a change at once. |
| `scheduled_messages` | write | The account's scheduled messages: `list` (waiting ones soonest first, then the week's sent, missed, failed and cancelled ones) or `cancel` one by `schedule_id` before it goes. Not registered in a session without writes. See [Scheduling a message](#scheduling-a-message). |
| `reminder` | local | A reminder about a chat, kept on this machine and posted to the user's webhook when due: `create` (`chat_id`, `note`, `after_hours` or `due_at`, `condition` `always` or `no_reply`), `list`, `cancel`. Nothing is sent on WhatsApp. See [Reminders](#reminders). |

### What an answer carries

Each session gets one rendering of every answer, fixed at its `initialize`
(`WAZAP_ANSWER_FORMAT`, [settings](settings.md)). A client that names itself
as an assistant (Claude Code, claude.ai and Claude Desktop, Codex, Cursor,
ChatGPT, Gemini CLI) gets the **text** format, whatever its credential: each
answer is its text block and its images, nothing else, and the tool list has
no `outputSchema`. Any other client, which is what a program is on a static
token or over OAuth, gets the **full** format: the same text block and the
structured content each tool's output schema declares.

The text is complete for an agent, and compact:

- every id a later call takes is on its line: `message_id`, `chat_id`,
  `draft_id`, `confirmation_id`, `schedule_id`, `reminder_id`, a group's id,
  each cursor (`list_chats`, `search`'s `before`, `catch_up`'s `more.cursor`,
  `wait_for_messages`, `list_contacts`); a person is named by name and
  formatted number, which every tool takes as a `chat_id`, and by their id
  where there is no number (a LID);
- messages come under a heading per day (`## 2026-11-10 Tue · today`) with
  the minute on each line, in the server's time zone; each sender's number,
  note and tags the first time they appear; the chat only where it changes,
  by its name and its id (`in Bloc 12 (…@g.us)`); a mention as the phone
  shows it, `@Ana`, where the stored `text` carries digits (`@<token>`, a
  mention's `token`: a lid's digits name nobody); a reply's quote with its id
  when that message is not on the list; a voice note's transcript;
- the answer's notes and its next step are the very sentences of the
  structured `notes` and `next` (a draft's approval rule, `find_contact`'s
  "call send_message now"), so no client is told something else;
- nothing twice: one line per chat in `list_chats`, a member per line in
  `get_group_info`, and search's nearby context leaves out the hits already
  listed.

`test/answer-text.test.mjs` checks every tool on the evaluation's fixture
world: each id, cursor, note and next step in the structured answer is also
in the text.

### Confirming a chat change

`manage_chat(chat_id, action, ...)` returns `status: "preview"`, the resolved
account and chat, the effect, `confirmation_id` and a 15-minute expiry. It does not
archive, block, delete, pin, mute or otherwise mutate the chat. Show the preview;
after approval call `manage_chat` with the returned `chat_id`, `action`,
`confirmation_id` and the same `account_id`. Omit the message and duration options:
they are frozen in the preview. A different target, action or identity is refused.

The confirmation is scoped to its authenticated identity, account, linked owner
and service instance. A new connection using the same remote credential can
confirm; a different credential cannot. A restart invalidates pending previews.
Other tool calls in that session make an unattempted preview stale. Write policy
and target identity are checked again before execution; message actions also
refuse a changed source text. Repeated or concurrent confirms share one attempt.
`CHAT_ACTION_OUTCOME_UNKNOWN` means inspect state and do not retry automatically.

`clear` and `delete` remove the account's chat history and local index; every
member sees a message pin. The preview states that scope. The existing
`mark_read` action remains direct for integrations that send read receipts and
must only be called when the user asks. This gate requires a separate preview and
confirmation call; it cannot independently prove that a human approved the preview.

### Sending once

A drafted message does not reach WhatsApp until `confirm_send`, and a draft goes out at most
once, even across a crash. Drafts are kept in the account database for 15
minutes, at most 20 per MCP session and 200 per account, each with the WhatsApp
message id it will be sent under. Confirming a draft again answers the same receipt with
`already_sent: true`, and two confirms at once send it once. A failure while
the message is still being prepared (not connected, the write budget, the
number lookup, a missing file, a media upload) leaves the draft as it was, to
confirm again. Once the message is handed to WhatsApp's relay (which also looks
up the recipient's devices and encrypts it before writing), a failure answers
`SEND_OUTCOME_UNKNOWN`: WhatsApp may have the message, so that draft is never
sent again. The agent checks the chat instead. When WhatsApp later echoes that
message id, the send is recorded as sent, and the identity that confirmed it gets
the receipt from then on. For 24 hours a confirmed draft answers its receipt or
`SEND_OUTCOME_UNKNOWN` to that identity; deleting the sent message, or clearing
or deleting its chat, removes its words from the record. On HTTP a draft's identity is the credential's, so a
reinitialized session on the same credential still confirms it; on stdio,
bridges and the daemon's own channel drafts stay per-session. Drafts do not survive a restart: after one, no
session can confirm a draft made before it, sent or not, though a send the
restart interrupted is still recorded as unknown and still settles when its id
is echoed.

### Scheduling a message

`send_message` with `send_at` drafts a message for later; everything else about
the draft is the same, the recipient's send rules included. `send_at` is a
date and a time: a wall-clock time like `2026-10-12T09:00` is read in
`time_zone` (an IANA zone such as `Europe/Bucharest`; the server's own zone
when left out), and one with an offset (`2026-10-12T09:00:00+03:00`, `…Z`) is
that instant. It must be at least a minute and at most 365 days ahead. A time
the clocks skip when they spring forward is refused (`INVALID_TIME`); one they
repeat when they fall back is the first of the two, and the answer says so.
The preview carries a `Scheduled:` line with the day, the time, the zone and
its UTC offset, and the draft carries `send_at` (ISO, with that offset) and
`time_zone`, so the user says yes to the exact time.

What leaves is what was approved. Media from a `url` is fetched when it is
drafted and kept until it goes ([Media from a URL](#media-from-a-url)), so a
draft for later takes one like any other: at its time the kept bytes go, and
the URL is not asked again. A `file_path` is pinned by its SHA-256 when
drafted, and a file changed by the time it goes is refused (`FILE_NOT_FOUND`)
and the message closes as failed. A reply (`reply_to`) or a forward goes only while the message it names
is still stored; on an account with `WAZAP_PERSIST_HISTORY=0`, which forgets
messages at every restart, a reply or forward for later is refused when
drafted.

`confirm_send` on that draft is the yes, and schedules it rather than sending
it: it answers `status: "scheduled"` with a `schedule_id`. The same draft
confirmed again answers the same schedule with `already_scheduled: true`. A
time that came or passed while the draft waited for the yes is refused, and
nothing is scheduled or sent. Nothing but this confirm schedules a draft, and
no confirm sends a draft made for later at once. An account holds at most 100
scheduled messages waiting (`SCHEDULE_FULL`).

At its time the message goes through the same send as any confirm, under the
WhatsApp key it was drafted with, so every check runs again at that moment:
the account's record on disk (enabled, writes on), the server's read-only
switch, the send rules, the link, WhatsApp's own restrictions and the
account's write rate limit. A refusal no retry fixes (`SEND_BLOCKED`,
`READ_ONLY`, `NOT_ON_WHATSAPP`, …) closes it as `failed`, sending nothing. A
refusal that may pass waits and tries again: the link being down or the rate
limit until the window below closes, after the wait the limiter names, without
counting as attempts; a timeout or another passing error before the message
left is tried up to ten times, then closes as failed. A message wazap could not send within 15
minutes of its time — the server was stopped, the link was down — is
`missed`: it is never sent late, and a restart never sends a backlog in a
burst. One that reached WhatsApp and then failed is `unknown`, never sent
again, and becomes `sent` when WhatsApp echoes it, as in
[Sending once](#sending-once). A send a crash interrupted is settled at the
next start from its send record: sent again only when it certainly never
left, within the same 15 minutes.

Missed, failed and unknown messages are reported, not dropped:
`scheduled_messages` lists them with `error_code` and `error` for a week
(`error_code` is an error code from the table below, or `NOT_RUNNING` for one
that came due while wazap was stopped, or `INTERRUPTED` for one a stop or a
crash cut short),
`get_status`'s `hint` counts them, and with the `scheduled` webhook event on
each outcome is posted once (see
[the webhook](api-and-webhooks.md#reminders-and-scheduled-messages)).

`scheduled_messages` lists and cancels them. It is a write tool, so a session
without writes, a read-only server and a read-only account never see or use it;
any write session on the account sees the account's scheduled messages, since
a session that scheduled one may be gone by the time it is to be cancelled.
Scheduled messages live in the account database and survive restarts. A
waiting one keeps its words there until it is sent or closed, also on an
account with `WAZAP_PERSIST_HISTORY=0`; once sent the record keeps no words,
and a closed record goes a week later. A different number linking to the
account sets its database aside, scheduled messages included: they never go
from another number.

### Media from a URL

`send_message` with `url` fetches the file when it drafts, through the same
guard as before (every DNS answer and redirect must be a public address, the
connection is pinned to the checked address, at most 100 MB, 30 seconds), and
keeps it in `accounts/<id>/outgoing/` under its SHA-256 (`0600` in a `0700`
folder). The preview names the file as it is: its name (the server's
`Content-Disposition`, else the URL's last segment, with the extension its type
has when the name has none), its type told by its bytes (a PDF a server labels
`application/octet-stream` is a PDF; an MP3 with no ID3 tag, whose first bytes
are only a frame header, is audio only when its declared type and its name do
not say otherwise), and its size, as
`[document] factura.pdf (application/pdf, 120 KB)`, and the draft carries
`media: { filename, mime, size }`. A URL that fails, answers 404 or is too large
fails the draft, before the user is asked anything; a caption on what turns out
to be audio is refused then too. `confirm_send` sends exactly the kept bytes,
checked against their hash (`FILE_NOT_FOUND` if the file changed or went, and
nothing is sent), without fetching the URL again.

Whatever its source, a photo, video or recording goes as WhatsApp shows its
own only in a type WhatsApp's viewer and players take (JPEG, PNG, WebP or GIF;
MP4, MOV or 3GP; MP3, M4A, AAC, AMR or Ogg). Any other, HEIC, AVIF, WebM, MKV,
AVI and WAV among them, goes as a document with its caption: sent as a photo or
a video, WhatsApp would label it JPEG or MP4 and the recipient's phone would not
open it. An MP4-family file whose brand says nothing of what it is takes its
declared type or its name's, never a video's by default.

**A file of the agent's own.** A cloud agent with a file and no public URL
for it (a claude.ai attachment, a file a cloud sandbox made) passes it in the
call: `data_base64` (plain or URL-safe base64, line breaks allowed, or a
`data:<type>;base64,` URL) with `filename`, the name the recipient sees, and
`mime` when it knows the type. Up to 5 MB once decoded; a larger file is
refused with `FILE_TOO_LARGE` and the fix to pass it as a `url`. It is kept and
previewed like a URL's file, its type told by its bytes, else by `mime`, else
by its name (a ZIP is the Office or OpenDocument file its name, or else `mime`,
says), and sent byte for byte, `send_at` included. It is one source among
`file_path`, `url` and `data_base64`: pass one. Over HTTP the request carrying
it must come from a write credential and declare its length (every HTTP client
does for a JSON body); see [Request budgets](self-host.md#request-budgets).

A kept file goes once nothing names it: after the send, when the draft expires
unconfirmed (15 minutes), when a scheduled message is cancelled, sent or
closed, and at the next start for anything a crash left. Two drafts of the
same bytes share one file. An account's kept files together hold at most 1 GB,
and none is written that would leave the disk less free than the smaller of
1 GB and 5%: past either, the draft is refused with `FILE_TOO_LARGE`.

### Reminders

`reminder` keeps a note about a chat for later, on this machine, and posts it
to the user's webhook as a `reminder` event when it is due. `create` takes
`chat_id`, `note` and either `after_hours` or `due_at` (read like `send_at`,
with `time_zone`). `condition` is `always` (the default) or `no_reply`: "remind
me if Ana has not answered in two days" is `condition: "no_reply"` with
`after_hours: 48`. A `no_reply` reminder is skipped, not posted, when anyone
other than the user wrote in that chat after it was set — a message that
reached the account since, sent no earlier than ten minutes before the
reminder was set; system notices do not count, and neither does history filed
late from before; on an account with `WAZAP_PERSIST_HISTORY=0` a reply is
noted before the messages are purged at a stop or start, so it still counts
after a restart. It waits while the link is down, and a minute after it comes
back, so a reply still on its way is not missed. `list` shows waiting reminders
and the week's fired, skipped and cancelled ones, each with `outcome`
(`posted`, `webhook_off`, `event_off` or `replied`); `cancel` takes
`reminder_id`.

A reminder reaches the user only through the webhook with the `reminder` event
on; without it, `create` says so in `notes`, a due reminder closes as fired with
`outcome` `webhook_off` or `event_off`, and `reminder list` is the only place it
shows. Like `remember`, reminders are registered in a session without writes,
and setting or cancelling one needs a credential that may change local state:
a read token is refused. An account holds at most 200 waiting.

### Catching up

`catch_up` answers "what did I miss?" in one call. It reads the account
database only — no network, except the cached member list of at most a dozen
groups, fetched within a second — and fits its answer into `budget_tokens`
(2,500 by default, 500 to 8,000), one line per entry. The budget is spent on
what the session receives: the text in an assistant's session, the structured
JSON (the longer copy) in a program's, at 2.2 characters a token, the ratio
measured on Claude for these answers, so 2,500 is about 2,500 real tokens; it
used to count 4 characters a token and so delivered about twice the tokens
asked. `approx_tokens` is counted the same way. The order:

1. **Waiting on you**: people whose last word asks for something — a question
   mark, a request word, or a voice note nobody has heard, never "ok, thanks"
   or a link — with the ask quoted (a voice note by its transcript) and what
   they said after it. In a group only when the user was @-mentioned or replied
   to. An ask stays until the user answers, `remember` marks it `handled` or it
   is two weeks old; `new` marks one that
   arrived since the last catch-up, and an answered call after the ask says
   it may have been dealt with by phone.
2. **Mentions, replies and polls**: group messages that @-mention the user or
   reply to them, and polls and events they have not answered, muted and
   archived groups included.
3. **Missed calls**, one line per person, saying whether the user called back
   or wrote since.
4. **People** who wrote: saved contacts first, then by how much they wrote;
   business accounts, numbers nobody saved and muted chats last. One quote
   each, with the media counted by kind.
5. **Groups**, one line each: how many messages, from how many people, the
   three who wrote most, media, polls, and a quote when the budget allows.
   Muted and archived groups share one line.
6. **Stories**: how many, and from whom.

A footer names the voice notes nobody transcribed (for `get_media`) —
only counting those of someone tagged `#private` — and counts what was left
out: chats tagged `#no-catchup`, groups the user left, channels and broadcast
lists. Signals — an amount, a date, a time, an address,
a link, a question — are marked on the entries shown, and an ask carrying a sum
or a date moves up. A chat's messages count as missed only after the user's
own last message there and after what their phone already read.

**Ids.** `ids: true` adds what an agent acts on next, so it needs no
`read_messages` first: every entry that quotes a message carries its
`message_id` (`id`; for someone waiting, the ask's, and `then_id` for what
followed when it is quoted too; an ask nobody transcribed is named as well),
a mention, reply, poll or event carries its own, and a person or group whose
messages include photos, videos, documents, stickers or audio files carries
the newest three as `media_ids`, newest first, ready for one batched
`get_media`. The text line ends with `· id <message_id>` and
`· media <id> <id>`. Nothing #private is ever named: their entries carry no
id, and a group's `media_ids` leave out what they sent. It is off by default
because ids are long: on the evaluation's two-account fixture they add 889
characters to a 14-day digest of 14 entries (2,642 → 3,531) and 712 to a 24-hour
one, 7 to 9% of the default 2,500-token budget, which a busy digest would pay
in entries and quotes that no longer fit. A digest asked with `ids` keeps them
on every page of its cursor.

**The mark.** Each client keeps its own mark per account: the OAuth client,
the token (`WAZAP_READ_TOKEN` and `WAZAP_WRITE_TOKEN` are two clients), or
for stdio and the clients sharing a running wazap the MCP client's own name
(`local:claude-code`, `local:cursor`), so two assistants on one machine do not
share a mark. By default a
catch-up reads since that client's last complete one, and moves the mark once
all of it was given: a digest with no `more`, or the last page of one. The
mark follows what reached wazap, not the time a message carries, so a message
filed late — a missed call stored when it stops ringing, a message decrypted on
a retry, one from a phone whose clock runs ahead — is in the next catch-up
rather than under the mark; nothing sent more than two weeks ago counts. The
first time, or when the mark is more than a week old, it reads the last 24
hours and says so. `since: "previous"` gives the last catch-up again;
`hours: N` (up to 336) or `since` as an ISO date or time (`2026-09-16`,
`2026-09-16T18:00`, an offset optional) from the last 14 days read an explicit
window and leave the mark where it is, and so does a catch-up limited by
`include`. No window reaches further back than 14 days. Two catch-ups of one
client at once move the mark once. The mark moves when the last page is
answered, before the answer is on its way, so a catch-up is given at most once:
if the answer is lost (a dropped connection, a client that crashed),
`since: "previous"` gives it again. Nothing is marked read on WhatsApp.

**Paging.** When the entries do not fit, the answer ends with `more`: how many
are left per section, about how many tokens they take, and a `cursor`. The
first page works out the whole digest and holds it, so the next pages give
exactly the rest of it, whatever arrives or is read on the phone in between.
A cursor is a random id that only the client that got it can use, and it lasts
15 minutes past its page; after that, or after a restart, it is
`CURSOR_EXPIRED`: call `catch_up` again without it, the mark has not moved.

**Several accounts.** Without `account_id`, a catch-up covers every linked
account at once, each section labelled per account, sharing the budget. A
disconnected account is reported as disconnected, with what it had stored, and
keeps its mark.

**Leaving a chat out.** Tag a person `#no-catchup` with
`remember` (an agent, a bot, a busy notification number) and
catch-ups skip their chat, counting it in the footer, and nothing they send
elsewhere shows either: no ask, mention, poll or quote of theirs in a group, no
group call, no story. Tag them `#private`
instead and they stay in, counted, but nothing they wrote is quoted — not the
ask, not a mention or a poll of theirs in a group, not a group's quote — and
their entries say `private` ([Keeping someone private](#keeping-someone-private)).
A person tagged on any linked account is tagged on every account a catch-up
reads, by number or lid, with `account_id` or without.

### Seeing, waiting, following up

`include_previews: true` on `read_messages` attaches a
small JPEG of each photo as an image block, newest first, up to 6 per call
(two reads stay well under the twenty images a hosted client takes in one
message); the text says which message each image is (`preview 1 is
<message_id>`, and `[preview 1]` on that message's line), and `previews` lists
their message_ids in order for a client that reads the structured part, so a
catch-up can say "a photo of a receipt" without a download. A photo past the
six is counted in a note, and the next call brings it. WhatsApp used to ship such a
preview inside every image message and in 2026 almost never does, so when
none is there wazap downloads the photo (or reads the [kept copy](data.md#kept-media),
even with the link down) once, shrinks it to 320 px on this machine with sharp,
off the event loop and for any image format, and keeps the result as a file under
`previews/` in the data directory, so a restart does not redo it. Where sharp's
prebuilt binary does not load, a JPEG is shrunk in pure JavaScript instead. A video gets
one frame, taken by ffmpeg a second in, when ffmpeg is installed. An SVG is
never drawn for a preview (`get_media` draws it), and a photo that downloaded
but made no preview is not downloaded again for an hour. The first
call over a day of photos takes a few seconds; the next is instant.

**A window.** `read_messages` with `since` and `until` reads one stretch of
a chat in one call: "what did Ana send yesterday" is `since` and `until` set
to yesterday's date, and "the photos and documents she sent" adds
`types: ["image", "document"]`. The answer echoes the window it read. When
the window holds more than `limit` messages, it gives the newest of them with
`more_in_window: true`; `before` with the oldest `message_id` and the same
window pages on inside it, and never asks the phone while the window's start is
stored. When the window reaches back past the chat's stored history (nothing is
stored from before `since`, or there is no `since`: a window with only `until`
reaches back to the chat's start), the answer says where that history starts,
whatever `types` kept, and names its oldest message: `before` with that id, or
any other, and the same window asks the phone for what came before the stored
history. An empty window then says the phone may hold its messages, never that
there are none. A `since` before 1970 reads from 1970; one past the year 2242
is refused.

With `types`, one read looks through at most 10,000 messages for the ones it
keeps. When it stops there with fewer than `limit` and older messages still
stored, the answer says so (`more_in_window` too, in a window) and names the
oldest message it looked at: `before` with that id and everything else the same
goes on from there, without asking the phone. A short page is then never the
whole of a window, nor the start of the chat.

`wait_for_messages` blocks until something arrives, up to 55 seconds, then
returns it with a `cursor`. Calling it again with that cursor replays whatever
landed in between, so an agent can sit in a loop and miss nothing. With
`addressed_to_me` only direct messages, @-mentions of the user and replies to
their messages wake it; group chatter does not. The user's own messages and
WhatsApp's notices never do.

Every message comes back with a non-empty `text`: media and system messages
carry a placeholder such as `[image] caption`, `[voice message · 0:42]`, `[deleted]` or
`[poll] Pizza or pasta?`. A poll also carries each option with who voted for it,
and an event who answered going, maybe or not going. Timestamps are ISO 8601 with the machine's UTC offset,
alongside a human `age` like `2h ago`.

### Media for remote agents

`get_media` answers with what an agent in any client can take in: image blocks
and text. No hosted client plays audio or video or opens a file from a tool
result, and a cloud agent cannot open a path on the machine running wazap, so a
remote session (HTTP: a token or OAuth) gets no file written and no path, and
every kind of media comes back as follows. A local session (stdio, the daemon's
bridge) gets the same, plus the file saved and its `path`.

| Media | What comes back |
|---|---|
| Photo, sticker, image sent as a document (JPEG, PNG, WebP, GIF, SVG; HEIC through macOS `sips`) | One JPEG view (WebP, GIF, HEIC and TIFF up to 25 MP, JPEG and PNG up to 100 MP; an SVG is drawn in a process of its own, stopped after 10 s): long edge 1,024 px within about 110 KB, so its base64 stays under the ~150,000 characters a hosted client keeps. `detail: "high"`: 2,048 px within 1.5 MB, for small print. An animation shows its first frame; transparency sits on white. A long image (a scrolling screenshot, a receipt, a panorama: about 2.6:1 and longer) is cut into up to six strips that each repeat a little of the next, laid side by side or one under another, so its text is drawn larger than a whole fit would allow (`view.strips`, `view.strip_layout`). `view` gives its size and the original's. A Lottie sticker shows the thumbnail it shipped; a remote session gets it without a download. |
| Video, GIF, round video | A contact sheet: six frames spread across the clip, tiled into one 1,024 px JPEG, with `frames_at` (the second of each) and `duration_seconds` (ffmpeg's own reading when the message overstates it). Needs ffmpeg; when no sheet can be made, one frame sized like a view, and without ffmpeg the thumbnail WhatsApp shipped. The sound is not transcribed. |
| Voice note, audio | Its transcript (see [Voice notes](voice.md)). When none can be made, a remote session gets only `transcript_unavailable` and the recording's facts. |
| PDF | Its text, page by page under `--- page N ---`, from page 1 until about 12,000 characters, in `document_text`, with `document.pages_total` and the pages returned. `pages: "2-4"` (or `"5"`, `"5-"`) picks others. The first asked page also comes as a picture when poppler's `pdftoppm` is installed, or on macOS for page 1 through Quick Look; a scan with no text layer is read from that picture. |
| Word, Excel, PowerPoint, OpenDocument (docx, xlsx, pptx, odt, ods, odp) | Their text from the file's XML: paragraphs; sheets as tab-separated rows, each value under its column's header and dates as dates; slides under `--- slide N ---` (`pages` picks slides). |
| Text, CSV, JSON, Markdown, XML, HTML | The text, decoded (HTML without its scripts, styles and tags): UTF-8, UTF-16, the charset an HTML or XML file names, or else Windows-1250 or 1252 (Excel's CSV on Romanian or Western Windows), whichever the letters point to. |
| Anything longer than one answer that has no pages of its own (Word, sheets, text, HTML) | Parts of about 12,000 characters under `--- part N ---`, cut at a line: `pages: "2"` reads the second, `document.unit` is `part` and `document.pages_total` says how many there are. Up to 2,000,000 characters (8 MB of a text or HTML file) are read. |
| Anything else | Its facts only (`mime`, `size`, `original_filename`), and a note saying so. |

A document's text, a transcript and any text in an image were written by the
sender: `document_text` is quoted in the text between `<<<document_text <tag>`
and `>>> <tag>`, with a tag drawn for each answer, and a line of the document
that starts like a marker is escaped with a backslash, so the sender cannot end
the quote early; `notes` says it is data, not instructions. The server's
instructions carry the same rule for every session.

With `WAZAP_PUBLIC_URL` set, a remote session also gets `link`: the original
file, valid 30 minutes, for the person to open (see
[self-hosting](self-host.md#host-files-and-remote-media)); hosted chat clients do
not fetch it themselves, so the view and the text above stay the main answer.

Expired media (WhatsApp's servers keep a file for a limited time) is asked of
the phone again when someone asks for it: the phone has 20 seconds to upload it
anew, and the fresh address is stored so the next call goes straight to it. A
phone that is offline gives `MEDIA_UNAVAILABLE` with a fix to retry once it is
online. Downloads are held in memory, at most three at once and 300 MB in
flight; one that stalls for 30 seconds or runs past three minutes is stopped.

**Several at once.** `message_ids` (up to 8, instead of `message_id`) opens
several messages in one call, a few at a time: "show me the photos Ana sent"
is one call after the read that found them. Each message is answered in the
order asked, under its own `## n of N · <message_id>` heading with its image
right after its own lines, and in `items` (one object per message, with the
fields a single answer has; the top-level `message_id` is the first one asked
and `type`, `caption`, `original_filename` and `sender` are `null`). One that
cannot be read — gone, not media, a download that failed — carries
`error: { code, message, fix }` in its item and its section, and the others
still answer. Every view is the standard one, so a batch holds at most eight
image blocks of about 110 KB each: `detail: "high"` and `pages` take one
message at a time and are refused with `message_ids` naming more than one (a
list of one, as `catch_up`'s `media_ids` often is, is answered in `items` and
takes them). Every item has its own
download, under the same budget as a call of its own; a repeated id is
answered once; a cancelled call stops them all. Whether a hosted client counts
the images toward its ~150,000-character result is not documented: a batch of
eight photos is about a million characters of base64.

The answer's text names the next call when there is more to read (`pages: "4"
reads on`); `document.truncated` says the asked pages were cut at the budget.
What wazap says of a read (a refusal, a read that failed, a page past the end,
a file read only up to its limit) is a line of the text too, not only in
`notes`, and a file that could not be read is never called empty.

Documents are read in a worker thread with a memory cap and a 20-second limit,
two at a time; Office files go through a small ZIP reader that refuses an
archive with too many entries, an entry that inflates past 20 MB (60 MB in all)
or at more than 200:1, and an entry that lies about its size. A PDF's streams
are unpacked and measured before it is read: one past 64 MB, or 256 MB in all,
refuses the file as a compression bomb; a stream whose dictionary cannot be
read is measured as every filter that could expand it. That check is a first
line a crafted file can get past; the bound is the memory watch: while a
document is read the server's memory is watched and the read stopped past
512 MB of growth, and the page is drawn only after the read, never for a file
it refused or stopped, by one renderer at a time, itself stopped past 512 MB.
A file over 50 MB is not read. One download serves the view, the sheet, the
text and a local session's file.

### Finding people

`find_contact` answers "who is mama?", "Ana de la contabilitate" or "Mișu"
before anything is drafted. It reads the names wazap keeps for a person — the
saved contact name, a business name, the name they give themselves — and what
you filed about them: a `nickname` or `relatie` detail, a tag, and a note that
says nothing but the relationship ("mama"). Case, diacritics and Romanian case
endings do not matter ("Stefan" is Ștefan, "mamei" is mama), a short form finds
the full name ("Mișu" is Mihai) below the name itself, and a group is found by
its name. A relationship word matches only what you filed, never a message and
never a name like "Mama Anei" or "Mamaia Resort". People you talk to more, and
more recently, rank higher. `qualifier` tells two of a name apart: a tag, a
detail, a note, a business or a group they write in ("contabilitate"), or the
last four digits of the number.

The answer is one of three:

- **resolved** — one person or group is clearly meant: `contact.chat_id`, the
  full id to send to, with what matched.
- **ambiguous** — up to five candidates and what tells them apart: when you
  last exchanged messages and in which direction, how many you sent them in 90
  days, groups in common, your note and tags, whether it is a business, and the
  number's last four digits. No candidate carries a full number or a word of any
  message, so the agent has to ask you and look the one you name up again.
- **not_found** — the closest names, if any. For a relationship nobody is filed
  under, the agent is told to ask who it is and file it with
  `remember` (`fields: {"relatie": "mama"}`).

Without `account_id`, every linked account is searched and each candidate says
which account it is on; the answer is resolved only when one account has the
only match. A resolved person also comes with their number and what the user
filed on them (note, tags, details). A number, however it is written
("+40 722 001 111", "0722-001-111"), or an id (a sender's `id` from a message)
is looked up as such: `resolved` with `matched.source` `number` or `id`, or
`not_found` telling the agent to check the number.
A detail's whole value names its person too: filed with `{"caz": "AP-123"}`,
they are what `find_contact({ name: "AP-123" })` resolves to.
`find_contact({ tag: "client" })` lists everyone filed under a tag instead,
each with their `chat_id`, newest conversation first: up to `limit` (50), shared
between the accounts, with `omitted` counting on each account whoever the limit
left out.

### Reading by name

`read_messages` and `search` take `chat_id` as the user says it: "mama",
"Ana Vasile", "Bloc 12", a nickname or a filed detail, resolved by the same
rules as `find_contact`, across every linked account unless `account_id`
names one. Only one chat on one account is read: the answer's `chat_id` is
that chat, `account_id` its account, and `resolved` says whom
(`{ from, name, kind }`), so "what did mama say yesterday" is one call. A
name that fits several chats, or none, reads nothing: it is refused with
`CHAT_NOT_FOUND`, and the error carries `candidates` (up to five, each with
`chat_id`, `name`, `kind` and, over several accounts, `account_id`) for the
agent to ask the user which one. Unlike `find_contact`'s ambiguous answer, the
candidates carry their chat ids, since a read sends nothing; the agent still
asks before reading one. A name tagged `#private` reads as their `chat_id`
does: naming them asks for their words. An id, a phone number and `"status"`
are read as they always were. `send_message` never resolves a name: a
recipient comes from `find_contact` and a preview the user approves.

### Working by tag

What `remember` files shows wherever the person does: `list_chats`, the sender
of a message in `read_messages` and `search`, and `catch_up` carry their `tags`
beside the `note`, so an assistant knows who someone is without asking again.
A tag is also a scope: `list_chats({ tag: "client" })` lists only those
people's chats, newest first, with their unread counts and a cursor, and
`search({ query, tag: "client" })` searches only their direct chats. To file
many people at once, pass `remember` a list:
`remember({ chat_id: ["+40722001111", "+40722002222"], add_tags: ["client"], fields: {"source": "crm"} })`.
A number is enough to reach a person, so another system that knows the number
needs no WhatsApp id.

**Draft context.** A resolved contact also carries what a message to them is
written after: the last 8 messages both ways (each cut to 200 characters,
voice notes as their transcript) and how you write there — language,
diacritics, tu or dumneavoastră, length, emoji — from your own messages in that
chat in the last 90 days, or across the account when there are fewer than five.
The style never counts messages wazap sent, so an agent does not learn its own
drafts back. It is on by default, only in a session that can send, and only for
a resolved contact the account's [send rules](send-rules.md#send-rules) allow. A contact tagged `#private`
(`remember` with `add_tags: ["private"]`) on any linked account gets the style
only, never messages, and a group's context leaves out what they wrote
([Keeping someone private](#keeping-someone-private)). `wazap config draft-context off [--account <id>]` turns it off
for an account (`draft_context: false` in `accounts.json`), the style check
below included, from the next call, without a restart.

**Style check.** A text draft to a person you have written to yourself (not
through wazap) at least five times in 90 days comes back with `style_check`: `warnings` among
`language_mismatch`, `diacritics_mismatch` (with diacritics where you write
without them, or words like „mâine” without them where you use them),
`address_mismatch` (tu where you say dumneavoastră, or the reverse) and
`length_outlier` (over three times your usual longest there, and over 80
characters), with the `basis` it was measured on. What the draft quotes does
not count, nor "doamna" said of someone else, nor a plural spoken to two
people. It never blocks a draft; words you dictated stay as they are.

**The address book.** Names come from the phone. When no contact has a saved
name yet, the first `find_contact` of a server run asks WhatsApp for the
address book, the way `wazap contacts resync` does, and waits up to 15 seconds for it
before answering; finds that arrive meanwhile wait for the same answer. It does
not ask while the connection is still receiving its first sync, nor again
within 7 days of the last ask, the same rule wazap heals a missing address book
by at connect.

### The address book

`list_contacts` lists the phone's address book on one account (`account_id`,
or the default one), for a program that lets you pick people out of it — say,
importing your clients — or an assistant asked who is in it. Each entry:

- `name` — the saved name. wazap keeps three names for a person: this one,
  the one WhatsApp's contact events give (`notify`) and the one they publish
  on their own messages (push name). Only the first makes someone part of this
  list: contact events also name people who only wrote or share a group with
  you, and those carry a push name and no saved name. The saved name comes
  from the address book WhatsApp sends after linking, and from the name the
  history gives a direct chat, which is the saved name or, for someone not
  saved who has a WhatsApp username, that username: wazap cannot tell those
  two apart.
- `phone` — the number in E.164 (`+40721000111`), and `chat_id`, the direct
  chat's id (`40721000111@s.whatsapp.net`) to pass to the other tools. Keep
  `chat_id` as the key of what you import.
- `contact_id` — the number the webhook's message events name them by.
- `last_message` — `{ at, direction }` for the newest message of your direct
  chat with them that is not a notice (a security code that changed, the
  encryption banner), `at` in ISO 8601 with its offset and `direction` `in`
  or `out`, or `null` when wazap holds no such message (a chat whose history
  never reached it counts as none). Never a word of it.

Left out: someone with no number (a privacy id alone), groups, the account
itself, and anyone tagged `#private` on any linked account. Someone you
remove from the phone's address book stays: WhatsApp does not say so.

`order: "recent"` (the default) lists the people you have a direct chat with
first, the latest first, then everyone else in the address book's order;
`order: "address_book"` is that order alone — the order wazap first heard of
each person, which is the order WhatsApp delivered the address book in, after
whoever the history or a message named first. Not an alphabetical one.
`limit` takes up to 500 (100 by default); `total` counts the whole listing and
`next`, passed as `cursor` with the same `account_id` and `order`, gives the
following page, until it is `null`. Every page reads the conversations as they
stood at the first one, so someone who writes to you while the pages come does
not jump ahead of the cursor and get missed; a message deleted meanwhile can
move its person later, so a listing may give someone twice (keep the first by
`chat_id`), and a contact saved meanwhile may wait for the next listing. Who
someone is is not frozen: when the number behind a privacy id becomes known,
two rows become one person, who can move ahead of the cursor and take another
`contact_id`. That happens mostly during the first sync, so a listing begun
before `sync` is `done` is worth reading again.

`address_book_synced` is `false` until the address book itself has reached
wazap. Right after linking the history sync comes first, and it names the
people of your chats; the address book comes through WhatsApp's app state
sync, holds people you never wrote to, and nothing says when it is complete.
So the answer is `true` once someone saved with a name has no chat with you:
a list read while it is `false` holds the people of your chats only, and an
address book whose every contact has a chat with you, or an empty one, never
reads as synced. `get_status` counts the saved names in `contacts_named`; a
list read right after linking is worth reading again once `sync` is `done`
and that count stops growing. It answers from what wazap stores, so it works
while the link is down, and an account that is not linked answers the error
every read gets.

It is a read, so every session that can read gets it, a read-only token and
an assistant included: whoever holds such a session can page through your
whole address book, names and numbers.

### Keeping someone private

Tag a person `#private` (`remember` with `add_tags: ["private"]`) and their
words — a message's text, caption, transcript, quote, a link's or a file's
preview, a poll's text — stay out of what the assistant did not ask about them
by name. A call names them when it gives their chat (`chat_id`), a message of
theirs (`message_id`, to `get_message` or `get_media`), or them as the author
(`search` with `from`); a group named by `chat_id` reads whole, what they wrote
in it included. Everywhere else what is theirs keeps who, when, in which chat
and what kind, and loses the words:

- `catch_up` counts them and never quotes them; their entries say `private`.
- `find_contact`'s draft context carries your style for them, no messages.
- `list_contacts` leaves them out altogether.
- `search` without `chat_id` leaves out their chat and what they write in
  groups before it counts to `limit`, by meaning and by words, and says how
  many in `private_omitted`. A quote of theirs in someone else's message keeps
  who wrote it, not what.
- `wait_for_messages` without `chat_id` still returns what arrived from them,
  in their chat or in a group, with `text: "[private]"` and `private: true`;
  waiting on one chat, theirs or a group's, reads it whole.
- `list_chats` shows the last message of their chat, or the last one they wrote
  in a group, the same way.
- `read_messages` on `"status"` keeps their stories with author, time and kind,
  without text, caption or preview. A story cannot be named, so for now there
  is no way to read one of theirs through the assistant.

The tag goes with the person: filed on one account, it holds in `search`,
`wait_for_messages`, `list_chats`, the stories and `find_contact`'s draft
context of every other account, by number or lid, and in every catch-up. The
[outbound webhook](api-and-webhooks.md#which-chats-are-posted) never posts their
direct chat or a message they wrote in a group, with or without a chat filter.
A `connection` event still goes out: it carries no message content.


## Errors

Every failure is a structured `{ error, message, fix }` rather than a stack
trace, so an agent can decide whether to retry, ask the user, or stop. A
failure thrown without a fix of its own carries the line `learn`'s `errors`
topic gives its code, which holds in any session and for any tool: advice
that fits only one (`file_path`, which a remote session is not shown) is in
that failure's own fix.

| Code | Meaning |
| --- | --- |
| `NOT_LINKED` | No account linked. Call `link_account`, or run `npx wazap-mcp login`. |
| `ALREADY_LINKED` | `link_account` was called on a session that is already linked. Call `get_status`. |
| `SESSION_EXPIRED` | Unlinked from the phone. Run `npx wazap-mcp login`. |
| `SESSION_CORRUPT` | Credentials unreadable. Run `npx wazap-mcp logout` then `login`. |
| `NOT_CONNECTED` | Still connecting or reconnecting, or preparing the account database once after an upgrade. |
| `SYNC_IN_PROGRESS` | History sync has not finished; results may be partial. |
| `INVALID_PHONE` | Number is not in international format. |
| `INVALID_ID` | Not a WhatsApp chat, contact or group id. |
| `NOT_ON_WHATSAPP` | WhatsApp answered that the number has no account. A lookup it did not answer is `NOT_CONNECTED`. |
| `CHAT_NOT_FOUND` / `MESSAGE_NOT_FOUND` / `CONTACT_NOT_FOUND` / `GROUP_NOT_FOUND` | Unknown id; for a chat given by name, a name that fits several chats or none, with their `candidates`. |
| `NOT_A_PARTICIPANT` / `NOT_ADMIN` / `GROUP_ANNOUNCEMENT_ONLY` | Group permissions. |
| `MEDIA_UNAVAILABLE` | WhatsApp expired the file and the phone could not upload it again (offline: retry once it is online; gone: the sender resends), or it was never synced here. |
| `FILE_NOT_FOUND` / `FILE_TOO_LARGE` / `URL_FETCH_FAILED` / `INVALID_IMAGE` | Outbound media problems; `FILE_TOO_LARGE` also for a received file over the 100 MB `get_media` holds in memory. |
| `TEXT_TOO_LONG` | Over WhatsApp's message limit, a group name's 100 characters, or what `remember` keeps for a contact (30 tags, 30 details). |
| `EDIT_WINDOW_EXPIRED` / `RETRACT_WINDOW_EXPIRED` / `NOT_OWN_MESSAGE` | WhatsApp's own limits on editing and deleting: only the account's own messages can be edited; a group admin may also delete anyone's for everyone. |
| `READ_ONLY` | wazap is running read-only. |
| `RATE_LIMITED` | Too many writes, or too many read marks, which have a budget of their own, or media downloads or requests to the phone for expired media; `fix` says how long to wait. |
| `ACCOUNT_RESTRICTED` | WhatsApp restricts or banned the account, and nothing was sent. Do not retry: `get_status` says what and until when under `health`. Under a reachout timelock only a first message to someone never written to is refused; existing chats go on. |
| `DRAFT_NOT_FOUND` / `DRAFT_EXPIRED` | The draft is unknown, from another identity (another session on stdio, another credential on HTTP), sent more than 15 minutes ago, or expired unsent. Draft again. |
| `CHAT_ACTION_NOT_FOUND` / `CHAT_ACTION_EXPIRED` / `CHAT_ACTION_STALE` | Preview absent, foreign, expired or superseded. Preview again and get a new approval. |
| `CHAT_ACTION_OUTCOME_UNKNOWN` | A chat action was attempted; its outcome is unknown. The same confirmation never executes again; inspect state before a new explicit request. |
| `SEND_OUTCOME_UNKNOWN` | The message reached the socket and then the send failed, so WhatsApp may have it. The draft is never sent again; check the chat before drafting anew. |
| `SEND_BLOCKED` | The account's send rules refuse this recipient. `wazap config send` changes them; the agent must not route around. |
| `INVALID_TIME` | `send_at` or `due_at` is unreadable, in the past, under a minute or over 365 days ahead, in a zone that does not exist, or at a time the clocks skip; a scheduled draft's time passed before its yes; or a draft for later replies to or forwards a message on an account that keeps no history. |
| `SCHEDULE_NOT_FOUND` | No scheduled message or reminder with that id on this account. |
| `SCHEDULE_FULL` | The account already holds 100 scheduled messages or 200 reminders waiting. |
| `AMBIGUOUS_ACCOUNT` | More than one account could handle this, or a write named a chat no account knows. Pass `account_id`. |
| `ACCOUNT_NOT_FOUND` | No account with that id. Run `wazap account add`; `get_status` lists the ids. |
| `ACCOUNT_DISABLED` | That account is disabled. Run `wazap account enable <id>`; a running server picks it up. |
| `TIMEOUT` / `WHATSAPP_ERROR` | WhatsApp did not answer, or rejected the operation. |

### Cached remote connectors

Remote HTTP sessions retain unlisted compatibility handlers for catalogues saved
before 1.0. Every fresh `tools/list` advertises only the current tools: historical
aliases do not duplicate search, summaries, files or transcripts in the list.
The SDK still validates the arguments of unlisted compatibility calls, which keep
the same read permissions and rate limits. Refresh the client's catalogue to use
the current names; a client that has not refreshed can keep calling its cached reads.

Remote `learn` (its `workflows` topic), prompts and session instructions prefer the current workflows and
include a short fallback mapping for clients that still only expose the old names.

Compatibility reads use the same account, privacy and filesystem restrictions.
Recent pages are bounded by message count; their opaque cursors last 15 minutes
and recheck current message retention and private tags. A candidate for a reply
is not proof of an obligation, since a call outside WhatsApp may have resolved it.

In the compact presentation, both the text and structured answer omit deleted entries,
empty media and emoji-only text, and group adjacent plain text from one author.
Captioned media, named documents, transcribed voice notes and calls remain;
quotes and other message-specific details stay separate. A group has its source
`message_ids` and `first_timestamp`; `message_id` names its last message.
Each conversation reports `omitted` counts by type. `message_count` remains the
original page budget, `shown_message_count` counts retained source messages, and
`line_count` counts grouped entries. Cursors preserve compact mode. An empty
visible page can still have omitted media and more pages; use a full read for
their contents. The compact text is a transcript: each chat by name and
`chat_id` (and account, when the read covers several), who wrote what, then the
next page's `cursor`, the previews by message_id and the notes. It names no
message's id; the full presentation does.

Photo previews upgrade tiny shipped thumbnails from the original when available,
cache the larger preview, and retain the thumbnail if the original has expired.
Use the media read when the full image is needed to read a document.
