import { fetchJSON } from "../utils/httpClient";

const BASE = "https://api.comick.io";

export type ContentType = "manga" | "manhwa" | "manhua" | "unknown";

export interface ComicSearchResult {
  hid: string; slug: string; title: string;
  contentType: ContentType; coverUrl: string;
  rating: string; genres: string[];
  status: number; lastChapter: number | null; followCount: number;
}

export interface ComicInfo extends ComicSearchResult {
  description: string; authors: string[];
  artists: string[]; year: number | null;
  totalChapters: number;
}

export interface ComicChapter {
  hid: string; chap: string; title: string | null;
  lang: string; publishedAt: string; groupName: string[];
}

export interface ChapterPage {
  url: string; width: number; height: number;
}

function countryToType(country?: string): ContentType {
  switch (country) {
    case "jp": return "manga";
    case "kr": return "manhwa";
    case "zh": case "zh-hk": return "manhua";
    default:   return "unknown";
  }
}

function mapHit(hit: any): ComicSearchResult {
  const md = hit.md_covers?.[0];
  const cover = md?.b2key ? `https://meo.comick.pictures/${md.b2key}` : "";
  return {
    hid:         hit.hid ?? hit.id ?? "",
    slug:        hit.slug ?? "",
    title:       hit.title ?? hit.slug ?? "",
    contentType: countryToType(hit.country),
    coverUrl:    cover,
    rating:      hit.content_rating ?? "safe",
    genres:      (hit.md_comic_md_genres ?? []).map((g: any) => g.md_genres?.name ?? ""),
    status:      hit.status ?? 1,
    lastChapter: hit.last_chapter ?? null,
    followCount: hit.follow_count ?? 0,
  };
}

// ComicK API headers — these must look like a real browser hitting their site
// tachiyomi=true was previously used but CF started flagging it
const COMICK_HEADERS = {
  Origin:  "https://comick.io",
  Referer: "https://comick.io/",
};

export class ComickScraper {

  async search(
    query: string,
    opts: { type?: ContentType; limit?: number; page?: number } = {}
  ): Promise<ComicSearchResult[]> {
    const params = new URLSearchParams({
      q:     query,
      limit: String(opts.limit ?? 20),
      page:  String(opts.page  ?? 1),
      // removed tachiyomi=true — ComicK's CF now flags this param
    });

    const countryMap: Record<string, string> = {
      manga: "jp", manhwa: "kr", manhua: "zh",
    };
    if (opts.type && opts.type !== "unknown") {
      params.set("country", countryMap[opts.type] ?? "");
    }

    const data = await fetchJSON<any[]>(
      `${BASE}/v1.0/search?${params}`,
      COMICK_HEADERS.Referer,
      true // Cloudflare protected — uses proxy/FlareSolverr fallback
    );
    return (data ?? []).map(mapHit);
  }

  async trending(type?: ContentType, page = 1): Promise<ComicSearchResult[]> {
    const params = new URLSearchParams({
      page:  String(page),
      order: "follow",
    });
    const countryMap: Record<string, string> = {
      manga: "jp", manhwa: "kr", manhua: "zh",
    };
    if (type && type !== "unknown") {
      params.set("country", countryMap[type] ?? "");
    }
    const data = await fetchJSON<any[]>(
      `${BASE}/v1.0/comic?${params}`,
      COMICK_HEADERS.Referer,
      true // Cloudflare protected — uses proxy/FlareSolverr fallback
    );
    return (data ?? []).map(mapHit);
  }

  async fetchComicInfo(slug: string): Promise<ComicInfo> {
    const data = await fetchJSON<any>(
      `${BASE}/comic/${slug}`,
      COMICK_HEADERS.Referer,
      true // Cloudflare protected — uses proxy/FlareSolverr fallback
    );
    const comic = data?.comic ?? data;
    const base  = mapHit(comic);
    return {
      ...base,
      description:   comic.desc ?? "",
      authors:       (comic.author ?? []).map((a: any) => a.name ?? a),
      artists:       (comic.artist ?? []).map((a: any) => a.name ?? a),
      year:          comic.year ?? null,
      totalChapters: comic.chapter_count ?? 0,
    };
  }

  async fetchChapters(
    hid: string,
    opts: { page?: number; lang?: string; limit?: number } = {}
  ): Promise<{ chapters: ComicChapter[]; total: number }> {
    const params = new URLSearchParams({
      page:  String(opts.page  ?? 1),
      limit: String(opts.limit ?? 60),
      lang:  opts.lang ?? "en",
    });
    const data = await fetchJSON<any>(
      `${BASE}/comic/${hid}/chapters?${params}`,
      COMICK_HEADERS.Referer,
      true // Cloudflare protected — uses proxy/FlareSolverr fallback
    );
    const chapters: ComicChapter[] = (data?.chapters ?? []).map((c: any) => ({
      hid:         c.hid,
      chap:        c.chap ?? "0",
      title:       c.title ?? null,
      lang:        c.lang  ?? "en",
      publishedAt: c.created_at ?? "",
      groupName:   c.group_name ?? [],
    }));
    return { chapters, total: data?.total ?? chapters.length };
  }

  async fetchChapterPages(chapterHid: string): Promise<ChapterPage[]> {
    const data = await fetchJSON<any>(
      `${BASE}/chapter/${chapterHid}?tachiyomi=true`,
      COMICK_HEADERS.Referer,
      true
    );
    // Handle both response shapes ComicK returns
    const images = data?.chapter?.md_images ?? data?.md_images ?? [];
    return images
      .filter((img: any) => img?.b2key)
      .map((img: any) => ({
        url:    `https://meo.comick.pictures/${img.b2key}`,
        width:  img.w ?? 0,
        height: img.h ?? 0,
      }));
  }
}
