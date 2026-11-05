import { getDb, type Db } from '../db/index.js';
import { normalizeAppId } from '../config.js';
import { appInScope } from '../audiences/audience.js';
import { EmailError } from '../email/errors.js';

/**
 * How to open a page of an app inside a merchant's Shopify admin:
 * https://admin.shopify.com/store/{store}/apps/{adminHandle}{path}. Page
 * buttons in an email read these, one URL per recipient's store.
 */

export interface AppPage {
  key: string;
  label: string;
  path: string;
}

export interface AppLinks {
  appId: string;
  adminHandle: string;
  pages: AppPage[];
  updatedAt: string | null;
}

const PAGE_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MAX_PAGES = 20;

export function getAppLinks(appId: string, db: Db = getDb()): AppLinks {
  const id = normalizeAppId(appId);
  const row = db.prepare('SELECT * FROM app_links WHERE app_id = ?').get(id) as
    | { app_id: string; admin_handle: string; pages: string; updated_at: string }
    | undefined;
  if (!row) return { appId: id, adminHandle: '', pages: [], updatedAt: null };
  return {
    appId: row.app_id,
    adminHandle: row.admin_handle,
    pages: JSON.parse(row.pages) as AppPage[],
    updatedAt: row.updated_at,
  };
}

function validatePages(input: unknown): AppPage[] {
  if (!Array.isArray(input)) throw new EmailError('pages must be a list.', 422, 'pages');
  if (input.length > MAX_PAGES) throw new EmailError(`At most ${MAX_PAGES} pages.`, 422, 'pages');
  const seen = new Set<string>();
  return input.map((entry, index) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const key = typeof record.key === 'string' ? record.key.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    const row = `Page ${index + 1}`;
    if (!PAGE_KEY.test(key)) {
      throw new EmailError(`${row}: key must start with a letter and use only a-z, 0-9, and _ (32 at most).`, 422, 'pages');
    }
    if (seen.has(key)) throw new EmailError(`${row}: the key "${key}" is used twice.`, 422, 'pages');
    seen.add(key);
    if (label.length < 1 || label.length > 80) throw new EmailError(`${row}: label must be 1 to 80 characters.`, 422, 'pages');
    if (!path.startsWith('/') || path.length > 300 || /\s/.test(path)) {
      throw new EmailError(`${row}: path must start with "/" and have no spaces.`, 422, 'pages');
    }
    return { key, label, path };
  });
}

export function saveAppLinks(
  appId: string,
  input: { adminHandle?: unknown; pages?: unknown },
  db: Db = getDb(),
): AppLinks {
  const id = normalizeAppId(appId);
  if (!appInScope(id, db)) throw new EmailError(`App ${id} is outside the reporting scope.`, 404);
  const adminHandle = typeof input.adminHandle === 'string' ? input.adminHandle.trim().toLowerCase() : '';
  if (!HANDLE.test(adminHandle)) {
    throw new EmailError(
      'Admin handle must be the part after /apps/ in the app\'s admin URL, such as example-app.',
      422,
      'adminHandle',
    );
  }
  const pages = validatePages(input.pages ?? []);
  db.prepare(
    `INSERT INTO app_links (app_id, admin_handle, pages, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       admin_handle = excluded.admin_handle, pages = excluded.pages, updated_at = excluded.updated_at`,
  ).run(id, adminHandle, JSON.stringify(pages), new Date().toISOString());
  return getAppLinks(id, db);
}

/** example-store.myshopify.com → example-store; anything else → null. */
export function storeHandle(myshopifyDomain: string | null | undefined): string | null {
  const domain = (myshopifyDomain ?? '').trim().toLowerCase();
  const match = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/.exec(domain);
  return match ? match[1]! : null;
}

export function buildPageUrl(links: AppLinks, myshopifyDomain: string | null, pageKey: string): string | null {
  const store = storeHandle(myshopifyDomain);
  const page = links.pages.find((entry) => entry.key === pageKey);
  if (!store || !page || !links.adminHandle) return null;
  return `https://admin.shopify.com/store/${store}/apps/${links.adminHandle}${page.path}`;
}

export function appPageUrl(
  appId: string,
  myshopifyDomain: string | null,
  pageKey: string,
  db: Db = getDb(),
): string | null {
  return buildPageUrl(getAppLinks(appId, db), myshopifyDomain, pageKey);
}
