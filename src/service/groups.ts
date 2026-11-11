/**
 * The account's groups: reading one, creating, joining from an invite, and the
 * admin actions manage_group takes, with the metadata cache behind them. Part
 * of WhatsAppService (src/whatsapp.ts), which lends the socket and its write
 * guards through GroupsHost.
 */

import { performance } from "node:perf_hooks";
import {
  normalizeMessageContent,
  type GroupMetadata,
  type GroupParticipant,
  type proto,
  type WAMessage,
  type WASocket,
} from "baileys";
import { WazapError } from "../errors.js";
import { isGroupId } from "../ids.js";
import { logError } from "../logger.js";
import { isoWithOffset, protoNumber } from "../messages.js";
import { describe, loadProfilePicture } from "../outgoing-media.js";
import type {
  GroupAction,
  GroupActionResult,
  GroupInfo,
  JoinGroupResult,
  JoinRequest,
  MediaSource,
  ParticipantResult,
} from "../wa-types.js";
import type { AccountIdentity } from "./identity.js";
import { orNullAfter, PROFILE_LOOKUP_MS, statusCodeOf } from "./util.js";
import type { MessageViews } from "./views.js";

/** What the service lends the groups: the socket behind its guards, and where a group's names are learned. */
export interface GroupsHost {
  /** Runs a tool's work, turning a thrown fault into the error the tool reports. */
  guarded<T>(work: () => Promise<T>): Promise<T>;
  ensureConnected(): WASocket;
  /** The socket for a write: connected, not read-only, within the rate limit. */
  beginWrite(): WASocket;
  /** Metadata just read: the names it carries are learned. */
  learnGroup(meta: GroupMetadata): void;
}

/**
 * How long a send addresses a group's members as they were last read whole
 * from WhatsApp, as Baileys' own example caches them: a change no event
 * reported (one made while the socket was down, a disappearing-messages
 * setting, an addressing mode) reaches the sends within this.
 */
export const SEND_METADATA_MS = 5 * 60_000;

/** When a group read was asked for, and its place among reads and re-read requests. */
interface Asked {
  at: number;
  order: number;
}

export class AccountGroups {
  /** Group metadata by jid, as last read or updated. */
  readonly groupCache = new Map<string, GroupMetadata>();
  /** Groups whose metadata WhatsApp refused, so we stop asking on every read. */
  readonly unreadableGroups = new Set<string>();
  /**
   * When each cached group's last whole read from WhatsApp was asked for: the
   * clock below, which a send trusts it for SEND_METADATA_MS by, and its place
   * in the order of reads and re-read requests.
   */
  private readonly readWhole = new Map<string, Asked>();
  /** A send trusts only a read asked for after these in that order: per group, and for every group (a reconnect). */
  private readonly rereadAfter = new Map<string, number>();
  private rereadAllAfter = 0;
  private order = 0;
  /** A send's read of a group in flight, shared by the sends to it that wait. */
  private readonly sendReads = new Map<string, Promise<GroupMetadata | undefined>>();

  constructor(
    private readonly host: GroupsHost,
    private readonly identity: AccountIdentity,
    private readonly views: MessageViews,
    private readonly now: () => number = () => performance.now()
  ) {}

  getGroupInfo(groupId: string): Promise<GroupInfo> {
    return this.host.guarded(async () => {
      this.host.ensureConnected();
      const jid = this.identity.resolveId(groupId);
      if (!isGroupId(jid)) {
        throw new WazapError("GROUP_NOT_FOUND", `"${groupId}" is not a group id.`, "Group ids end in @g.us");
      }
      const meta = await this.groupMeta(jid, true);
      const mine = this.myParticipation(meta);
      if (!mine) {
        throw new WazapError("NOT_A_PARTICIPANT", `The linked account is not a participant of ${jid}.`);
      }
      const iAmAdmin = isAdmin(mine);

      const info: GroupInfo = {
        chat_id: jid,
        name: meta.subject,
        description: meta.desc ?? null,
        owner: meta.owner ? this.identity.canonical(meta.owner) : null,
        created_at: meta.creation ? isoWithOffset(meta.creation * 1000) : null,
        participant_count: meta.participants.length,
        participants: meta.participants.slice(0, MAX_GROUP_PARTICIPANTS).map((p) => {
          const id = this.identity.canonical(p.id);
          return { contact_id: id, name: this.identity.displayName(id), is_admin: isAdmin(p) };
        }),
        announcement_only: Boolean(meta.announce),
        i_am_admin: iAmAdmin,
        info_locked: Boolean(meta.restrict),
        member_add_mode: meta.memberAddMode ? "all" : "admins",
        join_approval: Boolean(meta.joinApprovalMode),
        disappearing_seconds: meta.ephemeralDuration ?? 0,
      };
      if (meta.isCommunity || meta.linkedParent) {
        info.community = {
          is_community: Boolean(meta.isCommunity),
          parent_group_id: meta.linkedParent ? this.identity.canonical(meta.linkedParent) : null,
        };
      }

      if (iAmAdmin) {
        const link = await this.inviteLink(jid).catch(() => null);
        if (link) info.invite_link = link;
      }
      return info;
    });
  }

