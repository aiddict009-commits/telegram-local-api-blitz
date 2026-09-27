import http from "node:http";

const PORT = 8080;

const LOCAL_API = "http://127.0.0.1:8081";

const server = http.createServer((req, res) => {

  if (req.url.startsWith("/bot")) {

    const target = new URL(req.url, LOCAL_API);

    const proxy = http.request(
      target,
      {
        method: req.method,
        headers: req.headers
      },
      upstream => {

        res.writeHead(
          upstream.statusCode || 502,
          upstream.headers
        );

        upstream.pipe(res);
      }
    );

    proxy.on("error", error => {

      console.error("[router] error:", error);

      if (!res.headersSent) {
        res.writeHead(502);
        res.end("Local API unavailable");
      }
    });

    req.pipe(proxy);

    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[router] running on :${PORT}`);
});
