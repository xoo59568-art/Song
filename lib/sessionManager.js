import fsPromises from "fs/promises";
import fs from "fs";
import path from "path";
import EventEmitter from "events";
import { DisconnectReason } from "@whiskeysockets/baileys";

// ─── Semaphore ────────────────────────────────────────────────────────────────

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    // FIX: increment only once — either immediately or when dequeued
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (typeof next === "function") {
        try {
          next();
        } catch (e) {
          console.warn("Semaphore release error:", e?.message || e);
        }
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeSessionFsId(sessionId) {
  if (typeof sessionId !== "string")
    throw new Error("sessionId must be a string");
  const trimmed = sessionId.trim();
  if (!trimmed) throw new Error("sessionId must be non-empty");
  const safe = trimmed.replace(/[^A-Za-z0-9_.\-@]/g, "");
  if (!safe) throw new Error("invalid sessionId (after sanitization)");
  return safe;
}

async function removeDir(p) {
  if (!p) return;
  try {
    if (fsPromises.rm) {
      await fsPromises.rm(p, { recursive: true, force: true });
    } else {
      await fsPromises.rmdir(p, { recursive: true });
    }
  } catch {
    /* ignore */
  }
}

const WS_OPEN = 1; // WebSocket.OPEN constant

function isSocketAlive(sock) {
  if (!sock) return false;
  const ws = sock.ws;
  if (!ws) return false;
  return ws.readyState === WS_OPEN;
}

// ─── SessionManager ───────────────────────────────────────────────────────────

export default class SessionManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {function} opts.createSocket          - async (fsId, { onQR }) => WASocket  [required]
   * @param {string}  [opts.sessionsDir]          - directory for auth folders
   * @param {string}  [opts.metaFile]             - path to sessions.json
   * @param {number}  [opts.concurrency=10]       - max parallel socket starts
   * @param {number}  [opts.startDelayMs=200]     - delay between starts
   * @param {number}  [opts.reconnectLimit=10]    - max reconnect attempts before permanent logout
   * @param {number}  [opts.defaultBackoff=1000]  - initial reconnect delay ms
   * @param {number}  [opts.maxBackoff=60000]     - max reconnect delay ms
   * @param {number}  [opts.stableConnectionTime=30000] - ms stable before resetting attempt counter
   * @param {object}  [opts.db]                   - optional db with .logout(sessionId)
   * @param {boolean} [opts.attachShutdown=true]  - attach SIGINT/SIGTERM handlers
   */
  constructor(opts = {}) {
    super();

    if (!opts.createSocket || typeof opts.createSocket !== "function") {
      throw new Error("createSocket option is required and must be a function");
    }

    this.createSocket = opts.createSocket;
    this.db = opts.db ?? null;
    this.sessions = new Map();
    this.sessionsDir = path.resolve(
      opts.sessionsDir || path.join(process.cwd(), "sessions")
    );
    this.metaFile = path.resolve(
      opts.metaFile || path.join(process.cwd(), "sessions.json")
    );
    this.concurrency =
      typeof opts.concurrency === "number" ? opts.concurrency : 10;
    this.startDelayMs =
      typeof opts.startDelayMs === "number" ? opts.startDelayMs : 200;
    this.defaultBackoff =
      typeof opts.defaultBackoff === "number" ? opts.defaultBackoff : 1000;
    this.maxBackoff =
      typeof opts.maxBackoff === "number" ? opts.maxBackoff : 60_000;
    this.reconnectLimit =
      typeof opts.reconnectLimit === "number" ? opts.reconnectLimit : 10;
    this.stableConnectionTime =
      typeof opts.stableConnectionTime === "number"
        ? opts.stableConnectionTime
        : 30_000;
    this.attachShutdown = opts.attachShutdown !== false;

    this.semaphore = new Semaphore(this.concurrency);
    this._persistChain = Promise.resolve();
    this._shuttingDown = false;

    // Unlimited listeners — we may have many sessions
    try {
      this.setMaxListeners(0);
    } catch {
      /* ignore */
    }

    // Load persisted session list
    try {
      this._loadMetaSync();
      this.ready = Promise.resolve();
    } catch (e) {
      console.warn(
        "SessionManager: sync meta load failed, falling back to async:",
        e?.message || e
      );
      this.ready = this._loadMeta().catch((err) => {
        console.warn(
          "SessionManager: async meta load failed:",
          err?.message || err
        );
      });
    }

    // Attach shutdown handlers once per process
    if (this.attachShutdown && !process._sessionManagerShutdownAttached) {
      this._setupShutdownHandlers();
      process._sessionManagerShutdownAttached = true;
    }
  }

  // ─── Entry factory ──────────────────────────────────────────────────────────

  _createSessionEntry() {
    return {
      sock: null,
      fsId: null,
      backoffMs: this.defaultBackoff,
      restarting: false,
      status: "stopped",
      reconnectTimer: null,
      stableConnectionTimer: null,
      deleted: false,
      reconnectAttempts: 0,
      _handlers: null,
      connectionOpenedAt: null,
    };
  }

  // ─── Shutdown ───────────────────────────────────────────────────────────────

  _setupShutdownHandlers() {
    const shutdown = async (signal) => {
      if (this._shuttingDown) return;
      this._shuttingDown = true;
      console.log(
        `SessionManager: received ${signal}, shutting down gracefully...`
      );
      try {
        await this.stopAll();
        await this._persistMeta();
      } catch (e) {
        console.error("SessionManager: shutdown error:", e?.message || e);
      }
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  }

  // ─── Meta persistence ───────────────────────────────────────────────────────

  _loadMetaSync() {
    try {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    } catch (e) {
      if (e?.code !== "EEXIST")
        console.warn("SessionManager: mkdir sync failed:", e?.message || e);
    }

    let raw;
    try {
      raw = fs.readFileSync(this.metaFile, "utf-8");
    } catch (e) {
      if (e?.code === "ENOENT") {
        raw = "[]";
      } else {
        throw e;
      }
    }

    let list;
    try {
      list = JSON.parse(raw || "[]");
    } catch {
      console.warn("SessionManager: invalid meta JSON, using empty array");
      list = [];
    }
    if (!Array.isArray(list)) list = [];

    for (const id of list) {
      if (typeof id === "string" && id.trim() && !this.sessions.has(id)) {
        this.sessions.set(id, this._createSessionEntry());
      }
    }

    // Best-effort sync persist (normalise)
    try {
      this._persistMetaSync();
    } catch {
      this._persistMeta().catch(() => {});
    }
  }

  async _loadMeta() {
    try {
      await fsPromises.mkdir(this.sessionsDir, { recursive: true });
      const raw = await fsPromises
        .readFile(this.metaFile, "utf-8")
        .catch((e) => {
          if (e?.code === "ENOENT") return "[]";
          throw e;
        });

      let list;
      try {
        list = JSON.parse(raw || "[]");
      } catch {
        console.warn(
          "SessionManager: invalid meta JSON (async), using empty array"
        );
        list = [];
      }
      if (!Array.isArray(list)) list = [];

      for (const id of list) {
        if (typeof id === "string" && id.trim() && !this.sessions.has(id)) {
          this.sessions.set(id, this._createSessionEntry());
        }
      }
      await this._persistMeta().catch(() => {});
    } catch (e) {
      if (e?.code !== "ENOENT")
        console.warn("SessionManager: meta load error:", e?.message || e);
    }
  }

  /**
   * Serialised async persist — writes never overlap, errors are logged not swallowed.
   */
  _persistMeta() {
    const job = async () => {
      const dir = path.dirname(this.metaFile);
      const list = Array.from(this.sessions.keys());
      const tmp = `${this.metaFile}.tmp.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(tmp, JSON.stringify(list, null, 2), "utf-8");

      let renamed = false;
      for (let attempt = 0; attempt < 4 && !renamed; attempt++) {
        try {
          await fsPromises.rename(tmp, this.metaFile);
          renamed = true;
        } catch (err) {
          if (attempt === 3) {
            // Last resort: direct write
            await fsPromises.writeFile(
              this.metaFile,
              JSON.stringify(list, null, 2),
              "utf-8"
            );
            renamed = true;
          } else {
            if (err?.code === "ENOENT") {
              try {
                await fsPromises.writeFile(
                  tmp,
                  JSON.stringify(list, null, 2),
                  "utf-8"
                );
              } catch {
                /* ignore */
              }
            }
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          }
        }
      }

      // Cleanup tmp if leftover
      try {
        await fsPromises.unlink(tmp).catch(() => {});
      } catch {
        /* ignore */
      }

      // Best-effort dir fsync
      try {
        const fd = await fsPromises.open(dir, "r");
        try {
          if (typeof fd.sync === "function") await fd.sync();
        } finally {
          await fd.close();
        }
      } catch {
        /* ignore */
      }

      this.emit("meta.updated", list);
    };

    // FIX: chain with explicit error logging — never pass job as rejection handler
    this._persistChain = this._persistChain.then(job).catch((e) => {
      console.error("SessionManager: meta persist failed:", e?.message || e);
    });

    return this._persistChain;
  }

  _persistMetaSync() {
    const dir = path.dirname(this.metaFile);
    const list = Array.from(this.sessions.keys());
    const tmp = `${this.metaFile}.tmp.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }

    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf-8");

    let renamed = false;
    for (let attempt = 0; attempt < 4 && !renamed; attempt++) {
      try {
        if (!fs.existsSync(tmp))
          fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf-8");
        fs.renameSync(tmp, this.metaFile);
        renamed = true;
      } catch (err) {
        if (attempt === 3) {
          fs.writeFileSync(
            this.metaFile,
            JSON.stringify(list, null, 2),
            "utf-8"
          );
          renamed = true;
        }
      }
    }

    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }

    // Best-effort dir fsync
    try {
      const fd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* ignore */
    }

    this.emit("meta.updated", list);
  }

  // ─── Session lifecycle ──────────────────────────────────────────────────────

  /**
   * Register a session ID in memory without starting it.
   * FIX: uses async persist (was blocking sync on every register call inside start())
   */
  register(sessionId) {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("sessionId must be a non-empty string");
    }
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, this._createSessionEntry());
    } else {
      const entry = this.sessions.get(sessionId);
      if (entry.deleted) entry.deleted = false;
      if (typeof entry.reconnectAttempts !== "number")
        entry.reconnectAttempts = 0;
    }
    // FIX: async persist instead of blocking sync — removes event-loop stall on every start()
    this._persistMeta().catch(() => {});
  }

  unregister(sessionId) {
    if (!this.sessions.has(sessionId)) return false;
    const entry = this.sessions.get(sessionId);
    this._clearReconnectTimer(entry);
    this._clearStableConnectionTimer(entry);
    try {
      if (entry.sock) this._removeSocketHandlers(entry.sock);
    } catch {
      /* ignore */
    }
    this.sessions.delete(sessionId);
    this._persistMeta().catch(() => {});
    return true;
  }

  // ─── Timer helpers ──────────────────────────────────────────────────────────

  _clearReconnectTimer(entry) {
    if (!entry?.reconnectTimer) return;
    try {
      clearTimeout(entry.reconnectTimer);
    } catch {
      /* ignore */
    }
    entry.reconnectTimer = null;
  }

  _clearStableConnectionTimer(entry) {
    if (!entry?.stableConnectionTimer) return;
    try {
      clearTimeout(entry.stableConnectionTimer);
    } catch {
      /* ignore */
    }
    entry.stableConnectionTimer = null;
  }

  // ─── Socket cleanup ─────────────────────────────────────────────────────────

  _cleanupSocket(entry) {
    if (!entry?.sock) return;
    try {
      const ev = entry.sock.ev;
      if (ev) {
        if (entry._handlers && typeof ev.removeListener === "function") {
          for (const [event, fn] of Object.entries(entry._handlers)) {
            try {
              ev.removeListener(event, fn);
            } catch {
              /* ignore */
            }
          }
        }
        if (typeof ev.removeAllListeners === "function") {
          try {
            ev.removeAllListeners();
          } catch {
            /* ignore */
          }
        }
      }
      // FIX: prefer terminate() over close() — immediate, no lingering FIN handshake
      const ws = entry.sock.ws;
      if (ws) {
        try {
          if (typeof ws.terminate === "function") ws.terminate();
          else if (typeof ws.close === "function") ws.close();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    entry._handlers = null;
    entry.sock = null;
  }

  _removeSocketHandlers(sock) {
    if (!sock?.ev) return;
    try {
      const handlers = sock._smHandlers;
      if (handlers && typeof handlers === "object") {
        for (const [ev, fn] of Object.entries(handlers)) {
          try {
            if (typeof sock.ev.removeListener === "function")
              sock.ev.removeListener(ev, fn);
          } catch {
            /* ignore */
          }
        }
      } else {
        if (typeof sock.ev.removeAllListeners === "function") {
          try {
            sock.ev.removeAllListeners();
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      try {
        if (sock.ev && typeof sock.ev.removeAllListeners === "function")
          sock.ev.removeAllListeners();
      } catch {
        /* ignore */
      }
    } finally {
      try {
        delete sock._smHandlers;
      } catch {
        /* ignore */
      }
    }
  }

  // ─── start() ────────────────────────────────────────────────────────────────

  async start(sessionId) {
    if (this._shuttingDown) throw new Error("SessionManager is shutting down");
    if (this.ready) await this.ready;

    this.register(sessionId);
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error("Failed to register session");
    if (entry.deleted)
      throw new Error("Session marked deleted; will not start");

    // FIX: guard against duplicate starts, but also detect dead-socket "connected" state
    if (entry.status === "starting" || entry.restarting) {
      return entry.sock;
    }
    if (entry.status === "connected") {
      if (isSocketAlive(entry.sock)) {
        return entry.sock; // genuinely connected and alive — skip
      }
      // Socket is dead despite status — fall through and restart
      console.warn(
        `[${sessionId}] status=connected but socket is dead (readyState=${entry.sock?.ws?.readyState}), restarting...`
      );
      this._cleanupSocket(entry);
      entry.status = "stopped";
      this.sessions.set(sessionId, entry);
    }

    await this.semaphore.acquire();

    try {
      entry.status = "starting";
      this.sessions.set(sessionId, entry);

      // Determine filesystem-safe ID
      let safeFsId;
      try {
        safeFsId = sanitizeSessionFsId(sessionId);
      } catch {
        safeFsId = `sess-${Buffer.from(sessionId)
          .toString("hex")
          .slice(0, 12)}`;
      }
      entry.fsId = safeFsId;

      // Create socket — pass onQR callback so QR is surfaced as manager event
      let sock;
      try {
        sock = await this.createSocket(safeFsId, {
          onQR: (qr) => this.emit("qr", sessionId, qr),
        });
      } catch (err) {
        console.error(
          `[${sessionId}] createSocket failed:`,
          err?.message || err
        );
        entry.status = "stopped";
        entry.restarting = false;
        this._cleanupSocket(entry);
        this.sessions.set(sessionId, entry);
        throw err;
      }

      if (!sock) throw new Error("createSocket returned null/undefined");

      // Remove handlers from previous socket (if any) to avoid leaks
      if (entry.sock && entry.sock !== sock) {
        try {
          this._removeSocketHandlers(entry.sock);
        } catch {
          /* ignore */
        }
        try {
          const ws = entry.sock.ws;
          if (ws) {
            if (typeof ws.terminate === "function") ws.terminate();
            else if (typeof ws.close === "function") ws.close();
          }
        } catch {
          /* ignore */
        }
      }

      // Assign new socket
      entry.sock = sock;
      entry.status = "connected";
      entry.restarting = false;
      entry.backoffMs = this.defaultBackoff;
      // NOTE: reconnectAttempts intentionally NOT reset here — reset after stableConnectionTime
      this._clearReconnectTimer(entry);

      if (sock?.ev && typeof sock.ev.on === "function") {
        this._attachSocketListeners(sessionId, sock);
      } else {
        console.warn(`[${sessionId}] socket missing event emitter`);
      }

      this._persistMeta().catch(() => {});
      this.sessions.set(sessionId, entry);

      return sock;
    } finally {
      if (this.startDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.startDelayMs));
      }
      this.semaphore.release();
    }
  }

  // ─── _attachSocketListeners() ───────────────────────────────────────────────

  _attachSocketListeners(sessionId, sock) {
    const entry = this.sessions.get(sessionId);
    if (!entry || !sock?.ev) return;

    const handlers = {};

    const wrap = (evName, handler) => {
      try {
        const wrapped = (...args) => {
          Promise.resolve()
            .then(() => handler(...args))
            .catch((e) => {
              console.error(
                `[${sessionId}] event handler '${evName}' error:`,
                e?.message || e
              );
            });
        };
        handlers[evName] = wrapped;
        sock.ev.on(evName, wrapped);
      } catch (e) {
        console.warn(
          `[${sessionId}] failed to attach handler '${evName}':`,
          e?.message || e
        );
      }
    };

    // Forward all standard events to manager consumers
    wrap("messages.upsert", (m) => this.emit("messages.upsert", sessionId, m));
    wrap("groups.update", (u) => this.emit("groups.update", sessionId, u));
    wrap("group-participants.update", (u) =>
      this.emit("group-participants.update", sessionId, u)
    );
    wrap("creds.update", (u) => this.emit("creds.update", sessionId, u));
    // FIX #2: call event was missing — now forwarded
    wrap("call", (c) => this.emit("call", sessionId, c));

    // connection.update: pass sock reference so stale-socket events are ignored
    const connWrapped = (update) => {
      try {
        this._handleConnectionUpdate(sessionId, update, sock);
      } catch (e) {
        console.error(
          `[${sessionId}] connection.update handler error:`,
          e?.message || e
        );
      }
    };
    handlers["connection.update"] = connWrapped;
    try {
      sock.ev.on("connection.update", connWrapped);
    } catch (e) {
      console.warn(
        `[${sessionId}] failed to attach connection.update:`,
        e?.message || e
      );
    }

    // Store handler refs for precise removal later
    try {
      sock._smHandlers = handlers;
    } catch {
      /* ignore */
    }
    entry._handlers = handlers;
    this.sessions.set(sessionId, entry);
  }

  // ─── Connection event handling ──────────────────────────────────────────────

  async _handleConnectionUpdate(sessionId, update, sock = null) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    // Ignore events from stale socket instances
    if (sock && entry.sock && entry.sock !== sock) {
      console.debug(
        `[${sessionId}] Ignoring connection.update from stale socket`
      );
      return;
    }

    const { connection, lastDisconnect, qr } = update;
    this.emit("connection.update", sessionId, update);

    // Surface QR through manager (belt-and-suspenders in case createSocket's handler missed it)
    if (qr) this.emit("qr", sessionId, qr);

    if (connection === "open") {
      entry.status = "connected";
      entry.backoffMs = this.defaultBackoff;
      entry.restarting = false;
      entry.connectionOpenedAt = Date.now();

      this._clearReconnectTimer(entry);
      this._clearStableConnectionTimer(entry);

      // Reset reconnect counter only after connection is stable for stableConnectionTime ms
      entry.stableConnectionTimer = setTimeout(() => {
        const cur = this.sessions.get(sessionId);
        if (cur && cur.status === "connected") {
          console.log(
            `[${sessionId}] ✅ Connection stable for ${this.stableConnectionTime}ms, resetting reconnect counter (was ${cur.reconnectAttempts})`
          );
          cur.reconnectAttempts = 0;
          this.sessions.set(sessionId, cur);
        }
      }, this.stableConnectionTime);

      this.sessions.set(sessionId, entry);
      await this._persistMeta().catch(() => {});
      this.emit("connected", sessionId);
      return;
    }

    if (connection === "close") {
      this._clearStableConnectionTimer(entry);

      const isLoggedOut = this._isPermanentDisconnect(lastDisconnect);
      const statusCode =
        lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.statusCode;
      const reason =
        lastDisconnect?.error?.output?.payload?.reason ??
        lastDisconnect?.reason ??
        lastDisconnect?.message;

      console.log(
        `[${sessionId}] connection.close: statusCode=${statusCode}, reason=${reason}, permanent=${isLoggedOut}`
      );

      if (isLoggedOut) {
        await this._handlePermanentLogout(sessionId, entry, lastDisconnect);
        return;
      }

      // FIX: increment BEFORE checking limit
      entry.reconnectAttempts = (entry.reconnectAttempts || 0) + 1;
      console.log(
        `[${sessionId}] 🔄 Reconnect attempt ${entry.reconnectAttempts}/${this.reconnectLimit}`
      );

      if (entry.reconnectAttempts >= this.reconnectLimit) {
        console.warn(
          `[${sessionId}] ❌ Reconnect limit reached (${this.reconnectLimit})`
        );
        await this._handlePermanentLogout(sessionId, entry, {
          reason: "reconnect-limit-exceeded",
        });
        return;
      }

      this.sessions.set(sessionId, entry);
      await this._scheduleReconnect(sessionId, entry);
    }
  }

  async _handlePermanentLogout(sessionId, entry, lastDisconnect) {
    this._clearReconnectTimer(entry);
    this._clearStableConnectionTimer(entry);

    try {
      if (entry.sock) this._removeSocketHandlers(entry.sock);
    } catch {
      /* ignore */
    }
    this._cleanupSocket(entry);
    entry.restarting = false;

    const fsId =
      entry.fsId ||
      (() => {
        try {
          return sanitizeSessionFsId(sessionId);
        } catch {
          return null;
        }
      })();

    if (fsId) {
      const sessionPath = path.join(this.sessionsDir, fsId);
      try {
        await removeDir(sessionPath);
      } catch (e) {
        console.warn(
          `[${sessionId}] failed to remove auth directory:`,
          e?.message || e
        );
      }
    }

    if (this.db && typeof this.db.logout === "function") {
      try {
        await this.db.logout(sessionId);
      } catch (e) {
        console.warn(`[${sessionId}] db.logout failed:`, e?.message || e);
      }
    }

    this.sessions.delete(sessionId);
    await this._persistMeta().catch(() => {});

    const reason =
      lastDisconnect?.error?.output?.payload?.reason ??
      lastDisconnect?.error?.output?.statusCode ??
      lastDisconnect?.reason ??
      lastDisconnect?.message ??
      "unknown";

    this.emit("session.deleted", sessionId, { reason });
    this.emit("loggedOut", sessionId);
  }

  async _scheduleReconnect(sessionId, entry) {
    if (!entry || entry.restarting) return;

    entry.restarting = true;
    this._cleanupSocket(entry);
    entry.status = "reconnecting";

    const backoff = Math.min(
      entry.backoffMs || this.defaultBackoff,
      this.maxBackoff
    );
    console.log(
      `[${sessionId}] scheduling reconnect in ${backoff}ms (attempt ${entry.reconnectAttempts}/${this.reconnectLimit})`
    );

    const attemptReconnect = async () => {
      if (!this.sessions.has(sessionId)) return;
      const cur = this.sessions.get(sessionId);
      if (!cur || cur.status === "connected" || cur.deleted) return;

      cur.restarting = false;
      this.sessions.set(sessionId, cur);

      try {
        await this.start(sessionId);
        // Success — stable timer will reset reconnectAttempts after stableConnectionTime
      } catch (err) {
        console.error(
          `[${sessionId}] reconnect start() failed:`,
          err?.message || err
        );

        const cur2 = this.sessions.get(sessionId);
        if (!cur2) return;

        this._cleanupSocket(cur2);

        // FIX: increment here too for synchronous start() failures
        cur2.reconnectAttempts = (cur2.reconnectAttempts || 0) + 1;

        if (cur2.reconnectAttempts >= this.reconnectLimit) {
          console.warn(
            `[${sessionId}] ❌ Reconnect limit exceeded (${this.reconnectLimit})`
          );
          await this._handlePermanentLogout(sessionId, cur2, {
            reason: "reconnect-limit-exceeded",
          });
          return;
        }

        // Exponential backoff
        cur2.backoffMs = Math.min(
          (cur2.backoffMs || this.defaultBackoff) * 2,
          this.maxBackoff
        );
        cur2.restarting = true;
        this.sessions.set(sessionId, cur2);
        cur2.reconnectTimer = setTimeout(attemptReconnect, cur2.backoffMs);
      }
    };

    entry.reconnectTimer = setTimeout(attemptReconnect, backoff);
    this.sessions.set(sessionId, entry);
  }

  // ─── Permanent disconnect detection ─────────────────────────────────────────

  _isPermanentDisconnect(lastDisconnect) {
    if (!lastDisconnect) return false;

    const statusCode =
      lastDisconnect?.error?.output?.statusCode ??
      lastDisconnect?.statusCode ??
      lastDisconnect?.error?.statusCode ??
      null;

    const payloadReason =
      lastDisconnect?.error?.output?.payload?.reason ??
      lastDisconnect?.error?.output?.payload?.message ??
      lastDisconnect?.error?.output?.payload?.status ??
      lastDisconnect?.reason ??
      lastDisconnect?.error?.message ??
      lastDisconnect?.message ??
      "";

    const reasonStr = String(statusCode ?? payloadReason).toLowerCase();

    const dr = DisconnectReason || {};
    const knownCodes = new Set(
      [
        String(dr.loggedOut),
        String(dr.forbidden),
        String(dr.badSession),
      ].filter(Boolean)
    );
    const knownStrings = new Set([
      "loggedout",
      "logged out",
      "forbidden",
      "invalid session",
      "bad session",
      "invalid credentials",
      "not authorized",
      "unauthorized",
      "session revoked",
      "authentication failed",
    ]);

    if (typeof statusCode === "number") {
      if (statusCode === 401 || statusCode === 403) return true;
      if (knownCodes.has(String(statusCode))) return true;
    }
    if (knownCodes.has(reasonStr)) return true;
    if (knownStrings.has(reasonStr)) return true;

    for (const k of knownStrings) {
      if (reasonStr.includes(k)) return true;
    }

    return false;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async startAll() {
    if (this.ready) await this.ready;
    // FIX: let semaphore control concurrency — no manual chunking needed
    const keys = Array.from(this.sessions.keys());
    await Promise.all(
      keys.map((sid) =>
        this.start(sid).catch((e) => {
          console.error(`startAll: error starting ${sid}:`, e?.message || e);
        })
      )
    );
  }

  async stop(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    this._clearReconnectTimer(entry);
    this._clearStableConnectionTimer(entry);

    try {
      entry.status = "stopping";
      if (entry.sock) {
        try {
          this._removeSocketHandlers(entry.sock);
        } catch {
          try {
            entry.sock.ev?.removeAllListeners?.();
          } catch {
            /* ignore */
          }
        }
        try {
          const ws = entry.sock.ws;
          if (ws) {
            if (typeof ws.terminate === "function") ws.terminate();
            else if (typeof ws.close === "function") ws.close();
          }
        } catch (e) {
          console.warn(`[${sessionId}] stop ws error:`, e?.message || e);
        }
      }
    } finally {
      this._cleanupSocket(entry);
      entry.sock = null;
      entry.status = "stopped";
      entry._handlers = null;
      this.sessions.set(sessionId, entry);
    }

    return true;
  }

  async stopAll() {
    const keys = Array.from(this.sessions.keys());
    await Promise.all(keys.map((sid) => this.stop(sid).catch(() => {})));
  }

  async logout(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    try {
      if (entry.sock) {
        try {
          this._removeSocketHandlers(entry.sock);
        } catch {
          /* ignore */
        }
        try {
          if (typeof entry.sock.logout === "function")
            await entry.sock.logout();
          else {
            const ws = entry.sock.ws;
            if (ws) {
              if (typeof ws.terminate === "function") ws.terminate();
              else if (typeof ws.close === "function") ws.close();
            }
          }
        } catch (e) {
          console.warn(`[${sessionId}] logout socket error:`, e?.message || e);
        }
      }
    } finally {
      this._clearReconnectTimer(entry);
      this._clearStableConnectionTimer(entry);

      const fsId =
        entry.fsId ||
        (() => {
          try {
            return sanitizeSessionFsId(sessionId);
          } catch {
            return null;
          }
        })();

      if (fsId) {
        const sessionPath = path.join(this.sessionsDir, fsId);
        try {
          await removeDir(sessionPath);
        } catch (e) {
          console.warn(
            `[${sessionId}] failed to remove auth directory:`,
            e?.message || e
          );
        }
      }

      entry.deleted = true;
      entry.restarting = false;
      entry._handlers = null;
      this._cleanupSocket(entry);
      this.sessions.delete(sessionId);

      await this._persistMeta().catch(() => {});

      if (this.db && typeof this.db.logout === "function") {
        try {
          await this.db.logout(sessionId);
        } catch (e) {
          console.warn(`[${sessionId}] db.logout failed:`, e?.message || e);
        }
      }

      this.emit("loggedOut", sessionId);
      this.emit("session.deleted", sessionId, {
        reason: "client-initiated-logout",
      });
    }

    return true;
  }

  // ─── Inspection helpers ──────────────────────────────────────────────────────

  isRunning(sessionId) {
    const entry = this.sessions.get(sessionId);
    return !!(
      entry &&
      entry.sock &&
      entry.status === "connected" &&
      isSocketAlive(entry.sock)
    );
  }

  list() {
    const out = [];
    for (const [k, v] of this.sessions.entries()) {
      out.push({
        sessionId: k,
        status: v.status,
        backoffMs: v.backoffMs,
        reconnectAttempts: v.reconnectAttempts || 0,
        deleted: !!v.deleted,
        alive: isSocketAlive(v.sock),
      });
    }
    return out;
  }

  getAllConnections() {
    const out = [];
    for (const [sid, entry] of this.sessions.entries()) {
      out.push({
        sessionId: sid, // FIX: was misleadingly named "file_path"
        connection: entry.sock || null,
        healthy: !!(
          entry.sock &&
          entry.status === "connected" &&
          isSocketAlive(entry.sock)
        ),
        status: entry.status,
        alive: isSocketAlive(entry.sock),
      });
    }
    return out;
  }
}
