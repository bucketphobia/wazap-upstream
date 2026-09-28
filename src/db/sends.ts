/**
 * Drafts and what became of them once confirmed: the storage half of
 * confirm_send. Each step is one statement, so two confirms of one draft can
 * never both take it; the lifetime, the per-session cap and what each refusal
 * says are the service's (src/drafts.ts).
 *
 *   draft ──claim──▶ sending ──settle──▶ sent
 *     ▲                 │                  ▲
 *     └───release───────┤                  │ settle, when WhatsApp echoes the key
 *                       └──unsettle──▶ unknown
 *
 * release is only for a send that failed before its key reached the socket;
 * after that the outcome is either known or unknown, never retried. A row a
 * crash left in sending becomes unknown when the database is next opened by
 * the service (interrupt). The key never changes: a retraction or a tombstone
 * makes it dead for good (see the retracted table).
 */
import type { Connection } from "./connection.js";
import type { SQLInputValue } from "./sqlite.js";

export type SendState = "draft" | "sending" | "sent" | "unknown";

/** How long the key of a send wazap let go of is remembered (sent_keys): the draft context's window. */
export const SENT_KEYS_RETENTION_MS = 90 * 86_400_000;

export interface SendRecord {
  draftId: string;
  /** The identity that drafted it (ToolCtx.draftOwner); null for a draft made outside any session. */
  owner: string | null;
  chatJid: string;
  kind: string;
  /** The frozen draft, JSON; emptied once the send settled as sent. */
  payload: string;
  keyId: string;
  state: SendState;
  /** What confirm_send answered, JSON; set once sent. */
  receipt: string | null;
  errorCode: string | null;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
}

export type NewDraft = Pick<
  SendRecord,
  "draftId" | "owner" | "chatJid" | "kind" | "payload" | "keyId" | "createdAt" | "expiresAt"
>;

interface SendRow {
  draft_id: string;
  owner: string | null;
  chat_jid: string;
  kind: string;
  payload: string;
  key_id: string;
  state: SendState;
  receipt: string | null;
  error_code: string | null;
  created_at: number;
  expires_at: number;
  updated_at: number;
}

const COLUMNS =
  "draft_id, owner, chat_jid, kind, payload, key_id, state, receipt, error_code, created_at, expires_at, updated_at";

