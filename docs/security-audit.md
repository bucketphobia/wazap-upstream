# Security audit: client isolation, network boundaries and retention

This is a scoped source review and local regression test effort, not a complete
security audit or a production penetration test. WhatsApp is stubbed; no messages
were sent to the linked account, and no public listener was exposed.

## 1. HTTP session ownership — fixed

Previously each request was authenticated, but its `mcp-session-id` selected a
transport without checking the credential that initialized it. A read token,
another write token, or an anonymous reader (when enabled) could use a write
session if it obtained its id. GET and DELETE were affected too. The tests do
not demonstrate a way to steal a session id.

Sessions now bind to a SHA-256 fingerprint of the exact bearer credential and
its effective read/write permission. Foreign credentials receive 404 and cannot
touch the session's idle timeout or transport. Every request still authenticates:
expired/revoked tokens receive 401. OAuth token rotation requires reinitializing.
The session registry and lifecycle live in `src/http-sessions.ts`.

Regression tests: `test/session-isolation.test.mjs`, `test/oauth.test.mjs`, and
existing lifecycle tests in `test/daemon.test.mjs`. Ten of the eleven initial
static-token regression cases failed before the fix.

## 2. Cross-client draft confirmation — fixed

Previously any write client could confirm an account's draft given its id,
even from its own independently authenticated session. The same flaw reproduced
through two actual stdio bridge processes attached to a stub daemon. All ten
initial draft isolation regression cases failed before the fix.

Each `registerTools` invocation keeps one draft identity, kept server-side.
On the local channels — stdio servers, the daemon's own credential, anonymous
sessions — it is an opaque id minted per registration. On the remote endpoint
it is the credential's stable identity: a static token's, or the OAuth client
the grant belongs to — so an async confirm over a reinitialized HTTP connection
still reaches the draft, and an OAuth access-token rotation does not strand it.
Every outgoing draft records that identity and its resolved account. Before
account resolution or send-policy lookup, `confirm_send` checks ownership and
rejects a conflicting explicit account. Foreign and unknown draft ids return
`DRAFT_NOT_FOUND` without revealing the recipient/policy or consuming the draft.
An owned draft is resolved through its recorded account, not caller-provided
routing hints. Existing live allow/deny checks still run before sending.

The scope is deliberately **authenticated identity**, not connection:

- Text, media, polls, locations and forwards all use the same ownership path.
- Each stdio server and each bridge upstream session still has a distinct
  identity; a new initialize there requires a new draft.
- A remote credential is itself a shared identity: all of its sessions — after
  eviction, reconnect or OAuth rotation — own the same drafts.
- Failed sends remain retryable by the owner identity according to the existing
  service behavior. Ownership does not extend the service's 15-minute expiry.
- A confirmed draft keeps its owner record as long as its send record, so
  another identity's replay is still rejected while the owner hears the receipt.

`src/tool-runtime.ts` now owns tool registration/execution, annotations, account
routing, error conversion and process-wide per-tool rate buckets. It is created
once for the tool catalogue; reinitializing does not reset the rate budget.
`src/tools.ts` retains the schemas and handlers, exporting the existing public
registration and error helper names for compatibility.

Tests in `test/draft-isolation.test.mjs` exercise all five draft kinds, explicit
account overrides, service-created unowned drafts, retries, expiry, replay,
independent HTTP sessions (same and different tokens), new versus resumed
sessions, two real stdio bridge subprocesses, and shared rate budgets. All use
local fixtures; outbound WhatsApp operations are stubbed.

## 3. HTTP/OAuth logs and media errors — hardened

The first HTTP regression run reproduced query-string logging and arbitrary
filesystem access (seven of eight initial cases failed). `req.originalUrl`
previously exposed OAuth state/query values; raw RPC/Accept fields could inject
log text. Express's default error handler could also print malformed JSON body
excerpts. These are now handled by `src/http-log.ts`: allowlisted route/RPC names,
normalized Accept formats, bounded printable labels, and generic parser errors.
The same rules apply when a client closes before a response. Arbitrary route
paths are logged as `/other`; their contents never enter the log.

OAuth registration/consent labels are sanitized, and unreadable OAuth state no
longer prints JSON parser excerpts. Media-fetch failures no longer include signed
URLs or arbitrary resolver/request error details. HTTP status and timeout remain
useful diagnostics. User-Agent and OAuth client labels remain diagnostic metadata:
control-character filtering does not remove secrets deliberately placed in them.
This is not a guarantee that every third-party dependency or proxy log is safe.

## 4. Remote filesystem access — restricted

An HTTP write token previously allowed selecting any local file as outgoing
media or a profile/group picture; even read clients could choose an arbitrary
`save_to` directory (then `download_media`, `get_media` since 1.0). Tests use a synthetic private file and stub
WhatsApp operations to demonstrate access without transmitting anything.

HTTP sessions now reject `file_path` and `save_to` before account lookup or any
filesystem call. This applies to static tokens and OAuth, even when the peer is
loopback. Public URLs, forwarding, and default-directory downloads remain
available. Remote tools advertise this restriction. No public setting or tool
argument overrides it.

Local stdio retains intentional file access. The generated private daemon token
is explicitly marked with a local-files capability so stdio bridges keep working;
public read/write tokens and OAuth grants never inherit it. This private token
must not be distributed to remote clients. Its file capability participates in
session ownership along with read/write permission and credential identity.

The existing SSRF protections passed added tests for alternate loopback forms,
mixed public/private DNS answers, pinned socket lookup and chunked size caps.
Existing redirect/private-peer tests also pass. Untrusted MIME subtypes are now
restricted to a short alphanumeric download extension; previously backslashes
could enter generated filenames (path separators on Windows). Tests reproduce
that filename issue, not a live Windows exploit.

## 5. Cross-account write preflight — hardened

A write-enabled account makes write tools visible for the session. The final
WhatsApp write gate already rejected a read-only target account, but draft
creation and some media preflight work ran before that check. This pass does
**not** demonstrate unauthorized WhatsApp transmission from a read-only account.

