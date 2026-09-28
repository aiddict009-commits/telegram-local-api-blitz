
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, rm } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 8080);
console.log("[config] PORT =", process.env.PORT, "| Node listens on =", PORT);
const API_KEY = process.env.DOWNLOADER_API_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CACHE_CHANNEL_ID = process.env.CACHE_CHANNEL_ID;
const API_ID = process.env.TELEGRAM_API_ID;
const API_HASH = process.env.TELEGRAM_API_HASH;

const LOCAL_API_HOST = "127.0.0.1";
const LOCAL_API_PORT = 8082;
const JOB_DIR = "/data/jobs";
const MAX_SIZE = 300 * 1024 * 1024;
const MAX_DURATION_MS = 15 * 60 * 1000;

const formats = {
  "360p": "bv*[height<=360]+ba/b[height<=360]",
  "480p": "bv*[height<=480]+ba/b[height<=480]",
  "720p": "bv*[height<=720]+ba/b[height<=720]",
  "1080p": "bv*[height<=1080]+ba/b[height<=1080]"
};

function sendJson(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

const missingConfig = [
  ["DOWNLOADER_API_KEY", API_KEY],
  ["BOT_TOKEN", BOT_TOKEN],
  ["CACHE_CHANNEL_ID", CACHE_CHANNEL_ID],
  ["TELEGRAM_API_ID", API_ID],
  ["TELEGRAM_API_HASH", API_HASH]
].filter(([, value]) => !value).map(([name]) => name);

let telegramReady = false;
let telegramProcess = null;
let busy = false;

if (missingConfig.length === 0) {
  telegramProcess = spawn("telegram-bot-api", [
    "--local",
    "--http-port=8082",
    `--api-id=${API_ID}`,
    `--api-hash=${API_HASH}`,
    "--dir=/data",
    "--temp-dir=/data/temp"
  ]);

  telegramProcess.stdout.on("data", data =>
    console.log("[telegram]", data.toString().trim())
  );

  telegramProcess.stderr.on("data", data =>
    console.log("[telegram]", data.toString().trim())
  );

  telegramProcess.on("error", error => {
    telegramReady = false;
    console.error("[telegram] process error:", error);
  });

  telegramProcess.on("exit", code => {
    telegramReady = false;
    console.error("[telegram] exited with code:", code);
  });
} else {
  console.error(
    "[config] Missing environment variables:",
    missingConfig.join(", ")
  );
}

async function waitForTelegram() {
  for (let attempt = 0; attempt < 45; attempt++) {
    if (!telegramProcess || telegramProcess.exitCode !== null) {
      throw new Error("Telegram Local Bot API is not running");
    }

    try {
      const response = await fetch(
        `http://${LOCAL_API_HOST}:${LOCAL_API_PORT}/bot${BOT_TOKEN}/getMe`,
        { signal: AbortSignal.timeout(4000) }
      );

      const result = await response.json();

      if (response.ok && result.ok) {
        telegramReady = true;
        return;
      }
    } catch {
      // The Local Bot API may still be starting.
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error("Telegram Local Bot API did not become ready");
}

if (telegramProcess) {
  waitForTelegram()
    .then(() => console.log("[telegram] API is ready"))
    .catch(error => console.error("[telegram] startup:", error.message));
}

async function readJson(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk.toString("utf8");

    if (body.length > 20000) {
      throw new Error("Request body is too large");
    }
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function runDownloader(url, quality, outputTemplate) {
  return new Promise((resolve, reject) => {
    const child = spawn("/opt/venv/bin/yt-dlp", [
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--max-filesize", "300M",
      "--merge-output-format", "mp4",
      "-f", formats[quality],
      "-o", outputTemplate,
      url
    ]);

    let errorText = "";
    let settled = false;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error("Download timed out after 15 minutes"));
      }
    }, MAX_DURATION_MS);

    child.stdout.on("data", chunk => {
      console.log("[yt-dlp]", chunk.toString().trim());
    });

    child.stderr.on("data", chunk => {
      const line = chunk.toString();
      errorText += line;

      if (errorText.length > 8000) {
        errorText = errorText.slice(-8000);
      }

      console.log("[yt-dlp]", line.trim());
    });

    child.on("error", error => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on("close", code => {
      clearTimeout(timeout);

      if (settled) return;
      settled = true;

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          errorText.slice(-3000) || `yt-dlp exited with code ${code}`
        ));
      }
    });
  });
}

