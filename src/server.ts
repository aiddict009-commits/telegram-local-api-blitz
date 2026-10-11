/**
 * server.ts - Complete self-contained manga/novel API
 * All chapter fetching logic is inline here - no separate scraper files needed
 * for the core MangaDex functionality.
 */

import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { gotScraping } from "got-scraping";

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin ?? "";
  const allowed =
    /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
    /^https:\/\/[^.]+\.lovable\.app$/.test(origin) ||
    /^https:\/\/[^.]+\.lovableproject\.com$/.test(origin) ||
    /^https:\/\/lovable\.dev$/.test(origin) ||
    /^https:\/\/arcaneread\.lovable\.app$/.test(origin) ||
    (process.env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).includes(origin);

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
});

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// ── Shared fetch with browser fingerprint ────────────────────────────────────
const OPTS = {
  headerGeneratorOptions: {
    browsers: [{ name: "chrome" as const, minVersion: 120 }],
    operatingSystems: ["windows" as const],
  },
  retry: { limit: 2 },
  timeout: { request: 20_000 },
};

async function fetchJSON<T>(url: string, referer = "https://mangadex.org/"): Promise<T> {
  const res = await gotScraping({ url, ...OPTS, headers: {
    Accept: "application/json",
    Referer: referer,
    Origin: new URL(referer).origin,
  }});
  if (res.statusCode !== 200) throw new Error(`${res.statusCode} from ${url}`);
  return JSON.parse(res.body) as T;
}

// ── MangaDex constants ────────────────────────────────────────────────────────
const MD = "https://api.mangadex.org";
const COVER = "https://uploads.mangadex.org/covers";
const RATINGS = ["safe","suggestive","erotica","pornographic"];

function mdParams(base: Record<string,string>, arrays: Record<string,string[]> = {}): string {
  const p = new URLSearchParams(base);
  for (const [k,vs] of Object.entries(arrays)) vs.forEach(v => p.append(`${k}[]`, v));
  return p.toString();
}

function mapManga(item: any) {
  const a = item.attributes ?? {};
  const t = a.title ?? {};
  const title = t.en ?? t["ja-ro"] ?? t.ja ?? t["ko-ro"] ?? t.ko ?? Object.values(t)[0] ?? "Unknown";
  const cover = (() => {
    const c = (item.relationships ?? []).find((r:any) => r.type === "cover_art");
    const f = c?.attributes?.fileName;
    return f ? `${COVER}/${item.id}/${f}.512.jpg` : "";
  })();
  const lang = a.originalLanguage ?? "";
  const contentType = lang.startsWith("ja") ? "manga" : lang.startsWith("ko") ? "manhwa" : lang.startsWith("zh") ? "manhua" : "unknown";
  return {
    id: item.id, title, contentType, coverUrl: cover,
    status: a.status ?? "unknown", rating: a.contentRating ?? "safe",
    genres: (a.tags??[]).filter((t:any)=>t.attributes?.group==="genre").map((t:any)=>t.attributes?.name?.en??""),
    description: a.description?.en ?? "", year: a.year ?? null,
  };
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), sources: ["mangadex","comick","novelfull"] });
});

