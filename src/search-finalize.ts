/** Final search snapshots after identity/metadata awaits; never reuses old words. */
import { WazapError } from "./errors.js";
import type { AccountSource } from "./account-hub.js";
import type { SearchSource, SearchContext, SearchOptions, WhatsAppApi } from "./wa-types.js";

export function searchOwner(wa: WhatsAppApi): string | null {
  return typeof wa.getStatus === "function" ? (wa.getStatus().account?.id ?? null) : null;
}

export function checkSearchSource(hub: AccountSource, accountId: string, wa: WhatsAppApi, owner: string | null): void {
  if (hub.binding(accountId)?.wa !== wa || searchOwner(wa) !== owner) {
    throw new WazapError(
      "NOT_CONNECTED",
      "The account changed during this search.",
      "Retry the search on the intended account"
    );
  }
}

export const SEARCH_CHANGED =
  "Some search sources changed or became unavailable during the read and were omitted. Retry for updated candidates.";

export function finalizeSearch<T extends SearchSource & { sender: object }>(
  wa: WhatsAppApi,
  messages: readonly T[],
  contexts: SearchContext[] | undefined,
  chatId: string | undefined,
  opts: SearchOptions,
  query: string
): { messages: T[]; contexts: SearchContext[] | undefined; changed: boolean } {
  const fresh = wa.refreshSearch?.(messages, chatId, opts, query);
  if (fresh === undefined) return { messages: [...messages], contexts, changed: false };
  const byId = new Map(messages.map((m) => [m.message_id, m]));
  return {
    messages: fresh.rows.map(({ source_id, message }) => {
      const previous = byId.get(source_id)!;
      return { ...previous, ...message, sender: { ...previous.sender, ...message.sender } };
    }),
    contexts: fresh.contexts,
    changed: fresh.dropped > 0,
  };
}
