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
