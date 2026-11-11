---
name: whatsapp-groups
description: Catch up on a busy WhatsApp group. Use when the user asks what happened in a group, what was decided, what they are being asked to do there, or for a summary of a thread with many messages. Read-only.
---

# WhatsApp group catch-up

Deliverable: decisions, dates, and what is asked of the user, in that order, with the chatter gone. A 300-message thread should compress to a screen.

## Load the whole window

1. Pass the group's name as `chat_id` to `read_messages`: it reads the one group that name means, and the answer's `resolved` says which. A `CHAT_NOT_FOUND` with `candidates` means two chats share the name: ask which, never pick. (`list_chats` `filter: "groups"` lists them too.) `get_group_info` once for the participant names and who the admins are; use names, not numbers, in the summary.
2. `read_messages` with `limit: 200` and the window the user asked for as `since` (and `until`), ISO dates or times like `search` takes: "this week" is `since: "<Monday's date>"`. When the answer says `more_in_window`, call again with `before` set to the oldest `message_id` and the same window, until it no longer does. A note that the chat's stored history starts inside the window means `before` with the same `since` asks the phone for the rest. Without a window, page with `before` until the oldest message you hold is older than the window, or WhatsApp returns no more.
3. Note which messages quote or mention the user: `quoted.sender` equal to the user, the user's name in `text`, or `sender` addressing them directly. These are the **asks**.

## Extract

Work through the messages once and collect:

- **Decisions**: something agreed or announced by an admin or by the people it concerns ("ok, Saturday at 10 then").
- **Dates and deadlines**: any concrete day, time, or "by Friday", with what it is for.
- **Asks of the user**: every mention or reply to them, plus open questions nobody answered that fall on the user. A `call` message in the group after one of these, with `call.outcome` `answered`, means the user was on that group call: say so and treat the ask as probably handled, the way `whatsapp-inbox` does.
- **Open threads**: questions still without an answer, for anyone.
- **Polls and events**: the question and the result from `poll.options`, each option with its `votes` and its `voters` by name; for an event, who is going, maybe or not going from `event_responses`. These are the votes that reached this device, so a result reads as "so far", never as final.
- **Who joined, left or changed what**: group notices read as `[Medeea added Ana (40723124956)]`, with `system.actor` and `system.targets` naming the people. Report them from there; a notice that names no target says so, and a new member is never paired with whoever happened to post nearby.

Skip greetings, reactions, stickers, and messages that only acknowledge.

## Report

```
Bloc 12 — 312 messages since Monday

Decided
- Roof repair goes to Tehnoplast, 18,400 lei, vote closed Wednesday.
- Water off Thursday 09:00–13:00.

Dates
- Fri 15 Mar: pay share (1,150 lei) to the association account.

You
- Mihai asked (Tue) if you can be home Thursday for the plumber. Unanswered.

Open
- Nobody confirmed who holds the basement key.
```

End with the message count and the window covered, so the user knows what the summary stands on. Replying in the group is the `whatsapp-send` skill's job; here, offer it only for the *You* items.