`src/tool-runtime.ts` now checks the resolved account's configured/effective
read-only policy before executing any write handler. An implicit chat match
cannot borrow another account's write permission. An owned draft is not consumed
while its account is read-only. Existing account resolution, disabled-account
checks, and service-level write gates remain in place. This does not implement
live policy reload or per-client account ACLs.

Tests cover all non-confirm write registrations with operation traps, actual
stub-backed service preflight, implicit routing, retained reads and owned draft
confirmation. The effective-policy change in the confirmation test is a test
fixture, not a promise that editing config on disk is applied without restart.

## 6. OAuth proxy identity and audience — hardened

Previously all loopback, link-local and private peers were treated as trusted
proxies. A separate `CF-Connecting-IP` fallback could also select the password
lockout identity independently of Express's rate limiter. Header-only tests
reproduced rotating lockout identities; no live tunnel was attacked.

`WAZAP_TRUST_PROXY` now names only trusted proxy IPs/CIDRs (default loopback;
`none` disables forwarded identity). Broad automatic private-network trust and
the CF-header fallback are removed. All limiters derive identity from Express's
configured X-Forwarded-For chain. Tests cover ignored headers with no trusted
proxy, CF-only spoofing, a chain ending in an untrusted private client, and a
legitimate local proxy separating two public callers. Input validation is in
`src/proxy-trust.ts` and the setting is documented in `.env.example`.

Deployment requirement: the trusted ingress must sanitize or replace untrusted
forwarded headers and name its actual peer. Trusting a loopback proxy does not
magically make a client-provided header truthful. Docker proxies not on loopback
need their explicit address; CF-only deployments must provide a trusted XFF
chain or accept a shared proxy identity. No deployed configuration was changed.

OAuth now rejects a supplied resource different from its configured `/mcp` URL
at authorization, code exchange and refresh; omission stays compatible with
older clients. A refresh asking for scopes beyond the grant is narrowed to the
grant, as before; one with nothing in the grant is rejected. (This pass first
rejected any ungranted scope; see "Pre-release review" below.)
Access tokens now expire at, rather than just after, the exact expiry instant.

Additional tests confirm existing client binding for codes/refresh tokens,
redirect mismatch rejection without consuming the valid code, revocation by a
foreign client leaving the grant intact, and metadata independent of forwarded
Host/scheme. Nine initial regression tests failed before this step's fixes.

## 7. Webhooks and transcription endpoints — hardened

A local two-listener regression reproduced OpenAI-compatible transcription
following 301/302/303/307/308 redirects to another endpoint. In particular,
307/308 preserve the multipart upload; cross-origin fetch normally strips
Authorization, so this is not a claim that every redirect leaks the API key.
Transcription now refuses all redirects, including same-origin ones. Operators
must configure the final base endpoint. These URLs are trusted operator
configuration, not arbitrary media URLs supplied by MCP clients, and intentionally
support local/private providers. The public-media SSRF policy is not applied to
them.

Provider error excerpts and transport exception messages could carry private
content or secret-bearing URLs even after literal API-key redaction. Errors now
retain only status/category/fix. Successful JSON is bounded to 1 MiB of actual
streamed bytes, independently of Content-Length, and malformed/absent text is a
typed, generic failure. Null JSON previously escaped as a TypeError. Response
reading/cancellation is isolated in `src/http-response.ts`; ignored error bodies
are cancelled rather than buffered. Existing one-retry behavior and request
timeouts remain in place.

Webhook redirects were already refused. Webhook responses are now cancelled on
success as well as failure to release unread streams; retries, HMAC signing and
queue limits remain unchanged. Generic transport/build failures no longer echo
raw exception text into logs, status or persisted failure counters. Host/status
remain available for diagnosis. URL validators no longer quote invalid input;
userinfo credentials and fragments are rejected. Webhook query tokens remain
supported, whereas transcription base URLs reject queries because appending the
API path to a query-bearing base is ambiguous. Transcription readiness shows the
host rather than the full potentially secret-bearing path.

## 8. Automatic previews and decoder subprocesses — hardened

Baileys implicitly fetches a page and potentially its thumbnail when generating
text messages, even with `generateHighQualityLinkPreview: false`. This bypasses
wazap's `safe-media` path and uses dependency-specific network/logging behavior.
A stub callback in the real Baileys message generator reproduced invocation for
send, confirm and edit, without making external requests. The fix passes
`linkPreview: null`, disabling new previews; since link previews were removed
(section 9), that explicit null is again the whole behavior. Forwarding may
retain an already embedded preview without a new page fetch. This test proves an
implicit network-capable code path, not a live SSRF exploit.

`src/media-process.ts` centralizes ffmpeg input restrictions for video previews,
GIF conversion and local transcription: only the file protocol and an explicit
media-demuxer allowlist, excluding playlists/image sequences. GIF conversion
forces the GIF demuxer. Raw decoder stderr/JSON-parser excerpts are omitted from
errors. Outgoing video thumbnails use the same restricted preview path and
explicitly suppress Baileys's shell-spawned, unrestricted ffmpeg fallback, even
when no frame can be made.

Tests inspect actual child-process arguments using synthetic executables and
exercise real ffmpeg on generated video/audio and malicious playlist fixtures.
Those playlist fixtures were already rejected by this machine's ffmpeg before
the change; this restriction is defense in depth, not a demonstrated local-file
exfiltration fix. The allowlist is not an OS-level sandbox or a guarantee against
codec vulnerabilities, all secondary local-file references, or resource abuse.
Photo decoding remains local with its existing resolution/memory limits.

Twenty-four of the initial thirty-one network/preview regression cases failed
before the fixes. Additional tests cover understated Content-Length, real regular
media compatibility and the no-thumbnail fallback through Baileys's actual media
preparation with a stub uploader. No audio, messages or credentials from the real
account were used. Model downloads were inspected as a separate CLI-operated
path with curated upstream URLs and no account payload/API credential; their
CDN redirects remain intentionally enabled.

