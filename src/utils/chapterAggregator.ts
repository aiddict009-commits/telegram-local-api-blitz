/**
 * chapterAggregator.ts
 * Fetches chapters from MangaDex + ComicK simultaneously and merges them.
 * Handles licensed titles (0 on MangaDex) by falling back to ComicK.
 * Handles title mismatches by trying multiple title variants.
 */

import { MangaDexScraper } from "../scrapers/mangaDexScraper";
import { ComickScraper }   from "../scrapers/comickScraper";

const mangadex = new MangaDexScraper();
const comick   = new ComickScraper();

export interface UnifiedChapter {
  id:          string;
  number:      string;
  title:       string | null;
  source:      string;
  lang:        string;
  publishedAt: string;
  group:       string;
  pages:       number;
  isExternal:  boolean;
}

function parseNum(s: string | null | undefined): number {
  if (!s || s === "0") return -1;
  const n = parseFloat(s);
  return isNaN(n) ? -1 : n;
}

// ── Generate title variants to maximise ComicK hit rate ───────────────────────
// MangaDex often returns the native title (Korean/Japanese/Chinese).
// ComicK uses English titles. We try all variants until one returns results.
function titleVariants(title: string, altTitles: string[] = []): string[] {
  const variants = new Set<string>();

  // Always try the given titles first
  variants.add(title);
  altTitles.forEach(t => variants.add(t));

  // Strip common suffixes that differ between sources
  // e.g. "Na Honjaman Level-Up" → "Level Up", "Solo Leveling"
  const clean = title
    .replace(/na honjaman/gi, "")        // Korean "only I"
    .replace(/\(.*?\)/g, "")             // remove parentheticals
    .replace(/[^\w\s]/g, " ")            // remove special chars
    .replace(/\s+/g, " ")
    .trim();
  if (clean && clean !== title) variants.add(clean);

  // First 3 meaningful words as a short search
  const words = title.split(/\s+/).filter(w => w.length > 2);
  if (words.length >= 2) variants.add(words.slice(0, 3).join(" "));

  return Array.from(variants).filter(Boolean);
}

// ── Search ComicK with multiple title attempts ────────────────────────────────
async function findComicKHid(
  title: string,
  altTitles: string[]
): Promise<string | null> {
  const variants = titleVariants(title, altTitles);

  for (const variant of variants) {
    try {
      const results = await comick.search(variant, { limit: 5 });
      if (results.length > 0) {
        console.info(`[aggregator] ComicK found via variant: "${variant}"`);
        return results[0].hid;
      }
    } catch {
      // continue to next variant
    }
  }
  console.warn(`[aggregator] ComicK: no results for any title variant of "${title}"`);
  return null;
}

// ── Fetch from MangaDex (skip external/licensed chapters) ─────────────────────
async function fromMangaDex(mangaId: string, lang: string): Promise<UnifiedChapter[]> {
  try {
    const chapters: UnifiedChapter[] = [];
    let offset = 0;
    const limit = 96;

    while (true) {
      const { chapters: batch, total } = await mangadex.fetchChapters(mangaId, { lang, limit, offset });
      for (const c of batch) {
        if (c.isExternal) continue; // skip Manga Plus / external — no images
        chapters.push({
          id:          c.id,
          number:      c.chapter ?? "",
          title:       c.title,
          source:      "mangadex",
          lang:        c.lang,
          publishedAt: c.publishedAt,
          group:       c.scanlationGroup,
          pages:       c.pages,
          isExternal:  false,
        });
      }
      offset += limit;
      if (!batch.length || offset >= total) break;
    }
    return chapters;
  } catch (e) {
    console.warn(`[aggregator] MangaDex chapters failed: ${(e as Error).message}`);
    return [];
  }
}

// ── Fetch from ComicK ─────────────────────────────────────────────────────────
async function fromComicK(
  title: string,
  altTitles: string[],
  lang: string
): Promise<UnifiedChapter[]> {
  try {
    const hid = await findComicKHid(title, altTitles);
    if (!hid) return [];

    const chapters: UnifiedChapter[] = [];
    for (let page = 1; page <= 15; page++) {
      const { chapters: batch } = await comick.fetchChapters(hid, { page, lang, limit: 100 });
      if (!batch.length) break;
      for (const c of batch) {
        chapters.push({
          id:          c.hid,
          number:      c.chap ?? "",
          title:       c.title,
          source:      "comick",
          lang:        c.lang,
          publishedAt: c.publishedAt,
          group:       c.groupName.join(", ") || "Unknown",
          pages:       0,
          isExternal:  false,
        });
      }
    }
    console.info(`[aggregator] ComicK returned ${chapters.length} chapters`);
    return chapters;
  } catch (e) {
    console.warn(`[aggregator] ComicK chapters failed: ${(e as Error).message}`);
    return [];
  }
}

// ── Main aggregator ───────────────────────────────────────────────────────────
export async function aggregateChapters(opts: {
  mangadexId: string;
  title:      string;
  altTitles?: string[]; // pass English alt titles from MangaDex info
  lang?:      string;
}): Promise<{ chapters: UnifiedChapter[]; total: number; sources: string[] }> {
  const lang      = opts.lang ?? "en";
  const altTitles = opts.altTitles ?? [];

  const [mdChapters, ckChapters] = await Promise.all([
    fromMangaDex(opts.mangadexId, lang),
    fromComicK(opts.title, altTitles, lang),
  ]);

  const sources: string[] = [];
  if (mdChapters.length) sources.push("mangadex");
  if (ckChapters.length) sources.push("comick");

  // Merge: ComicK first, MangaDex overwrites (higher quality)
  const seen = new Map<string, UnifiedChapter>();
  for (const c of ckChapters) {
    const key = c.number || c.id;
    seen.set(key, c);
  }
  for (const c of mdChapters) {
    const key = c.number || c.id;
    seen.set(key, c);
  }

  // Sort ascending by chapter number
  const merged = Array.from(seen.values()).sort((a, b) => {
    const na = parseNum(a.number);
    const nb = parseNum(b.number);
    if (na === -1 && nb === -1) return 0;
    if (na === -1) return 1;
    if (nb === -1) return -1;
    return na - nb;
  });

  // Auto-number any chapters still missing a number
  let seq = 0;
  for (const c of merged) {
    if (!c.number || c.number === "0") {
      seq++;
      c.number = `${seq}`;
    }
  }

  return { chapters: merged, total: merged.length, sources };
}
