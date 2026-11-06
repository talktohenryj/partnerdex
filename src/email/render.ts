import { EmailError } from './errors.js';

/**
 * One email from a template and one recipient's values.
 *
 * The body is a light Markdown: paragraphs, line breaks, links, bold, italic,
 * and bare https URLs. No dependency, and nothing a person types becomes HTML
 * — the body is escaped first and formatted after, so `<script>` arrives as
 * text. Merge tags are swapped in last, from placeholders, so a value such as
 * a shop called "**Sale**" is never read as formatting.
 */

export const MERGE_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'role',
  'shop_name',
  'shop_domain',
  'myshopify_domain',
  'store_status',
  'app_name',
  'country',
  'currency',
  'timezone',
  'shopify_plan',
] as const;

export type MergeField = (typeof MERGE_FIELDS)[number];

export interface MergeValues {
  fields: Partial<Record<MergeField, string | null>>;
  /** Page key → this recipient's admin URL, or null when the store has no handle. */
  pages: Record<string, string | null>;
}

export interface Sender {
  fromName: string;
  fromEmail: string;
  replyTo: string;
  footerAddress: string;
  buttonColor: string;
}

export interface RenderInput {
  subject: string;
  previewText: string;
  body: string;
  merge: MergeValues;
  sender: Sender;
  /** The label of the campaign's email type, e.g. "Product updates". */
  typeLabel: string;
  urls: { unsubscribe: string; oneClick: string; page: string };
  /**
   * Dashboard preview only: mark a fallback value in yellow and draw a page
   * button with no link as a dashed box, so a blank is easy to see. Never set
   * for an email that is sent.
   */
  preview?: boolean;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

const TAG = /\{\{\s*([^{}]*?)\s*\}\}/g;
const FIELD_TAG = /^([a-z_]+)(?:\|(.*))?$/s;
const BUTTON_TAG = /^button\s+"([^"]{1,100})"\s+page="([^"]*)"$/;
const PAGE_LINK = /\[([^\]\n]+)\]\(page:([^)\s]*)\)/g;

type Tag =
  | { kind: 'field'; field: MergeField; fallback: string }
  | { kind: 'button'; label: string; page: string };

function parseTag(inner: string): Tag {
  const button = BUTTON_TAG.exec(inner);
  if (button) return { kind: 'button', label: button[1]!, page: button[2]! };
  const field = FIELD_TAG.exec(inner);
  if (field && (MERGE_FIELDS as readonly string[]).includes(field[1]!)) {
    return { kind: 'field', field: field[1] as MergeField, fallback: (field[2] ?? '').trim() };
  }
  throw new EmailError(
    `Unknown merge field {{${inner}}}. Use one of: ${MERGE_FIELDS.map((name) => `{{${name}}}`).join(', ')}, or {{button "Label" page="key"}}.`,
    422,
    'body',
  );
}

/** The page keys a template uses, in buttons and in [text](page:key) links. */
export function pageKeysIn(body: string): string[] {
  const keys = new Set<string>();
  for (const match of body.matchAll(TAG)) {
    const tag = parseTag(match[1]!);
    if (tag.kind === 'button') keys.add(tag.page);
  }
  for (const match of body.matchAll(PAGE_LINK)) keys.add(match[2]!);
  return [...keys];
}

/**
 * Throws 422 on an unknown {{tag}}, on a button in the subject, and on a page
 * key that `pageKeys` does not list.
 */
export function validateTemplate(subject: string, body: string, pageKeys: string[] = []): void {
  for (const match of subject.matchAll(TAG)) {
    if (parseTag(match[1]!).kind === 'button') {
      throw new EmailError('A button cannot go in the subject.', 422, 'subject');
    }
  }
  const known = new Set(pageKeys);
  for (const key of pageKeysIn(body)) {
    if (!known.has(key)) {
      throw new EmailError(
        `Unknown page "${key}". Add it under App links on the Settings tab${known.size ? `, or use one of: ${[...known].join(', ')}` : ''}.`,
        422,
        'body',
      );
    }
  }
}

/** The merge fields a template uses, in subject, preview text, and body, in MERGE_FIELDS order. */
export function fieldsIn(...templates: string[]): MergeField[] {
  const used = new Set<MergeField>();
  for (const template of templates) {
    for (const match of template.matchAll(TAG)) {
      const tag = parseTag(match[1]!);
      if (tag.kind === 'field') used.add(tag.field);
    }
  }
  return MERGE_FIELDS.filter((field) => used.has(field));
}

