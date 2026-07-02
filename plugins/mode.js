import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";

function resolveBotNumber(conn) {
  if (!conn) return null;
  if (conn.id) return String(conn.id);
  if (conn.user && conn.user.id) return String(conn.user.id).split(":")[0];
  return null;
}

Module({
  command: "mode",
  package: "owner",
  description: "Toggle bot mode (public / private)",
})(async (message, match) => {
  if (!message.isFromMe) return message.send("❌ Owner only command.");

  const botNumber = resolveBotNumber(message.conn);
  if (!botNumber) return message.send("❌ Bot number not found.");

  const input = match?.trim().toLowerCase();
  const key = "mode"; // true = public, false = private

  if (input === "public" || input === "private") {
    await message.react("⏳");
    try {
      db.setHot(botNumber, key, input === "public");
      await message.react("✅");
      return message.send(`✅ *Bot mode set to* \`${input.toUpperCase()}\``);
    } catch (err) {
      await message.react("❌");
      return message.send("❌ *Failed to update bot mode*");
    }
  }

  const isPublic = db.get(botNumber, key, true) === true;

  return message.send(
    `⚙️ *Bot Mode*\n` +
      `> Status: ${isPublic ? "🌍 PUBLIC" : "🔒 PRIVATE"}\n\n` +
      `*Usage:*\n` +
      `• .mode public\n` +
      `• .mode private`
  );
});

Module({
  command: "public",
  package: "owner",
  description: "Set bot mode to public",
})(async (message) => {
  if (!message.isFromMe) return message.send("❌ Owner only command.");

  const botNumber = resolveBotNumber(message.conn);
  if (!botNumber) return message.send("❌ Bot number not found.");

  await message.react("⏳");
  try {
    db.setHot(botNumber, "mode", true);
    await message.react("✅");
    return message.send("✅ *Bot mode set to* `PUBLIC`");
  } catch (err) {
    await message.react("❌");
    return message.send("❌ *Failed to update bot mode*");
  }
});

Module({
  command: "private",
  package: "owner",
  description: "Set bot mode to private",
})(async (message) => {
  if (!message.isFromMe) return message.send("❌ Owner only command.");

  const botNumber = resolveBotNumber(message.conn);
  if (!botNumber) return message.send("❌ Bot number not found.");

  await message.react("⏳");
  try {
    db.setHot(botNumber, "mode", false);
    await message.react("✅");
    return message.send("✅ *Bot mode set to* `PRIVATE`");
  } catch (err) {
    await message.react("❌");
    return message.send("❌ *Failed to update bot mode*");
  }
});
