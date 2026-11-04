import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';

/**
 * Shop details: the same five facts for every store, sent by any app through
 * POST /api/identify. One row per shop; the last write wins.
 *
 * A field the call leaves out is not touched, `null` clears it, and a value
 * that fails its check is reported and the old value stays.
 */

export const SHOP_DETAIL_FIELDS = [
  'primaryDomain',
  'country',
  'currency',
  'timezone',
  'shopifyPlan',
] as const;

export type ShopDetailField = (typeof SHOP_DETAIL_FIELDS)[number];

export type ShopDetailIgnoredReason = 'unknown_key' | 'invalid' | 'shop_not_found';

export interface ShopDetailsWriteResult {
  saved: string[];
  ignored: Array<{ key: string; reason: ShopDetailIgnoredReason }>;
}

export interface ShopDetails {
  shopId: string;
  primaryDomain: string | null;
  country: string | null;
  currency: string | null;
  timezone: string | null;
  shopifyPlan: string | null;
  updatedAt: string;
  updatedByApp: string;
  updatedByAppName: string | null;
}

const COLUMN: Record<ShopDetailField, string> = {
  primaryDomain: 'primary_domain',
  country: 'country',
  currency: 'currency',
  timezone: 'timezone',
  shopifyPlan: 'shopify_plan',
};

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function hostName(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  return labels.every((label) => HOST_LABEL.test(label)) ? host : null;
}

function timeZone(value: string): string | null {
  const zone = value.trim();
  if (!zone) return null;
  try {
    // The resolved name is the canonical spelling, so "america/toronto" is
    // stored as "America/Toronto".
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The stored form of a value, or undefined when it fails the field's check. */
function normalize(field: ShopDetailField, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  switch (field) {
    case 'primaryDomain':
      return hostName(value) ?? undefined;
    case 'country':
      return /^[a-z]{2}$/i.test(value.trim()) ? value.trim().toUpperCase() : undefined;
    case 'currency':
      return /^[a-z]{3}$/i.test(value.trim()) ? value.trim().toUpperCase() : undefined;
    case 'timezone':
      return timeZone(value) ?? undefined;
    case 'shopifyPlan': {
      const plan = value.trim();
      return plan && plan.length <= 100 ? plan : undefined;
    }
  }
}

function isDetailField(key: string): key is ShopDetailField {
  return (SHOP_DETAIL_FIELDS as readonly string[]).includes(key);
}

export function setShopDetails(
  shopId: string,
  appId: string,
  input: Record<string, unknown>,
  db: Db = getDb(),
): ShopDetailsWriteResult {
  const result: ShopDetailsWriteResult = { saved: [], ignored: [] };
  const changes = new Map<ShopDetailField, string | null>();

  for (const [key, value] of Object.entries(input)) {
    if (!isDetailField(key)) {
      result.ignored.push({ key, reason: 'unknown_key' });
      continue;
    }
    if (value === null) {
      changes.set(key, null);
      result.saved.push(key);
      continue;
    }
    const stored = normalize(key, value);
    if (stored === undefined) {
      result.ignored.push({ key, reason: 'invalid' });
      continue;
    }
    changes.set(key, stored);
    result.saved.push(key);
  }

  if (changes.size === 0) return result;

  const fields = [...changes.keys()];
  const columns = fields.map((field) => COLUMN[field]);
  const params: Record<string, string | null> = {
    shopId,
    appId,
    now: new Date().toISOString(),
  };
  for (const field of fields) params[field] = changes.get(field) ?? null;

  db.prepare(
    `INSERT INTO shop_details (shop_id, ${columns.join(', ')}, updated_at, updated_by_app)
     VALUES (@shopId, ${fields.map((field) => `@${field}`).join(', ')}, @now, @appId)
     ON CONFLICT(shop_id) DO UPDATE SET
       ${columns.map((column) => `${column} = excluded.${column}`).join(',\n       ')},
       updated_at = excluded.updated_at,
       updated_by_app = excluded.updated_by_app`,
  ).run(params);

  return result;
}

export function shopDetails(shopId: string, db: Db = getDb()): ShopDetails | null {
  const row = db
    .prepare(
      `SELECT d.shop_id, d.primary_domain, d.country, d.currency, d.timezone,
              d.shopify_plan, d.updated_at, d.updated_by_app, a.name AS app_name
         FROM shop_details d
         LEFT JOIN apps a ON a.id = d.updated_by_app
        WHERE d.shop_id = ?`,
    )
    .get(shopId) as
    | {
        shop_id: string;
        primary_domain: string | null;
        country: string | null;
        currency: string | null;
        timezone: string | null;
        shopify_plan: string | null;
        updated_at: string;
        updated_by_app: string;
        app_name: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    shopId: row.shop_id,
    primaryDomain: row.primary_domain,
    country: row.country,
    currency: row.currency,
    timezone: row.timezone,
    shopifyPlan: row.shopify_plan,
    updatedAt: row.updated_at,
    updatedByApp: row.updated_by_app,
    updatedByAppName: row.app_name,
  };
}