## 9. Controlled link previews — removed

For a while, `src/link-preview.ts` fetched the first explicit HTTP(S) link in
sent or edited text through `publicMedia`, with bounded page and JPEG thumbnail
fetches. It was removed before 1.0: the server no longer fetches anything for a
text send, confirm or edit, so none of that network path remains to defend.

The dependency's own fetcher stays disabled. Both call sites pass
`linkPreview: null` explicitly, because an omitted field lets Baileys fetch the
page itself with its unrestricted helper (section 8). A confirmed draft is built
without Baileys's URL-info callback, so it cannot fetch either.
`test/preview-security.test.mjs` runs send, confirm and edit through Baileys's
real message generator with a counting fetcher and checks that the field is
present, null, and that nothing was fetched.

## 10. Model download streams and write lifecycle — hardened

The shared model downloader previously checked size only after consuming and
writing the entire response. Synthetic oversized streams reproduced unbounded
progress beyond the pinned model size. Injected disk failures under backpressure
could terminate the process with an unhandled stream error or leave it waiting
for a drain that would never arrive. A final write error could also be swallowed
by the completion handler. No real disk was filled and no model was downloaded
from an external service for these reproducers.

The implementation now lives in `src/model-download.ts`. Whisper's model table
keeps compatibility exports; embedding downloads import the shared helper
without loading transcription providers and retain their `RECALL_FAILED` code
and command-specific fix. The model tables, URLs and pinned digests are unchanged.

- A transform checks each chunk against the remaining expected bytes before
  forwarding it to the file writer; progress cannot exceed that size.
- Oversized/invalid Content-Length is rejected early, but actual streamed bytes
  are always counted independently. Identity encoding is requested; compressed
  responses are refused. A 206 must match the complete expected range, including
  start, end and total, even on an unsolicited partial response.
- `pipeline` owns backpressure, stream errors and closure. Publication by rename
  occurs only after pipeline success, exact byte count and SHA-256 verification.
- The network/write phase has a 30-second idle deadline, including
  response-header waits, and a total deadline of 30 minutes or the model's size
  at 100 KiB/s, whichever is longer: a fixed 30 minutes cut off a steady 1 GB
  download on a slow link. Caller cancellation also applies
  during local prefix/cache hashing. Timers and abort listeners are cleaned up.
- Interruptions/timeouts keep a bounded prefix; invalid ranges, 416, overflow
  and verification mismatches remove the partial file. A server ignoring Range
  restarts cleanly. Unused responses are cancelled on failure.
- Errors retain HTTP status, controlled categories and allowlisted disk error
  codes, never raw reason phrases, Content-Range values, signed URL exceptions
  or caller abort reasons. Invalid options/pre-aborted calls fail before changing
  files or making requests; directories are not mistaken for absent files.

All 20 initial regression cases failed on the old implementation; additional
coverage brings this step to 34 tests in `test/model-download.test.mjs`. They cover
fresh/resumed overflow, dishonest lengths/ranges, prefix reuse after cancellation,
header/body/active-transfer timeouts, child-isolated ENOSPC/EACCES/final EIO
injection, encoding refusal, callbacks, CDN redirect compatibility, and embedding
error mapping. Existing verification/cache/resume tests also pass.

Scope: this bounds each invocation's writes and coordinates its streams. The
cross-process follow-up is below. Filesystem crash durability and protection from
hostile-local file replacement remain outside this pass. Local hashing before
the transfer uses caller cancellation, not the network timer.

## 11. Concurrent model downloads — coordinated

`src/model-download-lock.ts` acquires an atomic, per-destination lock directory
before reading a cache hit, deleting an invalid model, hashing/resuming a partial
file or making HTTP requests. The downloader uses the canonical parent directory
for both the lock and model I/O, so relative and directory-symlink aliases cannot
bypass exclusion. Another caller fails promptly rather than joining an unbounded
queue. Different destination files remain independent.

The directory contains one uniquely named ownership record, with a PID, start
time and host/PID scope but no request URL or credentials. Linux scope includes
the PID namespace; unavailable namespace identity disables automatic reclamation.
Directory/file creation modes are 0700/0600. Release is idempotent and happens
after stream cancellation/closure and invalid-part cleanup, including cached
hits, errors and caller cancellation. Embedding error mapping preserves lock
recovery instructions rather than replacing them with a generic retry command.

There is no age-based lease expiry. A live or inconclusively probed PID (including
EPERM) is never evicted. For a known dead owner in the same scope, successful
unlink of that generation's unique ownership filename grants the right to remove
the now-empty directory. Among competing reclaimers, only one unlink can succeed;
losers never remove the directory. An old releaser also cannot unlink a successor's
record. Cleanup is never recursive and a symlink at the lock path is not followed.

Unknown/empty/malformed/foreign-scope claims fail closed. A crash between lock
creation and record writing, or between record removal and directory removal,
can require manual recovery. Operators must confirm no downloader is using the
model before removing only its lock directory. PID reuse may conservatively
require a retry/manual check. These are cooperative, same-host locks, not a
distributed-filesystem protocol or protection against another local process that
can maliciously alter the data directory; pre-upgrade downloaders must be stopped.

Nine of eleven initial lock regression cases failed before implementation.
`test/model-download-lock.test.mjs` now has 19 cases, including real child-process
contention, killed-owner recovery with multiple contenders, distinct destinations,
path aliases, stale timestamps, private records, ambiguous owners, inconclusive
PID probes, idempotent/foreign cleanup, and embedding error guidance. The workers
use synthetic IPC-controlled fetch streams, not live HTTP or model services.
Existing downloader tests also assert lock removal across success/error paths.
The lock suite passed five additional consecutive runs after the full gate.

## 12. Observed deletions and revocations — local retention hardened

