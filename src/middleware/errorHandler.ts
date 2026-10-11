import { Request, Response, NextFunction } from "express";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const message = err instanceof Error ? err.message : "Unexpected server error";
  const status = (err as any)?.statusCode ?? 500;

  console.error(`[Error] ${message}`);

  res.status(status).json({ error: message });
}
