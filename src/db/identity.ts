/**
 * Who and where: contacts (one row per person, phone jid and lid together),
 * the lid -> number pairings learned, chats under the canonical jid of their
 * person, the resolution of any sid spelling to its stored message, and what
 * the user filed about people and threads (notes, tags, fields, handled marks).
 *
 * The pairing rules are main's LidRegistry, table for table: a lid answers for
 * the number it was last learned with; a lid that moves to a new number stops
 * answering for the old one; a number that gains a new lid leaves its older
 * lid answering for it. The canonical jid of a direct chat or contact is the
 * number once a pairing names one, the lid until then.
 */
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";
import { chatFromRow, contactFromRow, type ChatRow, type ContactRow } from "./rows.js";
import type {
  ChatInput,
  ChatKind,
  ChatRecord,
  ContactInput,
  ContactNotes,
  ContactRecord,
  FieldEdit,
  HandledRecord,
} from "./types.js";

export function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid") || jid.endsWith("@hosted.lid");
}

export function chatKindOf(jid: string): ChatKind {
  if (jid === "status@broadcast") return "status";
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@newsletter")) return "newsletter";
  if (jid.endsWith("@broadcast")) return "broadcast";
  return "direct";
}

/**
 * The one spelling of a jid the store keys by, as main's resolveChatId writes
 * it: no device (`40700000001:12@s.whatsapp.net`), a lowercase server,
 * `@c.us` and `@hosted` as `@s.whatsapp.net`, and every lid server as `@lid`.
 */
export function normalizeJid(jid: string): string {
  const trimmed = jid.trim();
  const at = trimmed.lastIndexOf("@");
  if (at === -1) return trimmed;
  const user = trimmed.slice(0, at).split(":")[0]!;
  const server = trimmed.slice(at + 1).toLowerCase();
  const canonical = server === "hosted.lid" ? "lid" : server === "c.us" || server === "hosted" ? "s.whatsapp.net" : server;
  return `${user}@${canonical}`;
}

export function sidOf(fromMe: boolean, chatJid: string, keyId: string): string {
  return `${fromMe}_${chatJid}_${keyId}`;
}

/** Same grammar as message-ref.ts: `<true|false>_<chat jid>_<stanza id>`, or `<chat jid>_<stanza id>` with no direction. */
const FULL_SID = /^(true|false)_([^_\s]+@[^_\s]+)_(.+)$/s;
const BARE_SID = /^([^_\s]+@[^_\s]+)_(.+)$/s;

export function parseSid(sid: string): { fromMe: boolean | null; chatJid: string; keyId: string } | null {
  const full = FULL_SID.exec(sid);
  if (full !== null) return { fromMe: full[1] === "true", chatJid: full[2]!, keyId: full[3]! };
  const bare = BARE_SID.exec(sid);
  return bare === null ? null : { fromMe: null, chatJid: bare[1]!, keyId: bare[2]! };
}

/** The columns every write decision about an existing message needs, and no content. */
export interface MessageKey {
  id: number;
  /** The row's own chat, which differs from `chat.id` while that chat is folding into another. */
  chat_id: number;
  key_id: string;
  from_me: number;
  ts: number;
  edited_at: number | null;
  expires_at: number | null;
  deleted_at: number | null;
  /** The clear barrier of the row's own chat. */
  cleared_through_ts: number | null;
  /** The chat a reader sees the message in. */
  chat: ChatRecord;
  /** The sid over that chat's canonical jid. */
  sid: string;
}

const KEY_COLUMNS =
  "m.id, m.chat_id, m.key_id, m.from_me, m.ts, m.edited_at, m.expires_at, m.deleted_at, c.cleared_through_ts";

interface NotesRow {
  note: string | null;
  tags: string | null;
  fields: string | null;
  updated_at: number;
}

function notesFromRow(row: NotesRow): ContactNotes {
  return {
    note: row.note,
    tags: row.tags === null ? [] : (JSON.parse(row.tags) as string[]),
    fields: row.fields === null ? {} : (JSON.parse(row.fields) as Record<string, string>),
    updatedAt: row.updated_at,
  };
}

export class Identity {
  constructor(private readonly c: Connection) {}

  /** The number a lid was last learned with, or null. */
  phoneOfLid(lid: string): string | null {
    return this.c.get<{ phone_jid: string }>("SELECT phone_jid FROM lid_phones WHERE lid = ?", normalizeJid(lid))?.phone_jid ?? null;
  }

  /** The id wazap hands out: the number once a pairing names it, the lid until then, anything else as it is. */
  canonicalJid(jid: string): string {
    const normalized = normalizeJid(jid);
    return isLidJid(normalized) ? (this.phoneOfLid(normalized) ?? normalized) : normalized;
  }

