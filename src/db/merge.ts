/**
 * Learning that a lid and a number are one person.
 *
 * The pairing itself is synchronous: `learnLidPhone` records it, applies
 * main's LidRegistry rules to the contact rows and folds a lid chat into the
 * number's chat before it returns, so the very next write under either
 * spelling lands on the right person. Only moving what a fold leaves behind —
 * a merged contact's references, a lid chat's messages — runs in chunks,
 * with the event loop turning between them.
 *
 * The rules, from src/identity.ts on main:
 * - a lid answers for the number it was last learned with;
 * - a lid that moves to a new number stops answering for the old one, and
 *   nothing the old number holds moves: history, notes and chats stay with it;
 * - a number that gains a new lid leaves its older lid answering for it.
 * So the only rows ever merged are a person known only by a lid and the same
 * person known by the number that lid now pairs with.
 *
 * What a merge keeps, deterministically:
 * - the older contact id survives (ids already handed out stay valid);
 * - names: the number's row wins, the lid's row fills gaps;
 * - note: both, the number's first, joined by a newline when they differ;
 * - tags: the sorted union;
 * - fields: the union; a field both rows set differently keeps both values as
 *   "<number's value> | <lid's value>".
 *
 * Nothing needs a separate record to survive a crash: a contact or chat row
 * with `merged_into` set is the pending work, and `resumeMerges()` drains it.
 */
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";
import { chatKindOf, isLidJid, normalizeJid, type Identity } from "./identity.js";
import { statusRank, type Messages } from "./messages.js";
import { RECOMPUTE_LAST, type ChatRow, type ContactRow } from "./rows.js";
import type { ContactNotes, MergeReport } from "./types.js";
import { contentHash } from "./vectors.js";

/** How the two note records of one person combine. Exported for the tests that pin the rule. */
export function mergeNotes(numberSide: ContactNotes | null, lidSide: ContactNotes | null): {
  note: string | null;
  tags: string[];
  fields: Record<string, string>;
} {
  const notes = [numberSide?.note, lidSide?.note].filter((note): note is string => typeof note === "string" && note !== "");
  const note = notes.length === 0 ? null : [...new Set(notes)].join("\n");
  const tags = [...new Set([...(numberSide?.tags ?? []), ...(lidSide?.tags ?? [])])].sort();
  const fields: Record<string, string> = {};
  for (const key of [...new Set([...Object.keys(numberSide?.fields ?? {}), ...Object.keys(lidSide?.fields ?? {})])].sort()) {
    const values = [numberSide?.fields[key], lidSide?.fields[key]].filter((value): value is string => value !== undefined);
    fields[key] = [...new Set(values)].join(" | ");
  }
  return { note, tags, fields };
}

export class Merger {
  constructor(
    private readonly c: Connection,
    private readonly identity: Identity,
    private readonly messages: Messages
  ) {}

  learnLidPhone(lid: string, phoneJid: string): Promise<MergeReport> {
    const l = normalizeJid(lid);
    const p = normalizeJid(phoneJid);
    if (!isLidJid(l) || isLidJid(p) || chatKindOf(l) !== "direct" || chatKindOf(p) !== "direct") {
      return Promise.reject(new StorageError("INVALID_INPUT", `Expected a lid and a phone jid, got ${lid} and ${phoneJid}.`));
    }
    let paired: { contactId: number; chatId: number | null };
    try {
      paired = this.c.write(() => this.pair(l, p));
    } catch (err) {
      return Promise.reject(err);
    }
    return this.c.bulk(async () => {
      const report: MergeReport = { contactId: paired.contactId, chatId: paired.chatId, movedMessages: 0, mediaPaths: [] };
      await this.drain(report);
      return report;
    });
  }

  /** Finishes every fold a crash or a close interrupted; call once after opening. */
  resumeMerges(): Promise<MergeReport> {
    this.c.assertWritable();
    return this.c.bulk(async () => {
      const report: MergeReport = { contactId: null, chatId: null, movedMessages: 0, mediaPaths: [] };
      await this.drain(report);
      return report;
    });
  }

