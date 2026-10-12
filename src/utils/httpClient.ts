// src/utils/httpClient.ts  (or wherever your current httpClient is)

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "";
const PROXY_URL = process.env.PROXY_URL || "";

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
}

export async function httpGet(url: string, options: FetchOptions = {}) {
  // 1. Try normal fetch first (fast path)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);

    const res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        ...options.headers,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.ok) {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return await res.json();
      }
      return await res.text();
    }
  } catch (err) {
    // Normal fetch failed → go to FlareSolverr
  }

  // 2. Use FlareSolverr if available
  if (FLARESOLVERR_URL) {
    try {
      const flareRes = await fetch(FLARESOLVERR_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cmd: "request.get",
          url: url,
          maxTimeout: 60000,
        }),
      });

      const data = await flareRes.json();

      if (data.status === "ok" && data.solution?.response) {
        const responseText = data.solution.response;

        // Try to parse as JSON if possible
        try {
          return JSON.parse(responseText);
        } catch {
          return responseText;
        }
      }

      throw new Error(data.message || "FlareSolverr returned non-ok status");
    } catch (err: any) {
      throw new Error(
        `[httpClient] All bypass attempts failed for ${url} → ${err.message}`
      );
    }
  }

  throw new Error(`[httpClient] All bypass attempts failed for ${url}`);
}

// Optional helper
export async function httpGetJson(url: string, options: FetchOptions = {}) {
  const result = await httpGet(url, options);
  if (typeof result === "string") {
    return JSON.parse(result);
  }
  return result;
}