  /** Every lid -> number pairing, in the order it was learned: what an in-memory registry replays. */
  lidPairs(): Array<[lid: string, phoneJid: string]> {
    return this.c
      .all<{ lid: string; phone_jid: string }>("SELECT lid, phone_jid FROM lid_phones ORDER BY learned_at, lid")
      .map((row) => [row.lid, row.phone_jid]);
  }

  /**
   * Every person, with what the user filed about them, in the address book's
   * order (then everyone else, by when they were first seen); a merging row
   * is not listed twice. Bounded by people, not messages.
   */
  listContacts(): Array<{ contact: ContactRecord; notes: ContactNotes | null }> {
    return this.c
      .all<ContactRow & { note: string | null; tags: string | null; fields: string | null; notes_updated_at: number | null }>(
        `SELECT k.*, n.note, n.tags, n.fields, n.updated_at AS notes_updated_at
         FROM contacts k LEFT JOIN contact_notes n ON n.contact_id = k.id
         WHERE k.merged_into IS NULL ORDER BY k.listed IS NULL, k.listed, k.id`
      )
      .map((row) => ({
        contact: contactFromRow(row),
        notes:
          row.notes_updated_at === null
            ? null
            : notesFromRow({ note: row.note, tags: row.tags, fields: row.fields, updated_at: row.notes_updated_at }),
      }));
  }

  /** Every chat that is not folding into another, with or without messages. Bounded by chats, not messages. */
  listChats(): ChatRecord[] {
    return this.c.all<ChatRow>("SELECT * FROM chats WHERE merged_into IS NULL ORDER BY id").map(chatFromRow);
  }

  contactById(id: number): ContactRecord | null {
    const row = this.c.get<ContactRow>("SELECT * FROM contacts WHERE id = ?", id);
    return row === undefined ? null : contactFromRow(row);
  }

  contactIdOf(jid: string): number | null {
    const canonical = this.canonicalJid(jid);
    const row = isLidJid(canonical)
      ? this.c.get<{ id: number }>("SELECT id FROM contacts WHERE lid = ? AND phone_jid IS NULL", canonical)
      : this.c.get<{ id: number }>("SELECT id FROM contacts WHERE phone_jid = ?", canonical);
    return row?.id ?? null;
  }

  /** The contact and every row still merging into it: what a sender filter must match. */
  contactIdsOf(jid: string): number[] {
    const id = this.contactIdOf(jid);
    if (id === null) return [];
    return [id, ...this.c.all<{ id: number }>("SELECT id FROM contacts WHERE merged_into = ?", id).map((row) => row.id)];
  }

  /** The direct chats of the people filed under `tag`, with every chat still folding into one of them. */
  chatIdsTagged(tag: string): number[] {
    return this.c
      .all<{ id: number }>(
        `SELECT c.id FROM chats c CROSS JOIN chats p ON p.id = coalesce(c.merged_into, c.id)
         CROSS JOIN contacts k ON k.id = p.contact_id
         WHERE p.kind = 'direct' AND coalesce(k.merged_into, k.id) IN
           (SELECT n.contact_id FROM contact_notes n, json_each(n.tags) t WHERE t.value = ?)`,
        tag
      )
      .map((row) => row.id);
  }

  contact(jid: string): ContactRecord | null {
    const id = this.contactIdOf(jid);
    return id === null ? null : this.contactById(id);
  }

  ensureContact(jid: string): number {
    const found = this.contactIdOf(jid);
    if (found !== null) return found;
    const canonical = this.canonicalJid(jid);
    const column = isLidJid(canonical) ? "lid" : "phone_jid";
    return this.c.write(
      () =>
        this.c.get<{ id: number }>(`INSERT INTO contacts(${column}, updated_at) VALUES (?, ?) RETURNING id`, canonical, this.c.now())!
          .id
    );
  }

