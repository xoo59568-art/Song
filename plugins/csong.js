import axios from "axios";
import yts from "yt-search";
import { Module } from "../lib/plugins.js";
import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";

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

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve({ stdout, stderr });
    });
  });
}

// Convert raw input -> premium 48kHz Ogg/Opus (any input format)
async function toOgg(inputPath, outputPath) {
  const cmd = `ffmpeg -y -i "${inputPath}" -vn -c:a libopus -b:a 96k -vbr on -ac 1 -ar 48000 -frame_duration 20 -map_metadata -1 -f ogg "${outputPath}"`;
  await execAsync(cmd);
}

// Generate a dynamic waveform from the encoded audio using volumedetect
async function generateDynamicWaveform(outputPath) {
  let dynamicWaveform = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    dynamicWaveform[i] = Math.floor(Math.random() * 20) + 15;
  }

  try {
    const analysisCommand = `ffmpeg -i "${outputPath}" -filter:a "volumedetect" -f null /dev/null`;
    const { stdout, stderr } = await new Promise((resolve) => {
      exec(analysisCommand, (err, aStdout, aStderr) => {
        resolve({ stdout: aStdout, stderr: aStderr });
      });
    });

    const logOutput = stderr || stdout;
    const maxDbMatch = logOutput.match(/max_volume:\s+(-?\d+\.?\d*)\s+dB/);
    const meanDbMatch = logOutput.match(/mean_volume:\s+(-?\d+\.?\d*)\s+dB/);

    if (maxDbMatch && meanDbMatch) {
      const maxDb = parseFloat(maxDbMatch[1]);
      const meanDb = parseFloat(meanDbMatch[1]);
      const soundRange = Math.abs(maxDb - meanDb) || 20;

      for (let i = 0; i < 64; i++) {
        let intensityFactor = Math.abs(Math.sin((i / 64) * Math.PI * (1 + (soundRange / 10))));
        let barHeight = Math.floor(intensityFactor * 40) + 15;
        if (barHeight > 63) barHeight = 63;
        if (barHeight < 10) barHeight = 10;
        dynamicWaveform[i] = barHeight;
      }
    }
  } catch (parseErr) {
    console.error("Waveform analysis fallback used:", parseErr);
  }

  return Buffer.from(dynamicWaveform);
}

async function getDuration(outputPath) {
  return new Promise((resolve) => {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`;
    exec(cmd, (err, stdout) => {
      const dur = parseFloat(stdout);
      resolve(!err && !isNaN(dur) ? Math.ceil(dur) : 10);
    });
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
  command: "csong",
  package: "youtube",
  description: "Download song → premium 48kHz Ogg/Opus with dynamic waveform → channel upload",
  usage: ".csong <song name / yt link> , <channel jid / channel link>",
})(async (message, match) => {
  const stamp = Date.now();
  const inPath = path.join(os.tmpdir(), `csong_in_${stamp}.mp3`);
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

    // Convert -> premium 48kHz Ogg/Opus
    await toOgg(inPath, oggPath);

    // Generate dynamic waveform from the encoded audio
    const dynamicWaveform = await generateDynamicWaveform(oggPath);

    const voiceBuffer = fs.readFileSync(oggPath);
    const duration = await getDuration(oggPath);

    await message.react("📤");

    const voicePayload = {
      audio: voiceBuffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
      seconds: duration,
      waveform: dynamicWaveform,
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
    cleanup(inPath, oggPath);
  }
});
