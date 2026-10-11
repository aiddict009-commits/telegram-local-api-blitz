# manga-novel-api v2

A self-hosted proxy API that serves **Manga · Manhwa · Manhua** and **Light Novel** data to your frontend — with full CORS bypass and Cloudflare evasion built in.

---

## The Two Problems This Solves

### Problem 1 — CORS
Your React app on `http://localhost:5173` cannot call `https://api.comick.io` directly.  
The browser blocks it. This is CORS.

```
Browser → api.comick.io    ❌  Blocked by browser CORS policy
Browser → localhost:3001   ✓  Your server (CORS headers set by us)
localhost:3001 → api.comick.io  ✓  Server-to-server, CORS doesn't apply
```

### Problem 2 — Cloudflare
Even from a Node.js server, `fetch()` / `axios` get blocked by Cloudflare with 403/503.  
Cloudflare detects non-browser traffic by inspecting:
- **TLS fingerprint** — the cipher suites Node.js advertises differ from Chrome's
- **HTTP/2 SETTINGS** — browsers send a specific sequence Node doesn't replicate
- **Header order** — browsers always send headers in the same order

**Solution:** `got-scraping` patches all three, making our server look exactly like Chrome.

---

## Sources

| Source | Base URL | Method | Manga | Manhwa | Manhua | CF Protected |
|---|---|---|:---:|:---:|:---:|:---:|
| **ComicK** | `api.comick.io` | JSON API | ✓ | ✓ | ✓ | ✓ |
| **MangaDex** | `api.mangadex.org` | JSON API | ✓ | ✓ | ✓ | — |
| **WeebCentral** | `weebcentral.com` | HTML scrape | ✓ | ✓ | ✓ | ✓ |
| **AsuraScans** | `asuracomic.net` | HTML scrape | ✓ | ✓ | ✓ | ✓ |
| **NovelFull** | `novelfull.com` | HTML scrape | — | — | — | ✓ |

---

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/manga-novel-api.git
cd manga-novel-api
npm install
cp .env.example .env
npm run dev        # → http://localhost:3001
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Port the server listens on |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated frontend origins for CORS |
| `NODE_ENV` | `development` | Set to `production` on your server |

---

## API Reference

### Health
```
GET /api/health
```

### Manga / Manhwa / Manhua

All manga endpoints accept `?source=` to pick the provider.

| Endpoint | Params | Description |
|---|---|---|
| `GET /api/manga/sources` | — | List all sources + their capabilities |
| `GET /api/manga/search` | `q`, `source`, `type`, `page`, `limit` | Search across any source |
| `GET /api/manga/trending` | `source`, `type`, `page`, `limit` | Trending (ComicK / MangaDex only) |
| `GET /api/manga/:id` | `source` | Comic/series info |
| `GET /api/manga/:id/chapters` | `source`, `page`, `lang`, `limit` | Chapter list |
| `GET /api/manga/:id/chapters/:chId/pages` | `source` | Chapter page image URLs |

**`?type=`** filter: `manga` · `manhwa` · `manhua`  
**`?source=`** values: `comick` · `mangadex` · `weebcentral` · `asura`

#### Examples
```
GET /api/manga/search?q=solo+leveling&source=mangadex&type=manhwa
GET /api/manga/trending?source=comick&type=manhwa&page=1
GET /api/manga/d86cf65b-5f6c-437d-a0af-19a31f94ec55?source=mangadex
GET /api/manga/d86cf65b.../chapters?source=mangadex&lang=en&limit=96
GET /api/manga/some-hid/chapters/chapter-hid/pages?source=comick
```

### Light Novels

| Endpoint | Params | Description |
|---|---|---|
| `GET /api/novels/search` | `q` | Search NovelFull |
| `GET /api/novels/:slug` | — | Novel metadata |
| `GET /api/novels/:slug/chapters` | `page` | Paginated chapter list |
| `GET /api/novels/:slug/chapters/:chSlug` | — | Chapter text content |

### Image Proxy

Solves hotlink protection so `<img>` tags work in your frontend.

