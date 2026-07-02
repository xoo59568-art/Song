// ══════════════════════════════════════════════════════════════════════════════
// checkRawMessage.js
// Antibot / Antimention / AntiGStatus
// Path: /home/container/mami/lib/checkRawMessage.js
// ══════════════════════════════════════════════════════════════════════════════

import { db, manager } from "./client.js";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ── Warn store (in-memory) ────────────────────────────────────────────────────
const _warnStore = new Map();
const WARN_LIMIT = 3;

function _warnCount(groupJid, senderJid) {
  return _warnStore.get(`${groupJid}:${senderJid}`) || 0;
}

function _warnIncrement(groupJid, senderJid) {
  const key   = `${groupJid}:${senderJid}`;
  const count = (_warnStore.get(key) || 0) + 1;
  _warnStore.set(key, count);
  return count;
}

function _warnReset(groupJid, senderJid) {
  _warnStore.delete(`${groupJid}:${senderJid}`);
}

// ── Execute action: kick / warn / delete ──────────────────────────────────────
async function executeAction(sock, groupJid, senderJid, msgKey, action, reason, sessionId) {
  const senderNum = senderJid.split("@")[0].split(":")[0];

  if (action === "delete") {
    try {
      await sock.sendMessage(groupJid, { delete: msgKey });
      logger.info({ sessionId, groupJid, senderNum }, `🗑️ ${reason} | delete success`);
    } catch (e) {
      logger.warn({ sessionId }, `[checkRaw] delete failed: ${e?.message}`);
    }

  } else if (action === "warn") {
    const count = _warnIncrement(groupJid, senderJid);

    if (count >= WARN_LIMIT) {
      try {
        await sock.sendMessage(groupJid, {
          text: `⚠️ *${reason}*\n\n👤 @${senderNum} has reached ${WARN_LIMIT} warnings.\n🚫 Removing from group.`,
          mentions: [senderJid],
        });
        await sock.groupParticipantsUpdate(groupJid, [senderJid], "remove");
        _warnReset(groupJid, senderJid);
        logger.info({ sessionId, groupJid, senderNum }, `✅ ${reason} | warn limit → kick success`);
      } catch (e) {
        logger.warn({ sessionId }, `[checkRaw] warn-kick failed: ${e?.message}`);
      }
    } else {
      try {
        await sock.sendMessage(groupJid, {
          text: `⚠️ *${reason}*\n\n👤 @${senderNum}\n📛 Warning: ${count}/${WARN_LIMIT}\n_(${WARN_LIMIT - count} more warning(s) before removal)_`,
          mentions: [senderJid],
        });
        logger.info({ sessionId, groupJid, senderNum }, `✅ ${reason} | warn ${count}/${WARN_LIMIT} success`);
      } catch (e) {
        logger.warn({ sessionId }, `[checkRaw] warn message failed: ${e?.message}`);
      }
    }

  } else if (action === "kick") {
    try {
      await sock.sendMessage(groupJid, {
        text: `🚫 *${reason}*\n\n👤 @${senderNum} has been removed from the group.`,
        mentions: [senderJid],
      });
      await sock.groupParticipantsUpdate(groupJid, [senderJid], "remove");
      logger.info({ sessionId, groupJid, senderNum }, `✅ ${reason} | kick success`);
    } catch (e) {
      logger.warn({ sessionId }, `[checkRaw] kick failed: ${e?.message}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Main export
// ══════════════════════════════════════════════════════════════════════════════
export const checkRawMessage = async (sock, msg, sessionId) => {
  try {
    const from      = msg.key?.remoteJid || "";
    const sender    = msg.key?.participant || msg.key?.remoteJid || "";
    const type      = Object.keys(msg.message || {})[0];
    const pushName  = msg.pushName || "Unknown";

    // শুধু group message এ কাজ করবে
    if (!from.endsWith("@g.us")) {
      return { id: msg.key?.id, from, sender, type, pushName };
    }

    const senderNum = sender.split("@")[0].split(":")[0];

    // ══════════════════════════════════════════════════════════════════════════
    // 1. ANTIBOT
    // ══════════════════════════════════════════════════════════════════════════
    const antibotMode = db.get(from, "antibot"); // false | "kick" | "warn" | "delete"

    if (antibotMode && antibotMode !== false) {
      const isBot =
        sender.includes(":") ||                          // bot JID pattern: 628xxx:15@s.whatsapp.net
        senderNum.toLowerCase().includes("bot");

      if (isBot) {
        logger.info(
          { sessionId, from, senderNum },
          `🤖 Antibot detected | sender: ${senderNum} | action: ${antibotMode}`
        );
        await executeAction(sock, from, sender, msg.key, antibotMode, "Antibot Detected", sessionId);
        return null;
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 2. ANTIMENTION
    // ══════════════════════════════════════════════════════════════════════════
    const antimentionMode = db.get(from, "antimention"); // false | "kick" | "warn" | "delete"

    if (antimentionMode && antimentionMode !== false) {
      const contextInfo =
        msg.message?.extendedTextMessage?.contextInfo ||
        msg.message?.statusMentionMessage?.contextInfo ||
        msg.message?.groupStatusMentionMessage?.contextInfo ||
        {};

      const mentioned = contextInfo?.mentionedJid || [];
      const limit     = db.get(from, "antimention_limit") || 5;

      if (mentioned.length >= limit) {
        logger.info(
          { sessionId, from, senderNum, count: mentioned.length },
          `📢 Antimention detected | mentions: ${mentioned.length}/${limit} | action: ${antimentionMode}`
        );
        await executeAction(
          sock, from, sender, msg.key,
          antimentionMode,
          `Antimention Detected (${mentioned.length} mentions)`,
          sessionId
        );
        return null;
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 3. ANTIGSTATUS
    // ══════════════════════════════════════════════════════════════════════════
    const antigstatusMode = db.get(from, "antigstatus"); // false | "kick" | "warn" | "delete"

    if (antigstatusMode && antigstatusMode !== false) {
      const contextInfo =
        msg.message?.statusMentionMessage?.contextInfo ||
        msg.message?.groupStatusMentionMessage?.contextInfo ||
        msg.message?.extendedTextMessage?.contextInfo ||
        {};

      const groupMentions = contextInfo?.groupMentions || [];

      if (groupMentions.length > 0) {
        const mentionedGroups = groupMentions
          .map(g => g.groupSubject || g.groupJid || "Unknown")
          .join(", ");

        logger.info(
          { sessionId, from, senderNum },
          `📌 Antigstatus detected | tagged: ${mentionedGroups} | action: ${antigstatusMode}`
        );

        await executeAction(
          sock, from, sender, msg.key,
          antigstatusMode,
          `AntiGStatus Detected (tagged: ${mentionedGroups})`,
          sessionId
        );
        return null;
      }
    }

    // সব ঠিক থাকলে message info return করো
    return { id: msg.key?.id, from, sender, type, pushName };

  } catch (e) {
    logger.error({ sessionId }, "[checkRaw] Error:", e?.message || e);
    return null;
  }
};
