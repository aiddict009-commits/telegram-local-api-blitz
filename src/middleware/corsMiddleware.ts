import { Request, Response, NextFunction } from "express";

// Collect ALL allowed origins from any related env var
// (handles the multiple ALLOWED_ORIGINS* variables in Railway)
const rawOrigins = [
  process.env.ALLOWED_ORIGINS ?? "",
  process.env.ALLOWED_ORIGINS2 ?? "",
  process.env.ALLOWED_ORIGINS3 ?? "",
  process.env.ALLOWED_ORIGIN ?? "",
].join(",");

const EXPLICIT_ORIGINS = rawOrigins
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

// Wildcard domain patterns — any subdomain of these is always allowed
// This prevents needing to update env vars every time a Lovable URL changes
const ALLOWED_DOMAIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,           // localhost any port
  /^https:\/\/[^.]+\.lovable\.app$/,         // *.lovable.app
  /^https:\/\/[^.]+\.lovableproject\.com$/,  // *.lovableproject.com
  /^https:\/\/lovable\.dev$/,                // lovable.dev editor
  /^https:\/\/gptengineer\.app$/,            // gptengineer.app
];

function isOriginAllowed(origin: string): boolean {
  // Check explicit list first
  if (EXPLICIT_ORIGINS.includes(origin)) return true;
  // Check wildcard patterns
  return ALLOWED_DOMAIN_PATTERNS.some(pattern => pattern.test(origin));
}

const EXPOSED_HEADERS = ["X-Total-Count", "X-Page", "X-Total-Pages"];
const ALLOWED_HEADERS = ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"];

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const incomingOrigin = req.headers.origin;

  if (incomingOrigin && isOriginAllowed(incomingOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", incomingOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));
    res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS.join(", "));
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}