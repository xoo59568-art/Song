// lib/credsPoller.js
// Polls the external pairing website for newly-paired sessions and boots them.

import fs from "fs/promises";
import path from "path";
import config from "../config.js";

/**
 * @param {SessionManager} manager - the bot's SessionManager instance
 * @param {object} opts
 * @param {string} opts.pairSiteUrl - e.g. https://your-pair-site.onrender.com
 * @param {string} [opts.token]     - PAIR_API_TOKEN shared secret
 * @param {number} [opts.intervalMs] - how often to poll (default 8s)
 */
export function startCredsPoller(manager, opts = {}) {
  const pairSiteUrl = (opts.pairSiteUrl || config.PAIR_SITE_URL || process.env.PAIR_SITE_URL || "").replace(/\/$/, "");
  const token = opts.token || config.PAIR_API_TOKEN || process.env.PAIR_API_TOKEN || "";
  const intervalMs = opts.intervalMs || Number(process.env.PAIR_POLL_INTERVAL_MS) || 8000;

  if (!pairSiteUrl) {
    console.warn("[credsPoller] PAIR_SITE_URL not set — poller disabled.");
    return null;
  }

  console.log(`[credsPoller] Watching ${pairSiteUrl} every ${intervalMs}ms`);

  const tick = async () => {
    try {
      const url = `${pairSiteUrl}/api/pending${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[credsPoller] Pair site returned ${res.status}`);
        return;
      }
      const data = await res.json();
      if (!data?.ok || !Array.isArray(data.sessions) || data.sessions.length === 0) return;

      for (const session of data.sessions) {
        await bootSession(manager, session);
      }
    } catch (err) {
      console.error("[credsPoller] Poll failed:", err?.message || err);
    }
  };

  const timer = setInterval(tick, intervalMs);
  tick(); // run once immediately on startup

  return () => clearInterval(timer);
}

async function bootSession(manager, session) {
  const { number, files } = session;
  if (!number || !files || typeof files !== "object") {
    console.warn("[credsPoller] Skipping malformed session entry");
    return;
  }

  // Safety net: never boot a session with an empty/invalid creds.json —
  // that would create a broken session folder instead of a working one.
  const rawCreds = files["creds.json"];
  let credsValid = false;
  if (rawCreds && typeof rawCreds === "string") {
    try {
      const parsed = JSON.parse(rawCreds);
      credsValid = parsed && typeof parsed === "object";
    } catch {
      credsValid = false;
    }
  }
  if (!credsValid) {
    console.warn(`[credsPoller] Skipping ${number} — creds.json missing/invalid in queue entry`);
    return;
  }

  try {
    const sessionsDir = path.join(process.cwd(), "sessions");
    const sessionPath = path.join(sessionsDir, number);
    await fs.mkdir(sessionPath, { recursive: true });

    for (const [filename, content] of Object.entries(files)) {
      // Guard against path traversal from a malicious/garbled queue entry
      const safeName = path.basename(filename);
      await fs.writeFile(path.join(sessionPath, safeName), content, "utf-8");
    }

    console.log(`[credsPoller] ✅ New creds received for ${number} — starting session`);
    await manager.start(number);
  } catch (err) {
    console.error(`[credsPoller] Failed to boot session for ${number}:`, err?.message || err);
  }
}
