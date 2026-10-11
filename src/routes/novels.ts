import { Router, Request, Response } from "express";
import { NovelFullScraper } from "../scrapers/novelFullScraper";
import { asyncWrapper } from "../utils/asyncWrapper";

export const novelRouter = Router();
const scraper = new NovelFullScraper();

// ─── GET /api/novels/search?q= ────────────────────────────────────────────────
novelRouter.get(
  "/search",
  asyncWrapper(async (req: Request, res: Response) => {
    const query = String(req.query.q ?? "").trim();
    if (!query) {
      return res.status(400).json({ error: "Query parameter 'q' is required." });
    }
    const results = await scraper.search(query);
    res.json(results);
  })
);

// ─── GET /api/novels/:slug ────────────────────────────────────────────────────
novelRouter.get(
  "/:slug",
  asyncWrapper(async (req: Request, res: Response) => {
    const info = await scraper.fetchNovelInfo(req.params.slug);
    res.json(info);
  })
);

// ─── GET /api/novels/:slug/chapters ──────────────────────────────────────────
novelRouter.get(
  "/:slug/chapters",
  asyncWrapper(async (req: Request, res: Response) => {
    const page = Number(req.query.page ?? 1);
    const chapters = await scraper.fetchChapterList(req.params.slug, page);
    res.json(chapters);
  })
);

// ─── GET /api/novels/:slug/chapters/:chapterSlug ─────────────────────────────
novelRouter.get(
  "/:slug/chapters/:chapterSlug",
  asyncWrapper(async (req: Request, res: Response) => {
    const content = await scraper.fetchChapterContent(
      req.params.slug,
      req.params.chapterSlug
    );
    res.json(content);
  })
);
