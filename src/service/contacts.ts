/**
 * The account's contacts: the address book and how many names it holds,
 * search by name, number, tag or detail, one contact's card, find_contact,
 * the local notes, tags and details, and the full resync that asks WhatsApp
 * for the address book again. Part of WhatsAppService (src/whatsapp.ts),
 * which lends its state and guards through ContactsHost and triggers the
 * self-heal and the blocklist on each new connection.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { ALL_WA_PATCH_NAMES, type WASocket } from "baileys";
import type { AccountRecord } from "../accounts.js";
import { WazapError } from "../errors.js";
import { findInAccount, type AccountFind, type FindContactQuery } from "../find-contact.js";
import { isGroupId, isNoiseJid } from "../ids.js";
import { IMPORT_META } from "../legacy-import/index.js";
import { log, logError } from "../logger.js";
import { realName } from "./identity.js";
import { orNullAfter, PROFILE_LOOKUP_MS } from "./util.js";
import type {
  ConnectionStatus,
  ContactDetails,
  ContactDetailsEdit,
  ContactSyncResult,
  ContactSummary,
} from "../wa-types.js";
import type { AccountIdentity } from "./identity.js";
import type { AccountStorage } from "./storage.js";
import type { MessageViews } from "./views.js";

/** Local contact filing caps: enough to describe anyone, small enough to stay a note. */
const MAX_CONTACT_TAGS = 30;

const MAX_CONTACT_FIELDS = 30;

/** A detail value is a line, like a note — not a document. */
const MAX_FIELD_VALUE_CHARS = 200;

const MAX_TAG_CHARS = 40;

const MAX_FIELD_KEY_CHARS = 40;

/** A resync asks WhatsApp for the whole address book, so it is not free. */
const CONTACT_RESYNC_COOLDOWN_MS = 7 * 24 * 3_600_000;

/** How long past the initial sync a slow app state sync still gets to deliver. */
export const CONTACT_SETTLE_MS = 15_000;

export interface ContactResyncInput {
  /** Contacts carrying an address-book name right now. */
  named: number;
  /** WhatsApp has already told us a version for at least one collection. */
  storedVersions: boolean;
  /** When wazap last asked for the whole address book, from the store. */
  resyncedAt: number | null;
  now: number;
}

/**
 * Whether this session should ask WhatsApp for the address book from scratch.
 *
 * Names arrive only in an app state sync that starts from version zero. With no
 * stored version there is nothing to heal: the connection is already doing that
 * sync. With versions stored and no names in hand, the delivery went somewhere
 * that threw it away, and only a resync gets it back. An account whose address
 * book is genuinely empty looks identical, which is what the cooldown is for.
 */
export function needsContactResync({ named, storedVersions, resyncedAt, now }: ContactResyncInput): boolean {
  if (named > 0 || !storedVersions) return false;
  return resyncedAt === null || now - resyncedAt >= CONTACT_RESYNC_COOLDOWN_MS;
}

function statusTextOf(entry: { [protocol: string]: unknown } | undefined): string | null {
  const status = entry?.status;
  if (status && typeof status === "object" && "status" in status) {
    return (status as { status?: string | null }).status ?? null;
  }
  return typeof status === "string" ? status : null;
}

/** A tag is a lowercase token: "#Client  Ro" files as "client-ro". */
function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-");
}

function requireTag(raw: string): string {
  const tag = normalizeTag(raw);
  if (tag === "" || tag.length > MAX_TAG_CHARS) {
    throw new WazapError("INVALID_ID", `"${raw}" is not a usable tag.`, 'Pass a short label like "client"');
  }
  return tag;
}

function requireFieldKey(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (key === "" || key.length > MAX_FIELD_KEY_CHARS) {
    throw new WazapError("INVALID_ID", `"${raw}" is not a usable detail key.`, 'Pass a short key like "role"');
  }
  return key;
}

/** What the service lends the contacts, read at each call. */
export interface ContactsHost {
  stopped(): boolean;
  status(): ConnectionStatus;
  guarded<T>(work: () => Promise<T>): Promise<T>;
  ensureConnected(): WASocket;
  waitForSync(): Promise<void>;
  /** Tags changed. The webhook re-reads them, so a pending event for someone just removed can be cancelled. */
  notesChanged(): void;
}

export class AccountContacts {
  /** Contacts with an address-book name; null until counted again after a name changed. */
  namedContactsCache: number | null = null;
  /** find_contact's one ask this boot for an address book that looked empty, shared by every find waiting on it (F2-3). */
  private addressBookAsk: Promise<void> | null = null;
  readonly blocked = new Set<string>();

  constructor(
    private readonly host: ContactsHost,
    private readonly identity: AccountIdentity,
    private readonly views: MessageViews,
    private readonly storage: AccountStorage,
    private readonly accountRecord: AccountRecord
  ) {}

  /**
   * The same full resync the self-heal runs, on demand. Nothing about the
   * account changes: this asks WhatsApp to send the address book again.
   */
  syncContacts(): Promise<ContactSyncResult> {
    return this.host.guarded(async () => {
      const sock = this.host.ensureConnected();
      const before = this.namedContacts();
      await this.resyncContacts(sock);
      const after = await this.waitForNames(before, Date.now() + CONTACT_SETTLE_MS);
      return { requested: true, named_before: before, named_after: after };
    });
  }

