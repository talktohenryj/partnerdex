import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb } from '../src/db/index.js';
import { createCampaign, prepareCampaign, startSend } from '../src/email/campaigns.js';
import { isSubscribed } from '../src/email/preferences.js';
import { runEmailTick } from '../src/email/runner.js';
import { setTransportForTests } from '../src/email/transport.js';
import { applyResendEvent, signResendPayload, verifyResendSignature } from '../src/email/webhook.js';
import { createApp } from '../src/server/index.js';
import { PAYING_OWNERS, SENDING_ENV, saveSender, seedOwners, sendingSetup } from './emailHelpers.js';

const WEBHOOK_SECRET = `whsec_${Buffer.from('test-webhook-signing-key-0123456789').toString('base64')}`;
const WEBHOOK_ENV = { ...SENDING_ENV, RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET };

function signed(payload: unknown, options: { secret?: string; at?: number; id?: string } = {}) {
  const raw = JSON.stringify(payload);
  const timestamp = String(Math.floor((options.at ?? Date.now()) / 1000));
  const id = options.id ?? 'msg_test_1';
  const signature = signResendPayload(options.secret ?? WEBHOOK_SECRET, id, timestamp, raw);
  return {
    raw,
    headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } as Record<string, string>,
  };
}

/** A sent campaign of `count` owners; returns the resend ids in address order. */
async function sentCampaign(count: number): Promise<{ id: string; sends: Array<{ email: string; resendId: string }> }> {
  saveSender();
  seedOwners(count);
  const created = createCampaign({ name: 'News', audience: PAYING_OWNERS, subject: 'Hi', body: 'Hello' });
  await prepareCampaign(created.id);
  startSend(created.id, count);
  for (let i = 0; i < 10; i += 1) {
    const outcome = await runEmailTick();
    if (outcome.kind === 'finished') break;
  }
  const sends = getDb()
    .prepare('SELECT email, resend_id AS resendId FROM email_sends WHERE campaign_id = ? ORDER BY email')
    .all(created.id) as Array<{ email: string; resendId: string }>;
  return { id: created.id, sends };
}

function sendRow(resendId: string) {
  return getDb()
    .prepare('SELECT delivered_at, bounced_at, complained_at, opened_at, clicked_at FROM email_sends WHERE resend_id = ?')
    .get(resendId) as Record<string, string | null>;
}

function suppression(email: string) {
  return getDb().prepare('SELECT source, reason FROM contact_suppressions WHERE email = ?').get(email) as
    | { source: string; reason: string | null }
    | undefined;
}

describe('Resend webhook signature', () => {
  it('accepts any matching v1 signature', () => {
    const { raw, headers } = signed({ type: 'email.delivered' });
    headers['svix-signature'] = `v1,bm90LXRoZS1zaWduYXR1cmU= ${headers['svix-signature']}`;
    assert.equal(verifyResendSignature(Buffer.from(raw), headers, WEBHOOK_SECRET), true);
  });

  it('rejects bad signature', () => {
    const { raw, headers } = signed({ type: 'email.delivered' }, { secret: `whsec_${Buffer.from('another').toString('base64')}` });
    assert.equal(verifyResendSignature(Buffer.from(raw), headers, WEBHOOK_SECRET), false);
    const good = signed({ type: 'email.delivered' });
    assert.equal(verifyResendSignature(Buffer.from(`${good.raw} `), good.headers, WEBHOOK_SECRET), false);
    assert.equal(verifyResendSignature(Buffer.from(good.raw), {}, WEBHOOK_SECRET), false);
  });

  it('rejects old timestamp', () => {
    const { raw, headers } = signed({ type: 'email.delivered' }, { at: Date.now() - 10 * 60_000 });
    assert.equal(verifyResendSignature(Buffer.from(raw), headers, WEBHOOK_SECRET), false);
  });
});

