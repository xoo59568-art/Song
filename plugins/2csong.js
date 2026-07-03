import axios from "axios";
import yts from "yt-search";
import { Module } from "../lib/plugins.js";
import fs from "fs";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

ffmpeg.setFfmpegPath(ffmpegPath);

const DEFAULT_WAVEFORM = Buffer.from(
  Array.from({ length: 100 }, () => Math.floor(Math.random() * 101))
);

/* ===========================
   HELPERS
=========================== */

const resolveChannelJid = async (input, message) => {
  input = input.trim();
  if (input.includes("@newsletter")) return input;
  try {
    const url = new URL(input);
    if (url.pathname.startsWith("/channel/")) {
      const code = url.pathname.split("/channel/")[1];
      const res = await message.conn.newsletterMetadata("invite", code, "GUEST");
      return res.id;
    }
  } catch (_) {}
  return null;
};

const isYouTubeUrl = (str) =>
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(str.trim());

async function fetchBuffer(url) {
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  return Buffer.from(res.data);
}

function cleanup(...files) {
  for (const f of files) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}

function formatViews(v) {
  if (!v && v !== 0) return "Unknown";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return String(v);
}

// Generate a raw 1x1 black PNG buffer (no lavfi dependency)
function createBlackPng(pngPath) {
  const blackPixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  fs.writeFileSync(pngPath, blackPixelPng);
}

// Step 1: raw audio -> black screen mp4 (fast: low fps, low res, audio copied not re-encoded)
async function toBlackMp4(audioPath, pngPath, mp4Path) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(pngPath)
      .inputOptions(["-loop", "1", "-framerate", "1"])
      .input(audioPath)
      .outputOptions([
        "-shortest",
        "-vf", "scale=160:120",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "stillimage",
        "-crf", "51",
        "-r", "1",
        "-g", "1",
        "-c:a", "copy",
        "-pix_fmt", "yuv420p",
      ])
      .format("mp4")
      .save(mp4Path)
      .on("end", resolve)
      .on("error", reject);
  });
}

// Step 2: mp4 -> ogg/opus (voice note ready)
async function toOgg(mp4Path, oggPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(mp4Path)
      .noVideo()
      .audioCodec("libopus")
      .audioChannels(1)
      .audioFrequency(48000)
      .audioBitrate("64k")
      .outputOptions(["-vn", "-application", "voip", "-avoid_negative_ts", "make_zero"])
      .format("ogg")
      .on("end", resolve)
      .on("error", reject)
      .save(oggPath);
  });
}

// fwd.js-style multi-attempt reliable send (for channel only)
async function sendToChannel(conn, jid, payload, opts = {}) {
  try {
    await conn.sendMessage(jid, payload, opts);
    return true;
  } catch (e) {
    console.log("channel send attempt 1 failed:", e.message);
  }

  await new Promise((r) => setTimeout(r, 1000));

  try {
    await conn.sendMessage(jid, payload, opts);
    return true;
  } catch (e) {
    console.log("channel send attempt 2 failed:", e.message);
  }

  await new Promise((r) => setTimeout(r, 1500));

  try {
    await conn.sendMessage(jid, payload, { ...opts, force: true });
    return true;
  } catch (e) {
    console.log("channel send attempt 3 failed:", e.message);
  }

  return false;
}

/* ===========================
   .csong
=========================== */

