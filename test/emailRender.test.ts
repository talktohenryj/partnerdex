import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb } from '../src/db/index.js';
import { appPageUrl, saveAppLinks, storeHandle } from '../src/apps/links.js';
import { EmailError } from '../src/email/errors.js';
import { formatFrom, renderEmail, validateTemplate, type MergeValues, type Sender } from '../src/email/render.js';
import { saveSettings } from '../src/email/settings.js';
import { setTransportForTests } from '../src/email/transport.js';
import { APP_ID, resetEnvironment } from './helpers.js';

const SENDER: Sender = {
  fromName: 'Sam from Example App',
  fromEmail: 'sam@updates.example.com',
  replyTo: 'sam@example.com',
  footerAddress: '123 Placeholder St, Example City, ST 00000',
  buttonColor: '#2e72d2',
};

const URLS = {
  page: 'https://partnerdex.example.com/p/tok',
  unsubscribe: 'https://partnerdex.example.com/p/tok?off=1',
  oneClick: 'https://partnerdex.example.com/p/tok/one-click',
};

function merge(fields: MergeValues['fields'] = {}, pages: MergeValues['pages'] = {}): MergeValues {
  return { fields: { app_name: 'Example App', shop_name: 'Example Candles Co', ...fields }, pages };
}

function render(body: string, values = merge(), subject = 'Hello') {
  return renderEmail({ subject, previewText: 'Preview here', body, merge: values, sender: SENDER, typeLabel: 'Product updates', urls: URLS });
}