  upsertContact(input: ContactInput): ContactRecord {
    return this.c.write(() => {
      const id = this.ensureContact(input.jid);
      const sets: string[] = [];
      const values: Array<string | number | null> = [];
      const assign = (column: string, value: string | number | null | undefined): void => {
        if (value === undefined) return;
        sets.push(`${column} = ?`);
        values.push(value);
      };
      assign("name", input.name);
      assign("notify", input.notify);
      assign("push_name", input.pushName);
      assign("verified_name", input.verifiedName);
      assign("is_business", input.isBusiness === undefined ? undefined : input.isBusiness === null ? null : input.isBusiness ? 1 : 0);
      if (input.listed === true) {
        const current = this.c.get<{ listed: number | null }>("SELECT listed FROM contacts WHERE id = ?", id)?.listed ?? null;
        if (current === null) {
          const last = this.c.get<{ n: number | null }>("SELECT max(listed) AS n FROM contacts WHERE listed IS NOT NULL")?.n ?? 0;
          sets.push("listed = ?");
          values.push(last + 1);
        }
      }
      else if (typeof input.listed === "number") {
        sets.push("listed = min(coalesce(listed, ?), ?)");
        values.push(input.listed, input.listed);
      }
      if (sets.length > 0) {
        this.c.run(`UPDATE contacts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...values, this.c.now(), id);
      }
      return this.contactById(id)!;
    });
  }

  chatById(id: number): ChatRecord | null {
    const row = this.c.get<ChatRow>("SELECT * FROM chats WHERE id = ?", id);
    return row === undefined ? null : chatFromRow(row);
  }

  /**
   * A chat by any spelling: the canonical jid first, then the jid as given. A
   * chat folding into another answers as the chat it folds into — but only
   * under its own canonical jid: a lid that moved to another number while its
   * old chat was still folding into the old number's chat no longer answers
   * for that chat, so its new messages start the new number's chat instead.
   */
  chat(jid: string): ChatRecord | null {
    const normalized = normalizeJid(jid);
    const canonical = chatKindOf(normalized) === "direct" ? this.canonicalJid(normalized) : normalized;
    const row = this.c.get<ChatRow>("SELECT * FROM chats WHERE jid = ?", canonical);
    if (row !== undefined) return row.merged_into === null ? chatFromRow(row) : this.chatById(row.merged_into);
    if (canonical === normalized) return null;
    const spelled = this.c.get<ChatRow>("SELECT * FROM chats WHERE jid = ? AND merged_into IS NULL", normalized);
    return spelled === undefined ? null : chatFromRow(spelled);
  }

  /** The chat and every chat still folding into it: where its messages may sit right now. */
  chatIdsOf(chat: ChatRecord): number[] {
    return [chat.id, ...this.c.all<{ id: number }>("SELECT id FROM chats WHERE merged_into = ?", chat.id).map((row) => row.id)];
  }

  /** The chat for `jid`, created under its canonical jid when unknown. */
  ensureChat(jid: string, kind?: ChatKind): ChatRecord {
    const existing = this.chat(jid);
    if (existing !== null) return existing;
    return this.c.write(() => {
      const normalized = normalizeJid(jid);
      const chatKind = kind ?? chatKindOf(normalized);
      const canonical = chatKind === "direct" ? this.canonicalJid(normalized) : normalized;
      const contactId = chatKind === "direct" ? this.ensureContact(canonical) : null;
      const row = this.c.get<ChatRow>(
        "INSERT INTO chats(jid, kind, contact_id) VALUES (?, ?, ?) RETURNING *",
        canonical,
        chatKind,
        contactId
      )!;
      return chatFromRow(row);
    });
  }

  upsertChat(input: ChatInput): ChatRecord {
    return this.c.write(() => {
      const chat = this.ensureChat(input.jid, input.kind);
      const sets: string[] = [];
      const values: Array<string | number | Uint8Array | null> = [];
      const assign = (column: string, value: string | number | Uint8Array | null | undefined): void => {
        if (value === undefined) return;
        sets.push(`${column} = ?`);
        values.push(value);
      };
      assign("name", input.name);
      assign("archived", input.archived === undefined ? undefined : input.archived ? 1 : 0);
      assign("pinned", input.pinned);
      assign("muted_until", input.mutedUntil);
      assign("unread", input.unread);
      assign("proto", input.proto);
      if (sets.length > 0) this.c.run(`UPDATE chats SET ${sets.join(", ")} WHERE id = ?`, ...values, chat.id);
      return this.chatById(chat.id)!;
    });
  }

  /**
   * The stored message with this chat, direction and key, wherever a fold has
   * it right now. While a fold is still moving rows, one message can sit under
   * both spellings; a tombstone on either side is the one that answers, as
   * the fold itself will decide, so a delete reads as done before it lands.
   */
  findByKey(chat: ChatRecord, fromMe: boolean, keyId: string): MessageKey | null {
    let found: MessageKey | null = null;
    for (const chatId of this.chatIdsOf(chat)) {
      const row = this.c.get<Omit<MessageKey, "chat" | "sid">>(
        `SELECT ${KEY_COLUMNS} FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE m.chat_id = ? AND m.from_me = ? AND m.key_id = ?`,
        chatId,
        fromMe ? 1 : 0,
        keyId
      );
      if (row === undefined) continue;
      const key = { ...row, chat, sid: sidOf(fromMe, chat.jid, keyId) };
      if (key.deleted_at !== null) return key;
      found ??= key;
    }
    return found;
  }

  /**
   * The stored message a sid names, in any spelling: the chat part resolves
   * through the pairings to the chat, and the message is that chat's
   * direction and key. A sid without a direction tries both.
   */
  findMessage(sid: string): MessageKey | null {
    const parsed = parseSid(sid);
    if (parsed === null) return null;
    const chat = this.chat(parsed.chatJid);
    if (chat === null) return null;
    for (const fromMe of parsed.fromMe === null ? [true, false] : [parsed.fromMe]) {
      const found = this.findByKey(chat, fromMe, parsed.keyId);
      if (found !== null) return found;
    }
    return null;
  }

  notes(jid: string): ContactNotes | null {
    const id = this.contactIdOf(jid);
    if (id === null) return null;
    const row = this.c.get<NotesRow>("SELECT note, tags, fields, updated_at FROM contact_notes WHERE contact_id = ?", id);
    return row === undefined ? null : notesFromRow(row);
  }

  /** An empty note clears it; a contact left with no note, tags or fields loses the row. */
  setNote(jid: string, note: string): ContactNotes | null {
    return this.c.write(() => {
      const trimmed = note.trim();
      const current = this.notes(jid);
      return this.saveNotes(jid, trimmed === "" ? null : trimmed, current?.tags ?? [], current?.fields ?? {});
    });
  }

  updateFields(jid: string, edit: FieldEdit): ContactNotes | null {
    return this.c.write(() => {
      const current = this.notes(jid);
      const tags = new Set(current?.tags ?? []);
      for (const tag of edit.removeTags ?? []) tags.delete(tag);
      for (const tag of edit.addTags ?? []) tags.add(tag);
      const fields = { ...(current?.fields ?? {}) };
      for (const key of edit.removeFields ?? []) delete fields[key];
      Object.assign(fields, edit.set ?? {});
      return this.saveNotes(jid, current?.note ?? null, [...tags], fields);
    });
  }

  private saveNotes(jid: string, note: string | null, tags: string[], fields: Record<string, string>): ContactNotes | null {
    const id = this.ensureContact(jid);
    return this.writeNotes(id, note, tags, fields);
  }

  /** Stores notes on a contact row; the merge path writes through here too. Call inside write(). */
  writeNotes(contactId: number, note: string | null, tags: string[], fields: Record<string, string>): ContactNotes | null {
    if (note === null && tags.length === 0 && Object.keys(fields).length === 0) {
      this.c.run("DELETE FROM contact_notes WHERE contact_id = ?", contactId);
      return null;
    }
    const at = this.c.now();
    this.c.run(
      `INSERT INTO contact_notes(contact_id, note, tags, fields, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(contact_id) DO UPDATE SET note = excluded.note, tags = excluded.tags, fields = excluded.fields,
         updated_at = excluded.updated_at`,
      contactId,
      note,
      tags.length === 0 ? null : JSON.stringify(tags),
      Object.keys(fields).length === 0 ? null : JSON.stringify(fields),
      at
    );
    return { note, tags, fields, updatedAt: at };
  }

  notesById(contactId: number): ContactNotes | null {
    const row = this.c.get<NotesRow>("SELECT note, tags, fields, updated_at FROM contact_notes WHERE contact_id = ?", contactId);
    return row === undefined ? null : notesFromRow(row);
  }

  /**
   * "I dealt with that": the ask open now is handled. A message from them after
   * the ask reopens the chat; the user's own and system notices do not.
   */
  markHandled(chatJid: string, askSid: string | null, at: number = this.c.now()): HandledRecord {
    return this.c.write(() => {
      const chat = this.ensureChat(chatJid);
      const ask = askSid === null ? null : this.findMessage(askSid);
      if (askSid !== null && ask === null) {
        throw new StorageError("INVALID_INPUT", `No stored message is filed under ${askSid}.`);
      }
      this.c.run(
        `INSERT INTO handled(chat_id, ask_message_id, at) VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET ask_message_id = excluded.ask_message_id, at = excluded.at`,
        chat.id,
        ask?.id ?? null,
        at
      );
      return { askMessageId: ask?.id ?? null, askSid: ask?.sid ?? null, at };
    });
  }

  handled(chatJid: string): HandledRecord | null {
    const chat = this.chat(chatJid);
    return chat === null ? null : this.handledByChatId(chat.id);
  }

  handledByChatId(chatId: number): HandledRecord | null {
    const row = this.c.get<{ ask_message_id: number | null; from_me: number | null; key_id: string | null; jid: string; at: number }>(
      `SELECT h.ask_message_id, m.from_me, m.key_id, c.jid, h.at
       FROM handled h JOIN chats c ON c.id = h.chat_id LEFT JOIN messages m ON m.id = h.ask_message_id WHERE h.chat_id = ?`,
      chatId
    );
    if (row === undefined) return null;
    const askSid = row.key_id === null ? null : sidOf(row.from_me === 1, row.jid, row.key_id);
    return { askMessageId: row.ask_message_id, askSid, at: row.at };
  }
}
