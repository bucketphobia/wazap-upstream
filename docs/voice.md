# Voice messages

A voice note is the one message an agent cannot read. Switch transcription on and
it becomes text: `[voice message · 0:42] "sunt la notar, ajung în 20 de minute"`,
with the bare words also in a `transcript` field. `catch_up` and `search` see
that text, so a voice note becomes findable by what was said in it.

Pick a provider once, in `wazap setup` or later:

```bash
wazap config transcribe local     # free and private, one 574 MB model on disk
wazap config transcribe openai    # cheap and fast, the audio leaves this machine
wazap config transcribe off
```

| | `local` | `openai` |
| --- | --- | --- |
| Runs | whisper.cpp, here | any OpenAI-compatible `/audio/transcriptions` |
| Costs | nothing | per minute of audio, on your key |
| Privacy | the audio never leaves this machine | **the audio leaves this machine** |
| Needs | `whisper-cpp` and `ffmpeg`, plus a model | an API key |

## Local, with whisper.cpp

```bash
brew install whisper-cpp ffmpeg      # macOS; elsewhere build whisper.cpp, install ffmpeg from your package manager
wazap transcribe download            # fetch and verify the model
wazap transcribe test recording.ogg  # prove it before you trust it
```

`wazap setup` and `wazap transcribe download` offer that `brew install`
themselves when either binary is missing, and go straight on to the model in the
same run. `--no-brew` turns the offer off everywhere.

Models land in `<data-dir>/models/` and are checked against a SHA-256 pinned in
the source. The shared whisper/embedding downloader stops an oversized response
before excess bytes are written, independently of `Content-Length`. Only a
successfully closed write with the exact size and digest is renamed from `.part`
to the final model file.

The network/write phase has a 30-second no-progress timeout (including waiting
for response headers) and an overall deadline of 30 minutes or the time the
model takes at 100 KiB/s, whichever is longer (about three hours for large-v3). A timeout or interrupted
transfer keeps a bounded partial file for a later retry to resume; an invalid
range, oversized response or failed verification discards it. A receiver that
ignores Range restarts the download safely. CDN redirects remain supported,
but compressed responses are refused so byte ranges remain unambiguous. Errors
report status/category, not signed URLs, response excerpts or raw disk errors.

Each destination has an exclusive `<model>.download-lock/` directory, held from
cache verification through the final rename and cleanup. A simultaneous download
of that model fails promptly with a retry hint; different models can download
in parallel. Directory symlinks and relative paths use the same canonical parent.
The lock is released on success, handled failures and cancellation; if it
cannot be removed, the verified model is kept and the next run names the
directory.

A known dead owner on the same host/PID scope can be recovered automatically;
Linux also checks the PID namespace. Live owners are never evicted by age. If a
process dies during lock initialization/cleanup, or the owner record is corrupt,
from another scope or inaccessible, recovery fails closed. Inspect the
`owner-*.json` inside the lock directory and remove **only that lock directory**
only after confirming no downloader is still using the model. Then rerun the
command to reuse the partial file when possible. Never remove an active lock.
This coordinates cooperating versions on one host, not distributed downloads
across machines; stop older downloaders before upgrading.

The model is whisper large-v3-turbo (`ggml-large-v3-turbo-q5_0.bin`, 574 MB),
the smallest that still gets Romanian right. Smaller models drop diacritics and
mangle names, which is worse than no transcript at all: a missing transcript is
a question, a wrong name is a wrong answer.

## An API, OpenAI-compatible

`wazap config transcribe openai` asks for the key without echoing it, then for
the base URL (OpenAI unless you type another), and stores both in
`<data-dir>/.env`.

**With this provider the audio leaves your machine.** Every voice note wazap
transcribes is uploaded to that endpoint. If that is not acceptable, use `local`,
which uploads nothing.

The key is treated as a secret rather than as a setting:

- It is never accepted as a command-line argument, because an argument lands in
  your shell history and in `ps`.
- The prompt echoes nothing, not even asterisks.
- It is stored only in `<data-dir>/.env`, mode `0600`.
- `status`, `status --json`, `config` and `get_status` show at most
  `api key: set (…abcd)`.
- Provider error bodies, transport exception details and malformed-JSON excerpts
  are not printed. Errors retain HTTP status, timeouts and actionable fixes.
- A plain-`http` base URL is refused unless it points back at this
  machine. Userinfo credentials, queries and fragments are not allowed in this
  base URL; set the API key separately.
- Redirects are refused, including same-origin redirects: configure the final
  base endpoint directly. This keeps audio and credentials on the intended route.
- Successful JSON responses are capped at 1 MiB, including chunked responses.
  Error response bodies are discarded without being read.

### API transcription with WhatsApp read-only