The first eleven synthetic regressions all failed against the previous commit,
built separately in a temporary directory. The failures covered ignored Baileys
`messages.update` REVOKE events, payload bytes left in history/snapshots and the
append-only semantic index, missing persistent phone-event deletion barriers,
stale appends/backfill, and preview/transcription results returned after deletion.
Further review found that history-sync chat rows embed a second copy of the most
recent message, and that a deletion arriving during the recall queue's final
history-offset write could remain pending until another feed. The latter was
reproduced independently with a gated offset write.

Changes:

- Normalize protocol revoke keys from the sender's perspective and scope them
  to the enclosing chat, never an arbitrary embedded `remoteJid`. Honor REVOKE
  updates even without a cached original. Group revoke stubs can identify an
  admin rather than the original author, so both direction encodings of that
  chat/message ID are removed. Successful local deletes for everyone now remove
  the cached original without waiting for an echo.
- `src/message-retention.ts` owns content-free account-local deletion barriers,
  serialized persistence, coalesced cleanup and history rewriting. IDs and local
  chat-clear cutoffs live in `retention.json`, independently of bounded history
  rings. Missing files initialize legacy installations; malformed/unreadable
  files fail closed with no raw JSON/error excerpts. Directory/file creation
  modes are 0700/0600. Barriers are not age-evicted.
- Delete/revoke observation removes readable payloads synchronously. Snapshot,
  history and preview writes share an ordering with cleanup, and late appends
  re-check barriers. History rewrites remove all saved versions/transcripts of
  deleted records rather than merely appending another tombstone. Snapshot chat
  metadata is stripped of its embedded messages on ingestion, hydration and
  serialization. Known LID/phone aliases, including newly learned pairings, are
  applied to stored and indexed copies.
- Clearing/deleting a chat rejects older backfill, including messages absent
  from the live ring. The cutoff is the local observation time, not a WhatsApp
  server sequence. Clock skew and second-precision message timestamps can also
  suppress a legitimate message around the clear boundary.
- Late automatic preview/transcription results are not returned or cached for a
  deleted message. Preview file publication shares the cleanup queue. Webhook
  events still waiting for transcription check message existence before creating
  their payload.
- Recall queries filter barriers immediately, including index-only messages.
  Embedding batches re-check retention before submission and publication;
  deletions are not optimized away while a put is in flight. The queue restarts
  if work arrived during its final offset write. Chat/predicate removal selects
  rows inside the index write queue, after earlier queued puts.
- Explicit index deletes force compaction even below the normal dead-row ratio,
  removing old text and vector rows from the current files. Incomplete indexes
  are wiped before rebuilding instead of appending new row-zero data to old
  payloads. Managed interrupted rewrite files are removed. A disabled or failed
  recall index is invalidated on deletion rather than exempted from cleanup.
- Barriers are kept even with history persistence off. Inactive
  history/snapshot/recall caches from a previous enabled configuration are
  invalidated in full (the expiry follow-up makes this unconditional on startup
  with history off). Only owned cache files are removed;
  notes, credentials, models, explicit media exports and unrelated files are not.
- Successful delete/clear tools wait for cleanup. A storage failure is reported
  safely even when the WhatsApp-side action already succeeded. The error stays
  sticky for that service instance; fix permissions/space before restarting.
  Socket-event cleanup is asynchronous; startup applies known barriers again.

The initial 39 tests in `test/message-retention.test.mjs` and
`test/message-retention-state.test.mjs` exercised these boundaries with synthetic
protobufs, mocked sockets, controlled
embedding/transcription promises and temporary directories. Existing daily,
chat-action, persistence, story and recall tests remain covered. No user history,
credentials, live WhatsApp sends or real embedding/transcription service was used.
Both new suites also passed five consecutive additional runs after the full gate.

Limits: this is logical removal plus rewriting of current owned cache files, not
secure erasure of heap pages, SSD blocks, journals, backups or filesystem snapshots.
The multi-file operation is not a crash-durable transaction. A delete lost before
its barrier is saved, or never recorded by an older version, cannot be inferred
later. This is retention after recognized delete events, not independent
verification of WhatsApp's revoke authorization. Already returned data, explicit
exports/in-flight export operations,
independent quoted/forwarded copies and external processing are not recalled.
The follow-up below adds freshness gates for webhook backlogs and retries;
already-started HTTP requests cannot be unsent, and a queued job can still hold
its payload until it drains. Metadata growth and forced index-compaction I/O need an explicit
long-term operational policy rather than silently forgetting deletion barriers.

## 13. Disappearing messages — conservative per-message expiry enforced

> **Opt-in since the pre-release review:** everything in this section runs only with
> `WAZAP_RETENTION=1`. Without it, deadlines are neither recorded nor enforced, and
> starting with history off does not discard earlier caches. Deletion handling in
> section 12 applies either way. See "Pre-release review" below.

An offline probe first confirmed that an already-expired ephemeral message could
remain in the live store. Eleven of twelve initial synthetic service regressions
then failed before implementation; the ordinary-message control passed.

`src/message-expiry.ts` derives an absolute deadline from `ephemeralDuration` or
the actual payload's `contextInfo.expiration`, and message-specific start/sent
timestamps (protobuf Longs included). When multiple valid clocks or durations
exist, the earliest combination wins. Bounded traversal handles known envelopes,
including edits, device-sent, document-with-caption, associated-child and view-once
wrappers. It does not descend into another message's quoted content, use the chat
setting timestamp as the message start, or use ingestion time to restart a timer.
A marked message with missing/invalid/overflowing timing fails closed. Ordinary
messages, zero protobuf defaults and chat-setting protocol events do not acquire
a retroactive deadline.

- Account-local deadlines live in the content-free retention ledger. Updates
  cannot extend them; learned LID/phone aliases inherit them. Once expiry is
  observed it becomes a deletion barrier, including against clock rollback.
  Malformed ledger expiry metadata is rejected before partially applying state.