  createGroup(name: string, participantIds: string[]): Promise<{ chat_id: string; participants: ParticipantResult[] }> {
    return this.host.guarded(async () => {
      const sock = this.host.beginWrite();
      const ids = participantIds.map((id) => this.identity.resolveId(id));
      const meta = await sock.groupCreate(name, ids);
      this.cacheGroup(this.identity.canonical(meta.id), meta);
      const present = new Set(meta.participants.map((p) => this.identity.canonical(p.id)));
      return {
        chat_id: this.identity.canonical(meta.id),
        participants: ids.map((id) =>
          present.has(id)
            ? { id, status: "ok" as const }
            : { id, status: "failed" as const, reason: "WhatsApp did not add this participant" }
        ),
      };
    });
  }

  /**
   * Join a group from an invite: a chat.whatsapp.com link or its bare code, or
   * an invite message someone sent. Without confirm it only looks the group up,
   * so the user sees what they would join. The code goes to WhatsApp and
   * nowhere else: not into a result, an error or a log line.
   */
  joinGroup(opts: { invite?: string; messageId?: string; confirm: boolean }): Promise<JoinGroupResult> {
    return this.host.guarded(async () => {
      if ((opts.invite === undefined) === (opts.messageId === undefined)) {
        throw new WazapError(
          "INVALID_ID",
          "Pass exactly one of invite or message_id.",
          'invite takes a https://chat.whatsapp.com/ link or its code; message_id an "invite" message from read_messages'
        );
      }
      const invite = opts.messageId === undefined ? undefined : this.inviteMessageOf(opts.messageId);
      const code = invite?.code ?? inviteCodeOf(opts.invite ?? "");
      const unknown = { description: null, participant_count: null, join_approval: null };

      if (!opts.confirm) {
        const sock = this.host.ensureConnected();
        let meta: GroupMetadata;
        try {
          meta = await sock.groupGetInviteInfo(code);
        } catch (err) {
          // An invite message still names its group when WhatsApp will not describe it.
          if (invite === undefined) throw inviteRefused(err);
          return { status: "preview", group_id: this.identity.canonical(invite.groupJid), name: invite.name, ...unknown };
        }
        return {
          status: "preview",
          group_id: this.identity.canonical(meta.id),
          name: meta.subject || null,
          description: meta.desc ?? null,
          participant_count: meta.size ?? meta.participants.length,
          join_approval: Boolean(meta.joinApprovalMode),
        };
      }

      const sock = this.host.beginWrite();
      if (invite !== undefined) {
        const from: unknown = await sock.groupAcceptInviteV4(invite.raw.key, invite.message).catch((err: unknown) => {
          throw inviteRefused(err);
        });
        const group = typeof from === "string" && isGroupId(from) ? from : invite.groupJid;
        return { status: "joined", group_id: this.identity.canonical(group), name: invite.name, ...unknown };
      }
      const group = await sock.groupAcceptInvite(code).catch((err: unknown) => {
        throw inviteRefused(err);
      });
      // A group that asks for approval answers with the request, not the group,
      // and Baileys hands back nothing: the account is not in yet.
      return group
        ? { status: "joined", group_id: this.identity.canonical(group), name: null, ...unknown }
        : { status: "pending_approval", group_id: null, name: null, ...unknown };
    });
  }