// Stream the local file to Telegram without buffering the whole video.
async function uploadToCache(filePath, quality) {
  const fileInfo = await stat(filePath);
  const filename = path.basename(filePath).replace(/["\r\n]/g, "_");
  const boundary = `----SlapVideo${randomUUID().replace(/-/g, "")}`;

  const fields =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
    `${CACHE_CHANNEL_ID}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="caption"\r\n\r\n` +
    `SlapVideo cache • ${quality}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="video"; filename="${filename}"\r\n` +
    `Content-Type: video/mp4\r\n\r\n`;

  const ending = `\r\n--${boundary}--\r\n`;
  const prefixBuffer = Buffer.from(fields);
  const endingBuffer = Buffer.from(ending);

  const contentLength =
    prefixBuffer.length + fileInfo.size + endingBuffer.length;

  return new Promise((resolve, reject) => {
    const upload = http.request({
      hostname: LOCAL_API_HOST,
      port: LOCAL_API_PORT,
      path: `/bot${BOT_TOKEN}/sendVideo`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": contentLength
      }
    }, response => {
      let responseBody = "";

      response.setEncoding("utf8");
      response.on("data", chunk => {
        responseBody += chunk;
      });

      response.on("end", () => {
        let result;

        try {
          result = JSON.parse(responseBody);
        } catch {
          reject(new Error("Telegram returned an invalid response"));
          return;
        }

        if (
          response.statusCode < 200 ||
          response.statusCode >= 300 ||
          !result.ok
        ) {
          reject(new Error(
            "Telegram upload failed: " +
            JSON.stringify(result).slice(0, 2000)
          ));
          return;
        }

        resolve(result.result);
      });
    });

    upload.on("error", reject);

    upload.write(prefixBuffer);

    const fileStream = createReadStream(filePath);

    fileStream.on("error", error => upload.destroy(error));
    fileStream.on("end", () => upload.end(endingBuffer));
    fileStream.pipe(upload, { end: false });
  });
}

async function cleanup(folder) {
  if (!folder) return;

  try {
    await rm(folder, { recursive: true, force: true });
  } catch (error) {
    console.error("[cleanup] failed:", error.message);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const ready = telegramReady && !missingConfig.length;

    sendJson(res, ready ? 200 : 503, {
      ok: ready,
      service: "slapvideo-backend",
      telegramReady,
      busy
    });
    return;
  }

  if (req.method !== "POST" || req.url !== "/download") {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }

  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  if (missingConfig.length) {
    sendJson(res, 503, {
      ok: false,
      error: "Backend environment variables are missing"
    });
    return;
  }

  if (!telegramReady) {
    sendJson(res, 503, {
      ok: false,
      error: "Telegram Local Bot API is not ready"
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
    const body = await readJson(req);
    const url = String(body.url || "").trim();
    const quality = String(body.quality || "720p");

    let parsedUrl;

    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error("Please provide a valid video URL");
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are supported");
    }

    if (!formats[quality]) {
      throw new Error("Unsupported quality");
    }

    folder = path.join(JOB_DIR, randomUUID());
    await mkdir(folder, { recursive: true });

    const outputTemplate = path.join(folder, "video.%(ext)s");

    await runDownloader(url, quality, outputTemplate);

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
    await cleanup(folder);
    busy = false;
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] listening on port ${PORT}`);
});

function shutdown() {
  console.log("[server] shutting down");
  server.close();
  if (telegramProcess && telegramProcess.exitCode === null) {
    telegramProcess.kill("SIGTERM");
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