describe('Resend webhook events', () => {
  beforeEach(() => {
    sendingSetup(WEBHOOK_ENV);
  });
  afterEach(() => {
    setTransportForTests(null);
    closeDb();
  });

  it('delivered stamps once', async () => {
    const { sends } = await sentCampaign(1);
    const resendId = sends[0]!.resendId;
    applyResendEvent({ type: 'email.delivered', created_at: '2026-11-06T10:00:00.000Z', data: { email_id: resendId } });
    applyResendEvent({ type: 'email.delivered', created_at: '2026-11-06T11:00:00.000Z', data: { email_id: resendId } });
    assert.equal(sendRow(resendId).delivered_at, '2026-11-06T10:00:00.000Z');
  });

  it('hard bounce suppresses', async () => {
    const { sends } = await sentCampaign(1);
    const { email, resendId } = sends[0]!;
    applyResendEvent({ type: 'email.bounced', data: { email_id: resendId, bounce: { type: 'Permanent' } } });
    assert.ok(sendRow(resendId).bounced_at);
    assert.deepEqual(suppression(email), { source: 'resend_webhook', reason: 'hard bounce' });
    const contact = getDb().prepare('SELECT is_suppressed FROM contacts WHERE email = ?').get(email) as { is_suppressed: number };
    assert.equal(contact.is_suppressed, 1);
  });

  it('soft bounce does not suppress', async () => {
    const { sends } = await sentCampaign(1);
    const { email, resendId } = sends[0]!;
    applyResendEvent({ type: 'email.bounced', data: { email_id: resendId, bounce: { type: 'Transient' } } });
    assert.ok(sendRow(resendId).bounced_at);
    assert.equal(suppression(email), undefined);
  });

  it('complaint turns off marketing types only', async () => {
    const { sends } = await sentCampaign(1);
    const { email, resendId } = sends[0]!;
    applyResendEvent({ type: 'email.complained', data: { email_id: resendId } });
    assert.ok(sendRow(resendId).complained_at);
    assert.equal(isSubscribed(email, 'product_updates'), false);
    assert.equal(isSubscribed(email, 'weekly_recap'), false);
    assert.equal(isSubscribed(email, 'account_notices'), true);
    assert.equal(suppression(email), undefined);
  });

  it('opened and clicked keep the first time', async () => {
    const { sends } = await sentCampaign(1);
    const resendId = sends[0]!.resendId;
    applyResendEvent({ type: 'email.opened', created_at: '2026-11-06T10:00:00Z', data: { email_id: resendId } });
    applyResendEvent({ type: 'email.opened', created_at: '2026-11-06T12:00:00Z', data: { email_id: resendId } });
    applyResendEvent({ type: 'email.clicked', created_at: '2026-11-06T10:05:00Z', data: { email_id: resendId } });
    const row = sendRow(resendId);
    assert.equal(row.opened_at, '2026-11-06T10:00:00.000Z');
    assert.equal(row.clicked_at, '2026-11-06T10:05:00.000Z');
  });

  it('unknown email id ignored', async () => {
    await sentCampaign(1);
    assert.equal(applyResendEvent({ type: 'email.delivered', data: { email_id: 'not-ours' } }), 'unknown_email');
    assert.equal(applyResendEvent({ type: 'email.sent', data: { email_id: 'not-ours' } }), 'ignored');
    const stamped = getDb().prepare('SELECT COUNT(delivered_at) AS n FROM email_sends').get() as { n: number };
    assert.equal(stamped.n, 0);
  });
});

describe('Resend webhook route', () => {
  let server: Server;
  let origin: string;

  async function listen(env: Record<string, string>) {
    sendingSetup(env);
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const post = (raw: string, headers: Record<string, string>) =>
    fetch(`${origin}/api/email/webhooks/resend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    });

  afterEach(() => {
    server?.close();
    setTransportForTests(null);
    closeDb();
  });

  it('webhook disabled without secret', async () => {
    await listen(SENDING_ENV);
    const { raw, headers } = signed({ type: 'email.delivered', data: { email_id: 'x' } });
    assert.equal((await post(raw, headers)).status, 503);
  });

  it('rejects a bad signature with 401 and writes nothing', async () => {
    await listen(WEBHOOK_ENV);
    const { sends } = await sentCampaign(1);
    const { raw, headers } = signed({ type: 'email.delivered', data: { email_id: sends[0]!.resendId } });
    headers['svix-signature'] = 'v1,bm9wZQ==';
    assert.equal((await post(raw, headers)).status, 401);
    const old = signed({ type: 'email.delivered', data: { email_id: sends[0]!.resendId } }, { at: Date.now() - 10 * 60_000 });
    assert.equal((await post(old.raw, old.headers)).status, 401);
    assert.equal(sendRow(sends[0]!.resendId).delivered_at, null);
  });

  it('applies a signed event without a dashboard session', async () => {
    await listen(WEBHOOK_ENV);
    const { sends } = await sentCampaign(1);
    const { raw, headers } = signed({ type: 'email.delivered', data: { email_id: sends[0]!.resendId } });
    assert.equal((await post(raw, headers)).status, 200);
    assert.ok(sendRow(sends[0]!.resendId).delivered_at);
  });

  it('handler error still returns 200', async () => {
    await listen(WEBHOOK_ENV);
    const { raw, headers } = signed({});
    const broken = `${raw.slice(0, -1)}`;
    const resigned = signResendPayload(WEBHOOK_SECRET, headers['svix-id']!, headers['svix-timestamp']!, broken);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const response = await post(broken, { ...headers, 'svix-signature': `v1,${resigned}` });
      assert.equal(response.status, 200);
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
  });
});
