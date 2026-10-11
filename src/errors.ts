export type ErrorCode =
  | "NOT_LINKED"
  | "ALREADY_LINKED"
  | "SESSION_EXPIRED"
  | "SESSION_CORRUPT"
  | "NOT_CONNECTED"
  | "SYNC_IN_PROGRESS"
  | "INVALID_PHONE"
  | "INVALID_ID"
  | "NOT_ON_WHATSAPP"
  | "CHAT_NOT_FOUND"
  | "MESSAGE_NOT_FOUND"
  | "CONTACT_NOT_FOUND"
  | "GROUP_NOT_FOUND"
  | "NOT_A_PARTICIPANT"
  | "NOT_ADMIN"
  | "GROUP_ANNOUNCEMENT_ONLY"
  | "MEDIA_UNAVAILABLE"
  | "MEDIA_ACCESS_DENIED"
  | "FILE_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "INVALID_IMAGE"
  | "URL_FETCH_FAILED"
  | "TEXT_TOO_LONG"
  | "EDIT_WINDOW_EXPIRED"
  | "RETRACT_WINDOW_EXPIRED"
  | "NOT_OWN_MESSAGE"
  | "READ_ONLY"
  | "RATE_LIMITED"
  | "TRANSCRIBE_UNAVAILABLE"
  | "TRANSCRIBE_FAILED"
  | "RECALL_UNAVAILABLE"
  | "RECALL_FAILED"
  | "RECALL_BAD_INPUT"
  | "TIMEOUT"
  | "SERVICE_ERROR"
  | "DRAFT_NOT_FOUND"
  | "DRAFT_EXPIRED"
  | "DRAFT_STALE"
  | "CURSOR_EXPIRED"
  | "SEND_OUTCOME_UNKNOWN"
  | "SEND_BLOCKED"
  | "INVALID_TIME"
  | "SCHEDULE_NOT_FOUND"
  | "SCHEDULE_FULL"
  | "AMBIGUOUS_ACCOUNT"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_DISABLED"
  | "ACCOUNT_RESTRICTED"
  | "WHATSAPP_ERROR";

export class WazapError extends Error {
  readonly code: ErrorCode;
  readonly fix?: string;

  constructor(code: ErrorCode, message: string, fix?: string) {
    super(message);
    this.name = "WazapError";
    this.code = code;
    this.fix = fix;
  }
}

export const RELINK_FIX = "Run `npx wazap-mcp login`";
export const RESET_FIX = "Run `npx wazap-mcp logout` then `npx wazap-mcp login`";

