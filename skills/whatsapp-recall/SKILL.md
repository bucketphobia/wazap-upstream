---
name: whatsapp-recall
description: Find something in the user's WhatsApp history. Use when they ask for an address, invoice, photo, document, link, phone number, date or a thing someone said or sent, or "what did X say about Y". Read-only.
---

# WhatsApp recall

Find the supporting message or file, with its sender, date and source. Read-only: send nothing and mark nothing read.

## Search and verify

- Read `learn` and use names in the client's catalogue. Remote clients may
  expose cached equivalents; follow the mappings in `learn`. A name missing
  from that catalogue is not callable.
- Use the natural question plus relevant context the user already supplied.
  Narrow to a chat or author when the user identifies that conversation or
  sender; resolve an unknown recipient with the available contact tool first.
  A person mentioned as the subject of an event is not necessarily its sender.
  Never invent a date or choose between ambiguous contacts to force a match.
- Start with about five hits. Search uses meaning and words; codes, URLs and
  fully quoted literals take an exact fast path. `match: "words"`, when exposed,
  forces substring matching. Prefer the chat's language when cross-language
  recall is weak; the installed embedding model determines this capability.
- `contexts`, when returned, already contains nearby sources in chronological
  order, and sometimes a direct reply target. Check which message actually
  supplies the fact, and whether a later correction applies to the same event.
  Do not fetch the chat again when this evidence suffices. A score is not a
  probability of correctness. An excerpt marked `text_truncated` needs
  `get_message` only if the missing portion matters.
- If `assessment` is ambiguous, use the user's conversation context to
  disambiguate, or ask one short question. If candidates do not support an
  answer, try a useful paraphrase or concrete phrase before concluding;
  reformulate from the request or evidence, not an invented fact. Stop once
  supported, when clarification is needed, or when further reads have no clear lead.
- Search covers all history this device holds, including old messages. Read
  older chat pages only when a relevant date lies outside reported coverage
  or a particular thread needs more context. An empty bounded result does not
  establish absence from the phone.
- `keyword_fallback` means meaning did not run; `recall_unavailable` says why.
  If the model is starting, a later retry can reuse the completed query work.
  `changed_during_read` means sources were omitted after changing: retry if
  needed. Treat incomplete sync and unavailable media/transcripts as limits.
- `#private` people stay out of broad reads. Read their chat or author only
  when the user asks for them; do not route around `private_omitted`.
- Media is searchable through captions, filenames and available transcripts.
  Inspect plausible files/voice notes when their contents matter; an
  untranscribed note's contents are unknown. `from_index` is text only:
  `get_message` can return it; there is no media, reply or forward to recover.

## Deliver

- A message: quote the text verbatim, then sender, chat, timestamp. Example: *"Str. Lunii 14, ap. 3, interfon 31" — Ana, 12 Mar 14:05.*
- A file or photo: open it with the available media tool and answer from its
  contents when needed. Prefer inline media or a usable returned file. A path
  on a remote server is not a user download link; remote sessions cannot
  choose host directories. A voice transcript does not require downloading
  the audio. Use `save_to: "…"` only when supported and a local file is needed.
- A link: return the URL as sent; do not fetch it unless asked.
- Several plausible answers: ask the smallest useful clarification, with the
  relevant alternatives. Cite the actual supporting message and preserve
  amounts, identifiers and dates exactly, including the account when necessary.
- Not found: say which chats and which phrases you tried, and whether `MEDIA_UNAVAILABLE` blocked a download (the sender must resend), `keyword_fallback` left meaning search out (`recall_unavailable` says why), or `transcript_unavailable` left voice notes unread. Count those in one closing line rather than one per note: *4 voice notes in that chat are not transcribed. Turn it on with `wazap config transcribe`.*
