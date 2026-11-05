import { getDb, type Db } from '../db/index.js';
import { onSendStarted, refreshCounters, senderOf, type CampaignStatus } from './campaigns.js';
import { configBlockedReason } from './guard.js';
import { preferenceUrls } from './links.js';
import { isSubscribed } from './preferences.js';
import { formatFrom, renderEmail, type MergeValues } from './render.js';
import { getTransport, MAX_BATCH, TransportError, type OutgoingEmail } from './transport.js';
import { getEmailType } from './types.js';

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

export type TickOutcome =
  | { kind: 'idle' }
  | { kind: 'batch'; campaignId: string; batchKey: string; sent: number; failed: number; skipped: number }
  | { kind: 'retry'; campaignId: string; batchKey: string; error: string }
  | { kind: 'finished'; campaignId: string; status: CampaignStatus };

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
}

/** The oldest campaign with work: sending, or cancelled with a batch still in flight. */
function nextCampaign(db: Db): ActiveCampaign | null {
  return (
    (db
      .prepare(
        `SELECT c.* FROM email_campaigns c
          WHERE c.status = 'sending'
             OR (c.status = 'cancelled'
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

/** Claim the next batch: re-check opt-outs, then mark up to 100 rows sending under one key. */
function claimBatch(campaign: ActiveCampaign, db: Db, clock: () => number): { key: string; rows: SendRow[]; skipped: number } | null {
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
      if (rows.length === MAX_BATCH) break;
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

function finishIfDone(campaign: ActiveCampaign, db: Db, clock: () => number): TickOutcome | null {
  const counts = refreshCounters(campaign.id, db);
  if (counts.queued > 0 || counts.sending > 0) return null;
  const at = new Date(clock()).toISOString();
  if (campaign.status === 'cancelled') {
    return { kind: 'finished', campaignId: campaign.id, status: 'cancelled' };
  }
  const status: CampaignStatus = counts.sent === 0 && counts.failed > 0 ? 'failed' : 'sent';
  db.prepare(`UPDATE email_campaigns SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?`).run(
    status,
    at,
    at,
    campaign.id,
  );
  return { kind: 'finished', campaignId: campaign.id, status };
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
      ).run('idempotency window passed — check Resend before resending', campaign.id, key);
      refreshCounters(campaign.id, db);
      return { kind: 'batch', campaignId: campaign.id, batchKey: key, sent: 0, failed: rows.length, skipped: 0 };
    }
  } else {
    if (campaign.status !== 'sending') return finishIfDone(campaign, db, clock) ?? { kind: 'idle' };
    const claimed = claimBatch(campaign, db, clock);
    if (!claimed) return finishIfDone(campaign, db, clock) ?? { kind: 'idle' };
    skipped = claimed.skipped;
    if (claimed.rows.length === 0) {
      refreshCounters(campaign.id, db);
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
    if (error instanceof TransportError && !error.retryable) {
      db.prepare(
        `UPDATE email_sends SET status = 'failed', error = ? WHERE campaign_id = ? AND batch_key = ? AND status = 'sending'`,
      ).run(message.slice(0, 500), campaign.id, key);
      refreshCounters(campaign.id, db);
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
  refreshCounters(campaign.id, db);
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
