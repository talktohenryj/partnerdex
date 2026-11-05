import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb } from '../src/db/index.js';
import { createCampaign, prepareCampaign } from '../src/email/campaigns.js';
import { signLink, verifyLink, TEST_SOURCE } from '../src/email/links.js';
import { isSubscribed } from '../src/email/preferences.js';
import { setTransportForTests } from '../src/email/transport.js';
import { createApp } from '../src/server/index.js';
import { PAYING_OWNERS, SECRET, saveSender, seedOwners, sendingSetup } from './emailHelpers.js';

const EMAIL = 'owner001@example-shop1.test';

describe('preference page', () => {
  let server: Server;
  let origin: string;
  let campaignId: string;

  beforeEach(async () => {
    sendingSetup();
    saveSender();
    seedOwners(1);
    const created = createCampaign({ name: 'News', audience: PAYING_OWNERS, subject: 'Hi', body: 'Hello', emailType: 'weekly_recap' });
    await prepareCampaign(created.id);
    campaignId = created.id;
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    server.close();
    setTransportForTests(null);
    closeDb();
  });

  const token = (typeKey = 'weekly_recap', sourceId = campaignId, email = EMAIL) =>
    signLink({ email, typeKey, sourceId }, SECRET);

  const prefRows = () => getDb().prepare('SELECT type_key, subscribed, source FROM email_preferences ORDER BY type_key').all();

  const post = (path: string, form: Record<string, string | string[]> = {}) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      for (const entry of Array.isArray(value) ? value : [value]) body.append(key, entry);
    }
    return fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });
  };

  it('tokens round-trip and reject tampering', () => {
    const signed = token();
    assert.deepEqual(verifyLink(signed, SECRET), { email: EMAIL, typeKey: 'weekly_recap', sourceId: campaignId });
    const [payload, mac] = signed.split('.');
    const forged = Buffer.from(`someone@example.com\nweekly_recap\n${campaignId}`).toString('base64url');
    assert.equal(verifyLink(`${forged}.${mac}`, SECRET), null);
    assert.equal(verifyLink(`${payload}.${mac}x`, SECRET), null);
    assert.equal(verifyLink(signed, 'another-secret-another-secret-another'), null);
  });

  it('preference GET does not write', async () => {
    for (const suffix of ['', '?off=1']) {
      const response = await fetch(`${origin}/p/${token()}${suffix}`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Choose the emails you get from Sam from Example App/);
      assert.ok(!html.includes('PartnerDex'));
      assert.ok(html.includes('Always on'));
      assert.ok(html.includes(EMAIL));
      assert.ok(html.includes('Example Candles Co'));
    }
    assert.deepEqual(prefRows(), []);
  });

  it('one click turns off only its type', async () => {
    const first = await post(`/p/${token()}/one-click`, { 'List-Unsubscribe': 'One-Click' });
    assert.equal(first.status, 200);
    assert.deepEqual(prefRows(), [{ type_key: 'weekly_recap', subscribed: 0, source: 'one_click' }]);
    assert.equal(isSubscribed(EMAIL, 'weekly_recap'), false);
    assert.equal(isSubscribed(EMAIL, 'product_updates'), true);
    const contact = getDb().prepare('SELECT is_suppressed FROM contacts WHERE email = ?').get(EMAIL) as { is_suppressed: number };
    assert.equal(contact.is_suppressed, 0, 'the contact is not suppressed');
    const send = getDb().prepare('SELECT unsubscribed_at FROM email_sends WHERE campaign_id = ? AND email = ?').get(campaignId, EMAIL) as { unsubscribed_at: string | null };
    assert.ok(send.unsubscribed_at);

    const again = await post(`/p/${token()}/one-click`);
    assert.equal(again.status, 200);
    assert.deepEqual(prefRows(), [{ type_key: 'weekly_recap', subscribed: 0, source: 'one_click' }]);
  });

  it('footer unsubscribe confirms, then shows undo', async () => {
    const off = await post(`/p/${token()}/off`);
    assert.equal(off.status, 303);
    assert.equal(isSubscribed(EMAIL, 'weekly_recap'), false);
    const page = await (await fetch(`${origin}${off.headers.get('location')}`)).text();
    assert.match(page, /You are unsubscribed from <b>Weekly recap<\/b>/);
    assert.match(page, /Undo/);
    const undo = await post(`/p/${token()}/undo`);
    assert.equal(undo.status, 303);
    assert.equal(isSubscribed(EMAIL, 'weekly_recap'), true);
  });

  it('save sets every switch from the form', async () => {
    const saved = await post(`/p/${token()}`, { save: '1', types: ['product_updates', 'account_notices'] });
    assert.equal(saved.status, 303);
    assert.equal(isSubscribed(EMAIL, 'product_updates'), true);
    assert.equal(isSubscribed(EMAIL, 'weekly_recap'), false);
    assert.equal(isSubscribed(EMAIL, 'tips'), false);
    assert.equal(isSubscribed(EMAIL, 'account_notices'), true);
    const page = await (await fetch(`${origin}${saved.headers.get('location')}`)).text();
    assert.match(page, /Saved\./);
  });

  it('unsubscribe all keeps account notices', async () => {
    const response = await post(`/p/${token()}/all`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /You will not get marketing email from Sam from Example App/);
    for (const key of ['product_updates', 'weekly_recap', 'tips']) assert.equal(isSubscribed(EMAIL, key), false, key);
    assert.equal(isSubscribed(EMAIL, 'account_notices'), true);
    assert.equal(getDb().prepare(`SELECT COUNT(*) AS n FROM email_preferences WHERE type_key = 'account_notices'`).get()!.n as number, 0);
  });

  it('tampered token rejected', async () => {
    const bad = `${token().slice(0, -2)}xx`;
    assert.equal((await fetch(`${origin}/p/${bad}`)).status, 400);
    assert.equal((await post(`/p/${bad}/one-click`)).status, 400);
    assert.equal((await post(`/p/${bad}/all`)).status, 400);
    assert.deepEqual(prefRows(), []);
  });

  it('test token is a no-op', async () => {
    const test = token('weekly_recap', TEST_SOURCE, 'sam@example.com');
    for (const path of ['/one-click', '/all', '/off', '']) {
      const response = await post(`/p/${test}${path}`, { types: [] });
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), /This was a test email — nothing changed\./);
    }
    assert.deepEqual(prefRows(), []);
  });
});
