import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { IDEMPOTENCY_WINDOW_ERROR, onSendStarted, refreshCounters, senderOf, type CampaignStatus, type SendStatus } from './campaigns.js';
import { configBlockedReason } from './guard.js';
import { preferenceUrls } from './links.js';
import { isSubscribed } from './preferences.js';
import { formatFrom, renderEmail, type MergeValues } from './render.js';
import { getTransport, MAX_BATCH, TransportError, type OutgoingEmail } from './transport.js';
import { getEmailType } from './types.js';
import { nextUtcMidnight, sendWait, setSendWait, utcMidnight, type WaitReason } from './wait.js';

/**
 * The send loop. Same shape as the sync scheduler: a chained setTimeout, so
 * two ticks never run at once. In-process, not in the sync worker — it waits
 * on the network, not the CPU.
 *
 * Every batch is written as `sending` with its idempotency key *before* the
 * request goes out. A crash or a deploy between the two leaves those rows
 * `sending`, and the next tick re-posts exactly them under the same key.
 * Resend answers a repeated key with the first result instead of sending
 * twice. Keys live 24 hours, so a batch older than 23 hours is failed for a
 * person to check rather than risked.
 */

const IDLE_MS = 30_000;
const BUSY_MS = 1_000;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
export const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60_000;
/** How often to try again after Resend's monthly quota: it has no fixed reset time we know. */
export const MONTHLY_QUOTA_RETRY_MS = 60 * 60_000;

export type TickOutcome =
  | { kind: 'idle' }
  | { kind: 'batch'; campaignId: string; batchKey: string; sent: number; failed: number; skipped: number }
  | { kind: 'retry'; campaignId: string; batchKey: string; error: string }
  | { kind: 'finished'; campaignId: string; status: CampaignStatus }
  | { kind: 'waiting'; reason: WaitReason; until: string };

interface SendRow {
  campaign_id: string;
  email: string;
  merge: string;
  batch_key: string | null;
}

interface ActiveCampaign {
  id: string;
  status: CampaignStatus;
  subject: string;
  preview_text: string;
  body: string;
  email_type: string;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  footer_address: string | null;
  button_color: string | null;
  batch_seq: number;
  batch_started_at: string | null;
  /** Pause once sent + failed reaches this; null = no planned pause. */
  pause_at: number | null;
}

/** The oldest campaign with work: sending, or cancelled or paused with a batch still in flight. */
function nextCampaign(db: Db): ActiveCampaign | null {
  return (
    (db
      .prepare(
        `SELECT c.* FROM email_campaigns c
          WHERE c.status = 'sending'
             OR (c.status IN ('cancelled', 'paused')
                 AND EXISTS (SELECT 1 FROM email_sends s WHERE s.campaign_id = c.id AND s.status = 'sending'))
          ORDER BY c.started_at, c.id
          LIMIT 1`,
      )
      .get() as ActiveCampaign | undefined) ?? null
  );
}

function suppressed(email: string, db: Db): boolean {
  const row = db
    .prepare(
      `SELECT (SELECT is_suppressed FROM contacts WHERE email = @email) AS flag,
              EXISTS (SELECT 1 FROM contact_suppressions WHERE email = @email) AS hard`,
    )
    .get({ email }) as { flag: number | null; hard: number };
  return row.flag === 1 || row.hard === 1;
}

function outgoing(campaign: ActiveCampaign, row: SendRow, db: Db): OutgoingEmail {
  const sender = senderOf(campaign)!;
  const rendered = renderEmail({
    subject: campaign.subject,
    previewText: campaign.preview_text,
    body: campaign.body,
    merge: JSON.parse(row.merge) as MergeValues,
    sender,
    typeLabel: getEmailType(campaign.email_type, db)?.label ?? campaign.email_type,
    urls: preferenceUrls({ email: row.email, typeKey: campaign.email_type, sourceId: campaign.id }),
  });
  return {
    from: formatFrom(sender),
    to: row.email,
    replyTo: sender.replyTo || undefined,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    headers: rendered.headers,
  };
}

