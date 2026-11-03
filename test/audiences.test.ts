import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  optionCounts,
  resolveAudience,
  validateDefinition,
  type AudienceDefinition,
} from '../src/audiences/audience.js';
import { toCsv } from '../src/audiences/csv.js';
import { createAudience, getAudience } from '../src/audiences/store.js';
import { resetConfig } from '../src/config.js';
import { closeDb, getDb } from '../src/db/index.js';
import { suppressContact, upsertContact } from '../src/contacts/upsert.js';
import { createApp } from '../src/server/index.js';
import { APP_ID, resetEnvironment, seed, seedForApp } from './helpers.js';

const OTHER_APP = '222';

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** Paying shops by id. */
function paying(...shopIds: string[]) {
  return shopIds.map((shopId) => ({
    chargeRef: `pay-${shopId}`,
    shopId,
    amount: 30,
    activatedAt: '2024-01-01T00:00:00Z',
    firstSaleAt: '2024-01-02T00:00:00Z',
  }));
}

function trialing(shopId: string) {
  return {
    chargeRef: `trial-${shopId}`,
    shopId,
    amount: 30,
    activatedAt: daysFromNow(-2),
    billingOn: daysFromNow(12),
  };
}

function person(input: {
  email: string;
  firstName?: string;
  lastName?: string;
  shopId: string;
  role?: 'owner' | 'staff' | 'collaborator';
  appId?: string;
}): void {
  upsertContact(
    {
      email: input.email,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      shop: { appId: input.appId ?? APP_ID, shopId: input.shopId },
      role: input.role ?? 'staff',
      source: 'csv_import',
      seenAt: '2026-08-01T00:00:00.000Z',
    },
    getDb(),
  );
}

function link(email: string, shopId: string, role: string, matchMethod = 'auto', appId = APP_ID) {
  getDb()
    .prepare(
      `INSERT INTO contact_shops (email, app_id, shop_id, role, match_method)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email, app_id, shop_id) DO UPDATE SET
         role = excluded.role, match_method = excluded.match_method`,
    )
    .run(email, appId, shopId, role, matchMethod);
}