  manageGroup(
    groupId: string,
    action: GroupAction,
    participantIds?: string[],
    value?: string,
    source?: MediaSource
  ): Promise<GroupActionResult> {
    return this.host.guarded(async () => {
      const sock = this.host.beginWrite();
      const jid = this.identity.resolveId(groupId);
      if (!isGroupId(jid)) {
        throw new WazapError("GROUP_NOT_FOUND", `"${groupId}" is not a group id.`, "Group ids end in @g.us");
      }

      // A setting's value is checked first, so a bad one never reaches WhatsApp, not even the admin lookup.
      const choices = GROUP_SETTINGS[action];
      const setting = choices ? settingFor(action, value, choices) : undefined;
      if (ADMIN_ACTIONS.has(action)) await this.assertGroupAdmin(jid, action);
      const ids = (participantIds ?? []).map((id) => this.identity.resolveId(id));
      if (PARTICIPANT_ACTIONS.has(action) && ids.length === 0) {
        throw new WazapError("INVALID_ID", `The "${action}" action needs at least one participant id.`);
      }

      switch (action) {
        case "add":
        case "remove":
        case "promote":
        case "demote": {
          const results = await sock.groupParticipantsUpdate(jid, ids, action);
          this.groupCache.delete(jid);
          return {
            group_id: jid,
            action,
            applied: `${action} ${ids.length} participant(s)`,
            participants: results.map((entry, index) => this.participantResult(entry, ids[index])),
          };
        }
        case "leave":
          await sock.groupLeave(jid);
          this.groupCache.delete(jid);
          return { group_id: jid, action, applied: "left the group" };
        case "set_subject": {
          const subject = requireValue(value, "set_subject", "the new group name");
          await sock.groupUpdateSubject(jid, subject);
          this.groupCache.delete(jid);
          return { group_id: jid, action, applied: `subject set to "${subject}"` };
        }
        case "set_description": {
          const description = requireValue(value, "set_description", "the new description");
          await sock.groupUpdateDescription(jid, description);
          this.groupCache.delete(jid);
          return { group_id: jid, action, applied: "description updated" };
        }
        case "set_picture": {
          // The same loader as the account's own photo, so a bad file fails the same way.
          const media = await loadProfilePicture(source ?? {});
          await sock.updateProfilePicture(jid, media.buffer);
          const picture = await orNullAfter(sock.profilePictureUrl(jid, "image"), PROFILE_LOOKUP_MS);
          return { group_id: jid, action, applied: "group photo updated", profile_pic_url: picture ?? null };
        }
        case "remove_picture":
          await sock.removeProfilePicture(jid);
          return { group_id: jid, action, applied: "group photo removed" };
        case "get_invite_link": {
          const link = await this.inviteLink(jid);
          return { group_id: jid, action, applied: "invite link fetched", invite_link: link };
        }
        case "revoke_invite_link": {
          const code = await sock.groupRevokeInvite(jid);
          const link = code ? `https://chat.whatsapp.com/${code}` : undefined;
          return {
            group_id: jid,
            action,
            applied: "invite link revoked",
            ...(link ? { invite_link: link } : {}),
          };
        }
        case "list_join_requests": {
          const listed = await sock.groupRequestParticipantsList(jid);
          const requests = listed.filter((attrs) => attrs.jid).map((attrs) => this.joinRequest(attrs));
          return {
            group_id: jid,
            action,
            applied: `${requests.length} pending join request(s)`,
            join_requests: requests,
          };
        }
        case "approve_join_requests":
        case "reject_join_requests": {
          const verdict = action === "approve_join_requests" ? "approve" : "reject";
          const results = await sock.groupRequestParticipantsUpdate(jid, ids, verdict);
          this.groupCache.delete(jid);
          return {
            group_id: jid,
            action,
            applied: `${verdict} ${ids.length} join request(s)`,
            // A refused approval is not a cue to send an invite, so no invite_needed here.
            participants: results.map((entry, index) => this.participantResult(entry, ids[index], false)),
          };
        }
        case "set_announcement_only":
        case "set_info_locked":
        case "set_add_mode":
        case "set_join_approval":
        case "set_disappearing": {
          if (!setting) throw new WazapError("INVALID_ID", `The "${action}" action needs a value.`);
          await setting.apply(sock, jid);
          this.groupCache.delete(jid);
          return { group_id: jid, action, applied: setting.applied };
        }
      }
    });
  }

