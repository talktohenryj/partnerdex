import crypto from 'node:crypto';
import { getConfig } from '../config.js';

/**
 * Signed links for the preference page. The token carries who, which email
 * type, and which campaign (or "test"); the HMAC stops anyone editing it to
 * unsubscribe someone else. No expiry: an unsubscribe link must keep working.
 */

export const TEST_SOURCE = 'test';

export interface LinkPayload {
  email: string;
  typeKey: string;
  /** The campaign id, or "test" for a test email. */
  sourceId: string;
}

function hmac(secret: string, data: string): Buffer {
  return crypto.createHmac('sha256', secret).update(`partnerdex.email-link.v1\n${data}`).digest();
}

export function signLink(payload: LinkPayload, secret = requireSecret()): string {
  const data = `${payload.email}\n${payload.typeKey}\n${payload.sourceId}`;
  return `${Buffer.from(data).toString('base64url')}.${hmac(secret, data).toString('base64url')}`;
}

export function verifyLink(token: string, secret = getConfig().email.linkSecret): LinkPayload | null {
  if (!secret || typeof token !== 'string' || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const data = Buffer.from(token.slice(0, dot), 'base64url').toString();
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = hmac(secret, data);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const parts = data.split('\n');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  return { email: parts[0], typeKey: parts[1], sourceId: parts[2] };
}

function requireSecret(): string {
  const secret = getConfig().email.linkSecret;
  if (!secret) throw new Error('EMAIL_LINK_SECRET is not set.');
  return secret;
}

function baseUrl(): string {
  const base = getConfig().email.publicBaseUrl;
  if (!base) throw new Error('PUBLIC_BASE_URL is not set.');
  return base;
}

export function preferenceUrls(payload: LinkPayload): {
  page: string;
  unsubscribe: string;
  oneClick: string;
} {
  const token = signLink(payload);
  const page = `${baseUrl()}/p/${token}`;
  return { page, unsubscribe: `${page}?off=1`, oneClick: `${page}/one-click` };
}