function unlinked(email: string): void {
  const now = '2026-08-01T00:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO contacts (email, is_suppressed, source, created_at, updated_at)
       VALUES (?, 0, 'csv_import', ?, ?)`,
    )
    .run(email, now, now);
}

const ALL_ROLES = ['owner', 'staff', 'collaborator'] as const;

function def(overrides: Partial<AudienceDefinition> = {}): AudienceDefinition {
  return { appId: APP_ID, statuses: ['paying'], roles: ['owner'], ...overrides };
}

describe('audience resolver', () => {
  beforeEach(() => {
    resetEnvironment({ PARTNER_APP_IDS: APP_ID });
  });
  afterEach(() => closeDb());

  it('resolves paying owners for one app', () => {
    seed(paying('1'));
    person({ email: 'a@x.test', firstName: 'A', shopId: '1', role: 'owner' });

    const result = resolveAudience(def());
    assert.equal(result.recipients.length, 1);
    assert.equal(result.recipients[0]!.email, 'a@x.test');
    assert.equal(result.recipients[0]!.status, 'paying');
    assert.equal(result.recipients[0]!.shopName, 'Shop 1');
  });

  it('role filter excludes staff without counting them', () => {
    seed(paying('1'));
    person({ email: 'a@x.test', shopId: '1', role: 'owner' });
    person({ email: 'b@x.test', shopId: '1', role: 'staff' });

    const result = resolveAudience(def());
    assert.deepEqual(result.recipients.map((r) => r.email), ['a@x.test']);
    assert.equal(result.excludedPeople.length, 0);
    assert.deepEqual(result.excluded, { suppressed: 0, ambiguous: 0, noStatus: 0, merged: 0 });
  });

  it('dedupes a multi-store person to the owned store', () => {
    seed(paying('1', '2'));
    person({ email: 'c@x.test', shopId: '1', role: 'staff' });
    link('c@x.test', '2', 'owner');

    const result = resolveAudience(def({ roles: [...ALL_ROLES] }));
    assert.equal(result.recipients.length, 1);
    assert.equal(result.recipients[0]!.shopId, '2');
    assert.equal(result.recipients[0]!.role, 'owner');
    assert.equal(result.excluded.merged, 1);
  });

  it('preview counts other shops', () => {
    seed(paying('1', '2'));
    person({ email: 'c@x.test', shopId: '1', role: 'owner' });
    link('c@x.test', '2', 'owner');

    const result = resolveAudience(def());
    assert.equal(result.recipients.length, 1);
    assert.equal(result.recipients[0]!.otherShops, 1);
  });

  it('excludes suppressed via mirror', () => {
    seed(paying('1'));
    person({ email: 'd@x.test', shopId: '1', role: 'owner' });
    suppressContact('d@x.test', { source: 'manual' }, getDb());

    const result = resolveAudience(def());
    assert.equal(result.recipients.length, 0);
    assert.equal(result.excluded.suppressed, 1);
    assert.equal(result.excludedPeople[0]!.email, 'd@x.test');
    assert.equal(result.excludedPeople[0]!.reason, 'suppressed');
  });

  it('excludes suppressed via suppression row when mirror lags', () => {
    seed(paying('1'));
    person({ email: 'e@x.test', shopId: '1', role: 'owner' });
    getDb()
      .prepare(
        `INSERT INTO contact_suppressions (email, suppressed_at, source) VALUES (?, ?, 'manual')`,
      )
      .run('e@x.test', '2026-08-01T00:00:00.000Z');

    const result = resolveAudience(def());
    assert.equal(result.recipients.length, 0);
    assert.equal(result.excluded.suppressed, 1);
  });

  it('excludes ambiguous and counts it', () => {
    seed(paying('1'));
    person({ email: 'f@x.test', shopId: '1', role: 'owner' });
    link('f@x.test', '1', 'owner', 'ambiguous');

    const result = resolveAudience(def());
    assert.equal(result.recipients.length, 0);
    assert.equal(result.excluded.ambiguous, 1);
    assert.equal(result.excludedPeople[0]!.reason, 'ambiguous');
  });

  it('person kept on another store is not excluded', () => {
    seed(paying('1', '2'));
    person({ email: 'h@x.test', shopId: '1', role: 'owner' });
    link('h@x.test', '1', 'owner', 'ambiguous');
    link('h@x.test', '2', 'owner', 'auto');

    const result = resolveAudience(def());
    assert.deepEqual(result.recipients.map((r) => [r.email, r.shopId]), [['h@x.test', '2']]);
    assert.equal(result.excludedPeople.length, 0);
    assert.equal(result.excluded.ambiguous, 0);
  });

  it('never includes unlinked', () => {
    seed(paying('1'));
    unlinked('g@x.test');

    const result = resolveAudience(def({ roles: [...ALL_ROLES] }));
    assert.equal(result.recipients.length, 0);
    assert.equal(result.excludedPeople.length, 0);
  });

  it('status is per app not per shop', () => {
    resetEnvironment({ PARTNER_APP_IDS: `${APP_ID},${OTHER_APP}` });
    // Shop 5 pays for 111 and has churned from 222.
    seed(paying('5'));
    seedForApp(OTHER_APP, 'other-5', '5');
    getDb()
      .prepare(`UPDATE subscriptions SET churn_at = '2024-06-01T00:00:00.000Z' WHERE app_id = ?`)
      .run(OTHER_APP);
    getDb()
      .prepare(`UPDATE install_intervals SET ended_at = '2024-06-01T00:00:00.000Z' WHERE app_id = ?`)
      .run(OTHER_APP);
    person({ email: 'in222@x.test', shopId: '5', role: 'owner', appId: OTHER_APP });
    person({ email: 'in111@x.test', shopId: '5', role: 'owner', appId: APP_ID });

    const churned = resolveAudience(
      def({ appId: OTHER_APP, statuses: ['churned'], roles: [...ALL_ROLES] }),
    );
    assert.deepEqual(churned.recipients.map((r) => r.email), ['in222@x.test']);
    assert.equal(churned.recipients[0]!.status, 'churned');

    const payingIn111 = resolveAudience(def({ roles: [...ALL_ROLES] }));
    assert.deepEqual(payingIn111.recipients.map((r) => r.email), ['in111@x.test']);
  });

  it('counts contacts on shops with no status', () => {
    seed(paying('1'));
    getDb()
      .prepare(`INSERT INTO shops (id, name, myshopify_domain) VALUES ('77', 'Quiet', 'q.example')`)
      .run();
    person({ email: 'q@x.test', shopId: '77', role: 'owner' });

    const result = resolveAudience(def());
    assert.equal(result.excluded.noStatus, 1);
    assert.equal(result.excludedPeople[0]!.reason, 'noStatus');
    assert.equal(result.excludedPeople[0]!.status, null);
  });

  it('lists excluded people with a reason', () => {
    seed(paying('1', '2', '3'));
    person({ email: 'sup@x.test', shopId: '1', role: 'owner' });
    suppressContact('sup@x.test', { source: 'manual' }, getDb());
    person({ email: 'amb@x.test', shopId: '2', role: 'owner' });
    link('amb@x.test', '2', 'owner', 'ambiguous');
    person({ email: 'ok@x.test', shopId: '3', role: 'owner' });

    const result = resolveAudience(def());
    const reasons = Object.fromEntries(result.excludedPeople.map((p) => [p.email, p.reason]));
    assert.deepEqual(reasons, { 'sup@x.test': 'suppressed', 'amb@x.test': 'ambiguous' });
    assert.deepEqual(result.recipients.map((r) => r.email), ['ok@x.test']);
  });

  it('excluded counts add up to excluded people', () => {
    seed(paying('1', '2'));
    for (let i = 0; i < 40; i += 1) {
      person({ email: `s${i}@x.test`, shopId: i % 2 ? '1' : '2', role: 'owner' });
      suppressContact(`s${i}@x.test`, { source: 'manual' }, getDb());
    }
    person({ email: 'amb@x.test', shopId: '1', role: 'owner' });
    link('amb@x.test', '1', 'owner', 'ambiguous');

    const result = resolveAudience(def());
    assert.equal(result.excluded.suppressed, 40);
    const { suppressed, ambiguous, noStatus } = result.excluded;
    assert.equal(suppressed + ambiguous + noStatus, result.excludedPeople.length);
  });

  it('option counts use the other filter', () => {
    seed([...paying('1', '2', '3'), trialing('4')]);
    person({ email: 'owner@x.test', shopId: '1', role: 'owner' });
    person({ email: 'trial@x.test', shopId: '4', role: 'owner' });
    person({ email: 'staff1@x.test', shopId: '2', role: 'staff' });
    person({ email: 'staff2@x.test', shopId: '3', role: 'staff' });

    const current = def();
    const counts = optionCounts(current);
    assert.equal(counts.statuses.trialing, 1);
    assert.equal(counts.statuses.paying, 1);
    assert.equal(counts.roles.staff, 2);
    assert.equal(counts.roles.owner, 1);
    assert.equal(resolveAudience(current).recipients.length, 1);
  });

  it('counts distinct stores', () => {
    seed(paying('1', '2'));
    person({ email: 'a@x.test', shopId: '1', role: 'owner' });
    person({ email: 'b@x.test', shopId: '1', role: 'owner' });
    person({ email: 'c@x.test', shopId: '2', role: 'owner' });

    const result = resolveAudience(def());
    assert.equal(result.recipients.length, 3);
    assert.equal(result.stores, 2);
    assert.equal(result.byStatus.paying, 3);
    assert.equal(result.byRole.owner, 3);
  });
});

describe('audience validation and storage', () => {
  beforeEach(() => {
    resetEnvironment({ PARTNER_APP_IDS: APP_ID });
    seed(paying('1'));
  });
  afterEach(() => closeDb());

  it('normalizes the app id and dedupes values', () => {
    const clean = validateDefinition({
      appId: `gid://partners/App/${APP_ID}`,
      statuses: ['trialing', 'paying', 'paying'],
      roles: ['staff', 'owner'],
    });
    assert.deepEqual(clean, { appId: APP_ID, statuses: ['paying', 'trialing'], roles: ['owner', 'staff'] });
  });

  it('saved audience names are unique case-insensitively', () => {
    createAudience({ name: 'Paying owners', definition: def() });
    assert.throws(
      () => createAudience({ name: 'paying OWNERS', definition: def() }),
      (error: Error & { status?: number }) => error.status === 409,
    );
  });

  it('stale audience reads with stale flag', () => {
    const saved = createAudience({ name: 'Old app', definition: def() });
    process.env.PARTNER_APP_IDS = '333';
    resetConfig();
    const read = getAudience(saved.id);
    assert.ok(read);
    assert.equal(read.stale, true);
    assert.equal(read.definition.appId, APP_ID);
  });
});