/** How many more emails go out before a planned pause: at most one batch. */
function roomBeforePause(campaign: ActiveCampaign, db: Db): number {
  if (campaign.pause_at === null) return MAX_BATCH;
  const done = db
    .prepare(`SELECT COUNT(*) AS n FROM email_sends WHERE campaign_id = ? AND status IN ('sent', 'failed')`)
    .get(campaign.id) as { n: number };
  return Math.max(0, Math.min(MAX_BATCH, campaign.pause_at - done.n));
}

/** Campaign emails sent since 00:00 UTC today, over all campaigns. Test sends are not in email_sends. */
export function sentTodayUtc(db: Db, clock: () => number = Date.now): number {
  const since = new Date(utcMidnight(clock())).toISOString();
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM email_sends WHERE status = 'sent' AND sent_at >= ?`).get(since) as { n: number }
  ).n;
}

function waitUntil(reason: WaitReason, until: number): TickOutcome {
  const wait = { reason, until: new Date(until).toISOString() };
  setSendWait(wait);
  return { kind: 'waiting', ...wait };
}

/** Claim the next batch: re-check opt-outs, then mark up to `room` rows sending under one key. */
function claimBatch(
  campaign: ActiveCampaign,
  db: Db,
  clock: () => number,
  room: number,
): { key: string; rows: SendRow[]; skipped: number } | null {
  return db.transaction(() => {
    const candidates = db
      .prepare(
        `SELECT campaign_id, email, merge, batch_key FROM email_sends
          WHERE campaign_id = ? AND status = 'queued' ORDER BY email LIMIT ?`,
      )
      .all(campaign.id, MAX_BATCH * 2) as SendRow[];
    if (candidates.length === 0) return null;

    const skip = db.prepare(
      `UPDATE email_sends SET status = 'skipped', skip_reason = ? WHERE campaign_id = ? AND email = ?`,
    );
    const rows: SendRow[] = [];
    let skipped = 0;
    for (const row of candidates) {
      if (rows.length === room) break;
      if (suppressed(row.email, db)) {
        skip.run('suppressed', campaign.id, row.email);
        skipped += 1;
      } else if (!isSubscribed(row.email, campaign.email_type, db)) {
        skip.run('unsubscribed_type', campaign.id, row.email);
        skipped += 1;
      } else {
        rows.push(row);
      }
    }
    if (rows.length === 0) return { key: '', rows, skipped };

    const seq = campaign.batch_seq + 1;
    const key = `${campaign.id}:${seq}`;
    db.prepare(`UPDATE email_campaigns SET batch_seq = ?, batch_started_at = ? WHERE id = ?`).run(
      seq,
      new Date(clock()).toISOString(),
      campaign.id,
    );
    const mark = db.prepare(
      `UPDATE email_sends SET status = 'sending', batch_key = ? WHERE campaign_id = ? AND email = ?`,
    );
    for (const row of rows) mark.run(key, campaign.id, row.email);
    return { key, rows: rows.map((row) => ({ ...row, batch_key: key })), skipped };
  })();
}

function finishCampaign(id: string, counts: Record<SendStatus, number>, db: Db, clock: () => number): CampaignStatus {
  const at = new Date(clock()).toISOString();
  const status: CampaignStatus = counts.sent === 0 && counts.failed > 0 ? 'failed' : 'sent';
  db.prepare(
    `UPDATE email_campaigns SET status = ?, pause_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
  ).run(status, at, at, id);
  return status;
}

function finishIfDone(campaign: ActiveCampaign, db: Db, clock: () => number): TickOutcome | null {
  const counts = refreshCounters(campaign.id, db);
  if (counts.queued > 0 || counts.sending > 0) return null;
  if (campaign.status === 'cancelled') {
    return { kind: 'finished', campaignId: campaign.id, status: 'cancelled' };
  }
  return { kind: 'finished', campaignId: campaign.id, status: finishCampaign(campaign.id, counts, db, clock) };
}

/**
 * After every batch: recount, then pause a send that reached its planned
 * pause, or close a paused one that has nothing left (a pause asked for while
 * the last batch was in flight).
 */