Read-only accounts refuse API audio uploads by default. After approving the
provider, upload scope and charges, set `WAZAP_TRANSCRIBE_ALLOW_API=1` alongside
`WAZAP_TRANSCRIBE=openai`. WhatsApp send and mutation tools stay disabled.
The permission flag does not enable a provider or grant WhatsApp writes.
This opt-in defaults to on-request transcription; explicitly set
`WAZAP_TRANSCRIBE_AUTO=1` to process eligible incoming voice notes in the
background. Local transcription and existing write-enabled API defaults are
unchanged when the permission flag is unset.

Transcripts are cached and concurrent requests are deduplicated. Background
work keeps its durable queue and retries; timeouts or crashes can cause repeat
provider charges. There is no total dollar budget in wazap. Configure provider
limits before enabling automatic uploads. Enabling the provider does not
retroactively transcribe the whole archive.

### Compatible gateways

Configure the exact base endpoint and model route with
`WAZAP_TRANSCRIBE_URL` and `WAZAP_TRANSCRIBE_MODEL`. The client appends
`/audio/transcriptions` and sends multipart audio, model and optional language.
OpenAI and LiteLLM-compatible routes use Bearer `Authorization` by default.
Bifrost uses base `/openai`; use the exact configured provider/model name.
Set `WAZAP_TRANSCRIBE_AUTH_HEADER=x-bf-vk` only when the gateway requires its
raw virtual-key header. Exactly one credential header is sent.

The base URL still requires HTTPS or loopback HTTP and rejects credentials,
queries, fragments and redirects. This feature does not allow LAN plain HTTP
or establish gateway routes, credentials or model access. Tests exercise
synthetic compatible endpoints; actual gateway/provider availability must be
verified separately before sending approved content.

## Without being asked

With automatic transcription enabled, incoming voice notes of up to ten minutes are
transcribed in the background as they arrive, never holding up a message. The
transcript is stored with the message, so a voice note is transcribed once, and
its words are searchable, recalled and carried by the webhook event.

- **Durable.** The note is queued in the account database in the same
  transaction that stores it, so a restart or a crash resumes the queue
  instead of dropping it. A note that just arrived starts at once, ahead of any
  backlog, which is what lets its webhook event carry the words. A stop waits
  up to 30 s for a transcription under way to store its words, so a note is
  not paid for twice; removing an account cancels it instead.
- **One at a time for the whole server.** Every account shares one
  transcriber and they take turns, so a backlog on one does not starve another
  and two whisper.cpp runs never fight for the machine. Only the server
  (`wazap serve`, the service) transcribes; short commands such as
  `wazap status --live` queue what arrives and leave it to the server.
- **Retried, then given up on.** A download that times out, a provider
  answering 429 or 5xx, or whisper.cpp crashing is tried again after 10 s and
  after a minute more, three attempts in all. Media WhatsApp no longer holds,
  audio the provider refuses as input, or a file too large gives up at once.
  A note given up on is not queued again; `get_media(message_id)` still tries
  it on request.
- **Waiting costs nothing.** A note whose account is disconnected spends no
  attempt and runs within seconds of the connection opening. A provider that
  cannot take any note — whisper.cpp or its model missing, an API refusing the
  key — pauses all transcription for 30 s, then twice as long each time up to
  15 minutes, and one note probes it before any other audio is downloaded.
  Meanwhile webhook events post the `[voice message · 0:42]` placeholder at
  once instead of waiting for words that are not coming.
- **Deleted means dropped.** A note deleted, expired or cleared while it
  waits leaves the queue and is never uploaded.
- **A day at most.** A note still waiting 24 hours after it was queued (the
  account offline, the provider paused) is given up on as `too_old` and never
  transcribed on its own later.
- **Local stays local.** Each note remembers whether it was queued for
  `local` or for an API. A note queued under `local` is never sent to an API
  provider configured afterwards: it is given up on as `provider_changed`. A
  note queued for an API may still be transcribed locally.
- **History: the last day only.** A note that a history sync brings (a first
  link, a relink) is queued only when it is less than 24 hours old, so linking
  never transcribes the archive. A note WhatsApp delivers live is always
  queued, however old its timestamp.

Audio *files* are left alone, since one can be an hour long, and so are notes
you recorded and notes WhatsApp gave no length for; call
`get_media(message_id)` for those. `WAZAP_TRANSCRIBE_AUTO=0` keeps that and
stops the background work; with it, or with the provider switched
off, a queue already stored is kept and waits, and it continues under the
provider configured next, within the day and the local-stays-local rule.
`get_status` shows the queue under `transcription` (how many wait, how long
the current run has taken, how many were given up on, the latest reason, a
pause and until when, never content), and `wazap status` prints a
`voice queue` line, a warning when notes wait and nothing will run them.