describe('audience csv', () => {
  beforeEach(() => resetEnvironment({ PARTNER_APP_IDS: APP_ID }));
  afterEach(() => closeDb());

  it('csv escapes formula cells', () => {
    seed(paying('1'));
    person({
      email: 'evil@x.test',
      firstName: '=HYPERLINK("http://bad.test","x")',
      lastName: 'O"Neil, Jr',
      shopId: '1',
      role: 'owner',
    });
    const csv = toCsv(resolveAudience(def()).recipients);
    const [header, row] = csv.trimEnd().split('\r\n');
    assert.equal(header, 'email,first_name,last_name,role,store,store_domain,status');
    assert.equal(
      row,
      `evil@x.test,"'=HYPERLINK(""http://bad.test"",""x"")","O""Neil, Jr",owner,Shop 1,s1.example,paying`,
    );
  });
});

describe('audience routes', () => {
  let server: Server | null = null;
  let origin = '';

  async function start(overrides: Record<string, string> = {}) {
    resetEnvironment({ PARTNER_APP_IDS: APP_ID, ...overrides });
    server = createApp().listen(0);
    await new Promise((resolve) => server!.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function post(path: string, body: unknown) {
    return fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
    closeDb();
  });

  it('audience routes sit behind requireAuth', async () => {
    await start({ DASHBOARD_PASSWORD: 'correct-horse-battery' });
    const response = await post('/api/audiences/preview', { definition: def() });
    assert.equal(response.status, 401);
  });

  it('preview rejects empty statuses', async () => {
    await start();
    seed(paying('1'));
    const response = await post('/api/audiences/preview', { definition: def({ statuses: [] }) });
    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /statuses/);

    const badRole = await post('/api/audiences/preview', {
      definition: { ...def(), roles: ['boss'] },
    });
    assert.equal(badRole.status, 422);
    assert.match(((await badRole.json()) as { error: string }).error, /roles/);
  });

  it('preview rejects out of scope app', async () => {
    await start();
    seed(paying('1'));
    const response = await post('/api/audiences/preview', { definition: def({ appId: '999' }) });
    assert.equal(response.status, 422);
    assert.match(((await response.json()) as { error: string }).error, /appId/);
  });

  it('preview searches by name or email', async () => {
    await start();
    seed(paying('1'));
    person({ email: 'ada@x.test', firstName: 'Ada', shopId: '1', role: 'owner' });
    person({ email: 'bob@x.test', firstName: 'Bob', shopId: '1', role: 'owner' });
    person({ email: 'cy@x.test', firstName: 'Cy', shopId: '1', role: 'owner' });

    const response = await post('/api/audiences/preview', { definition: def(), q: 'ada' });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      count: number;
      matching: number;
      rows: Array<{ email: string }>;
    };
    assert.equal(body.count, 3);
    assert.equal(body.matching, 1);
    assert.deepEqual(body.rows.map((r) => r.email), ['ada@x.test']);
  });

  it('preview pages and sorts like contacts', async () => {
    await start();
    seed(paying('1'));
    for (const name of ['Eve', 'Ann', 'Dan', 'Bea', 'Cal']) {
      person({ email: `${name.toLowerCase()}@x.test`, firstName: name, shopId: '1', role: 'owner' });
    }
    const response = await post('/api/audiences/preview', {
      definition: def(),
      limit: 2,
      offset: 2,
      sort: 'name',
    });
    const body = (await response.json()) as { count: number; rows: Array<{ firstName: string }> };
    assert.equal(body.count, 5);
    assert.deepEqual(body.rows.map((r) => r.firstName), ['Cal', 'Dan']);
  });

  it('preview caps excluded sample at 25', async () => {
    await start();
    seed(paying('1'));
    for (let i = 0; i < 40; i += 1) {
      person({ email: `s${i}@x.test`, shopId: '1', role: 'owner' });
      suppressContact(`s${i}@x.test`, { source: 'manual' }, getDb());
    }
    const response = await post('/api/audiences/preview', { definition: def() });
    const body = (await response.json()) as {
      excluded: { suppressed: number };
      excludedSample: unknown[];
    };
    assert.equal(body.excluded.suppressed, 40);
    assert.equal(body.excludedSample.length, 25);
  });

  it('saves, lists with a live count, renames, and deletes', async () => {
    await start();
    seed(paying('1'));
    person({ email: 'a@x.test', shopId: '1', role: 'owner' });

    const created = await post('/api/audiences', { name: '  Paying owners ', definition: def() });
    assert.equal(created.status, 201);
    const audience = (await created.json()) as { id: string; name: string };
    assert.equal(audience.name, 'Paying owners');

    const clash = await post('/api/audiences', { name: 'PAYING owners', definition: def() });
    assert.equal(clash.status, 409);

    const list = (await (await fetch(`${origin}/api/audiences`)).json()) as {
      audiences: Array<{ id: string; count: number; stale: boolean }>;
    };
    assert.deepEqual(
      list.audiences.map((a) => [a.id, a.count, a.stale]),
      [[audience.id, 1, false]],
    );

    const renamed = await fetch(`${origin}/api/audiences/${audience.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Owners' }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { name: string }).name, 'Owners');

    const removed = await fetch(`${origin}/api/audiences/${audience.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 204);
    const after = (await (await fetch(`${origin}/api/audiences`)).json()) as { audiences: unknown[] };
    assert.equal(after.audiences.length, 0);
  });

  it('csv row count equals preview count', async () => {
    await start();
    seed(paying('1', '2'));
    person({ email: 'a@x.test', shopId: '1', role: 'owner' });
    person({ email: 'b@x.test', shopId: '2', role: 'staff' });
    person({ email: 'c@x.test', shopId: '2', role: 'owner' });
    link('a@x.test', '2', 'owner');

    const preview = (await (
      await post('/api/audiences/preview', { definition: def({ roles: [...ALL_ROLES] }) })
    ).json()) as { count: number };

    const csvResponse = await fetch(
      `${origin}/api/audiences/export.csv?appId=${APP_ID}&statuses=paying&roles=owner,staff,collaborator`,
    );
    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(
      csvResponse.headers.get('content-disposition') ?? '',
      /^attachment; filename="audience-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = (await csvResponse.text()).trimEnd().split('\r\n');
    assert.equal(lines.length - 1, preview.count);

    const created = (await (
      await post('/api/audiences', { name: 'All paying', definition: def({ roles: [...ALL_ROLES] }) })
    ).json()) as { id: string };
    const byId = await fetch(`${origin}/api/audiences/export.csv?id=${created.id}`);
    assert.equal((await byId.text()).trimEnd().split('\r\n').length - 1, preview.count);
  });
});