function settle(id: string, db: Db, clock: () => number): void {
  const counts = refreshCounters(id, db);
  const row = db.prepare('SELECT status, pause_at FROM email_campaigns WHERE id = ?').get(id) as
    | { status: CampaignStatus; pause_at: number | null }
    | undefined;
  if (!row || counts.sending > 0) return;
  if (row.status === 'sending' && row.pause_at !== null && counts.sent + counts.failed >= row.pause_at) {
    if (counts.queued === 0) {
      finishCampaign(id, counts, db, clock);
      return;
    }
    db.prepare(`UPDATE email_campaigns SET status = 'paused', pause_at = NULL, updated_at = ? WHERE id = ?`).run(
      new Date(clock()).toISOString(),
      id,
    );
    console.log(`[partnerdex] email campaign ${id} paused after ${counts.sent + counts.failed} emails, as planned`);
  } else if (row.status === 'paused' && counts.queued === 0) {
    finishCampaign(id, counts, db, clock);
  }
}

/**
 * One step of the loop: resume an in-flight batch, or send the next one, or
 * close a campaign that has nothing left. Exported for tests, which drive it
 * by hand with a fake transport and clock.
 */
export async function runEmailTick(db: Db = getDb(), clock: () => number = Date.now): Promise<TickOutcome> {
  const campaign = nextCampaign(db);
  if (!campaign) return { kind: 'idle' };

  const inFlight = db
    .prepare(
      `SELECT campaign_id, email, merge, batch_key FROM email_sends
        WHERE campaign_id = ? AND status = 'sending' ORDER BY batch_key, email`,
    )
    .all(campaign.id) as SendRow[];

  let key: string;
  let rows: SendRow[];
  let skipped = 0;
  if (inFlight.length > 0) {
    key = inFlight[0]!.batch_key!;
    rows = inFlight.filter((row) => row.batch_key === key);
    const started = campaign.batch_started_at ? Date.parse(campaign.batch_started_at) : clock();
    if (clock() - started > IDEMPOTENCY_WINDOW_MS) {
      db.prepare(
        `UPDATE email_sends SET status = 'failed', error = ? WHERE campaign_id = ? AND batch_key = ? AND status = 'sending'`,
      ).run(IDEMPOTENCY_WINDOW_ERROR, campaign.id, key);
      settle(campaign.id, db, clock);
      return { kind: 'batch', campaignId: campaign.id, batchKey: key, sent: 0, failed: rows.length, skipped: 0 };
    }
  } else {
    if (campaign.status !== 'sending') {
      settle(campaign.id, db, clock);
      return campaign.status === 'cancelled' ? (finishIfDone(campaign, db, clock) ?? { kind: 'idle' }) : { kind: 'idle' };
    }
    const wait = sendWait(clock());
    if (wait) return { kind: 'waiting', ...wait };
    let room = roomBeforePause(campaign, db);
    if (room === 0) {
      settle(campaign.id, db, clock);
      return { kind: 'idle' };
    }
    const limit = getConfig().email.dailyLimit;
    if (limit !== null) {
      const left = limit - sentTodayUtc(db, clock);
      if (left <= 0) {
        console.log(`[partnerdex] email daily limit of ${limit} reached; sending again after 00:00 UTC`);
        return waitUntil('daily_limit', nextUtcMidnight(clock()));
      }
      room = Math.min(room, left);
    }
    const claimed = claimBatch(campaign, db, clock, room);
    if (!claimed) return finishIfDone(campaign, db, clock) ?? { kind: 'idle' };
    skipped = claimed.skipped;
    if (claimed.rows.length === 0) {
      settle(campaign.id, db, clock);
      return { kind: 'batch', campaignId: campaign.id, batchKey: '', sent: 0, failed: 0, skipped };
    }
    key = claimed.key;
    rows = claimed.rows;
  }

  const transport = getTransport();
  if (!transport) {
    return { kind: 'retry', campaignId: campaign.id, batchKey: key, error: 'RESEND_API_KEY is not set.' };
  }

  let ids: string[];
  try {
    ids = (await transport.sendBatch(rows.map((row) => outgoing(campaign, row, db)), key)).ids;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const quota =
      error instanceof TransportError && (error.code === 'daily_quota_exceeded' || error.code === 'monthly_quota_exceeded')
        ? error.code
        : null;
    if (quota) {
      // A 429 means Resend sent nothing, so the rows go back in the queue and
      // are claimed again later under a new key.
      db.prepare(
        `UPDATE email_sends SET status = 'queued', batch_key = NULL, error = NULL
          WHERE campaign_id = ? AND batch_key = ? AND status = 'sending'`,
      ).run(campaign.id, key);
      settle(campaign.id, db, clock);
      if (quota === 'daily_quota_exceeded') {
        console.log(`[partnerdex] Resend daily quota reached; ${rows.length} emails wait for 00:00 UTC`);
        return waitUntil('daily_quota', nextUtcMidnight(clock()));
      }
      console.log(`[partnerdex] Resend monthly quota reached; ${rows.length} emails wait; checking again in 1 hour`);
      return waitUntil('monthly_quota', clock() + MONTHLY_QUOTA_RETRY_MS);
    }
    if (error instanceof TransportError && !error.retryable) {
      db.prepare(
        `UPDATE email_sends SET status = 'failed', error = ? WHERE campaign_id = ? AND batch_key = ? AND status = 'sending'`,
      ).run(message.slice(0, 500), campaign.id, key);
      settle(campaign.id, db, clock);
      console.log(`[partnerdex] email campaign ${campaign.id} batch ${key}: 0 sent, ${rows.length} failed`);
      return { kind: 'batch', campaignId: campaign.id, batchKey: key, sent: 0, failed: rows.length, skipped };
    }
    return { kind: 'retry', campaignId: campaign.id, batchKey: key, error: message };
  }

  const at = new Date(clock()).toISOString();
  db.transaction(() => {
    const done = db.prepare(
      `UPDATE email_sends SET status = 'sent', resend_id = ?, sent_at = ?, error = NULL
        WHERE campaign_id = ? AND email = ? AND status = 'sending'`,
    );
    rows.forEach((row, index) => done.run(ids[index] ?? null, at, campaign.id, row.email));
  })();
  settle(campaign.id, db, clock);
  console.log(`[partnerdex] email campaign ${campaign.id} batch ${key}: ${rows.length} sent, 0 failed`);
  return { kind: 'batch', campaignId: campaign.id, batchKey: key, sent: rows.length, failed: 0, skipped };
}

