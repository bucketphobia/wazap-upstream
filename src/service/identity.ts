/**
 * Who a jid is, for one account: the lid ↔ number pairings, the account's own
 * ids, and the one place a jid becomes a name. Part of WhatsAppService
 * (src/whatsapp.ts), which owns the socket, the account and the database and
 * lends them through IdentityHost.
 */

import type { Contact as BaileysContact, GroupMetadata, WASocket } from "baileys";
import { chatKindOf, type AccountDb } from "../db/index.js";
import { WazapError } from "../errors.js";
import { LidRegistry, lidKey } from "../identity.js";
import { isGroupId, isNoiseJid } from "../ids.js";
import { logError } from "../logger.js";
import { privatePeople, type PrivatePeople } from "../private-contacts.js";
import type { PrivateRule, StatusInfo } from "../wa-types.js";

/**
 * A contact WhatsApp will not name for us still arrives with a `name`: the
 * masked number "+40∙∙∙∙∙∙∙98". Counting those as address-book entries would
 * make wazap believe the address book had landed, and showing one hides the
 * plain number the reader can actually dial. Anything made only of digits and
 * masking is not a name.
 */
const NOT_A_NAME = /^[+\d\s()\-.·•∙…*]+$/u;

/** The name a human wrote, or "" for a placeholder and for nothing at all. */
export function realName(value: string | null | undefined): string {
  const name = value?.trim() ?? "";
  return name === "" || NOT_A_NAME.test(name) ? "" : name;
}

/** What the service lends identity: read at each call, so a new socket, account or database is seen at once. */
export interface IdentityHost {
  db(): AccountDb;
  readyDb(): AccountDb | null;
  sock(): WASocket | null;
  account(): StatusInfo["account"];
  stopped(): boolean;
  /** A group's metadata, when it has been fetched. */
  cachedGroup(jid: string): GroupMetadata | undefined;
  /** Lid chats still folding into their number's chat; list_chats lets them land. */
  readonly folds: Set<Promise<unknown>>;
  scheduleFileCleanup(): Promise<void>;
  /** A pairing may have named someone: the named-contacts count is stale. */
  namesChanged(): void;
}

export class AccountIdentity {
  constructor(private readonly host: IdentityHost) {}

  /** Every lid ↔ number pairing, mirrored from the account database: the ids every read hands out. */
  lids = new LidRegistry();

  ownJid(): string {
    const id = this.host.sock()?.user?.id;
    if (id) return this.canonical(id);
    return this.host.account()?.id ?? "";
  }

  isMe(jid: string): boolean {
    return this.lids.isSelf(jid, this.ownJid(), this.host.sock()?.user?.lid);
  }

  resolveId(input: string): string {
    return this.lids.resolve(input);
  }

  /** A sender filter: the account's own id, however it is spelled, is "me" — its messages are stored without a sender. */
  /**
   * The people a broad read leaves the words of out (src/private-contacts.ts),
   * read once for the call; null when the call did not ask for the rule or
   * nobody is #private.
   */
  privateScope(rule: PrivateRule | undefined): PrivatePeople | null {
    if (rule === undefined) return null;
    const people = privatePeople(this.host.db(), rule.others);
    return people.none ? null : people;
  }

  senderFilter(from: string | undefined): string | undefined {
    if (from === undefined) return undefined;
    if (from === "me") return "me";
    const jid = this.resolveId(from);
    return this.ownJid() !== "" && this.isMe(jid) ? "me" : jid;
  }

  /** A contact mutation keys on a person: groups and noise jids are caller errors, not contacts. */
  personJid(input: string): string {
    const jid = this.resolveId(input);
    if (isGroupId(jid) || isNoiseJid(jid)) {
      throw new WazapError("INVALID_ID", `"${input}" is not a person's contact id.`, "Pass a phone number or a contact id");
    }
    return jid;
  }

  /** Canonical form, or the input unchanged for jids wazap does not address
   * (status broadcasts, newsletters). */
  canonical(jid: string): string {
    return this.lids.canonical(jid);
  }

  /**
   * The lid → number table under the two names it had while ids and naming
   * kept separate copies of it; tests still read both. A copy, so nothing
   * writes a pairing past learnLid.
   */
  private get lidToPn(): ReadonlyMap<string, string> {
    return new Map(this.lids);
  }

  private get lidPhones(): ReadonlyMap<string, string> {
    return this.lidToPn;
  }

