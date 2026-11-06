import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb } from '../src/db/index.js';
import { backfillCampaign, formatBackfillSummary, resendTime } from '../src/email/backfill.js';
import { createCampaign, prepareCampaign, startSend } from '../src/email/campaigns.js';
import { isSubscribed } from '../src/email/preferences.js';
import { runEmailTick } from '../src/email/runner.js';
import { setTransportForTests, TransportError } from '../src/email/transport.js';
import { applyResendEvent } from '../src/email/webhook.js';
import { PAYING_OWNERS, saveSender, seedOwners, sendingSetup, type FakeTransport } from './emailHelpers.js';

const CREATED = '2026-11-05 14:02:11.123456+00';
const CREATED_ISO = '2026-11-05T14:02:11.123Z';
const noSleep = async () => {};

async function sentCampaign(count: number) {
  seedOwners(count);
  const created = createCampaign({ name: 'News', audience: PAYING_OWNERS, subject: 'Hi', body: 'Hello' });
  await prepareCampaign(created.id);
  startSend(created.id, count);
  for (let i = 0; i < 10; i += 1) if ((await runEmailTick()).kind === 'finished') break;
  const sends = getDb()
    .prepare('SELECT email, resend_id AS resendId FROM email_sends WHERE campaign_id = ? ORDER BY email')
    .all(created.id) as Array<{ email: string; resendId: string }>;
  return { id: created.id, sends };
}

function row(resendId: string) {
  return getDb()
    .prepare('SELECT delivered_at, opened_at, clicked_at, bounced_at, complained_at FROM email_sends WHERE resend_id = ?')
    .get(resendId) as Record<string, string | null>;
}

