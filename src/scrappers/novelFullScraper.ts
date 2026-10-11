import * as cheerio from "cheerio";
import { fetchHTML } from "../utils/httpClient";

export interface NovelSearchResult {
  title: string; slug: string; cover: string; latestChapter: string;
}
export interface NovelInfo {
  title: string; slug: string; cover: string; author: string;
  status: string; genres: string[]; description: string;
}
export interface ChapterListResult {
  chapters: { title: string; slug: string; date: string }[];
  page: number; totalPages: number;
}
export interface ChapterContent {
  title: string; content: string;
  prevChapter: string | null; nextChapter: string | null;
}

const BASE = "https://novelfull.net"; // site moved from .com to .net

export class NovelFullScraper {

  async search(query: string): Promise<NovelSearchResult[]> {
    const html = await fetchHTML(
      `${BASE}/search?keyword=${encodeURIComponent(query)}`,
      BASE
    );
    const $ = cheerio.load(html);
    const results: NovelSearchResult[] = [];

    // Try multiple selector patterns since the site restructures periodically
    const rows = $(".list-truyen .row, .truyen-list .row, .col-truyen-main .list-truyen li");

    rows.each((_i, el) => {
      // Pattern 1: anchor with truyen-title class
      let anchor = $(el).find("h3.truyen-title a, h3 a, .truyen-title a");
      if (!anchor.length) anchor = $(el).find("a[href*='/novel/'], a[href$='.html']").first();

      const title = anchor.text().trim();
      const href  = anchor.attr("href") ?? "";
      const slug  = href.replace(/^\//, "").replace(/\.html$/, "");
      const cover = $(el).find("img").attr("src") ?? $(el).find("img").attr("data-src") ?? "";
      const latest = $(el).find(".text-info a, .chapter a").first().text().trim();

      if (title && slug && !slug.startsWith("http")) {
        results.push({ title, slug, cover, latestChapter: latest });
      }
    });

    return results;
  }

  async fetchNovelInfo(slug: string): Promise<NovelInfo> {
    const html = await fetchHTML(`${BASE}/${slug}`, BASE);
    const $ = cheerio.load(html);

    const title  = $("h3.title, h1.title, .book h3, .title-detail").first().text().trim();
    const cover  = $(".book img, .cover img").attr("src") ?? "";
    const author = $('a[itemprop="author"], .info a[href*="author"]').first().text().trim();
    const status = $(".info .text-primary, .info span.label-success").first().text().trim();
    const genres: string[] = [];
    $('a[itemprop="genre"], .info a[href*="genre"]').each((_i, el) => {
      genres.push($(el).text().trim());
    });
    const description = $(".desc-text, .detail-content p, #tab-description").text().trim();

    return { title, slug, cover, author, status, genres, description };
  }

  async fetchChapterList(slug: string, page = 1): Promise<ChapterListResult> {
    const html = await fetchHTML(`${BASE}/${slug}?page=${page}`, BASE);
    const $ = cheerio.load(html);
    const chapters: { title: string; slug: string; date: string }[] = [];

    $(".list-chapter li a, .chapter-list li a, ul.list-chapter a").each((_i, el) => {
      const title       = $(el).text().trim();
      const href        = $(el).attr("href") ?? "";
      const chapterSlug = href.replace(/^\//, "").replace(/\.html$/, "");
      const date        = $(el).closest("li").find(".text-info, .date-chapters").text().trim();
      if (title && chapterSlug) { chapters.push({ title, slug: chapterSlug, date }); }
    });

    const totalPagesAttr = $(".pagination li:last-child a, .pagination a[data-page]").last().attr("data-page");
    const totalPages = totalPagesAttr ? parseInt(totalPagesAttr, 10) : 1;

    return { chapters, page, totalPages };
  }

  async fetchChapterContent(novelSlug: string, chapterSlug: string): Promise<ChapterContent> {
    const html = await fetchHTML(`${BASE}/${novelSlug}/${chapterSlug}`, BASE);
    const $ = cheerio.load(html);

    const title = $(".chapter-title, h2.chapter-title, #chapter-title").text().trim();
    $("#chapter-content .ads, #chapter-content script, #chapter-content ins").remove();
    const content = $("#chapter-content, .chapter-content").first().html() ?? "";

    const prevChapter =
      $("a#prev_chap, a[href*='prev'], .prev-chap a").attr("href")?.split("/").pop()?.replace(/\.html$/, "") ?? null;
    const nextChapter =
      $("a#next_chap, a[href*='next'], .next-chap a").attr("href")?.split("/").pop()?.replace(/\.html$/, "") ?? null;

    return { title, content, prevChapter, nextChapter };
  }
}
