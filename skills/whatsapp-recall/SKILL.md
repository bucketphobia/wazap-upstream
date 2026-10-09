---
name: whatsapp-recall
description: Find something in the user's WhatsApp history. Use when they ask for an address, invoice, photo, document, link, phone number, date or a thing someone said or sent, or "what did X say about Y". Read-only.
---

# WhatsApp recall

Deliverable: the exact message or file, quoted with who sent it and when, or a clear "not found" that says where you looked.

## Narrow, then search

1. If a person or group is named, resolve it with `find_contact` (a group by its name too) and search inside that `chat_id`. Searching one chat beats searching everything. When it answers `ambiguous` or `not_found`, ask the user which one before searching.
2. `search` matches by meaning and by words at once, so a paraphrase still hits; a query in another language seldom does, so search in the language the chat is written in. Each result carries its date and a score; `from_index` means wazap holds the message only as text — quote its words; `get_message` returns them, but `get_media` has nothing to open and it cannot be replied to or forwarded. For an exact string (an id, a number, a URL), pass `match: "words"`. `private_omitted` counts matches from someone the user tagged `#private`, left out because the search did not name them: say how many, and search their `chat_id` or `from` only when the user asks for them by name. An answer with `mode: "keyword_fallback"` matched the words only, because meaning search could not run: `recall_unavailable` says why (off, with the command in `fix`; failing; or still starting, when a search a minute later has meaning again). If nothing matches, run two more variants before giving up: a synonym or the other language the user writes in, and a narrower fragment (a street name instead of "the address", "factura" instead of "the invoice from March").
3. Media has no searchable text beyond its caption and the `[image]`/`[document] name.pdf` placeholder. For "the photo of…" or "the PDF", search the placeholder and filename words, or `read_messages` on the chat with `limit: 100` and scan `type` and `media.filename`.
4. Older than what is loaded: `read_messages` with `before` set to the oldest `message_id` you have, repeatedly, until the date the user remembers is covered or WhatsApp returns nothing more.

5. A voice note is searchable only once it has been transcribed; `search`
   matches its `transcript` like any other text. If the chat holds notes whose text is
   still `[voice message · 0:42]`, call `get_media(message_id)` on the plausible
   ones before you conclude anything.

Done searching when you have a match, or all three query variants and the pagination step came back empty.

## Deliver

- A message: quote the text verbatim, then sender, chat, timestamp. Example: *"Str. Lunii 14, ap. 3, interfon 31" — Ana, 12 Mar 14:05.*
- A file or photo: `get_media` on the message (a photo also comes back as an image you can look at), then open the saved file with your file-reading tool and answer from its contents when the user asked a question about it (an amount, a clause, a date). Give the saved path so the user can open it. For a voice note or an audio file, pass a directory as `save_to: "…"` to get the file: without it `get_media` answers with the transcript, and gives a path only when no transcript could be made (`transcript_unavailable`).
- A link: return the URL as sent; do not fetch it unless asked.
- Several candidates: list up to 5 with sender and date and ask which one, rather than guessing.
- Not found: say which chats and which phrases you tried, and whether `MEDIA_UNAVAILABLE` blocked a download (the sender must resend), `keyword_fallback` left meaning search out (`recall_unavailable` says why), or `transcript_unavailable` left voice notes unread. Count those in one closing line rather than one per note: *4 voice notes in that chat are not transcribed. Turn it on with `wazap config transcribe`.*