- A single unreferenced timer per account sweeps due IDs even with no readers and
  even after their raw messages have left bounded memory. Long waits are capped
  to Node's timer range and rearmed. Reads also compare the current clock, so a
  delayed callback is not permission to return expired text. Expiry removes
  memory synchronously and schedules serialized disk/index cleanup.
- History records, snapshots and index rows carry the deadline independently of
  the latest protobuf. This prevents stripped edits from turning temporary text
  into ordinary text on replay. Boot observes every history version before
  deduplication, learns all files' deadlines before allowing the recall queue to
  submit any text, and refreshes queued puts' deadlines around embedding. Index
  rows recover timers even when their original history is no longer present.
- The recall format moves from version 2 to 3. The first version of this pass
  invalidated the v2 index, because legacy index-only rows cannot prove they
  were not ephemeral. On a real account that meant re-embedding ~12k messages
  and permanently losing the rows whose history was gone, so the owner chose to
  migrate v2 in place instead: rows are kept, and deadlines found in retained
  history still expire them under `WAZAP_RETENTION`. The accepted residual risk
  is a legacy ephemeral row with no history left, which keeps no deadline. New index queries
  filter absolute deadlines independently of the service's timer, and pending
  disk writes/embedding results recheck before publication.
- Preview reads/writes and transcription results recheck expiry after awaits.
  Media downloads check while consuming data and before exporting/returning it.
  A file already written as an explicit user export is not deleted: it is no
  longer an automatic cache. Forwards, edits, reactions and quoted replies
  recheck their source before sending after asynchronous preparation.
- Webhook message jobs carry a content-free freshness predicate. The sink checks
  it before admission, after waiting for a slot and before each retry. Expired or
  deleted jobs return false without counting as receiver failures; a throwing
  predicate fails closed. Connection/test events remain independent of messages.
  This does not cancel a POST already started or instantly erase job/heap buffers.
- With history off, startup invalidates inactive old history/snapshot/index
  caches; a disabled recall index is not an exemption. Credentials, notes,
  explicit exports, model files and unrelated files outside owned cache paths
  are not wiped. Deadline metadata still persists without message bodies.
- Stop cancels the account's timer and shares one idempotent shutdown promise.
  Stopped instances do not re-ingest messages or publish late preview/transcript
  results. A delete/clear whose remote acknowledgement arrives after shutdown
  reports that local cleanup could not complete, rather than promising success
  or writing through a stale owner.

The follow-up adds 62 tests across `test/ephemeral-retention.test.mjs`,
`test/message-expiry.test.mjs` and the retention-state suite. They cover exact
boundaries, idle cleanup, missing/malformed metadata, protocol Longs, wrapper
bounds, edits, restarts, index-only rows, legacy index migration, cross-file boot
ordering, independent cache deadlines, long timers, clock rollback, delayed
embedding/media/transcription/preview/forward/reply operations, webhook backlog
and retry cancellation, marked outbound acknowledgements without a socket upsert,
and shutdown. Fixtures use mocked clocks, synthetic protobufs, stubbed
network/provider functions and temporary directories only. All four retention
suites (101 tests) also passed five consecutive additional runs after the full gate.

Scope is intentionally stricter than full WhatsApp UI semantics: **keep-in-chat
hints do not grant indefinite retention**. A chat's current disappearing setting
is not applied retroactively to unmarked messages; absent a recognized per-message
marker, this code cannot infer the original timer. Live protocol compatibility,
keep/undo-keep authorization and unmarked outgoing/chat-default behavior need
separate review. Clock accuracy matters; choosing the earlier timestamp can
expire a message early under clock skew. Suspension or a stopped process delays
physical cleanup until execution resumes/startup; expiry checks and cleanup are
not a crash-durable transaction or secure erasure. Already returned/sent data,
independent quotes/forwards, explicit exports and third-party processing remain
outside retraction. In-flight jobs can hold temporary buffers/files until their
own completion/timeout; this is not cancellation of decoder/provider work or
erasure of provider-side caches. Barrier growth and compaction I/O remain
operational limits.

## 14. Embedding transport — bounded and secret-safe

The local embedding client followed redirects, read unbounded JSON/error bodies,
and exposed provider messages and decoder stderr. All 23 initial synthetic
regressions failed. The follow-up also tests health-body disposal and failed-child
shutdown without starting a real model.

Embedding POSTs and sidecar health probes now refuse redirects. Ignored bodies
are cancelled; JSON is limited to 4 MiB of actual decoded bytes under the existing
60-second request deadline. Replies must contain the expected number of vectors,
with the configured dimensions and finite numeric elements. Invalid/null replies,
HTTP errors, transport errors and decoder exits produce typed errors without raw
provider text, URLs or stderr. A failed spawn clears the child reference so stop
cannot wait forever for an exit from a process that never started.

The test-only `WAZAP_EMBED_URL` override rejects userinfo, query and fragment, and
readiness displays its host only. Like transcription/webhooks, this is a trusted
operator sink, not a public-media URL: private endpoints remain usable. Selecting
a remote override sends text there. The default sidecar binds literal loopback;
this does not sandbox local processes or defend against a hostile local port
owner. Tests: `test/embedding-security.test.mjs` and the existing sidecar/recall
suites. No real model, credentials or WhatsApp data were used.

## 15. Account policy loss — fail closed

Previously `AccountHub.recordOnDisk` swallowed parse/read errors and send handlers
fell back to cached rules. Removing accounts.json could also synthesize an open
default account. Synthetic fixtures reproduced these gaps without a real send.

- Saving policy seals its existence first with an empty, private
  `accounts.json.required` marker. The hub also seals legacy policy at startup,
  without rewriting its bytes or permissions. Missing marked policy is an error,
  not fresh-install defaults; migration cannot silently recreate it.
- Fresh or legacy unmarked directories retain their bootstrap behavior. The
  marker cannot prove a file existed before this version observed it. Explicit
  layout rollback removes the modern registry and marker; an old flat-layout
  runtime does not enforce per-account controls.
