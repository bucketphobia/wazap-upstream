/**
 * A read's chat_id given as a name: "Ana", "mama", "Bloc 12", a nickname or a
 * filed detail. find_contact's own resolver (src/find-contact.ts) decides what
 * it means, across every live account unless the call names one, and only an
 * answer that is one chat on one account is read: "what did mama say" is one
 * call instead of find_contact then read_messages. Anything else is refused
 * with the candidates, chat ids and names, for the agent to ask the user:
 * never a guess. Ids, phone numbers and "status" pass through untouched.
 *
 * Reads only. A send resolves its recipient through find_contact and a
 * preview the user approves; nothing here reaches send_message.
 */
import type { AccountBinding } from "./account-hub.js";
import { asWazapError, WazapError } from "./errors.js";
import { lookupOf, mergeAccounts, type AccountFind, type FoundContact } from "./find-contact.js";
import type { ToolCtx } from "./tool-runtime.js";

/** Candidates a refusal lists, like find_contact's ambiguous answer. */
const CANDIDATES_MAX = 5;

/** A chat_id that is a name, resolved: the chat, the account it is on, and who it is. */
export interface NamedChat {
  chatId: string;
  binding: Pick<AccountBinding, "id" | "wa">;
  /** What the call said, and the name of the chat it resolved to. */
  asked: string;
  name: string;
  kind: "person" | "group";
}

/** Whether a chat_id is a name rather than an id, a phone number or "status". */
export function isChatName(chatId: string): boolean {
  const text = chatId.trim();
  if (text === "" || text.includes("@") || text.toLowerCase() === "status") return false;
  if (lookupOf(text) !== null) return false;
  return /\p{L}/u.test(text);
}

function candidateOf(found: FoundContact, multi: boolean): { chat_id: string; name: string; kind: string; account_id?: string } {
  return { chat_id: found.candidate.jid, name: found.candidate.displayName, kind: found.candidate.kind, ...(multi ? { account_id: found.accountId } : {}) };
}

function listed(candidates: ReadonlyArray<ReturnType<typeof candidateOf>>): string {
  return candidates.map((c) => `${c.name} (${c.chat_id}${c.account_id === undefined ? "" : `, account ${c.account_id}`})`).join("; ");
}

/**
 * The chat `chatId` names, when it is a name; undefined when it is already an
 * id. `accountId` keeps the lookup on that account, as an explicit account_id
 * does; otherwise every live account is asked, and the name resolves only
 * when one account has the only match.
 */
export async function chatByName(chatId: string, accountId: string | undefined, ctx: Pick<ToolCtx, "hub" | "wa" | "accountId">): Promise<NamedChat | undefined> {
  if (!isChatName(chatId)) return undefined;
  const asked = chatId.trim();
  const everyone = accountId === undefined ? ctx.hub.bindings() : [];
  const multi = everyone.length > 1;
  const targets: Array<Pick<AccountBinding, "id" | "wa">> = multi ? everyone : [{ id: ctx.accountId, wa: ctx.wa }];
  const settled = await Promise.allSettled(
    targets.map(async (target) => {
      if (typeof target.wa.findContact !== "function") throw new WazapError("SERVICE_ERROR", `Account "${target.id}" cannot look people up.`);
      return target.wa.findContact({ name: asked, kind: "any", limit: CANDIDATES_MAX });
    })
  );
  const answers: AccountFind[] = [];
  let failures = 0;
  for (const result of settled) {
    if (result.status === "fulfilled") answers.push(result.value);
    else failures++;
  }
  if (answers.length === 0) throw asWazapError(settled.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason);
  const outcome = mergeAccounts(answers, CANDIDATES_MAX);
  // One match where not every account could look is a candidate to confirm, as find_contact has it.
  if (outcome.contact !== null && failures === 0) {
    const found = outcome.contact;
    const binding = targets.find((target) => target.id === found.accountId)!;
    return { chatId: found.candidate.jid, binding, asked, name: found.candidate.displayName, kind: found.candidate.kind };
  }
  const candidates = (outcome.contact !== null ? [outcome.contact] : outcome.status === "ambiguous" ? outcome.candidates : outcome.closest).map((found) => candidateOf(found, multi));
  if (candidates.length > 0 && outcome.status !== "not_found") {
    throw new WazapError(
      "CHAT_NOT_FOUND",
      `"${asked}" could be ${candidates.length === 1 ? "this chat" : `${candidates.length} chats`}: ${listed(candidates)}. Nothing was read.`,
      "Ask the user which one they mean, then pass its chat_id (and account_id when it says one); never pick one yourself",
      { candidates }
    );
  }
  throw new WazapError(
    "CHAT_NOT_FOUND",
    `No chat is named "${asked}"${candidates.length === 0 ? "" : `; the closest: ${listed(candidates)}`}. Nothing was read.`,
    "Ask the user who they mean, or pass a chat_id from list_chats or find_contact",
    candidates.length === 0 ? undefined : { candidates }
  );
}
