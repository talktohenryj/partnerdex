import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb } from '../src/db/index.js';
import {
  createCampaign,
  failureGroups,
  getCampaign,
  IDEMPOTENCY_WINDOW_ERROR,
  listSends,
  markResendFailed,
  prepareCampaign,
  cancelCampaign,
  retryFailed,
  startSend,
} from '../src/email/campaigns.js';
import { EmailError } from '../src/email/errors.js';
import { emailHistory, lastEmailFor } from '../src/email/history.js';
import { runEmailTick, sentTodayUtc, type TickOutcome } from '../src/email/runner.js';
import { setTransportForTests } from '../src/email/transport.js';
import { sendWait } from '../src/email/wait.js';
import { applyResendEvent } from '../src/email/webhook.js';
import { PAYING_OWNERS, SENDING_ENV, quota, rejected, saveSender, seedOwners, sendingSetup, type FakeTransport } from './emailHelpers.js';

const DAY1 = Date.parse('2026-11-06T15:00:00.000Z');
const MIDNIGHT = Date.parse('2026-11-07T00:00:00.000Z');

async function prepared(name = 'News') {
  const created = createCampaign({ name, audience: PAYING_OWNERS, subject: `${name} subject`, body: 'Hello' });
  await prepareCampaign(created.id);
  return created.id;
}

/** Tick with a fixed clock until idle, finished, or waiting. */
async function drain(clock: () => number, max = 50): Promise<TickOutcome> {
  for (let i = 0; i < max; i += 1) {
    const outcome = await runEmailTick(getDb(), clock);
    if (outcome.kind === 'idle' || outcome.kind === 'finished' || outcome.kind === 'waiting') return outcome;
  }
  assert.fail('runner did not settle');
}

function statuses(id: string): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM email_sends WHERE campaign_id = ? GROUP BY status')
    .all(id) as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

function failRows(id: string, count: number, error: string, withResendId = false) {
  const emails = getDb()
    .prepare(`SELECT email FROM email_sends WHERE campaign_id = ? AND status = 'sent' ORDER BY email LIMIT ?`)
    .all(id, count) as Array<{ email: string }>;
  const update = getDb().prepare(
    `UPDATE email_sends SET status = 'failed', error = ?, resend_id = CASE WHEN ? THEN resend_id ELSE NULL END,
            sent_at = NULL WHERE campaign_id = ? AND email = ?`,
  );
  for (const { email } of emails) update.run(error, withResendId ? 1 : 0, id, email);
}

