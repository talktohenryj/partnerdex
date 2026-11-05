import { getDb, type Db } from '../db/index.js';

/**
 * Email types: the kinds of email a recipient can turn off one at a time.
 * Seeded by migration 7; editing them is a later sprint.
 */

export interface EmailType {
  key: string;
  label: string;
  description: string;
  canUnsubscribe: boolean;
  sort: number;
}

export function listEmailTypes(db: Db = getDb()): EmailType[] {
  const rows = db.prepare('SELECT * FROM email_types ORDER BY sort, key').all() as Array<{
    key: string;
    label: string;
    description: string;
    can_unsubscribe: number;
    sort: number;
  }>;
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    description: row.description,
    canUnsubscribe: row.can_unsubscribe === 1,
    sort: row.sort,
  }));
}

export function getEmailType(key: string, db: Db = getDb()): EmailType | null {
  return listEmailTypes(db).find((type) => type.key === key) ?? null;
}
