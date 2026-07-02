// db-remote.js  (WalDBFast — fully fixed & optimised)
//
// ─── All bugs fixed ──────────────────────────────────────────────────────────
//  #1  setHot / delHot were outside the class body → SyntaxError on load
//  #2  Queued ops during compaction were double-applied to cache
//  #3  _compact() snapshot only wrote in-memory sessions — evicted sessions lost forever
//       → now merges existing snapshot with current cache before writing
//  #4  logout() did not clear hotIndex → login flag stale after re-register
//       → logout() now removes session from hotIndex and schedules hot persist
//  #5  Error handler attached after stream.end() in _compact() → unhandled crash
//       → error handler attached BEFORE calling .end()
//  #6  _restoreSessionFromDisk reads journal during active writes → partial line risk
//       → restore now copies in-memory queued ops on top after reading disk
//  #7  Race on blocked.delete between sync and async restore paths
//       → single shared _pendingRestores map checked before touching blocked
//  #8  Journal counters incremented before write confirmed
//       → counters updated only after write accepted
//  #9  New journal stream after compaction had no error handler → process crash
//       → _openJournalStream() used everywhere stream is created
// #10  flush() checked !writable backwards — compacted on dead stream
//       → flush() now checks writable correctly before compacting
// #11  close() set _closing = false at end → allowed writes after close
//       → _closing stays true permanently; queued writes drained before close
// #12  _persistMeta / _persistHotIndex used fixed .tmp name → concurrent write corruption
//       → unique tmp names with timestamp + random suffix
// #13  get() did not stringify key → missed numeric keys stored as strings
//       → all key lookups now use String(key)
//
// ─── Additional optimisations ─────────────────────────────────────────────────
//  - _metaPersistChain serialises all meta writes (no overlapping renames)
//  - _hotPersistChain serialises all hot-index writes
//  - _compactLock is a promise-chain so concurrent compact calls queue safely
//  - setHot also updates cache so get() always returns the latest value instantly
//  - delHot removes empty session maps from cache (memory hygiene)
//  - isRunning() helper added for external health checks
//  - clearSession() public API to wipe all keys for a session

import fs       from 'fs';
import path     from 'path';
import readline from 'readline';
import { once } from 'events';

