import { getDb, type Db } from '../db/index.js';
import { getCampaignRow } from './campaigns.js';
import { EmailError } from './errors.js';
import { unsubscribeAllMarketing } from './preferences.js';
import { getTransport, TransportError, type EmailTransport } from './transport.js';
import { stampSend } from './webhook.js';

/**
 * A one-time pull of delivery data for a campaign that went out before the
 * webhook existed. Resend does not replay old webhook events, so this reads
 * each email back with GET /emails/:id.
 *
 * Resend returns only the latest event and the time the email was created —
 * no event times and no bounce type. So the times written are the creation
 * time, an event implies the ones before it (clicked → opened → delivered),
 * and a bounce is stamped but not suppressed: a person decides that.
 *
 * Run it after the webhook is live. The stamps keep the first time, so an
 * overlap with webhook events, or a second run, changes nothing.
 */

export const BACKFILL_SPACING_MS = 600;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_TRIES = 6;

export interface BackfillSummary {
  read: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  /** last_event values with nothing to write (sent, queued, delivery_delayed, …). */
  other: number;
  errors: number;
}

type Column = Parameters<typeof stampSend>[1];

const IMPLIES: Record<string, Column[]> = {
  delivered: ['delivered_at'],
  opened: ['delivered_at', 'opened_at'],
  clicked: ['delivered_at', 'opened_at', 'clicked_at'],
  bounced: ['bounced_at'],
  complained: ['complained_at'],
};

/** Resend writes "2026-11-05 14:02:11.123456+00"; Date.parse needs ISO. */
export function resendTime(raw: string | null, fallback: string): string {
  if (raw) {
    const iso = raw.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return fallback;
}

export interface BackfillOptions {
  transport?: EmailTransport;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function backfillCampaign(id: string, db: Db = getDb(), options: BackfillOptions = {}): Promise<BackfillSummary> {
  if (!getCampaignRow(id, db)) throw new EmailError(`No campaign with id ${id}.`, 404);
  const transport = options.transport ?? getTransport();
  if (!transport) throw new EmailError('RESEND_API_KEY is not set.', 403);
  const sleep = options.sleep ?? realSleep;

  const rows = db
    .prepare(
      `SELECT email, resend_id, sent_at FROM email_sends
        WHERE campaign_id = ? AND status = 'sent' AND resend_id IS NOT NULL ORDER BY sent_at, email`,
    )
    .all(id) as Array<{ email: string; resend_id: string; sent_at: string | null }>;

  const summary: BackfillSummary = { read: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, other: 0, errors: 0 };
  for (const [index, row] of rows.entries()) {
    if (index > 0) await sleep(BACKFILL_SPACING_MS);
    let record: Awaited<ReturnType<EmailTransport['getEmail']>> | null = null;
    let backoff = BACKOFF_START_MS;
    for (let attempt = 1; attempt <= MAX_TRIES && !record; attempt += 1) {
      try {
        record = await transport.getEmail(row.resend_id);
      } catch (error) {
        if (!(error instanceof TransportError) || !error.retryable || attempt === MAX_TRIES) break;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
    if (!record) {
      summary.errors += 1;
      continue;
    }
    summary.read += 1;
    const event = record.lastEvent ?? '';
    const columns = IMPLIES[event];
    if (!columns) {
      summary.other += 1;
      continue;
    }
    const at = resendTime(record.createdAt, row.sent_at ?? new Date().toISOString());
    db.transaction(() => {
      for (const column of columns) stampSend(row.resend_id, column, at, db);
      if (event === 'complained') unsubscribeAllMarketing(row.email, 'complaint', db);
    })();
    summary[event as keyof typeof IMPLIES & keyof BackfillSummary] += 1;
  }
  return summary;
}

export function formatBackfillSummary(id: string, summary: BackfillSummary): string {
  const lines = [
    `Backfill of campaign ${id}: ${summary.read} read, ${summary.errors} could not be read.`,
    `  last event: ${summary.clicked} clicked, ${summary.opened} opened, ${summary.delivered} delivered, ` +
      `${summary.bounced} bounced, ${summary.complained} complained, ${summary.other} other.`,
  ];
  if (summary.bounced > 0) {
    lines.push(
      `  ${summary.bounced} bounced. Resend does not say hard or soft, so none were suppressed. ` +
        'Check them in the campaign report (filter: Bounced) and suppress on the Contacts page.',
    );
  }
  return lines.join('\n');
}
