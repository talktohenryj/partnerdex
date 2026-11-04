import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';
import {
  ContactsError,
  assertAppInScope,
  resolveShopMatch,
  upsertContact,
  type ContactRole,
  type ContactSource,
  type UpsertContactResult,
} from '../contacts/upsert.js';
import { setShopDetails, type ShopDetailsWriteResult } from '../shops/details.js';

/**
 * POST /api/identify: one call where an app describes shops — their contacts
 * and their shop details. Always arrays, even for one shop or one person.
 *
 * The whole body is checked before anything is written, so a malformed body
 * writes nothing. A shop field this version does not know is skipped and
 * reported, so an app newer than PartnerDex never breaks a call.
 */

export const MAX_SHOPS = 500;
export const MAX_CONTACTS_PER_SHOP = 500;

const KNOWN_SHOP_FIELDS = new Set(['appId', 'shopId', 'myshopifyDomain', 'contacts', 'details']);
const ROLES: ContactRole[] = ['owner', 'staff', 'collaborator'];
const SOURCES: ContactSource[] = ['app_capture', 'csv_import'];

export interface IdentifyContactInput {
  email: string;
  firstName: string | null;
  lastName: string | null;
  role?: ContactRole;
  source: ContactSource;
  seenAt: string;
}

export interface IdentifyShopInput {
  appId: string;
  shopId: string | null;
  myshopifyDomain: string | null;
  contacts: IdentifyContactInput[];
  details: Record<string, unknown> | null;
  ignoredFields: string[];
}

export interface IdentifyShopResult {
  shopId: string | null;
  matched: boolean;
  contacts: UpsertContactResult[];
  details: ShopDetailsWriteResult;
  ignoredFields: string[];
}

function malformed(message: string): never {
  throw new ContactsError(message, 422);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string, path: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') malformed(`${path}.${key} must be a string`);
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseContact(raw: unknown, path: string, now: string): IdentifyContactInput {
  if (!isRecord(raw)) malformed(`${path} must be an object`);
  const email = optionalString(raw, 'email', path);
  if (!email) malformed(`${path}.email is required`);
  if (!email.includes('@')) malformed(`${path}.email must look like an email address`);

  const role = optionalString(raw, 'role', path);
  if (role !== null && !ROLES.includes(role as ContactRole)) {
    malformed(`${path}.role must be owner, staff, or collaborator`);
  }
  const source = optionalString(raw, 'source', path) ?? 'app_capture';
  if (!SOURCES.includes(source as ContactSource)) {
    malformed(`${path}.source must be app_capture or csv_import`);
  }

  return {
    email,
    firstName: optionalString(raw, 'firstName', path),
    lastName: optionalString(raw, 'lastName', path),
    role: (role ?? undefined) as ContactRole | undefined,
    source: source as ContactSource,
    seenAt: optionalString(raw, 'seenAt', path) ?? now,
  };
}

function parseShop(raw: unknown, path: string, now: string): IdentifyShopInput {
  if (!isRecord(raw)) malformed(`${path} must be an object`);

  const appId = optionalString(raw, 'appId', path);
  if (!appId) malformed(`${path}.appId is required`);
  const shopId = optionalString(raw, 'shopId', path);
  const myshopifyDomain = optionalString(raw, 'myshopifyDomain', path);
  if (!shopId && !myshopifyDomain) malformed(`${path} needs shopId or myshopifyDomain`);

  let contacts: IdentifyContactInput[] = [];
  if (raw.contacts !== undefined) {
    if (!Array.isArray(raw.contacts)) malformed(`${path}.contacts must be an array`);
    if (raw.contacts.length > MAX_CONTACTS_PER_SHOP) {
      malformed(`${path}.contacts must hold at most ${MAX_CONTACTS_PER_SHOP} contacts`);
    }
    contacts = raw.contacts.map((contact, index) =>
      parseContact(contact, `${path}.contacts[${index}]`, now),
    );
  }

  let details: Record<string, unknown> | null = null;
  if (raw.details !== undefined && raw.details !== null) {
    if (!isRecord(raw.details)) malformed(`${path}.details must be an object`);
    details = raw.details;
  }

  const ignoredFields = Object.keys(raw).filter((key) => !KNOWN_SHOP_FIELDS.has(key));

  return { appId, shopId, myshopifyDomain, contacts, details, ignoredFields };
}

/** Check the whole body. Throws a 422 naming the first bad path. */
export function parseIdentifyBody(body: unknown, now = new Date().toISOString()): IdentifyShopInput[] {
  if (!isRecord(body) || !('shops' in body)) malformed('shops must be an array');
  const shops = body.shops;
  if (!Array.isArray(shops)) malformed('shops must be an array');
  if (shops.length < 1 || shops.length > MAX_SHOPS) {
    malformed(`shops must hold 1 to ${MAX_SHOPS} shops`);
  }
  return shops.map((shop, index) => parseShop(shop, `shops[${index}]`, now));
}

export function identify(body: unknown, db: Db = getDb()): IdentifyShopResult[] {
  const shops = parseIdentifyBody(body);
  // Scope is checked before any write too, so a call naming an app outside
  // the reporting scope writes nothing.
  for (const shop of shops) assertAppInScope(shop.appId, db);

  return db.transaction(() =>
    shops.map((shop): IdentifyShopResult => {
      const ref = { appId: shop.appId, shopId: shop.shopId, myshopifyDomain: shop.myshopifyDomain };
      const match = resolveShopMatch(db, ref);
      const matched = match.shopId !== null && match.matched === 'auto';

      const contacts = shop.contacts.map((contact) =>
        upsertContact({ ...contact, shop: ref }, db),
      );

      let details: ShopDetailsWriteResult = { saved: [], ignored: [] };
      if (shop.details) {
        details = matched
          ? setShopDetails(match.shopId!, shop.appId, shop.details, db)
          : {
              saved: [],
              ignored: Object.keys(shop.details).map((key) => ({
                key,
                reason: 'shop_not_found' as const,
              })),
            };
      }

      return {
        shopId: match.shopId,
        matched,
        contacts,
        details,
        ignoredFields: shop.ignoredFields,
      };
    }),
  )();
}
