# Semantic recall

## Authenticated API embeddings

```dotenv
WAZAP_RECALL=openai
WAZAP_EMBED_API_URL=https://your-compatible-gateway/v1
WAZAP_EMBED_API_KEY=private-key
WAZAP_EMBED_API_MODEL=exact-model-route
WAZAP_EMBED_API_DIMS=VERIFIED_VECTOR_LENGTH
WAZAP_EMBED_API_MIN_SIMILARITY=CALIBRATED_COSINE_FLOOR
WAZAP_EMBED_AUTH_HEADER=Authorization
```

Every required setting must be supplied, and `openai` mode is explicit approval
to upload retained message text and search queries to that endpoint. Setting API
credentials while recall is off sends nothing. No local binary/model is needed
for API mode. Requests use `/embeddings` with exact model, raw `input` strings
and `encoding_format: "float"`; local Gemma/e5 task prefixes are not applied.
`DIMS` validates provider output and is not sent as a dimension-shortening option.
The model's actual output must match it. Select and test a model-specific cosine
floor; local-model floors are not evidence of API relevance or Arabic quality.

First enablement indexes **all retained eligible messages**, not only new ones.
There is no date/chat allowlist or total backfill dollar limit in this change.
Privacy tags govern retrieval views; they do not make the embedding backfill an
export allowlist. Approve the retained-history scope explicitly before enabling.
The feed uses at most 32 texts/8,192 characters per batch, with individual text
capped at 2,048 characters; these are character bounds, not exact token/cost
measurements. Search queries are not length capped or rate limited here. On
failures it retries with backoff, pauses after five consecutive failed batch
attempts, then probes later with delays capped at 15 minutes. Input refusals
(400/413/422) bisect a batch to isolate bad text: a refused 32-text batch can
produce up to 63 HTTP requests per attempt, or 315 before that pause. It has no total
lifetime retry/spend cap: use Bifrost's scoped key/provider budget.

Vectors, content hashes and queue checkpoints stay in the account database;
restarts resume durable work. Edits re-embed changed text, deletes/expiry remove
vectors with messages. Provider URL, model and vector length identify the vector
space; switching any reindexes instead of mixing spaces. Credentials do not
identify the space, so key rotation alone does not reindex. Old-space vectors
remain only until each message is re-embedded or removed; a switch incurs another backfill.
Meaning search degrades to keyword search when the API is unavailable.

API embeddings accept explicitly configured HTTP or HTTPS endpoints, including
Docker service names such as `http://bifrost:8080/openai/v1`. HTTP carries API
credentials and message/query text unencrypted; use it only on a trusted network.
They reject redirects, time out after
60 seconds and cap replies at 4 MiB. Malformed, duplicate, missing, nonfinite,
zero-norm or wrong-sized vectors are rejected. Errors omit provider bodies,
credentials, raw transport details and text. Bifrost's compatible base is
`/openai`; LiteLLM and other gateways may use `/v1`. Exactly one credential
header is sent. CLI recall configuration still covers local/off; configure
API mode through the environment. Existing local recall behavior is unchanged.

### Query and document input types

The default `WAZAP_EMBED_API_INPUT_TYPE=none` omits provider-specific input
types, keeping ordinary OpenAI-compatible requests unchanged. For compatible
providers that distinguish retrieval tasks, `direct` adds top-level
`input_type: "document"` while indexing and `input_type: "query"` while
searching. `extra_params` puts that field inside an `extra_params` object and
sends `x-bf-passthrough-extra-params: true`, as Bifrost's integration requires.
Neither mode changes the credential header or applies local-model prompts.

Changing this mode creates a new index identity and backfills retained text;
default omission preserves existing API identities. Verify the installed
gateway and downstream provider honor the selected envelope with approved
synthetic data first. Model aliases and input-type compatibility are not
inferred from names. For example, Voyage recommends query/document types,
but permits omission; an intermediary can silently ignore unsupported fields.
The model's configured dimensions must still match every returned vector.
These modes send the fixed labels `document` and `query`, accepted by Voyage.
Providers requiring other task labels need a gateway mapping; for example,
Cohere's `search_document`/`search_query` values are different.

