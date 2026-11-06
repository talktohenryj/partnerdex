import crypto from 'node:crypto';
import type express from 'express';
import { getConfig } from '../config.js';
import { suppressContact } from '../contacts/upsert.js';
import { getDb, type Db } from '../db/index.js';
import { unsubscribeAllMarketing } from './preferences.js';

/**
 * Resend's delivery events, back into email_sends and the suppression store.
 *
 * Resend signs each delivery with Svix. The check needs the raw body, so the
 * route is mounted ahead of the global JSON parser.
 */

export const SIGNATURE_TOLERANCE_S = 300;

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

/** The base64 v1 signature of one delivery, as Svix computes it. Exported for tests. */
export function signResendPayload(secret: string, id: string, timestamp: string, rawBody: Buffer | string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody.toString()}`).digest('base64');
}

export function verifyResendSignature(
  rawBody: Buffer,
  headers: Headers,
  secret: string,
  now: number = Date.now(),
): boolean {
  const id = header(headers, 'svix-id');
  const timestamp = header(headers, 'svix-timestamp');
  const signatures = header(headers, 'svix-signature');
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return false;

  const expected = Buffer.from(signResendPayload(secret, id, timestamp, rawBody));
  return signatures.split(' ').some((entry) => {
    const [version, signature] = entry.split(',');
    if (version !== 'v1' || !signature) return false;
    const given = Buffer.from(signature);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

export interface ResendEvent {
  type?: unknown;
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    bounce?: { type?: unknown } | null;
  } | null;
}

export type EventResult = 'written' | 'unknown_email' | 'ignored';

const STAMP: Record<string, string> = {
  'email.delivered': 'delivered_at',
  'email.bounced': 'bounced_at',
  'email.complained': 'complained_at',
  'email.opened': 'opened_at',
  'email.clicked': 'clicked_at',
};

/** Set one event column, keeping the first time. Exported for the backfill. */
export function stampSend(
  resendId: string,
  column: 'delivered_at' | 'bounced_at' | 'complained_at' | 'opened_at' | 'clicked_at',
  at: string,
  db: Db,
): void {
  db.prepare(`UPDATE email_sends SET ${column} = COALESCE(${column}, ?) WHERE resend_id = ?`).run(at, resendId);
}

function eventTime(event: ResendEvent): string {
  const raw = typeof event.created_at === 'string' ? Date.parse(event.created_at) : NaN;
  return new Date(Number.isNaN(raw) ? Date.now() : raw).toISOString();
}

export function applyResendEvent(event: ResendEvent, db: Db = getDb()): EventResult {
  const type = typeof event.type === 'string' ? event.type : '';
  const column = STAMP[type];
  if (!column) return 'ignored';
  const resendId = typeof event.data?.email_id === 'string' ? event.data.email_id : '';
  if (!resendId) return 'ignored';
  const row = db.prepare('SELECT email FROM email_sends WHERE resend_id = ?').get(resendId) as
    | { email: string }
    | undefined;
  if (!row) return 'unknown_email';

  const at = eventTime(event);
  db.transaction(() => {
    stampSend(resendId, column as Parameters<typeof stampSend>[1], at, db);
    if (type === 'email.bounced' && event.data?.bounce?.type === 'Permanent') {
      suppressContact(row.email, { source: 'resend_webhook', reason: 'hard bounce', at }, db);
    }
    if (type === 'email.complained') {
      unsubscribeAllMarketing(row.email, 'complaint', db);
    }
  })();
  return 'written';
}

/**
 * POST /api/email/webhooks/resend. Mounted with express.raw, ahead of the JSON
 * parser and the dashboard gate: the signature is the credential.
 */
export function resendWebhookHandler(request: express.Request, response: express.Response): void {
  const secret = getConfig().email.resendWebhookSecret;
  if (!secret) {
    response.status(503).json({ error: 'The Resend webhook is off. Set RESEND_WEBHOOK_SECRET.' });
    return;
  }
  const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (!verifyResendSignature(raw, request.headers, secret)) {
    response.status(401).json({ error: 'Bad signature.' });
    return;
  }
  // Past this point always 200: Resend retries anything else, and an event
  // that cannot be applied would retry forever.
  try {
    applyResendEvent(JSON.parse(raw.toString('utf8')) as ResendEvent);
  } catch (error) {
    console.error('[partnerdex] Resend webhook event could not be applied:', error instanceof Error ? error.message : error);
  }
  response.status(200).json({ ok: true });
}
