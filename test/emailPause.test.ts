import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb } from '../src/db/index.js';
import { suppressContact } from '../src/contacts/upsert.js';
import {
  cancelCampaign,
  createCampaign,
  getCampaign,
  listSends,
  pauseCampaign,
  prepareCampaign,
  resumeCampaign,
  startSend,
} from '../src/email/campaigns.js';
import { EmailError } from '../src/email/errors.js';
import { runEmailTick } from '../src/email/runner.js';
import { setTransportForTests } from '../src/email/transport.js';
import { createApp } from '../src/server/index.js';
import { PAYING_OWNERS, SENDING_ENV, retryable, saveSender, seedOwners, sendingSetup, type FakeTransport } from './emailHelpers.js';

async function prepared(count: number) {
  seedOwners(count);
  const created = createCampaign({ name: 'News', audience: PAYING_OWNERS, subject: 'Hi', body: 'Hello {{first_name|there}}' });
  await prepareCampaign(created.id);
  return created.id;
}

/** Tick until the loop has nothing to do. */
async function drain(max = 50): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    const outcome = await runEmailTick();
    if (outcome.kind === 'idle' || outcome.kind === 'finished') return;
  }
  assert.fail('runner did not settle');
}

function sendsByStatus(id: string): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM email_sends WHERE campaign_id = ? GROUP BY status')
    .all(id) as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