/** Every distinct fallback each field has in the templates, e.g. { first_name: ['Hi', 'there'] }. */
export function fallbacksIn(...templates: string[]): Partial<Record<MergeField, string[]>> {
  const out: Partial<Record<MergeField, string[]>> = {};
  for (const template of templates) {
    for (const match of template.matchAll(TAG)) {
      const tag = parseTag(match[1]!);
      if (tag.kind !== 'field' || !tag.fallback) continue;
      const list = (out[tag.field] ??= []);
      if (!list.includes(tag.fallback)) list.push(tag.fallback);
    }
  }
  return out;
}

/** True when the body uses {{first_name}} with no fallback. */
export function firstNameWithoutFallback(subject: string, body: string): boolean {
  for (const match of `${subject}\n${body}`.matchAll(TAG)) {
    const tag = parseTag(match[1]!);
    if (tag.kind === 'field' && tag.field === 'first_name' && !tag.fallback) return true;
  }
  return false;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fieldValue(merge: MergeValues, tag: { field: MergeField; fallback: string }): string {
  const value = (merge.fields[tag.field] ?? '').trim();
  return value || tag.fallback;
}

/** Merge tags in a one-line string such as the subject. No HTML. */
export function mergeLine(template: string, merge: MergeValues): string {
  return template
    .replace(TAG, (_whole, inner: string) => {
      const tag = parseTag(inner);
      return tag.kind === 'field' ? fieldValue(merge, tag) : tag.label;
    })
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

// Private-use characters mark where a merge value goes until formatting is done.
const OPEN = '\uE000';
const CLOSE = '\uE001';
const SLOT = /\uE000(\d+)\uE001/g;

interface Slot {
  html: string;
  text: string;
  /** A button alone in its paragraph renders as a full-width block. */
  block?: string;
}

function isHttp(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url);
}

function buttonHtml(label: string, url: string, color: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 16px"><tr><td>` +
    `<a href="${escapeHtml(url)}" style="display:block;background:${color};color:#ffffff;text-decoration:none;` +
    `border-radius:6px;font-weight:600;font-size:15px;line-height:44px;height:44px;text-align:center;padding:0 20px">` +
    `${escapeHtml(label)}</a></td></tr></table>`
  );
}

function inlineButtonHtml(label: string, url: string, color: string): string {
  return (
    `<a href="${escapeHtml(url)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;` +
    `border-radius:6px;font-weight:600;line-height:44px;padding:0 20px">${escapeHtml(label)}</a>`
  );
}

const LINK_OR_URL = /\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<]+)/g;

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
}

function stripEmphasis(raw: string): string {
  return raw.replace(/\*\*([^*\n]+?)\*\*/g, '$1').replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1$2');
}

/** Splits a trailing ".", ",", ")" and the like off a bare URL. */
function trimUrl(url: string): [string, string] {
  const match = /(?:[.,;:!?)\]'"]|&quot;|&#39;)+$/.exec(url);
  return match ? [url.slice(0, match.index), match[0]] : [url, ''];
}

/** One paragraph of escaped text → HTML. */
function inlineHtml(escaped: string): string {
  let out = '';
  let last = 0;
  for (const match of escaped.matchAll(LINK_OR_URL)) {
    out += emphasis(escaped.slice(last, match.index));
    last = match.index! + match[0].length;
    if (match[3]) {
      const [url, rest] = trimUrl(match[3]);
      out += `<a href="${url}" style="color:#2e72d2">${url}</a>${rest}`;
    } else {
      // The URL is escaped text: &amp; in it is what an href wants.
      const url = match[2]!.replace(/&amp;/g, '&');
      out += isHttp(url)
        ? `<a href="${match[2]}" style="color:#2e72d2">${emphasis(match[1]!)}</a>`
        : emphasis(match[0]);
    }
  }
  return out + emphasis(escaped.slice(last));
}

function inlineText(raw: string): string {
  let out = '';
  let last = 0;
  for (const match of raw.matchAll(LINK_OR_URL)) {
    out += stripEmphasis(raw.slice(last, match.index));
    last = match.index! + match[0].length;
    if (match[3]) out += match[3];
    else out += isHttp(match[2]!) ? `${stripEmphasis(match[1]!)} (${match[2]})` : match[0];
  }
  return out + stripEmphasis(raw.slice(last));
}

const FALLBACK_MARK = 'background:#fff5d6;color:inherit;border-radius:3px;padding:0 2px';

function deadButtonHtml(label: string): string {
  return (
    `<div style="margin:8px 0 16px;border:1px dashed #c9a227;border-radius:6px;line-height:42px;text-align:center;font-size:15px">` +
    `${escapeHtml(label)} <small style="color:#8a6100">(no link for this store)</small></div>`
  );
}