  async groupMeta(jid: string, fresh = false): Promise<GroupMetadata> {
    const cached = this.groupCache.get(jid);
    if (cached && !fresh) return cached;
    const sock = this.host.ensureConnected();
    const asked = this.ask();
    let meta: GroupMetadata;
    try {
      meta = await sock.groupMetadata(jid);
    } catch (err) {
      const code = statusCodeOf(err);
      if (code === 403) throw new WazapError("NOT_A_PARTICIPANT", `The linked account is not in ${jid}.`);
      if (code === 404) throw new WazapError("GROUP_NOT_FOUND", `WhatsApp does not know the group ${jid}.`);
      throw new WazapError("GROUP_NOT_FOUND", `Could not read ${jid}: ${describe(err)}`);
    }
    this.cacheGroup(jid, meta, asked);
    return meta;
  }

  /**
   * What Baileys addresses a group message with (its cachedGroupMetadata): the
   * metadata this cache holds when it was read whole from WhatsApp less than
   * SEND_METADATA_MS ago on this socket, so most sends to a group cost no
   * metadata round trip. Anything else is read again first: a group not
   * cached, one whose members changed (group-participants.update drops it),
   * one whose disappearing-messages setting changed, and every group after a
   * reconnect. A read WhatsApp fails rejects with WhatsApp's own error, which
   * relayMessage does not catch: the send fails after that one query, as it
   * did when Baileys asked itself, and send.ts tells a timeout or a dropped
   * link from a refusal as before. Undefined when there is no socket to ask
   * on, or the group is one reads already gave up on: Baileys then asks
   * WhatsApp itself, as it did before, and reports what it says.
   */
  forSend(jid: string): Promise<GroupMetadata | undefined> {
    const key = this.identity.canonical(jid);
    if (!isGroupId(key)) return Promise.resolve(undefined);
    const cached = this.groupCache.get(key);
    const read = this.readWhole.get(key);
    const after = Math.max(this.rereadAllAfter, this.rereadAfter.get(key) ?? 0);
    if (cached !== undefined && read !== undefined && read.order > after && this.now() - read.at < SEND_METADATA_MS) {
      return Promise.resolve(cached);
    }
    if (this.unreadableGroups.has(key)) return Promise.resolve(undefined);
    const pending = this.sendReads.get(key);
    if (pending !== undefined) return pending;
    let sock: WASocket;
    try {
      sock = this.host.ensureConnected();
    } catch {
      return Promise.resolve(undefined);
    }
    const reading: Promise<GroupMetadata | undefined> = this.readForSend(sock, key).finally(() => {
      if (this.sendReads.get(key) === reading) this.sendReads.delete(key);
    });
    this.sendReads.set(key, reading);
    return reading;
  }

  private async readForSend(sock: WASocket, jid: string): Promise<GroupMetadata> {
    const asked = this.ask();
    const meta = await sock.groupMetadata(jid);
    try {
      this.cacheGroup(jid, meta, asked);
    } catch (err) {
      // The members are cached before their names are learned; a store that
      // refuses the names does not fail the send they were read for.
      logError("learn a group's members before a send", err);
    }
    return meta;
  }

  /**
   * The next send to `jid` (to every group, without one) reads its metadata
   * again first: a setting changed that no group event carries, or the socket
   * is new and may have missed changes while it was down. A read already in
   * flight was asked for before the change, so it does not count. Reads keep
   * the cache.
   */
  rereadBeforeSend(jid?: string): void {
    if (jid === undefined) {
      this.rereadAllAfter = ++this.order;
      this.sendReads.clear();
      return;
    }
    this.rereadAfter.set(jid, ++this.order);
    this.sendReads.delete(jid);
  }

  private ask(): Asked {
    return { at: this.now(), order: ++this.order };
  }

  /**
   * Metadata read whole from WhatsApp: a group query (asked for as `asked`),
   * a group just created, or one the account was just added to.
   */
  cacheGroup(jid: string, meta: GroupMetadata, asked = this.ask()): void {
    this.groupCache.set(jid, meta);
    this.readWhole.set(jid, asked);
    this.host.learnGroup(meta);
  }

  /**
   * Reading a group for the first time costs one metadata fetch, after which its
   * senders resolve from cache. A group we cannot read — left, deleted — is not
   * worth failing the read over, and asking again on every read would cost a
   * round trip per message page forever.
   */
  async learnParticipants(jid: string): Promise<void> {
    if (!isGroupId(jid) || this.groupCache.has(jid) || this.unreadableGroups.has(jid)) return;
    await this.groupMeta(jid).catch(() => this.unreadableGroups.add(jid));
  }

