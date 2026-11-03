import { normalizeAppId } from '../config.js';
import { shopStatuses, type CustomerStatus, type ShopStatus } from '../customers/index.js';
import { getDb, type Db } from '../db/index.js';
import { sortShops, type ContactSort } from '../contacts/list.js';
import {
  assertAppInScope,
  ContactsError,
  type ContactRole,
  type MatchMethod,
} from '../contacts/upsert.js';
import { AudienceError } from './errors.js';

/**
 * An audience: one app, the store statuses, and the roles — resolved to the
 * people it names right now.
 *
 * The rule is the stored thing, never the list. Who is in it is decided here,
 * on every read, from the contacts store and the same per-store status the
 * Customers list shows.
 */

export const STATUSES = ['paying', 'trialing', 'installed', 'churned', 'gone'] as const;
export const ROLES = ['owner', 'staff', 'collaborator'] as const;

export interface AudienceDefinition {
  appId: string;
  statuses: CustomerStatus[];
  roles: ContactRole[];
}

export interface Recipient {
  email: string;
  firstName: string | null;
  lastName: string | null;
  source: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  isSuppressed: boolean;
  matchMethod: MatchMethod;
  shopId: string;
  shopName: string | null;
  shopDomain: string | null;
  role: ContactRole;
  status: CustomerStatus;
  mrr: number;
  currency: string | null;
  /** The "+N" on the Customers cell: other stores this person was merged from. */
  otherShops: number;
}

export type ExclusionReason = 'suppressed' | 'ambiguous' | 'noStatus';

export interface ExcludedPerson extends Omit<Recipient, 'status'> {
  /** Null when the reason is `noStatus`. */
  status: CustomerStatus | null;
  reason: ExclusionReason;
}

export interface AudienceResult {
  recipients: Recipient[];
  /** One per person, sorted like recipients. */
  excludedPeople: ExcludedPerson[];
  excluded: { suppressed: number; ambiguous: number; noStatus: number; merged: number };
  /** Distinct stores among recipients. */
  stores: number;
  byStatus: Record<CustomerStatus, number>;
  byRole: Record<ContactRole, number>;
}

export interface OptionCounts {
  statuses: Record<CustomerStatus, number>;
  roles: Record<ContactRole, number>;
}

function subset<T extends string>(
  input: unknown,
  allowed: readonly T[],
  field: string,
): T[] {
  if (!Array.isArray(input)) {
    throw new AudienceError(`${field} must be a list of ${allowed.join(', ')}.`, 422);
  }
  const out: T[] = [];
  for (const value of input) {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      throw new AudienceError(
        `${field} has an unknown value "${String(value)}". Use ${allowed.join(', ')}.`,
        422,
      );
    }
    if (!out.includes(value as T)) out.push(value as T);
  }
  if (out.length === 0) {
    throw new AudienceError(`${field} must name at least one of ${allowed.join(', ')}.`, 422);
  }
  // Canonical order, so two definitions that ask the same thing compare equal.
  return allowed.filter((value) => out.includes(value));
}

/** True when `appId` is in reporting scope. Never throws. */
export function appInScope(appId: string, db: Db = getDb()): boolean {
  try {
    assertAppInScope(appId, db);
    return true;
  } catch (error) {
    if (error instanceof ContactsError) return false;
    throw error;
  }
}

export function validateDefinition(input: unknown, db: Db = getDb()): AudienceDefinition {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AudienceError('definition must be an object with appId, statuses, and roles.', 422);
  }
  const record = input as Record<string, unknown>;
  const appId = typeof record.appId === 'string' ? normalizeAppId(record.appId) : '';
  if (!appId) {
    throw new AudienceError('appId is required.', 422);
  }
  if (!appInScope(appId, db)) {
    throw new AudienceError(`appId "${appId}" is outside the reporting scope.`, 422);
  }
  return {
    appId,
    statuses: subset(record.statuses, STATUSES, 'statuses'),
    roles: subset(record.roles, ROLES, 'roles'),
  };
}

interface MembershipRow {
  email: string;
  shopId: string;
  role: ContactRole;
  matchMethod: MatchMethod;
  firstName: string | null;
  lastName: string | null;
  source: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  isSuppressed: number;
  hardSuppressed: number;
  shopName: string | null;
  shopDomain: string | null;
}

interface Candidate {
  row: MembershipRow;
  shop: ShopStatus | undefined;
  // The fields sortShops ranks on.
  shopId: string;
  role: ContactRole;
  mrr: number;
  name: string | null;
  domain: string | null;
}

function emptyStatusCounts(): Record<CustomerStatus, number> {
  return { paying: 0, trialing: 0, installed: 0, churned: 0, gone: 0 };
}

