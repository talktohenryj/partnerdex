import type { Recipient } from './audience.js';

/**
 * Audience export, one row per recipient.
 *
 * RFC 4180 quoting. A cell that starts with = + - @ (or a tab or carriage
 * return) is prefixed with ' so a spreadsheet shows it as text instead of
 * running it as a formula — a contact's name is data typed by a stranger.
 */

const HEADER = ['email', 'first_name', 'last_name', 'role', 'store', 'store_domain', 'status'];

function cell(value: string | null | undefined): string {
  let text = value ?? '';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(recipients: Recipient[]): string {
  const lines = [HEADER.join(',')];
  for (const row of recipients) {
    lines.push(
      [
        row.email,
        row.firstName,
        row.lastName,
        row.role,
        row.shopName,
        row.shopDomain,
        row.status,
      ]
        .map(cell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