  /** The synchronous half: the pairing, the contact rows and the chat rows. Runs inside write(). */
  private pair(lid: string, phone: string): { contactId: number; chatId: number | null } {
    const now = this.c.now();
    this.c.run(
      `INSERT INTO lid_phones(lid, phone_jid, learned_at) VALUES (?, ?, ?)
       ON CONFLICT(lid) DO UPDATE SET phone_jid = excluded.phone_jid, learned_at = excluded.learned_at`,
      lid,
      phone,
      now
    );
    // A lid that moved stops answering for the number it left.
    this.c.run("UPDATE contacts SET lid = NULL, updated_at = ? WHERE lid = ? AND phone_jid IS NOT NULL AND phone_jid != ?", now, lid, phone);

    const byPhone = this.c.get<ContactRow>("SELECT * FROM contacts WHERE phone_jid = ?", phone);
    const byLid = this.c.get<ContactRow>("SELECT * FROM contacts WHERE lid = ? AND phone_jid IS NULL", lid);
    let contactId: number;
    if (byPhone !== undefined && byLid !== undefined) {
      contactId = this.mergeContacts(byPhone, byLid, lid, phone, now);
    } else if (byPhone !== undefined) {
      contactId = byPhone.id;
      if (byPhone.lid !== lid) this.c.run("UPDATE contacts SET lid = ?, updated_at = ? WHERE id = ?", lid, now, contactId);
    } else if (byLid !== undefined) {
      contactId = byLid.id;
      this.c.run("UPDATE contacts SET phone_jid = ?, updated_at = ? WHERE id = ?", phone, now, contactId);
    } else {
      contactId = this.c.get<{ id: number }>(
        "INSERT INTO contacts(phone_jid, lid, updated_at) VALUES (?, ?, ?) RETURNING id",
        phone,
        lid,
        now
      )!.id;
    }

    const lidChat = this.c.get<ChatRow>("SELECT * FROM chats WHERE jid = ? AND merged_into IS NULL", lid);
    const phoneChat = this.c.get<ChatRow>("SELECT * FROM chats WHERE jid = ? AND merged_into IS NULL", phone);
    if (lidChat !== undefined && phoneChat !== undefined) {
      this.c.run("UPDATE chats SET merged_into = ? WHERE id = ? OR merged_into = ?", phoneChat.id, lidChat.id, lidChat.id);
      this.shareBarrier(phoneChat.id);
      // The number's chat lists and waits as the whole fold from now on, not only its own rows.
      this.c.run(RECOMPUTE_LAST, phoneChat.id);
    } else if (lidChat !== undefined) {
      this.c.run("UPDATE chats SET jid = ? WHERE id = ?", phone, lidChat.id);
    }
    const chatId = phoneChat?.id ?? lidChat?.id ?? null;
    if (chatId !== null) this.c.run("UPDATE chats SET contact_id = ? WHERE id = ?", contactId, chatId);
    return { contactId, chatId };
  }

  /**
   * A chat and every chat folding into it read as one, so they share the
   * latest clear barrier among them, and each one's last message is recomputed
   * under it. Call inside write().
   */
  private shareBarrier(keepId: number): void {
    const family = this.c.all<{ id: number; cleared_through_ts: number | null }>(
      "SELECT id, cleared_through_ts FROM chats WHERE id = ? OR merged_into = ?",
      keepId,
      keepId
    );
    const barrier = Math.max(0, ...family.map((chat) => chat.cleared_through_ts ?? 0));
    if (barrier === 0) return;
    for (const chat of family) {
      if (chat.cleared_through_ts === barrier) continue;
      this.c.run("UPDATE chats SET cleared_through_ts = ? WHERE id = ?", barrier, chat.id);
      this.c.run(RECOMPUTE_LAST, chat.id);
    }
  }

