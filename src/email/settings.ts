import { getDb, type Db } from '../db/index.js';
import { EmailError } from './errors.js';

/**
 * The sender: who every email is from, where replies go, and the postal
 * address in the footer. Entered in the dashboard, not in the environment —
 * the person sending changes these, not the person deploying.
 */

export interface EmailSettings {
  fromName: string;
  fromEmail: string;
  replyTo: string;
  footerAddress: string;
  buttonColor: string;
  updatedAt: string | null;
}

export const DEFAULT_BUTTON_COLOR = '#2e72d2';

const EMPTY: EmailSettings = {
  fromName: '',
  fromEmail: '',
  replyTo: '',
  footerAddress: '',
  buttonColor: DEFAULT_BUTTON_COLOR,
  updatedAt: null,
};

/** A plain address: one @, no spaces, a dot in the domain. Not RFC 5322. */
const ADDRESS = /^[^\s@<>()",;:]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function isPlainAddress(value: string): boolean {
  return value.length <= 254 && ADDRESS.test(value);
}

export function getSettings(db: Db = getDb()): EmailSettings {
  const row = db.prepare('SELECT * FROM email_settings WHERE id = 1').get() as
    | {
        from_name: string;
        from_email: string;
        reply_to: string;
        footer_address: string;
        button_color: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return { ...EMPTY };
  return {
    fromName: row.from_name,
    fromEmail: row.from_email,
    replyTo: row.reply_to,
    footerAddress: row.footer_address,
    buttonColor: row.button_color || DEFAULT_BUTTON_COLOR,
    updatedAt: row.updated_at,
  };
}

function text(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new EmailError(`${name} must be text.`, 422, name);
  return value.trim();
}

export function validateSettings(input: unknown): Omit<EmailSettings, 'updatedAt'> {
  const record =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

  const fromName = text(record, 'fromName');
  if (fromName.length < 1 || fromName.length > 80 || /[\r\n]/.test(fromName)) {
    throw new EmailError('From name must be 1 to 80 characters on one line.', 422, 'fromName');
  }
  const fromEmail = text(record, 'fromEmail').toLowerCase();
  if (!isPlainAddress(fromEmail)) {
    throw new EmailError('From email must be an email address such as hello@example.com.', 422, 'fromEmail');
  }
  const replyTo = text(record, 'replyTo').toLowerCase();
  if (replyTo && !isPlainAddress(replyTo)) {
    throw new EmailError('Reply-To must be an email address, or blank.', 422, 'replyTo');
  }
  const footerAddress = text(record, 'footerAddress');
  if (footerAddress.length < 10 || footerAddress.length > 300) {
    throw new EmailError(
      'Footer postal address must be 10 to 300 characters. The law requires a physical address in every marketing email.',
      422,
      'footerAddress',
    );
  }
  const buttonColor = (text(record, 'buttonColor') || DEFAULT_BUTTON_COLOR).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(buttonColor)) {
    throw new EmailError('Button colour must be a hex colour such as #2e72d2.', 422, 'buttonColor');
  }
  return { fromName, fromEmail, replyTo, footerAddress, buttonColor };
}

export function saveSettings(input: unknown, db: Db = getDb()): EmailSettings {
  const clean = validateSettings(input);
  db.prepare(
    `INSERT INTO email_settings (id, from_name, from_email, reply_to, footer_address, button_color, updated_at)
     VALUES (1, @fromName, @fromEmail, @replyTo, @footerAddress, @buttonColor, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       from_name = excluded.from_name,
       from_email = excluded.from_email,
       reply_to = excluded.reply_to,
       footer_address = excluded.footer_address,
       button_color = excluded.button_color,
       updated_at = excluded.updated_at`,
  ).run({ ...clean, updatedAt: new Date().toISOString() });
  return getSettings(db);
}

/** True when the four fields a send needs are filled in. */
export function settingsComplete(settings: EmailSettings): boolean {
  try {
    validateSettings(settings);
    return true;
  } catch {
    return false;
  }
}

export function fromDomain(settings: EmailSettings): string {
  return settings.fromEmail.split('@')[1] ?? '';
}
