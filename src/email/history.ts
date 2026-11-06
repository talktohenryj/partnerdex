import { normalizeEmail } from '../contacts/upsert.js';
import { getDb, type Db } from '../db/index.js';
import type { SendStatus } from './campaigns.js';

/** Every campaign one person was in, newest first: what we last sent them and what happened. */

export interface EmailHistoryEntry {
  campaignId: string;
  name: string;
  subject: string;
  sentAt: string | null;
  status: SendStatus;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
  unsubscribedAt: string | null;
}

interface HistoryRow {
  campaign_id: string;
  email: string;
  name: string;
  subject: string;
  sent_at: string | null;
  status: SendStatus;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  unsubscribed_at: string | null;
}

const SELECT = `SELECT s.campaign_id, s.email, c.name, c.subject, s.sent_at, s.status, s.delivered_at, s.opened_at,
                       s.clicked_at, s.bounced_at, s.complained_at, s.unsubscribed_at
                  FROM email_sends s JOIN email_campaigns c ON c.id = s.campaign_id`;

/** Newest first; rows never sent (queued, skipped) sort by the campaign's start. */
const ORDER = `COALESCE(s.sent_at, c.started_at, c.created_at) DESC, s.campaign_id`;

function toEntry(row: HistoryRow): EmailHistoryEntry {
  return {
    campaignId: row.campaign_id,
    name: row.name,
    subject: row.subject,
    sentAt: row.sent_at,
    status: row.status,
    deliveredAt: row.delivered_at,
    openedAt: row.opened_at,
    clickedAt: row.clicked_at,
    bouncedAt: row.bounced_at,
    complainedAt: row.complained_at,
    unsubscribedAt: row.unsubscribed_at,
  };
}

export function emailHistory(email: string, db: Db = getDb()): EmailHistoryEntry[] {
  const rows = db.prepare(`${SELECT} WHERE s.email = ? ORDER BY ${ORDER}`).all(normalizeEmail(email)) as HistoryRow[];
  return rows.map(toEntry);
}

export const LAST_EMAIL_MAX = 200;

/** The newest campaign for each of a page of addresses. Addresses with none are left out. */
export function lastEmailFor(emails: string[], db: Db = getDb()): Record<string, EmailHistoryEntry> {
  const wanted = [...new Set(emails.map(normalizeEmail).filter(Boolean))].slice(0, LAST_EMAIL_MAX);
  if (wanted.length === 0) return {};
  const marks = wanted.map(() => '?').join(', ');
  const rows = db
    .prepare(`${SELECT} WHERE s.email IN (${marks}) AND s.status IN ('sent', 'failed') ORDER BY s.email, ${ORDER}`)
    .all(...wanted) as HistoryRow[];
  const result: Record<string, EmailHistoryEntry> = {};
  for (const row of rows) if (!result[row.email]) result[row.email] = toEntry(row);
  return result;
}
