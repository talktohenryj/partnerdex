import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb } from '../src/db/index.js';
import { createApp } from '../src/server/index.js';
import { APP_ID, resetEnvironment } from './helpers.js';

const TOKEN = 'test-ingest-token-please';
const DOMAIN = 'example-candles.myshopify.com';

function seedShop(id: string, domain: string): void {
  getDb()
    .prepare(`INSERT INTO shops (id, name, myshopify_domain) VALUES (?, ?, ?)`)
    .run(id, `Shop ${id}`, domain);
}

let server: Server | null = null;
let origin = '';

async function start(env: Record<string, string>): Promise<void> {
  resetEnvironment({ PARTNER_APP_IDS: APP_ID, DASHBOARD_PASSWORD: 'dashboard-password', ...env });
  getDb();
  seedShop('10', DOMAIN);
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stop(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  server = null;
  closeDb();
}

async function post(path: string, body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

interface IdentifyResponse {
  results: Array<{
    shopId: string | null;
    matched: boolean;
    contacts: Array<{ matched: string; created: boolean }>;
    details: { saved: string[]; ignored: Array<{ key: string; reason: string }> };
    ignoredFields: string[];
  }>;
}

const identify = (body: unknown, token?: string | null) => post('/api/identify', body, token);

function counts() {
  const db = getDb();
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    contacts: one('SELECT count(*) AS n FROM contacts'),
    details: one('SELECT count(*) AS n FROM shop_details'),
  };
}

const contact = (email: string) => ({ email, firstName: 'Ada', role: 'owner', seenAt: '2026-11-01T00:00:00.000Z' });

describe('POST /api/identify', () => {
  beforeEach(() => start({ INGEST_TOKEN: TOKEN }));
  afterEach(stop);

  it('identify upserts contacts like ingest', async () => {
    const response = await identify({
      shops: [{ appId: APP_ID, myshopifyDomain: DOMAIN, contacts: [contact('Ada@Example.com')] }],
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as IdentifyResponse;
    assert.deepEqual(json.results, [
      {
        shopId: '10',
        matched: true,
        contacts: [{ matched: 'auto', created: true }],
        details: { saved: [], ignored: [] },
        ignoredFields: [],
      },
    ]);
    const link = getDb()
      .prepare('SELECT email, shop_id, role FROM contact_shops')
      .get();
    assert.deepEqual(link, { email: 'ada@example.com', shop_id: '10', role: 'owner' });
  });

  it('identify without contacts saves details', async () => {
    const response = await identify({
      shops: [
        {
          appId: APP_ID,
          myshopifyDomain: DOMAIN,
          details: { timezone: 'America/Toronto', currency: 'cad' },
        },
      ],
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as IdentifyResponse;
    assert.deepEqual(json.results[0]!.details, { saved: ['timezone', 'currency'], ignored: [] });
    assert.deepEqual(counts(), { contacts: 0, details: 1 });
    const row = getDb().prepare('SELECT currency FROM shop_details').get();
    assert.deepEqual(row, { currency: 'CAD' });
  });

  it('unknown shop fields are skipped and reported', async () => {
    const response = await identify({
      shops: [
        {
          appId: APP_ID,
          shopId: '10',
          customAttributes: { giftCardsSold: 4 },
          details: { country: 'CA' },
        },
      ],
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as IdentifyResponse;
    assert.deepEqual(json.results[0]!.ignoredFields, ['customAttributes']);
    assert.deepEqual(json.results[0]!.details.saved, ['country']);
  });

  it('unmatched shop ignores details', async () => {
    const response = await identify({
      shops: [
        {
          appId: APP_ID,
          myshopifyDomain: 'unknown-store.myshopify.com',
          contacts: [contact('ben@example.com')],
          details: { country: 'CA', currency: 'CAD' },
        },
      ],
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as IdentifyResponse;
    const result = json.results[0]!;
    assert.equal(result.matched, false);
    assert.equal(result.shopId, null);
    assert.deepEqual(result.contacts, [{ matched: 'none', created: true }]);
    assert.deepEqual(result.details.ignored, [
      { key: 'country', reason: 'shop_not_found' },
      { key: 'currency', reason: 'shop_not_found' },
    ]);
    assert.deepEqual(counts(), { contacts: 1, details: 0 });
  });

  it('batch over 500 is rejected', async () => {
    const shops = Array.from({ length: 501 }, () => ({
      appId: APP_ID,
      shopId: '10',
      details: { country: 'CA' },
    }));
    const response = await identify({ shops });
    assert.equal(response.status, 422);
    assert.match(((await response.json()) as { error: string }).error, /shops must hold 1 to 500 shops/);
    assert.deepEqual(counts(), { contacts: 0, details: 0 });
  });

  it('contacts over 500 in a shop are rejected', async () => {
    const contacts = Array.from({ length: 501 }, (_, index) => contact(`p${index}@example.com`));
    const response = await identify({ shops: [{ appId: APP_ID, shopId: '10', contacts }] });
    assert.equal(response.status, 422);
    assert.match(((await response.json()) as { error: string }).error, /shops\[0\]\.contacts/);
    assert.deepEqual(counts(), { contacts: 0, details: 0 });
  });

  it('single shop object is rejected', async () => {
    const single = await identify({ shop: { appId: APP_ID, shopId: '10' } });
    assert.equal(single.status, 422);
    assert.equal(((await single.json()) as { error: string }).error, 'shops must be an array');

    const empty = await identify({ shops: [] });
    assert.equal(empty.status, 422);
    assert.equal(((await empty.json()) as { error: string }).error, 'shops must hold 1 to 500 shops');
  });

  it('malformed body writes nothing', async () => {
    const response = await identify({
      shops: [
        { appId: APP_ID, shopId: '10', contacts: [contact('ok@example.com')], details: { country: 'CA' } },
        { appId: APP_ID, shopId: '10', contacts: [contact('ok2@example.com'), { firstName: 'No email' }] },
      ],
    });
    assert.equal(response.status, 422);
    assert.match(((await response.json()) as { error: string }).error, /shops\[1\]\.contacts\[1\]\.email/);

    const noShop = await identify({ shops: [{ appId: APP_ID, contacts: [] }] });
    assert.equal(noShop.status, 422);
    assert.match(((await noShop.json()) as { error: string }).error, /shops\[0\] needs shopId or myshopifyDomain/);

    assert.deepEqual(counts(), { contacts: 0, details: 0 });
  });

  it('identify needs the ingest token', async () => {
    const body = { shops: [{ appId: APP_ID, shopId: '10' }] };
    assert.equal((await identify(body, null)).status, 401);
    assert.equal((await identify(body, 'nope')).status, 401);
    assert.equal((await identify(body)).status, 200);
  });

  it('accepts a batch larger than the dashboard body limit', async () => {
    const shops = Array.from({ length: 500 }, (_, index) => ({
      appId: APP_ID,
      myshopifyDomain: `store-${index}.myshopify.com`,
      details: { primaryDomain: `shop.store-${index}.example.com`, country: 'CA', currency: 'CAD' },
    }));
    assert.ok(JSON.stringify({ shops }).length > 64 * 1024);
    const response = await identify({ shops });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as IdentifyResponse).results.length, 500);
  });

  it('dashboard reads details behind the login', async () => {
    await identify({ shops: [{ appId: APP_ID, shopId: '10', details: { shopifyPlan: 'Grow' } }] });
    const anonymous = await fetch(`${origin}/api/customers/10/details`);
    assert.equal(anonymous.status, 401);
  });
});

describe('app ingest token names', () => {
  afterEach(stop);

  const body = { shops: [{ appId: APP_ID, shopId: '10' }] };
  const ingestBody = { email: 'a@example.com', appId: APP_ID, shopId: '10' };

  it('INGEST_TOKEN wins over the old name', async () => {
    await start({ INGEST_TOKEN: TOKEN, CONTACTS_INGEST_TOKEN: 'old-token-value' });
    assert.equal((await identify(body)).status, 200);
    assert.equal((await post('/api/contacts/ingest', ingestBody)).status, 200);
    assert.equal((await identify(body, 'old-token-value')).status, 401);
  });

  it('old token name still works', async () => {
    await start({ CONTACTS_INGEST_TOKEN: TOKEN });
    assert.equal((await identify(body)).status, 200);
    assert.equal((await post('/api/contacts/ingest', ingestBody)).status, 200);
  });

  it('contacts ingest unchanged', async () => {
    await start({ INGEST_TOKEN: TOKEN });
    const response = await post('/api/contacts/ingest', ingestBody);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { matched: 'auto', created: true });
  });

  it('neither token set answers 503 on both endpoints', async () => {
    await start({});
    for (const response of [await identify(body), await post('/api/contacts/ingest', ingestBody)]) {
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: 'App ingest is disabled. Set INGEST_TOKEN to enable it.',
      });
    }
  });
});