function rejects(status: number, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof EmailError, `expected EmailError, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

describe('Resend quota and the daily limit', () => {
  let fake: FakeTransport;
  afterEach(() => {
    setTransportForTests(null);
    closeDb();
  });

  it('resend batch reads the daily quota header', async () => {
    const { resendTransport } = await import('../src/email/resend.js');
    const original = globalThis.fetch;
    const reply = (headers: Record<string, string>) =>
      (async () => new Response(JSON.stringify({ data: [{ id: 're_1' }] }), { status: 200, headers })) as typeof fetch;
    const email = { from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't', html: 'h', headers: {} };
    try {
      globalThis.fetch = reply({ 'x-resend-daily-quota': '42' });
      assert.deepEqual(await resendTransport('re_test').sendBatch([email], 'k'), { ids: ['re_1'], dailyQuotaUsed: 42 });
      globalThis.fetch = reply({});
      assert.deepEqual(await resendTransport('re_test').sendBatch([email], 'k'), { ids: ['re_1'], dailyQuotaUsed: null });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('resend error name read into code', async () => {
    const { resendTransport } = await import('../src/email/resend.js');
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' }), {
        status: 429,
      })) as typeof fetch;
    try {
      await assert.rejects(resendTransport('re_test').sendOne({ from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't', html: 'h', headers: {} }), (error: unknown) => {
        const transport = error as { code: string; status: number; retryable: boolean };
        assert.equal(transport.code, 'daily_quota_exceeded');
        assert.equal(transport.status, 429);
        assert.equal(transport.retryable, true);
        return true;
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  describe('with a daily limit of 100', () => {
    beforeEach(() => {
      fake = sendingSetup({ ...SENDING_ENV, EMAIL_DAILY_LIMIT: '100' });
      saveSender();
    });

    it('daily limit caps the batch', async () => {
      seedOwners(231);
      const first = await prepared('First');
      // Send 60 and pause, so 60 of today's 100 are used.
      startSend(first, 231, getDb(), Date.now, 60);
      await drain(() => DAY1);
      assert.equal(sentTodayUtc(getDb(), () => DAY1), 60);
      // Resume the rest: only 40 go out today.
      const { resumeCampaign } = await import('../src/email/campaigns.js');
      resumeCampaign(first);
      const outcome = await drain(() => DAY1);
      assert.equal(outcome.kind, 'waiting');
      assert.deepEqual(fake.batches().map((call) => call.emails.length), [60, 40]);
      assert.equal(sentTodayUtc(getDb(), () => DAY1), 100);
    });

    it('daily limit waits until midnight utc', async () => {
      seedOwners(171);
      const id = await prepared();
      startSend(id, 171);
      const outcome = await drain(() => DAY1);
      assert.deepEqual(outcome, { kind: 'waiting', reason: 'daily_limit', until: new Date(MIDNIGHT).toISOString() });
      assert.deepEqual(fake.batches().map((call) => call.emails.length), [100]);
      assert.deepEqual(getCampaign(id)!.waiting, { reason: 'daily_limit', until: new Date(MIDNIGHT).toISOString() });
      assert.equal(getCampaign(id)!.status, 'sending');
      // Still the same day: nothing more goes out.
      assert.equal((await runEmailTick(getDb(), () => DAY1 + 3_600_000)).kind, 'waiting');
      assert.equal(fake.batches().length, 1);
      // Next UTC day: the rest.
      const done = await drain(() => MIDNIGHT + 60_000);
      assert.equal(done.kind, 'finished');
      assert.deepEqual(fake.batches().map((call) => call.emails.length), [100, 71]);
      assert.equal(getCampaign(id)!.status, 'sent');
      assert.equal(getCampaign(id)!.waiting, null);
    });

    it('daily limit uses resend count when it is higher', async () => {
      seedOwners(60);
      const id = await prepared();
      startSend(id, 60, getDb(), Date.now, 10);
      // Resend counts 80 more than PartnerDex: test sends and other apps count too.
      fake.dailyQuotaUsed = 80;
      await drain(() => DAY1);
      const { resumeCampaign } = await import('../src/email/campaigns.js');
      resumeCampaign(id);
      const outcome = await drain(() => DAY1);
      assert.equal(outcome.kind, 'waiting');
      assert.deepEqual(fake.batches().map((call) => call.emails.length), [10, 10]);
      // Next day the old count no longer applies.
      fake.dailyQuotaUsed = null;
      await drain(() => MIDNIGHT + 1_000);
      assert.deepEqual(fake.batches().map((call) => call.emails.length), [10, 10, 40]);
    });
  });

  describe('without a daily limit', () => {
    beforeEach(() => {
      fake = sendingSetup();
      saveSender();
    });

    it('daily quota requeues the batch', async () => {
      seedOwners(150);
      const id = await prepared();
      startSend(id, 150);
      await runEmailTick(getDb(), () => DAY1);
      fake.failures.push(quota('daily_quota_exceeded'));
      const outcome = await drain(() => DAY1);
      assert.deepEqual(outcome, { kind: 'waiting', reason: 'daily_quota', until: new Date(MIDNIGHT).toISOString() });
      assert.deepEqual(statuses(id), { sent: 100, queued: 50 });
      const queued = getDb()
        .prepare(`SELECT COUNT(*) AS n FROM email_sends WHERE campaign_id = ? AND status = 'queued' AND batch_key IS NULL AND error IS NULL`)
        .get(id) as { n: number };
      assert.equal(queued.n, 50);
      assert.equal(getCampaign(id)!.status, 'sending');
      assert.equal(getCampaign(id)!.waiting?.reason, 'daily_quota');
    });

    it('requeued batch sends under a new key next day', async () => {
      seedOwners(150);
      const id = await prepared();
      startSend(id, 150);
      await runEmailTick(getDb(), () => DAY1);
      fake.failures.push(quota('daily_quota_exceeded'));
      await drain(() => DAY1);
      const done = await drain(() => MIDNIGHT + 1_000);
      assert.equal(done.kind, 'finished');
      assert.deepEqual(fake.batches().map((call) => call.key), [`${id}:1`, `${id}:2`, `${id}:3`]);
      assert.deepEqual(statuses(id), { sent: 150 });
    });

    it('monthly quota requeues and waits an hour', async () => {
      seedOwners(20);
      const id = await prepared();
      startSend(id, 20);
      fake.failures.push(quota('monthly_quota_exceeded'));
      const outcome = await drain(() => DAY1);
      assert.deepEqual(outcome, { kind: 'waiting', reason: 'monthly_quota', until: new Date(DAY1 + 3_600_000).toISOString() });
      assert.deepEqual(statuses(id), { queued: 20 });
      assert.ok(sendWait(DAY1 + 1_000));
      assert.equal(sendWait(DAY1 + 3_600_000), null);
    });

    it('rate limit keeps the s3 backoff', async () => {
      seedOwners(20);
      const id = await prepared();
      startSend(id, 20);
      fake.failures.push(quota('rate_limit_exceeded'));
      const outcome = await runEmailTick(getDb(), () => DAY1);
      assert.equal(outcome.kind, 'retry');
      assert.deepEqual(statuses(id), { sending: 20 });
      await drain(() => DAY1);
      assert.deepEqual(fake.batches().map((call) => call.key), [`${id}:1`, `${id}:1`]);
    });
  });
});

describe('Resend email.failed', () => {
  let fake: FakeTransport;
  beforeEach(() => {
    fake = sendingSetup();
    saveSender();
  });
  afterEach(() => {
    setTransportForTests(null);
    closeDb();
  });

  async function sentCampaign(count: number) {
    seedOwners(count);
    const id = await prepared();
    startSend(id, count);
    await drain(() => DAY1);
    const ids = getDb()
      .prepare(`SELECT resend_id AS id FROM email_sends WHERE campaign_id = ? ORDER BY email`)
      .all(id) as Array<{ id: string }>;
    return { id, resendIds: ids.map((row) => row.id) };
  }

  it('reached_daily_quota requeues the email and opens the campaign again', async () => {
    const { id, resendIds } = await sentCampaign(5);
    assert.equal(getCampaign(id)!.status, 'sent');
    const result = applyResendEvent({
      type: 'email.failed',
      data: { email_id: resendIds[0], failed: { reason: 'reached_daily_quota' } },
    });
    assert.equal(result, 'written');
    assert.deepEqual(statuses(id), { sent: 4, queued: 1 });
    const campaign = getCampaign(id)!;
    assert.equal(campaign.status, 'sending');
    assert.equal(campaign.finishedAt, null);
    assert.equal(campaign.waiting?.reason, 'daily_quota');
    const row = getDb().prepare(`SELECT resend_id, sent_at FROM email_sends WHERE campaign_id = ? AND status = 'queued'`).get(id) as {
      resend_id: string | null;
      sent_at: string | null;
    };
    assert.deepEqual(row, { resend_id: null, sent_at: null });
    // After 00:00 UTC it goes out under a new key.
    const after = Date.parse(sendWait()!.until) + 1_000;
    const done = await drain(() => after);
    assert.equal(done.kind, 'finished');
    assert.deepEqual(statuses(id), { sent: 5 });
    assert.equal(fake.batches().at(-1)!.emails.length, 1);
  });

  it('another reason fails the email for retry failed', async () => {
    const { id, resendIds } = await sentCampaign(3);
    applyResendEvent({ type: 'email.failed', data: { email_id: resendIds[1], failed: { reason: 'invalid_recipient' } } });
    assert.deepEqual(statuses(id), { sent: 2, failed: 1 });
    assert.equal(getCampaign(id)!.status, 'sent');
    const groups = failureGroups(id);
    assert.deepEqual(groups.map((group) => [group.error, group.count, group.rejected]), [
      ['Resend could not send: invalid_recipient', 1, true],
    ]);
    retryFailed(id, ['Resend could not send: invalid_recipient'], 1);
    await drain(() => DAY1 + 1_000);
    assert.deepEqual(statuses(id), { sent: 3 });
  });

  it('a cancelled campaign is not opened again', async () => {
    seedOwners(30);
    const id = await prepared();
    startSend(id, 30, getDb(), Date.now, 10);
    await drain(() => DAY1);
    cancelCampaign(id);
    const resendId = (getDb().prepare(`SELECT resend_id AS id FROM email_sends WHERE campaign_id = ? AND status = 'sent' LIMIT 1`).get(id) as { id: string }).id;
    assert.equal(markResendFailed(resendId, 'reached_daily_quota'), 'failed');
    assert.equal(getCampaign(id)!.status, 'cancelled');
    assert.equal(statuses(id).failed, 1);
  });

  it('an unknown or already failed email is left alone', async () => {
    const { resendIds } = await sentCampaign(1);
    assert.equal(markResendFailed('not-ours', 'reached_daily_quota'), 'unknown_email');
    assert.equal(markResendFailed(resendIds[0]!, 'invalid_recipient'), 'failed');
    assert.equal(markResendFailed(resendIds[0]!, 'reached_daily_quota'), 'not_sent');
  });
});

describe('retry failed', () => {
  let fake: FakeTransport;
  beforeEach(() => {
    fake = sendingSetup();
    saveSender();
  });
  afterEach(() => {
    setTransportForTests(null);
    closeDb();
  });

  async function sentWithFailures() {
    seedOwners(10);
    const id = await prepared();
    startSend(id, 10);
    await drain(() => DAY1);
    failRows(id, 3, IDEMPOTENCY_WINDOW_ERROR);
    getDb().prepare(`UPDATE email_campaigns SET status = 'sent' WHERE id = ?`).run(id);
    return id;
  }

  it('retry failed requeues only failed rows', async () => {
    const id = await sentWithFailures();
    assert.throws(() => retryFailed(id, [IDEMPOTENCY_WINDOW_ERROR], 2), rejects(400, /^Type 3 to confirm\.$/));
    const campaign = retryFailed(id, [IDEMPOTENCY_WINDOW_ERROR], 3);
    assert.equal(campaign.status, 'sending');
    assert.deepEqual(statuses(id), { sent: 7, queued: 3 });
    await drain(() => DAY1 + 1_000);
    assert.equal(fake.batches().at(-1)!.key, `${id}:2`);
    assert.equal(fake.batches().at(-1)!.emails.length, 3);
    assert.deepEqual(statuses(id), { sent: 10 });
    assert.equal(getCampaign(id)!.status, 'sent');
  });

  it('retry failed by chosen error groups', async () => {
    const id = await sentWithFailures();
    const invalid = 'Resend: Invalid `to` field.';
    getDb()
      .prepare(`UPDATE email_sends SET status = 'failed', error = ?, resend_id = NULL WHERE campaign_id = ? AND status = 'sent' AND email IN (SELECT email FROM email_sends WHERE campaign_id = ? AND status = 'sent' ORDER BY email LIMIT 2)`)
      .run(invalid, id, id);
    const groups = failureGroups(id);
    assert.deepEqual(groups, [
      { error: IDEMPOTENCY_WINDOW_ERROR, count: 3, uncertain: true, rejected: false },
      { error: invalid, count: 2, uncertain: false, rejected: true },
    ]);
    retryFailed(id, [IDEMPOTENCY_WINDOW_ERROR], 3);
    assert.deepEqual(statuses(id), { sent: 5, queued: 3, failed: 2 });
  });

  it('retry failed skips rows with a resend id', async () => {
    seedOwners(4);
    const id = await prepared();
    startSend(id, 4);
    await drain(() => DAY1);
    failRows(id, 1, 'Resend: something odd', true);
    failRows(id, 1, 'Resend: something odd');
    getDb().prepare(`UPDATE email_campaigns SET status = 'sent' WHERE id = ?`).run(id);
    assert.deepEqual(failureGroups(id).map((group) => group.count), [1]);
    retryFailed(id, ['Resend: something odd'], 1);
    assert.deepEqual(statuses(id), { sent: 2, failed: 1, queued: 1 });
  });

  it('retry failed rejects a wrong count', async () => {
    const id = await sentWithFailures();
    assert.throws(() => retryFailed(id, [IDEMPOTENCY_WINDOW_ERROR], '4'), rejects(400));
    assert.throws(() => retryFailed(id, [IDEMPOTENCY_WINDOW_ERROR], true), rejects(400));
    assert.throws(() => retryFailed(id, [], 3), rejects(422));
    assert.throws(() => retryFailed(id, ['no such error'], 0), rejects(409));
    assert.deepEqual(statuses(id), { sent: 7, failed: 3 });
  });

  it('retry failed only on sent or failed campaigns', async () => {
    seedOwners(3);
    const draft = createCampaign({ name: 'Draft', audience: PAYING_OWNERS, subject: 'Hi', body: 'Hello' });
    assert.throws(() => retryFailed(draft.id, ['x'], 1), rejects(409));
    const id = await prepared();
    startSend(id, 3);
    assert.throws(() => retryFailed(id, ['x'], 1), rejects(409, /sending/));
  });

  it('failure groups mark idempotency window as uncertain', async () => {
    const id = await sentWithFailures();
    assert.deepEqual(failureGroups(id), [{ error: IDEMPOTENCY_WINDOW_ERROR, count: 3, uncertain: true, rejected: false }]);
  });

  it('a non-retryable error is still a group', async () => {
    seedOwners(3);
    const id = await prepared();
    startSend(id, 3);
    fake.failures.push(rejected());
    await drain(() => DAY1);
    assert.equal(getCampaign(id)!.status, 'failed');
    assert.deepEqual(failureGroups(id), [{ error: 'Resend: invalid from address', count: 3, uncertain: false, rejected: true }]);
    retryFailed(id, ['Resend: invalid from address'], 3);
    await drain(() => DAY1);
    assert.equal(getCampaign(id)!.status, 'sent');
  });
});

describe('campaign report and history', () => {
  beforeEach(() => {
    sendingSetup();
    saveSender();
  });
  afterEach(() => {
    setTransportForTests(null);
    closeDb();
  });

  function stamp(id: string, column: string, count: number) {
    getDb()
      .prepare(
        `UPDATE email_sends SET ${column} = '2026-11-06T16:00:00.000Z'
          WHERE campaign_id = ? AND email IN (SELECT email FROM email_sends WHERE campaign_id = ? AND status = 'sent' ORDER BY email LIMIT ?)`,
      )
      .run(id, id, count);
  }

  it('campaign stats and rates', async () => {
    seedOwners(171);
    const id = await prepared();
    startSend(id, 171);
    await drain(() => DAY1);
    stamp(id, 'delivered_at', 165);
    stamp(id, 'opened_at', 88);
    stamp(id, 'clicked_at', 40);
    stamp(id, 'bounced_at', 6);
    stamp(id, 'unsubscribed_at', 3);
    const campaign = getCampaign(id)!;
    assert.deepEqual(campaign.stats, {
      sent: 171, delivered: 165, opened: 88, clicked: 40, bounced: 6, complained: 0, unsubscribed: 3, failed: 0, skipped: 0,
    });
    assert.equal((campaign.rates.click! * 100).toFixed(1), '24.2');
    assert.equal((campaign.rates.open! * 100).toFixed(1), '53.3');
    assert.equal((campaign.rates.bounce! * 100).toFixed(1), '3.5');
    assert.equal(campaign.rates.unsubscribe, 3 / 165);
  });

  it('recipients filter by event', async () => {
    seedOwners(5);
    const id = await prepared();
    startSend(id, 5);
    await drain(() => DAY1);
    stamp(id, 'clicked_at', 2);
    const clicked = listSends(id, { status: 'clicked' });
    assert.equal(clicked.total, 2);
    assert.ok(clicked.rows.every((row) => row.clickedAt));
    assert.equal(listSends(id, { status: 'all' }).total, 5);
    assert.equal(listSends(id, { status: 'bounced' }).total, 0);
    const search = listSends(id, { status: 'all', q: 'owner003' });
    assert.deepEqual(search.rows.map((row) => row.email), ['owner003@example-shop3.test']);
    assert.equal(listSends(id, { status: 'all', q: '%' }).total, 0);
  });

  it('history newest first', async () => {
    seedOwners(2);
    const first = await prepared('First');
    startSend(first, 2);
    await drain(() => DAY1);
    const second = await prepared('Second');
    startSend(second, 2);
    await drain(() => DAY1 + 86_400_000);
    const history = emailHistory('Owner001@example-shop1.test');
    assert.deepEqual(history.map((entry) => entry.name), ['Second', 'First']);
    assert.equal(history[0]!.status, 'sent');
  });

  it('last email for a page of contacts', async () => {
    seedOwners(3);
    const first = await prepared('First');
    startSend(first, 3);
    await drain(() => DAY1);
    const second = await prepared('Second');
    startSend(second, 3);
    await drain(() => DAY1 + 86_400_000);
    const last = lastEmailFor(['owner001@example-shop1.test', 'OWNER002@example-shop2.test', 'nobody@example.test']);
    assert.deepEqual(Object.keys(last).sort(), ['owner001@example-shop1.test', 'owner002@example-shop2.test']);
    assert.equal(last['owner001@example-shop1.test']!.name, 'Second');
  });
});