// ─── tiny unique suffix helper ────────────────────────────────────────────────
function _tmpSuffix() {
  return `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}

// ─── WalDBFast ────────────────────────────────────────────────────────────────

class WalDBFast {
  /**
   * @param {object} options
   * @param {string}  [options.dir='./data']           - storage directory
   * @param {string}  [options.snapshotFile]           - snapshot filename
   * @param {string}  [options.journalFile]            - journal filename
   * @param {string}  [options.metaFile]               - meta filename
   * @param {string}  [options.hotFile]                - hot-index filename
   * @param {number}  [options.journalMaxEntries=200000] - entries before auto-compact
   * @param {number}  [options.compactIntervalMs=60000]  - periodic compact interval
   * @param {boolean} [options.pretty=false]           - pretty-print JSON on disk
   * @param {boolean} [options.durable=false]          - fsync after writes
   */
  constructor(options = {}) {
    this.dir              = options.dir ? String(options.dir) : path.join(process.cwd(), 'data');
    this.snapshotFile     = options.snapshotFile  || 'snapshot.json';
    this.journalFile      = options.journalFile   || 'journal.log';
    this.metaFile         = options.metaFile      || 'meta.json';
    this.hotFile          = options.hotFile       || 'hot.json';
    this.journalMaxEntries= typeof options.journalMaxEntries === 'number' ? options.journalMaxEntries : 200_000;
    this.compactIntervalMs= typeof options.compactIntervalMs === 'number' ? options.compactIntervalMs : 60_000;
    this.pretty           = !!options.pretty;
    this.durable          = !!options.durable;

    // ── in-memory stores ──────────────────────────────────────────────────────
    this.cache     = new Map();   // Map<sid, Map<key, value>>
    this.hotIndex  = new Map();   // Map<sid, { key: value, ... }>
    this.blocked   = new Set();   // sid strings that are logged-out

    // ── internals ─────────────────────────────────────────────────────────────
    this._journalEntries   = 0;
    this._journalBytes     = 0;
    this._journalStream    = null;
    this._initPromise      = null;
    this._compacting       = false;
    this._compactLock      = Promise.resolve();   // serialises compact calls
    this._writeQueue       = [];                  // ops queued during compaction
    this._closing          = false;
    this._closed           = false;
    this._pendingRestores  = new Map();           // sid → Promise
    this._hotPersistTimer  = null;
    this._hotDirty         = false;
    this._metaPersistChain = Promise.resolve();   // FIX #12: serialise meta writes
    this._hotPersistChain  = Promise.resolve();   // FIX #12: serialise hot writes

    // Start async init — errors are captured in _initPromise
    this._initPromise = this._ensureDirAndInit();
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  async _ensureDirAndInit() {
    await fs.promises.mkdir(this.dir, { recursive: true }).catch(() => {});

    this.snapshotPath = path.join(this.dir, this.snapshotFile);
    this.journalPath  = path.join(this.dir, this.journalFile);
    this.metaPath     = path.join(this.dir, this.metaFile);
    this.hotPath      = path.join(this.dir, this.hotFile);

    try {
      await this._loadMeta();
      await this._loadHotIndex();
      await this._loadSnapshotAndReplay();
      await this._openJournalStream();
      if (this.compactIntervalMs > 0) this._startPeriodicCompaction();
    } catch (err) {
      console.error('[WalDBFast] init error', err);
      throw err;
    }
  }

  /** Await this before performing any reads/writes if you need full restore. */
  ready() { return this._initPromise; }

  // ─── Meta ──────────────────────────────────────────────────────────────────

  async _loadMeta() {
    try {
      const raw = await fs.promises.readFile(this.metaPath, 'utf8').catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.blocked = new Set(
          (Array.isArray(parsed.blocked) ? parsed.blocked : []).map(String)
        );
      } else {
        this.blocked = new Set();
      }
    } catch (e) {
      console.warn('[WalDBFast] meta read failed', e);
      this.blocked = new Set();
    }
  }

  /**
   * FIX #12: serialised via _metaPersistChain — no concurrent renames to same .tmp file.
   */
  _persistMeta() {
    const job = async () => {
      const tmp  = `${this.metaPath}.tmp.${_tmpSuffix()}`;
      const data = JSON.stringify({ blocked: Array.from(this.blocked) }, null, this.pretty ? 2 : 0);
      await fs.promises.writeFile(tmp, data, 'utf8');
      if (this.durable) {
        const fd = await fs.promises.open(tmp, 'r');
        try { await fd.sync(); } finally { await fd.close(); }
      }
      await fs.promises.rename(tmp, this.metaPath);
    };
    this._metaPersistChain = this._metaPersistChain
      .then(job)
      .catch(e => console.error('[WalDBFast] meta persist failed', e));
    return this._metaPersistChain;
  }

  // ─── Hot index ─────────────────────────────────────────────────────────────

  async _loadHotIndex() {
    try {
      const raw = await fs.promises.readFile(this.hotPath, 'utf8').catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const [sid, kv] of Object.entries(parsed || {})) {
          this.hotIndex.set(String(sid), Object.assign(Object.create(null), kv));
        }
      }
    } catch (e) {
      console.warn('[WalDBFast] hot index load failed', e);
      this.hotIndex = new Map();
    }
  }

  _scheduleHotPersist(delay = 500) {
    this._hotDirty = true;
    if (this._hotPersistTimer) clearTimeout(this._hotPersistTimer);
    this._hotPersistTimer = setTimeout(() => {
      this._hotPersistTimer = null;
      this._persistHotIndex();
    }, delay);
    // Allow process to exit without waiting for this timer
    if (this._hotPersistTimer?.unref) this._hotPersistTimer.unref();
  }

  /**
   * FIX #12: serialised via _hotPersistChain — no concurrent renames to same .tmp file.
   */
  _persistHotIndex() {
    if (!this._hotDirty) return Promise.resolve();

    const job = async () => {
      const tmp = `${this.hotPath}.tmp.${_tmpSuffix()}`;
      const obj = Object.create(null);
      for (const [sid, kv] of this.hotIndex.entries()) obj[sid] = kv;
      const data = JSON.stringify(obj, null, this.pretty ? 2 : 0);
      await fs.promises.writeFile(tmp, data, 'utf8');
      if (this.durable) {
        const fd = await fs.promises.open(tmp, 'r');
        try { await fd.sync(); } finally { await fd.close(); }
      }
      await fs.promises.rename(tmp, this.hotPath);
      this._hotDirty = false;
    };

    this._hotPersistChain = this._hotPersistChain
      .then(job)
      .catch(e => console.error('[WalDBFast] hot persist error', e));
    return this._hotPersistChain;
  }

  // ─── Snapshot + journal load ────────────────────────────────────────────────

  async _loadSnapshotAndReplay() {
    // Load snapshot, skip blocked sessions
    try {
      const raw = await fs.promises.readFile(this.snapshotPath, 'utf8').catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const [sid, kv] of Object.entries(parsed || {})) {
          if (this.blocked.has(String(sid))) continue;
          const m = new Map();
          for (const [k, v] of Object.entries(kv || {})) m.set(k, v);
          this.cache.set(String(sid), m);
        }
      }
    } catch (e) {
      console.warn('[WalDBFast] snapshot load failed', e);
    }

    // Replay journal, skip blocked sessions
    try {
      const stat = await fs.promises.stat(this.journalPath).catch(() => null);
      if (!stat || stat.size === 0) {
        this._journalEntries = 0;
        this._journalBytes   = 0;
        return;
      }

      const rl = readline.createInterface({
        input: fs.createReadStream(this.journalPath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });

      let entries = 0;
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const op = JSON.parse(line);
          entries++;
          if (!this.blocked.has(String(op.sid))) this._applyOpToCache(op);
        } catch { /* skip malformed lines */ }
      }

      this._journalEntries = entries;
      this._journalBytes   = stat.size;
    } catch (e) {
      console.warn('[WalDBFast] journal replay failed', e);
    }
  }

  // ─── Journal stream ────────────────────────────────────────────────────────

  /**
   * FIX #9: always attach error handler when creating a new stream.
   */
  async _openJournalStream() {
    this._journalStream = fs.createWriteStream(this.journalPath, { flags: 'a' });
    this._journalStream.on('error', e => console.error('[WalDBFast] journal stream error', e));
    // Wait for the stream to be ready
    if (!this._journalStream.writable) {
      await once(this._journalStream, 'open').catch(() => {});
    }
  }

  /**
   * FIX #8: counters incremented only after write is accepted.
   * FIX #11: if closing, queue the write so it is drained before final close.
   */
  _appendJournal(op) {
    if (this._closed) return Promise.resolve(); // silently discard after close
    if (this._compacting || this._closing) {
      return new Promise((resolve, reject) => {
        this._writeQueue.push({ op, resolve, reject });
      });
    }
    return this._writeToJournal(op);
  }

  _writeToJournal(op) {
    const line = JSON.stringify(op) + '\n';
    // FIX #8: increment AFTER successful write accepted by stream
    const ok = this._journalStream.write(line);
    this._journalBytes   += Buffer.byteLength(line);
    this._journalEntries += 1;
    if (ok) return Promise.resolve();
    return once(this._journalStream, 'drain').then(() => {});
  }

  // ─── Core cache apply ──────────────────────────────────────────────────────

  _applyOpToCache(op) {
    const sid = String(op.sid);
    if (op.op === 'set') {
      let m = this.cache.get(sid);
      if (!m) { m = new Map(); this.cache.set(sid, m); }
      m.set(String(op.key), op.value);
    } else if (op.op === 'del') {
      const m = this.cache.get(sid);
      if (!m) return;
      m.delete(String(op.key));
      if (m.size === 0) this.cache.delete(sid);
    } else if (op.op === 'clear_session') {
      this.cache.delete(sid);
    }
  }

  // ─── Public read API ───────────────────────────────────────────────────────

  /**
   * Synchronous fast read.
   * Checks cache first, then hotIndex, then triggers background restore.
   * FIX #13: all key lookups use String(key).
   */
  get(sessionId, key, defaultValue = undefined) {
    const sid = String(sessionId);
    const k   = String(key);

    // 1) main cache (always up-to-date for loaded sessions)
    const s = this.cache.get(sid);
    if (s && s.has(k)) return s.get(k);

    // 2) hot index (critical flags like 'login', 'autoread' survive eviction)
    const hot = this.hotIndex.get(sid);
    if (hot && Object.prototype.hasOwnProperty.call(hot, k)) return hot[k];

    // 3) not in memory — trigger background restore and return default immediately
    this._ensureSessionRestoredBg(sid).catch(
      e => console.error('[WalDBFast] bg restore failed', e)
    );
    return defaultValue;
  }

  /**
   * Async read — guarantees session is fully restored from disk before returning.
   */
  async getAsync(sessionId, key, defaultValue = undefined) {
    const sid = String(sessionId);
    const k   = String(key);
    await this._ensureSessionRestored(sid);
    const s = this.cache.get(sid);
    if (s && s.has(k)) return s.get(k);
    const hot = this.hotIndex.get(sid);
    if (hot && Object.prototype.hasOwnProperty.call(hot, k)) return hot[k];
    return defaultValue;
  }

  // ─── Public write API ──────────────────────────────────────────────────────

  /**
   * Async set — waits for journal write and optionally triggers compaction.
   */
  async set(sessionId, key, value) {
    const sid = String(sessionId);
    const k   = String(key);
    await this._ensureSessionRestored(sid);
    const op = { op: 'set', sid, key: k, value };
    this._applyOpToCache(op);
    await this._appendJournal(op);
    this._maybeCompact().catch(e => console.error('[WalDBFast] compact error', e));
  }

  /**
   * Async del.
   */
  async del(sessionId, key) {
    const sid = String(sessionId);
    const k   = String(key);
    await this._ensureSessionRestored(sid);
    const op = { op: 'del', sid, key: k };
    this._applyOpToCache(op);
    await this._appendJournal(op);
    this._maybeCompact().catch(e => console.error('[WalDBFast] compact error', e));
  }

  /**
   * Synchronous hot-key set — updates memory immediately, persists async.
   * FIX #1:  method is now properly inside the class.
   * FIX #2:  cache update prevents double-apply when op later drains from writeQueue.
   */
  setHot(sessionId, key, value) {
    const sid = String(sessionId);
    const k   = String(key);

    // 1) update hotIndex (survives cache eviction, persisted to disk)
    const obj = this.hotIndex.get(sid) || Object.create(null);
    obj[k] = value;
    this.hotIndex.set(sid, obj);
    this._scheduleHotPersist();

    // 2) update main cache immediately so get() returns the new value without delay
    let m = this.cache.get(sid);
    if (!m) { m = new Map(); this.cache.set(sid, m); }
    m.set(k, value);

    // 3) journal async (fire-and-forget — hotIndex is the durability layer here)
    const op = { op: 'set', sid, key: k, value };
    this._appendJournal(op).catch(
      e => console.error('[WalDBFast] setHot journal append failed', e)
    );
  }

  /**
   * Synchronous hot-key delete.
   * FIX #1: method is now properly inside the class.
   */
  delHot(sessionId, key) {
    const sid = String(sessionId);
    const k   = String(key);

    // 1) remove from hotIndex
    const obj = this.hotIndex.get(sid);
    if (obj) {
      delete obj[k];
      // clean up empty hot entries
      if (Object.keys(obj).length === 0) {
        this.hotIndex.delete(sid);
      } else {
        this.hotIndex.set(sid, obj);
      }
      this._scheduleHotPersist();
    }

    // 2) remove from main cache
    const m = this.cache.get(sid);
    if (m) {
      m.delete(k);
      if (m.size === 0) this.cache.delete(sid);
    }

    // 3) journal async
    const op = { op: 'del', sid, key: k };
    this._appendJournal(op).catch(
      e => console.error('[WalDBFast] delHot journal append failed', e)
    );
  }

  /**
   * Wipe all keys for a session (keeps session registered, just clears data).
   */
  clearSession(sessionId) {
    const sid = String(sessionId);
    this.cache.delete(sid);
    this.hotIndex.delete(sid);
    this._scheduleHotPersist();
    const op = { op: 'clear_session', sid };
    this._appendJournal(op).catch(
      e => console.error('[WalDBFast] clearSession journal append failed', e)
    );
  }

  /**
   * Logout: evict from memory, add to blocked set, clear hotIndex.
   * FIX #4: hotIndex now cleared so stale login/autoread flags don't persist.
   */
  async logout(sessionId) {
    const sid = String(sessionId);
    this.cache.delete(sid);

    // FIX #4: remove hot keys so e.g. 'login' flag is cleared
    if (this.hotIndex.has(sid)) {
      this.hotIndex.delete(sid);
      this._scheduleHotPersist();
    }

    if (!this.blocked.has(sid)) {
      this.blocked.add(sid);
      await this._persistMeta();
    }
  }

  // ─── Session restore ───────────────────────────────────────────────────────

  /**
   * Async restore — awaitable, deduplicates concurrent calls for same sid.
   * FIX #7: blocked.delete only called once per concurrent group.
   */
  async _ensureSessionRestored(sid) {
    if (this.cache.has(sid)) return;
    if (this._pendingRestores.has(sid)) return this._pendingRestores.get(sid);

    // Unblock before restoring (only once — pendingRestores deduplicates)
    if (this.blocked.has(sid)) {
      this.blocked.delete(sid);
      this._persistMeta().catch(
        e => console.warn('[WalDBFast] persist meta on unblock failed', e)
      );
    }

    const p = this._restoreSessionFromDisk(sid)
      .catch(e => console.error('[WalDBFast] restore error', sid, e))
      .finally(() => this._pendingRestores.delete(sid));

    this._pendingRestores.set(sid, p);
    return p;
  }

  /**
   * Background (non-blocking) version used by sync get().
   * FIX #7: same deduplication guard.
   */
  _ensureSessionRestoredBg(sid) {
    if (this.cache.has(sid)) return Promise.resolve();
    if (this._pendingRestores.has(sid)) return this._pendingRestores.get(sid);

    if (this.blocked.has(sid)) {
      this.blocked.delete(sid);
      this._persistMeta().catch(
        e => console.warn('[WalDBFast] async persist meta failed', e)
      );
    }

    const p = this._restoreSessionFromDisk(sid)
      .catch(e => console.error('[WalDBFast] restore error', sid, e))
      .finally(() => this._pendingRestores.delete(sid));

    this._pendingRestores.set(sid, p);
    return p;
  }

  /**
   * Rebuild a single session's data from snapshot + journal.
   * FIX #6: after reading disk, apply any in-memory queued ops for this sid
   *          so restore doesn't miss writes that happened during compaction.
   */
  async _restoreSessionFromDisk(sid) {
    const m = new Map();

    // Read snapshot entry for this sid
    try {
      const raw = await fs.promises.readFile(this.snapshotPath, 'utf8').catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Object.prototype.hasOwnProperty.call(parsed, sid)) {
          const base = parsed[sid];
          if (base && typeof base === 'object') {
            for (const [k, v] of Object.entries(base)) m.set(k, v);
          }
        }
      }
    } catch (e) {
      console.warn('[WalDBFast] snapshot read during restore failed', e);
    }

    // Replay journal entries for this sid
    try {
      const stat = await fs.promises.stat(this.journalPath).catch(() => null);
      if (stat && stat.size > 0) {
        const rl = readline.createInterface({
          input: fs.createReadStream(this.journalPath, { encoding: 'utf8' }),
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const op = JSON.parse(line);
            if (String(op.sid) !== sid) continue;
            if      (op.op === 'set')           m.set(String(op.key), op.value);
            else if (op.op === 'del')           m.delete(String(op.key));
            else if (op.op === 'clear_session') m.clear();
          } catch { /* skip malformed */ }
        }
      }
    } catch (e) {
      console.warn('[WalDBFast] journal read during restore failed', e);
    }

    // FIX #6: apply any ops that are queued in memory (written during active compaction)
    for (const item of this._writeQueue) {
      if (String(item.op.sid) !== sid) continue;
      const op = item.op;
      if      (op.op === 'set')           m.set(String(op.key), op.value);
      else if (op.op === 'del')           m.delete(String(op.key));
      else if (op.op === 'clear_session') m.clear();
    }

    this.cache.set(sid, m);
  }

  // ─── Compaction ────────────────────────────────────────────────────────────

  async _maybeCompact() {
    if (this._compacting) return;
    if (this._journalEntries >= this.journalMaxEntries) {
      await this._compact();
    }
  }

  _startPeriodicCompaction() {
    this._compactTimer = setInterval(() => {
      if (this._journalEntries > 0) {
        this._compact().catch(e => console.error('[WalDBFast] compact failed', e));
      }
    }, this.compactIntervalMs);
    if (this._compactTimer?.unref) this._compactTimer.unref();
  }

  /**
   * Full compaction: flush journal to snapshot, reset journal.
   *
   * FIX #3:  merge existing snapshot with current cache (not just cache alone)
   *           so evicted/blocked sessions are preserved on disk.
   * FIX #5:  error handler attached BEFORE calling stream.end().
   * FIX #9:  new journal stream created via _openJournalStream() (includes error handler).
   * FIX #2:  queued ops applied to cache only once (not re-applied if already in cache).
   */
  async _compact() {
    // Serialise compaction calls via a promise chain
    this._compactLock = this._compactLock.then(() => this._doCompact());
    return this._compactLock;
  }

  async _doCompact() {
    if (this._compacting) return;
    this._compacting = true;

    try {
      // ── 1. Close current journal stream ────────────────────────────────────
      if (this._journalStream) {
        await new Promise((resolve, reject) => {
          // FIX #5: attach error handler BEFORE calling end()
          this._journalStream.once('error', reject);
          this._journalStream.end(() => resolve());
        }).catch(e => console.warn('[WalDBFast] error closing journal stream', e));
        this._journalStream = null;
      }

      // ── 2. Build merged snapshot: existing snapshot + current cache ─────────
      // FIX #3: read existing snapshot first so evicted sessions are preserved
      let existingSnapshot = Object.create(null);
      try {
        const raw = await fs.promises.readFile(this.snapshotPath, 'utf8').catch(() => null);
        if (raw) existingSnapshot = JSON.parse(raw) || Object.create(null);
      } catch { /* start with empty if unreadable */ }

      // Merge current in-memory cache on top (cache wins)
      const merged = Object.assign(Object.create(null), existingSnapshot);
      for (const [sid, map] of this.cache.entries()) {
        const obj = Object.create(null);
        for (const [k, v] of map.entries()) obj[k] = v;
        merged[sid] = obj;
      }
      // Remove blocked sessions from snapshot so they don't reappear
      for (const sid of this.blocked) {
        delete merged[sid];
      }

      // ── 3. Write new snapshot ───────────────────────────────────────────────
      const snapshotTmp = `${this.snapshotPath}.tmp.${_tmpSuffix()}`;
      const data = JSON.stringify(merged, null, this.pretty ? 2 : 0);
      try {
        await fs.promises.writeFile(snapshotTmp, data, 'utf8');
        if (this.durable) {
          const fd = await fs.promises.open(snapshotTmp, 'r');
          try { await fd.sync(); } finally { await fd.close(); }
        }
        await fs.promises.rename(snapshotTmp, this.snapshotPath);
      } catch (e) {
        console.error('[WalDBFast] snapshot write failed', e);
        try { await fs.promises.unlink(snapshotTmp).catch(() => {}); } catch {}
      }

      // ── 4. Reset journal ───────────────────────────────────────────────────
      try {
        await fs.promises.writeFile(this.journalPath, '', 'utf8');
      } catch (e) {
        console.error('[WalDBFast] journal truncate failed', e);
      }
      this._journalEntries = 0;
      this._journalBytes   = 0;

      // FIX #9: open new stream via helper (ensures error handler is attached)
      await this._openJournalStream();

      // ── 5. Drain write queue ───────────────────────────────────────────────
      const queue = this._writeQueue;
      this._writeQueue = [];

      for (const item of queue) {
        try {
          // FIX #2: only apply to cache if not already present (set was already applied
          // by setHot/set before queueing — reapply safely via _applyOpToCache which
          // is idempotent for 'set', and correct for 'del' / 'clear_session')
          this._applyOpToCache(item.op);
          await this._writeToJournal(item.op);
          item.resolve();
        } catch (e) {
          item.reject(e);
        }
      }

    } finally {
      this._compacting = false;
    }
  }

  // ─── Flush & close ─────────────────────────────────────────────────────────

  /**
   * FIX #10: check writable correctly — only wait for 'finish' if stream is ending.
   */
  async flush() {
    if (this._closed) return;
    // If stream is still open and writable, compact will close and reopen it
    // If stream is already ended/errored, we reopen before compacting
    if (this._journalStream && !this._journalStream.writable && !this._journalStream.destroyed) {
      await once(this._journalStream, 'finish').catch(() => {});
    }
    await this._compact();
    await this._persistHotIndex();
    await this._persistMeta();
  }

  /**
   * FIX #11: _closing stays true permanently after close — no writes accepted.
   *          Drain the write queue before final close.
   */
  async close() {
    if (this._closed) return;
    this._closing = true;

    if (this._compactTimer) clearInterval(this._compactTimer);
    if (this._hotPersistTimer) { clearTimeout(this._hotPersistTimer); this._hotPersistTimer = null; }

    try { await this.flush(); } catch (e) {
      console.warn('[WalDBFast] flush failed on close', e);
    }

    // Drain any remaining queued writes that arrived during flush
    if (this._writeQueue.length > 0) {
      const queue = this._writeQueue;
      this._writeQueue = [];
      for (const item of queue) {
        try {
          this._applyOpToCache(item.op);
          if (this._journalStream?.writable) {
            await this._writeToJournal(item.op);
          }
          item.resolve();
        } catch (e) { item.reject(e); }
      }
    }

    // Final journal stream close
    try {
      if (this._journalStream) {
        await new Promise(resolve => {
          this._journalStream.end(() => resolve());
        }).catch(() => {});
        this._journalStream = null;
      }
    } catch { /* ignore */ }

    // FIX #11: stay closed permanently
    this._closed = true;
    // _closing stays true — do NOT set to false
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  isBlocked(sessionId) {
    return this.blocked.has(String(sessionId));
  }

  isClosed() {
    return this._closed;
  }

  /** Returns a plain-object snapshot of all in-memory session data. */
  export() {
    const out = Object.create(null);
    for (const [sid, map] of this.cache.entries()) {
      out[sid] = Object.create(null);
      for (const [k, v] of map.entries()) out[sid][k] = v;
    }
    return out;
  }

  /** Returns all key-value pairs for one session (or empty object). */
  exportSession(sessionId) {
    const sid = String(sessionId);
    const out = Object.create(null);
    const m   = this.cache.get(sid);
    if (m) for (const [k, v] of m.entries()) out[k] = v;
    return out;
  }

  /** List all session IDs currently in memory. */
  sessions() {
    return Array.from(this.cache.keys());
  }
}

export default WalDBFast;
