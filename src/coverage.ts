/**
 * How much of the local history a keyword search covered. A search that
 * answers "no messages found" must still say how much was looked through, so
 * an empty result never reads as an empty history.
 *
 * The service counts it off the account database: every visible message of a
 * real chat inside the chat scope and the time filters, and the dates of the
 * oldest and newest. There is no per-chat cap: every message the phone synced
 * to this device is kept and searched.
 */

import type { RecallStatus } from "./recall/index.js";
import type { WhatsAppApi } from "./wa-types.js";

export interface SearchCoverage {
  /** Messages the search ran over: in scope, and inside the time filters. */
  searched: number;
  /** Distinct chats those messages span. */
  chats: number;
  /** ISO bounds of the searched window; null when the scope held nothing. */
  oldest_at: string | null;
  newest_at: string | null;
  /** Always null: no chat is capped any more. Kept so a reader of the field finds it. */
  per_chat_cap: number | null;
}

/**
 * The coverage of one search by words, or null when `wa` is a stand-in
 * that cannot count it. Never throws: a coverage miss must not take a working
 * search down with it.
 */
export function searchCoverage(
  wa: WhatsAppApi,
  chatId: string | undefined,
  opts: { sinceMs?: number; untilMs?: number; tag?: string } = {}
): SearchCoverage | null {
  try {
    return typeof wa.searchCoverage === "function" ? wa.searchCoverage(chatId, opts) : null;
  } catch {
    return null;
  }
}

const thousands = (n: number): string => n.toLocaleString("en-US");

/**
 * The line a keyword-search result carries: how many messages were searched
 * and over what span. With nothing to count, it says where it searched.
 */
export function coverageNote(cov: SearchCoverage | null, scoped: boolean): string {
  const kept = "every message this device synced is kept";
  if (cov === null) return `Searched the messages wazap holds locally; ${kept}.`;
  if (cov.searched === 0) return `Searched 0 held messages; ${kept}.`;
  const span =
    cov.oldest_at === null || cov.newest_at === null
      ? ""
      : `, ${cov.oldest_at.slice(0, 10)} → ${cov.newest_at.slice(0, 10)}`;
  const what = scoped ? "of this chat" : `across ${cov.chats} ${cov.chats === 1 ? "chat" : "chats"}`;
  return `Searched ${thousands(cov.searched)} held messages ${what}${span}; ${kept}.`;
}

/** The recall counterpart: the vectors are the semantic window, and pending messages are still being embedded. */
export function indexCoverageNote(index: RecallStatus): string {
  const pending = index.pending > 0 ? ` (${thousands(index.pending)} still indexing)` : "";
  return `The recall index covers ${thousands(index.indexed)} messages${pending}.`;
}