/** What an agent should do about each code. Rendered by the `learn` tool, so each is one short line. */
export const ERROR_GUIDE: Record<ErrorCode, string> = {
  NOT_LINKED: "Nothing is linked: link_account, or the user runs `npx wazap-mcp login`.",
  ALREADY_LINKED: "Already linked; call get_status.",
  SESSION_EXPIRED: "The phone unlinked this device: link_account again. Do not retry.",
  SESSION_CORRUPT: "Credentials are unreadable: link_account, or `npx wazap-mcp logout` then `login`.",
  NOT_CONNECTED: "Connecting, or preparing the database after an upgrade: get_status, wait, retry once.",
  ACCOUNT_RESTRICTED:
    "Restricted or banned by WhatsApp; nothing sent. Do not retry.",
  SYNC_IN_PROGRESS: "History is still syncing: retry in a few seconds; older messages may be missing.",
  INVALID_PHONE: "Ask the user for the number with its country code, e.g. +15550100.",
  INVALID_ID: "An id or argument is unusable: read message and fix; pass ids exactly as a tool gave them.",
  NOT_ON_WHATSAPP: "That number has no WhatsApp: confirm it with the user. Do not retry.",
  CHAT_NOT_FOUND: "Unknown chat: take the chat_id from list_chats or find_contact.",
  MESSAGE_NOT_FOUND: "Unknown message: use a message_id from read_messages or search.",
  CONTACT_NOT_FOUND: "Nobody by that name: find_contact first.",
  GROUP_NOT_FOUND: "Unknown group, or not a group id (…@g.us).",
  NOT_A_PARTICIPANT: "The account is not in that group. Do not retry.",
  NOT_ADMIN: "The account is not an admin of that group. Do not retry.",
  GROUP_ANNOUNCEMENT_ONLY: "Only admins may post in that group. Do not retry.",
  MEDIA_UNAVAILABLE: "WhatsApp no longer has that media; the sender must resend it. Do not retry.",
  MEDIA_ACCESS_DENIED:
    "This session cannot use host files: pass a public URL, forward a message, or get_media without save_to. Do not route around it.",
  FILE_NOT_FOUND: "No such file on the machine running wazap: check the path with the user.",
  FILE_TOO_LARGE: "Too large: media up to 100 MB, a group photo up to 10 MB.",
  INVALID_IMAGE: "Not a JPEG, PNG or WebP photo.",
  URL_FETCH_FAILED: "The URL could not be fetched: check it, or pass file_path.",
  TEXT_TOO_LONG: "Over WhatsApp's limit: shorten it, or split it into several messages.",
  EDIT_WINDOW_EXPIRED: "Edits are allowed for 15 minutes: send a correction instead.",
  RETRACT_WINDOW_EXPIRED: "Deleting for everyone is allowed for 2 days. Do not retry.",
  NOT_OWN_MESSAGE:
    "Only the account's own message, anyone's in a group where it is admin, or any with for_everyone: false. Do not retry.",
  READ_ONLY: "Writes are off: the user runs `wazap config writes on` and restarts the server.",
  RATE_LIMITED: "Too fast: wait the seconds in fix, then retry once.",
  TRANSCRIBE_UNAVAILABLE: "Transcription is off or unfinished: tell the user the command in fix. Do not retry.",
  TRANSCRIBE_FAILED: "The transcription provider failed: retry once at most.",
  RECALL_UNAVAILABLE: "Meaning search is off: tell the user the command in fix. Do not retry.",
  RECALL_FAILED: "The embedding backend failed: retry once at most.",
  RECALL_BAD_INPUT: "The embedding server refused this input: do not retry it unchanged.",
  TIMEOUT: "WhatsApp did not answer in time: retry once, then get_status.",
  SERVICE_ERROR: "wazap's background service failed on this machine, not WhatsApp: tell the user the fix.",
  DRAFT_NOT_FOUND: "No such draft in this session: draft again, show the preview, get a fresh yes.",
  DRAFT_EXPIRED: "The draft expired after 15 minutes: draft again, show the new preview and wait for a new yes; the old yes does not carry over.",
  DRAFT_STALE:
    "The talk moved on, so nothing was sent: draft again with send_message, show the new preview and ask for a yes to it.",
  CURSOR_EXPIRED: "The catch_up cursor expired: call catch_up without it; nothing was lost.",
  SEND_OUTCOME_UNKNOWN:
    "It may or may not have arrived: never confirm or draft it again unasked. read_messages shows it once WhatsApp echoes it; not there yet does not mean it failed.",
  SEND_BLOCKED: "The account's send rules refuse this recipient: tell the user. Do not retry or route around it.",
  INVALID_TIME: "Bad time: see fix, ask the user.",
  SCHEDULE_NOT_FOUND: "Unknown id: list again.",
  SCHEDULE_FULL: "Too many waiting: tell the user.",
  AMBIGUOUS_ACCOUNT: "Several accounts fit, or a write names a chat no account knows: pass account_id.",
  ACCOUNT_NOT_FOUND: "No such account: get_status lists them, and `wazap account add` makes one.",
  ACCOUNT_DISABLED: "The account is disabled: the user runs `wazap account enable <id>`.",
  WHATSAPP_ERROR: "WhatsApp refused: read message. Do not blindly retry.",
};


/** Any thrown value as a WazapError, so no tool ever surfaces a raw error. */
export function asWazapError(err: unknown): WazapError {
  if (err instanceof WazapError) return err;
  return new WazapError("WHATSAPP_ERROR", err instanceof Error ? err.message : String(err));
}
