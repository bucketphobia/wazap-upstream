# The tools

What each of the 21 tools answers, the workflows behind them, and every error
code. The [README](../README.md#the-21-tools) has the one-line table.

## The 21 tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `learn` | read | The guide to every tool, id format and error code, as text. Call it first. |
| `get_status` | read | Connection status, sync state, linked account, how fresh the history is, webhook delivery, versions, data dir, and `health`: what WhatsApp says about the account itself (a reachout timelock, a ban, a session taken over, its cap on first messages to new people), with until when. Top-level fields are the default account; `accounts` lists every configured one and `default` names it. `include_picture: true` adds `picture_url`, the account's own profile photo (a WhatsApp link that expires; `null` when there is none or it cannot be read). Optional `account_id` on this and every other tool. |
| `link_account` | read | Pair an account that already exists (`wazap account add`). Returns the code to type into the phone. Registered in read-only mode too. |
| `list_chats` | read | Conversations newest-first; filter `all`/`unread`/`groups`/`individual`/`archived`. `include_pictures: true` adds `picture_url` per chat (a link that expires; none for `#private`). |
| `read_messages` | read | Messages in a chat; `before` pages further back, pulling older history from the phone; `types` narrows to one or more message types, e.g. `["call"]`; `include_previews` attaches a small image of each photo. `chat_id: "status"` reads the stories of the last `hours`, which show nowhere else. |
| `catch_up` | read | What the user missed, in one call and within a token budget, across every linked account: who is waiting on a reply, mentions, replies and open polls, missed calls, people, groups condensed, stories. Pages with a cursor. See [Catching up](#catching-up). |
| `search` | read | Messages by meaning and by words at once, over everything the account keeps, so a paraphrase or another language still hits; `match: "words"` keeps only messages holding the words. `chat_id`, `since`, `until` and `from` narrow it, and the answer says how much it searched. Without `chat_id`, someone tagged `#private` is left out and counted in `private_omitted`. Without [semantic recall](recall.md#semantic-recall) it matches words and says so. |
| `get_message` | read | One message in full, with its quoted message, each reaction with who left it, and who voted for each option of a poll or answered an event. On your own messages, `delivery` says whether it was sent, delivered, read or played, and in a group who read it and when. |
| `find_contact` | read | Who a name, nickname, relationship ("mama"), group name, number or id means. Resolved: the `chat_id`, number, note, tags and details, plus the recent exchange and how you write there in a session that can send. Otherwise the candidates that tell people apart, to ask you. `tag` lists everyone filed under a tag. See [Finding people](#finding-people). |
| `list_contacts` | read | The phone's address book on one account, a page at a time (up to 500, `next` as `cursor`): each person's saved name, number in E.164, `chat_id`, `contact_id`, and when the last direct message was and which way it went. `order: "recent"` (default) puts whoever you talked to last first; `address_book` keeps the phone's order. No message words. See [The address book](#the-address-book). |
| `get_group_info` | read | Participants, admins, announcement mode, who may edit the info or add members, join approval, disappearing messages, community, invite link (when you are admin). |
| `get_media` | read | A message's media: a voice note or audio as its transcript, a photo attached as an image, any file saved to disk (`save_to` picks the directory). Transcription runs on the local or the API provider; with `save_to` a recording comes as its file, with a transcript only if one was already made, and when no transcript can be made the file comes instead, with `transcript_unavailable` saying why. |
| `wait_for_messages` | read | Block up to 55 s until a message arrives, then return it with a cursor for the next call. `addressed_to_me` wakes only for direct messages, @-mentions and replies. |
| `remember` | local | Keep what the user says about a person, on this machine only: a note, tags, details (`relatie`, `nickname`, "role": "contabil") that `find_contact` matches, and `handled: true` to take an ask off `catch_up`'s waiting list until they write again. `#private` keeps their words out of what the assistant did not ask about them by name ([Keeping someone private](#keeping-someone-private)). Nothing changes on WhatsApp. |
| `send_message` | write | Draft a message: text (a reply, @-mentions), media from a path or URL (`as`: document, voice note or GIF), a poll (`options`), a location (`latitude`, `longitude`) or a forward (`forward`). Does not send. A text draft to someone you write to often carries `style_check`: where it does not read like you. |
| `confirm_send` | write | Send a draft after the user has seen the preview and said yes. A draft is sent at most once; see [Sending once](#sending-once). |
| `edit_message` | write | Edit your own message, within WhatsApp's 15-minute window. |
| `react_to_message` | write | Add or remove an emoji reaction. |
| `delete_message` | write | `for_everyone: true` retracts your own message, within WhatsApp's 2-day window, and in a group where you are admin someone else's message too. `for_everyone: false` deletes any message for the linked account only, at any age. |
| `manage_chat` | write | Archive, pin, mute (8h by default), mark read/unread; pin a message for everyone (24h, 7 days or 30 days) or star it; clear or delete the chat for the linked account; block or unblock a person. |
| `manage_group` | write | Create a group; join one from an invite link or message (without `confirm: true` it only shows the group); add, remove, promote, demote, leave, rename, set or remove the group photo, invite links, list, approve or reject join requests, and change the settings. Every member sees a change at once. |

### Sending once

Nothing reaches WhatsApp until `confirm_send`, and a draft goes out at most
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

### Catching up

`catch_up` answers "what did I miss?" in one call. It reads the account
database only — no network, except the cached member list of at most a dozen
groups, fetched within a second — and fits its answer into `budget_tokens`
(2,500 by default, 500 to 8,000), one line per entry, in this order:

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
small JPEG of each photo as an image block, newest first, up to 12 per call,
and labels each message line with the preview it belongs to, so a catch-up can
say "a photo of a receipt" without a download. WhatsApp used to ship such a
preview inside every image message and in 2026 almost never does, so when
none is there wazap downloads the photo once, shrinks it to 320 px on this
machine with pure JavaScript, and keeps the result as a file under
`previews/` in the data directory, so a restart does not redo it. A video gets
one frame, taken by ffmpeg a second in, when ffmpeg is installed. The first
call over a day of photos takes a few seconds; the next is instant.

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
`find_contact({ tag: "client" })` lists everyone filed under a tag instead,
each with their `chat_id`: up to `limit` (50), shared between the accounts, with
`omitted` counting on each account whoever the limit left out.

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
trace, so an agent can decide whether to retry, ask the user, or stop.

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
| `CHAT_NOT_FOUND` / `MESSAGE_NOT_FOUND` / `CONTACT_NOT_FOUND` / `GROUP_NOT_FOUND` | Unknown id. |
| `NOT_A_PARTICIPANT` / `NOT_ADMIN` / `GROUP_ANNOUNCEMENT_ONLY` | Group permissions. |
| `MEDIA_UNAVAILABLE` | WhatsApp expired the file, or it was never synced here. |
| `FILE_NOT_FOUND` / `FILE_TOO_LARGE` / `URL_FETCH_FAILED` / `INVALID_IMAGE` | Outbound media problems. |
| `TEXT_TOO_LONG` | Over WhatsApp's message limit. |
| `EDIT_WINDOW_EXPIRED` / `RETRACT_WINDOW_EXPIRED` / `NOT_OWN_MESSAGE` | WhatsApp's own limits on editing and deleting. |
| `READ_ONLY` | wazap is running read-only. |
| `RATE_LIMITED` | Too many writes, or too many read marks, which have a budget of their own; `fix` says how long to wait. |
| `ACCOUNT_RESTRICTED` | WhatsApp restricts or banned the account, and nothing was sent. Do not retry: `get_status` says what and until when under `health`. Under a reachout timelock only a first message to someone never written to is refused; existing chats go on. |
| `DRAFT_NOT_FOUND` / `DRAFT_EXPIRED` | The draft is unknown, from another identity (another session on stdio, another credential on HTTP), sent more than 15 minutes ago, or expired unsent. Draft again. |
| `SEND_OUTCOME_UNKNOWN` | The message reached the socket and then the send failed, so WhatsApp may have it. The draft is never sent again; check the chat before drafting anew. |
| `SEND_BLOCKED` | The account's send rules refuse this recipient. `wazap config send` changes them; the agent must not route around. |
| `AMBIGUOUS_ACCOUNT` | More than one account could handle this, or a write named a chat no account knows. Pass `account_id`. |
| `ACCOUNT_NOT_FOUND` | No account with that id. Run `wazap account add`; `get_status` lists the ids. |
| `ACCOUNT_DISABLED` | That account is disabled. Run `wazap account enable <id>`; a running server picks it up. |
| `TIMEOUT` / `WHATSAPP_ERROR` | WhatsApp did not answer, or rejected the operation. |
