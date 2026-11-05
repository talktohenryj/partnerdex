import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { getSettings, settingsComplete } from './settings.js';

/**
 * Why sending is off right now, or null when it is on.
 *
 * The first missing piece only, in the order a person fixes them. A dashboard
 * with no password is the first: anyone who reaches the port could otherwise
 * email every merchant.
 */
export function sendingBlockedReason(db: Db = getDb()): string | null {
  return configBlockedReason() ?? (settingsComplete(getSettings(db)) ? null : SETTINGS_REASON);
}

export const SETTINGS_REASON =
  'Fill in the sender settings (From name, From email, and Footer postal address) on the Settings tab.';

/** The environment half of sendingBlockedReason(): what a deploy must set. */
export function configBlockedReason(): string | null {
  const config = getConfig();
  if (!config.auth.password) return 'Set DASHBOARD_PASSWORD before sending email.';
  if (!config.email.resendApiKey) return 'Set RESEND_API_KEY to send email through Resend.';
  if (!config.email.publicBaseUrl) {
    return 'Set PUBLIC_BASE_URL to the address people reach this server at, so unsubscribe links work.';
  }
  if (!config.email.linkSecret) return 'Set EMAIL_LINK_SECRET (32 or more random characters) to sign unsubscribe links.';
  return null;
}
