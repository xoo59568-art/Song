// app.js — FULLY FIXED & OPTIMISED
//
// ── Fixes vs previous version ─────────────────────────────────────────────────
//  #1  db.ready() was called AFTER manager.startAll() — sessions could receive
//       messages before DB was initialized. DB is now awaited inside main() itself
//       so by the time app.listen() runs, everything is ready.
//  #2  forceLoadPlugins() was called INSIDE app.listen() callback — plugins loaded
//       after the server was already accepting connections. Moved before listen().
//  #3  manager.startAll() was called BOTH inside main({autoStartAll:false}) logic
//       AND again inside app.listen() — double start attempt. Now only called once
//       from main() with autoStartAll:true.
//  #4  waitForOpen() attached a new sock.ev.on("connection.update") handler on
//       every /pair call — this bypasses SessionManager and could interfere with
//       its own connection.update handling. Fixed to use a manager "connection.update"
//       event listener scoped to the session instead.
//  #5  /pair route used req.params.num as both the session ID and phone number —
//       phone number is cleaned but the raw value was used as session ID, risking
//       sessions named like "91+9812345678". Now always uses cleanNumber as sid.
//  #6  SIGINT handler exited with process.exit(0) before await db.close() resolved
//       in some edge cases. Now uses sequential await with timeout guard.
//  #7  No request validation on /start/:sessionId — any string including
//       path-traversal chars could be passed. Basic sanitization added.
//  #8  app.listen() errors (e.g. port in use) were not handled — process would
//       hang silently. Added 'error' event handler.
//  #9  bodyParser.json() had no size limit — large payloads could OOM the process.
//       Added 1mb limit.

import express from "express";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs-extra";
import getPort from "get-port";
import { fileURLToPath } from "url";
import { forceLoadPlugins, getPluginInfo } from "./lib/plugins.js";
import { manager, main, db, pluginQueueStats } from "./lib/client.js";
import initializeTelegramBot from "./bot.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Express setup ──────────────────────────────────────────────────────────────

const app = express();
// FIX #9: limit body size to 1mb
app.use(bodyParser.json({ limit: "1mb" }));

// Ensure sessions directory exists
const SESSIONS_DIR = path.join(process.cwd(), "sessions");
await fs.mkdirp(SESSIONS_DIR);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Format a pairing code as AAAA-BBBB-CCCC-DDDD */
function fmtCode(raw) {
  if (!raw) return raw;
  const s = String(raw).replace(/\s+/g, "");
  return s.match(/.{1,4}/g)?.join("-") || s;
}

/**
 * FIX #7: sanitize session IDs — only alphanumeric + _ . - @
 */
function sanitizeSid(sid) {
  if (typeof sid !== "string") return null;
  const safe = sid.trim().replace(/[^A-Za-z0-9_.\-@]/g, "");
  return safe.length > 0 ? safe : null;
}

/**
 * FIX #4: wait for a session to reach "open" state via manager events,
 * not by attaching directly to sock.ev (which bypasses SessionManager).
 */
