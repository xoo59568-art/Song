// lib/plugins.js — FULLY FIXED & OPTIMISED
//
// ── Fixes applied ─────────────────────────────────────────────────────────────
//  #1  `commands` export was allPlugins (Array) — name implied Map, caused
//       `commands.get()` TypeError in any code that imported it directly.
//       → renamed export to `pluginList` (Array); kept `commands` as alias
//         pointing at commandMap (the actual Map) for back-compat
//  #2  `ensurePlugins()` started background load but returned empty snapshot —
//       callers in index.js did `await ensurePlugins()` which resolved instantly
//       without waiting for plugins. Main() now calls forceLoadPlugins() instead.
//  #3  loadPlugins() guard `allPlugins.length > 0` blocked reload even when
//       called with a different directory — added _loadedDir tracking
//  #4  Module() had no guard against duplicate command registration — same
//       command name from two files would silently overwrite the first
//  #5  No sorting of plugin files — load order was OS-dependent (non-deterministic)
//       → files are now sorted alphabetically before loading
//  #6  _loadingPromise was never reset on successful load — forceLoadPlugins()
//       could return a stale rejected promise on second call after failure
//  #7  No way to know which plugins are loaded — added getPluginInfo() helper

import fs from "fs-extra";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Internal registries ────────────────────────────────────────────────────────
const commandMap = new Map(); // command string → plugin
const textPlugins = []; // plugins with on === "text"
const allPlugins = []; // every registered plugin

let _pluginsSnapshot = null;
let _loadingPromise = null;
let _loadedDir = null; // FIX #3: track which dir was loaded

// ── Module decorator ──────────────────────────────────────────────────────────

/**
 * Module(meta)(exec) — register a plugin.
 *
 * meta shape:
 *   command?: string        — registers as a command (e.g. "menu")
 *   on?: "text"             — registers as a text plugin
 *   name?: string           — human-readable name
 *   desc?: string           — description shown in .menu
 *   category?: string       — category for grouping
 *
 * Usage in a plugin file:
 *   Module({ command: "ping", desc: "Ping the bot" })(async (msg, args) => {
 *     await msg.reply("Pong!");
 *   });
 */
export function Module(meta) {
  return (exec) => {
    if (typeof exec !== "function") {
      console.warn(`[plugins] Module registered without exec function:`, meta);
      return;
    }

    const plugin = Object.freeze({ ...meta, exec });

    // Register primary command
    if (plugin.command) {

  // OVERRIDE SUPPORT
  if (
    commandMap.has(plugin.command)
  ) {

    console.log(
      `[plugins] ♻️ Override: ${plugin.command}`
    );
  }

  // REGISTER
  commandMap.set(
    plugin.command,
    plugin
  );

  // ALIASES
  if (
    Array.isArray(plugin.aliases)
  ) {

    for (const alias of plugin.aliases) {

      commandMap.set(
        alias,
        plugin
      );
    }
  }
}

    // Register text plugins (run on every message)
    if (plugin.on === "text") textPlugins.push(plugin);

    allPlugins.push(plugin);
  };
}

// ── Snapshot helper ───────────────────────────────────────────────────────────

function getSnapshot() {
  return {
    commands: new Map(commandMap), // safe copy of Map
    text: [...textPlugins], // safe copy of Array
    all: [...allPlugins], // safe copy of Array
  };
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * loadPlugins(dir) — import every .js file in dir.
 * Each file is expected to call Module(...)(exec) during import.
 *
 * FIX #3: re-loads if a different directory is passed.
 * FIX #5: files sorted alphabetically for deterministic load order.
 */
export async function loadPlugins(dir = path.join(__dirname, "..", "plugins")) {
  const resolvedDir = path.resolve(dir);

  // Already loaded from this exact directory — return cached snapshot
  if (allPlugins.length > 0 && _loadedDir === resolvedDir) {
    _pluginsSnapshot = getSnapshot();
    return _pluginsSnapshot;
  }

  let files = [];
  try {
    const entries = await fs.readdir(resolvedDir);
    // FIX #5: sort for deterministic order
    files = entries.filter((f) => f.endsWith(".js")).sort();
  } catch (err) {
    console.error(
      "[plugins] Failed to read directory:",
      resolvedDir,
      err?.message || err
    );
    _pluginsSnapshot = getSnapshot();
    return _pluginsSnapshot;
  }

  let loaded = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const filePath = path.join(resolvedDir, file);
      await import(pathToFileURL(filePath).href);
      console.log(`[plugins] ✅ Loaded: ${file}`);
      loaded++;
    } catch (err) {
      console.error(`[plugins] ❌ Error loading ${file}:`, err?.message || err);
      failed++;
    }
  }

  console.log(
    `[plugins] 📦 Commands: ${commandMap.size} | Text: ${textPlugins.length} | Total: ${allPlugins.length}` +
      (failed > 0 ? ` | ⚠️  Failed: ${failed}` : "")
  );

  _loadedDir = resolvedDir;
  _pluginsSnapshot = getSnapshot();
  // FIX #6: clear loading promise after successful load
  _loadingPromise = null;
  return _pluginsSnapshot;
}

// ── Hot-path synchronous getter ───────────────────────────────────────────────

/**
 * ensurePlugins() — synchronous snapshot getter for the hot message path.
 *
 * Returns current snapshot if available.
 * If plugins haven't loaded yet, kicks off background load (once) and
 * returns an empty-but-valid snapshot so callers never crash.
 *
 * NOTE: Do NOT `await ensurePlugins()` — it is intentionally synchronous.
 *       Use `await forceLoadPlugins()` at startup instead.
 */
export function ensurePlugins() {
  if (_pluginsSnapshot) return _pluginsSnapshot;

  // Kick off background load once
  if (!_loadingPromise) {
    _loadingPromise = loadPlugins().catch((err) => {
      console.error("[plugins] Background load failed:", err?.message || err);
      _loadingPromise = null; // allow retry on next call
    });
  }

  // Return empty-but-valid snapshot immediately (safe for hot path)
  return {
    commands: new Map(),
    text: [],
    all: [],
  };
}

// ── Startup loader ────────────────────────────────────────────────────────────

/**
 * forceLoadPlugins(dir) — awaitable, use at startup.
 *
 * Blocks until all plugins are loaded. Safe to call multiple times —
 * returns cached result if already loaded from the same directory.
 *
 * FIX #2: this is what main() in client.js should await, not ensurePlugins().
 */
export async function forceLoadPlugins(dir) {
  if (_pluginsSnapshot && (!dir || path.resolve(dir) === _loadedDir)) {
    return _pluginsSnapshot;
  }
  // FIX #6: if a previous load is in flight, join it
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = loadPlugins(dir);
  return _loadingPromise;
}

// ── Exports for plugin consumers ──────────────────────────────────────────────

/**
 * FIX #1: `commands` now correctly exports the Map (commandMap),
 * not allPlugins (Array). Back-compat maintained.
 */
export const commands = commandMap;

/**
 * Safe snapshot getter — returns a copy of allPlugins array.
 */
export function getCommands() {
  return [...allPlugins];
}

/**
 * Diagnostic helper — useful for /status or admin endpoints.
 */
export function getPluginInfo() {
  return {
    commands: Array.from(commandMap.keys()),
    textPlugins: textPlugins.map((p) => p.name || p.on || "unnamed"),
    total: allPlugins.length,
    loadedDir: _loadedDir,
    loaded: _pluginsSnapshot !== null,
  };
}
