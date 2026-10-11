/**
 * httpClient.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLOUDFLARE BYPASS ARCHITECTURE
 * ────────────────────────────────────
 *
 * Cloudflare has TWO protection layers:
 *
 *   Layer 1 — Passive TLS fingerprinting
 *     CF checks the TLS cipher suites / HTTP2 SETTINGS your client sends.
 *     Node's built-in fetch/axios look like bots. got-scraping patches this
 *     by emitting Chrome's exact TLS fingerprint. ✓ Bypassed.
 *
 *   Layer 2 — Active JS challenge (Turnstile / IUAM)
 *     CF serves a JS page that runs a CPU challenge in the browser.
 *     It then checks: does this IP look like a datacenter?
 *     Railway = AWS datacenter IP → CF always triggers the JS challenge.
 *     got-scraping CANNOT bypass this because there is no real browser. ✗
 *
 * THE FIX — Three-layer fallback:
 *
 *   Attempt 1: got-scraping direct (works for MangaDex + non-CF sites)
 *   Attempt 2: got-scraping through residential proxy (bypasses datacenter flag)
 *   Attempt 3: FlareSolverr (headless Chrome, solves JS challenge completely)
 *
 * SETUP OPTIONS (set in Railway environment variables):
 *
 *   Option A — Residential proxy (cheapest, fastest):
 *     Get free proxies at webshare.io (10 free rotating residential proxies)
 *     Set: PROXY_URL=http://username:password@proxy.webshare.io:80
 *
 *   Option B — FlareSolverr (most powerful):
 *     Add a new Railway service using Docker image:
 *       ghcr.io/flaresolverr/flaresolverr:latest
 *     Set: FLARESOLVERR_URL=http://your-flaresolverr-service.railway.internal:8191
 *
 *   Both can be set simultaneously — proxy is tried first (faster),
 *   FlareSolverr is the last resort.
 *
 * WHICH SOURCES NEED BYPASS:
 *   MangaDex        → NO  (public API, no CF bot protection)
 *   ComicK          → YES (CF on datacenter IPs)
 *   WeebCentral     → YES (CF Turnstile)
 *   AsuraScans      → YES (CF Turnstile)
 *   NovelFull       → YES (CF on datacenter IPs)
 */

import { gotScraping } from "got-scraping";

// ─── Base browser impersonation options ───────────────────────────────────────
const BROWSER_OPTS = {
  headerGeneratorOptions: {
    browsers: [{ name: "chrome" as const, minVersion: 120 }],
    operatingSystems: ["windows" as const],
    locales: ["en-US", "en"],
  },
  retry: { limit: 2 },
  timeout: { request: 25_000 },
  followRedirect: true,
};

// ─── Environment config ───────────────────────────────────────────────────────
const PROXY_URL        = process.env.PROXY_URL;         // residential proxy
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL;  // FlareSolverr instance

// ─── Detect Cloudflare challenge pages ───────────────────────────────────────
function isCFBlocked(statusCode: number, body: string): boolean {
  if (statusCode === 403) return true;
  if (statusCode === 503 && body.includes("cloudflare")) return true;
  // CF Turnstile/IUAM challenge page detection
  if (body.includes("challenge-platform") || body.includes("cf-challenge")) return true;
  if (body.includes("cf_clearance") && body.includes("<title>Just a moment")) return true;
  return false;
}

// ─── Attempt 1: Direct got-scraping ──────────────────────────────────────────
async function fetchDirect(url: string, headers: Record<string, string>): Promise<{ statusCode: number; body: string }> {
  const res = await gotScraping({ url, ...BROWSER_OPTS, headers });
  return { statusCode: res.statusCode, body: res.body };
}

// ─── Attempt 2: got-scraping through residential proxy ───────────────────────
async function fetchViaProxy(url: string, headers: Record<string, string>): Promise<{ statusCode: number; body: string }> {
  if (!PROXY_URL) throw new Error("No PROXY_URL configured");
  const res = await gotScraping({
    url,
    ...BROWSER_OPTS,
    proxyUrl: PROXY_URL,
    headers,
    timeout: { request: 30_000 }, // proxies are slower
  });
  return { statusCode: res.statusCode, body: res.body };
}