  /** One person's two rows become one; references move later, in chunks. Returns the survivor. */
  private mergeContacts(byPhone: ContactRow, byLid: ContactRow, lid: string, phone: string, now: number): number {
    const keep = Math.min(byPhone.id, byLid.id);
    const drop = Math.max(byPhone.id, byLid.id);
    const merged = mergeNotes(this.identity.notesById(byPhone.id), this.identity.notesById(byLid.id));
    this.c.run("DELETE FROM contact_notes WHERE contact_id IN (?, ?)", keep, drop);
    this.identity.writeNotes(keep, merged.note, merged.tags, merged.fields);
    this.c.run("UPDATE contacts SET phone_jid = NULL, lid = NULL, merged_into = ?, updated_at = ? WHERE id = ?", keep, now, drop);
    this.c.run("UPDATE contacts SET merged_into = ? WHERE merged_into = ?", keep, drop);
    this.c.run(
      `UPDATE contacts SET phone_jid = ?, lid = ?, name = ?, notify = ?, push_name = ?, verified_name = ?, is_business = ?,
         listed = ?, updated_at = ?
       WHERE id = ?`,
      phone,
      lid,
      byPhone.name ?? byLid.name,
      byPhone.notify ?? byLid.notify,
      byPhone.push_name ?? byLid.push_name,
      byPhone.verified_name ?? byLid.verified_name,
      byPhone.is_business ?? byLid.is_business,
      // The earlier of the two places in the address book.
      byPhone.listed === null || byLid.listed === null ? (byPhone.listed ?? byLid.listed) : Math.min(byPhone.listed, byLid.listed),
      now,
      keep
    );
    this.c.run("UPDATE chats SET contact_id = ? WHERE contact_id = ?", keep, drop);
    return keep;
  }

  /** Moves everything pending folds left behind, then removes the folded rows. Runs inside bulk(). */
  private async drain(report: MergeReport): Promise<void> {
    for (;;) {
      const contact = this.c.get<{ id: number; merged_into: number }>(
        "SELECT id, merged_into FROM contacts WHERE merged_into IS NOT NULL ORDER BY id LIMIT 1"
      );
      if (contact === undefined) break;
      await this.c.chunked(() => this.moveContactRefs(contact.merged_into, contact.id, this.c.chunkSize));
      this.c.write(() => {
        this.moveContactRefs(contact.merged_into, contact.id, null);
        this.c.run("DELETE FROM contacts WHERE id = ?", contact.id);
      });
    }
    for (;;) {
      const chat = this.c.get<{ id: number; merged_into: number }>(
        "SELECT id, merged_into FROM chats WHERE merged_into IS NOT NULL ORDER BY id LIMIT 1"
      );
      if (chat === undefined) break;
      await this.foldChat(chat.merged_into, chat.id, report);
    }
  }