// ---------------------------------------------------------------------------
// The loop

let timer: NodeJS.Timeout | null = null;
let running = false;
let started = false;
let backoffMs = 0;

function scheduleIn(delayMs: number): void {
  if (!started) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, delayMs);
  timer.unref?.();
}

async function tick(): Promise<void> {
  timer = null;
  if (running) return;
  running = true;
  let delay = IDLE_MS;
  try {
    const outcome = await runEmailTick();
    if (outcome.kind === 'retry') {
      backoffMs = backoffMs ? Math.min(backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
      delay = backoffMs;
      console.warn(`[partnerdex] email batch ${outcome.batchKey} will retry in ${delay / 1000}s: ${outcome.error}`);
    } else if (outcome.kind === 'waiting') {
      backoffMs = 0;
      delay = Math.max(BUSY_MS, Date.parse(outcome.until) - Date.now() + BUSY_MS);
    } else {
      backoffMs = 0;
      delay = outcome.kind === 'idle' ? IDLE_MS : BUSY_MS;
    }
  } catch (error) {
    console.error('[partnerdex] email runner failed:', error);
    delay = IDLE_MS;
  } finally {
    running = false;
  }
  scheduleIn(delay);
}

/** Starts the loop when the environment allows sending. Returns why not, or null. */
export function startEmailRunner(): string | null {
  const reason = configBlockedReason();
  if (reason || started) return reason;
  started = true;
  onSendStarted(wakeEmailRunner);
  scheduleIn(BUSY_MS);
  return null;
}

export function wakeEmailRunner(): void {
  if (started && !running) scheduleIn(0);
}

export function stopEmailRunner(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
  onSendStarted(null);
}
