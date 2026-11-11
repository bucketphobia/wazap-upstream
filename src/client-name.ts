/**
 * What catch_up keeps a client's mark under when its session is local — stdio,
 * the daemon's loopback bridge, anonymous loopback reads — where no credential
 * names it: the MCP client's own name, `local:<clientInfo.name>`, so Claude
 * Code and Cursor on one machine do not share one mark. A bridge is itself the
 * daemon's client, so it passes its own client's name on in each tool call's
 * `_meta` under CLIENT_META_KEY.
 */

/** A tool call's `_meta` key for the client a bridge serves. */
export const CLIENT_META_KEY = "wazap/client";

export const LOCAL_CLIENT = "local";

/**
 * Whether the session is an assistant talking to a person: stdio and the
 * daemon's bridge (`local`, `local:<client>`), and a hosted agent that signed
 * in (`oauth:<client_id>`). A static token (`token:<label>`) is a builder's own
 * program, which brings its own approval flow, so rules written for the turns
 * of a conversation are not applied to it.
 */
export function isAssistantClient(client: string): boolean {
  return client === LOCAL_CLIENT || client.startsWith(`${LOCAL_CLIENT}:`) || client.startsWith("oauth:");
}

/** `local:<name>` on one line and at most 64 characters; `local` for a client that gave no name. */
export function localClient(name: unknown): string {
  if (typeof name !== "string") return LOCAL_CLIENT;
  const flat = [...name.replace(/[\s\p{Cc}]+/gu, " ").trim()].slice(0, 64).join("");
  return flat === "" ? LOCAL_CLIENT : `${LOCAL_CLIENT}:${flat}`;
}

/**
 * How a session's tool answers are shaped. `full`: a text block and the
 * structured content its outputSchema declares — the contract a program
 * built on wazap reads (docs/stability.md). `text`: the text block alone (and
 * any image blocks), with no outputSchema in its catalogue, for a client that
 * puts the answer in front of a model: Claude Code feeds the model only the
 * structured JSON when there is one, dropping the text; Codex feeds only the
 * structured JSON and drops images too; ChatGPT feeds both. One complete
 * rendering is cheaper for every one of them and lets each see the images.
 */
export type AnswerFormat = "text" | "full";

/** WAZAP_ANSWER_FORMAT: `auto` picks per session (answerFormatFor); the other two hold for every session. */
export type AnswerFormatSetting = AnswerFormat | "auto";

/** What kind of credential opened a session, as the HTTP log names it. */
export type CredentialKind = "oauth" | "token" | "local" | "anonymous";

/**
 * The names assistants' MCP clients give in initialize's clientInfo, as the
 * owner's log shows them: Claude Code (`claude-code`), claude.ai and Claude
 * Desktop (`claude-ai`, `Claude …`), Codex (`codex-mcp-client`, `codex…`),
 * Cursor (`cursor-vscode`, `cursor…`), ChatGPT (`openai-mcp`, `ChatGPT…`) and
 * the Gemini CLI (`gemini-cli…`). Matched case-insensitively.
 */
const ASSISTANT_NAMES: readonly RegExp[] = [/^claude(?:$|[-_. ])/i, /^codex/i, /^cursor/i, /^openai(?:$|[-_. ])/i, /chatgpt/i, /^gemini-cli/i];

/** Whether an initialize's clientInfo.name is an assistant's client. */
export function isAssistantName(name: unknown): boolean {
  return typeof name === "string" && ASSISTANT_NAMES.some((pattern) => pattern.test(name.trim()));
}

/**
 * The format a session gets, decided once at its initialize: the setting when
 * it names one; otherwise `text` for a client that names itself as an
 * assistant, whatever its credential (a static token, OAuth or stdio), and
 * `full` for everything else, which keeps the structured contract. The
 * credential does not decide it: a program can sign in over OAuth as well
 * as an assistant can (n8n, MCP Inspector, a builder's own code), and the
 * format a client wazap does not recognise gets is the one it had before
 * there was a choice.
 */
export function answerFormatFor(setting: AnswerFormatSetting | undefined, clientName: unknown): AnswerFormat {
  if (setting === "text" || setting === "full") return setting;
  return isAssistantName(clientName) ? "text" : "full";
}

/** The formats a session minted under this setting may have: what a revival tries, in order. */
export function possibleFormats(setting: AnswerFormatSetting | undefined): readonly AnswerFormat[] {
  return setting === "text" || setting === "full" ? [setting] : ["text", "full"];
}
