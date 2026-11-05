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
  firstNameWithoutFallback,
  formatFrom,
  pageKeysIn,
  renderEmail,
  validateTemplate,
  type MergeValues,
  type RenderedEmail,
  type Sender,
} from './render.js';
import { fromDomain, getSettings } from './settings.js';
import { getTransport, type EmailTransport } from './transport.js';
import { getEmailType, listEmailTypes } from './types.js';

/**
 * Campaigns: one email to one audience, from draft to sent.
 *
 *   draft → (prepare) → ready → (send, typing the count) → sending → sent
 *
 * Prepare freezes the recipient list into email_sends and snapshots the
 * sender, so what the confirm step shows is exactly what goes out. Any edit
 * to a ready campaign throws the list away and puts it back to draft.
 */

export type CampaignStatus = 'draft' | 'ready' | 'sending' | 'sent' | 'cancelled' | 'failed';
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
  createdAt: string;
  updatedAt: string;
  preparedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
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

function toCampaign(row: CampaignRow, db: Db): Campaign {
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
    counts: statusCounts(row.id, db),
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

/** The first prepared recipient, else the first resolved one, else placeholders. */
function sampleMerge(row: CampaignRow, db: Db): { merge: MergeValues; email: string } {
  const prepared = db
    .prepare(`SELECT email, merge FROM email_sends WHERE campaign_id = ? ORDER BY email LIMIT 1`)
    .get(row.id) as { email: string; merge: string } | undefined;
  if (prepared) return { merge: JSON.parse(prepared.merge) as MergeValues, email: prepared.email };
  const definition = JSON.parse(row.audience) as AudienceDefinition;
  try {
    const first = resolveAudience(definition, db).recipients[0];
    if (first) return { merge: mergeFor(first, definition.appId, db), email: first.email };
  } catch {
    // An audience whose app left scope still previews with placeholders.
  }
  return { merge: placeholderMerge(definition.appId, db), email: 'alex@example.com' };
}

/**
 * The preview the compose screen shows. Uses the saved sender settings when
 * the campaign is not prepared, and never needs RESEND_API_KEY.
 */
export function renderPreview(id: string, db: Db = getDb()): RenderedEmail & { from: string; replyTo: string; to: string } {
  const row = requireRow(id, db);
  const settings = getSettings(db);
  const sender = senderOf(row) ?? settings;
  const { merge, email } = sampleMerge(row, db);
  const placeholderUrl = 'https://example.com/p/preview';
  const rendered = renderEmail({
    subject: row.subject,
    previewText: row.preview_text,
    body: row.body,
    merge,
    sender,
    typeLabel: typeLabel(row.email_type, db),
    urls: { page: placeholderUrl, unsubscribe: `${placeholderUrl}?off=1`, oneClick: `${placeholderUrl}/one-click` },
  });
  return {
    ...rendered,
    from: sender.fromEmail ? formatFrom(sender) : '',
    replyTo: sender.replyTo,
    to: email,
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

export function startSend(id: string, confirmCount: unknown, db: Db = getDb(), clock = Date.now): Campaign {
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
  const at = new Date(clock()).toISOString();
  db.prepare(
    `UPDATE email_campaigns SET status = 'sending', started_at = ?, updated_at = ? WHERE id = ? AND status = 'ready'`,
  ).run(at, at, id);
  onStart?.();
  return getCampaign(id, db)!;
}

/** Recount the four counters from email_sends, the one source of truth. */
export function refreshCounters(id: string, db: Db = getDb()): Record<SendStatus, number> {
  const counts = statusCounts(id, db);
  db.prepare(
    `UPDATE email_campaigns SET sent_count = ?, failed_count = ?, skipped_count = ?, updated_at = ? WHERE id = ?`,
  ).run(counts.sent, counts.failed, counts.skipped, now(), id);
  return counts;
}

export function cancelCampaign(id: string, db: Db = getDb()): Campaign {
  const row = requireRow(id, db);
  if (row.status !== 'sending' && row.status !== 'ready') {
    throw new EmailError(`This campaign is ${row.status} and cannot be cancelled.`, 409);
  }
  const at = now();
  db.transaction(() => {
    db.prepare(
      `UPDATE email_sends SET status = 'skipped', skip_reason = 'cancelled' WHERE campaign_id = ? AND status = 'queued'`,
    ).run(id);
    db.prepare(`UPDATE email_campaigns SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?`).run(
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

export async function sendTest(
  id: string,
  to: unknown,
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
  const { merge } = sampleMerge(row, db);
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