## Local recall

With recall on, `search` matches what was meant and the words at once: a
paraphrase still hits through its meaning, a short question through its words,
and the two rankings are fused. With the default model a question in another
language than the chat seldom finds it; `WAZAP_EMBED_MODEL=bge-m3` does (see
below). A match counts on its similarity alone; age only orders.
It reaches every message the account keeps. For an exact string — an id, a
phone number, a URL — pass `match: "words"`. When meaning search cannot run —
recall off, the embedding server failing or refusing the query, or the sidecar
still starting after 8 s — `search` matches the words only and says so
(`mode: "keyword_fallback"`, with `recall_unavailable` naming the cause and, for
recall off, the command that turns it on).

Off by default, and fully local: a `llama-server` sidecar bound to loopback
does the embedding, so nothing leaves the machine. It needs llama.cpp, the
pinned model and persisted history (`WAZAP_PERSIST_HISTORY`, on by default):

```bash
brew install llama.cpp      # macOS; elsewhere build llama.cpp and put llama-server on PATH
wazap embed download        # fetch the embedding model, ~318 MB sha256-verified
wazap config recall local   # then restart the service
```

`wazap embed download` offers the `brew install` itself when `llama-server`
is missing. `wazap status` runs the three checks — `recall`, `llama-server`,
`embed model` — and `get_status` reports the index as `off`, `indexing`,
`ready` or `degraded`.

`chat_id`, `since`, `until` and `from` narrow a search by meaning exactly as
they narrow one by words. Hits rank by a fused score (reciprocal rank fusion of the
word and meaning rankings), and a hit found only by meaning must clear the
similarity floor, so a question with no answer comes back empty. A match found
by meaning weighs a little less with age — 85% a month on, never under 70%, for
its rank and for the floor — so the fresher of two close matches comes first
while a clearly closer old one still does, and a word hit whose meaning falls
under the floor ranks by its words alone. One chat takes at most three leading
places before other chats' hits, and a near-duplicate trails the list. The vectors
live in the account database next to their messages, are made in the
background for every message that has none, and leave with their message when
it is deleted, revoked or expires; an edit makes its vector again. A message
wazap holds only as text — carried over from the recall index an older wazap
built — is marked `from_index`: `get_message` returns its text, but
`get_media` has nothing to open and it cannot be replied to or forwarded.

Embedding requests refuse redirects, cap replies at 4 MiB and validate vector
shape and finite values. Provider bodies and decoder stderr are not copied into
errors.

`wazap config recall local|off` sets `WAZAP_RECALL`, and every kept message is
indexed. The model is embeddinggemma-300m (~318 MB). For a history written in
more than one language, set `WAZAP_EMBED_MODEL=bge-m3` in the data dir's `.env`
and run `wazap embed download --model bge-m3` (~635 MB): it finds an answer
asked in another language (an English question for a Romanian message) where
gemma does not, at twice the size and embed time. Changing the model indexes
everything again in the background; until it is done, meaning reaches only the
messages indexed so far.

### Changing a gateway URL without uploading history again

The normalized API URL is part of the durable vector-space identity, together
with the model, dimensions and input-format mode. Changing only HTTPS/public
hostname to an HTTP/Docker alias still creates a new identity and normally
refills retained history. HTTP support does not automatically equate gateways
or grant upload permission.

If both URLs are verified aliases of the same backend and the model, dimensions
and formatting mode are unchanged, reuse requires an explicit offline migration
with the server stopped and a restorable database backup. Relabel the existing
vector space and reconcile its feed metadata explicitly, preserving vector
bytes, content hashes and existing pending queue/refill state. Refuse a
conflicting target space or incompatible settings. Skipped rows have no durable
completion ledger; absent feed metadata cannot prove that history was completed.
Keep the server stopped until migration and reconciliation checks pass. Do not
restart with recall off as a migration step: that clears feed metadata and work.
Relabeling existing vectors avoids uploading those rows again, but remaining
eligible history can still refill after restart. Never remove URL/model identity
checks globally, discard pending work, or mark unfinished history completed to
avoid a bill.
