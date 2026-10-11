import * as cheerio from "cheerio";
import { fetchHTML } from "../utils/httpClient";

const BASE = "https://asuracomic.net";

export interface AsuraResult {
  slug: string; title: string;
  contentType: "manga" | "manhwa" | "manhua" | "unknown";
  coverUrl: string; status: string; latestChapter: string; rating: string;
}
export interface AsuraChapter { slug: string; number: string; title: string; date: string; }

function parseType(raw: string): AsuraResult["contentType"] {
  const t = raw.toLowerCase();
  if (t.includes("manhwa")) return "manhwa";
  if (t.includes("manhua")) return "manhua";
  if (t.includes("manga"))  return "manga";
  return "unknown";
}

export class AsuraScraper {
  async search(query: string): Promise<AsuraResult[]> {
    const html = await fetchHTML(`${BASE}/series?name=${encodeURIComponent(query)}`, BASE);
    const $ = cheerio.load(html);
    const results: AsuraResult[] = [];
    $("div.grid > a, .series-card").each((_i, el) => {
      const href  = $(el).attr("href") ?? "";
      const slug  = href.replace(BASE, "").replace(/^\//, "");
      const title = $(el).find("span, h3").first().text().trim() || ($(el).find("img").attr("alt") ?? "");
      const cover = $(el).find("img").attr("src") ?? "";
      const status  = $(el).find("[class*='status']").text().trim();
      const chapter = $(el).find("[class*='chapter']").text().trim();
      const rating  = $(el).find("[class*='rating']").text().trim();
      const typeEl  = $(el).find("[class*='type']").text().trim();
      if (slug && title) results.push({ slug, title, contentType: parseType(typeEl), coverUrl: cover, status, latestChapter: chapter, rating });
    });
    return results;
  }

  async fetchSeriesInfo(slug: string): Promise<{
    title: string; contentType: AsuraResult["contentType"];
    coverUrl: string; status: string; genres: string[];
    description: string; authors: string[]; rating: string;
  }> {
    const html = await fetchHTML(`${BASE}/${slug}`, BASE);
    const $ = cheerio.load(html);
    const title  = $("h1, .series-title").first().text().trim();
    const cover  = $(".series-thumb img, .thumb img").attr("src") ?? "";
    const desc   = $(".series-desc, .description").text().trim();
    const genres: string[] = []; const authors: string[] = [];
    let status = ""; let typeRaw = ""; let rating = "";
    $("[class*='info'] div, .series-info li, .info-item").each((_i, el) => {
      const text = $(el).text().trim(); const lower = text.toLowerCase();
      if (lower.includes("status:"))  { status  = text.split(":").slice(1).join(":").trim(); }
      if (lower.includes("type:"))    { typeRaw = text.split(":").slice(1).join(":").trim(); }
      if (lower.includes("author:"))  { authors.push(text.split(":").slice(1).join(":").trim()); }
      if (lower.includes("rating:"))  { rating  = text.split(":").slice(1).join(":").trim(); }
      if (lower.includes("genre") || lower.includes("tag")) {
        $(el).find("a, span.genre").each((_j, g) => { genres.push($(g).text().trim()); });
      }
    });
    return { title, contentType: parseType(typeRaw), coverUrl: cover, status, genres: genres.filter(Boolean), description: desc, authors: authors.filter(Boolean), rating };
  }

  async fetchChapters(slug: string): Promise<AsuraChapter[]> {
    const html = await fetchHTML(`${BASE}/${slug}`, BASE);
    const $ = cheerio.load(html);
    const chapters: AsuraChapter[] = [];
    $("div[class*='chapter'] a, li[class*='chapter'] a, .chapter-list a").each((_i, el) => {
      const href   = $(el).attr("href") ?? "";
      const chSlug = href.replace(BASE, "").replace(/^\//, "");
      const num    = $(el).find("[class*='chapter-number'], strong").text().trim() || ($(el).text().match(/chapter\s*([\d.]+)/i)?.[1] ?? "");
      const title  = $(el).text().trim();
      const date   = $(el).closest("li, div").find("time, .date").text().trim();
      if (chSlug) chapters.push({ slug: chSlug, number: num, title, date });
    });
    return chapters;
  }

  async fetchChapterPages(chapterSlug: string): Promise<string[]> {
    const html = await fetchHTML(`${BASE}/${chapterSlug}`, BASE);
    const $ = cheerio.load(html);
    const pages: string[] = [];
    $("img[src*='cdn'], img[src*='asura'], .reader img, #readerarea img").each((_i, el) => {
      const src = $(el).attr("src") ?? $(el).attr("data-src") ?? "";
      if (src) pages.push(src);
    });
    return pages;
  }
}
