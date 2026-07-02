import fs from 'fs';
import { prefsDB } from './userPrefs.js';
import {
  getContentType,
  downloadContentFromMessage,
  jidNormalizedUser,
  areJidsSameUser,
  extractMessageContent,
} from "@whiskeysockets/baileys";
import { Jimp } from "jimp";

// ── Config constants ──────────────────────────────────────────────────────────
const CLEANUP_MS = Number(process.env.SERIALIZER_RAW_TTL_MS) || 5_000;
const MAX_BODY_LENGTH = Number(process.env.SERIALIZER_MAX_BODY_LEN) || 2_000;
const METADATA_CACHE_TTL =
  Number(process.env.SERIALIZER_METADATA_TTL_MS) || 10_000;
const JPEG = "image/jpeg";

// ─ cache key includes sessionId so sessions never share metadata ─────
const metadataCache = new Map(); // key: `${sessionId}:${groupJid}` → { md, expires }
const gift = Object.freeze({
  key: {
    fromMe: false,
    participant: "917439382677@s.whatsapp.net",
    remoteJid: "status@broadcast",
  },
  message: {
    contactMessage: {
      displayName: "𓆩⃟𝐑𝛂͎᪱ʙʙᷱ᪳ɪ͓ʈ 𝐗ᴹᴅ˺⤹六⤸",
      vcard: [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `N:;𓆩⃟𝐑𝛂͎᪱ʙʙᷱ᪳ɪ͓ʈ 𝐗ᴹᴅ˺⤹六⤸`,
        `FN:𓆩⃟𝐑𝛂͎᪱ʙʙᷱ᪳ɪ͓ʈ 𝐗ᴹᴅ˺⤹六⤸`,
        "item1.TEL;waid=917439382677:917439382677",
        "item1.X-ABLabel:WhatsApp",
        "END:VCARD",
      ].join("\n"),
    },
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Safe jidNormalizedUser — never throws on empty/null input.
 */
function safeJid(jid) {
  try {
    return jid ? jidNormalizedUser(jid) : "";
  } catch {
    return "";
  }
}

/**
 * Extract text body from a message content object by type.
 */
function extractBody(type, content) {
  if (!content) return "";
  switch (type) {
    case "conversation":
      return typeof content === "string" ? content : "";
    case "extendedTextMessage":
      return content.text || "";
    case "imageMessage":
      return content.caption || "";
    case "videoMessage":
      return content.caption || "";
    case "documentMessage":
      return content.caption || "";
    case "templateButtonReplyMessage":
      return content.selectedDisplayText || "";
    case "buttonsResponseMessage":
      return content.selectedButtonId || "";
    case "listResponseMessage":
      return content.singleSelectReply?.selectedRowId || "";
    default:
      return "";
  }
}

/**
 * Download media from a Baileys content object.
 * @param {object} content  - Baileys message content
 * @param {string} type     - message type (e.g. "imageMessage")
 * @returns {Promise<Buffer|null>}
 */
async function _downloadMedia(content, type) {
  if (!content) return null;
  try {
    const mediaType = type.replace("Message", "");
    const stream = await downloadContentFromMessage(content, mediaType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (e) {
    console.error("[serialize] download error:", e?.message || e);
    return null;
  }
}

/**
 * proper square center-crop for profile pictures.
 * Original code did .crop({ x:0, y:0, w, h }) which is a no-op.
 */
export async function makePp(buf) {
  const img = await Jimp.read(buf);
  const w = img.bitmap.width;
  const h = img.bitmap.height;

  // Square crop from center
  const size = Math.min(w, h);
  const x = Math.floor((w - size) / 2);
  const y = Math.floor((h - size) / 2);

  const cropped = img.clone().crop({ x, y, w: size, h: size });

  const imgBuf = await cropped
    .clone()
    .scaleToFit({ w: 324, h: 324 })
    .getBuffer(JPEG);
  const prevBuf = await cropped
    .clone()
    .normalize()
    .resize({ w: 96, h: 96 })
    .getBuffer(JPEG);

  return { img: imgBuf, prev: prevBuf };
}

// ── MsgWrapper ────────────────────────────────────────────────────────────────

class MsgWrapper {
  constructor({
    raw,
    conn,
    sessionId,
    key,
    from,
    fromMe,
    isFromMe,
    isOwner,
    sender,
    isGroup,
    pushName,
    type,
    body,
    content,
    quoted,
    mentions,
    gift,
  }) {
    // Core references
    this.raw = raw;
    this.mek = raw; // alias kept for plugin compat
    this.conn = conn;
    this.client = conn; // alias kept for plugin compat
    this._sessionId = sessionId;
    this._rawGone = false;

    // Message identity
    this.key = key;
    this.id = key.id;
    this.from = from;
    this.fromMe = fromMe;
    this.isFromMe = isFromMe;
    this.isOwner = isOwner;
    this.isfromMe = isFromMe; // typo alias kept for plugin compat
    this.sender = sender;
    this.isGroup = isGroup;
    this.pushName = pushName;

    // Content
    this.type = type;
    this.body = body;
    this.content = content;
    this.quoted = quoted;
    this.mentions = mentions || [];
    this.mention = this.mentions;
    this.bot = safeJid(conn?.user?.id);
    this.botJid = this.bot;
    this.botnum = this.bot.split("@")[0];

    // Group info (populated by loadGroupInfo())
    this.groupMetadata = null;
    this.groupParticipants = [];
    this.groupAdmins = [];
    this.groupOwner = null;
    this.isAdmin = false;
    this.isBotAdmin = false;
    this.joinApprovalMode = false;
    this.memberAddMode = false;
    this.announce = false;
    this.restrict = false;
    this.gift = gift;

    this._createdAt = Date.now();

    // Schedule raw message cleanup to free memory
    if (CLEANUP_MS > 0) {
      const t = setTimeout(() => {
        try {
          this.discardRaw();
        } catch {
          /* ignore */
        }
      }, CLEANUP_MS);
      if (t?.unref) t.unref();
    }
  }

  // ── Group info ─────────────────────────────────────────────────────────────

  /**
   * Load & cache group metadata. Must be awaited before accessing
   * isAdmin, isBotAdmin, groupAdmins, groupOwner etc.
   * cache key now includes sessionId to prevent cross-session bleed.
   */
  async loadGroupInfo() {
    if (!this.isGroup) return this;
    try {
      const now = Date.now();
      // prefix cache key with sessionId
      const cacheKey = `${this._sessionId}:${this.from}`;
      const cached = metadataCache.get(cacheKey);

      let md = null;
      if (cached && cached.expires > now) {
        md = cached.md;
      } else {
        // Prune expired entry
        if (cached) metadataCache.delete(cacheKey);
        try {
          md =
            typeof this.conn.groupMetadata === "function"
              ? await this.conn.groupMetadata(this.from)
              : null;
        } catch {
          md = null;
        }

        if (md) {
          metadataCache.set(cacheKey, {
            md,
            expires: now + METADATA_CACHE_TTL,
          });
        }
      }

      this.groupMetadata = md || {};

      // Normalise participant list
      let participants = [];
      if (Array.isArray(md?.participants)) {
        participants = md.participants;
      } else if (Array.isArray(md?.adminIds)) {
        participants = md.adminIds.map((id) => ({ id, isAdmin: true }));
      }
      this.groupParticipants = participants;

      this.groupAdmins = participants
        .filter(
          (p) =>
            p &&
            (p.isAdmin === true ||
              p.admin === "admin" ||
              p.admin === "superadmin")
        )
        .map((p) => safeJid(typeof p === "string" ? p : p.id));

      this.groupOwner = md?.owner
        ? safeJid(md.owner)
        : this.groupAdmins[0] || null;

      this.joinApprovalMode = md?.joinApprovalMode || false;
      this.memberAddMode = md?.memberAddMode || false;
      this.announce = md?.announce || false;
      this.restrict = md?.restrict || false;

      const botJid = this.conn?.user?.id ? safeJid(this.conn.user.id) : null;
      const botLid = this.conn?.user?.lid ? safeJid(this.conn.user.lid) : null;

      this.isAdmin = this.groupAdmins.some((a) =>
        this.sender ? areJidsSameUser(a, this.sender) : false
      );
      this.isBotAdmin = this.groupAdmins.some(
        (a) =>
          (botJid && areJidsSameUser(a, botJid)) ||
          (botLid && areJidsSameUser(a, botLid))
      );
    } catch (err) {
      console.error("[serialize] loadGroupInfo error:", err?.message || err);
    }
    return this;
  }

  async _refreshCache() {
    // Invalidate cached metadata for this group then reload
    const cacheKey = `${this._sessionId}:${this.from}`;
    metadataCache.delete(cacheKey);
    try {
      await this.loadGroupInfo();
    } catch {
      /* ignore */
    }
  }

  // ── Group action helpers ───────────────────────────────────────────────────

  /**
   * (optimisation): single helper removes repetition across
   * addParticipant / removeParticipant / promoteParticipant / demoteParticipant.
   */
  async _groupAction(jid, action) {
    const jids = Array.isArray(jid) ? jid : [jid];
    const normalized = jids.map((j) => safeJid(j)).filter(Boolean);
    const res = await this.conn.groupParticipantsUpdate(
      this.from,
      normalized,
      action
    );
    await this._refreshCache();
    return res;
  }

  async muteGroup() {
    try {
      const res = await this.conn.groupSettingUpdate(this.from, "announcement");
      await this._refreshCache();
      return res;
    } catch (e) {
      console.error("[serialize] muteGroup:", e?.message);
      return null;
    }
  }

  async unmuteGroup() {
    try {
      const res = await this.conn.groupSettingUpdate(
        this.from,
        "not_announcement"
      );
      await this._refreshCache();
      return res;
    } catch (e) {
      console.error("[serialize] unmuteGroup:", e?.message);
      return null;
    }
  }

  async setSubject(text) {
    try {
      const res = await this.conn.groupUpdateSubject(this.from, text);
      await this._refreshCache();
      return res;
    } catch (e) {
      console.error("[serialize] setSubject:", e?.message);
      return null;
    }
  }

  async setDescription(text) {
    try {
      const res = await this.conn.groupUpdateDescription(this.from, text);
      await this._refreshCache();
      return res;
    } catch (e) {
      console.error("[serialize] setDescription:", e?.message);
      return null;
    }
  }

  async addParticipant(jid) {
    try {
      return await this._groupAction(jid, "add");
    } catch (e) {
      console.error("[serialize] addParticipant:", e?.message);
      return null;
    }
  }

  async removeParticipant(jid) {
    try {
      return await this._groupAction(jid, "remove");
    } catch (e) {
      console.error("[serialize] removeParticipant:", e?.message);
      return null;
    }
  }

  async promoteParticipant(jid) {
    try {
      return await this._groupAction(jid, "promote");
    } catch (e) {
      console.error("[serialize] promoteParticipant:", e?.message);
      return null;
    }
  }

  async demoteParticipant(jid) {
    try {
      return await this._groupAction(jid, "demote");
    } catch (e) {
      console.error("[serialize] demoteParticipant:", e?.message);
      return null;
    }
  }

  async leaveGroup() {
    try {
      return await this.conn.groupLeave(this.from);
    } catch (e) {
      console.error("[serialize] leaveGroup:", e?.message);
      return null;
    }
  }

  async inviteCode() {
    try {
      return await this.conn.groupInviteCode(this.from);
    } catch (e) {
      console.error("[serialize] inviteCode:", e?.message);
      return null;
    }
  }

  async revokeInvite() {
    try {
      const res = await this.conn.groupRevokeInvite(this.from);
      await this._refreshCache();
      return res;
    } catch (e) {
      console.error("[serialize] revokeInvite:", e?.message);
      return null;
    }
  }

  async getInviteInfo(code) {
    try {
      return await this.conn.groupGetInviteInfo(code);
    } catch (e) {
      console.error("[serialize] getInviteInfo:", e?.message);
      return null;
    }
  }

  async joinViaInvite(code) {
    try {
      return await this.conn.groupAcceptInvite(code);
    } catch (e) {
      console.error("[serialize] joinViaInvite:", e?.message);
      return null;
    }
  }

  async getJoinRequests() {
    try {
      return await this.conn.groupRequestParticipantsList(this.from);
    } catch (e) {
      console.error("[serialize] getJoinRequests:", e?.message);
      return null;
    }
  }

  async updateJoinRequests(jids, action = "approve") {
    try {
      const normalized = (Array.isArray(jids) ? jids : [jids]).map((j) =>
        safeJid(j)
      );
      const res = await this.conn.groupRequestParticipantsUpdate(
        this.from,
        normalized,
        action
      );
      await this._refreshCache();
      return res;
    } catch (e) {
      console.error("[serialize] updateJoinRequests:", e?.message);
      return null;
    }
  }

  async setMemberAddMode(enable = true) {
    try {
      try {
        const res = await this.conn.groupSettingUpdate(
          this.from,
          enable ? "member_add_mode" : "not_member_add_mode"
        );
        await this._refreshCache();
        return res;
      } catch {
        // Fallback for older Baileys versions
        const res = await this.conn.groupSettingUpdate(
          this.from,
          enable ? "not_announcement" : "announcement"
        );
        await this._refreshCache();
        return res;
      }
    } catch (e) {
      console.error("[serialize] setMemberAddMode:", e?.message);
      return null;
    }
  }

  // ── Participant helpers ─────────────────────────────────────────────────────

  getParticipants() {
    return this.groupParticipants || [];
  }

  isParticipant(jid) {
    const normalized = safeJid(jid);
    return this.getParticipants().some((p) => {
      const pid = typeof p === "string" ? p : p?.id || "";
      return areJidsSameUser(safeJid(pid), normalized);
    });
  }

  // ── Status / profile / block ───────────────────────────────────────────────

  async fetchStatus(jid) {
    try {
      return await this.conn.fetchStatus(safeJid(jid));
    } catch (e) {
      console.error("[serialize] fetchStatus:", e?.message);
      return null;
    }
  }

  async profilePictureUrl(jid, type = "image") {
    try {
      return await this.conn.profilePictureUrl(safeJid(jid), type);
    } catch (e) {
      console.error("[serialize] profilePictureUrl:", e?.message);
      return null;
    }
  }

  async blockUser(jid) {
    try {
      return await this.conn.updateBlockStatus(safeJid(jid), "block");
    } catch (e) {
      console.error("[serialize] blockUser:", e?.message);
      return null;
    }
  }

  async unblockUser(jid) {
    try {
      return await this.conn.updateBlockStatus(safeJid(jid), "unblock");
    } catch (e) {
      console.error("[serialize] unblockUser:", e?.message);
      return null;
    }
  }

  // ── LID helpers ────────────────────────────────────────────────────────────

  async getLID(phoneNumber) {
    try {
      if (!this.conn.signalRepository?.lidMapping) return null;
      return await this.conn.signalRepository.lidMapping.getLIDForPN(
        phoneNumber
      );
    } catch (e) {
      console.error("[serialize] getLID:", e?.message);
      return null;
    }
  }

  async getPN(lid) {
    try {
      if (!this.conn.signalRepository?.lidMapping) return null;
      return await this.conn.signalRepository.lidMapping.getPNForLID(lid);
    } catch (e) {
      console.error("[serialize] getPN:", e?.message);
      return null;
    }
  }

  isPnUser(jid) {
    return !!jid?.includes("@s.whatsapp.net");
  }
  isLidUser(jid) {
    return !!jid?.includes("@lid");
  }

  areJidsSame(jid1, jid2) {
    try {
      return areJidsSameUser(safeJid(jid1), safeJid(jid2));
    } catch {
      return false;
    }
  }

  // ── Profile picture ────────────────────────────────────────────────────────

  async setPp(jid, buf) {
    try {
      const img = await makePp(buf);
      await this.conn.updateProfilePicture(safeJid(jid), img);
      await this._refreshCache().catch(() => {});
      return true;
    } catch (e) {
      console.error("[serialize] setPp:", e?.message);
      return null;
    }
  }

  // ── Media download ─────────────────────────────────────────────────────────

  /**
   * Download the media from this message.
   */
  async download() {
    return _downloadMedia(this.content, this.type);
  }

  // ── sendButton — relay a raw proto message (buttons/interactive) ───────────

  /**
   * Send a raw Baileys proto message object directly via relayMessage.
   * Use this for buttonsMessage, templateMessage, interactiveMessage etc.
   * @param {object} protoMsg - raw proto message object e.g. { buttonsMessage: {...} }
   * @param {string} [jid]    - target JID (defaults to this.from)
   */
  async sendButton(protoMsg, jid = null) {
    try {
      const target = jid || this.from;
      return await this.conn.relayMessage(target, protoMsg, {});
    } catch (e) {
      console.error("[serialize] sendButton error:", e?.message);
      return null;
    }
  }

  async send(payload, options = {}) {
    try {
      if (payload?.delete)
        return await this.conn.sendMessage(this.from, {
          delete: payload.delete,
        });
      let cend;
      if (typeof payload === "string") cend = { text: payload };
      else if (payload.video)
        cend = {
          video: payload.video,
          caption: payload.caption || "",
          mimetype: payload.mimetype || "video/mp4",
        };
      else if (payload.image)
        cend = { image: payload.image, caption: payload.caption || "" };
      else if (payload.audio)
        cend = {
          audio: payload.audio,
          mimetype: payload.mimetype || "audio/mp4",
          ptt: payload.ptt || false,
        };
      else cend = payload;
      if (options.mentions) cend.mentions = options.mentions;
      if (options.edit) cend.edit = options.edit;
      return await this.conn.sendMessage(this.from, cend, {
  quoted: options.quoted || (() => {
    const num = (this.sender || "").split("@")[0].split(":")[0];
    return prefsDB.get(num, "vcard") === false ? this.raw : gift;
  })(),
});
     
    } catch (e) {
      console.error("Error sending message:", e);
      return null;
    }
  }

  async replyMethod(payload, options = {}) {
    try {
      if (payload?.delete)
        return await this.conn.sendMessage(this.from, {
          delete: payload.delete,
        });
      let cend;
      if (typeof payload === "string") cend = { text: payload };
      else if (payload.video)
        cend = {
          video: payload.video,
          caption: payload.caption || "",
          mimetype: payload.mimetype || "video/mp4",
        };
      else if (payload.image)
        cend = { image: payload.image, caption: payload.caption || "" };
      else if (payload.audio)
        cend = {
          audio: payload.audio,
          mimetype: payload.mimetype || "audio/mp4",
          ptt: payload.ptt || false,
        };
      else cend = payload;
      if (options.mentions) cend.mentions = options.mentions;
      if (options.edit) cend.edit = options.edit;
      return await this.conn.sendMessage(this.from, cend, { quoted: this.raw });
    } catch (e) {
      console.error("Error sending reply:", e);
      return null;
    }
  }

  // Aliases kept for full plugin backward-compatibility
  sendreply(payload, options = {}) {
    return this.replyMethod(payload, options);
  }
  sendReply(payload, options = {}) {
    return this.replyMethod(payload, options);
  }
  reply(payload, options = {}) {
    return this.replyMethod(payload, options);
  }

  async react(emoji) {
    try {
      return await this.conn.sendMessage(this.from, {
        react: { text: emoji, key: this.key },
      });
    } catch (e) {
      console.error("[serialize] react:", e?.message);
      return null;
    }
  }

  // ── Raw cleanup ────────────────────────────────────────────────────────────

  /**
   * Release raw message reference to free memory.
   * Called automatically after CLEANUP_MS.
   */
  discardRaw() {
    this._rawGone = true;
    try {
      if (this.raw) delete this.raw;
    } catch {
      /* ignore */
    }
    try {
      if (this.mek) delete this.mek;
    } catch {
      /* ignore */
    }
    try {
      if (this.quoted?.msg) delete this.quoted.msg;
    } catch {
      /* ignore */
    }
  }

  /**
   * FIX #4: returns null (not undefined) after discard, with a clear log.
   */
  getRaw() {
    if (this._rawGone) {
      return null; // clearly null — callers should check before using
    }
    return this.raw || null;
  }
}

// ── Serializer ────────────────────────────────────────────────────────────────

export default class Serializer {
  constructor(conn, sessionId) {
    this.conn = conn;
    this.sessionId = sessionId;
  }

  /**
   * Synchronously turn a raw Baileys message into a MsgWrapper.
   * All expensive work (group metadata, media download) is deferred to async methods.
   */
  serializeSync(msg) {
    const conn = this.conn;
    const key = msg.key || {};

    const from = key.remoteJid || "";
    const fromMe = key.fromMe || false;
    const isGroup = from.endsWith("@g.us");

    // FIX #7: guard jidNormalizedUser against null/empty conn.user
    const sender = safeJid(
      isGroup ? key.participant || key.participantAlt || from : from
    );

    const pushName = msg.pushName || "Unknown";
    const msgContent = extractMessageContent(msg.message);
    const type = getContentType(msgContent || msg.message) || "";
    const content = msgContent?.[type] ?? msg.message?.[type] ?? null;

    // FIX #7: safe isFromMe check
    const botId = conn?.user?.id ? safeJid(conn.user.id) : "";
    const botLid = conn?.user?.lid ? safeJid(conn.user.lid) : "";
    const isFromMe =
      fromMe ||
      (botId && areJidsSameUser(sender, botId)) ||
      (botLid && areJidsSameUser(sender, botLid));

const senderNum =
  sender.split("@")[0].split(":")[0];

const botNum =
  botId.split("@")[0];

// FIX: was reading from global.db which never had sudo data.
// Now reads from ./data/sudo.json — same file Sudo.js plugin writes to.
const _GLOBAL_SUDO = ["917439382677"];
let _sudoData = {};
try {
  if (fs.existsSync("./data/sudo.json")) {
    _sudoData = JSON.parse(fs.readFileSync("./data/sudo.json", "utf-8"));
  }
} catch {}
const _botSudo = Array.isArray(_sudoData[botNum]) ? _sudoData[botNum] : [];
const sudoList = [...new Set([..._GLOBAL_SUDO, ..._botSudo])];

const isOwner =
  isFromMe ||
  sudoList.includes(senderNum);
    
    // Body text
    const rawBody = extractBody(type, content);
    const body =
      typeof rawBody === "string" ? rawBody.slice(0, MAX_BODY_LENGTH) : "";

    // FIX #2: extract contextInfo from ANY message type, not just extendedTextMessage
    const quoted = (() => {
      // Try every possible location where contextInfo can live
      const msgContent2 = extractMessageContent(msg.message);
      const msgType2 = getContentType(msgContent2) || "";
      const contextInfo =
        msgContent2?.[msgType2]?.contextInfo ||
        msg.message?.extendedTextMessage?.contextInfo ||
        msg.message?.imageMessage?.contextInfo ||
        msg.message?.videoMessage?.contextInfo ||
        msg.message?.audioMessage?.contextInfo ||
        msg.message?.stickerMessage?.contextInfo ||
        msg.message?.documentMessage?.contextInfo ||
        msg.message?.buttonsResponseMessage?.contextInfo ||
        msg.message?.listResponseMessage?.contextInfo ||
        null;

      const quotedMsg = contextInfo?.quotedMessage;
      if (!quotedMsg) return null;

      const qt = getContentType(quotedMsg) || "";
      const qContent = quotedMsg[qt];
      const qBody = extractBody(qt, qContent);

      const quotedParticipant = safeJid(
        contextInfo?.participant || contextInfo?.participantAlt || from || ""
      );

      const isQuotedFromMe =
        (botId && areJidsSameUser(quotedParticipant, botId)) ||
        (botLid && areJidsSameUser(quotedParticipant, botLid)) ||
        false;

      return {
        type: qt,
        msg: typeof qContent === "object" ? { ...qContent } : qContent,
        body: typeof qBody === "string" ? qBody.slice(0, MAX_BODY_LENGTH) : "",
        text: typeof qBody === "string" ? qBody.slice(0, MAX_BODY_LENGTH) : "",
        fromMe: isQuotedFromMe,
        participant: quotedParticipant,
        sender: quotedParticipant,
        // Expose common media fields directly for easy plugin access
        mimetype: (typeof qContent === "object" ? qContent?.mimetype : null) || null,
        fileName: (typeof qContent === "object" ? qContent?.fileName : null) || null,
        ptt: (typeof qContent === "object" ? qContent?.ptt : null) || false,
        id: contextInfo?.stanzaId,
        key: {
          remoteJid: from,
          fromMe: isQuotedFromMe,
          id: contextInfo?.stanzaId,
          participant: quotedParticipant,
        },
        // Lazy media download for quoted message
        download: () => _downloadMedia(qContent, qt),
        raw: {
          key: {
            remoteJid: from,
            fromMe: isQuotedFromMe,
            id: contextInfo?.stanzaId,
            participant: quotedParticipant,
          },
          message: quotedMsg,
          pushName: msg.pushName,
        },
      };
    })();

    // FIX: extract mentionedJid from ANY contextInfo location (text, image, video, etc.)
    const _anyCtx =
      msg.message?.extendedTextMessage?.contextInfo ||
      msg.message?.[type]?.contextInfo ||
      msg.message?.imageMessage?.contextInfo ||
      msg.message?.videoMessage?.contextInfo ||
      msg.message?.audioMessage?.contextInfo ||
      msg.message?.documentMessage?.contextInfo ||
      msg.message?.stickerMessage?.contextInfo ||
      null;
    const mentions = Array.isArray(_anyCtx?.mentionedJid) ? _anyCtx.mentionedJid : [];

    return new MsgWrapper({
      raw: msg,
      conn,
      sessionId: this.sessionId,
      key,
      from,
      fromMe,
      isFromMe,
      sender,
      isGroup,
      pushName,
      type,
      body,
      isOwner,
      content,
      quoted,
      mentions,
      gift,
    });
  }
}

// ── Named exports for plugin convenience ──────────────────────────────────────
export { MsgWrapper, gift };