  /**
   * People from the phone's address book: the only contact count worth
   * reporting. The database also holds everyone who ever wrote or reacted, so
   * its size says nothing about whether the address book ever arrived.
   */
  namedContacts(): number {
    if (this.namedContactsCache === null) {
      const db = this.storage.readyDb();
      if (db === null) return 0;
      let named = 0;
      for (const { contact } of db.identity.listContacts()) {
        const jid = contact.phoneJid ?? contact.lid ?? "";
        if (!isGroupId(jid) && realName(contact.name)) named++;
      }
      this.namedContactsCache = named;
    }
    return this.namedContactsCache;
  }

  /**
   * Name and number matches, plus the local filing: a tag or a detail's key or
   * value hits too, which is how "contabil" finds the person filed under
   * `role: contabil`. With `tag` only contacts carrying it come back, so
   * "everyone tagged furnizori" is one call. People known only through their
   * local filing — never synced as contacts — are candidates as well.
   */
  searchContacts(query: string, limit: number, opts: { tag?: string } = {}): Promise<ContactSummary[]> {
    return this.host.guarded(async () => {
      this.host.ensureConnected();
      await this.host.waitForSync();
      const needle = query.trim().toLowerCase();
      // "0734…" typed the way a number is dialled at home matches "40734…".
      const digits = needle.replace(/\D/g, "").replace(/^0+/, "");
      const tag = opts.tag === undefined ? undefined : normalizeTag(opts.tag);
      if (tag === "") {
        throw new WazapError("INVALID_ID", `"${opts.tag}" is not a usable tag.`, 'Pass a label like "client"');
      }
      const matches: ContactSummary[] = [];
      for (const { contact, notes } of this.storage.db.identity.listContacts()) {
        const person = contact.phoneJid ?? contact.lid;
        if (person === null || isGroupId(person) || isNoiseJid(person)) continue;
        // The address book (the account's own entry too, when it is in it) and the people the user filed: not everyone who ever wrote.
        if (contact.listed === null && notes === null) continue;
        const tags = notes?.tags ?? [];
        if (tag !== undefined && !tags.includes(tag)) continue;
        // Every name we might show, or someone the chat list calls "Carmen"
        // would not be findable by that name here.
        const known = [contact.name, contact.verifiedName, contact.notify, contact.pushName].map(realName);
        const number = person.split("@")[0] ?? "";
        const hit =
          needle === "" ||
          known.some((name) => name?.toLowerCase().includes(needle)) ||
          (digits.length >= 5 && number.includes(digits)) ||
          tags.some((t) => t.includes(needle)) ||
          Object.entries(notes?.fields ?? {}).some(([key, value]) => key.includes(needle) || value.toLowerCase().includes(needle));
        if (!hit) continue;
        matches.push(this.views.contactSummary(person));
        if (matches.length >= limit) break;
      }
      return matches;
    });
  }

  getContact(contactId: string): Promise<ContactDetails> {
    return this.host.guarded(async () => {
      const sock = this.host.ensureConnected();
      const jid = this.identity.resolveId(contactId);
      // A number WhatsApp does not know never answers these two queries, so
      // they get a deadline and the contact still comes back from the store.
      const [about, picture] = await Promise.all([
        orNullAfter(
          sock.fetchStatus(jid).then((entries) => statusTextOf(entries?.[0])),
          PROFILE_LOOKUP_MS
        ),
        orNullAfter(sock.profilePictureUrl(jid, "image"), PROFILE_LOOKUP_MS),
      ]);
      return {
        ...this.views.contactSummary(jid),
        about,
        profile_pic_url: picture ?? null,
        is_blocked: this.blocked.has(jid),
      };
    });
  }

  // ---- find_contact and the draft context (F2-3) ----------------------------

  /**
   * Who a name means on this account (src/find-contact.ts), from what the
   * account stores: no connection is needed, only a database that answers.
   * While connected, an address book that looks empty is first asked for (see
   * askForEmptyAddressBook).
   */
  findContact(query: FindContactQuery): Promise<AccountFind> {
    return this.host.guarded(async () => {
      let db = this.storage.db;
      if (this.host.status() === "connected") {
        await this.host.waitForSync();
        await this.askForEmptyAddressBook();
        db = this.storage.db;
      }
      return findInAccount(db, this.accountRecord.id, query, (id) => this.identity.resolveId(id));
    });
  }

