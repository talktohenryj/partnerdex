import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb } from '../src/db/index.js';
import { getConfig } from '../src/config.js';
import { suppressContact } from '../src/contacts/upsert.js';
import {
  cancelCampaign,
  createCampaign,
  getCampaign,
  prepareCampaign,
  sendTest,
  startSend,
  updateCampaign,
} from '../src/email/campaigns.js';
import { EmailError } from '../src/email/errors.js';
import { setPreferences } from '../src/email/preferences.js';
import { runEmailTick, startEmailRunner, stopEmailRunner } from '../src/email/runner.js';
import { setTransportForTests } from '../src/email/transport.js';
import { createApp } from '../src/server/index.js';
import { saveAppLinks } from '../src/apps/links.js';
import {
  PAYING_OWNERS,
  SENDING_ENV,
  rejected,
  retryable,
  saveSender,
  seedOwners,
  sendingSetup,
  type FakeTransport,
} from './emailHelpers.js';

function rejects(status: number, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof EmailError, `expected EmailError, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

function campaign(body = 'Hi {{first_name|there}},\n\nNews for {{shop_name}}.') {
  return createCampaign({ name: 'Q4 ideas', audience: PAYING_OWNERS, subject: '{{first_name|Hi}}, 3 ideas', body });
}

async function prepared(count: number, body?: string) {
  seedOwners(count);
  const created = campaign(body);
  const result = await prepareCampaign(created.id);
  return { id: created.id, result };
}

async function drain(fake: FakeTransport, max = 50): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    const outcome = await runEmailTick();
    if (outcome.kind === 'idle' || outcome.kind === 'finished') return;
  }
  assert.fail(`runner did not finish; ${fake.calls.length} calls`);
}

function rows(id: string) {
  return getDb()
    .prepare('SELECT email, status, skip_reason, batch_key, resend_id, error FROM email_sends WHERE campaign_id = ? ORDER BY email')
    .all(id) as Array<{ email: string; status: string; skip_reason: string | null; batch_key: string | null; resend_id: string | null; error: string | null }>;
}

describe('email sending guard', () => {
  afterEach(() => {
    stopEmailRunner();
    setTransportForTests(null);
    closeDb();
  });

  it('sending blocked without dashboard password', async () => {
    sendingSetup({ ...SENDING_ENV, DASHBOARD_PASSWORD: '' });
    saveSender();
    seedOwners(1);
    const created = campaign();
    await assert.rejects(prepareCampaign(created.id), rejects(403, /^Set DASHBOARD_PASSWORD before sending email\.$/));
    assert.equal(startEmailRunner(), 'Set DASHBOARD_PASSWORD before sending email.', 'runner not started');
  });

  it('sending blocked without resend key', async () => {
    sendingSetup({ ...SENDING_ENV, RESEND_API_KEY: '' });
    saveSender();
    seedOwners(1);
    const created = campaign();
    await assert.rejects(prepareCampaign(created.id), rejects(403, /RESEND_API_KEY/));
    await assert.rejects(sendTest(created.id, 'me@example.com'), rejects(403, /RESEND_API_KEY/));
  });

  it('blank sender settings block sending', async () => {
    sendingSetup();
    seedOwners(1);
    const created = campaign();
    await assert.rejects(prepareCampaign(created.id), rejects(403, /Fill in the sender settings/));
  });

  it('prepare blocked when domain unverified', async () => {
    const fake = sendingSetup();
    saveSender();
    seedOwners(1);
    fake.domain = 'pending';
    const created = campaign();
    await assert.rejects(prepareCampaign(created.id), rejects(422, /updates\.example\.com is pending/));
    fake.domain = 'not_found';
    await assert.rejects(prepareCampaign(created.id), rejects(422, /not in your Resend account/));
  });

  it('a public base url must be https', () => {
    sendingSetup({ ...SENDING_ENV, PUBLIC_BASE_URL: 'http://partnerdex.example.com' });
    assert.throws(() => getConfig(), /PUBLIC_BASE_URL must use https/);
    sendingSetup({ ...SENDING_ENV, EMAIL_LINK_SECRET: 'short' });
    assert.throws(() => getConfig(), /EMAIL_LINK_SECRET must be at least 32/);
    sendingSetup({ ...SENDING_ENV, PUBLIC_BASE_URL: 'https://partnerdex.example.com/' });
    assert.equal(getConfig().email.publicBaseUrl, 'https://partnerdex.example.com');
  });
});

describe('campaign prepare and send', () => {
  let fake: FakeTransport;
  beforeEach(() => {
    fake = sendingSetup();
    saveSender();
  });
  afterEach(() => {
    stopEmailRunner();
    setTransportForTests(null);
    closeDb();
  });

  it('unknown merge field rejected on save', () => {
    seedOwners(1);
    assert.throws(() => campaign('Hello {{company}}'), rejects(422, /Unknown merge field \{\{company\}\}/));
  });

  it('prepare freezes recipients and snapshots sender', async () => {
    const { id, result } = await prepared(3);
    assert.equal(result.count, 3);
    assert.equal(result.sample.length, 3);
    assert.equal(result.from, '"Sam from Example App" <sam@updates.example.com>');
    const after = getCampaign(id)!;
    assert.equal(after.status, 'ready');
    assert.equal(after.recipientCount, 3);
    assert.equal(after.sender?.fromEmail, 'sam@updates.example.com');
    assert.equal(after.counts.queued, 3);

    // Changing the settings later does not touch the snapshot.
    saveSender();
    getDb().prepare(`UPDATE email_settings SET from_name = 'Someone else'`).run();
    assert.equal(getCampaign(id)!.sender?.fromName, 'Sam from Example App');
  });

  it('edit after prepare returns to draft', async () => {
    const { id } = await prepared(2);
    const edited = updateCampaign(id, { subject: 'New subject' });
    assert.equal(edited.status, 'draft');
    assert.equal(edited.recipientCount, 0);
    assert.equal(rows(id).length, 0, 'queued rows gone');
    // A rename alone keeps the list.
    await prepareCampaign(id);
    assert.equal(updateCampaign(id, { name: 'Renamed' }).status, 'ready');
  });

  it('confirm count must match', async () => {
    const { id } = await prepared(3);
    assert.throws(() => startSend(id, 2), rejects(409, /^Type 3 to confirm\.$/));
    assert.equal(fake.batches().length, 0, 'nothing sent');
    assert.equal(getCampaign(id)!.status, 'ready');
  });

  it('stale prepare rejected', async () => {
    const { id } = await prepared(1);
    const later = () => Date.now() + 61 * 60_000;
    assert.throws(() => startSend(id, 1, getDb(), later), rejects(409, /Prepare it again/));
  });

  it('missing first names are counted when there is no fallback', async () => {
    seedOwners(3, (index) => (index === 2 ? null : `Owner${index}`));
    const created = campaign('Hi {{first_name}}');
    const result = await prepareCampaign(created.id);
    assert.equal(result.missingFirstName, 1);
    const withFallback = campaign('Hi {{first_name|there}}');
    assert.equal((await prepareCampaign(withFallback.id)).missingFirstName, 0);
  });

  it('sends in batches of 100 with sequential keys', async () => {
    const { id } = await prepared(250);
    startSend(id, 250);
    await drain(fake);
    const batches = fake.batches();
    assert.deepEqual(batches.map((call) => call.emails.length), [100, 100, 50]);
    assert.deepEqual(batches.map((call) => call.key), [`${id}:1`, `${id}:2`, `${id}:3`]);
    const done = getCampaign(id)!;
    assert.equal(done.status, 'sent');
    assert.equal(done.sentCount, 250);
    assert.ok(done.finishedAt);
    const email = batches[0]!.emails[0]!;
    assert.equal(email.from, '"Sam from Example App" <sam@updates.example.com>');
    assert.equal(email.replyTo, 'sam@example.com');
    assert.equal(email.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(email.headers['List-Unsubscribe']!, /^<https:\/\/partnerdex\.example\.com\/p\/[^>]+\/one-click>$/);
    assert.ok(email.text.includes('123 Placeholder St'));
    assert.ok(email.html.includes('123 Placeholder St'));
    assert.match(email.subject, /^Owner\d+, 3 ideas$/);
  });

  it('resumes a sending batch with the same key after restart', async () => {
    const { id } = await prepared(250);
    startSend(id, 250);
    await runEmailTick();
    // The process dies after batch 2 is marked sending, before the response.
    fake.failures.push(new Error('process killed') as never);
    const died = await runEmailTick();
    assert.equal(died.kind, 'retry');
    assert.equal(rows(id).filter((row) => row.status === 'sending').length, 100);

    await drain(fake);
    const keys = fake.batches().map((call) => call.key);
    assert.deepEqual(keys, [`${id}:1`, `${id}:2`, `${id}:2`, `${id}:3`]);
    assert.deepEqual(
      fake.batches()[1]!.emails.map((email) => email.to),
      fake.batches()[2]!.emails.map((email) => email.to),
      'the same rows are re-posted',
    );
    const all = rows(id);
    assert.equal(all.filter((row) => row.status === 'queued').length, 0);
    assert.equal(all.filter((row) => row.status === 'sent').length, 250);
    const byKey = new Map<string, Set<string>>();
    for (const row of all) {
      const owners = byKey.get(row.email) ?? new Set();
      owners.add(row.batch_key!);
      byKey.set(row.email, owners);
    }
    assert.ok([...byKey.values()].every((set) => set.size === 1), 'no recipient in two batch keys');
  });

  it('retryable error keeps rows sending', async () => {
    const { id } = await prepared(3);
    startSend(id, 3);
    fake.failures.push(retryable());
    const first = await runEmailTick();
    assert.equal(first.kind, 'retry');
    assert.ok(rows(id).every((row) => row.status === 'sending'));
    await drain(fake);
    assert.deepEqual(fake.batches().map((call) => call.key), [`${id}:1`, `${id}:1`]);
    assert.equal(getCampaign(id)!.status, 'sent');
  });

  it('non-retryable error fails the batch only', async () => {
    const { id } = await prepared(150);
    startSend(id, 150);
    fake.failures.push(rejected());
    await drain(fake);
    const all = rows(id);
    assert.equal(all.filter((row) => row.status === 'failed').length, 100);
    assert.ok(all.filter((row) => row.status === 'failed').every((row) => row.error === 'Resend: invalid from address'));
    assert.equal(all.filter((row) => row.status === 'sent').length, 50);
    const done = getCampaign(id)!;
    assert.equal(done.status, 'sent');
    assert.equal(done.failedCount, 100);
  });

  it('every row failing marks the campaign failed', async () => {
    const { id } = await prepared(2);
    startSend(id, 2);
    fake.failures.push(rejected());
    await drain(fake);
    assert.equal(getCampaign(id)!.status, 'failed');
  });

  it('suppressed after prepare is skipped', async () => {
    const { id } = await prepared(3);
    const target = rows(id)[0]!.email;
    suppressContact(target, { source: 'manual' });
    startSend(id, 3);
    await drain(fake);
    const row = rows(id).find((entry) => entry.email === target)!;
    assert.equal(row.status, 'skipped');
    assert.equal(row.skip_reason, 'suppressed');
    assert.equal(fake.batches()[0]!.emails.length, 2);
    assert.equal(getCampaign(id)!.skippedCount, 1);
  });

  it('unsubscribed from the type mid-send is skipped', async () => {
    const { id } = await prepared(2);
    const target = rows(id)[0]!.email;
    setPreferences(target, { product_updates: false }, 'one_click');
    startSend(id, 2);
    await drain(fake);
    const row = rows(id).find((entry) => entry.email === target)!;
    assert.equal(row.status, 'skipped');
    assert.equal(fake.batches()[0]!.emails.length, 1);
  });

  it('prepare skips turned off type', async () => {
    seedOwners(3);
    setPreferences('owner001@example-shop1.test', { product_updates: false }, 'preference_page');
    const created = campaign();
    const result = await prepareCampaign(created.id);
    assert.equal(result.count, 2);
    assert.equal(result.excluded.unsubscribedType, 1);
    assert.equal(result.typeLabel, 'Product updates');
    const row = rows(created.id).find((entry) => entry.email === 'owner001@example-shop1.test')!;
    assert.equal(row.status, 'skipped');
    assert.equal(row.skip_reason, 'unsubscribed_type');
    // Account notices cannot be turned off, so the same person is included.
    const notice = createCampaign({ name: 'Billing', audience: PAYING_OWNERS, subject: 'Billing', body: 'Hi', emailType: 'account_notices' });
    assert.equal((await prepareCampaign(notice.id)).count, 3);
  });

  it('cancel skips queued rows', async () => {
    const { id } = await prepared(250);
    startSend(id, 250);
    await runEmailTick();
    cancelCampaign(id);
    await drain(fake);
    assert.equal(fake.batches().length, 1);
    const done = getCampaign(id)!;
    assert.equal(done.status, 'cancelled');
    assert.equal(done.sentCount, 100);
    assert.equal(rows(id).filter((row) => row.skip_reason === 'cancelled').length, 150);
  });

  it('page buttons are frozen per store at prepare', async () => {
    saveAppLinks(PAYING_OWNERS.appId, {
      adminHandle: 'example-app',
      pages: [{ key: 'orders', label: 'Orders', path: '/react/orders' }],
    });
    const { id, result } = await prepared(2, 'Hi\n\n{{button "Go to your Orders page" page="orders"}}');
    assert.equal(result.missingPageLinks, 1, 'shop 2 has no myshopify.com domain');
    startSend(id, 2);
    await drain(fake);
    const toShop1 = fake.batches()[0]!.emails.find((email) => email.to === 'owner001@example-shop1.test')!;
    assert.ok(
      toShop1.text.includes('Go to your Orders page: https://admin.shopify.com/store/example-candles/apps/example-app/react/orders'),
    );
  });

  it('send test goes to the reply-to with [Test] and real merge values', async () => {
    seedOwners(1);
    const created = campaign();
    const sent = await sendTest(created.id, undefined);
    assert.equal(sent.to, 'sam@example.com');
    const call = fake.calls.find((entry) => entry.kind === 'one')!;
    const email = call.emails[0]!;
    assert.equal(email.to, 'sam@example.com');
    assert.equal(email.subject, '[Test] Owner1, 3 ideas');
    assert.ok(email.text.includes('News for Example Candles Co.'));
    assert.ok(email.text.includes('123 Placeholder St'));
  });

  it('test sends are limited to 20 per campaign per hour', async () => {
    seedOwners(1);
    const created = campaign();
    for (let i = 0; i < 20; i += 1) await sendTest(created.id, 'me@example.com');
    await assert.rejects(sendTest(created.id, 'me@example.com'), rejects(429));
  });
});

describe('email API', () => {
  let server: Server;
  let origin: string;
  let cookie: string;

  beforeEach(async () => {
    sendingSetup();
    seedOwners(2);
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

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${origin}/api/email${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('needs the dashboard session', async () => {
    assert.equal((await fetch(`${origin}/api/email/campaigns`)).status, 401);
  });

  it('settings blank shows the banner reason', async () => {
    const response = await call('GET', '/campaigns');
    const body = (await response.json()) as { blockedReason: string };
    assert.match(body.blockedReason, /^Fill in the sender settings/);
  });

  it('saves settings, creates, prepares, and sends', async () => {
    const saved = await call('PUT', '/settings', {
      fromName: 'Sam',
      fromEmail: 'sam@updates.example.com',
      replyTo: '',
      footerAddress: '123 Placeholder St, Example City',
    });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { blockedReason: string | null }).blockedReason, null);

    const domain = (await (await call('GET', '/settings/domain')).json()) as { domain: string; status: string };
    assert.deepEqual([domain.domain, domain.status], ['updates.example.com', 'verified']);

    const bad = await call('PUT', '/settings', { fromName: 'Sam', fromEmail: 'x', footerAddress: '123 Placeholder St' });
    assert.equal(bad.status, 422);
    assert.equal(((await bad.json()) as { field: string }).field, 'fromEmail');

    const created = (await (await call('POST', '/campaigns', { name: 'News', audience: PAYING_OWNERS, subject: 'Hi', body: 'Hello {{first_name}}' })).json()) as { id: string };
    const preview = (await (await call('POST', `/campaigns/${created.id}/render`)).json()) as { subject: string; text: string; from: string };
    assert.equal(preview.subject, 'Hi');
    assert.match(preview.text, /^Hello Owner1/);
    assert.equal(preview.from, '"Sam" <sam@updates.example.com>');

    const prep = (await (await call('POST', `/campaigns/${created.id}/prepare`)).json()) as { count: number };
    assert.equal(prep.count, 2);
    assert.equal((await call('POST', `/campaigns/${created.id}/send`, { confirmCount: 1 })).status, 409);
    const sending = (await (await call('POST', `/campaigns/${created.id}/send`, { confirmCount: 2 })).json()) as { status: string };
    assert.equal(sending.status, 'sending');
    assert.equal((await call('PUT', `/campaigns/${created.id}`, { subject: 'x' })).status, 409, 'read-only while sending');
  });
});