function emptyRoleCounts(): Record<ContactRole, number> {
  return { owner: 0, staff: 0, collaborator: 0 };
}

function loadMemberships(db: Db, appId: string, roles: ContactRole[]): MembershipRow[] {
  const params: Record<string, unknown> = { appId };
  const roleNames = roles.map((role, index) => {
    params[`role${index}`] = role;
    return `@role${index}`;
  });
  return db
    .prepare(
      `SELECT cs.email AS email,
              cs.shop_id AS shopId,
              cs.role AS role,
              cs.match_method AS matchMethod,
              c.first_name AS firstName,
              c.last_name AS lastName,
              c.source AS source,
              c.created_at AS createdAt,
              c.last_seen_at AS lastSeenAt,
              c.is_suppressed AS isSuppressed,
              (sup.email IS NOT NULL) AS hardSuppressed,
              s.name AS shopName,
              s.myshopify_domain AS shopDomain
         FROM contact_shops cs
         JOIN contacts c ON c.email = cs.email
         LEFT JOIN contact_suppressions sup ON sup.email = cs.email
         LEFT JOIN shops s ON s.id = cs.shop_id
        WHERE cs.app_id = @appId AND cs.role IN (${roleNames.join(', ')})`,
    )
    .all(params) as MembershipRow[];
}

function toRecipient(candidate: Candidate, otherShops: number): Recipient {
  const { row, shop } = candidate;
  return {
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    source: row.source,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    isSuppressed: row.isSuppressed === 1 || row.hardSuppressed === 1,
    matchMethod: row.matchMethod,
    shopId: row.shopId,
    shopName: shop?.name ?? row.shopName,
    shopDomain: shop?.domain ?? row.shopDomain,
    role: row.role,
    status: shop?.status as CustomerStatus,
    mrr: shop?.mrr ?? 0,
    currency: shop?.currency ?? null,
    otherShops,
  };
}

function byShopThenEmail(
  a: { shopName: string | null; shopDomain: string | null; shopId: string; email: string },
  b: { shopName: string | null; shopDomain: string | null; shopId: string; email: string },
): number {
  const left = (a.shopName ?? a.shopDomain ?? a.shopId).toLowerCase();
  const right = (b.shopName ?? b.shopDomain ?? b.shopId).toLowerCase();
  return left.localeCompare(right) || a.email.localeCompare(b.email);
}

function resolveWith(
  def: AudienceDefinition,
  db: Db,
  statuses: Map<string, ShopStatus>,
): AudienceResult {
  const wanted = new Set<CustomerStatus>(def.statuses);
  const kept = new Map<string, Candidate[]>();
  const dropped = new Map<string, Array<{ candidate: Candidate; reason: ExclusionReason }>>();

  const drop = (candidate: Candidate, reason: ExclusionReason) => {
    const list = dropped.get(candidate.row.email) ?? [];
    list.push({ candidate, reason });
    dropped.set(candidate.row.email, list);
  };

  for (const row of loadMemberships(db, def.appId, def.roles)) {
    const shop = statuses.get(row.shopId);
    const candidate: Candidate = {
      row,
      shop,
      shopId: row.shopId,
      role: row.role,
      mrr: shop?.mrr ?? 0,
      name: shop?.name ?? row.shopName,
      domain: shop?.domain ?? row.shopDomain,
    };
    if (!shop) {
      drop(candidate, 'noStatus');
      continue;
    }
    // Not asked for is not left out: nothing to report.
    if (!wanted.has(shop.status)) continue;
    if (row.matchMethod === 'ambiguous') {
      drop(candidate, 'ambiguous');
      continue;
    }
    // Both checks: the is_suppressed mirror can lag a hand-edited row.
    if (row.isSuppressed === 1 || row.hardSuppressed === 1) {
      drop(candidate, 'suppressed');
      continue;
    }
    const list = kept.get(row.email) ?? [];
    list.push(candidate);
    kept.set(row.email, list);
  }

  let merged = 0;
  const recipients: Recipient[] = [];
  for (const candidates of kept.values()) {
    const [primary, ...rest] = sortShops(candidates);
    merged += rest.length;
    recipients.push(toRecipient(primary!, rest.length));
  }
  recipients.sort(byShopThenEmail);

  const byStatus = emptyStatusCounts();
  const byRole = emptyRoleCounts();
  const storeIds = new Set<string>();
  for (const recipient of recipients) {
    byStatus[recipient.status] += 1;
    byRole[recipient.role] += 1;
    storeIds.add(recipient.shopId);
  }

  const excludedPeople: ExcludedPerson[] = [];
  for (const [email, entries] of dropped) {
    if (kept.has(email)) continue;
    const first = sortShops(entries.map((entry) => entry.candidate))[0]!;
    const reason = entries.find((entry) => entry.candidate === first)!.reason;
    const otherShops = entries.length - 1;
    excludedPeople.push({
      ...toRecipient(first, otherShops),
      status: first.shop?.status ?? null,
      reason,
    });
  }
  excludedPeople.sort(byShopThenEmail);

  const excluded = { suppressed: 0, ambiguous: 0, noStatus: 0, merged };
  for (const person of excludedPeople) excluded[person.reason] += 1;

  return { recipients, excludedPeople, excluded, stores: storeIds.size, byStatus, byRole };
}

