import { getDb, type Db } from '../db/index.js';
import { normalizeEmail } from '../contacts/upsert.js';
import { listEmailTypes } from './types.js';

/**
 * Per-person, per-type opt-outs. No row means subscribed. A type that cannot
 * be turned off (account notices) is always on, whatever a row says.
 *
 * This is separate from contact suppression: a suppressed contact gets
 * nothing of any type; a preference turns off one type only.
 */

export type PreferenceSource = 'preference_page' | 'one_click' | 'complaint';

export function isSubscribed(email: string, typeKey: string, db: Db = getDb()): boolean {
  const type = db.prepare('SELECT can_unsubscribe FROM email_types WHERE key = ?').get(typeKey) as
    | { can_unsubscribe: number }
    | undefined;
  if (type && type.can_unsubscribe === 0) return true;
  const row = db
    .prepare('SELECT subscribed FROM email_preferences WHERE email = ? AND type_key = ?')
    .get(normalizeEmail(email), typeKey) as { subscribed: number } | undefined;
  return !row || row.subscribed === 1;
}

/** Every type with its current state for one person, in display order. */
export function preferencesFor(
  email: string,
  db: Db = getDb(),
): Array<{ key: string; label: string; description: string; canUnsubscribe: boolean; subscribed: boolean }> {
  return listEmailTypes(db).map((type) => ({
    key: type.key,
    label: type.label,
    description: type.description,
    canUnsubscribe: type.canUnsubscribe,
    subscribed: isSubscribed(email, type.key, db),
  }));
}

export function setPreferences(
  email: string,
  choices: Record<string, boolean>,
  source: PreferenceSource,
  db: Db = getDb(),
): void {
  const normalized = normalizeEmail(email);
  const now = new Date().toISOString();
  const types = new Map(listEmailTypes(db).map((type) => [type.key, type]));
  const write = db.prepare(
    `INSERT INTO email_preferences (email, type_key, subscribed, source, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email, type_key) DO UPDATE SET
       subscribed = excluded.subscribed, source = excluded.source, updated_at = excluded.updated_at
     WHERE email_preferences.subscribed <> excluded.subscribed`,
  );
  db.transaction(() => {
    for (const [key, subscribed] of Object.entries(choices)) {
      const type = types.get(key);
      if (!type || !type.canUnsubscribe) continue;
      write.run(normalized, key, subscribed ? 1 : 0, source, now);
    }
  })();
}

export function unsubscribeAllMarketing(email: string, source: PreferenceSource, db: Db = getDb()): void {
  const choices: Record<string, boolean> = {};
  for (const type of listEmailTypes(db)) if (type.canUnsubscribe) choices[type.key] = false;
  setPreferences(email, choices, source, db);
}