// ── Sources ───────────────────────────────────────────────────────────────────
app.get("/api/manga/sources", (_req, res) => {
  res.json({ sources: [
    { id: "mangadex", name: "MangaDex", types: ["manga","manhwa","manhua"] },
    { id: "comick",   name: "ComicK",   types: ["manga","manhwa","manhua"] },
  ]});
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get("/api/manga/search", async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.status(400).json({ error: "'q' required" });
    const limit  = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = (Math.max(Number(req.query.page ?? 1), 1) - 1) * limit;
    const type   = String(req.query.type ?? "");
    const langMap: Record<string,string[]> = { manga:["ja","ja-ro"], manhwa:["ko","ko-ro"], manhua:["zh","zh-hk"] };

    const qs = mdParams({ title: q, limit: String(limit), offset: String(offset), "order[relevance]": "desc" }, {
      includes: ["cover_art","author"], contentRating: RATINGS,
      ...(langMap[type] ? { originalLanguage: langMap[type] } : {}),
    });
    const data = await fetchJSON<any>(`${MD}/manga?${qs}`);
    res.json({ source: "mangadex", query: q, results: (data.data ?? []).map(mapManga) });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// ── Trending ──────────────────────────────────────────────────────────────────
app.get("/api/manga/trending", async (req: Request, res: Response) => {
  try {
    const limit  = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = (Math.max(Number(req.query.page ?? 1), 1) - 1) * limit;
    const type   = String(req.query.type ?? "");
    const langMap: Record<string,string[]> = { manga:["ja"], manhwa:["ko"], manhua:["zh"] };

    const qs = mdParams({ limit: String(limit), offset: String(offset), "order[followedCount]": "desc" }, {
      includes: ["cover_art"], contentRating: RATINGS,
      ...(langMap[type] ? { originalLanguage: langMap[type] } : {}),
    });
    const data = await fetchJSON<any>(`${MD}/manga?${qs}`);
    res.json({ source: "mangadex", results: (data.data ?? []).map(mapManga) });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// ── Manga info ────────────────────────────────────────────────────────────────
app.get("/api/manga/:id", async (req: Request, res: Response) => {
  try {
    const qs = mdParams({}, { includes: ["cover_art","author","artist"] });
    const data = await fetchJSON<any>(`${MD}/manga/${req.params.id}?${qs}`);
    res.json({ source: "mangadex", ...mapManga(data.data) });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// ── Chapters — aggregated from MangaDex + ComicK ──────────────────────────────
app.get("/api/manga/:id/chapters", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const lang   = String(req.query.lang ?? "en");
    const title  = String(req.query.title ?? "");
    const limit  = Math.min(Number(req.query.limit ?? 96), 500);
    const page   = Math.max(Number(req.query.page ?? 1), 1);

    // Fetch from MangaDex — all ratings, no external
    const mdChapters: any[] = [];
    let offset = 0;
    while (true) {
      const qs = [
        `limit=96`, `offset=${offset}`, `order[chapter]=asc`,
        `includeExternalUrl=1`,
        ...RATINGS.map(r => `contentRating[]=${r}`),
        `translatedLanguage[]=${lang}`,
        `includes[]=scanlation_group`,
      ].join("&");
      const data = await fetchJSON<any>(`${MD}/manga/${id}/feed?${qs}`).catch(() => null);
      if (!data?.data?.length) break;
      for (const c of data.data) {
        if (c.attributes?.externalUrl) continue;
        const group = (c.relationships ?? []).find((r:any) => r.type === "scanlation_group");
        mdChapters.push({
          id: c.id, number: c.attributes?.chapter ?? "", title: c.attributes?.title ?? null,
          source: "mangadex", lang: c.attributes?.translatedLanguage ?? lang,
          publishedAt: c.attributes?.publishAt ?? "", group: group?.attributes?.name ?? "Unknown",
          pages: c.attributes?.pages ?? 0, isExternal: false,
        });
      }
      offset += 96;
      if (offset >= (data.total ?? 0)) break;
    }

    // Fetch from ComicK if MangaDex returned few/no chapters
    const ckChapters: any[] = [];
    if (mdChapters.length < 5 && title) {
      try {
        const search = await fetchJSON<any[]>(
          `https://api.comick.io/v1.0/search?q=${encodeURIComponent(title)}&limit=5`,
          "https://comick.io/"
        );
        const hid = (Array.isArray(search) ? search : [])[0]?.hid;
        if (hid) {
          for (let p = 1; p <= 10; p++) {
            const batch = await fetchJSON<any>(
              `https://api.comick.io/comic/${hid}/chapters?page=${p}&limit=100&lang=${lang}`,
              "https://comick.io/"
            ).catch(() => null);
            if (!batch?.chapters?.length) break;
            for (const c of batch.chapters) {
              ckChapters.push({
                id: c.hid, number: c.chap ?? "", title: c.title ?? null,
                source: "comick", lang: c.lang ?? lang,
                publishedAt: c.created_at ?? "", group: (c.group_name ?? []).join(", ") || "Unknown",
                pages: 0, isExternal: false,
              });
            }
          }
        }
      } catch { /* ComicK failed, use MD only */ }
    }

    // Merge & deduplicate by chapter number
    const seen = new Map<string, any>();
    for (const c of ckChapters) seen.set(c.number || c.id, c);
    for (const c of mdChapters) seen.set(c.number || c.id, c); // MD overwrites CK

    const merged = Array.from(seen.values()).sort((a, b) => {
      const na = parseFloat(a.number) || -1;
      const nb = parseFloat(b.number) || -1;
      return na === -1 && nb === -1 ? 0 : na === -1 ? 1 : nb === -1 ? -1 : na - nb;
    });

    // Auto-number unnumbered chapters
    let seq = 0;
    for (const c of merged) { if (!c.number || c.number === "0") c.number = String(++seq); }

    const start = (page - 1) * limit;
    res.json({
      source: "aggregated",
      sources: [...new Set([...mdChapters.length?"mangadex":"", ...ckChapters.length?"comick":""].filter(Boolean))],
      chapters: merged.slice(start, start + limit),
      total: merged.length, page,
    });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// ── Chapter pages ─────────────────────────────────────────────────────────────
app.get("/api/manga/:id/chapters/:chapterId/pages", async (req: Request, res: Response) => {
  try {
    const { chapterId } = req.params;
    const chSrc = String(req.query.chapterSource ?? "mangadex");

    if (chSrc === "comick") {
      const data = await fetchJSON<any>(
        `https://api.comick.io/chapter/${chapterId}?tachiyomi=true`,
        "https://comick.io/"
      );
      const imgs = data?.chapter?.md_images ?? data?.md_images ?? [];
      return res.json({ source: "comick", pages: imgs.filter((i:any)=>i?.b2key).map((i:any) => ({
        url: `https://meo.comick.pictures/${i.b2key}`, width: i.w ?? 0, height: i.h ?? 0,
      }))});
    }

    // MangaDex
    const data = await fetchJSON<any>(`${MD}/at-home/server/${chapterId}`);
    const base = data?.baseUrl ?? "https://uploads.mangadex.org";
    const hash = data?.chapter?.hash ?? "";
    res.json({ source: "mangadex", pages: (data?.chapter?.data ?? []).map((p:string) => ({
      url: `${base}/data/${hash}/${p}`, width: 0, height: 0,
    }))});
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// ── Image proxy ───────────────────────────────────────────────────────────────
const ALLOWED_DOMAINS = [
  "meo.comick.pictures","meo2.comick.pictures","uploads.mangadex.org",
  "cdn.weebcentral.com","gg.asuracomic.net","asuracomic.net","novelfull.net",
];
const REFERER_MAP: Record<string,string> = {
  "meo.comick.pictures": "https://comick.io/",
  "meo2.comick.pictures": "https://comick.io/",
  "uploads.mangadex.org": "https://mangadex.org/",
};

app.get("/api/proxy/image", async (req: Request, res: Response) => {
  try {
    const rawUrl = String(req.query.url ?? "").trim();
    if (!rawUrl) return res.status(400).json({ error: "url required" });
    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch { return res.status(400).json({ error: "invalid url" }); }
    if (!ALLOWED_DOMAINS.some(d => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`))) {
      return res.status(403).json({ error: `domain not allowed: ${parsed.hostname}` });
    }
    const referer = REFERER_MAP[parsed.hostname] ?? `${parsed.protocol}//${parsed.hostname}/`;
    const resp = await gotScraping({ url: rawUrl, responseType: "buffer" as const, ...OPTS,
      headers: { Referer: referer, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    });
    if (resp.statusCode !== 200) return res.status(502).json({ error: `upstream ${resp.statusCode}` });
    res.setHeader("Content-Type", resp.headers["content-type"] ?? "image/jpeg");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.end(resp.body);
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// ── Novel search (NovelFull) ──────────────────────────────────────────────────
app.get("/api/novels/search", async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.status(400).json({ error: "q required" });
    const html = await gotScraping({ url: `https://novelfull.net/search?keyword=${encodeURIComponent(q)}`, ...OPTS,
      headers: { Referer: "https://novelfull.net/" }
    });
    const { load } = await import("cheerio");
    const $ = load(html.body);
    const results: any[] = [];
    $(".list-truyen .row, .truyen-list li").each((_: any, el: any) => {
      const a = $(el).find("h3 a, .truyen-title a").first();
      const title = a.text().trim();
      const href  = a.attr("href") ?? "";
      const slug  = href.replace(/^\//, "").replace(/\.html$/, "");
      const cover = $(el).find("img").attr("src") ?? "";
      if (title && slug) results.push({ title, slug, cover, latestChapter: "" });
    });
    res.json(results);
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// ── 404 & error ───────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err?.message ?? "Server error" });
});

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`🚀 Server → http://localhost:${PORT}`);
  console.log(`✅ All logic self-contained in server.ts`);
});

export default app;