describe('email renderer', () => {
  it('unknown merge field rejected', () => {
    assert.throws(
      () => validateTemplate('Hi', 'Hello {{company}}'),
      (error: unknown) =>
        error instanceof EmailError && error.status === 422 && /Unknown merge field \{\{company\}\}\. Use one of: /.test(error.message),
    );
    assert.doesNotThrow(() => validateTemplate('{{first_name|Hi}}, news', 'Hello {{shop_name}} on {{shopify_plan}}'));
  });

  it('merge fallback used when blank', () => {
    const out = render('Hi {{first_name|there}}, from {{shop_name}}.', merge({ first_name: '  ' }), '{{first_name|Hi}}, ideas');
    assert.equal(out.subject, 'Hi, ideas');
    assert.match(out.text, /^Hi there, from Example Candles Co\./);
    const named = render('Hi {{first_name|there}}', merge({ first_name: 'Riley' }));
    assert.match(named.text, /^Hi Riley/);
  });

  it('markdown subset escapes html and drops non-http links', () => {
    const out = render(
      'Hello <script>alert(1)</script>\n[x](javascript:alert(1)) and **bold** and *it*\n\n[Docs](https://example.com/docs?a=1&b=2) or https://example.com/x.',
    );
    assert.ok(!out.html.includes('<script>'));
    assert.ok(out.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!/href="javascript/i.test(out.html));
    assert.ok(out.html.includes('<strong>bold</strong>'));
    assert.ok(out.html.includes('<em>it</em>'));
    assert.ok(out.html.includes('<br>'));
    assert.ok(out.html.includes('href="https://example.com/docs?a=1&amp;b=2"'));
    assert.ok(out.html.includes('<a href="https://example.com/x" style="color:#2e72d2">https://example.com/x</a>.'));
    assert.ok(out.text.includes('Docs (https://example.com/docs?a=1&b=2)'));
    assert.ok(out.text.includes('bold'), 'text keeps the words');
    assert.ok(!out.text.includes('**'));
  });

  it('merge values are escaped and never read as formatting', () => {
    const out = render('Hi {{shop_name}}', merge({ shop_name: '<b>**Sale**</b>' }));
    assert.ok(out.html.includes('&lt;b&gt;**Sale**&lt;/b&gt;'));
    assert.ok(!out.html.includes('<strong>Sale'));
  });

  it('footer and list-unsubscribe headers on every email', () => {
    const out = render('Body');
    assert.equal(out.headers['List-Unsubscribe'], `<${URLS.oneClick}>`);
    assert.equal(out.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    for (const part of [out.text, out.html]) {
      assert.ok(part.includes(SENDER.footerAddress));
      assert.ok(part.includes('You get this email because you use Example App on Example Candles Co.'));
      assert.ok(part.includes('Unsubscribe from Product updates'));
    }
    assert.ok(out.text.includes(`Unsubscribe from Product updates: ${URLS.unsubscribe}`));
    assert.ok(out.text.includes(`Email preferences: ${URLS.page}`));
    assert.ok(out.html.includes('Preview here'), 'preheader');
  });

  it('formats From with the name quoted and escaped', () => {
    assert.equal(formatFrom({ fromName: 'Sam "H" \\ Co', fromEmail: 'a@example.com' }), '"Sam \\"H\\" \\\\ Co" <a@example.com>');
  });

  it('page button renders url per store', () => {
    const url = 'https://admin.shopify.com/store/example-candles/apps/example-app/react/orders';
    const body = 'Hi\n\n{{button "Go to your Orders page" page="orders"}}\n\nOr [open orders](page:orders).';
    validateTemplate('Hi', body, ['orders']);
    assert.throws(() => validateTemplate('Hi', body, []), /Unknown page "orders"/);
    const out = render(body, merge({}, { orders: url }));
    assert.ok(out.html.includes(`href="${url}"`));
    assert.ok(out.html.includes('background:#2e72d2'));
    assert.ok(out.html.includes('height:44px'));
    assert.ok(out.text.includes(`Go to your Orders page: ${url}`));
    assert.ok(out.text.includes(`open orders (${url})`));

    const noHandle = render(body, merge({}, { orders: null }));
    assert.ok(!noHandle.html.includes('admin.shopify.com'));
    assert.ok(noHandle.text.includes('Go to your Orders page'));
  });
});

describe('app links', () => {
  beforeEach(() => {
    resetEnvironment({ PARTNER_APP_IDS: APP_ID });
    setTransportForTests(null);
  });
  afterEach(() => closeDb());

  it('app page url uses the store handle', () => {
    saveAppLinks(APP_ID, {
      adminHandle: 'example-app',
      pages: [{ key: 'orders', label: 'Orders', path: '/react/orders' }],
    });
    assert.equal(
      appPageUrl(APP_ID, 'example-candles.myshopify.com', 'orders'),
      'https://admin.shopify.com/store/example-candles/apps/example-app/react/orders',
    );
    assert.equal(appPageUrl(APP_ID, 'example-candles.myshopify.com', 'missing'), null);
    assert.equal(appPageUrl(APP_ID, null, 'orders'), null);
    assert.equal(storeHandle('shop.example.com'), null);
  });

  it('rejects bad page keys and paths', () => {
    assert.throws(() => saveAppLinks(APP_ID, { adminHandle: 'x', pages: [{ key: 'Orders', label: 'O', path: '/a' }] }), /key must start/);
    assert.throws(() => saveAppLinks(APP_ID, { adminHandle: 'x', pages: [{ key: 'o', label: 'O', path: 'a' }] }), /path must start/);
    assert.throws(() => saveAppLinks(APP_ID, { adminHandle: 'x', pages: Array.from({ length: 21 }, (_, i) => ({ key: `p${i}`, label: 'P', path: '/' })) }), /At most 20/);
  });

  it('settings validate footer address and addresses', () => {
    const good = { fromName: 'Sam', fromEmail: 'Sam@Example.com', replyTo: '', footerAddress: '123 Placeholder St, City' };
    const saved = saveSettings(good);
    assert.equal(saved.fromEmail, 'sam@example.com');
    assert.equal(saved.buttonColor, '#2e72d2');
    const field = (input: Record<string, string>) => {
      try {
        saveSettings({ ...good, ...input });
        return null;
      } catch (error) {
        return error instanceof EmailError ? `${error.status}:${error.field}` : 'other';
      }
    };
    assert.equal(field({ footerAddress: 'short' }), '422:footerAddress');
    assert.equal(field({ fromEmail: 'not an address' }), '422:fromEmail');
    assert.equal(field({ replyTo: 'nope@' }), '422:replyTo');
    assert.equal(field({ fromName: 'two\nlines' }), '422:fromName');
    assert.equal(field({ buttonColor: 'red' }), '422:buttonColor');
  });
});