- Write admission reads disk policy before preparation and refuses corruption,
  missing/disabled accounts or newly disabled writes. Send rules no longer fall
  back to cached values. Rejected owned drafts remain available after repair.
- Error hints say restore/repair from a trusted backup, not delete policy to get
  past an error; a lost policy also names the deliberate reset (delete the marker
  too, for one default account without send rules). Invalid recipient-rule contents are not echoed. Malformed
  `WAZAP_READ_ONLY` values are rejected rather than silently enabling writes.

Startup read-only restrictions still require a restart to change; the account
roster no longer does (section 19), and a roster reload reads the same
fail-closed registry. This is next-call write admission, not cancellation of
already-started work, transactional configuration updates or a per-client ACL.
The marker is not tamper protection against an operator who can remove both
files. It does not seal external environment variables or command-line flags:
unset global read-only settings still mean writes on, as before. For a durable
account restriction, use `wazap config writes off --account <id>`. Tests: `test/policy-state.test.mjs` plus account, migration and send-rule
regressions.

## 16. OAuth lifecycle — rotation, revocation and bounded state

Six initial regressions exposed reusable refresh tokens, malformed persisted
access entries becoming unexpiring, and registration resurrecting grants after
`oauth.json` was deleted before another request noticed its absence.

Refresh tokens are now single-use and rotate. A family identifier ties all
its generations and access tokens together. Reuse of a retained consumed token
revokes that family only, even when another grant uses the same client ID.
Revoking a retained old refresh token also revokes the family. Narrowing one
access token does not broaden or destroy the original consent grant's scope.
Legacy unrotated grants migrate on their next refresh; no raw bearer token is
persisted.

At most eight access tokens and 32 consumed refresh hashes are kept per family;
pruned tokens remain invalid, but their family can no longer be identified for
replay-triggered revocation. Global allocation caps are 256 registered clients,
256 active grants, 128 pending consent pages and 128 authorization codes. Existing
legacy state is not revoked merely to meet an allocation cap. Idle refresh grants
expire after 90 days; codes/pages expire at the exact ten-minute boundary.

Registration and client lookup honor sign-out before writing state, and sign-out
also clears pending pages/codes. Invalid persisted token shapes/scopes/expiry
reset to no grants instead of granting unbounded access. Public issuer settings
reject credentials and unsupported schemes without echoing malformed URLs.

**Compatibility:** clients must save each returned refresh token. A consumed
token is still accepted for 60 seconds from its first rotation, so a concurrent
refresh or a lost response does not sign the client out; the window is fixed and
cannot be extended by reuse. Reuse after it revokes the family. New access credentials still require new MCP sessions. The hosted
clients' real refresh/reconnect behavior is a release check, not proven by these
synthetic tests. Tests: expanded `test/oauth.test.mjs`, including restart,
independent families, bounded rotation chains, capacity and corruption.

## 17. Request/session budgets and anonymous browser requests

Five initial budget regressions failed; separate raw HTTP tests also reproduced
anonymous initialization with a foreign Origin or attacker-controlled Host.

- MCP POST authentication precedes JSON parsing. Bodies are explicitly capped at
  100 KiB and compressed bodies are refused. Each exact credential gets 240 POSTs
  per minute across session resets (fixed since the 1.0 settings cut; it was `WAZAP_HTTP_BUDGET`); 429 includes `Retry-After`. The endpoint's
  credential-window map is capped at 1,024 entries, pruning expired entries and
  refusing new ones with 503 rather than growing indefinitely.
- Session state remains capped at 128 overall, now also at 32 per exact
  credential. Excess sessions first evict that credential's oldest session, so
  one unchanged token cannot consume the entire registry.
- Actual tool handlers have eight in-flight slots per MCP session and 32
  process-wide (fixed since the 1.0 settings cut; they were `WAZAP_MAX_INFLIGHT` and `WAZAP_MAX_INFLIGHT_TOTAL`). Capacity is returned when work settles, even if the caller
  disconnects earlier. HTTP, stdio and private bridges share the tool budget.
- The listener caps connections at 256, header receipt at ten seconds, body
  receipt at thirty seconds and headers at 16 KiB. SSE/long-running tool response
  time is not confused with request-body receipt time.
- Anonymous access requires a literal loopback Host name (any port, so a mapped
  container port works) and, if provided, the matching HTTP Origin. Raw headers are checked before transport
  creation and never echoed on refusal. Explicit valid bearer authentication is
  not ambient browser authority and retains its existing host/proxy behavior.

These are bounded resource controls, not DDoS protection, fair scheduling or
multi-tenant isolation. Credential rotation creates a different credential;
anonymous callers and clients sharing a token share budgets. Anonymous access
is still not authentication: a proxy can rewrite headers, and non-browser callers
can set them. Always configure credentials for proxies/tunnels. Tests:
`test/request-budgets.test.mjs`, session isolation and existing daemon lifecycle
coverage. `src/http-budget.ts` keeps admission bookkeeping out of the endpoint.

## 18. Retention cost and small decomposition

`src/history-records.ts` extracts the history-version scan from the service. The
observer still sees every version before deduplication, so a stripped edit cannot
hide a prior deadline; tombstones stay independent of record order. Existing
service regressions characterize the extraction, with focused parser tests added.

Cleanup now groups deletion IDs by history file once, rather than remapping every
ID for every file. Existing tombstone timestamps are preserved, avoiding needless
file replacement just because the wall clock advanced. A deterministic 20-file,
200-barrier regression checks 200 path mappings instead of 4,000 and verifies
unchanged files retain their inode. Invalid internal deadlines fail closed rather
than arming an endless timer. Tests: `test/history-records.test.mjs`.

No database, new job framework or wholesale service rewrite was introduced.
Barriers still grow intentionally: evicting them without a replay policy would
restore deleted data. Cleanup still reads current history and can compact the
index; this is not a production-scale throughput claim. Monitor ledger/history
size and cleanup I/O, retain protected backups, and never truncate barriers as a
space-saving shortcut. Large installations need a separately designed archival
or indexed-ledger policy, not an arbitrary age limit in this patch.