function bodyParts(
  body: string,
  merge: MergeValues,
  sender: Sender,
  preview = false,
): { html: string; text: string } {
  const slots: Slot[] = [];
  const hold = (slot: Slot) => `${OPEN}${slots.push(slot) - 1}${CLOSE}`;

  let marked = body.replace(/\r\n?/g, '\n').replace(/[\uE000\uE001]/g, '');
  marked = marked.replace(PAGE_LINK, (_whole, label: string, key: string) => {
    const url = merge.pages[key] ?? null;
    return hold(
      url
        ? { html: `<a href="${escapeHtml(url)}" style="color:#2e72d2">${escapeHtml(label)}</a>`, text: `${label} (${url})` }
        : { html: escapeHtml(label), text: label },
    );
  });
  marked = marked.replace(TAG, (_whole, inner: string) => {
    const tag = parseTag(inner);
    if (tag.kind === 'field') {
      const value = fieldValue(merge, tag);
      const fellBack = preview && value !== '' && !(merge.fields[tag.field] ?? '').trim();
      return hold({
        html: fellBack ? `<mark style="${FALLBACK_MARK}">${escapeHtml(value)}</mark>` : escapeHtml(value),
        text: value,
      });
    }
    const url = merge.pages[tag.page] ?? null;
    if (!url) {
      return hold({
        html: escapeHtml(tag.label),
        text: tag.label,
        ...(preview ? { block: deadButtonHtml(tag.label) } : {}),
      });
    }
    return hold({
      html: inlineButtonHtml(tag.label, url, sender.buttonColor),
      text: `${tag.label}: ${url}`,
      block: buttonHtml(tag.label, url, sender.buttonColor),
    });
  });

  const paragraphs = marked
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.replace(/^\n+|\n+$/g, ''))
    .filter((paragraph) => paragraph.trim().length > 0);

  const fill = (value: string, form: 'html' | 'text') =>
    value.replace(SLOT, (_whole, index: string) => slots[Number(index)]![form]);

  const html = paragraphs
    .map((paragraph) => {
      const only = /^\uE000(\d+)\uE001$/.exec(paragraph.trim());
      if (only && slots[Number(only[1])]!.block) return slots[Number(only[1])]!.block!;
      const lines = paragraph.split('\n').map((line) => inlineHtml(escapeHtml(line)));
      return `<p style="margin:0 0 16px">${fill(lines.join('<br>'), 'html')}</p>`;
    })
    .join('\n');

  const text = paragraphs
    .map((paragraph) => fill(paragraph.split('\n').map(inlineText).join('\n'), 'text'))
    .join('\n\n');

  return { html, text };
}

/** "Name" <address>, with the name's quotes and backslashes escaped. */
export function formatFrom(sender: Pick<Sender, 'fromName' | 'fromEmail'>): string {
  const name = sender.fromName.replace(/[\r\n]+/g, ' ').replace(/(["\\])/g, '\\$1');
  return `"${name}" <${sender.fromEmail}>`;
}

export function renderEmail(input: RenderInput): RenderedEmail {
  const subject = mergeLine(input.subject, input.merge);
  const preview = mergeLine(input.previewText, input.merge);
  const body = bodyParts(input.body, input.merge, input.sender, input.preview);
  const appName = (input.merge.fields.app_name ?? '').trim() || 'our app';
  const shopName = (input.merge.fields.shop_name ?? '').trim() || 'your store';
  const because = `You get this email because you use ${appName} on ${shopName}.`;
  const unsubscribeLine = `Unsubscribe from ${input.typeLabel}`;

  const text =
    `${body.text}\n\n` +
    `—\n${input.sender.footerAddress}\n${because}\n` +
    `${unsubscribeLine}: ${input.urls.unsubscribe}\n` +
    `Email preferences: ${input.urls.page}\n`;

  const footer =
    `<p style="margin:0 0 6px">${escapeHtml(input.sender.footerAddress)}</p>` +
    `<p style="margin:0 0 6px">${escapeHtml(because)}</p>` +
    `<p style="margin:0"><a href="${escapeHtml(input.urls.unsubscribe)}" style="color:#6d7175">${escapeHtml(unsubscribeLine)}</a>` +
    ` · <a href="${escapeHtml(input.urls.page)}" style="color:#6d7175">Email preferences</a></p>`;

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#ffffff">` +
    `<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all">${escapeHtml(preview)}</span>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px"><tr>` +
    `<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#202223;text-align:left">` +
    `${body.html}` +
    `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e1e3e5;font-size:12px;line-height:1.5;color:#6d7175">${footer}</div>` +
    `</td></tr></table></td></tr></table></body></html>`;

  return {
    subject,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${input.urls.oneClick}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
