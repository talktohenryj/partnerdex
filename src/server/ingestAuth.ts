import crypto from 'node:crypto';
import type express from 'express';
import { getConfig } from '../config.js';

/**
 * Bearer-token guard for every endpoint an app calls. The token is
 * `INGEST_TOKEN`, not the dashboard password — that credential is for a human
 * at a browser.
 */

export function bearerMatches(presented: string, actual: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(actual).digest();
  return crypto.timingSafeEqual(a, b);
}

export function requireIngestToken(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  const expected = getConfig().auth.ingestToken;
  if (!expected) {
    response.status(503).json({
      error: 'App ingest is disabled. Set INGEST_TOKEN to enable it.',
    });
    return;
  }

  const header = request.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const presented = match?.[1]?.trim() ?? '';
  if (!presented || !bearerMatches(presented, expected)) {
    response.status(401).json({ error: 'Invalid or missing ingest token.' });
    return;
  }
  next();
}
