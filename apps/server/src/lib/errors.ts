import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { Logger } from './logger';

export class AppError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'You do not have permission to perform this action') => new AppError(403, 'forbidden', msg);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'unauthorized', msg);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details);
export const conflict = (msg: string) => new AppError(409, 'conflict', msg);

export function errorHandler(logger: Logger) {
  return (err: Error, c: Context) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    }
    if (err instanceof ZodError) {
      return c.json({ error: { code: 'validation_error', message: 'Invalid request', details: err.issues } }, 422);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
    }
    logger.error({ err, path: c.req.path }, 'unhandled error');
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
  };
}