  /**
   * One chunk of references from `drop` to `keep`; `limit` null moves the
   * rest at once (the final pass, for rows that arrived between chunks). Where
   * both rows reacted, voted or got a receipt on one message, the newer
   * reaction or vote wins and receipts keep the latest times.
   */
  private moveContactRefs(keep: number, drop: number, limit: number | null): boolean {
    const cap = limit ?? -1;
    let more = false;
    const moved = this.c.run(
      "UPDATE messages SET sender_id = ? WHERE id IN (SELECT id FROM messages WHERE sender_id = ? LIMIT ?)",
      keep,
      drop,
      cap
    );
    more ||= limit !== null && moved === limit;

    for (const table of ["reactions", "votes"] as const) {
      const ids = this.c
        .all<{ message_id: number }>(`SELECT message_id FROM ${table} WHERE contact_id = ? LIMIT ?`, drop, cap)
        .map((row) => row.message_id);
      if (ids.length === 0) continue;
      const json = JSON.stringify(ids);
      this.c.run(
        `DELETE FROM ${table} WHERE contact_id = ? AND message_id IN (SELECT value FROM json_each(?))
           AND ts < (SELECT d.ts FROM ${table} d WHERE d.contact_id = ? AND d.message_id = ${table}.message_id)`,
        keep,
        json,
        drop
      );
      this.c.run(
        `DELETE FROM ${table} WHERE contact_id = ? AND message_id IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM ${table} k WHERE k.contact_id = ? AND k.message_id = ${table}.message_id)`,
        drop,
        json,
        keep
      );
      this.c.run(
        `UPDATE ${table} SET contact_id = ? WHERE contact_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
        keep,
        drop,
        json
      );
      more ||= limit !== null && ids.length === limit;
    }

    const receiptIds = this.c
      .all<{ message_id: number }>("SELECT message_id FROM receipts WHERE contact_id = ? LIMIT ?", drop, cap)
      .map((row) => row.message_id);
    if (receiptIds.length > 0) {
      const json = JSON.stringify(receiptIds);
      this.c.run(
        `UPDATE receipts AS k SET
           delivered_at = coalesce(max(k.delivered_at, d.delivered_at), k.delivered_at, d.delivered_at),
           read_at = coalesce(max(k.read_at, d.read_at), k.read_at, d.read_at),
           played_at = coalesce(max(k.played_at, d.played_at), k.played_at, d.played_at)
         FROM receipts AS d
         WHERE k.contact_id = ? AND d.contact_id = ? AND d.message_id = k.message_id
           AND d.message_id IN (SELECT value FROM json_each(?))`,
        keep,
        drop,
        json
      );
      this.c.run(
        `DELETE FROM receipts WHERE contact_id = ? AND message_id IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM receipts k WHERE k.contact_id = ? AND k.message_id = receipts.message_id)`,
        drop,
        json,
        keep
      );
      this.c.run(
        "UPDATE receipts SET contact_id = ? WHERE contact_id = ? AND message_id IN (SELECT value FROM json_each(?))",
        keep,
        drop,
        json
      );
      more ||= limit !== null && receiptIds.length === limit;
    }
    return more;
  }

  /**
   * A lid chat folding into the number's chat: rows under the shared barrier
   * go, the messages move over, then the lid chat's row merges into the
   * number's and disappears.
   */
  private async foldChat(keepId: number, dropId: number, report: MergeReport): Promise<void> {
    this.c.write(() => this.shareBarrier(keepId));
    for (const chatId of [keepId, dropId]) {
      report.mediaPaths.push(...(await this.messages.purgeCleared(chatId)).mediaPaths);
    }

    await this.c.chunked(() => this.moveChunk(keepId, dropId, report, this.c.chunkSize));
    this.c.write(() => {
      while (this.moveChunk(keepId, dropId, report, this.c.chunkSize));
      const drop = this.c.get<ChatRow>("SELECT * FROM chats WHERE id = ?", dropId)!;
      this.c.run(
        `UPDATE chats SET name = coalesce(name, ?), pinned = coalesce(pinned, ?), muted_until = coalesce(muted_until, ?),
           unread = unread + ?, proto = coalesce(proto, ?), archived = CASE WHEN ? = 0 THEN 0 ELSE archived END,
           cleared_through_ts = CASE WHEN ? IS NULL THEN cleared_through_ts
             ELSE max(coalesce(cleared_through_ts, 0), ?) END
         WHERE id = ?`,
        drop.name,
        drop.pinned,
        drop.muted_until,
        drop.unread,
        drop.proto,
        drop.archived,
        drop.cleared_through_ts,
        drop.cleared_through_ts,
        keepId
      );
      const handled = this.c.all<{ ask_message_id: number | null; at: number }>(
        "SELECT ask_message_id, at FROM handled WHERE chat_id IN (?, ?) ORDER BY at DESC",
        keepId,
        dropId
      );
      if (handled.length > 0) {
        this.c.run(
          `INSERT INTO handled(chat_id, ask_message_id, at) VALUES (?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET ask_message_id = excluded.ask_message_id, at = excluded.at`,
          keepId,
          handled[0]!.ask_message_id,
          handled[0]!.at
        );
      }
      this.c.run("UPDATE chats SET contact_id = coalesce(contact_id, ?) WHERE id = ?", drop.contact_id, keepId);
      this.c.run("UPDATE OR IGNORE retracted SET chat_id = ? WHERE chat_id = ?", keepId, dropId);
      this.c.run("DELETE FROM retracted WHERE chat_id = ?", dropId);
      this.c.run("DELETE FROM chats WHERE id = ?", dropId);
      this.c.run(RECOMPUTE_LAST, keepId);
    });
    // A clear of either spelling that landed while the fold ran may have raised the barrier since the first purge.
    report.mediaPaths.push(...(await this.messages.purgeCleared(keepId)).mediaPaths);
  }

  /** Moves up to `limit` messages from the folding chat into the number's chat; true while more remain. */
  private moveChunk(keepId: number, dropId: number, report: MergeReport, limit: number): boolean {
    const rows = this.c.all<{ id: number; from_me: number; key_id: string }>(
      "SELECT id, from_me, key_id FROM messages WHERE chat_id = ? ORDER BY id LIMIT ?",
      dropId,
      limit
    );
    for (const row of rows) {
      const twin = this.c.get<{ id: number }>(
        "SELECT id FROM messages WHERE chat_id = ? AND from_me = ? AND key_id = ?",
        keepId,
        row.from_me,
        row.key_id
      );
      if (twin === undefined) {
        this.c.run("UPDATE messages SET chat_id = ? WHERE id = ?", keepId, row.id);
      } else {
        this.mergeTwin(twin.id, row.id, report);
      }
      report.movedMessages++;
    }
    return rows.length === limit;
  }

  /**
   * One message filed under both spellings. The number's row survives and
   * takes the other row under the upsert rules: a tombstone on either side
   * wins; otherwise the newer edit's content wins, the older row fills gaps,
   * a transcript is never lost, status only rises, expiry only falls, flags
 * are the union of both.
   * Reactions, votes and receipts move with their own merge rules, derived
   * files move unless the survivor has its own of that kind, and the
   * embedding moves when it still describes the survivor's words. Only a file
   * no row references any more is handed back to unlink.
   */
  private mergeTwin(keepId: number, dropId: number, report: MergeReport): void {
    type Twin = {
      id: number; type: string; quoted_sid: string | null; quoted_from_me: number | null; quoted_key_id: string | null;
      status: number | null; edited_at: number | null;
      expires_at: number | null; observed_expires_at: number | null; deleted_at: number | null; sender_id: number | null;
      text: string | null; transcript: string | null; transcript_info: string | null; raw: Uint8Array | null; content_hash: string | null; flags: number;
    };
    const columns =
      "id, type, quoted_sid, quoted_from_me, quoted_key_id, status, edited_at, expires_at, observed_expires_at, deleted_at, sender_id, text, transcript, transcript_info, raw, content_hash, flags";
    const keep = this.c.get<Twin>(`SELECT ${columns} FROM messages WHERE id = ?`, keepId)!;
    const drop = this.c.get<Twin>(`SELECT ${columns} FROM messages WHERE id = ?`, dropId)!;

    if (drop.observed_expires_at !== null) {
      this.c.run(
        "UPDATE messages SET observed_expires_at = ? WHERE id = ? AND (observed_expires_at IS NULL OR observed_expires_at > ?)",
        drop.observed_expires_at, keepId, drop.observed_expires_at
      );
    }

    if (keep.deleted_at !== null || drop.deleted_at !== null) {
      if (keep.deleted_at === null) report.mediaPaths.push(...this.messages.tombstone(keepId, drop.deleted_at!));
      this.dropTwin(keepId, dropId, report);
      return;
    }

    const dropNewer = (drop.edited_at ?? -1) > (keep.edited_at ?? -1);
    const [winner, other] = dropNewer ? [drop, keep] : [keep, drop];
    const earliest = [keep.expires_at, drop.expires_at].filter((at): at is number => at !== null);
    this.c.run(
      `UPDATE messages SET type = ?, text = ?, raw = ?, content_hash = ?, quoted_sid = ?, quoted_from_me = ?, quoted_key_id = ?, edited_at = ?,
         transcript = ?, transcript_info = ?, status = ?, expires_at = ?, sender_id = ?, flags = ? WHERE id = ?`,
      winner.type,
      winner.text ?? other.text,
      winner.raw ?? other.raw,
      winner.raw !== null ? winner.content_hash : other.content_hash,
      winner.quoted_sid ?? other.quoted_sid,
      winner.quoted_key_id === null ? other.quoted_from_me : winner.quoted_from_me,
      winner.quoted_key_id ?? other.quoted_key_id,
      winner.edited_at ?? other.edited_at,
      keep.transcript ?? drop.transcript,
      keep.transcript !== null ? keep.transcript_info : drop.transcript_info,
      keep.status === null || drop.status === null
        ? (keep.status ?? drop.status)
        : statusRank(drop.status) > statusRank(keep.status)
          ? drop.status
          : keep.status,
      earliest.length === 0 ? null : Math.min(...earliest),
      keep.sender_id ?? drop.sender_id,
      // The bits either copy carried: a mention or a send seen under one spelling stays true of the message.
      keep.flags | drop.flags,
      keepId
    );

    // Reactions and votes: one per person, the newer wins.
    for (const table of ["reactions", "votes"] as const) {
      this.c.run(
        `DELETE FROM ${table} WHERE message_id = ? AND EXISTS (
           SELECT 1 FROM ${table} d WHERE d.message_id = ? AND d.contact_id = ${table}.contact_id AND d.ts > ${table}.ts)`,
        keepId,
        dropId
      );
      this.c.run(
        `DELETE FROM ${table} WHERE message_id = ? AND EXISTS (
           SELECT 1 FROM ${table} k WHERE k.message_id = ? AND k.contact_id = ${table}.contact_id)`,
        dropId,
        keepId
      );
      this.c.run(`UPDATE ${table} SET message_id = ? WHERE message_id = ?`, keepId, dropId);
    }
    // Receipts: the latest time of each kind.
    this.c.run(
      `UPDATE receipts AS k SET
         delivered_at = coalesce(max(k.delivered_at, d.delivered_at), k.delivered_at, d.delivered_at),
         read_at = coalesce(max(k.read_at, d.read_at), k.read_at, d.read_at),
         played_at = coalesce(max(k.played_at, d.played_at), k.played_at, d.played_at)
       FROM receipts AS d WHERE k.message_id = ? AND d.message_id = ? AND d.contact_id = k.contact_id`,
      keepId,
      dropId
    );
    this.c.run(
      `DELETE FROM receipts WHERE message_id = ? AND EXISTS (
         SELECT 1 FROM receipts k WHERE k.message_id = ? AND k.contact_id = receipts.contact_id)`,
      dropId,
      keepId
    );
    this.c.run("UPDATE receipts SET message_id = ? WHERE message_id = ?", keepId, dropId);

    // Derived files: the survivor's own of a kind wins; the other moves over.
    this.c.run(
      `UPDATE media SET message_id = ? WHERE message_id = ?
         AND NOT EXISTS (SELECT 1 FROM media k WHERE k.message_id = ? AND k.kind = media.kind)`,
      keepId,
      dropId,
      keepId
    );

    // The embedding still describes the survivor when it was made from the survivor's words.
    const merged = this.c.get<{ text: string | null; transcript: string | null }>(
      "SELECT text, transcript FROM messages WHERE id = ?",
      keepId
    )!;
    this.c.run(
      `UPDATE embeddings SET message_id = ? WHERE message_id = ? AND content_hash = ?
         AND NOT EXISTS (SELECT 1 FROM embeddings WHERE message_id = ?)`,
      keepId,
      dropId,
      contentHash(merged.text, merged.transcript),
      keepId
    );
    // A survivor left without a vector of the fed model is owed one.
    this.c.run(
      `INSERT OR IGNORE INTO embed_queue(message_id)
         SELECT m.id FROM messages m, meta f WHERE m.id = ? AND f.key = 'embed_model'
           AND m.deleted_at IS NULL AND (m.text IS NOT NULL OR m.transcript IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.message_id = m.id AND e.model = f.value)`,
      keepId
    );
    this.dropTwin(keepId, dropId, report);
  }

  /**
   * Deletes the folded twin after pointing events and handled marks at the
   * survivor; a file only it referenced is handed back, one another row still
   * uses is not.
   */
  private dropTwin(keepId: number, dropId: number, report: MergeReport): void {
    const paths = this.c.all<{ path: string }>("SELECT path FROM media WHERE message_id = ?", dropId).map((row) => row.path);
    // The message survives in the kept row: what pointed at the folded copy points there, instead of going null.
    this.c.run("UPDATE events SET message_id = ? WHERE message_id = ?", keepId, dropId);
    this.c.run("UPDATE handled SET ask_message_id = ? WHERE ask_message_id = ?", keepId, dropId);
    this.c.run("DELETE FROM messages WHERE id = ?", dropId);
    for (const path of paths) {
      if (this.c.get("SELECT 1 FROM media WHERE path = ?", path) === undefined) report.mediaPaths.push(path);
    }
  }
}
