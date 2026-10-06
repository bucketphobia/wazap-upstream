/**
 * list_contacts: the phone's address book on one account, a page at a time,
 * for a program that lets its user pick people out of it (an import of
 * clients) or an assistant asked who is in it.
 *
 * Who is in it (db.contacts.addressBook): a person a contact event placed in
 * the address book (`listed`) who carries a saved name (`contacts.name`) and a
 * phone number. A push name — what someone calls themselves on their own
 * messages, kept in `notify` and `push_name` — never makes anyone a contact
 * here: WhatsApp's contact events also name people who only wrote or sit in a
 * shared group, and those come with a push name and no saved name. The saved
 * name comes from the address book WhatsApp sends after linking, and from the
 * name the history sync gives a direct chat — the saved name, or a username
 * where the person has one and is not saved; wazap cannot tell those two
 * apart. Left out as well: a lid without a number, groups, the account itself,
 * and anyone tagged #private on this account or another live one
 * (src/private-contacts.ts) — a list nobody asked for by name. Someone removed
 * from the phone's address book stays: WhatsApp does not say so.
 *
 * Each person comes with metadata only: the saved name, the number in E.164,
 * the chat id, the contact id the webhook names them by, and when the last
 * message of the direct chat was and which way it went. Never a word of it.
 *
 * Orders: `recent` puts the people with a direct chat first, the latest first,
 * then everyone else in the address book's order; `address_book` is that
 * order alone — the order wazap first heard of each person (`listed`): the
 * order WhatsApp delivered the address book in, after whoever the history or
 * a message named first. Not an alphabetical one.
 *
 * Pages: the cursor (`next`) is opaque and self-contained: the account, the
 * order, where the page ended, and the stored message the first page read up
 * to. A later page reads every conversation as of that first page, so someone
 * who writes while the pages are fetched does not jump ahead of the cursor
 * and get skipped. A message deleted meanwhile can move its person later, so a
 * listing may repeat someone (dedupe by chat_id); a person the address book
 * adds meanwhile may come only in the next listing. Identity is not frozen:
 * when the number behind a privacy id becomes known, the two rows fold into
 * one, which can move that person ahead of the cursor or change their
 * contact_id. That happens mostly while the first sync runs, so a listing begun
 * before `sync` is done is worth repeating, and chat_id is the key to keep.
 * A page read while history is still arriving walks back through what arrived
 * since the first page, chat by chat.
 *
 * Whether the address book arrived (`address_book_synced`): someone saved
 * with a name has no chat with the account. The history sync names only the
 * people of its chats, and comes first; the address book comes through the
 * app state sync, holds people never written to, and WhatsApp says nothing
 * when it is done. So a book still arriving reads as synced from its first
 * such name on, and a phone whose every saved contact has a chat, or whose
 * address book is empty, never does.
 */
import { z } from "zod";
import { ADDRESS_BOOK_MAX_PAGE, type AccountDb, type AddressBookKey, type AddressBookOrder } from "./db/index.js";
import { privateRule } from "./catchup.js";
import { WazapError } from "./errors.js";
import { isoWithOffset } from "./messages.js";
import type { PrivatePeople } from "./private-contacts.js";
import type { ToolCtx, ToolResult } from "./tool-runtime.js";
import type { ContactList, ListContactsQuery, ListedContact } from "./wa-types.js";

export const LIST_CONTACTS_DEFAULT_LIMIT = 100;

const CURSOR_VERSION = 1;

interface CursorState {
  accountId: string;
  order: AddressBookOrder;
  asOfSeq: number;
  after: AddressBookKey;
}

function badCursor(why: string): WazapError {
  return new WazapError("INVALID_ID", `That cursor cannot continue this listing: ${why}.`, "Pass next exactly as the previous page gave it, with the same account_id and order, or start again without cursor");
}

export function encodeCursor(state: CursorState): string {
  const { accountId, order, asOfSeq, after } = state;
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, a: accountId, o: order === "recent" ? "r" : "b", s: asOfSeq, l: after.listed, i: after.id, t: after.at })).toString("base64url");
}