  /**
   * WhatsApp usually keys a contact by its phone jid and names the LID on the
   * side, leaving `phoneNumber` empty, so the pairing has to be read off `id`.
   */
  relearnLid(contact: BaileysContact): void {
    if (!contact.lid) return;
    if (contact.phoneNumber) this.learnLid(contact.lid, contact.phoneNumber);
    else if (contact.id?.endsWith("@s.whatsapp.net")) this.learnLid(contact.lid, contact.id);
  }

  /**
   * A pairing WhatsApp stated in a field meant for it, so ids may follow it:
   * the number becomes canonical, and the database makes the lid and the
   * number one person and one chat — names, notes and history included — so
   * nothing splits. The contact and chat rows move at once; a chat's messages
   * fold in behind it, in chunks.
   */
  learnLid(lid: string, pn: string): void {
    if (!lid || !pn || this.host.stopped()) return;
    const paired = this.lids.learn(lid, pn);
    const db = this.host.readyDb();
    if (db === null) return;
    const key = lidKey(lid);
    const phone = this.lids.phoneOf(key);
    if (phone === undefined || (!paired && db.identity.phoneOfLid(key) === phone)) return;
    try {
      const fold = db.learnLidPhone(key, phone).then(
        (report) => (report.mediaPaths.length > 0 ? this.host.scheduleFileCleanup() : undefined),
        (err: unknown) => logError("lid pairing", err)
      );
      this.host.folds.add(fold);
      void fold.finally(() => this.host.folds.delete(fold));
      this.host.namesChanged();
    } catch (err) {
      logError("lid pairing", err);
    }
  }

  /**
   * Ask Baileys for the numbers behind the LIDs we are about to name. It answers
   * from the table the account has already synced, so this is a lookup and not a
   * fetch, and it covers LIDs no chat, contact or group ever paired.
   */
  async learnLidPhones(jids: Iterable<string>): Promise<void> {
    const missing = [...new Set(jids)].filter((jid) => jid.endsWith("@lid") && this.lids.phoneOf(jid) === undefined);
    if (missing.length === 0) return;
    const mappings = await this.host.sock()?.signalRepository?.lidMapping?.getPNsForLIDs(missing).catch(() => null);
    // A pairing from WhatsApp's own table is as good as one from a contact:
    // the chat moves in with the phone chat, history included.
    for (const { lid, pn } of mappings ?? []) this.learnLid(lid, pn);
  }

  /**
   * The one place a jid becomes a name, so a sender, a chat header, a digest
   * title and a participant list can never disagree. The last rung is never a
   * raw LID: a LID is fifteen digits that read as a phone number and are not
   * one, so an unresolved one says it is unknown instead.
   *
   * `hint` is the pushName on the message being rendered, for a sender whose
   * name has not been ingested yet.
   */
  displayName(jid: string, hint?: string): string {
    if (!jid) return "unknown";
    if (this.isMe(jid)) return this.host.account()?.name || "You";
    const db = this.host.readyDb();
    if (isGroupId(jid)) {
      return db?.identity.chat(jid)?.name || this.host.cachedGroup(jid)?.subject || jid;
    }

    const contact = db?.identity.contact(jid) ?? null;
    const chat = db !== null && chatKindOf(jid) === "direct" ? db.identity.chat(jid) : null;
    const name =
      realName(contact?.name) ||
      realName(contact?.verifiedName) ||
      realName(contact?.notify) ||
      realName(contact?.pushName) ||
      realName(chat?.name);
    if (name) return name;
    const hinted = realName(hint);
    if (hinted) return hinted;

    const alias = this.lids.aliasOf(jid);
    const phoneJid = jid.endsWith("@lid") ? alias : jid;
    const digits = (phoneJid ?? jid).split("@")[0] ?? "";
    if ((phoneJid ?? jid).endsWith("@s.whatsapp.net")) return digits;
    return jid.endsWith("@lid") ? `unknown (lid …${digits.slice(-4)})` : jid;
  }

  /** The user's note on a person or a chat, from the database. */
  noteFor(jid: string): string | undefined {
    return this.host.readyDb()?.identity.notes(jid)?.note ?? undefined;
  }

  /** The tags the user filed a person under, sorted; undefined when there are none. */
  tagsFor(jid: string): string[] | undefined {
    const tags = this.host.readyDb()?.identity.notes(jid)?.tags ?? [];
    return tags.length === 0 ? undefined : [...tags].sort();
  }
}
