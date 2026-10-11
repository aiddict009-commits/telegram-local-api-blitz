import * as cheerio from "cheerio";
import { fetchHTML } from "../utils/httpClient";

const BASE = "https://weebcentral.com";

export interface WCResult {
  id: string; title: string;
  contentType: "manga" | "manhwa" | "manhua" | "unknown";
  coverUrl: string; status: string; latestChapter: string;
}
export interface WCChapter { id: string; title: string; date: string; }

function parseType(raw: string): WCResult["contentType"] {
  const t = raw.toLowerCase();
  if (t.includes("manhwa")) return "manhwa";
  if (t.includes("manhua")) return "manhua";
  if (t.includes("manga"))  return "manga";
  return "unknown";
}

export class WeebCentralScraper {
  async search(query: string, page = 1): Promise<WCResult[]> {
    const url = `${BASE}/search?text=${encodeURIComponent(query)}&limit=20&offset=${(page - 1) * 20}&display_mode=Full+Display`;
    const html = await fetchHTML(url, BASE, true);
    const $ = cheerio.load(html);
    const results: WCResult[] = [];

    $("li, article").each((_i, el) => {
      const anchor  = $(el).find("a[href*='/series/']").first();
      const href    = anchor.attr("href") ?? "";
      if (!href.includes("/series/")) return;
      const id      = href.replace(BASE, "").replace(/^\//, "");
      const img     = $(el).find("img").first();
      const title   = img.attr("alt") ?? anchor.text().trim();
      const cover   = img.attr("src") ?? img.attr("data-src") ?? "";
      const status  = $(el).find("strong:contains('Status') + span, [class*='status']").text().trim();
      const latest  = $(el).find("a[href*='/chapters/']").first().text().trim();
      const typeRaw = $(el).find("strong:contains('Type') + span, [class*='type']").text().trim();
      if (id && title) results.push({
        id, title,
        contentType: parseType(typeRaw),
        coverUrl: cover,
        status,
        latestChapter: latest
      });
    });
    return results;
  }

  async fetchSeriesInfo(id: string): Promise<{
    title: string; contentType: WCResult["contentType"];
    coverUrl: string; status: string; genres: string[];
    description: string; authors: string[];
  }> {
    const html = await fetchHTML(`${BASE}/${id}`, BASE, true);
    const $ = cheerio.load(html);
    const title  = $("h1").first().text().trim();
    const cover  = $("img[alt]").first().attr("src") ?? "";
    const desc   = $("p").filter((_i, el) => $(el).text().length > 100).first().text().trim();
    const genres: string[] = [];
    const authors: string[] = [];
    let status = "";
    let typeRaw = "";

    $("li, .info-item").each((_i, el) => {
      const text = $(el).text().toLowerCase();
      const value = $(el).find("a, span:last-child").text().trim();
      if (text.includes("status"))  status = value;
      if (text.includes("type"))    typeRaw = value;
      if (text.includes("genre"))   genres.push(...$(el).find("a").map((_j, a) => $(a).text().trim()).get());
      if (text.includes("author"))  authors.push(value);
    });

    return {
      title,
      contentType: parseType(typeRaw),
      coverUrl: cover,
      status,
      genres: genres.filter(Boolean),
      description: desc,
      authors: authors.filter(Boolean)
    };
  }

  async fetchChapters(id: string): Promise<WCChapter[]> {
    const html = await fetchHTML(`${BASE}/${id}`, BASE, true);
    const $ = cheerio.load(html);
    const chapters: WCChapter[] = [];

    $("a[href*='/chapters/']").each((_i, el) => {
      const href  = $(el).attr("href") ?? "";
      const chId  = href.replace(BASE, "").replace(/^\//, "");
      const title = $(el).text().trim();
      const date  = $(el).closest("li, div").find("time, .date").text().trim();
      if (chId && title) chapters.push({ id: chId, title, date });
    });
    return chapters;
  }

  async fetchChapterPages(chapterId: string): Promise<string[]> {
    const html = await fetchHTML(`${BASE}/${chapterId}`, BASE, true);
    const $ = cheerio.load(html);
    const pages: string[] = [];

    $("img").each((_i, el) => {
      const src = $(el).attr("src") ?? $(el).attr("data-src") ?? "";
      if (src && (src.includes("cdn") || src.includes("image") || src.includes("chapter"))) {
        pages.push(src);
      }
    });
    return pages;
  }
}
