
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, rm, openAsBlob } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.DOWNLOADER_API_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CACHE_CHANNEL_ID = process.env.CACHE_CHANNEL_ID;
const API_ID = process.env.TELEGRAM_API_ID;
const API_HASH = process.env.TELEGRAM_API_HASH;

const LOCAL_API = "http://127.0.0.1:8081";
const JOB_DIR = "/data/jobs";
const MAX_SIZE = 300 * 1024 * 1024;

const formats = {
  "360p": "bv*[height<=360]+ba/b[height<=360]/b",
  "480p": "bv*[height<=480]+ba/b[height<=480]/b",
  "720p": "bv*[height<=720]+ba/b[height<=720]/b",
  "1080p": "bv*[height<=1080]+ba/b[height<=1080]/b"
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json"
  });
  res.end(JSON.stringify(data));
}

// Start Telegram Local Bot API.
const telegram = spawn("telegram-bot-api", [
  "--local",
  "--http-port=8081",
  "--api-id=" + API_ID,
  "--api-hash=" + API_HASH,
  "--dir=/data",
  "--temp-dir=/data/temp"
]);

telegram.stdout.on("data", data =>
  console.log("[telegram]", data.toString().trim())
);

telegram.stderr.on("data", data =>
  console.log("[telegram]", data.toString().trim())
);

telegram.on("exit", code => {
  console.error("[telegram] exited:", code);
});

async function waitForTelegram() {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is missing");
  }

  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(
        `${LOCAL_API}/bot${BOT_TOKEN}/getMe`
      );

      if (response.ok) {
        const result = await response.json();
        if (result.ok) return;
      }
    } catch {}

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error("Telegram Local Bot API did not start");
}

async function readBody(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk.toString();

    if (body.length > 20000) {
      throw new Error("Request body too large");
    }
  }

  return JSON.parse(body);
}

function runDownloader(url, quality, output) {
  return new Promise((resolve, reject) => {
    const child = spawn("/opt/venv/bin/yt-dlp", [
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--max-filesize", "300M",
      "--merge-output-format", "mp4",
      "-f", formats[quality],
      "-o", output,
      url
    ]);

    let errorText = "";

    child.stderr.on("data", chunk => {
      const line = chunk.toString();
      errorText += line;

      if (errorText.length > 8000) {
        errorText = errorText.slice(-8000);
      }

      console.log("[yt-dlp]", line.trim());
    });

    child.stdout.on("data", chunk =>
      console.log("[yt-dlp]", chunk.toString().trim())
    );

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          errorText.slice(-3000) || `yt-dlp exited: ${code}`
        ));
      }
    });
  });
}

async function uploadToCache(filePath, quality) {
  const form = new FormData();

  form.append("chat_id", CACHE_CHANNEL_ID);
  form.append("caption", `SlapVideo cache • ${quality}`);

  // File-backed Blob avoids loading the entire video into RAM.
  const videoBlob = await openAsBlob(filePath, {
    type: "video/mp4"
  });

  form.append("video", videoBlob, path.basename(filePath));

  const response = await fetch(
    `${LOCAL_API}/bot${BOT_TOKEN}/sendVideo`,
    {
      method: "POST",
      body: form
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      "Telegram upload failed: " + JSON.stringify(result)
    );
  }

  return result.result;
}

async function cleanup(folder) {
  await rm(folder, {
    recursive: true,
    force: true
  });
}

let busy = false;

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "slapvideo-backend",
      busy
    });
    return;
  }

  if (req.method !== "POST" || req.url !== "/download") {
    sendJson(res, 404, {
      ok: false,
      error: "Not found"
    });
    return;
  }

  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    sendJson(res, 401, {
      ok: false,
      error: "Unauthorized"
    });
    return;
  }

  if (busy) {
    sendJson(res, 429, {
      ok: false,
      error: "A download is already running. Try again shortly."
    });
    return;
  }

  busy = true;
  let folder;

  try {
    if (!API_ID || !API_HASH || !BOT_TOKEN || !CACHE_CHANNEL_ID) {
      throw new Error("Telegram environment variables are missing");
    }

    const body = await readBody(req);
    const url = String(body.url || "").trim();
    const quality = String(body.quality || "720p");

    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Please provide a valid video URL");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are supported");
    }

    if (!formats[quality]) {
      throw new Error("Unsupported quality");
    }

    await waitForTelegram();

    folder = path.join(JOB_DIR, randomUUID());

    await mkdir(folder, {
      recursive: true
    });

    const template = path.join(folder, "video.%(ext)s");

    await runDownloader(url, quality, template);

    const files = await readdir(folder);

    const videoName = files.find(name =>
      /\.(mp4|mkv|webm|mov)$/i.test(name)
    );

    if (!videoName) {
      throw new Error("No video file was produced");
    }

    const videoPath = path.join(folder, videoName);
    const fileInfo = await stat(videoPath);

    if (fileInfo.size > MAX_SIZE) {
      throw new Error("Video is larger than 300 MB");
    }

    const message = await uploadToCache(videoPath, quality);
    const video = message.video;

    sendJson(res, 200, {
      ok: true,
      quality,
      size: fileInfo.size,
      message_id: message.message_id,
      file_id: video?.file_id || null,
      file_unique_id: video?.file_unique_id || null
    });
  } catch (error) {
    console.error("[download error]", error);

    sendJson(res, 500, {
      ok: false,
      error: error.message || "Download failed"
    });
  } finally {
    if (folder) {
      await cleanup(folder);
    }

    busy = false;
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] listening on port ${PORT}`);
});