## 19. Account roster and logout against a running server

A server read `accounts.json` once. A tenant added while it ran answered
`ACCOUNT_NOT_FOUND` until a restart, and `wazap logout` refused any lock holder
that was not the installed service. Both are now handled by the running process.

- **Roster reload.** `AccountHub.reload` re-reads the registry through
  `AccountRegistry.load`, so a missing policy behind its `.required` marker or a
  malformed file throws before anything changes: the roster stays, and a tool
  call that triggered the reload fails with that error instead of answering
  `ACCOUNT_NOT_FOUND`. Write admission still reads the disk record on every
  write. Disabled and removed accounts are stopped; a reload never stops the
  last running account, whose record then reads disabled and refuses by id.
- **Control line.** `src/control.ts` listens on `127.0.0.1`, port 0, separate
  from the MCP listener, so a tunnel or proxy that forwards `WAZAP_PORT` cannot
  reach it. One credential opens it: 32 random bytes, generated per process
  and published only in `control.json` (`0600`, atomic write, removed on exit,
  ignored when its pid is not the lock holder). Static read/write tokens, OAuth
  grants, the bridge token and anonymous callers get 401 before the body is
  read; any `Origin`, a non-loopback `Host`, a method other than POST, a body
  that is not JSON or over 4 KiB, and an invalid account id are refused too.
  There are three routes (reload, logout, remove) and no MCP tool calls them.
  Logs name the route and the account id, never the token.
- **Why a token file is enough.** Whoever can read `control.json` can already
  read or delete the credentials and the registry it would act on, and signal
  the process. The line adds no capability beyond that local file access; it
  replaces "stop the server, edit, start again".
- **Logout and removal ordering.** The account's service stops before anything
  is deleted, cancelling a pairing in flight and waiting (bounded) for its
  socket, so no credentials are written behind a logout or into a folder being
  removed. Logout then runs the same code as the offline command
  (`src/logout.ts`). If either fails half-way, the account is put back on a
  fresh service before the error is returned, so a stopped service never keeps
  answering. Callbacks from a replaced service (owner, give-up) are ignored.

Not covered: registry writes from two processes at once are still
last-writer-wins, as before. A live service keeps the rate limit, webhook
override and relaxed writes setting it started with until it next starts;
tightened writes and send rules are read from disk on every write, as before.
Tests: `test/account-roster.test.mjs`, `test/control.test.mjs`, and the two
running-server cases in `test/integration-contract.test.mjs`.

## 20. Legacy files and set-aside databases — kept a week

The account database (0.22) imports each account's legacy files once. Left in
place, they would keep a second copy of the history, readable from the data dir
for good, after the database had honoured a deletion. `src/legacy-files.ts`
retires them, and deletes nothing it cannot prove is its own copy.

- **Move.** Once the import is `done` or `imported`, `store.json`, `history/`,
  `retention.json`, `notes.json`, `recall/` and their temp files are renamed
  into `accounts/<id>/legacy/` (`0700`; `legacy-<n>/` when `legacy` is taken by
  a file or a link): same filesystem, no copy, directory entries synced. The
  plan with every destination is written before the first rename, so a crash
  leaves each moved entry recorded and the rest to the next boot; nothing moves
  before the import finishes, so a resumed import still reads every file. Once
  the move is recorded the service never opens, lists or stats those paths
  again (tested by instrumenting `fs`). A link is never moved. `auth/`,
  `media/`, `previews/` and `webhook.json` stay. A database marked `skipped`
  (a different number linked) moves nothing: those files belong to the earlier
  number and wait for it.
- **Deletion.** Only the recorded entries are deleted, a week after the later
  of the move and their own mtimes, at boot or by the daily pass, and at once
  with `WAZAP_RETENTION=1`; the folder goes only when empty, so anything else a
  user keeps in it stays. An import whose verification found unexplained
  differences records `legacy_keep=unverified` and is never deleted
  automatically: the files are what the user compares against. `wazap status`
  warns and gives the `rm -rf` to run deliberately.
- **Beta archive.** The import records the archive it took (`beta_imported`:
  owner, row count, newest time). `<data-dir>/archive.sqlite` moves to
  `<data-dir>/legacy/` only when every enabled account linked to its
  `meta.owner` has a `done` import carrying that record, and
  `accounts/<id>/archive.sqlite` only when its own account does. An account
  not linked at the upgrade, or an archive copied in later, is imported at the
  next start once the number matches; until then the archive stays in place.
  A moved archive's mtime is set to the move (never earlier than its files')
  and it is deleted a week later; one left in `legacy/` does not block the
  next, which takes a free name. An archive no enabled account is linked to, or
  whose owner cannot be read, is never moved or deleted.
- **Previous owner.** A database set aside when a different number linked
  (`wazap.<ms>.previous-owner.sqlite`, its `-wal` and `-shm`) holds the earlier
  person's history. When that number links again, the newest one it owns is
  put back and the other number's set aside. Otherwise it is deleted a week
  after the later of the time in its name and its mtime, never while its owner
  is linked to an enabled account or cannot be read, and `WAZAP_RETENTION=1`
  does not shorten the week. The legacy record moves with every swap, so a
  folder whose first database was set aside is still deleted on its week.
- **Logout** binds the account database to the number (creating it for an
  account never started on 0.22), then deletes only the credentials. A
  different number linking afterwards therefore never imports the earlier
  number's legacy files into its own history.
- **Reporting.** Logs carry counts and error codes, never contents, file names
  inside `history/` or numbers. `wazap status` changes no account database:
  one with a write-ahead log beside it — a server has it, or a crash left the
  log — opens read-only and is read log and all, so the answer holds what the
  server committed a moment ago and neither the file nor the log is written;
  one with no log opens immutable, so not even a `-shm` appears beside a
  database nobody has open. Symlinked legacy entries are reported, not followed.

