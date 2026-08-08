import fs from 'node:fs';
import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';
import { column, parseCsv } from './csv.js';
import {
  assertAppInScope,
  normalizeDomain,
  normalizeEmail,
  suppressContact,
  upsertContact,
  type ContactRole,
  type MatchMethod,
} from './upsert.js';

/**
 * One-time Mantle Contacts CSV → PartnerDex contacts store.
 *
 * Preview by default; `--commit` writes. Backfilled first/last seen stay NULL
 * (honest unknown). Suppression is a separate required pass when committing.
 */

export interface ImportOptions {
  csvPath: string;
  appId: string;
  /** Path to validated unsubscribed.csv (one email per line). Required for --commit. */
  suppressionPath?: string;
  commit?: boolean;
  db?: Db;
}

export interface ImportSummary {
  committed: boolean;
  rowsRead: number;
  uniqueEmails: number;
  contactsWritten: number;
  matchCounts: Record<MatchMethod, number>;
  labelMapping: Record<string, { role: ContactRole; count: number }>;
  unlinkedEmails: string[];
  suppressionMarked: number;
  coverage: {
    shopsTotal: number;
    shopsWithDomain: number;
    csvDomains: number;
    csvDomainsExactOne: number;
    csvDomainsAmbiguous: number;
    csvDomainsNone: number;
  };
}

/** Mantle Associated Customer Label → canonical role. */
export function mapMantleLabel(raw: string): { role: ContactRole; original: string } {
  const original = raw.trim();
  const key = original.toLowerCase();
  if (key === 'primary') return { role: 'owner', original };
  if (
    key === 'secondary' ||
    key === 'user' ||
    key === 'technical' ||
    key === 'customer' ||
    key === 'staff'
  ) {
    return { role: 'staff', original };
  }
  if (key === 'collaborator') return { role: 'collaborator', original };
  if (key === 'owner') return { role: 'owner', original };
  // Unknown labels default to staff — same reach-preserving call as the old import.
  return { role: 'staff', original: original || '(blank)' };
}

function readSuppressionEmails(filePath: string): string[] {
  const text = fs.readFileSync(filePath, 'utf8');
  const emails: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase() === 'email') continue;
    // Allow a one-column CSV with a header, or bare emails.
    const email = normalizeEmail(trimmed.split(',')[0] ?? '');
    if (email.includes('@')) emails.push(email);
  }
  return [...new Set(emails)];
}

