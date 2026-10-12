/**
 * server.ts - mounts the modular routers (manga, novels, image proxy).
 * Replaces the old self-contained version, which ignored ?source= and
 * never used the scrapers, aggregator, proxy or FlareSolverr code.
 */
import "dotenv/config";
import express, { Request, Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { corsMiddleware } from "./middleware/corsMiddleware";
import { errorHandler } from "./middleware/errorHandler";
import { mangaRouter } from "./routes/manga";
import { novelRouter } from "./routes/novels";
import { proxyRouter } from "./proxy/imageProxy";

const app = express();

// Hosts put the API behind a proxy; this lets rate limiting see the real client IP
app.set("trust proxy", 1);

app.use(corsMiddleware);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    sources: ["mangadex", "comick", "weebcentral", "asura", "novelfull"],
    proxy: Boolean(process.env.PROXY_URL),
    flaresolverr: Boolean(process.env.FLARESOLVERR_URL),
  });
});

// ── Routers ───────────────────────────────────────────────────────────────────
app.use("/api/manga", mangaRouter);
app.use("/api/novels", novelRouter);
app.use("/api/proxy", proxyRouter);

// ── 404 & error handling ──────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Route not found" });
});
app.use(errorHandler);

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`🚀 Server → http://localhost:${PORT}`);
});

export default app;
