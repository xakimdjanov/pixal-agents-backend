import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { log } from './log.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
  if (err instanceof ZodError) {
    const msg = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return void res.status(400).json({ error: msg });
  }
  if (err?.code === '23505') return void res.status(409).json({ error: 'already exists' });
  if (err?.code === '22P02') return void res.status(400).json({ error: 'invalid id' });
  if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'invalid JSON' });
  log('error', `unhandled: ${err?.code ?? ''} ${err?.message ?? err}`);
  res.status(500).json({ error: 'internal error' });
};