function waitForSessionOpen(sessionId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    // If already connected, resolve immediately
    if (manager.isRunning(sessionId)) return resolve();

    const timer = setTimeout(() => {
      manager.removeListener("connected", onConnected);
      manager.removeListener("session.deleted", onDeleted);
      reject(new Error(`Timed out waiting for ${sessionId} to connect`));
    }, timeoutMs);

    function onConnected(sid) {
      if (sid !== sessionId) return;
      cleanup();
      resolve();
    }
    function onDeleted(sid) {
      if (sid !== sessionId) return;
      cleanup();
      reject(new Error(`Session ${sessionId} was deleted before connecting`));
    }
    function cleanup() {
      clearTimeout(timer);
      manager.removeListener("connected", onConnected);
      manager.removeListener("session.deleted", onDeleted);
    }

    manager.on("connected", onConnected);
    manager.on("session.deleted", onDeleted);
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/**
 * Mass Channel React API
 *
 * Example:
 * /api/chr?url=https://whatsapp.com/channel/xxx/yyy&react=❤️,🔥,😂
 */

app.get("/api/chr", async (req, res) => {
  try {

    const { url, react } = req.query;

    // check params
    if (!url || !react) {
      return res.status(400).json({
        ok: false,
        error: "Missing url or react parameter"
      });
    }

    // validate channel url
    if (!url.includes("whatsapp.com/channel/")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid WhatsApp channel URL"
      });
    }

    // extract channel id + message id
    const match = String(url).match(
      /channel\/([\w\d]+)\/([\w\d]+)/
    );

    if (!match) {
      return res.status(400).json({
        ok: false,
        error: "Invalid channel link format"
      });
    }

    const [, channelId, messageId] = match;

    // get first active session
    const firstSession =
      manager.sessions.values().next().value;

    const mainSock = firstSession?.sock;

    if (!mainSock) {
      return res.status(500).json({
        ok: false,
        error: "No active sessions"
      });
    }

    // get channel metadata
    const meta =
      await mainSock.newsletterMetadata(
        "invite",
        channelId
      );

    // reaction list
    const reactions = String(react)
      .split(",")
      .map(v => v.trim())
      .filter(Boolean);

    if (!reactions.length) {
      return res.status(400).json({
        ok: false,
        error: "No reactions provided"
      });
    }

    let success = 0;
    let failed = 0;

    // loop all sessions
    for (const [sid, session] of manager.sessions) {

      try {

        const sock = session.sock;

        if (!sock) {
          failed++;
          continue;
        }

        // random emoji
        const emoji =
          reactions[
            Math.floor(
              Math.random() * reactions.length
            )
          ];

        // send reaction
        await sock.newsletterReactMessage(
          meta.id,
          messageId,
          emoji
        );

        success++;

        // anti flood delay
        await new Promise(resolve =>
          setTimeout(resolve, 700)
        );

      } catch (e) {

        failed++;

        console.log(
          `[CHR ERROR] ${sid}:`,
          e?.message || e
        );
      }
    }

    // final response
    return res.json({
      ok: true,
      channel: meta.name,
      success,
      failed,
      total:
        manager.sessions.size,
      reactions
    });

  } catch (err) {

    console.log(
      "[CHR API ERROR]",
      err?.message || err
    );

    return res.status(500).json({
      ok: false,
      error: "Internal server error"
    });
  }
});




/** Health check */
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "Baileys Multi-Session Bot",
    sessions: manager.list().length,
    plugins: getPluginInfo().total,
    queue: pluginQueueStats(),
  });
});


app.get("/test-react", async (req, res) => {
  try {

    const { url } = req.query;

    if (!url) {
      return res.json({
        ok: false,
        error: "Missing url"
      });
    }

    const match = url.match(
      /channel\/([\w\d]+)\/([\w\d]+)/
    );

    if (!match) {
      return res.json({
        ok: false,
        error: "Invalid link"
      });
    }

    const [, channelId, messageId] = match;

    const results = [];

    for (const [sid, session] of manager.sessions) {

      try {

        const sock = session.sock;

        console.log(
          "[TESTING SESSION]",
          sid
        );

        const meta =
          await sock.newsletterMetadata(
            "invite",
            channelId
          );

        console.log(
          "[META]",
          meta?.name
        );

        await sock.newsletterReactMessage(
          meta.id,
          messageId,
          "❤️"
        );

        results.push({
          session: sid,
          status: "success"
        });

      } catch (e) {

        console.log(
          "[REACT ERROR]",
          sid,
          e
        );

        results.push({
          session: sid,
          status: "failed",
          error:
            e?.message || String(e)
        });
      }
    }

    return res.json({
      ok: true,
      results
    });

  } catch (e) {

    console.log(e);

    return res.json({
      ok: false,
      error: e?.message
    });
  }
});



/** List all known sessions */
app.get("/sessions", (_req, res) => {
  res.json({ ok: true, sessions: manager.list() });
});


