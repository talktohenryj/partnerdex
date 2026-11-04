import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { getDb } from '../src/db/index.js';
import { setShopDetails, shopDetails } from '../src/shops/details.js';
import { APP_ID, resetEnvironment } from './helpers.js';

describe('shop details', () => {
  beforeEach(() => {
    resetEnvironment();
    getDb();
  });

  it('details need no setup', () => {
    const result = setShopDetails('10', APP_ID, {
      primaryDomain: 'shop.example-candles.com',
      country: 'CA',
      currency: 'CAD',
      timezone: 'America/Toronto',
      shopifyPlan: 'Grow',
    });
    assert.deepEqual(result.saved, ['primaryDomain', 'country', 'currency', 'timezone', 'shopifyPlan']);
    assert.deepEqual(result.ignored, []);
    const row = shopDetails('10');
    assert.equal(row?.primaryDomain, 'shop.example-candles.com');
    assert.equal(row?.shopifyPlan, 'Grow');
    assert.equal(row?.updatedByApp, APP_ID);
  });

  it('details are normalised', () => {
    const result = setShopDetails('10', APP_ID, {
      timezone: 'america/toronto',
      currency: 'cad',
      country: 'ca',
      primaryDomain: 'Shop.Example-Candles.com',
    });
    assert.deepEqual(result.saved, ['timezone', 'currency', 'country', 'primaryDomain']);
    const row = shopDetails('10');
    assert.equal(row?.timezone, 'America/Toronto');
    assert.equal(row?.currency, 'CAD');
    assert.equal(row?.country, 'CA');
    assert.equal(row?.primaryDomain, 'shop.example-candles.com');
  });

  it('invalid detail keeps old value', () => {
    setShopDetails('10', APP_ID, { timezone: 'America/Toronto' });
    const cases: Record<string, unknown> = {
      timezone: 'Mars/Olympus',
      primaryDomain: 'https://shop.example-candles.com',
      country: 'CAN',
      currency: 'CA',
      shopifyPlan: 'x'.repeat(101),
    };
    for (const [key, value] of Object.entries(cases)) {
      const result = setShopDetails('10', APP_ID, { [key]: value });
      assert.deepEqual(result.ignored, [{ key, reason: 'invalid' }], key);
      assert.deepEqual(result.saved, [], key);
    }
    assert.equal(shopDetails('10')?.timezone, 'America/Toronto');
  });

  it('null clears one detail', () => {
    setShopDetails('10', APP_ID, { shopifyPlan: 'Grow', currency: 'CAD' });
    const result = setShopDetails('10', APP_ID, { shopifyPlan: null });
    assert.deepEqual(result.saved, ['shopifyPlan']);
    const row = shopDetails('10');
    assert.equal(row?.shopifyPlan, null);
    assert.equal(row?.currency, 'CAD');
  });

  it('unknown detail key is reported', () => {
    const result = setShopDetails('10', APP_ID, { colour: 'blue' });
    assert.deepEqual(result.ignored, [{ key: 'colour', reason: 'unknown_key' }]);
    assert.equal(shopDetails('10'), null);
  });

  it('details are per shop not per app', () => {
    setShopDetails('10', APP_ID, { currency: 'CAD', shopifyPlan: 'Basic' });
    setShopDetails('10', '222', { shopifyPlan: 'Grow' });
    const rows = getDb().prepare('SELECT * FROM shop_details').all();
    assert.equal(rows.length, 1);
    const row = shopDetails('10');
    assert.equal(row?.shopifyPlan, 'Grow');
    assert.equal(row?.currency, 'CAD');
    assert.equal(row?.updatedByApp, '222');
  });
});
