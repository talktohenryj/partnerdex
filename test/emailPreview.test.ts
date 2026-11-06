import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb } from '../src/db/index.js';
import { saveAppLinks } from '../src/apps/links.js';
import { createCampaign, prepareCampaign, previewRecipients, renderPreview, sendTest } from '../src/email/campaigns.js';
import { setPreferences } from '../src/email/preferences.js';
import { renderEmail } from '../src/email/render.js';
import { setTransportForTests } from '../src/email/transport.js';
import { createApp } from '../src/server/index.js';
import { PAYING_OWNERS, SENDING_ENV, saveSender, seedOwners, sendingSetup, type FakeTransport } from './emailHelpers.js';

const BODY = 'Hi {{first_name|there}},\n\nNews for {{shop_name}}.\n\n{{button "Open orders" page="orders"}}';

/** Five owners; owner 2 and owner 4 have no first name. Only shop 1 has a myshopify domain. */
function setup() {
  seedOwners(5, (index) => (index === 2 || index === 4 ? null : `Owner${index}`));
  saveAppLinks(PAYING_OWNERS.appId, { adminHandle: 'example-app', pages: [{ key: 'orders', label: 'Orders', path: '/orders' }] });
  return createCampaign({ name: 'News', audience: PAYING_OWNERS, subject: '{{first_name|Hi}}, news', body: BODY });
}

const email = (n: number) => `owner00${n}@example-shop${n}.test`;

describe('preview as a recipient', () => {
  let fake: FakeTransport;
  beforeEach(() => {
    fake = sendingSetup();
    saveSender();
  });
  afterEach(() => {
    setTransportForTests(null);
    closeDb();
  });

  it('shows the first recipient by email with wrap-around neighbours', () => {
    const { id } = setup();
    const preview = renderPreview(id);
    assert.equal(preview.to, email(1));
    assert.deepEqual(preview.position, { index: 1, total: 5, prevEmail: email(5), nextEmail: email(2) });
  });

  it('previews the recipient asked for, with their variables', () => {
    const { id } = setup();
    const preview = renderPreview(id, { email: email(3) });
    assert.equal(preview.to, email(3));
    assert.equal(preview.subject, 'Owner3, news');
    assert.equal(preview.position.index, 3);
    const first = preview.variables.find((v) => v.key === 'first_name')!;
    assert.deepEqual(first, { key: 'first_name', value: 'Owner3', used: true, fallbacks: ['Hi', 'there'] });
    assert.equal(preview.variables.find((v) => v.key === 'country')!.used, false);
    assert.deepEqual(preview.pages, [{ key: 'orders', label: 'Orders', url: null, used: true }]);
    assert.equal(preview.blankCount, 1, 'no orders link for shop 3');
  });

  it('marks a fallback and a missing link in the preview only', () => {
    const { id } = setup();
    const preview = renderPreview(id, { email: email(2) });
    assert.equal(preview.subject, 'Hi, news');
    assert.match(preview.html, /<mark style="[^"]*">there<\/mark>/);
    assert.match(preview.html, /no link for this store/);
    assert.match(preview.text, /^Hi there,/);
    assert.equal(preview.blankCount, 2);
    assert.deepEqual(preview.recipient.blank, ['first_name']);
    assert.deepEqual(preview.recipient.noLink, ['orders']);

    const shop1 = renderPreview(id, { email: email(1) });
    assert.ok(shop1.html.includes('https://admin.shopify.com/store/example-candles/apps/example-app/orders'));
    assert.ok(!shop1.html.includes('<mark'));

    const sent = renderEmail({
      subject: 'x',
      previewText: '',
      body: BODY,
      merge: { fields: { first_name: '' }, pages: { orders: null } },
      sender: { fromName: 'A', fromEmail: 'a@example.com', replyTo: '', footerAddress: '123 Placeholder St', buttonColor: '#2e72d2' },
      typeLabel: 'Product updates',
      urls: { page: 'https://p', unsubscribe: 'https://p?off=1', oneClick: 'https://p/one-click' },
    });
    assert.ok(!sent.html.includes('<mark'), 'a sent email has no preview marks');
    assert.ok(!sent.html.includes('no link for this store'));
  });

  it('arrows step only through the filter', () => {
    const { id } = setup();
    const preview = renderPreview(id, { email: email(2), filter: 'blank' });
    assert.deepEqual(preview.position, { index: 1, total: 2, prevEmail: email(4), nextEmail: email(4) },
      'blank = a used merge field is empty: owners 2 and 4');
    const named = renderPreview(id, { filter: 'nolink' });
    assert.equal(named.to, email(2), 'the first in the filter when no one is asked for');
  });

  it('lists recipients for the picker with counts, search, and filters', () => {
    const { id } = setup();
    const all = previewRecipients(id);
    assert.equal(all.total, 5);
    assert.deepEqual(all.counts, { all: 5, blank: 2, nolink: 4 });
    assert.deepEqual(all.rows.map((row) => row.email), [1, 2, 3, 4, 5].map(email));
    assert.deepEqual(all.rows[1]!.blank, ['first_name']);

    const blank = previewRecipients(id, { filter: 'blank' });
    assert.deepEqual(blank.rows.map((row) => row.email), [email(2), email(4)]);
    const search = previewRecipients(id, { q: 'example candles' });
    assert.deepEqual(search.rows.map((row) => row.email), [email(1)]);
    const paged = previewRecipients(id, { offset: 3, limit: 1 });
    assert.equal(paged.matching, 5);
    assert.deepEqual(paged.rows.map((row) => row.email), [email(4)]);
  });

  it('uses the frozen list once prepared, without skipped people', async () => {
    const { id } = setup();
    setPreferences(email(3), { product_updates: false }, 'preference_page');
    await prepareCampaign(id);
    const list = previewRecipients(id);
    assert.equal(list.total, 4);
    assert.ok(!list.rows.some((row) => row.email === email(3)));
  });

  it('send test uses the values of the recipient in the preview', async () => {
    const { id } = setup();
    await sendTest(id, 'me@example.com', email(3));
    const sent = fake.calls.find((call) => call.kind === 'one')!.emails[0]!;
    assert.equal(sent.to, 'me@example.com');
    assert.equal(sent.subject, '[Test] Owner3, news');
    assert.ok(!sent.html.includes('<mark'), 'a test is a real email: no preview marks');
  });
});

describe('preview API', () => {
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

  it('renders as a recipient and lists recipients', async () => {
    const { id } = setup();
    const render = await fetch(`${origin}/api/email/campaigns/${id}/render`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: email(4), filter: 'blank' }),
    });
    const body = (await render.json()) as { to: string; position: { index: number; total: number } };
    assert.equal(body.to, email(4));
    assert.deepEqual([body.position.index, body.position.total], [2, 2]);

    const list = await fetch(`${origin}/api/email/campaigns/${id}/recipients?filter=blank&q=owner004`, { headers: { cookie } });
    const rows = (await list.json()) as { matching: number; rows: Array<{ email: string }> };
    assert.equal(rows.matching, 1);
    assert.equal(rows.rows[0]!.email, email(4));
  });
});