describe('pause and resume a send', () => {
  let fake: FakeTransport;
  beforeEach(() => {
    fake = sendingSetup();
    saveSender();
  });
  afterEach(() => {
    setTransportForTests(null);
    closeDb();
  });

  it('sends the first N, then pauses by itself', async () => {
    const id = await prepared(30);
    const started = startSend(id, 30, getDb(), Date.now, 10);
    assert.equal(started.pauseAt, 10);
    await drain();
    assert.deepEqual(fake.batches().map((call) => call.emails.length), [10]);
    const paused = getCampaign(id)!;
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseAt, null);
    assert.deepEqual(sendsByStatus(id), { sent: 10, queued: 20 });
    // A paused campaign is left alone.
    assert.equal((await runEmailTick()).kind, 'idle');
    assert.equal(fake.batches().length, 1);
  });

  it('resume sends the rest under the next batch keys', async () => {
    const id = await prepared(30);
    startSend(id, 30, getDb(), Date.now, 10);
    await drain();
    resumeCampaign(id);
    await drain();
    assert.deepEqual(fake.batches().map((call) => call.key), [`${id}:1`, `${id}:2`]);
    assert.deepEqual(fake.batches().map((call) => call.emails.length), [10, 20]);
    const done = getCampaign(id)!;
    assert.equal(done.status, 'sent');
    assert.equal(done.sentCount, 30);
  });

  it('resume can send only N more, then pause again', async () => {
    const id = await prepared(30);
    startSend(id, 30, getDb(), Date.now, 5);
    await drain();
    resumeCampaign(id, 10);
    await drain();
    assert.equal(getCampaign(id)!.status, 'paused');
    assert.deepEqual(sendsByStatus(id), { sent: 15, queued: 15 });
    resumeCampaign(id, 25);
    await drain();
    assert.equal(getCampaign(id)!.status, 'sent', 'asking for more than is left sends the rest');
  });

  it('a first batch over 100 goes out in batches of 100', async () => {
    const id = await prepared(250);
    startSend(id, 250, getDb(), Date.now, 150);
    await drain();
    assert.deepEqual(fake.batches().map((call) => call.emails.length), [100, 50]);
    assert.equal(getCampaign(id)!.status, 'paused');
  });

  it('a pause size of the whole list or more is a normal send', async () => {
    const id = await prepared(5);
    assert.equal(startSend(id, 5, getDb(), Date.now, 10).pauseAt, null);
    await drain();
    assert.equal(getCampaign(id)!.status, 'sent');
  });

  it('pause by hand stops after the batch in flight', async () => {
    const id = await prepared(250);
    startSend(id, 250);
    await runEmailTick();
    // Batch 2 hits a retryable error and stays in flight.
    fake.failures.push(retryable());
    assert.equal((await runEmailTick()).kind, 'retry');
    pauseCampaign(id);
    // The in-flight batch still finishes, with its own key, then the send stays paused.
    await drain();
    assert.deepEqual(fake.batches().map((call) => call.key), [`${id}:1`, `${id}:2`, `${id}:2`]);
    assert.equal(getCampaign(id)!.status, 'paused');
    assert.deepEqual(sendsByStatus(id), { sent: 200, queued: 50 });
    resumeCampaign(id);
    await drain();
    assert.equal(getCampaign(id)!.status, 'sent');
  });

  it('a pause during the last batch ends as sent', async () => {
    const id = await prepared(50);
    startSend(id, 50);
    fake.failures.push(retryable());
    await runEmailTick();
    // The only batch is in flight and nothing is queued: there is nothing to pause.
    assert.throws(() => pauseCampaign(id), (error: unknown) => error instanceof EmailError && error.status === 409);
    await drain();
    assert.equal(getCampaign(id)!.status, 'sent');
  });

  it('resume skips someone suppressed during the pause', async () => {
    const id = await prepared(12);
    startSend(id, 12, getDb(), Date.now, 10);
    await drain();
    const waiting = listSends(id, { status: 'queued' }).rows[0]!.email;
    suppressContact(waiting, { source: 'manual' });
    resumeCampaign(id);
    await drain();
    assert.deepEqual(sendsByStatus(id), { sent: 11, skipped: 1 });
  });

  it('cancel from paused skips what is left', async () => {
    const id = await prepared(30);
    startSend(id, 30, getDb(), Date.now, 10);
    await drain();
    const cancelled = cancelCampaign(id);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(sendsByStatus(id), { sent: 10, skipped: 20 });
    await drain();
    assert.equal(fake.batches().length, 1);
  });

  it('lists who got the email so far', async () => {
    const id = await prepared(30);
    startSend(id, 30, getDb(), Date.now, 5);
    await drain();
    const sent = listSends(id);
    assert.equal(sent.total, 5);
    assert.equal(sent.rows[0]!.email, 'owner001@example-shop1.test');
    assert.equal(sent.rows[0]!.name, 'Owner1');
    assert.equal(sent.rows[0]!.shopName, 'Example Candles Co');
    assert.ok(sent.rows[0]!.resendId);
    assert.equal(listSends(id, { status: 'queued' }).total, 25);
  });

  it('rejects a bad pause size and a resume that is not paused', async () => {
    const id = await prepared(5);
    assert.throws(() => startSend(id, 5, getDb(), Date.now, 0), (e: unknown) => e instanceof EmailError && e.status === 422);
    assert.throws(() => startSend(id, 5, getDb(), Date.now, 2.5), (e: unknown) => e instanceof EmailError && e.status === 422);
    assert.throws(() => resumeCampaign(id), (e: unknown) => e instanceof EmailError && e.status === 409);
  });
});

describe('pause API', () => {
  let server: Server;
  let origin: string;
  let cookie: string;
  beforeEach(async () => {
    sendingSetup();
    saveSender();
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: SENDING_ENV.DASHBOARD_PASSWORD }),
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });
  afterEach(() => {
    server.close();
    setTransportForTests(null);
    closeDb();
  });

  const post = (path: string, body: unknown = {}) =>
    fetch(`${origin}/api/email${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('starts with a pause, lists sends, resumes', async () => {
    const id = await prepared(20);
    const started = (await (await post(`/campaigns/${id}/send`, { confirmCount: 20, pauseAfter: 5 })).json()) as { pauseAt: number };
    assert.equal(started.pauseAt, 5);
    await drain();
    const sends = (await (await fetch(`${origin}/api/email/campaigns/${id}/sends`, { headers: { cookie } })).json()) as { total: number };
    assert.equal(sends.total, 5);
    const resumed = (await (await post(`/campaigns/${id}/resume`, {})).json()) as { status: string };
    assert.equal(resumed.status, 'sending');
    await drain();
    assert.equal((await post(`/campaigns/${id}/pause`)).status, 409, 'a sent campaign cannot pause');
  });
});