export function resolveAudience(def: AudienceDefinition, db: Db = getDb()): AudienceResult {
  return resolveWith(def, db, shopStatuses(db, def.appId));
}

/**
 * The number beside each option in the Store status and Role menus: how many
 * recipients that one option would give with the other rule as it stands.
 * After exclusions, so the ticked boxes add up to the headline when nobody is
 * on two stores.
 */
export function optionCounts(def: AudienceDefinition, db: Db = getDb()): OptionCounts {
  const statuses = shopStatuses(db, def.appId);
  const out: OptionCounts = { statuses: emptyStatusCounts(), roles: emptyRoleCounts() };
  for (const status of STATUSES) {
    out.statuses[status] = resolveWith({ ...def, statuses: [status] }, db, statuses).recipients.length;
  }
  for (const role of ROLES) {
    out.roles[role] = resolveWith({ ...def, roles: [role] }, db, statuses).recipients.length;
  }
  return out;
}

function personName(row: { firstName: string | null; lastName: string | null }): string {
  return [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
}

/** Case-insensitive substring on name or email, as /api/contacts searches people. */
export function matchesSearch(
  row: { email: string; firstName: string | null; lastName: string | null },
  search: string,
): boolean {
  const term = search.trim().toLowerCase();
  if (!term) return true;
  return (
    row.email.toLowerCase().includes(term) ||
    (row.firstName ?? '').toLowerCase().includes(term) ||
    (row.lastName ?? '').toLowerCase().includes(term) ||
    personName(row).toLowerCase().includes(term)
  );
}

type SortableRow = Omit<Recipient, 'status'>;

function nameKey(row: SortableRow): string {
  return ((row.firstName ?? '').trim() || row.email).toLowerCase();
}

function shopKey(row: SortableRow): string {
  return (row.shopName?.trim() || row.shopDomain?.trim() || row.shopId).toLowerCase();
}

/** Nullable ISO strings, with NULL lowest — the way SQLite orders them. */
function compareDates(a: string | null, b: string | null, dir: 1 | -1): number {
  if (a === b) return 0;
  if (a === null) return dir === 1 ? -1 : 1;
  if (b === null) return dir === 1 ? 1 : -1;
  return a < b ? -dir : dir;
}

const COMPARE: Record<ContactSort, (a: SortableRow, b: SortableRow) => number> = {
  name: (a, b) =>
    nameKey(a).localeCompare(nameKey(b)) ||
    (a.lastName ?? '').toLowerCase().localeCompare((b.lastName ?? '').toLowerCase()) ||
    a.email.localeCompare(b.email),
  name_desc: (a, b) =>
    nameKey(b).localeCompare(nameKey(a)) ||
    (b.lastName ?? '').toLowerCase().localeCompare((a.lastName ?? '').toLowerCase()) ||
    b.email.localeCompare(a.email),
  email: (a, b) => a.email.localeCompare(b.email),
  mrr: (a, b) => b.mrr - a.mrr || a.email.localeCompare(b.email),
  recent: (a, b) => compareDates(a.lastSeenAt, b.lastSeenAt, -1) || a.email.localeCompare(b.email),
  recent_asc: (a, b) => compareDates(a.lastSeenAt, b.lastSeenAt, 1) || a.email.localeCompare(b.email),
  created: (a, b) => compareDates(a.createdAt, b.createdAt, -1) || a.email.localeCompare(b.email),
  created_asc: (a, b) => compareDates(a.createdAt, b.createdAt, 1) || a.email.localeCompare(b.email),
  customer: (a, b) => shopKey(a).localeCompare(shopKey(b)) || a.email.localeCompare(b.email),
  customer_desc: (a, b) => shopKey(b).localeCompare(shopKey(a)) || a.email.localeCompare(b.email),
};

export function isContactSort(value: unknown): value is ContactSort {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COMPARE, value);
}

/** Orders recipients with the same sort keys the Contacts table uses. */
export function sortRecipients<T extends SortableRow>(rows: T[], sort: ContactSort): T[] {
  return [...rows].sort(COMPARE[sort]);
}
