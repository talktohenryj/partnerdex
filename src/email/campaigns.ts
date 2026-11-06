import crypto from 'node:crypto';
import { getDb, type Db } from '../db/index.js';
import { resolveAudience, validateDefinition, type AudienceDefinition, type Recipient } from '../audiences/audience.js';
import { getAudience } from '../audiences/store.js';
import { getAppLinks, buildPageUrl } from '../apps/links.js';
import { shopDetails } from '../shops/details.js';
import { EmailError } from './errors.js';
import { sendingBlockedReason } from './guard.js';
import { preferenceUrls, TEST_SOURCE } from './links.js';
import { isSubscribed } from './preferences.js';
import {
  fallbacksIn,
  fieldsIn,
  firstNameWithoutFallback,
  formatFrom,
  MERGE_FIELDS,
  pageKeysIn,
  renderEmail,
  validateTemplate,
  type MergeField,
  type MergeValues,
  type RenderedEmail,
  type Sender,
} from './render.js';
import { fromDomain, getSettings } from './settings.js';
import { getTransport, type EmailTransport } from './transport.js';
import { getEmailType, listEmailTypes } from './types.js';
import { nextUtcMidnight, sendWait, setSendWait, type SendWait } from './wait.js';

/**
 * Campaigns: one email to one audience, from draft to sent.
 *
 *   draft → (prepare) → ready → (send, typing the count) → sending → sent
 *
 * Prepare freezes the recipient list into email_sends and snapshots the
 * sender, so what the confirm step shows is exactly what goes out. Any edit
 * to a ready campaign throws the list away and puts it back to draft.
 */

