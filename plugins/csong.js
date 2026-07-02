import axios from "axios";
import yts from "yt-search";
import { Module } from "../lib/plugins.js";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

ffmpeg.setFfmpegPath(ffmpegPath);

const resolveChannelJid = async (input, message) => {
  input = input.trim();

  if (input.includes("@newsletter")) return input;

  try {
    const url = new URL(input);

    if (url.pathname.startsWith("/channel/")) {
      const code = url.pathname.split("/channel/")[1];

      const res = await message.conn.newsletterMetadata(
        "invite",
        code,
        "GUEST"
      );

      return res.id;
    }
  } catch (_) {}

  return null;
};

const isYouTubeUrl = (str) =>
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(
    str.trim()
  );

Module({
  command: "csong",
  package: "youtube",
  description: "Send song as voice note to WhatsApp channel",
  usage: ".csong <song/link> , <channel_jid/channel_link>",
})(async (message, match) => {
  const tempFiles = [];

  try {
    if (!match) {
      return message.send(
        "❌ Usage:\n.csong faded , 1203634xxxx@newsletter"
      );
    }

    const lastComma = match.lastIndexOf(",");

    if (lastComma === -1) {
      return message.send("❌ Use comma to separate song and channel");
    }

    const songInput = match.slice(0, lastComma).trim();
    const channelInput = match.slice(lastComma + 1).trim();

    if (!songInput) {
      return message.send("❌ Enter song name or YouTube link");
    }

    if (!channelInput) {
      return message.send("❌ Enter channel JID or link");
    }

    await message.react("🔍");

    const channelJid = await resolveChannelJid(channelInput, message);

    if (!channelJid) {
      return message.send("❌ Invalid channel JID or link");
    }

    let video;

    if (isYouTubeUrl(songInput)) {
      const videoId = songInput.match(/(?:v=|youtu\.be\/)([^&?/]+)/)?.[1] || "";
      const res = await yts({ videoId });

      video = {
        title: res.title || "Unknown Title",
        author: { name: res.author?.name || "Unknown" },
        timestamp: res.timestamp || "?",
        thumbnail: res.thumbnail || "",
        url: songInput,
      };
    } else {
      const res = await yts(songInput);

      if (!res.videos || res.videos.length === 0) {
        return message.send("❌ Song not found");
      }

      video = res.videos[0];
    }

    await message.react("⬇️");

    // Fetch download URL from API
    const apiUrl = "https://newapi-536w.onrender.com/api/song?url=" + encodeURIComponent(video.url);
    const { data } = await axios.get(apiUrl, { timeout: 60000 });

    if (!data || !data.status || !data.result?.audio) {
      return message.send("❌ Audio download failed from API");
    }

    const id = crypto.randomBytes(8).toString("hex");
    const mp3File = path.join(os.tmpdir(), `csong_${id}.mp3`);
    
    // CHANGED: Use .ogg extension for correct WhatsApp formatting
    const oggFile = path.join(os.tmpdir(), `csong_${id}.ogg`);

    tempFiles.push(mp3File, oggFile);

    // Download MP3
    const dlResp = await axios.get(data.result.audio, {
      responseType: "stream",
      timeout: 120000,
    });

    const writer = fs.createWriteStream(mp3File);
    dlResp.data.pipe(writer);

    await new Promise((res, rej) => {
      writer.on("finish", res);
      writer.on("error", rej);
      dlResp.data.on("error", rej); // Catch stream download errors
    });

    await message.react("🎙️");

    // Convert to OGG/Opus for WhatsApp
    await new Promise((resolve, reject) => {
      ffmpeg(mp3File)
        .noVideo()
        .audioCodec("libopus")
        .format("ogg") // CHANGED: WhatsApp strictly expects the OGG container
        .audioBitrate("128k") // Added bitrate to ensure stable quality
        .on("end", resolve)
        .on("error", reject)
        .save(oggFile);
    });

    const voiceBuffer = fs.readFileSync(oggFile);

    // Preview message for the user running the command
    await message.send({
      image: { url: video.thumbnail },
      caption:
        `🎵 *Now Playing*\n\n` +
        `📌 *Title:* ${video.title}\n` +
        `👤 *Channel:* ${video.author.name}\n` +
        `⏱️ *Duration:* ${video.timestamp}`,
      mimetype: "image/jpeg",
    });

    // Text details sent to the channel
    await message.conn.sendMessage(channelJid, {
      text:
        `🎵 *Now Playing*\n\n` +
        `📌 *Title:* ${video.title}\n` +
        `👤 *Channel:* ${video.author.name}\n` +
        `⏱️ *Duration:* ${video.timestamp}`,
    });

    await message.react("📤");

    // Upload Voice note (PTT) to the channel
    await message.conn.sendMessage(channelJid, {
      audio: voiceBuffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
    });

    await message.react("✅");

    await message.send(`✅ *Sent successfully!*\n\n🎵 ${video.title}`);
  } catch (err) {
    console.error("[CSONG ERROR]", err);
    await message.send("⚠️ csong failed: " + err.message);
  } finally {
    // Delete all temporary files to prevent server storage bloat
    tempFiles.forEach((f) => {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    });
  }
});