function recordOf(row: SendRow): SendRecord {
  return {
    draftId: row.draft_id,
    owner: row.owner,
    chatJid: row.chat_jid,
    kind: row.kind,
    payload: row.payload,
    keyId: row.key_id,
    state: row.state,
    receipt: row.receipt,
    errorCode: row.error_code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export class Sends {
  constructor(private readonly c: Connection) {}

  /**
   * Stores a draft. The owner keeps at most `cap` drafts and the account at
   * most `accountCap`, whoever drafted them: the oldest go first, in the same
   * transaction. Only drafts count; a send under way or settled is never evicted.
   */
  insertDraft(draft: NewDraft, cap: number, accountCap: number): void {
    this.c.write(() => {
      const owned = this.c.get<{ n: number }>(
        "SELECT count(*) AS n FROM sends WHERE owner IS ? AND state = 'draft'",
        draft.owner
      )!.n;
      const excess = owned - Math.max(0, cap - 1);
      if (excess > 0) {
        this.c.run(
          `DELETE FROM sends WHERE draft_id IN (
             SELECT draft_id FROM sends WHERE owner IS ? AND state = 'draft' ORDER BY created_at, draft_id LIMIT ?)`,
          draft.owner,
          excess
        );
      }
      const held = this.c.get<{ n: number }>("SELECT count(*) AS n FROM sends WHERE state = 'draft'")!.n;
      const beyond = held - Math.max(0, accountCap - 1);
      if (beyond > 0) {
        this.c.run(
          `DELETE FROM sends WHERE draft_id IN (
             SELECT draft_id FROM sends WHERE state = 'draft' ORDER BY created_at, draft_id LIMIT ?)`,
          beyond
        );
      }
      this.c.run(
        `INSERT INTO sends(${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, ?, ?)`,
        draft.draftId,
        draft.owner,
        draft.chatJid,
        draft.kind,
        draft.payload,
        draft.keyId,
        draft.createdAt,
        draft.expiresAt,
        draft.createdAt
      );
    });
  }

  get(draftId: string): SendRecord | null {
    const row = this.c.get<SendRow>(`SELECT ${COLUMNS} FROM sends WHERE draft_id = ?`, draftId);
    return row === undefined ? null : recordOf(row);
  }

  /** draft → sending, for its owner and while it has not lapsed. False when anything else holds. */
  claim(draftId: string, owner: string | null, now: number): boolean {
    return (
      this.change(
        "UPDATE sends SET state = 'sending', updated_at = ? WHERE draft_id = ? AND owner IS ? AND state = 'draft' AND expires_at > ?",
        now,
        draftId,
        owner,
        now
      ) === 1
    );
  }

  /** sending → draft: the key never reached the socket, so the draft may be confirmed again. */
  release(draftId: string, now: number): boolean {
    return this.change("UPDATE sends SET state = 'draft', updated_at = ? WHERE draft_id = ? AND state = 'sending'", now, draftId) === 1;
  }

  /** sending or unknown → sent, with what confirm_send answers from now on. The draft's words are no longer kept. */
  settle(draftId: string, receipt: string, now: number, keepUntil: number): boolean {
    return (
      this.change(
        `UPDATE sends SET state = 'sent', receipt = ?, payload = '{}', error_code = NULL, updated_at = ?, expires_at = ?
         WHERE draft_id = ? AND state IN ('sending', 'unknown')`,
        receipt,
        now,
        keepUntil,
        draftId
      ) === 1
    );
  }

  /** sending → unknown: the key may have reached WhatsApp. */
  unsettle(draftId: string, errorCode: string, now: number, keepUntil: number): boolean {
    return (
      this.change(
        "UPDATE sends SET state = 'unknown', error_code = ?, updated_at = ?, expires_at = ? WHERE draft_id = ? AND state = 'sending'",
        errorCode,
        now,
        keepUntil,
        draftId
      ) === 1
    );
  }

  /** Every send a crash or a stop left under way becomes unknown. Only safe before any confirm can run. */
  interrupt(now: number, keepUntil: number): number {
    return this.change(
      "UPDATE sends SET state = 'unknown', error_code = 'INTERRUPTED', updated_at = ?, expires_at = ? WHERE state = 'sending'",
      now,
      keepUntil
    );
  }

  /** Sends whose outcome is unknown, oldest first. */
  unknown(limit: number): SendRecord[] {
    return this.c
      .all<SendRow>(`SELECT ${COLUMNS} FROM sends WHERE state = 'unknown' ORDER BY updated_at, draft_id LIMIT ?`, limit)
      .map(recordOf);
  }

  /** The sends to these chats whose outcome is unknown, oldest first. */
  unknownIn(chatJids: readonly string[], limit: number): SendRecord[] {
    if (chatJids.length === 0) return [];
    return this.c
      .all<SendRow>(
        `SELECT ${COLUMNS} FROM sends WHERE state = 'unknown' AND chat_jid IN (${chatJids.map(() => "?").join(", ")}) ORDER BY updated_at, draft_id LIMIT ?`,
        ...chatJids,
        limit
      )
      .map(recordOf);
  }

  /** The unknown send made under this WhatsApp key, if any. */
  unknownByKey(keyId: string): SendRecord | null {
    const row = this.c.get<SendRow>(`SELECT ${COLUMNS} FROM sends WHERE key_id = ? AND state = 'unknown'`, keyId);
    return row === undefined ? null : recordOf(row);
  }

  /** True when a confirmed draft went out, or may have, under this key. */
  hasKey(keyId: string): boolean {
    return this.c.get("SELECT 1 FROM sends WHERE key_id = ? AND state <> 'draft'", keyId) !== undefined;
  }

  /** Drops a draft nobody confirmed. A send under way or settled stays. */
  removeDraft(draftId: string): boolean {
    return this.change("DELETE FROM sends WHERE draft_id = ? AND state = 'draft'", draftId) === 1;
  }

  /**
   * What an account that keeps no history forgets between runs: every draft,
   * and the words of every other send. The rows stay, so a send whose message
   * WhatsApp may have is still never sent again.
   */
  forgetWords(): void {
    this.c.write(() => {
      this.c.run("DELETE FROM sends WHERE state = 'draft'");
      this.c.run(
        `UPDATE sends SET payload = '{}', receipt = CASE WHEN receipt IS NULL THEN NULL ELSE json_set(receipt, '$.text', '') END
         WHERE payload <> '{}' OR json_extract(receipt, '$.text') <> ''`
      );
    });
  }

  /**
   * Deletes up to `limit` rows past their expires_at, never a send under way,
   * and up to `limit` sent keys older than SENT_KEYS_RETENTION_MS. Returns how
   * many send rows went.
   */
  sweep(now: number, limit: number): number {
    const cap = Math.max(1, Math.floor(limit));
    return this.c.write(() => {
      this.c.run(
        "DELETE FROM sent_keys WHERE key_id IN (SELECT key_id FROM sent_keys WHERE at <= ? ORDER BY at LIMIT ?)",
        now - SENT_KEYS_RETENTION_MS,
        cap
      );
      return this.c.run(
        `DELETE FROM sends WHERE draft_id IN (
           SELECT draft_id FROM sends WHERE expires_at <= ? AND state <> 'sending' ORDER BY expires_at LIMIT ?)`,
        now,
        cap
      );
    });
  }

  /** Whether wazap let go of a send under this key in the last 90 days, its row swept or not. */
  wasSent(keyId: string): boolean {
    return this.c.get("SELECT 1 FROM sent_keys WHERE key_id = ?", keyId) !== undefined;
  }

  /** One statement as its own write, or as part of the caller's; the rows it changed. */
  private change(sql: string, ...params: SQLInputValue[]): number {
    return this.c.write(() => this.c.run(sql, ...params));
  }
}
