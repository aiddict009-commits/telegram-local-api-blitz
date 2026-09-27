import http from "node:http";

const PORT = 8099;

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, "http://127.0.0.1");

    if (requestUrl.pathname !== "/proxy") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const target = requestUrl.searchParams.get("url");

    if (!target) {
      res.writeHead(400);
      res.end("Missing url");
      return;
    }

    const targetUrl = new URL(target);

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
      res.writeHead(400);
      res.end("Only HTTP/HTTPS URLs are allowed");
      return;
    }

    console.log("[proxy] fetching:", targetUrl.href);

    const response = await fetch(targetUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "video/mp4,video/webm,video/*,*/*;q=0.8"
      }
    });

    if (!response.ok) {
      res.writeHead(response.status);
      res.end(`Source returned HTTP ${response.status}`);
      return;
    }

    const headers = {};

    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
      "cache-control"
    ]) {
      const value = response.headers.get(name);

      if (value) {
        headers[name] = value;
      }
    }

    res.writeHead(response.status, headers);

    if (!response.body) {
      res.end();
      return;
    }

    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      if (!res.write(value)) {
        await new Promise(resolve => res.once("drain", resolve));
      }
    }

    res.end();

  } catch (error) {
    console.error("[proxy] error:", error);

    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Proxy error");
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[proxy] running on 127.0.0.1:${PORT}`);
});
