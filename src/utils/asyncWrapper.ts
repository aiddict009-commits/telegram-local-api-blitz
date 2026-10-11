import { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wraps an async route handler so that any thrown errors are automatically
 * forwarded to Express's error-handling middleware via next(err).
 * Without this, unhandled promise rejections in async routes silently hang.
 */
export function asyncWrapper(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
}
