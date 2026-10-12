// src/utils/httpClient.ts

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "";
const PROXY_URL = process.env.PROXY_URL || "";

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
}

async function rawFetch(url: string, options: FetchOptions = {}) {
  // 1. Try normal fetch first
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeout || 15000
    );

    const res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "application/json, text/html, */*",
        ...options.headers,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.ok) {
      return res;
    }
  } catch (err) {
    // fall through to FlareSolverr
  }

  // 2. Use FlareSolverr
  if (!FLARESOLVERR_URL) {
    throw new Error(
      `[httpClient] All bypass attempts failed for ${url} (no FLARESOLVERR_URL)`
    );
  }

  const flareRes = await fetch(FLARESOLVERR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cmd: "request.get",
      url,
      maxTimeout: 60000,
    }),
  });

  const data = await flareRes.json();

  if (data.status !== "ok" || !data.solution?.response) {
    throw new Error(
      `[httpClient] All bypass attempts failed for ${url} → ${
        data.message || "unknown error"
      }`
    );
  }

  // Create a fake Response-like object
  return {
    ok: true,
    status: data.solution.status || 200,
    text: async () => data.solution.response,
    json: async () => {
      try {
        return JSON.parse(data.solution.response);
      } catch {
        throw new Error("Response is not valid JSON");
      }
    },
    headers: {
      get: (name: string) =>
        data.solution.headers?.[name.toLowerCase()] || null,
    },
  };
}

/**
 * Fetch JSON (used by comickScraper + mangaDexScraper)
 */
export async function fetchJSON(url: string, options: FetchOptions = {}) {
  const res = await rawFetch(url, options);
  return await res.json();
}

/**
 * Fetch HTML (used by asura, weebCentral, novelFull scrapers)
 */
export async function fetchHTML(url: string, options: FetchOptions = {}) {
  const res = await rawFetch(url, options);
  return await res.text();
}

// Optional helpers (in case other files use them)
export async function httpGet(url: string, options: FetchOptions = {}) {
  const res = await rawFetch(url, options);
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await res.json();
  }
  return await res.text();
}

export async function httpGetJson(url: string, options: FetchOptions = {}) {
  return fetchJSON(url, options);
}
