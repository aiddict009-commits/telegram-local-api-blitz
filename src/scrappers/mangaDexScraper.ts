import { fetchJSON } from "../utils/httpClient";

const BASE       = "https://api.mangadex.org";
const COVER_BASE = "https://uploads.mangadex.org/covers";
const REFERER    = "https://mangadex.org/";
const ALL_RATINGS = ["safe", "suggestive", "erotica", "pornographic"];

export type ContentType = "manga" | "manhwa" | "manhua" | "unknown";

export interface MangaDexResult {
  id: string; title: string; contentType: ContentType;
  coverUrl: string; status: string; rating: string;
  genres: string[]; themes: string[]; description: string;
  year: number | null;
}
export interface MangaDexChapter {
  id: string; chapter: string | null; title: string | null;
  lang: string; publishedAt: string; scanlationGroup: string;
  pages: number; isExternal: boolean;
}

function langToType(lang?: string): ContentType {
  if (!lang) return "unknown";
  if (lang.startsWith("ja")) return "manga";
  if (lang.startsWith("ko")) return "manhwa";
  if (lang.startsWith("zh")) return "manhua";
  return "unknown";
}
function getTitle(a: any): string {
  const t = a?.title ?? {};
  return (t.en ?? t["ja-ro"] ?? t.ja ?? t["ko-ro"] ?? t.ko ?? Object.values(t)[0] ?? "Unknown") as string;
}
function getCoverUrl(mangaId: string, rels: any[]): string {
  const c = (rels ?? []).find((r: any) => r.type === "cover_art");
  const f = c?.attributes?.fileName;
  return f ? `${COVER_BASE}/${mangaId}/${f}.512.jpg` : "";
}
function getTags(a: any, group: string): string[] {
  return (a?.tags ?? []).filter((t: any) => t.attributes?.group === group)
    .map((t: any) => t.attributes?.name?.en ?? "").filter(Boolean);
}
function mapManga(item: any): MangaDexResult {
  const a = item.attributes ?? {};
  return {
    id: item.id, title: getTitle(a),
    contentType: langToType(a.originalLanguage),
    coverUrl: getCoverUrl(item.id, item.relationships ?? []),
    status: a.status ?? "unknown", rating: a.contentRating ?? "safe",
    genres: getTags(a, "genre"), themes: getTags(a, "theme"),
    description: a.description?.en ?? "", year: a.year ?? null,
  };
}

// ── KEY FIX: Build params manually without buildParams() helper ──────────────
// MangaDex requires:
//   contentRating[]=safe&contentRating[]=suggestive  (array params)
//   includeExternalUrl=1                             (plain param, NO brackets)
// Using URLSearchParams.append() directly avoids any accidental [] wrapping.
function buildChapterParams(opts: { lang: string; limit: number; offset: number }): string {
  const parts: string[] = [
    `limit=${opts.limit}`,
    `offset=${opts.offset}`,
    `order[chapter]=asc`,
    `includeExternalUrl=1`,
    ...ALL_RATINGS.map(r => `contentRating[]=${r}`),
    `translatedLanguage[]=${opts.lang}`,
    `includes[]=scanlation_group`,
  ];
  return parts.join("&");
}

function buildSearchParams(opts: {
  title?: string; limit: number; offset: number;
  langs?: string[]; order?: string;
}): string {
  const parts: string[] = [
    opts.title ? `title=${encodeURIComponent(opts.title)}` : "",
    `limit=${opts.limit}`,
    `offset=${opts.offset}`,
    opts.order ?? "order[relevance]=desc",
    ...ALL_RATINGS.map(r => `contentRating[]=${r}`),
    `includes[]=cover_art`,
    `includes[]=author`,
    ...(opts.langs ?? []).map(l => `originalLanguage[]=${l}`),
  ].filter(Boolean);
  return parts.join("&");
}

export class MangaDexScraper {

  async search(query: string, opts: { type?: ContentType; limit?: number; offset?: number } = {}): Promise<MangaDexResult[]> {
    const langMap: Record<string, string[]> = {
      manga: ["ja","ja-ro"], manhwa: ["ko","ko-ro"], manhua: ["zh","zh-hk"],
    };
    const qs = buildSearchParams({
      title: query, limit: opts.limit ?? 20, offset: opts.offset ?? 0,
      langs: opts.type ? langMap[opts.type] : [],
    });
    const data = await fetchJSON<any>(`${BASE}/manga?${qs}`, REFERER);
    return (data?.data ?? []).map(mapManga);
  }

  async fetchMangaInfo(id: string): Promise<MangaDexResult> {
    const data = await fetchJSON<any>(`${BASE}/manga/${id}?includes[]=cover_art&includes[]=author`, REFERER);
    return mapManga(data.data);
  }

  async fetchChapters(mangaId: string, opts: { lang?: string; limit?: number; offset?: number } = {}): Promise<{ chapters: MangaDexChapter[]; total: number }> {
    const qs = buildChapterParams({
      lang: opts.lang ?? "en",
      limit: opts.limit ?? 96,
      offset: opts.offset ?? 0,
    });
    const data = await fetchJSON<any>(`${BASE}/manga/${mangaId}/feed?${qs}`, REFERER);
    const chapters: MangaDexChapter[] = (data?.data ?? []).map((c: any) => {
      const group = (c.relationships ?? []).find((r: any) => r.type === "scanlation_group");
      const a = c.attributes ?? {};
      return {
        id: c.id, chapter: a.chapter ?? null, title: a.title ?? null,
        lang: a.translatedLanguage ?? "en", publishedAt: a.publishAt ?? "",
        scanlationGroup: group?.attributes?.name ?? "Unknown",
        pages: a.pages ?? 0, isExternal: !!a.externalUrl,
      };
    });
    return { chapters, total: data?.total ?? chapters.length };
  }

  async fetchChapterPages(chapterId: string): Promise<string[]> {
    const data = await fetchJSON<any>(`${BASE}/at-home/server/${chapterId}`, REFERER);
    const base = data?.baseUrl ?? "https://uploads.mangadex.org";
    const hash = data?.chapter?.hash ?? "";
    return (data?.chapter?.data ?? []).map((p: string) => `${base}/data/${hash}/${p}`);
  }

  async trending(opts: { type?: ContentType; limit?: number; offset?: number } = {}): Promise<MangaDexResult[]> {
    const langMap: Record<string, string[]> = { manga: ["ja"], manhwa: ["ko"], manhua: ["zh"] };
    const qs = buildSearchParams({
      limit: opts.limit ?? 20, offset: opts.offset ?? 0,
      order: "order[followedCount]=desc",
      langs: opts.type ? langMap[opts.type] : [],
    });
    const data = await fetchJSON<any>(`${BASE}/manga?${qs}`, REFERER);
    return (data?.data ?? []).map(mapManga);
  }
}