  /**
   * No contact carries a saved name: ask WhatsApp for the address book, at
   * most once per boot and on the same rule as the self-heal
   * (needsContactResync: not while the connection is still syncing, not within
   * 7 days of the last ask), then wait up to 15 s for names. Every find that
   * comes in meanwhile waits on the same ask. A failure is logged; the answer
   * comes from what is stored.
   */
  private askForEmptyAddressBook(): Promise<void> {
    if (this.addressBookAsk === null) {
      if (this.namedContacts() > 0) return Promise.resolve();
      this.addressBookAsk = (async () => {
        try {
          const sock = this.host.ensureConnected();
          const decision = {
            named: this.namedContacts(),
            storedVersions: await this.hasAppStateVersions(sock),
            resyncedAt: this.contactsResyncedAt(),
            now: Date.now(),
          };
          if (!needsContactResync(decision)) return;
          log("address book missing; requesting a full contact sync before find_contact answers");
          await this.resyncContacts(sock);
          await this.waitForNames(0, Date.now() + CONTACT_SETTLE_MS);
        } catch (err) {
          logError("contact sync", err);
        }
      })();
    }
    return this.addressBookAsk;
  }

  setContactNote(contactId: string, note: string): Promise<ContactSummary> {
    return this.host.guarded(async () => {
      const jid = this.identity.resolveId(contactId);
      this.storage.db.identity.setNote(jid, note);
      return this.views.contactSummary(jid);
    });
  }

  /**
   * The local contact file: tags and key-value details the agent files a
   * person under, found by find_contact. Nothing reaches WhatsApp —
   * the protocol stores only a name — so this is how "my accountant" and
   * "the guys from the depot" stay attached to people. The person need not
   * be a saved contact; filing a chat partner works too.
   */
  updateContactDetails(contactId: string, edit: ContactDetailsEdit): Promise<ContactSummary> {
    return this.host.guarded(async () => {
      const jid = this.identity.personJid(contactId);
      const addTags = (edit.addTags ?? []).map((t) => requireTag(t));
      const removeTags = (edit.removeTags ?? []).map((t) => requireTag(t));
      const set: Record<string, string> = {};
      const removeFields = new Set((edit.removeFields ?? []).map((k) => requireFieldKey(k)));
      for (const [key, value] of Object.entries(edit.fields ?? {})) {
        const normalized = requireFieldKey(key);
        const trimmed = value.trim();
        if (trimmed === "") removeFields.add(normalized);
        else {
          if (trimmed.length > MAX_FIELD_VALUE_CHARS) {
            throw new WazapError("TEXT_TOO_LONG", `Detail "${normalized}" is over ${MAX_FIELD_VALUE_CHARS} characters.`);
          }
          set[normalized] = trimmed;
        }
      }
      if (
        addTags.length === 0 &&
        removeTags.length === 0 &&
        Object.keys(set).length === 0 &&
        removeFields.size === 0
      ) {
        throw new WazapError(
          "INVALID_ID",
          "Nothing to update.",
          "Pass add_tags, remove_tags, fields or remove_fields"
        );
      }
      const db = this.storage.db;
      const current = db.identity.notes(jid);
      const tagCount =
        new Set([...(current?.tags ?? []), ...addTags].filter((t) => !removeTags.includes(t))).size;
      const fieldCount = new Set(
        [...Object.keys(current?.fields ?? {}), ...Object.keys(set)].filter((k) => !removeFields.has(k))
      ).size;
      if (tagCount > MAX_CONTACT_TAGS) {
        throw new WazapError("TEXT_TOO_LONG", `A contact holds at most ${MAX_CONTACT_TAGS} tags.`);
      }
      if (fieldCount > MAX_CONTACT_FIELDS) {
        throw new WazapError("TEXT_TOO_LONG", `A contact holds at most ${MAX_CONTACT_FIELDS} details.`);
      }
      db.identity.updateFields(jid, { addTags, removeTags, set, removeFields: [...removeFields] });
      this.host.notesChanged();
      return this.views.contactSummary(jid);
    });
  }

  /** When wazap last asked WhatsApp for the whole address book, kept in the database's meta. */
  contactsResyncedAt(): number | null {
    const stored = this.storage.readyDb()?.getMeta(IMPORT_META.contactsResyncedAt) ?? null;
    const at = stored === null ? Number.NaN : Number(stored);
    return Number.isFinite(at) ? at : null;
  }

  /** Names still arriving mean the sync is working; only silence means it is not coming. */
  async waitForNames(floor: number, deadline: number): Promise<number> {
    for (;;) {
      const named = this.namedContacts();
      if (named > floor || this.host.stopped() || Date.now() >= deadline) return named;
      await sleep(500);
    }
  }

  async hasAppStateVersions(sock: WASocket): Promise<boolean> {
    const stored = await sock.authState.keys.get("app-state-sync-version", [...ALL_WA_PATCH_NAMES]);
    return Object.values(stored).some((state) => state);
  }

  /**
   * Forget every stored app state version, then resync. The order is the whole
   * point: Baileys asks for a snapshot only when it has no version to resume
   * from, and the snapshot is what carries the contacts. The timestamp is
   * written before the request, so a resync interrupted halfway is not retried
   * on every start.
   */
  async resyncContacts(sock: WASocket): Promise<void> {
    const forgotten = Object.fromEntries(ALL_WA_PATCH_NAMES.map((name) => [name, null]));
    await sock.authState.keys.set({ "app-state-sync-version": forgotten });
    this.storage.readyDb()?.setMeta(IMPORT_META.contactsResyncedAt, String(Date.now()));
    await sock.resyncAppState(ALL_WA_PATCH_NAMES, true);
  }
}
