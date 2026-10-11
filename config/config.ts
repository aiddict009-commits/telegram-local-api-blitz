import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3001),

  /**
   * Comma-separated list of origins that are allowed to query this API.
   * Example .env value:  ALLOWED_ORIGINS=http://localhost:5173,https://myapp.com
   *
   * This is the CORS allow-list for your *frontend*. The scraping targets
   * (NovelFull, ComicK, etc.) are not affected — Node.js is exempt from CORS.
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim()),

  nodeEnv: process.env.NODE_ENV ?? "development",
};