Not covered: deletion is an unlink, not a secure erase, and copies in backups,
snapshots or free disk blocks are outside wazap. The week is a rollback window,
not a promise that nothing older survives: an unverified import, an archive
nobody owns, a set-aside database whose owner is linked, links and files put
back after the import (all reported by `wazap status`) stay until the user
deletes them. A rollback to 0.21 brings back messages deleted during the 0.22
period (`docs/data.md`, "Rolling back to 0.21"). Tests: `test/legacy-files.test.mjs`,
the beta cases in `test/legacy-import.test.mjs`, the logout case in
`test/account-roster.test.mjs`, the `fs` watch in
`test/account-database.test.mjs`.

## Pre-release review

The owner's review of this pass, before 0.21.0, kept its substance and changed
what hurt ordinary operation. Each item is its own commit with tests.

- **Strict retention is opt-in** (`WAZAP_RETENTION=1`, section 13). Enforcing
  disappearing-message deadlines, discarding caches when history is off, and
  clearing the index when a delete arrives while recall is unavailable are
  product decisions, not fixes; upgrades keep what wazap has seen.
- **The recall index migrates v2 to v3 in place** (section 13). Invalidating it
  would have re-embedded ~12k messages on the maintainer's account and lost 695
  rows with no local history. Accepted risk: a legacy ephemeral row whose history
  is gone keeps no deadline.
- **OAuth refresh:** a 60-second reuse window after rotation and scope narrowing
  instead of rejection (sections 6 and 16).
- **Budgets** default to 8/32 in-flight tools and 240 POSTs a minute and are
  configurable; anonymous loopback Host checks ignore the port (section 17).
- **Docker:** the compose network is pinned and its gateway trusted as the proxy
  hop; inside the container a host proxy appears as the gateway, not loopback,
  which was verified on Docker 29 (section 6).
- **Diagnostics:** error codes (ECONNREFUSED, CERT_*, exit codes, signals) are
  kept in logs and failure strings, never messages; llama-server boot output is
  logged until the server is ready.
- **Models:** lock-release failure no longer fails a verified download, the total
  deadline scales with model size, `bytes a-b/*` resumes are accepted, and lock
  errors name the directory.
- A failed retention cleanup is reported to its waiter once instead of failing
  every later delete until restart.

## Remaining limits and release gates

- A shared static token is a shared identity: its sessions share one draft
  identity, and a caller holding the credential can confirm its drafts.
  Identity-scoped drafts do not turn shared credentials into a hostile-client
  security boundary — use distinct credentials/OAuth grants for isolation.
- Account data and account-wide policies remain shared. There are no per-client
  account ACLs; do not describe this server as multi-tenant isolation.
- Draft/confirm is not independent proof of human consent. An agent authorized
  to call both tools can perform both; stronger approval requires a trusted UI
  or harness outside incoming message content.
- Validate real proxy/tunnel deployments and sanitized header chains separately.
  Exercise actual hosted-client token rotation/reconnection and live disappearing
  metadata before release. Keep-in-chat exceptions and inference from unmarked
  chat-default messages remain deliberately unsupported, as described above.
- Local stdio and private bridges are trusted with the filesystem. This pass does
  not sandbox them or address all local file replacement/symlink races.
- This pass covers the identified webhook, preview, transcription and embedding
  paths, not every dependency, reverse-proxy log or decoder resource budget.
  Model downloads now have byte/time bounds
  and cooperative same-host exclusion, but hostile-local filesystem races and
  distributed coordination remain outside the guarantees.
  Existing historical logs/persisted diagnostics are not retroactively scrubbed.
- The service is still large. The scoped extraction is complete; additional
  lifecycle/outgoing refactoring is optional maintenance, not a reason to rewrite
  tested behavior during this security pass.

## Verification

The scoped local review is complete on the pulled 0.20.2 base. `npm run check`
passes lint, typecheck and all 1,375 tests (none skipped on this machine); after
the pre-release review, 1,391. Fresh
`npm ci` installations and the full gate were verified in a temporary repository
copy under Node 22.22.3 and 24.21.0, without replacing the working installation.
`npm audit --omit=dev --audit-level=high` reported zero vulnerabilities at check
time. Node 24's npm also emitted install-script allowlist notices for Baileys,
esbuild, fsevents and protobufjs; installation and checks still succeeded. These
notices are not vulnerability findings and do not justify blindly approving
future dependency scripts.

`npm pack --dry-run --json` was checked for the new runtime modules and absence of
private state, `.env`, test fixtures and tickets. It did not publish a package. New coverage lives in
`test/message-retention.test.mjs`, `test/message-retention-state.test.mjs`,
`test/ephemeral-retention.test.mjs`, `test/message-expiry.test.mjs`,
`test/model-download-lock.test.mjs`, `test/model-download.test.mjs`,
`test/embedding-security.test.mjs`,
`test/policy-state.test.mjs`, `test/request-budgets.test.mjs`,
`test/history-records.test.mjs`, `test/network-sinks.test.mjs` and
`test/preview-security.test.mjs`, alongside
the previous account, OAuth, proxy, log, media and session tests. Real ffmpeg
fixtures are conditional on its availability in other environments.
These tests do not validate the real WhatsApp network, live public DNS behavior,
every hosted MCP client's reconnection behavior or a Windows deployment.

Release validation still needs the actual proxy/tunnel to reject spoofed
forwarding headers, enforce credentials and handle the deployed streaming/timeouts;
and the actual hosted clients to retain rotated refresh tokens and reinitialize
sessions. Run that smoke test with a dedicated synthetic WhatsApp account, not
private conversations. It was not run here because live WhatsApp/public listeners
and deployment were outside the authorized test scope.

No push, release or deployment has been performed. The pre-existing `.gitignore`
change is untouched. This report is under `docs/` because `tickets/` is ignored
in this working tree; the first-pass ticket remains only a local artifact.