export type CampaignStatus = 'draft' | 'ready' | 'sending' | 'paused' | 'sent' | 'cancelled' | 'failed';
export type SendStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface Campaign {
  id: string;
  name: string;
  subject: string;
  previewText: string;
  body: string;
  audience: AudienceDefinition;
  audienceId: string | null;
  audienceName: string | null;
  emailType: string;
  status: CampaignStatus;
  sender: Sender | null;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  counts: Record<SendStatus, number>;
  /** The send pauses by itself when sent + failed reaches this. */
  pauseAt: number | null;
  /** Delivery events from the Resend webhook (or the one-time backfill). */
  stats: CampaignStats;
  /** Open, click and unsubscribe over delivered; bounce over sent. Null when the base is 0. */
  rates: { open: number | null; click: number | null; unsubscribe: number | null; bounce: number | null };
  /** Set while the campaign is sending but the loop waits for a daily limit or a Resend quota. */
  waiting: SendWait | null;
  createdAt: string;
  updatedAt: string;
  preparedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CampaignStats {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  failed: number;
  skipped: number;
}

interface CampaignRow {
  id: string;
  name: string;
  subject: string;
  preview_text: string;
  body: string;
  audience: string;
  audience_id: string | null;
  email_type: string;
  status: CampaignStatus;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  footer_address: string | null;
  button_color: string | null;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  batch_seq: number;
  batch_started_at: string | null;
  pause_at: number | null;
  created_at: string;
  updated_at: string;
  prepared_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const EDITABLE: CampaignStatus[] = ['draft', 'ready'];
export const PREPARE_MAX_AGE_MS = 60 * 60_000;
export const SAMPLE_SIZE = 10;
const TEST_LIMIT_PER_HOUR = 20;

function now(): string {
  return new Date().toISOString();
}

export function getCampaignRow(id: string, db: Db = getDb()): CampaignRow | null {
  return (db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(id) as CampaignRow | undefined) ?? null;
}

function requireRow(id: string, db: Db): CampaignRow {
  const row = getCampaignRow(id, db);
  if (!row) throw new EmailError(`No campaign with id ${id}.`, 404);
  return row;
}

export type SenderColumns = Pick<CampaignRow, 'from_name' | 'from_email' | 'reply_to' | 'footer_address' | 'button_color'>;

export function senderOf(row: SenderColumns): Sender | null {
  if (!row.from_email) return null;
  return {
    fromName: row.from_name ?? '',
    fromEmail: row.from_email,
    replyTo: row.reply_to ?? '',
    footerAddress: row.footer_address ?? '',
    buttonColor: row.button_color ?? '#2e72d2',
  };
}

function statusCounts(id: string, db: Db): Record<SendStatus, number> {
  const counts: Record<SendStatus, number> = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM email_sends WHERE campaign_id = ? GROUP BY status')
    .all(id) as Array<{ status: SendStatus; n: number }>;
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

function campaignStats(id: string, counts: Record<SendStatus, number>, db: Db): CampaignStats {
  const events = db
    .prepare(
      `SELECT COUNT(delivered_at) AS delivered, COUNT(opened_at) AS opened, COUNT(clicked_at) AS clicked,
              COUNT(bounced_at) AS bounced, COUNT(complained_at) AS complained, COUNT(unsubscribed_at) AS unsubscribed
         FROM email_sends WHERE campaign_id = ?`,
    )
    .get(id) as Omit<CampaignStats, 'sent' | 'failed' | 'skipped'>;
  return { sent: counts.sent, ...events, failed: counts.failed, skipped: counts.skipped };
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

function toCampaign(row: CampaignRow, db: Db): Campaign {
  const counts = statusCounts(row.id, db);
  const stats = campaignStats(row.id, counts, db);
  const audienceName = row.audience_id ? (getAudience(row.audience_id, db)?.name ?? null) : null;
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    previewText: row.preview_text,
    body: row.body,
    audience: JSON.parse(row.audience) as AudienceDefinition,
    audienceId: row.audience_id,
    audienceName,
    emailType: row.email_type,
    status: row.status,
    sender: senderOf(row),
    recipientCount: row.recipient_count,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    counts,
    pauseAt: row.pause_at ?? null,
    stats,
    rates: {
      open: ratio(stats.opened, stats.delivered),
      click: ratio(stats.clicked, stats.delivered),
      unsubscribe: ratio(stats.unsubscribed, stats.delivered),
      bounce: ratio(stats.bounced, stats.sent),
    },
    waiting: row.status === 'sending' ? sendWait() : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preparedAt: row.prepared_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function getCampaign(id: string, db: Db = getDb()): Campaign | null {
  const row = getCampaignRow(id, db);
  return row ? toCampaign(row, db) : null;
}

export function listCampaigns(db: Db = getDb()): Campaign[] {
  const rows = db
    .prepare('SELECT * FROM email_campaigns ORDER BY created_at DESC, id')
    .all() as CampaignRow[];
  return rows.map((row) => toCampaign(row, db));
}

// ---------------------------------------------------------------------------
// Validation

function str(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new EmailError(`${name} must be text.`, 422, name);
  return value;
}

function cleanName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 120) throw new EmailError('Name must be 1 to 120 characters.', 422, 'name');
  return name;
}

function cleanSubject(value: string, required: boolean): string {
  const subject = value.trim();
  if (/[\r\n]/.test(subject)) throw new EmailError('Subject must be on one line.', 422, 'subject');
  if (subject.length > 200 || (required && subject.length < 1)) {
    throw new EmailError('Subject must be 1 to 200 characters.', 422, 'subject');
  }
  return subject;
}

function cleanPreview(value: string): string {
  const preview = value.replace(/[\r\n]+/g, ' ').trim();
  if (preview.length > 150) throw new EmailError('Preview text must be 150 characters at most.', 422, 'previewText');
  return preview;
}

function cleanBody(value: string, required: boolean): string {
  const body = value.replace(/\r\n?/g, '\n');
  if (body.length > 20_000 || (required && body.trim().length < 1)) {
    throw new EmailError('Body must be 1 to 20,000 characters.', 422, 'body');
  }
  return body;
}

function cleanType(value: string, db: Db): string {
  if (!getEmailType(value, db)) {
    throw new EmailError(
      `Unknown email type "${value}". Use one of: ${listEmailTypes(db).map((t) => t.key).join(', ')}.`,
      422,
      'emailType',
    );
  }
  return value;
}

function pageKeysFor(appId: string, db: Db): string[] {
  return getAppLinks(appId, db).pages.map((page) => page.key);
}

/** The audience a request names: a saved one by id, or a definition. */
function audienceFrom(
  input: Record<string, unknown>,
  db: Db,
): { definition: AudienceDefinition; audienceId: string | null } | undefined {
  if (typeof input.audienceId === 'string' && input.audienceId) {
    const saved = getAudience(input.audienceId, db);
    if (!saved) throw new EmailError(`No audience with id ${input.audienceId}.`, 422, 'audience');
    if (saved.stale) {
      throw new EmailError(`Audience "${saved.name}" names an app outside the reporting scope.`, 422, 'audience');
    }
    return { definition: saved.definition, audienceId: saved.id };
  }
  if (input.audience !== undefined) {
    return { definition: validateDefinition(input.audience, db), audienceId: null };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Store

export function createCampaign(input: unknown, db: Db = getDb()): Campaign {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const name = cleanName(str(record, 'name') ?? '');
  const audience = audienceFrom(record, db);
  if (!audience) throw new EmailError('Choose an audience.', 422, 'audience');
  const subject = cleanSubject(str(record, 'subject') ?? '', false);
  const previewText = cleanPreview(str(record, 'previewText') ?? '');
  const body = cleanBody(str(record, 'body') ?? '', false);
  const emailType = cleanType(str(record, 'emailType') ?? 'product_updates', db);
  validateTemplate(subject, body, pageKeysFor(audience.definition.appId, db));

  const id = crypto.randomUUID();
  const at = now();
  db.prepare(
    `INSERT INTO email_campaigns (id, name, subject, preview_text, body, audience, audience_id, email_type,
                                  status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  ).run(id, name, subject, previewText, body, JSON.stringify(audience.definition), audience.audienceId, emailType, at, at);
  return getCampaign(id, db)!;
}

function assertEditable(row: CampaignRow): void {
  if (!EDITABLE.includes(row.status)) {
    throw new EmailError(`This campaign is ${row.status} and can no longer change.`, 409);
  }
}

/** Back to draft: the frozen list no longer matches what would be sent. */
function unprepare(id: string, db: Db): void {
  db.prepare(`DELETE FROM email_sends WHERE campaign_id = ?`).run(id);
  db.prepare(
    `UPDATE email_campaigns
        SET status = 'draft', recipient_count = 0, skipped_count = 0, prepared_at = NULL,
            from_name = NULL, from_email = NULL, reply_to = NULL, footer_address = NULL, button_color = NULL
      WHERE id = ?`,
  ).run(id);
}

export function updateCampaign(id: string, input: unknown, db: Db = getDb()): Campaign {
  const row = requireRow(id, db);
  assertEditable(row);
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  const name = str(record, 'name');
  const subject = str(record, 'subject');
  const previewText = str(record, 'previewText');
  const body = str(record, 'body');
  const emailType = str(record, 'emailType');
  const audience = audienceFrom(record, db);

  const next = {
    name: name === undefined ? row.name : cleanName(name),
    subject: subject === undefined ? row.subject : cleanSubject(subject, false),
    previewText: previewText === undefined ? row.preview_text : cleanPreview(previewText),
    body: body === undefined ? row.body : cleanBody(body, false),
    emailType: emailType === undefined ? row.email_type : cleanType(emailType, db),
    audience: audience ? JSON.stringify(audience.definition) : row.audience,
    audienceId: audience ? audience.audienceId : row.audience_id,
  };
  const appId = (JSON.parse(next.audience) as AudienceDefinition).appId;
  validateTemplate(next.subject, next.body, pageKeysFor(appId, db));

  const changedContent =
    next.subject !== row.subject ||
    next.previewText !== row.preview_text ||
    next.body !== row.body ||
    next.emailType !== row.email_type ||
    next.audience !== row.audience ||
    next.audienceId !== row.audience_id;

  db.transaction(() => {
    db.prepare(
      `UPDATE email_campaigns
          SET name = @name, subject = @subject, preview_text = @previewText, body = @body,
              email_type = @emailType, audience = @audience, audience_id = @audienceId, updated_at = @at
        WHERE id = @id`,
    ).run({ ...next, at: now(), id });
    if (changedContent && row.status === 'ready') unprepare(id, db);
  })();
  return getCampaign(id, db)!;
}

export function deleteCampaign(id: string, db: Db = getDb()): void {
  const row = requireRow(id, db);
  assertEditable(row);
  db.transaction(() => {
    db.prepare('DELETE FROM email_sends WHERE campaign_id = ?').run(id);
    db.prepare('DELETE FROM email_campaigns WHERE id = ?').run(id);
  })();
}

// ---------------------------------------------------------------------------
// Merge values

function appName(appId: string, db: Db): string {
  const row = db.prepare('SELECT name FROM apps WHERE id = ?').get(appId) as { name: string } | undefined;
  return row?.name ?? '';
}

export function mergeFor(recipient: Recipient, appId: string, db: Db, links = getAppLinks(appId, db)): MergeValues {
  const details = shopDetails(recipient.shopId, db);
  const pages: Record<string, string | null> = {};
  for (const page of links.pages) pages[page.key] = buildPageUrl(links, recipient.shopDomain, page.key);
  return {
    fields: {
      first_name: recipient.firstName,
      last_name: recipient.lastName,
      email: recipient.email,
      role: recipient.role,
      shop_name: recipient.shopName,
      shop_domain: details?.primaryDomain ?? recipient.shopDomain,
      myshopify_domain: recipient.shopDomain,
      store_status: recipient.status,
      app_name: appName(appId, db),
      country: details?.country ?? null,
      currency: details?.currency ?? null,
      timezone: details?.timezone ?? null,
      shopify_plan: details?.shopifyPlan ?? null,
    },
    pages,
  };
}

const PLACEHOLDER_MERGE: MergeValues = {
  fields: {
    first_name: 'Alex',
    last_name: 'Sample',
    email: 'alex@example.com',
    role: 'owner',
    shop_name: 'Example Store',
    shop_domain: 'example-store.com',
    myshopify_domain: 'example-store.myshopify.com',
    store_status: 'paying',
    country: 'US',
    currency: 'USD',
    timezone: 'America/New_York',
    shopify_plan: 'basic',
  },
  pages: {},
};

function placeholderMerge(appId: string, db: Db): MergeValues {
  const links = getAppLinks(appId, db);
  const pages: Record<string, string | null> = {};
  for (const page of links.pages) pages[page.key] = buildPageUrl(links, 'example-store.myshopify.com', page.key);
  return { fields: { ...PLACEHOLDER_MERGE.fields, app_name: appName(appId, db) || 'Your App' }, pages };
}

function typeLabel(key: string, db: Db): string {
  return getEmailType(key, db)?.label ?? key;
}

// ---------------------------------------------------------------------------
// Preview as a recipient

export type PreviewFilter = 'all' | 'blank' | 'nolink';

interface PoolEntry {
  email: string;
  merge: MergeValues;
}

/**
 * Who the preview can show: the frozen list once the campaign is prepared
 * (not the skipped rows), else the audience as it resolves now. Sorted by
 * email, the order the send uses.
 */
function previewPool(row: CampaignRow, db: Db): PoolEntry[] {
  const prepared = db
    .prepare(
      `SELECT email, merge FROM email_sends WHERE campaign_id = ? AND status <> 'skipped' ORDER BY email`,
    )
    .all(row.id) as Array<{ email: string; merge: string }>;
  if (prepared.length > 0) {
    return prepared.map((entry) => ({ email: entry.email, merge: JSON.parse(entry.merge) as MergeValues }));
  }
  const definition = JSON.parse(row.audience) as AudienceDefinition;
  try {
    const links = getAppLinks(definition.appId, db);
    return resolveAudience(definition, db)
      .recipients.map((recipient) => ({ email: recipient.email, merge: mergeFor(recipient, definition.appId, db, links) }))
      .sort((a, b) => a.email.localeCompare(b.email));
  } catch {
    // An audience whose app left scope previews with placeholders.
    return [];
  }
}

interface Usage {
  fields: MergeField[];
  fallbacks: Partial<Record<MergeField, string[]>>;
  pages: string[];
}

function usageOf(row: CampaignRow): Usage {
  try {
    return {
      fields: fieldsIn(row.subject, row.preview_text, row.body),
      fallbacks: fallbacksIn(row.subject, row.preview_text, row.body),
      pages: pageKeysIn(row.body),
    };
  } catch {
    return { fields: [], fallbacks: {}, pages: [] };
  }
}

/** The used fields that are blank for this person, and the used pages with no link for their store. */
function gapsOf(merge: MergeValues, usage: Usage): { blank: MergeField[]; noLink: string[] } {
  return {
    blank: usage.fields.filter((field) => !(merge.fields[field] ?? '').trim()),
    noLink: usage.pages.filter((key) => !merge.pages[key]),
  };
}

function matchesFilter(merge: MergeValues, usage: Usage, filter: PreviewFilter): boolean {
  if (filter === 'all') return true;
  const gaps = gapsOf(merge, usage);
  return filter === 'blank' ? gaps.blank.length > 0 : gaps.noLink.length > 0;
}

export function asFilter(value: unknown): PreviewFilter {
  return value === 'blank' || value === 'nolink' ? value : 'all';
}

export interface PreviewRecipientRow {
  email: string;
  firstName: string | null;
  lastName: string | null;
  shopName: string | null;
  status: string | null;
  blank: string[];
  noLink: string[];
}

function rowOf(entry: PoolEntry, usage: Usage): PreviewRecipientRow {
  const gaps = gapsOf(entry.merge, usage);
  return {
    email: entry.email,
    firstName: entry.merge.fields.first_name ?? null,
    lastName: entry.merge.fields.last_name ?? null,
    shopName: entry.merge.fields.shop_name ?? null,
    status: entry.merge.fields.store_status ?? null,
    blank: gaps.blank,
    noLink: gaps.noLink,
  };
}

/** The picker's list: search by name, email, or store, and filter to the people with a gap. */
export function previewRecipients(
  id: string,
  options: { q?: string; filter?: PreviewFilter; offset?: number; limit?: number } = {},
  db: Db = getDb(),
): {
  total: number;
  counts: Record<PreviewFilter, number>;
  matching: number;
  rows: PreviewRecipientRow[];
} {
  const row = requireRow(id, db);
  const usage = usageOf(row);
  const pool = previewPool(row, db);
  const filter = options.filter ?? 'all';
  const term = (options.q ?? '').trim().toLowerCase();
  const counts: Record<PreviewFilter, number> = { all: pool.length, blank: 0, nolink: 0 };
  for (const entry of pool) {
    const gaps = gapsOf(entry.merge, usage);
    if (gaps.blank.length) counts.blank += 1;
    if (gaps.noLink.length) counts.nolink += 1;
  }
  const matching = pool.filter((entry) => {
    if (!matchesFilter(entry.merge, usage, filter)) return false;
    if (!term) return true;
    const f = entry.merge.fields;
    return [entry.email, f.first_name, f.last_name, f.shop_name, f.myshopify_domain]
      .some((value) => (value ?? '').toLowerCase().includes(term));
  });
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  return {
    total: pool.length,
    counts,
    matching: matching.length,
    rows: matching.slice(offset, offset + limit).map((entry) => rowOf(entry, usage)),
  };
}

/** The person to preview: the one asked for, else the first in the filter, else placeholders. */
function choose(
  row: CampaignRow,
  db: Db,
  email: unknown,
  filter: PreviewFilter = 'all',
): {
  entry: PoolEntry;
  usage: Usage;
  position: { index: number | null; total: number; prevEmail: string | null; nextEmail: string | null };
} {
  const usage = usageOf(row);
  const pool = previewPool(row, db);
  const list = filter === 'all' ? pool : pool.filter((entry) => matchesFilter(entry.merge, usage, filter));
  const wanted = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const entry =
    (wanted && (list.find((candidate) => candidate.email === wanted) ?? pool.find((candidate) => candidate.email === wanted))) ||
    list[0] ||
    pool[0] || { email: 'alex@example.com', merge: placeholderMerge((JSON.parse(row.audience) as AudienceDefinition).appId, db) };
  const at = list.indexOf(entry);
  // Arrows step through the filtered list and wrap; from outside it, they start at its ends.
  const prev = list.length ? list[at >= 0 ? (at - 1 + list.length) % list.length : list.length - 1]! : null;
  const next = list.length ? list[at >= 0 ? (at + 1) % list.length : 0]! : null;
  return {
    entry,
    usage,
    position: {
      index: at >= 0 ? at + 1 : null,
      total: list.length,
      prevEmail: prev && prev !== entry ? prev.email : null,
      nextEmail: next && next !== entry ? next.email : null,
    },
  };
}

export interface PreviewVariable {
  key: string;
  value: string | null;
  used: boolean;
  /** What a blank shows instead, one per distinct fallback the email uses. */
  fallbacks: string[];
}

export interface PreviewPage {
  key: string;
  label: string;
  url: string | null;
  used: boolean;
}

/**
 * The preview the compose screen shows, as one recipient. Uses the saved
 * sender settings when the campaign is not prepared, and never needs
 * RESEND_API_KEY. Fallback values and missing links are marked, for the
 * dashboard only.
 */
export function renderPreview(
  id: string,
  options: { email?: unknown; filter?: PreviewFilter } = {},
  db: Db = getDb(),
): RenderedEmail & {
  from: string;
  replyTo: string;
  to: string;
  recipient: PreviewRecipientRow;
  position: { index: number | null; total: number; prevEmail: string | null; nextEmail: string | null };
  variables: PreviewVariable[];
  pages: PreviewPage[];
  blankCount: number;
} {
  const row = requireRow(id, db);
  const settings = getSettings(db);
  const sender = senderOf(row) ?? settings;
  const { entry, usage, position } = choose(row, db, options.email, options.filter);
  const placeholderUrl = 'https://example.com/p/preview';
  const rendered = renderEmail({
    subject: row.subject,
    previewText: row.preview_text,
    body: row.body,
    merge: entry.merge,
    sender,
    typeLabel: typeLabel(row.email_type, db),
    urls: { page: placeholderUrl, unsubscribe: `${placeholderUrl}?off=1`, oneClick: `${placeholderUrl}/one-click` },
    preview: true,
  });
  const definition = JSON.parse(row.audience) as AudienceDefinition;
  const labels = new Map(getAppLinks(definition.appId, db).pages.map((page) => [page.key, page.label]));
  const pageKeys = [...new Set([...Object.keys(entry.merge.pages), ...usage.pages])];
  const gaps = gapsOf(entry.merge, usage);
  return {
    ...rendered,
    from: sender.fromEmail ? formatFrom(sender) : '',
    replyTo: sender.replyTo,
    to: entry.email,
    recipient: rowOf(entry, usage),
    position,
    variables: MERGE_FIELDS.map((key) => ({
      key,
      value: (entry.merge.fields[key] ?? '').trim() || null,
      used: usage.fields.includes(key),
      fallbacks: usage.fallbacks[key] ?? [],
    })),
    pages: pageKeys.map((key) => ({
      key,
      label: labels.get(key) ?? key,
      url: entry.merge.pages[key] ?? null,
      used: usage.pages.includes(key),
    })),
    blankCount: gaps.blank.length + gaps.noLink.length,
  };
}

// ---------------------------------------------------------------------------
// Prepare, send, cancel

export interface PrepareResult {
  count: number;
  excluded: { suppressed: number; ambiguous: number; noStatus: number; merged: number; unsubscribedType: number };
  typeLabel: string;
  sample: Array<{ email: string; firstName: string | null; shopName: string | null }>;
  /** Recipients with no first name, when the template uses {{first_name}} with no fallback. */
  missingFirstName: number;
  /** Recipients whose store has no admin link for a page the body uses. */
  missingPageLinks: number;
  sender: Sender;
  from: string;
}

function assertCanSend(db: Db): void {
  const reason = sendingBlockedReason(db);
  if (reason) throw new EmailError(reason, 403);
}

function requireTransport(): EmailTransport {
  const transport = getTransport();
  if (!transport) throw new EmailError('Set RESEND_API_KEY to send email through Resend.', 403);
  return transport;
}

async function assertDomainVerified(transport: EmailTransport, domain: string): Promise<void> {
  const status = await transport.domainStatus(domain);
  if (status !== 'verified') {
    const said = status === 'not_found' ? 'is not in your Resend account' : `is ${status} in Resend`;
    throw new EmailError(`The From domain ${domain} ${said}. Verify it in Resend before you send.`, 422);
  }
}

export async function prepareCampaign(id: string, db: Db = getDb()): Promise<PrepareResult> {
  assertCanSend(db);
  const row = requireRow(id, db);
  assertEditable(row);
  cleanSubject(row.subject, true);
  cleanBody(row.body, true);
  const definition = JSON.parse(row.audience) as AudienceDefinition;
  const links = getAppLinks(definition.appId, db);
  validateTemplate(row.subject, row.body, links.pages.map((page) => page.key));

  const settings = getSettings(db);
  await assertDomainVerified(requireTransport(), fromDomain(settings));

  // The audience is re-validated: its app may have left the reporting scope.
  const resolved = resolveAudience(validateDefinition(definition, db), db);
  const usedPages = pageKeysIn(row.body);
  const checkFirstName = firstNameWithoutFallback(row.subject, row.body);

  const queued: Array<{ recipient: Recipient; merge: MergeValues }> = [];
  const turnedOff: Array<{ recipient: Recipient; merge: MergeValues }> = [];
  for (const recipient of resolved.recipients) {
    const entry = { recipient, merge: mergeFor(recipient, definition.appId, db, links) };
    (isSubscribed(recipient.email, row.email_type, db) ? queued : turnedOff).push(entry);
  }
  if (queued.length === 0) {
    throw new EmailError('This audience has no one to send to right now.', 422);
  }

  const at = now();
  db.transaction(() => {
    db.prepare('DELETE FROM email_sends WHERE campaign_id = ?').run(id);
    const insert = db.prepare(
      `INSERT INTO email_sends (campaign_id, email, shop_id, merge, status, skip_reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const { recipient, merge } of queued) {
      insert.run(id, recipient.email, recipient.shopId, JSON.stringify(merge), 'queued', null);
    }
    for (const { recipient, merge } of turnedOff) {
      insert.run(id, recipient.email, recipient.shopId, JSON.stringify(merge), 'skipped', 'unsubscribed_type');
    }
    db.prepare(
      `UPDATE email_campaigns
          SET status = 'ready', recipient_count = @count, skipped_count = @skipped, sent_count = 0, failed_count = 0,
              from_name = @fromName, from_email = @fromEmail, reply_to = @replyTo,
              footer_address = @footerAddress, button_color = @buttonColor,
              prepared_at = @at, updated_at = @at
        WHERE id = @id`,
    ).run({ ...settings, count: queued.length, skipped: turnedOff.length, at, id });
  })();

  return {
    count: queued.length,
    excluded: { ...resolved.excluded, unsubscribedType: turnedOff.length },
    typeLabel: typeLabel(row.email_type, db),
    sample: queued.slice(0, SAMPLE_SIZE).map(({ recipient }) => ({
      email: recipient.email,
      firstName: recipient.firstName,
      shopName: recipient.shopName,
    })),
    missingFirstName: checkFirstName ? queued.filter(({ recipient }) => !recipient.firstName?.trim()).length : 0,
    missingPageLinks: usedPages.length
      ? queued.filter(({ merge }) => usedPages.some((key) => !merge.pages[key])).length
      : 0,
    sender: {
      fromName: settings.fromName,
      fromEmail: settings.fromEmail,
      replyTo: settings.replyTo,
      footerAddress: settings.footerAddress,
      buttonColor: settings.buttonColor,
    },
    from: formatFrom(settings),
  };
}

let onStart: (() => void) | null = null;

/** The runner registers here, so starting a send wakes it at once. */
export function onSendStarted(listener: (() => void) | null): void {
  onStart = listener;
}

export const PAUSE_CHOICES = [5, 10, 25] as const;

/** null = send everything; else a count of 1 to 1,000 emails before the send pauses. */
function cleanPauseAfter(value: unknown): number | null {
  if (value === undefined || value === null || value === '' || value === false) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new EmailError('Pause after must be a whole number from 1 to 1,000.', 422, 'pauseAfter');
  }
  return n;
}

function wake(): void {
  onStart?.();
}

/**
 * Start the send. With `pauseAfter`, the send loop sends that many emails,
 * then sets the campaign to paused until someone resumes or cancels it.
 */
export function startSend(
  id: string,
  confirmCount: unknown,
  db: Db = getDb(),
  clock = Date.now,
  pauseAfter: unknown = null,
): Campaign {
  assertCanSend(db);
  const row = requireRow(id, db);
  if (row.status !== 'ready') {
    throw new EmailError(
      row.status === 'draft' ? 'Prepare the campaign before you send it.' : `This campaign is ${row.status}.`,
      409,
    );
  }
  if (Number(confirmCount) !== row.recipient_count || typeof confirmCount === 'boolean') {
    throw new EmailError(`Type ${row.recipient_count} to confirm.`, 409);
  }
  if (!row.prepared_at || clock() - Date.parse(row.prepared_at) > PREPARE_MAX_AGE_MS) {
    throw new EmailError('The list is over an hour old. Prepare it again.', 409);
  }
  const first = cleanPauseAfter(pauseAfter);
  const pauseAt = first !== null && first < row.recipient_count ? first : null;
  const at = new Date(clock()).toISOString();
  db.prepare(
    `UPDATE email_campaigns SET status = 'sending', pause_at = ?, started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'ready'`,
  ).run(pauseAt, at, at, id);
  wake();
  return getCampaign(id, db)!;
}

/** Stop after the batch in flight. Nothing queued is lost; resume sends it. */
export function pauseCampaign(id: string, db: Db = getDb()): Campaign {
  const row = requireRow(id, db);
  if (row.status !== 'sending') throw new EmailError(`This campaign is ${row.status} and cannot be paused.`, 409);
  const counts = statusCounts(id, db);
  if (counts.queued === 0) throw new EmailError('Every email has gone out already.', 409);
  db.prepare(`UPDATE email_campaigns SET status = 'paused', pause_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
  return getCampaign(id, db)!;
}

/**
 * Send the rest, or with `pauseAfter` only that many more, then pause again.
 * Opt-outs and suppressions are checked again before each batch, so a resume
 * after a long pause sends nothing to someone who left meanwhile.
 */
export function resumeCampaign(id: string, pauseAfter: unknown = null, db: Db = getDb()): Campaign {
  assertCanSend(db);
  const row = requireRow(id, db);
  if (row.status !== 'paused') throw new EmailError(`This campaign is ${row.status}, not paused.`, 409);
  const counts = statusCounts(id, db);
  const more = cleanPauseAfter(pauseAfter);
  const done = counts.sent + counts.failed + counts.sending;
  const pauseAt = more !== null && more < counts.queued ? done + more : null;
  db.prepare(`UPDATE email_campaigns SET status = 'sending', pause_at = ?, updated_at = ? WHERE id = ?`).run(
    pauseAt,
    now(),
    id,
  );
  wake();
  return getCampaign(id, db)!;
}

export interface SendRow {
  email: string;
  name: string | null;
  shopName: string | null;
  status: SendStatus;
  skipReason: string | null;
  error: string | null;
  sentAt: string | null;
  resendId: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
  unsubscribedAt: string | null;
}

/** A recipients filter: a send status, or "has this delivery event", or everyone. */
export type SendFilter = 'all' | SendStatus | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained' | 'unsubscribed';

const EVENT_FILTERS: Partial<Record<SendFilter, string>> = {
  delivered: 'delivered_at',
  opened: 'opened_at',
  clicked: 'clicked_at',
  bounced: 'bounced_at',
  complained: 'complained_at',
  unsubscribed: 'unsubscribed_at',
};

export function asSendFilter(value: unknown): SendFilter | null {
  const filters: SendFilter[] = [
    'all', 'queued', 'sending', 'sent', 'failed', 'skipped',
    'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed',
  ];
  return typeof value === 'string' && (filters as string[]).includes(value) ? (value as SendFilter) : null;
}

/**
 * The recipients of a campaign: by status (the paused screen's "who got it
 * already"), or by delivery event (the report), searchable by address.
 */
export function listSends(
  id: string,
  options: { status?: SendFilter; q?: string; limit?: number; offset?: number } = {},
  db: Db = getDb(),
): { total: number; rows: SendRow[] } {
  requireRow(id, db);
  const filter = options.status ?? 'sent';
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const where = ['campaign_id = @id'];
  const event = EVENT_FILTERS[filter];
  if (event) where.push(`${event} IS NOT NULL`);
  else if (filter !== 'all') where.push('status = @status');
  const q = (options.q ?? '').trim().toLowerCase();
  if (q) where.push(`(email LIKE @q ESCAPE '\\' OR LOWER(merge) LIKE @q ESCAPE '\\')`);
  const params = { id, status: filter, q: `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit, offset };
  const clause = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM email_sends WHERE ${clause}`).get(params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT email, merge, status, skip_reason, error, sent_at, resend_id, delivered_at, opened_at, clicked_at,
              bounced_at, complained_at, unsubscribed_at
         FROM email_sends WHERE ${clause}
        ORDER BY ${event ? `${event} DESC,` : ''} sent_at IS NULL, sent_at, email LIMIT @limit OFFSET @offset`,
    )
    .all(params) as Array<{
    email: string;
    merge: string;
    status: SendStatus;
    skip_reason: string | null;
    error: string | null;
    sent_at: string | null;
    resend_id: string | null;
    delivered_at: string | null;
    opened_at: string | null;
    clicked_at: string | null;
    bounced_at: string | null;
    complained_at: string | null;
    unsubscribed_at: string | null;
  }>;
  return {
    total,
    rows: rows.map((entry) => {
      const merge = JSON.parse(entry.merge) as MergeValues;
      const name = [merge.fields.first_name, merge.fields.last_name].filter((part) => part && part.trim()).join(' ');
      return {
        email: entry.email,
        name: name || null,
        shopName: merge.fields.shop_name ?? null,
        status: entry.status,
        skipReason: entry.skip_reason,
        error: entry.error,
        sentAt: entry.sent_at,
        resendId: entry.resend_id,
        deliveredAt: entry.delivered_at,
        openedAt: entry.opened_at,
        clickedAt: entry.clicked_at,
        bouncedAt: entry.bounced_at,
        complainedAt: entry.complained_at,
        unsubscribedAt: entry.unsubscribed_at,
      };
    }),
  };
}

/** Recount the four counters from email_sends, the one source of truth. */
export function refreshCounters(id: string, db: Db = getDb()): Record<SendStatus, number> {
  const counts = statusCounts(id, db);
  db.prepare(
    `UPDATE email_campaigns SET sent_count = ?, failed_count = ?, skipped_count = ?, updated_at = ? WHERE id = ?`,
  ).run(counts.sent, counts.failed, counts.skipped, now(), id);
  return counts;
}

// ---------------------------------------------------------------------------
// Retry failed

/** The error S3 writes when a batch outlives Resend's idempotency key. */
export const IDEMPOTENCY_WINDOW_ERROR = 'idempotency window passed — check Resend before resending';

/** The start of the error on a row Resend accepted and then reported as failed (email.failed). */
export const RESEND_FAILED_PREFIX = 'Resend could not send';

/** Rows that can be sent again: Resend never accepted them, or it said it did not send them. */
const RETRYABLE_ROW = `(resend_id IS NULL OR error LIKE '${RESEND_FAILED_PREFIX}%')`;

export type ResendFailedOutcome = 'requeued' | 'failed' | 'unknown_email' | 'not_sent';

/**
 * Resend accepted an email and then reported that it did not send it.
 *
 * reached_daily_quota: Resend sent nothing, so the row goes back in the queue
 * and the loop waits until 00:00 UTC, the same as a 429 quota answer. A
 * finished campaign opens again to send it; a cancelled one does not.
 * Any other reason, or an unknown one: the row is failed with the reason, and
 * Retry failed can send it again.
 */
export function markResendFailed(
  resendId: string,
  reason: string | null,
  db: Db = getDb(),
  clock: () => number = Date.now,
): ResendFailedOutcome {
  const row = db.prepare('SELECT campaign_id, email, status FROM email_sends WHERE resend_id = ?').get(resendId) as
    | { campaign_id: string; email: string; status: SendStatus }
    | undefined;
  if (!row) return 'unknown_email';
  if (row.status !== 'sent') return 'not_sent';
  const campaign = requireRow(row.campaign_id, db);
  const at = new Date(clock()).toISOString();

  if (reason === 'reached_daily_quota' && campaign.status !== 'cancelled') {
    db.transaction(() => {
      db.prepare(
        `UPDATE email_sends SET status = 'queued', batch_key = NULL, resend_id = NULL, sent_at = NULL, error = NULL
          WHERE campaign_id = ? AND email = ?`,
      ).run(row.campaign_id, row.email);
      if (campaign.status === 'sent' || campaign.status === 'failed') {
        db.prepare(
          `UPDATE email_campaigns SET status = 'sending', pause_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(at, row.campaign_id);
      }
      refreshCounters(row.campaign_id, db);
    })();
    setSendWait({ reason: 'daily_quota', until: new Date(nextUtcMidnight(clock())).toISOString() });
    return 'requeued';
  }

  const text = `${RESEND_FAILED_PREFIX}: ${reason ?? 'no reason given'}`;
  db.transaction(() => {
    db.prepare(`UPDATE email_sends SET status = 'failed', error = ? WHERE campaign_id = ? AND email = ?`).run(
      text.slice(0, 500),
      row.campaign_id,
      row.email,
    );
    refreshCounters(row.campaign_id, db);
  })();
  return 'failed';
}

export interface FailureGroup {
  error: string;
  count: number;
  /** Resend may have sent these: the outcome of the request is unknown. */
  uncertain: boolean;
  /** Resend refused the request (a 4xx other than 429): the same email would fail again. */
  rejected: boolean;
}

/** Failed rows that Resend never accepted, grouped by error text, largest first. */
export function failureGroups(id: string, db: Db = getDb()): FailureGroup[] {
  requireRow(id, db);
  const rows = db
    .prepare(
      `SELECT COALESCE(error, '') AS error, COUNT(*) AS n FROM email_sends
        WHERE campaign_id = ? AND status = 'failed' AND ${RETRYABLE_ROW}
        GROUP BY COALESCE(error, '') ORDER BY n DESC, error`,
    )
    .all(id) as Array<{ error: string; n: number }>;
  return rows.map((row) => ({
    error: row.error,
    count: row.n,
    uncertain: row.error === IDEMPOTENCY_WINDOW_ERROR,
    rejected: /invalid|not verified|validation|not allowed/i.test(row.error),
  }));
}

/**
 * Put the failed rows with the chosen errors back in the queue and send the
 * campaign again. A row with a resend_id moves only when Resend reported it
 * failed (email.failed); otherwise Resend accepted it and it stays.
 * `confirmCount` must be the number of rows that will move.
 */
export function retryFailed(id: string, errors: unknown, confirmCount: unknown, db: Db = getDb()): Campaign {
  assertCanSend(db);
  const row = requireRow(id, db);
  if (row.status !== 'sent' && row.status !== 'failed') {
    throw new EmailError(`This campaign is ${row.status}. Retry works only on a sent or failed campaign.`, 409);
  }
  if (!Array.isArray(errors) || errors.length === 0 || errors.some((error) => typeof error !== 'string')) {
    throw new EmailError('Choose at least one group of failures to retry.', 422, 'errors');
  }
  const chosen = errors as string[];
  const marks = chosen.map(() => '?').join(', ');
  const match = `campaign_id = ? AND status = 'failed' AND ${RETRYABLE_ROW} AND COALESCE(error, '') IN (${marks})`;
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM email_sends WHERE ${match}`).get(id, ...chosen) as { n: number }).n;
  if (count === 0) throw new EmailError('No failed emails match those groups.', 409);
  if (typeof confirmCount === 'boolean' || Number(confirmCount) !== count) {
    throw new EmailError(`Type ${count} to confirm.`, 400);
  }
  const at = now();
  db.transaction(() => {
    db.prepare(
      `UPDATE email_sends SET status = 'queued', batch_key = NULL, resend_id = NULL, sent_at = NULL, error = NULL WHERE ${match}`,
    ).run(id, ...chosen);
    db.prepare(
      `UPDATE email_campaigns SET status = 'sending', pause_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(at, id);
    refreshCounters(id, db);
  })();
  wake();
  return getCampaign(id, db)!;
}

export function cancelCampaign(id: string, db: Db = getDb()): Campaign {
  const row = requireRow(id, db);
  if (row.status !== 'sending' && row.status !== 'ready' && row.status !== 'paused') {
    throw new EmailError(`This campaign is ${row.status} and cannot be cancelled.`, 409);
  }
  const at = now();
  db.transaction(() => {
    db.prepare(
      `UPDATE email_sends SET status = 'skipped', skip_reason = 'cancelled' WHERE campaign_id = ? AND status = 'queued'`,
    ).run(id);
    db.prepare(`UPDATE email_campaigns SET status = 'cancelled', pause_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?`).run(
      at,
      at,
      id,
    );
    refreshCounters(id, db);
  })();
  return getCampaign(id, db)!;
}

// ---------------------------------------------------------------------------
// Test sends

const testLog = new Map<string, number[]>();

export function resetTestLimits(): void {
  testLog.clear();
}

/** `as` picks whose values the test uses (an email in the audience); it still goes to `to`. */
export async function sendTest(
  id: string,
  to: unknown,
  as: unknown = undefined,
  db: Db = getDb(),
): Promise<{ id: string; to: string; subject: string }> {
  assertCanSend(db);
  const row = requireRow(id, db);
  const settings = getSettings(db);
  const address = (typeof to === 'string' && to.trim() ? to : settings.replyTo || settings.fromEmail)
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new EmailError('Enter an address to send the test to.', 422, 'to');
  }
  cleanSubject(row.subject, true);
  cleanBody(row.body, true);

  const at = Date.now();
  const recent = (testLog.get(id) ?? []).filter((time) => at - time < 60 * 60_000);
  if (recent.length >= TEST_LIMIT_PER_HOUR) {
    throw new EmailError(`At most ${TEST_LIMIT_PER_HOUR} test emails per campaign per hour.`, 429);
  }

  const sender = senderOf(row) ?? settings;
  const { merge } = choose(row, db, as).entry;
  const urls = preferenceUrls({ email: address, typeKey: row.email_type, sourceId: TEST_SOURCE });
  const rendered = renderEmail({
    subject: row.subject,
    previewText: row.preview_text,
    body: row.body,
    merge,
    sender,
    typeLabel: typeLabel(row.email_type, db),
    urls,
  });
  const subject = `[Test] ${rendered.subject}`;
  const result = await requireTransport().sendOne({
    from: formatFrom(sender),
    to: address,
    replyTo: sender.replyTo || undefined,
    subject,
    text: rendered.text,
    html: rendered.html,
    headers: rendered.headers,
  });
  recent.push(at);
  testLog.set(id, recent);
  return { id: result.id, to: address, subject };
}
