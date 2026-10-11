import { Router, Request, Response } from "express";
import { gotScraping } from "got-scraping";
import { asyncWrapper } from "../utils/asyncWrapper";

export const proxyRouter = Router();

const ALLOWED_IMAGE_DOMAINS = [
  "meo.comick.pictures", "meo2.comick.pictures",
  "uploads.mangadex.org", "cdn.weebcentral.com",
  "gg.asuracomic.net", "asuracomic.net",
  "novelfull.com", "img.novelfull.com",
];

const REFERER_MAP: Record<string, string> = {
  "meo.comick.pictures":  "https://comick.io/",
  "meo2.comick.pictures": "https://comick.io/",
  "uploads.mangadex.org": "https://mangadex.org/",
  "cdn.weebcentral.com":  "https://weebcentral.com/",
  "gg.asuracomic.net":    "https://asuracomic.net/",
};

proxyRouter.get("/image", asyncWrapper(async (req: Request, res: Response) => {
  const rawUrl = String(req.query.url ?? "").trim();
  if (!rawUrl) return res.status(400).json({ error: "'url' query param required." });

  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return res.status(400).json({ error: "Invalid URL." }); }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "Only http/https URLs allowed." });
  }

  const domainAllowed = ALLOWED_IMAGE_DOMAINS.some(
    d => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`)
  );
  if (!domainAllowed) {
    return res.status(403).json({ error: `Domain '${parsed.hostname}' not in allow-list.` });
  }

  const referer = REFERER_MAP[parsed.hostname] ?? `${parsed.protocol}//${parsed.hostname}/`;

  const response = await gotScraping({
    url: rawUrl,
    responseType: "buffer" as const,
    headerGeneratorOptions: {
      browsers: [{ name: "chrome" as const, minVersion: 112 }],
      operatingSystems: ["windows" as const],
    },
    headers: { Referer: referer, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    retry: { limit: 2 },
    timeout: { request: 15_000 },
  });

  if (response.statusCode !== 200) {
    return res.status(502).json({ error: `Upstream returned ${response.statusCode}` });
  }

  res.setHeader("Content-Type", response.headers["content-type"] ?? "image/jpeg");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.end(response.body);
}));