// ─── Attempt 3: FlareSolverr (real headless Chrome) ──────────────────────────
async function fetchViaFlareSolverr(url: string): Promise<{ statusCode: number; body: string }> {
  if (!FLARESOLVERR_URL) throw new Error("No FLARESOLVERR_URL configured");

  const res = await fetch(`${FLARESOLVERR_URL}/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
  });

  const json: any = await res.json();

  if (json.status !== "ok") {
    throw new Error(`FlareSolverr error: ${json.message}`);
  }

  return {
    statusCode: json.solution?.status ?? 200,
    body:       json.solution?.response ?? "",
  };
}

// ─── Core fetch with fallback chain ──────────────────────────────────────────
async function fetchWithFallback(
  url: string,
  headers: Record<string, string>,
  requiresCloudflareBypass: boolean
): Promise<string> {
  // Always try direct first — works for MangaDex and sometimes CF sites
  try {
    const { statusCode, body } = await fetchDirect(url, headers);
    if (!isCFBlocked(statusCode, body)) {
      if (statusCode !== 200) throw new Error(`[httpClient] ${statusCode} fetching ${url}`);
      return body;
    }
    console.warn(`[httpClient] CF block detected on direct request to ${url}`);
  } catch (err: any) {
    if (!requiresCloudflareBypass) throw err;
    console.warn(`[httpClient] Direct fetch failed: ${err.message}`);
  }

  // Attempt 2: residential proxy
  if (PROXY_URL) {
    try {
      const { statusCode, body } = await fetchViaProxy(url, headers);
      if (!isCFBlocked(statusCode, body)) {
        if (statusCode !== 200) throw new Error(`[httpClient] Proxy: ${statusCode} fetching ${url}`);
        console.info(`[httpClient] Proxy success for ${url}`);
        return body;
      }
      console.warn(`[httpClient] CF still blocking via proxy for ${url}`);
    } catch (err: any) {
      console.warn(`[httpClient] Proxy fetch failed: ${err.message}`);
    }
  }

  // Attempt 3: FlareSolverr
  if (FLARESOLVERR_URL) {
    try {
      const { statusCode, body } = await fetchViaFlareSolverr(url);
      if (statusCode !== 200) throw new Error(`[httpClient] FlareSolverr: ${statusCode} fetching ${url}`);
      console.info(`[httpClient] FlareSolverr success for ${url}`);
      return body;
    } catch (err: any) {
      console.warn(`[httpClient] FlareSolverr failed: ${err.message}`);
    }
  }

  // All attempts failed
  const hint = !PROXY_URL && !FLARESOLVERR_URL
    ? " — Set PROXY_URL or FLARESOLVERR_URL in Railway env vars to bypass Cloudflare"
    : "";
  throw new Error(`[httpClient] All bypass attempts failed for ${url}${hint}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch HTML. Pass `cloudflareProtected: true` for ComicK, WeebCentral,
 * AsuraScans, NovelFull. Leave false for MangaDex.
 */
export async function fetchHTML(
  url: string,
  referer = "https://www.google.com/",
  cloudflareProtected = false
): Promise<string> {
  return fetchWithFallback(
    url,
    {
      Referer: referer,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    cloudflareProtected
  );
}

/**
 * Fetch JSON endpoint. MangaDex does NOT need CF bypass.
 * ComicK's API does.
 */
export async function fetchJSON<T = unknown>(
  url: string,
  referer = "https://comick.io/",
  cloudflareProtected = false
): Promise<T> {
  const body = await fetchWithFallback(
    url,
    {
      Accept:           "application/json, text/plain, */*",
      "Accept-Language":"en-US,en;q=0.9",
      Origin:           new URL(referer).origin,
      Referer:          referer,
    },
    cloudflareProtected
  );

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`[httpClient] Invalid JSON from ${url}: ${body.slice(0, 120)}`);
  }
}
