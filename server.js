import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";

const PORT = Number(process.env.PORT || 8080);
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
const MAX_REDIRECTS = 5;

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

function sendJson(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

function isPublicIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => n < 0 || n > 255)) {
    return false;
  }

  const [a, b, c] = parts;

  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return false;
  }

  return true;
}

function isPublicIPv6(ip) {
  const value = ip.toLowerCase();

  // Accept global unicast IPv6 only.
  if (!/^[23]/.test(value)) return false;

  // Exclude documentation and special-use ranges.
  if (
    value.startsWith("2001:db8:") ||
    value.startsWith("2001:0000:") ||
    value.startsWith("2001:10:")
  ) {
    return false;
  }

  return true;
}

function isPublicIP(ip) {
  const version = isIP(ip);

  if (version === 4) return isPublicIPv4(ip);
  if (version === 6) return isPublicIPv6(ip);

  return false;
}

async function validateSourceUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Please provide a valid direct MP4 URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS links are supported");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing login credentials are not allowed");
  }

  const hostname = url.hostname.toLowerCase();

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error("This source hostname is not allowed");
  }

  const version = isIP(hostname);

  if (version) {
    if (!isPublicIP(hostname)) {
      throw new Error("Private or reserved IP addresses are not allowed");
    }
  } else {
    let addresses;

    try {
      addresses = await lookup(hostname, {
        all: true,
        verbatim: true
      });
    } catch {
      throw new Error("Could not resolve the source hostname");
    }

    if (
      !addresses.length ||
      addresses.some(address => !isPublicIP(address.address))
    ) {
      throw new Error("Source hostname resolves to a restricted address");
    }
  }

  return url;
}

async function fetchDirectMp4(sourceUrl, signal) {
  let currentUrl = sourceUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await validateSourceUrl(currentUrl);

    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SlapVideo/1.0)",
        "Accept": "video/mp4, application/octet-stream, */*"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();

      if (!location) {
        throw new Error("Source returned a redirect without a location");
      }

      if (redirects === MAX_REDIRECTS) {
        throw new Error("Too many redirects from the source");
      }

      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Source returned HTTP ${response.status}`);
    }

    const contentType = (
      response.headers.get("content-type") || ""
    ).split(";")[0].trim().toLowerCase();

    const finalPath = new URL(currentUrl).pathname.toLowerCase();

    const isMp4 =
      contentType === "video/mp4" ||
      (
        contentType === "application/octet-stream" &&
        finalPath.endsWith(".mp4")
      );

    if (!isMp4) {
      await response.body.cancel();
      throw new Error("The URL did not return a direct MP4 file");
    }

    const contentLength = Number(
      response.headers.get("content-length") || 0
    );

    if (contentLength > MAX_SIZE) {
      await response.body.cancel();
      throw new Error("Video is larger than 300 MB");
    }

    return response;
  }

  throw new Error("Unable to fetch the source video");
}

async function downloadDirectMp4(url, filePath) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort(new Error("Download timed out after 15 minutes"));
  }, MAX_DURATION_MS);

  try {
    const response = await fetchDirectMp4(url, controller.signal);

    let downloaded = 0;

    const sizeLimit = new Transform({
      transform(chunk, encoding, callback) {
        downloaded += chunk.length;

        if (downloaded > MAX_SIZE) {
          callback(new Error("Video is larger than 300 MB"));
          controller.abort();
          return;
        }

        callback(null, chunk);
      }
    });

    await pipeline(
      Readable.fromWeb(response.body),
      sizeLimit,
      createWriteStream(filePath, { flags: "wx" }),
      { signal: controller.signal }
    );

    if (downloaded === 0) {
      throw new Error("The MP4 file is empty");
    }

    return downloaded;
  } finally {
    clearTimeout(timeout);
  }
}

if (missingConfig.length === 0) {
  telegramProcess = spawn("telegram-bot-api", [
    "--local",
    `--http-port=${LOCAL_API_PORT}`,
    `--api-id=${API_ID}`,
    `--api-hash=${API_HASH}`,
    "--dir=/data",
    "--temp-dir=/data/temp"
  ]);

  telegramProcess.stdout.on("data", data => {
    console.log("[telegram]", data.toString().trim());
  });

  telegramProcess.stderr.on("data", data => {
    console.log("[telegram]", data.toString().trim());
  });

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

async function uploadToCache(filePath) {
  const fileInfo = await stat(filePath);
  const filename = path.basename(filePath).replace(/["\r\n]/g, "_");
  const boundary = `----SlapVideo${randomUUID().replace(/-/g, "")}`;

  const fields =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
    `${CACHE_CHANNEL_ID}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="caption"\r\n\r\n` +
    `SlapVideo cache • Original MP4\r\n` +
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

        if (responseBody.length > 100000) {
          upload.destroy(new Error("Telegram response was too large"));
        }
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
    const ready = telegramReady && missingConfig.length === 0;

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

    if (!url) {
      throw new Error("A direct MP4 URL is required");
    }

    folder = path.join(JOB_DIR, randomUUID());
    await mkdir(folder, { recursive: true });

    const videoPath = path.join(folder, "video.mp4");

    const size = await downloadDirectMp4(url, videoPath);

    const message = await uploadToCache(videoPath);
    const video = message.video;

    sendJson(res, 200, {
      ok: true,
      quality: "original",
      size,
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

server.on("error", error => {
  console.error("[server] listen error:", error);
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