  myParticipation(meta: GroupMetadata): GroupParticipant | undefined {
    return meta.participants.find((p) => this.identity.isMe(p.id) || (p.phoneNumber && this.identity.isMe(p.phoneNumber)));
  }

  async assertGroupAdmin(jid: string, action: GroupAction | "delete_message"): Promise<void> {
    const meta = await this.groupMeta(jid);
    const mine = this.myParticipation(meta);
    if (!mine) throw new WazapError("NOT_A_PARTICIPANT", `The linked account is not in ${jid}.`);
    if (!isAdmin(mine)) {
      throw new WazapError(
        "NOT_ADMIN",
        `"${action}" needs admin rights in "${meta.subject}".`,
        "Ask an admin of the group to make the linked account an admin, or to make this change themselves"
      );
    }
  }

  /** The invite a message carries, checked before WhatsApp is asked about it. */
  private inviteMessageOf(messageId: string): {
    raw: WAMessage;
    message: proto.Message.IGroupInviteMessage;
    code: string;
    groupJid: string;
    name: string | null;
  } {
    const raw = this.views.messageOrThrow(messageId);
    const message = normalizeMessageContent(raw.message)?.groupInviteMessage;
    if (!message) {
      throw new WazapError(
        "INVALID_ID",
        `Message ${messageId} is not a group invite.`,
        'Pass a message_id whose type is "invite", or the invite link as invite'
      );
    }
    const expires = protoNumber(message.inviteExpiration) ?? 0;
    // Baileys empties the code of an invite once it has been accepted.
    if (!message.inviteCode || !message.groupJid || (expires > 0 && expires * 1000 <= Date.now())) {
      throw new WazapError(
        "WHATSAPP_ERROR",
        `The invite in ${messageId} has expired or was already used.`,
        "Ask the sender for a fresh invite"
      );
    }
    return { raw, message, code: message.inviteCode, groupJid: message.groupJid, name: message.groupName || null };
  }

  private async inviteLink(jid: string): Promise<string> {
    const sock = this.host.ensureConnected();
    const code = await sock.groupInviteCode(jid);
    if (!code) throw new WazapError("WHATSAPP_ERROR", `WhatsApp returned no invite code for ${jid}.`);
    return `https://chat.whatsapp.com/${code}`;
  }

  private participantResult(
    entry: { status: string; jid: string | undefined },
    fallback?: string,
    inviteable = true
  ): ParticipantResult {
    const id = entry.jid ? this.identity.canonical(entry.jid) : (fallback ?? "");
    if (entry.status === "200") return { id, status: "ok" };
    if (inviteable && INVITE_NEEDED_CODES.has(entry.status)) {
      return { id, status: "invite_needed", reason: entry.status };
    }
    return { id, status: "failed", reason: entry.status };
  }

  /**
   * One pending join request. Baileys hands over the raw attributes of WhatsApp's
   * node untyped: `jid`, and `request_time` (seconds) and `request_method` when sent.
   */
  private joinRequest(attrs: { [key: string]: string }): JoinRequest {
    const id = this.identity.canonical(attrs.jid ?? "");
    const seconds = Number(attrs.request_time);
    return {
      id,
      name: this.identity.displayName(id),
      requested_at: seconds > 0 ? isoWithOffset(seconds * 1000) : null,
      method: attrs.request_method || null,
    };
  }
}

const MAX_GROUP_PARTICIPANTS = 500;

const ADMIN_ACTIONS = new Set<GroupAction>([
  "add",
  "remove",
  "promote",
  "demote",
  "set_subject",
  "set_description",
  "set_picture",
  "remove_picture",
  "get_invite_link",
  "revoke_invite_link",
  "list_join_requests",
  "approve_join_requests",
  "reject_join_requests",
  "set_announcement_only",
  "set_info_locked",
  "set_add_mode",
  "set_join_approval",
  "set_disappearing",
]);

const PARTICIPANT_ACTIONS = new Set<GroupAction>([
  "add",
  "remove",
  "promote",
  "demote",
  "approve_join_requests",
  "reject_join_requests",
]);

interface GroupSetting {
  applied: string;
  apply: (sock: WASocket, jid: string) => Promise<void>;
}

