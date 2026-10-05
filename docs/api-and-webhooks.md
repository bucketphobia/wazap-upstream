# The HTTP API and the outbound webhook

For a product driving WhatsApp from its own code rather than an agent: static
bearer tokens in, signed webhook events out.

## Building on wazap (HTTP API for products)

A product that drives WhatsApp from its own code, such as a booking app that
answers its customers, talks to `wazap serve --http` with static bearer tokens
rather than a person signing in. An agent does not need this: it uses a local
client or [OAuth](self-host.md#hosted-agents-oauth).

```bash
WAZAP_READ_TOKEN=$(openssl rand -hex 32) \
WAZAP_WRITE_TOKEN=$(openssl rand -hex 32) \
npx wazap-mcp serve --http --host 127.0.0.1 --port 8766
```

Keep both in `<data-dir>/.env` rather than on a command line. Every request to
`/mcp` carries `Authorization: Bearer <token>`:

- **`WAZAP_READ_TOKEN`** gets the read tools. Without it, and without OAuth,
  `/mcp` answers any process that reaches it: wazap refuses to bind a
  non-loopback address without it, and to serve a port a tunnel points at
  without it or OAuth.
- **`WAZAP_WRITE_TOKEN`** can also unlock the write tools. A leaked read token
  can never message anyone.

A write token is not the same as writes being enabled: when the server or the
account is read-only, even a write-token session has no write tools, and
`get_status` answers `write_tools: false` with the fix (`wazap config writes on`,
then restart). A read token never registers write tools.

Sessions on the same token share an identity; see [Client isolation](self-host.md#client-isolation).
A token never grants host files; see [Host files and remote media](self-host.md#host-files-and-remote-media).
What happens on WhatsApp comes back through the [outbound webhook](#outbound-webhook),
signed, so the product does not poll.

## Outbound webhook

Live events POST to one URL. Off by default. History sync is not posted.
Only `message_received` is posted unless you ask for more, because a consumer
that answers every POST without reading `event` would otherwise answer the
messages its own owner typed on the phone.

The `event` field names one of three. `message_received` is a message another
person sent. `message_sent` is a message this account sent itself, typed on
the phone or on another linked device; a message wazap sent through its own
tools is not announced, so a consumer can never be made to answer itself.
`connection` says the link came up, went down or expired, and carries
`health`: what WhatsApp says about the account itself (`state` ok,
new_chats_capped, reachout_restricted, temporarily_banned, banned,
session_replaced or client_outdated, with `until` and WhatsApp's `reason`).
A restriction that comes or goes while the link stays up is a `connection`
event too, with the same `status`; the pair of status and state is posted
once per change.

Ask for the other two in `WAZAP_WEBHOOK_EVENTS`, comma-separated
(`message_received,connection`), or say `all` for the three of them. Case
does not matter and the spaces around a name are ignored. An unknown name
fails `wazap status`, doctor and setup. An account carries its own list as
`webhook_events` in `accounts.json`.

```bash
npx wazap-mcp config webhook on    # asks for URL + secret (secret is not echoed)
npx wazap-mcp webhook test         # POST a probe event
npx wazap-mcp webhook test --event connection   # needs connection enabled
npx wazap-mcp webhook test --account work
npx wazap-mcp config webhook off
```

On without a URL or secret fails `wazap status`, doctor and setup. A failed
delivery never stops WhatsApp or MCP.

Events wait in an outbox inside the account database, written in the same
transaction as the message they announce, so a restart or a crash loses none.
They are posted one POST at a time per account, each bounded by 10 seconds. A timeout, an unreachable URL, or a `408`, `425`, `429` or `5xx` is
retried after 1 s, 5 s, 30 s and 2 min, then every 5 min, and one last time 24
hours after the event; then it has failed. A new event, or a POST that gets
through, retries at once every waiting event last tried 30 s ago or more, so a
receiver that comes back hears the backlog within moments. Any other `4xx`, such as the `401` of a
receiver whose API key changed, is a refusal: the event is posted once and
fails, and the error names the status with a hint. `WAZAP_WEBHOOK_RETRY_401=on`
is the exception, for a receiver that answers 401 for a moment and then accepts
the same body: a 401 is then retried on the same schedule, for up to a day.
Leave it unset when a 401 means the token is wrong. Either way the failure sets
`webhook.last_error`, which the next delivery clears. An event is posted at
least once: a POST a crash interrupted is sent again, so dedupe on
`message_id`. Turning the webhook off, or dropping an event from
`WAZAP_WEBHOOK_EVENTS`, cancels what waits; nothing is queued while it is off.
With `WAZAP_PERSIST_HISTORY=0` the stored messages are removed at every stop
and start, so a message event still waiting then is cancelled rather than
posted after the restart; connection events still go out.

### Which chats are posted

With neither `WAZAP_WEBHOOK_CHATS` nor `WAZAP_WEBHOOK_TAG` set, every chat is
posted, as before. Set either and a message event is posted only when the chat
matches.

- `WAZAP_WEBHOOK_CHATS` is a comma-separated list of chat ids
  (`15550100@s.whatsapp.net`, `120363000000000001@g.us`) and phone numbers
  (`+15550100`). A number matches that direct chat however WhatsApp spells the
  id, including once the number behind a `@lid` is known.
- `WAZAP_WEBHOOK_TAG` is a contact tag. Direct chats whose contact carries it
  are posted. The tag is the one `remember` stores, so `#autopeloc` and
  `autopeloc` are the same, and adding or removing it takes effect without a
  restart. A pending event for someone just removed is cancelled and not posted.
- A group is posted only when its chat id is in the list. A member's tag does
  not include the group.
- A contact tagged `#private` is never posted while a filter is set, even if
  their chat is listed or they also carry the allow tag. A message they wrote
  in a listed group is left out too. The owner's own messages in that group
  still go. With no filter, `#private` changes nothing.
- An empty filter posts no message events. Set `WAZAP_WEBHOOK_CHATS` to an
  empty value and no tag, or `wazap config webhook chats none` with the tag
  off. `connection` events are not chats, so they still follow
  `WAZAP_WEBHOOK_EVENTS`.

```bash
npx wazap-mcp config webhook chats 15550100@s.whatsapp.net,+15550101
npx wazap-mcp config webhook tag autopeloc
npx wazap-mcp config webhook chats none          # the tag, if set, is the whole filter
npx wazap-mcp config webhook filter off          # every chat again
npx wazap-mcp config webhook tag autopeloc --account work
```

`wazap config` prints the filter. An account's `webhook_chats` or `webhook_tag`
in `accounts.json` replaces the global filter as a whole: setting the tag on
the account does not keep the global chat list. `config webhook off --account
work` clears them with the account's other webhook fields. The chat list and
the tag name are read when the server starts, like the URL. Who carries the
tag is read from the account database at delivery time.

### Several messages, one POST

`WAZAP_WEBHOOK_COALESCE` is a number of seconds, from 1 to 300. Unset, each
message is its own POST. Set, a chat's messages wait until the chat has been
quiet for that long, and are then posted together. A conversation that never
pauses is still posted by twice the window, and never later than 5 minutes
after the first message of the burst. `90` waits 90 seconds of quiet and posts
by 180 seconds. Other chats are not held up, and the messages of one chat stay
in order.

The body of a single message is unchanged. A burst adds fields, and the fields
that were already there name the latest message:

- `count`, how many messages
- `message_ids`, oldest first
- `texts`, each message's preview, oldest first, each cut the way `text` is
- `first_ts` and `first_timestamp`, the first message's time

Dedupe on every id in `message_ids` when it is present, and on `message_id`
otherwise. A retry sends the same burst again. A message that arrives after
that POST has been attempted waits for its own window. The rows survive a
restart, so a burst still open when the process stops is posted by the next
one, once the window or the cap has passed.

```bash
npx wazap-mcp config webhook coalesce 90
npx wazap-mcp config webhook coalesce off
```

An account's `webhook_coalesce` in `accounts.json` wins. `0` turns the wait
off for that account even when the global window is on.

```json
{
  "event": "message_received",
  "from": "15550100",
  "contact_id": 42,
  "phone": "+15550100",
  "chat_id": "15550100@s.whatsapp.net",
  "ts": "2026-09-08T17:01:10+03:00",
  "timestamp": "2026-09-08T14:01:10.000Z",
  "text": "the latest line",
  "truncated": false,
  "kind": "text",
  "from_me": false,
  "is_self_chat": false,
  "message_id": "false_15550100@s.whatsapp.net_3EB0…c",
  "account_id": "default",
  "account_name": "default",
  "count": 3,
  "message_ids": [
    "false_15550100@s.whatsapp.net_3EB0…a",
    "false_15550100@s.whatsapp.net_3EB0…b",
    "false_15550100@s.whatsapp.net_3EB0…c"
  ],
  "texts": ["first line", "second line", "the latest line"],
  "first_ts": "2026-09-08T17:00:00+03:00",
  "first_timestamp": "2026-09-08T14:00:00.000Z"
}
```

A message event is built when it is posted, from the message as it is then: an
edit or a transcript that arrived in the meantime goes with it, and a message
deleted, expired or cleared first is not posted at all.

Redirects are never followed. Response bodies are cancelled without being read,
including successful ones. Diagnostics retain the destination host, status and
failure category, not URL paths/queries, response bodies or transport exception
excerpts. URL query tokens remain supported, but userinfo credentials and
fragments are refused. Webhook and transcription destinations are trusted
operator configuration, not agent-supplied public-media URLs: configure only
receivers allowed to see this account's data.

`get_status` counts the outbox's events in `webhook.delivery`: `delivered`
(kept 7 days), `failed` and `cancelled` (kept 30 days; a retried event that
never got through counts once), `pending`, `dropped` (events the account
database could not store), `consecutive_failures`, `retrying` (failed POSTs of
the oldest waiting event), `last_success_at`, `last_failure_at`,
`last_failure`, `last_status`, `last_dropped_at` and `oldest_pending_at`.
`wazap status` and doctor read the same outbox read-only, whether or not the
server runs: three failed events in a row, or an oldest waiting event still
retried 10 minutes after it was queued, fail the webhook check with the fix;
one failure since the last delivery, or an event retried for less, warns; the check passes again with the
next delivery. `webhook test` posts its probe directly, not through the
outbox, and does not change the counters. The log says the first failure of a
run, a count every 100 failures, and one line when delivery comes back, not a
line per event.

An account may set `webhook_url`,
`webhook_secret`, `webhook_events`, `webhook_auth`, `webhook_chats`,
`webhook_tag`, `webhook_coalesce` and `webhook_retry_401` in `accounts.json`.
The URL, secret, event list, auth header, coalescing window and 401 retry each
win over the global value. `webhook_chats` or `webhook_tag` replaces the global
filter as a whole. `config webhook off --account work` clears all of them.

`webhook test --event <name>` posts nothing and exits non-zero when that
event is not enabled, and says what to enable it with. While the webhook is
on, `wazap config` prints the events it posts on an `events:` line.

HMAC: `X-Wazap-Signature` is `sha256=<hex>`, HMAC-SHA256 of the exact raw
JSON body with the secret that signed it. Verify that raw body, not a
re-serialized object. HTTPS only, except `http://` on loopback. A service that
wants a header of its own, such as `Authorization: Bearer …`, gets it from
`WAZAP_WEBHOOK_AUTH`; see
[A receiver that wants its own header](#a-receiver-that-wants-its-own-header).

### A receiver that wants its own header

Cursor Automations, n8n and most hosted webhooks accept a POST only with a
header of their own, usually `Authorization: Bearer …`. wazap sends it beside its
signature once you set it:

```bash
npx wazap-mcp config webhook auth      # asks for it; it is not echoed
npx wazap-mcp webhook test
npx wazap-mcp config webhook no-auth   # back to the signature alone
```

Type `Bearer <token>`, or any other value, and it goes out as
`Authorization: Bearer <token>`. Type `X-Api-Key: <key>`, a header name, a
colon and the value, and it goes out as that header instead. It is stored in
`.env` as `WAZAP_WEBHOOK_AUTH`, or with `--account work` as that account's
`webhook_auth` in `accounts.json`, which wins over the global one. It is never a
command-line argument, and it never appears in `wazap status`, a log line or an
error; `wazap config` shows the header's name and a masked value. The headers
wazap sets itself (`Content-Type`, `User-Agent`, `X-Wazap-Event`,
`X-Wazap-Signature`) cannot be replaced, and `X-Wazap-Signature` is still sent,
so a receiver that can check it still should.

A `401` from the service, which is what a revoked token gives, fails the event at
once and `wazap status` names it; `config webhook auth` with the new token puts
it right. A receiver that answers 401 and then accepts the same request can
instead set `WAZAP_WEBHOOK_RETRY_401=on` (`wazap config webhook retry-401 on`),
and that 401 is retried like a 5xx. A wrong token then keeps being tried for
up to a day, so leave it off unless you have seen the 401 come and go.

#### Or a bridge on your own machine

When the service wants more than a header, or its token should not live in
wazap's data directory, a small receiver on your own machine can sit in between:
it checks the signature wazap put on the event, then passes the same body on with
what the service wants. This one needs nothing installed beyond Node.

```js
// webhook-bridge.mjs — TARGET=https://… TARGET_TOKEN=… WAZAP_WEBHOOK_SECRET=… node webhook-bridge.mjs
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const { TARGET, TARGET_TOKEN, WAZAP_WEBHOOK_SECRET, PORT = "8801" } = process.env;
if (!TARGET || !TARGET_TOKEN || !WAZAP_WEBHOOK_SECRET) throw new Error("set TARGET, TARGET_TOKEN and WAZAP_WEBHOOK_SECRET");

const sign = (body) => `sha256=${createHmac("sha256", WAZAP_WEBHOOK_SECRET).update(body).digest("hex")}`;
const signedByWazap = (given = "", body) => {
  const want = Buffer.from(sign(body));
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got);
};

createServer(async (req, res) => {
  if (req.method !== "POST") return void res.writeHead(405).end();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  // Only wazap holds the secret, so anything else that reaches this port is refused.
  if (!signedByWazap(req.headers["x-wazap-signature"], body)) return void res.writeHead(401).end();
  try {
    const upstream = await fetch(TARGET, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TARGET_TOKEN}`,
        "x-wazap-event": req.headers["x-wazap-event"] ?? "",
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(8000), // wazap gives up on a POST after 10 s
    });
    res.writeHead(upstream.status).end(); // the service's verdict is wazap's: 5xx is retried, another 4xx is a refusal
  } catch {
    res.writeHead(502).end(); // unreachable or too slow: wazap retries it
  }
}).listen(Number(PORT), "127.0.0.1");
```

Point wazap at it, with the same secret the script reads. `http://` is accepted
here because the address is loopback:

```bash
npx wazap-mcp config webhook on   # URL http://127.0.0.1:8801, and the secret
npx wazap-mcp webhook test
```

A `401` from the service, which is what a revoked token gives, comes back to
wazap as a `401`: the event fails at once and `wazap status` names it, as it
would for any receiver that refuses. Keep the service's token in the
environment of the script, not in the URL, and remember that
the service now receives your WhatsApp messages: give it only to receivers you
trust.

`contact_id` is the sender's contact in the account database: the same number
for the same person however WhatsApp spells their id, including after the
number behind a `@lid` becomes known. `phone` is the sender's number in E.164
(`+15550100`), or `null` while WhatsApp has not revealed it; `from` keeps its
old form. For `message_sent` both name the account itself.

`text` is a preview, cut at 2000 characters and ending in a single `…`.
`truncated` is true when it was cut. For `kind: "audio"`, `text` is the
transcription when wazap auto-transcribed the note itself, which it does for
incoming notes only; the event waits up to 60 seconds for those words, a
restart included, and goes at once when the transcription fails or the
provider is paused. In
every other case `text` is the `[voice message · 0:42]` placeholder: a note
you recorded yourself, a note longer than 600 seconds, a note WhatsApp stated
no duration for, and a transcription that failed every attempt or did not
finish within the 60 seconds. `ts` is the original local
time with a numeric offset, kept for consumers already reading it, and
`timestamp` is the same instant in UTC.

Within a chat, events arrive in the order wazap queued them: nothing of a chat
is posted while an older event of that chat waits for its transcript or its
next retry. Across chats there is no order: a chat whose event is retried, or
a voice note waiting for its words, holds back no other chat. `connection`
events keep their own order. Delivery is at least once, so dedupe on
`message_id`, and order by `timestamp` when it matters, since WhatsApp itself
can deliver a message late.

A message another person sent:

```json
{
  "event": "message_received",
  "from": "15550100",
  "contact_id": 42,
  "phone": "+15550100",
  "chat_id": "15550100@s.whatsapp.net",
  "ts": "2026-09-08T17:00:00+03:00",
  "timestamp": "2026-09-08T14:00:00.000Z",
  "text": "hello, or a preview of something longer",
  "truncated": false,
  "kind": "text",
  "from_me": false,
  "is_self_chat": false,
  "message_id": "false_15550100@s.whatsapp.net_3EB0…",
  "account_id": "default",
  "account_name": "default"
}
```

A message sent from the phone, here in the "Message yourself" chat:

```json
{
  "event": "message_sent",
  "from": "15551234",
  "contact_id": 1,
  "phone": "+15551234",
  "chat_id": "15551234@s.whatsapp.net",
  "ts": "2026-09-08T17:04:12+03:00",
  "timestamp": "2026-09-08T14:04:12.000Z",
  "text": "call the notary at 14:00 on Wednesday",
  "truncated": false,
  "kind": "text",
  "from_me": true,
  "is_self_chat": true,
  "message_id": "true_15551234@s.whatsapp.net_3EB0…",
  "account_id": "default",
  "account_name": "default"
}
```

A connection change. `status` is `linked`, `disconnected` or `expired`;
`not_linked`, `linking` and `connecting` post nothing, and two changes that
mean the same status post once.

```json
{
  "event": "connection",
  "status": "expired",
  "timestamp": "2026-09-08T14:10:00.000Z",
  "account_id": "default",
  "account_name": "default"
}
```

`connection` reports what the socket does while wazap is running. A clean
shutdown posts nothing, and a crash posts nothing either, so silence does not
mean the link is up. Poll `get_status` when you need to know that. A
`connection` event the receiver did not take is retried like any other, until
a newer change is queued behind it: then it is cancelled, so after an outage
the receiver hears the current status once, not every flap.