export function shopDomainCoverage(db: Db): { shopsTotal: number; shopsWithDomain: number } {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN myshopify_domain IS NOT NULL AND trim(myshopify_domain) <> '' THEN 1 ELSE 0 END) AS with_domain
       FROM shops`,
    )
    .get() as { total: number; with_domain: number };
  return { shopsTotal: row.total, shopsWithDomain: row.with_domain ?? 0 };
}

export function importMantleContacts(options: ImportOptions): ImportSummary {
  const db = options.db ?? getDb();
  const appId = options.appId.trim();
  assertAppInScope(appId, db);

  if (options.commit && !options.suppressionPath) {
    throw new Error(
      'contacts:import --commit requires --suppression=<unsubscribed.csv>. ' +
        'A missed opt-out is a CAN-SPAM problem.',
    );
  }

  const text = fs.readFileSync(options.csvPath, 'utf8');
  const { rows } = parseCsv(text);

  const matchCounts: Record<MatchMethod, number> = {
    auto: 0,
    ambiguous: 0,
    none: 0,
    manual: 0,
  };
  const labelMapping = new Map<string, { role: ContactRole; count: number }>();
  const unlinkedEmails: string[] = [];
  const seenEmails = new Set<string>();

  type Pending = {
    email: string;
    firstName: string;
    lastName: string;
    domain: string;
    role: ContactRole;
  };
  const pending: Pending[] = [];

  for (const row of rows) {
    const email = normalizeEmail(
      column(row, 'Email', 'Email Address', 'Contact Email', 'email'),
    );
    if (!email.includes('@')) continue;

    // Dedupe within the file — last row wins names/domain/role.
    const firstName = column(row, 'First Name', 'First name', 'first_name');
    const lastName = column(row, 'Last Name', 'Last name', 'last_name');
    const domain = normalizeDomain(
      column(
        row,
        'Associated Customer Shopify Domain',
        'Shopify Domain',
        'myshopify domain',
        'Domain',
      ),
    );
    const label = mapMantleLabel(
      column(row, 'Associated Customer Label', 'Label', 'Customer Label'),
    );

    const mapKey = label.original.toLowerCase() || '(blank)';
    const existingLabel = labelMapping.get(mapKey);
    if (existingLabel) existingLabel.count += 1;
    else labelMapping.set(mapKey, { role: label.role, count: 1 });

    // Replace prior pending row for the same email.
    const priorIdx = pending.findIndex((p) => p.email === email);
    const next: Pending = {
      email,
      firstName,
      lastName,
      domain,
      role: label.role,
    };
    if (priorIdx >= 0) pending[priorIdx] = next;
    else pending.push(next);
    seenEmails.add(email);
  }

  // Domain coverage against the live shops table (read-only; always computed).
  let csvDomainsExactOne = 0;
  let csvDomainsAmbiguous = 0;
  let csvDomainsNone = 0;
  const uniqueDomains = new Set(pending.map((p) => p.domain).filter(Boolean));
  for (const domain of uniqueDomains) {
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM shops WHERE lower(trim(myshopify_domain)) = ?`,
        )
        .get(domain) as { n: number }
    ).n;
    if (n === 0) csvDomainsNone += 1;
    else if (n === 1) csvDomainsExactOne += 1;
    else csvDomainsAmbiguous += 1;
  }
  const shopCoverage = shopDomainCoverage(db);

  const runUpserts = () => {
    for (const row of pending) {
      const result = upsertContact(
        {
          email: row.email,
          firstName: row.firstName || null,
          lastName: row.lastName || null,
          shop: { appId, myshopifyDomain: row.domain || null },
          role: row.role,
          source: 'mantle_backfill',
          // Honest unknown — do not stamp import day as first_seen.
          seenAt: null,
        },
        db,
      );
      matchCounts[result.matched] += 1;
      if (result.matched === 'none') unlinkedEmails.push(row.email);
    }
  };

  let contactsWritten = 0;
  let suppressionMarked = 0;

  if (options.commit) {
    db.transaction(() => {
      runUpserts();
      const emails = readSuppressionEmails(options.suppressionPath!);
      for (const email of emails) {
        suppressContact(email, { source: 'mantle', reason: 'unsubscribed' }, db);
        suppressionMarked += 1;
      }
    })();
    contactsWritten = pending.length;
  } else {
    // Preview: resolve matches without writing, by dry-running via upsert
    // against a savepoint that rolls back — keeps one code path.
    db.exec('SAVEPOINT contacts_import_preview');
    try {
      runUpserts();
    } finally {
      db.exec('ROLLBACK TO contacts_import_preview');
      db.exec('RELEASE contacts_import_preview');
    }
  }

  return {
    committed: Boolean(options.commit),
    rowsRead: rows.length,
    uniqueEmails: seenEmails.size,
    contactsWritten,
    matchCounts,
    labelMapping: Object.fromEntries(labelMapping.entries()),
    unlinkedEmails: [...new Set(unlinkedEmails)].sort(),
    suppressionMarked,
    coverage: {
      shopsTotal: shopCoverage.shopsTotal,
      shopsWithDomain: shopCoverage.shopsWithDomain,
      csvDomains: uniqueDomains.size,
      csvDomainsExactOne,
      csvDomainsAmbiguous,
      csvDomainsNone,
    },
  };
}

export function formatImportSummary(summary: ImportSummary): string {
  const lines: string[] = [];
  lines.push(summary.committed ? 'COMMITTED' : 'PREVIEW (no writes)');
  lines.push(`Rows read:        ${summary.rowsRead}`);
  lines.push(`Unique emails:    ${summary.uniqueEmails}`);
  if (summary.committed) {
    lines.push(`Contacts written: ${summary.contactsWritten}`);
    lines.push(`Suppressions:     ${summary.suppressionMarked}`);
  }
  lines.push('Match breakdown:');
  lines.push(`  auto       ${summary.matchCounts.auto}`);
  lines.push(`  ambiguous  ${summary.matchCounts.ambiguous}`);
  lines.push(`  none       ${summary.matchCounts.none}`);
  lines.push('Label mapping (CSV → role):');
  for (const [label, info] of Object.entries(summary.labelMapping).sort()) {
    lines.push(`  ${label.padEnd(16)} → ${info.role} (${info.count})`);
  }
  lines.push('Shop domain coverage:');
  lines.push(
    `  shops with myshopify_domain: ${summary.coverage.shopsWithDomain}/${summary.coverage.shopsTotal}`,
  );
  lines.push(
    `  CSV domains → exact one / ambiguous / none: ` +
      `${summary.coverage.csvDomainsExactOne} / ` +
      `${summary.coverage.csvDomainsAmbiguous} / ` +
      `${summary.coverage.csvDomainsNone}` +
      ` (of ${summary.coverage.csvDomains} unique)`,
  );
  if (summary.unlinkedEmails.length > 0 && summary.unlinkedEmails.length <= 25) {
    lines.push('Unlinked emails (kept, no contact_shops row):');
    for (const email of summary.unlinkedEmails) lines.push(`  ${email}`);
  } else if (summary.unlinkedEmails.length > 25) {
    lines.push(
      `Unlinked emails: ${summary.unlinkedEmails.length} (kept; no contact_shops row)`,
    );
  }
  return lines.join('\n');
}