Module({
  command: "csong2",
  package: "youtube",
  description: "Download song → black screen mp4 → voice note → channel upload",
  usage: ".csong <song name / yt link> , <channel jid / channel link>",
})(async (message, match) => {
  const stamp = Date.now();
  const inPath  = path.join(os.tmpdir(), `csong_in_${stamp}.mp3`);
  const pngPath = path.join(os.tmpdir(), `csong_img_${stamp}.png`);
  const mp4Path = path.join(os.tmpdir(), `csong_black_${stamp}.mp4`);
  const oggPath = path.join(os.tmpdir(), `csong_out_${stamp}.ogg`);

  try {
    if (!match) {
      return message.send(
        "❌ Usage:\n.csong love nwantiti , 120363418088880523@newsletter\n.csong https://youtu.be/xxx , https://whatsapp.com/channel/xxx"
      );
    }

    const lastComma = match.lastIndexOf(",");
    if (lastComma === -1) {
      return message.send(
        "❌ Use comma to separate song and channel\n\nExample:\n.csong song name , channel_jid"
      );
    }

    const songInput = match.slice(0, lastComma).trim();
    const channelInput = match.slice(lastComma + 1).trim();

    if (!songInput) return message.send("❌ Enter song name or YouTube link");
    if (!channelInput) return message.send("❌ Enter channel JID or link");

    await message.react("🔍");

    const channelJid = await resolveChannelJid(channelInput, message);
    if (!channelJid) {
      return message.send("❌ Invalid channel JID or link");
    }

    // Resolve video
    let video;
    if (isYouTubeUrl(songInput)) {
      const videoId = songInput.match(/(?:v=|youtu\.be\/)([^&?/]+)/)?.[1] || "";
      const res = await yts({ videoId });
      if (res?.title) {
        video = {
          title: res.title,
          author: { name: res.author?.name || "Unknown" },
          timestamp: res.timestamp || "?",
          views: res.views,
          url: songInput,
        };
      } else {
        video = {
          title: "Unknown Title",
          author: { name: "Unknown" },
          timestamp: "?",
          views: null,
          url: songInput,
        };
      }
    } else {
      const res = await yts(songInput);
      if (!res.videos || res.videos.length === 0) {
        return message.send("❌ Song not found");
      }
      video = res.videos[0];
    }

    // 1️⃣ Status card → inbox only
    const statusCard =
      `╭━━━〔 *🎵CHANNEL SONG UPLOADER* 〕━━━┈\n` +
      `┃ 🎶 *Title:* ${video.title}\n` +
      `┃ ⏱️ *Duration:* ${video.timestamp}\n` +
      `┃ 👁️ *Views:* ${formatViews(video.views)}\n` +
      `┃ 👨‍💻 *By:* Mr Rabbit.\n` +
      `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈\n\n` +
      `_⏳ Processing & uploading to channel..._`;

    await message.send(statusCard);
    await message.react("⬇️");

    const apiUrl =
      "https://rabbitapi.zone.id/api/song?url=" + encodeURIComponent(video.url);

    const { data } = await axios.get(apiUrl, { timeout: 30000 });

    if (!data?.success || !data?.result?.audio) {
      console.log(data);
      await message.react("❌");
      return message.send("❌ Audio download failed");
    }

    await message.react("🎙️");

    // Download raw audio
    const audioBuffer = await fetchBuffer(data.result.audio);
    fs.writeFileSync(inPath, audioBuffer);
    console.log("Downloaded audio size:", audioBuffer.length, "bytes");

    // Step 1: audio -> black screen mp4 (fast)
    createBlackPng(pngPath);
    await toBlackMp4(inPath, pngPath, mp4Path);

    // Step 2: black mp4 -> ogg (voice note)
    await toOgg(mp4Path, oggPath);
    const voiceBuffer = fs.readFileSync(oggPath);

    const duration = await new Promise((resolve) => {
      ffmpeg.ffprobe(oggPath, (err, meta) => {
        resolve(!err ? Math.ceil(meta?.format?.duration || 10) : 10);
      });
    });

    await message.react("📤");

    const voicePayload = {
      audio: voiceBuffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
      seconds: duration,
      waveform: DEFAULT_WAVEFORM,
      contextInfo: {
        forwardingScore: 0,
        isForwarded: false,
      },
    };

    // 2️⃣ Voice note (song only) → channel
    const sentToChannel = await sendToChannel(message.conn, channelJid, voicePayload);

    if (!sentToChannel) {
      await message.react("❌");
      return message.send("❌ Failed to upload song to channel after retries");
    }

    await message.react("✅");
    await message.send(
      `✅ *Successfully uploaded to channel!*\n\n🎵 *${video.title}*\n👤 ${video.author.name}\n⏱️ ${video.timestamp}`
    );

  } catch (err) {
    console.error("[CSONG ERROR]", err);
    if (err.code === "ECONNABORTED") {
      await message.send("⏳ Server timeout, try again");
    } else {
      await message.send("⚠️ csong failed: " + err.message);
    }
  } finally {
    cleanup(inPath, pngPath, mp4Path, oggPath);
  }
});