export function decodeCursor(cursor: string, accountId: string, order: AddressBookOrder): CursorState {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badCursor("it is not one list_contacts gave");
  }
  const parsed = raw as { v?: unknown; a?: unknown; o?: unknown; s?: unknown; l?: unknown; i?: unknown; t?: unknown } | null;
  const int = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.v !== CURSOR_VERSION ||
    typeof parsed.a !== "string" ||
    (parsed.o !== "r" && parsed.o !== "b") ||
    !int(parsed.s) ||
    !Number.isSafeInteger(parsed.l) ||
    !int(parsed.i) ||
    (parsed.t !== null && !int(parsed.t))
  ) {
    throw badCursor("it is not one list_contacts gave");
  }
  if (parsed.a !== accountId) throw badCursor(`it was given for account ${parsed.a}`);
  const was: AddressBookOrder = parsed.o === "r" ? "recent" : "address_book";
  if (was !== order) throw badCursor(`it was given for order ${was}`);
  return { accountId, order, asOfSeq: parsed.s, after: { listed: parsed.l as number, id: parsed.i, at: parsed.t as number | null } };
}

/** One page of one account's address book (see the top of this file). The service calls it. */
export function listInAccount(
  db: AccountDb,
  accountId: string,
  query: Pick<ListContactsQuery, "order" | "limit" | "cursor">,
  people: PrivatePeople | null
): Omit<ContactList, "sync"> {
  const state = query.cursor === undefined ? null : decodeCursor(query.cursor, accountId, query.order);
  const asOfSeq = state?.asOfSeq ?? db.digest.storedTop();
  const page = db.contacts.addressBook({
    order: query.order,
    limit: query.limit,
    asOfSeq,
    after: state?.after ?? null,
    exclude: people === null ? null : { contactIds: people.contactIds, jids: people.jids },
  });
  const contacts: ListedContact[] = page.entries.map((entry) => ({
    name: entry.name,
    phone: `+${entry.jid.split("@")[0]!}`,
    chat_id: entry.jid,
    contact_id: entry.contactId,
    last_message: entry.last === null ? null : { at: isoWithOffset(entry.last.at), direction: entry.last.fromMe ? "out" : "in" },
  }));
  return {
    contacts,
    total: page.total,
    next: page.next === null ? null : encodeCursor({ accountId, order: query.order, asOfSeq, after: page.next }),
    address_book_synced: page.arrived,
  };
}

// ---------------------------------------------------------------- the tool
//
// No output schema, like the tools of the integration contract
// (docs/stability.md): an SDK client checks structured content against a
// declared schema on errors too, so a tool that declares one answers a refusal
// as text alone, and an integration reads `structuredContent.error`.

export const LIST_CONTACTS_INPUT = {
  order: z.enum(["recent", "address_book"]).default("recent").describe("recent: latest direct chat first, then the rest in address book order"),
  limit: z.number().int().min(1).max(ADDRESS_BOOK_MAX_PAGE).default(LIST_CONTACTS_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(512).optional().describe("next from the previous page"),
};

function lastLine(contact: ListedContact): string {
  if (contact.last_message === null) return "no chat";
  return `last ${contact.last_message.direction} ${contact.last_message.at.slice(0, 16).replace("T", " ")}`;
}

const NOT_ARRIVED = "The phone's address book has not reached wazap yet (WhatsApp sends it once after linking): call again in a few seconds.";

export function renderContactList(list: ContactList, order: AddressBookOrder): string {
  if (list.total === 0) {
    return list.address_book_synced ? "Nobody in the address book has a number and a saved name (people tagged #private are left out)." : NOT_ARRIVED;
  }
  const lines = [`# Address book — ${order} (${list.contacts.length} of ${list.total})`];
  if (!list.address_book_synced) lines.push(`Only the people of your chats so far. ${NOT_ARRIVED}`);
  for (const c of list.contacts) lines.push(`- ${c.name} — ${c.phone} · ${lastLine(c)}`);
  if (list.next !== null) lines.push(`More: pass cursor "${list.next}".`);
  return lines.join("\n");
}

export async function runListContacts(args: { order: AddressBookOrder; limit: number; cursor?: string }, ctx: ToolCtx): Promise<ToolResult> {
  if (typeof ctx.wa.listContacts !== "function") {
    throw new WazapError("SERVICE_ERROR", `Account "${ctx.accountId}" cannot list its address book.`, "Restart the wazap server so every account runs this version");
  }
  const list = await ctx.wa.listContacts({
    order: args.order,
    limit: args.limit,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    private: await privateRule(ctx.hub, ctx.accountId),
  });
  const structured: Record<string, unknown> = {
    order: args.order,
    count: list.contacts.length,
    total: list.total,
    contacts: list.contacts,
    next: list.next,
    address_book_synced: list.address_book_synced,
    sync: list.sync,
  };
  return { content: [{ type: "text", text: renderContactList(list, args.order) }], structuredContent: structured };
}