describe('one-time backfill', () => {
  let fake: FakeTransport;
  beforeEach(() => {
    fake = sendingSetup();
    saveSender();
  });
  afterEach(() => {
    setTransportForTests(null);
    closeDb();
  });

  it('backfill maps each last event', async () => {
    const { id, sends } = await sentCampaign(5);
    const events = ['clicked', 'opened', 'delivered', 'bounced', 'delivery_delayed'];
    sends.forEach((send, index) => fake.records.set(send.resendId, { lastEvent: events[index]!, createdAt: CREATED }));
    const summary = await backfillCampaign(id, getDb(), { transport: fake, sleep: noSleep });
    assert.deepEqual(summary, { read: 5, delivered: 1, opened: 1, clicked: 1, bounced: 1, complained: 0, failed: 0, other: 1, errors: 0 });
    assert.deepEqual(row(sends[0]!.resendId), {
      delivered_at: CREATED_ISO, opened_at: CREATED_ISO, clicked_at: CREATED_ISO, bounced_at: null, complained_at: null,
    });
    assert.deepEqual(row(sends[1]!.resendId), {
      delivered_at: CREATED_ISO, opened_at: CREATED_ISO, clicked_at: null, bounced_at: null, complained_at: null,
    });
    assert.deepEqual(row(sends[2]!.resendId), {
      delivered_at: CREATED_ISO, opened_at: null, clicked_at: null, bounced_at: null, complained_at: null,
    });
    assert.equal(row(sends[3]!.resendId).bounced_at, CREATED_ISO);
    assert.deepEqual(row(sends[4]!.resendId), {
      delivered_at: null, opened_at: null, clicked_at: null, bounced_at: null, complained_at: null,
    });
  });

  it('backfill does not suppress bounces', async () => {
    const { id, sends } = await sentCampaign(1);
    fake.records.set(sends[0]!.resendId, { lastEvent: 'bounced', createdAt: CREATED });
    await backfillCampaign(id, getDb(), { transport: fake, sleep: noSleep });
    const suppressed = getDb().prepare('SELECT COUNT(*) AS n FROM contact_suppressions').get() as { n: number };
    assert.equal(suppressed.n, 0);
  });

  it('backfill complaint turns off marketing', async () => {
    const { id, sends } = await sentCampaign(1);
    fake.records.set(sends[0]!.resendId, { lastEvent: 'complained', createdAt: CREATED });
    await backfillCampaign(id, getDb(), { transport: fake, sleep: noSleep });
    assert.equal(row(sends[0]!.resendId).complained_at, CREATED_ISO);
    assert.equal(isSubscribed(sends[0]!.email, 'product_updates'), false);
    assert.equal(isSubscribed(sends[0]!.email, 'account_notices'), true);
  });

  it('backfill is idempotent', async () => {
    const { id, sends } = await sentCampaign(2);
    applyResendEvent({ type: 'email.delivered', created_at: '2026-11-05T14:03:00.000Z', data: { email_id: sends[0]!.resendId } });
    for (const send of sends) fake.records.set(send.resendId, { lastEvent: 'delivered', createdAt: CREATED });
    await backfillCampaign(id, getDb(), { transport: fake, sleep: noSleep });
    const before = sends.map((send) => row(send.resendId));
    await backfillCampaign(id, getDb(), { transport: fake, sleep: noSleep });
    assert.deepEqual(sends.map((send) => row(send.resendId)), before);
    assert.equal(before[0]!.delivered_at, '2026-11-05T14:03:00.000Z');
  });

  it('backfill skips rows without a resend id', async () => {
    const { id, sends } = await sentCampaign(3);
    getDb().prepare(`UPDATE email_sends SET status = 'failed', resend_id = NULL WHERE resend_id = ?`).run(sends[0]!.resendId);
    await backfillCampaign(id, getDb(), { transport: fake, sleep: noSleep });
    assert.equal(fake.getEmailCalls.length, 2);
    assert.ok(!fake.getEmailCalls.includes(sends[0]!.resendId));
  });

  it('backfill retries a 429 and counts what it cannot read', async () => {
    const { id, sends } = await sentCampaign(2);
    fake.records.set(sends[0]!.resendId, new TransportError('Resend: rate limit', 429, true, 'rate_limit_exceeded'));
    fake.records.set(sends[1]!.resendId, new TransportError('Resend: not found', 404, false));
    const waits: number[] = [];
    const summary = await backfillCampaign(id, getDb(), { transport: fake, sleep: async (ms) => void waits.push(ms) });
    assert.equal(summary.read, 1);
    assert.equal(summary.errors, 1);
    assert.ok(waits.includes(5_000));
  });

  it('backfill output has no addresses', async () => {
    const { id, sends } = await sentCampaign(2);
    fake.records.set(sends[0]!.resendId, { lastEvent: 'bounced', createdAt: CREATED });
    const text = formatBackfillSummary(id, await backfillCampaign(id, getDb(), { transport: fake, sleep: noSleep }));
    assert.doesNotMatch(text, /@/);
    assert.match(text, /1 bounced\. Resend does not say hard or soft/);
  });

  it('reads Resend time formats', () => {
    assert.equal(resendTime(CREATED, 'x'), CREATED_ISO);
    assert.equal(resendTime('2026-11-05T14:02:11.000Z', 'x'), '2026-11-05T14:02:11.000Z');
    assert.equal(resendTime('nonsense', 'fallback'), 'fallback');
    assert.equal(resendTime(null, 'fallback'), 'fallback');
  });

  it('backfill marks a failed email failed, for retry', async () => {
    const { id, sends } = await sentCampaign(2);
    fake.records.set(sends[0]!.resendId, { lastEvent: 'failed', createdAt: CREATED });
    const summary = await backfillCampaign(id, getDb(), { transport: fake, sleep: noSleep });
    assert.equal(summary.failed, 1);
    const failed = getDb()
      .prepare(`SELECT status, error FROM email_sends WHERE resend_id = ?`)
      .get(sends[0]!.resendId) as { status: string; error: string };
    assert.deepEqual(failed, { status: 'failed', error: 'Resend could not send: no reason given' });
    assert.match(formatBackfillSummary(id, summary), /1 failed at Resend \(not sent\)/);
  });
});