const DAY_SECONDS = 86_400;

/** The values each setting action takes, what each asks WhatsApp for, and how the result reads. */
const GROUP_SETTINGS: Partial<Record<GroupAction, Record<string, GroupSetting>>> = {
  set_announcement_only: {
    on: { applied: "only admins can send messages", apply: (sock, jid) => sock.groupSettingUpdate(jid, "announcement") },
    off: {
      applied: "every member can send messages",
      apply: (sock, jid) => sock.groupSettingUpdate(jid, "not_announcement"),
    },
  },
  set_info_locked: {
    on: { applied: "only admins can edit the group info", apply: (sock, jid) => sock.groupSettingUpdate(jid, "locked") },
    off: {
      applied: "every member can edit the group info",
      apply: (sock, jid) => sock.groupSettingUpdate(jid, "unlocked"),
    },
  },
  set_add_mode: {
    admins: { applied: "only admins can add members", apply: (sock, jid) => sock.groupMemberAddMode(jid, "admin_add") },
    all: { applied: "every member can add members", apply: (sock, jid) => sock.groupMemberAddMode(jid, "all_member_add") },
  },
  set_join_approval: {
    on: { applied: "admins approve new members", apply: (sock, jid) => sock.groupJoinApprovalMode(jid, "on") },
    off: { applied: "new members join without approval", apply: (sock, jid) => sock.groupJoinApprovalMode(jid, "off") },
  },
  // The durations WhatsApp offers; 0 is what Baileys turns into "off".
  set_disappearing: {
    off: { applied: "disappearing messages off", apply: (sock, jid) => sock.groupToggleEphemeral(jid, 0) },
    "24h": {
      applied: "disappearing messages set to 24h",
      apply: (sock, jid) => sock.groupToggleEphemeral(jid, DAY_SECONDS),
    },
    "7d": {
      applied: "disappearing messages set to 7d",
      apply: (sock, jid) => sock.groupToggleEphemeral(jid, 7 * DAY_SECONDS),
    },
    "90d": {
      applied: "disappearing messages set to 90d",
      apply: (sock, jid) => sock.groupToggleEphemeral(jid, 90 * DAY_SECONDS),
    },
  },
};

/** The setting a value names, or INVALID_ID with a fix listing the values the action takes. */
function settingFor(action: GroupAction, value: string | undefined, choices: Record<string, GroupSetting>): GroupSetting {
  const key = (value ?? "").trim().toLowerCase();
  if (Object.hasOwn(choices, key)) return choices[key];
  const allowed = Object.keys(choices)
    .map((choice) => `"${choice}"`)
    .join(", ");
  throw new WazapError(
    "INVALID_ID",
    key ? `"${value}" is not a value the "${action}" action takes.` : `The "${action}" action needs a value.`,
    `Pass value as one of ${allowed}`
  );
}

/** WhatsApp answers "cannot add, invite them instead" with these codes. */
const INVITE_NEEDED_CODES = new Set(["403", "409"]);

/** The code in a chat.whatsapp.com link, or a bare code. What is refused is not repeated back. */
function inviteCodeOf(invite: string): string {
  const trimmed = invite.trim();
  const match =
    /^(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,64})\/?(?:[?#].*)?$/i.exec(trimmed) ??
    /^([A-Za-z0-9]{10,64})$/.exec(trimmed);
  if (!match?.[1]) {
    throw new WazapError(
      "INVALID_ID",
      "The invite is neither a https://chat.whatsapp.com/ link nor an invite code.",
      "Pass the link exactly as it was shared"
    );
  }
  return match[1];
}

/** WhatsApp's refusal of an invite. Baileys builds its message from WhatsApp's answer, which does not carry the code. */
function inviteRefused(err: unknown): WazapError {
  if (err instanceof WazapError) return err;
  return new WazapError(
    "WHATSAPP_ERROR",
    `WhatsApp refused the invite: ${describe(err)}.`,
    "The link may be reset, expired or mistyped: ask for a fresh invite"
  );
}

export function isAdmin(participant: GroupParticipant): boolean {
  return participant.admin === "admin" || participant.admin === "superadmin";
}

function requireValue(value: string | undefined, action: GroupAction, what: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new WazapError("INVALID_ID", `The "${action}" action needs a value: ${what}.`);
  return trimmed;
}
