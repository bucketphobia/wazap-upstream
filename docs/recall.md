# Semantic recall

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

## Search workers

The embedding feed warms a shared int8 cache in bounded primary-key batches.
Unfiltered meaning searches use up to four workers (one fewer than available CPU
cores, minimum one). Workers preserve the existing similarity function and heap.
Each worker returns at most 4,096 heap admissions per query; an overflow abandons
the worker result and uses the existing SQLite scan. This also preserves the exact
legacy choice among equal scores without scanning all vectors a second time.

`WAZAP_RECALL_CACHE_MAX_MB` defaults to `2048` MiB; `0` disables the cache.
The limit covers vector bytes, shared message IDs, and three reusable sorted-slot
indexes (56 bytes of shared bookkeeping per reserved slot). The warm allocation
includes 10% headroom, or 1,024 slots when larger, clamped to the limit. Supported
runtimes grow shared buffers without another vector copy. On older runtimes,
copies yield in bounded steps and refuse growth whose temporary peak exceeds the
limit. JavaScript Maps, worker heaps, SQLite page cache and runtime overhead are
additional: the setting is not a process RSS limit. A size or allocation failure
releases the cache and remains latched until restart; requests keep using SQLite.

Dirty embeddings reconcile in background batches; a query encountering a large
backlog uses SQLite immediately. Queries and reconciliation share one queue so
workers read immutable buffers. Candidates edited or deleted after dispatch are
omitted; those changes enter the next scan. A connection's `PRAGMA data_version`
invalidates the cache when another connection commits, including during a scan.
The next warm uses current data. No persistent schema migration is needed.

Cache failures are logged without message content, release shared storage, and
allow at most three background recovery attempts (1, 2 and 4 second delays).
Warm operations have a 60-second deadline and worker responses a 15-second
deadline. Recall status includes advisory `cache` state, reason, shared bytes,
recovery count and `capFallbacks`; a cache failure does not disable SQLite recall.
Chat, sender and time filters, pending clear purges and cold caches also retain
that path.

For provider-free desktop acceptance, build and commit first, then run:

```sh
node scripts/bench-vector-workers.mjs <owned-scratch-dir> random
node scripts/bench-vector-workers.mjs <another-owned-scratch-dir> identical
```

Each creates 500,000 valid synthetic messages and 3,072-dimensional embeddings,
then calls the real WhatsApp service and `hybridAsync`. Only WhatsApp transport
and query embedding are stubbed; no provider calls are made. Output includes the
commit SHA, three exact service-level comparisons against SQLite, ten warm-query
measurements, cap hits, RSS, cache build time, and event-loop delay during both
warm and query phases. Synthetic results do not establish production retrieval
quality or server latency.