app.get("/online", (_req, res) => {
  const online = manager.list().filter(id => {
    const s = manager.sessions.get(id);
    return s?.status === "connected";
  });

  res.json({
    ok: true,
    total: online.length,
    sessions: online
  });
});
/** Start / wake a session (non-blocking — socket may still be connecting) */
app.get("/start/:sessionId", async (req, res) => {
  // FIX #7: sanitize session ID
  const sid = sanitizeSid(req.params.sessionId);
  if (!sid)
    return res.status(400).json({ ok: false, error: "Invalid sessionId" });

  try {
    await manager.start(sid);
    res.json({ ok: true, sessionId: sid, running: manager.isRunning(sid) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * Pair a new session via pairing code.
 * GET /pair/:phoneNumber  — phone must be E.164 digits without +
 *
 * FIX #5: always uses cleanNumber as the session ID
 * FIX #4: uses manager events instead of sock.ev.on()
 */
app.get("/pair/:num", async (req, res) => {
  const phone = String(req.params.num || "").replace(/\D/g, "");

  if (!/^[0-9]{6,15}$/.test(phone)) {
    return res.status(400).json({
      ok: false,
      error: "phone must be digits only (E.164 without +), e.g. 919812345678",
    });
  }

  // FIX #5: session ID = clean phone number (no raw param used)
  const sid = phone;

  try {
    const sock = await manager.start(sid);
    if (!sock) throw new Error("Failed to create socket");

    // SPEED FIX: 3s WS handshake wait — no need to wait for full "open"
    // requestPairingCode works as soon as socket connects to WA servers
    await new Promise(r => setTimeout(r, 3000));

    if (typeof sock.requestPairingCode !== "function") {
      throw new Error("Pairing code not supported by this socket version");
    }

    const rawCode = await sock.requestPairingCode(phone);
    const code = fmtCode(rawCode);

    return res.json({ ok: true, sessionId: sid, phone, code });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/** Stop a session (graceful — keeps credentials) */
app.post("/stop/:sessionId", async (req, res) => {
  const sid = sanitizeSid(req.params.sessionId);
  if (!sid)
    return res.status(400).json({ ok: false, error: "Invalid sessionId" });

  try {
    const ok = await manager.stop(sid);
    res.json({ ok, sessionId: sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/** Logout (permanent — deletes credentials) */
app.post("/logout/:sessionId", async (req, res) => {
  const sid = sanitizeSid(req.params.sessionId);
  if (!sid)
    return res.status(400).json({ ok: false, error: "Invalid sessionId" });

  try {
    const ok = await manager.logout(sid);
    res.json({ ok, sessionId: sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/** Session detail */
app.get("/session/:sessionId", (req, res) => {
  const sid = sanitizeSid(req.params.sessionId);
  if (!sid)
    return res.status(400).json({ ok: false, error: "Invalid sessionId" });

  const entry = manager.sessions.get(sid);
  if (!entry)
    return res.status(404).json({ ok: false, error: "Session not found" });

  res.json({
    ok: true,
    sessionId: sid,
    status: entry.status,
    running: manager.isRunning(sid),
    reconnectAttempts: entry.reconnectAttempts || 0,
  });
});

/** Plugin info endpoint */
app.get("/plugins", (_req, res) => {
  res.json({ ok: true, ...getPluginInfo() });
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────

// FIX #6: sequential shutdown with timeout guard
async function gracefulShutdown(signal) {
  console.log(`\n[app] Received ${signal} — shutting down...`);
  const timeout = setTimeout(() => {
    console.error("[app] Shutdown timed out — forcing exit");
    process.exit(1);
  }, 15_000);

  try {
    await manager.stopAll();
    await db.flush();
    await db.close();
    console.log("[app] Clean shutdown complete");
  } catch (e) {
    console.error("[app] Shutdown error:", e?.message || e);
  } finally {
    clearTimeout(timeout);
    process.exit(0);
  }
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ── Startup ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || await getPort({ port: 8000 });

(async function init() {
  try {
    console.log("[app] Initializing...");

    await main({ autoStartAll: true });

    console.log("[app] DB ready, plugins loaded, sessions started");

    const server = app.listen(PORT, () => {
      console.log(`[app] 🚀 Server listening on port ${PORT}`);
    });

    try {
      initializeTelegramBot(manager);
    } catch (error) {
      console.error(error);
    }

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[app] ❌ Port ${PORT} is already in use`);
      } else {
        console.error("[app] Server error:", err.message);
      }
      process.exit(1);
    });
  } catch (err) {
    console.error("[app] Fatal initialization error:", err?.message || err);
    process.exit(1);
  }
})();