```
GET /api/proxy/image?url=<url-encoded-image-url>
```

Instead of:
```html
<img src="https://meo.comick.pictures/page.jpg">  ← blocked by hotlink protection
```
Use:
```html
<img src="http://localhost:3001/api/proxy/image?url=https%3A%2F%2Fmeo.comick.pictures%2Fpage.jpg">
```

The proxy:
- Spoof the `Referer` header to the source domain
- Returns the image bytes with `Access-Control-Allow-Origin: *`
- Adds `Cache-Control: public, max-age=604800` (7 day browser cache)
- Only allows domains on its internal allow-list (no open relay)

---

## File Structure

```
manga-novel-api/
├── src/
│   ├── server.ts                    # Entry point, middleware, route mounting
│   ├── routes/
│   │   ├── manga.ts                 # Unified manga/manhwa/manhua endpoints
│   │   └── novels.ts                # Novel endpoints
│   ├── scrapers/
│   │   ├── comickScraper.ts         # api.comick.io direct JSON API + CF bypass
│   │   ├── mangaDexScraper.ts       # api.mangadex.org public REST API
│   │   ├── weebCentralScraper.ts    # weebcentral.com HTML scrape + CF bypass
│   │   ├── asuraScraper.ts          # asuracomic.net HTML scrape + CF bypass
│   │   └── novelFullScraper.ts      # novelfull.com HTML scrape + CF bypass
│   ├── proxy/
│   │   └── imageProxy.ts            # Image proxy (hotlink bypass + CORS fix)
│   ├── middleware/
│   │   ├── corsMiddleware.ts        # Custom CORS — detailed explanation inside
│   │   ├── errorHandler.ts          # Global error handler
│   │   └── requestLogger.ts         # Request logging
│   └── utils/
│       ├── httpClient.ts            # got-scraping wrapper — THE Cloudflare bypass
│       └── asyncWrapper.ts          # Async route error forwarding
├── config/
│   └── config.ts                    # Centralised env vars
├── .github/workflows/ci.yml
├── .env.example
├── package.json
└── tsconfig.json
```

---

## How the Cloudflare Bypass Works (in detail)

`src/utils/httpClient.ts` is the core — every outbound request goes through it.

```typescript
import { gotScraping } from "got-scraping";

const response = await gotScraping({
  url: "https://api.comick.io/v1.0/search?q=...",
  headerGeneratorOptions: {
    browsers: [{ name: "chrome", minVersion: 120 }],
    operatingSystems: ["windows"],
  },
});
```

`got-scraping` internally:
1. Generates headers in Chrome's exact order and with Chrome's exact values
2. Patches Node's TLS stack to emit Chrome's cipher suite list
3. Sets the HTTP/2 SETTINGS frame to match Chrome's defaults

Cloudflare checks all three — and sees Chrome. ✓

---

## How CORS is Prevented (in detail)

`src/middleware/corsMiddleware.ts` handles this.

```
Browser sends:  Origin: http://localhost:5173
Our server:     Access-Control-Allow-Origin: http://localhost:5173  ✓
                Access-Control-Allow-Methods: GET, OPTIONS
                Access-Control-Allow-Credentials: true
                Vary: Origin
```

For OPTIONS preflight:
```
Browser:   OPTIONS /api/manga/search  (preflight check)
Our server: 204 No Content  (immediately, before the route runs)
Browser:   GET /api/manga/search  (actual request, now allowed)
```

Origins NOT in `ALLOWED_ORIGINS` get no CORS headers → browser blocks them. This is intentional.

---

## Alternative Approaches (if you don't want a full server)

| Approach | Pros | Cons |
|---|---|---|
| **Vercel / Netlify functions** | No server to maintain | Cold starts, execution time limits |
| **Cloudflare Workers** | Global edge, very fast | Limited Node.js compatibility |
| **cors-anywhere** | Simple to self-host | Doesn't bypass CF fingerprinting |
| **Browser extension** | No backend needed | Only works for you, not deployed users |
| **This server** | Full control, CF bypass, image proxy | You run a server |

---

## License

MIT
