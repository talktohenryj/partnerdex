import type Database from 'better-sqlite3';

type Db = Database.Database;

/**
 * Migration runner for Role-4 (durable) tables.
 *
 * Disposable tables stay in SCHEMA_SQL as CREATE TABLE IF NOT EXISTS — they can
 * be thrown away and rebuilt from the Partner API. Durable tables cannot: once
 * contacts (or reviews, or notification channels) hold the only copy of a fact,
 * "delete the file and re-sync" is gone, and IF NOT EXISTS is a silent no-op on
 * an existing table. So durable schema changes go through this runner.
 *
 * Minimal on purpose: read PRAGMA user_version, run each pending up() inside a
 * transaction, bump the version. No down-migrations, no framework.
 */

export interface Migration {
  version: number;
  up: (db: Db) => void;
}

/**
 * Contacts store — Role 4. The Partner API never had this data, so nothing here
 * can be recovered by re-syncing. Email is the natural key (Mantle keyed on it;
 * email-global suppression assumes it). contact_shops is a separate table
 * because one person can manage many stores and the same person can appear
 * across apps; contact_suppressions is separate so an opt-out survives every
 * rewrite of the rows around it.
 */
export const CONTACTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  email         TEXT PRIMARY KEY,
  first_name    TEXT,
  last_name     TEXT,
  is_suppressed INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL,
  first_seen_at TEXT,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS contact_shops (
  email         TEXT NOT NULL,
  app_id        TEXT NOT NULL,
  shop_id       TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',
  match_method  TEXT NOT NULL DEFAULT 'none',
  first_seen_at TEXT,
  last_seen_at  TEXT,
  PRIMARY KEY (email, app_id, shop_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_contact_shops_shop ON contact_shops (app_id, shop_id);

CREATE TABLE IF NOT EXISTS contact_suppressions (
  email         TEXT PRIMARY KEY,
  suppressed_at TEXT NOT NULL,
  source        TEXT NOT NULL,
  reason        TEXT
) WITHOUT ROWID;
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(CONTACTS_SCHEMA_SQL);
    },
  },
];

export function readUserVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0;
}

/**
 * Apply every migration whose version is greater than the DB's current
 * user_version. Idempotent: a caught-up DB runs zero migrations.
 *
 * `extra` is a test seam — production callers leave it undefined so only
 * MIGRATIONS runs. Tests pass a temporary migration 2 (or a throwing one)
 * without polluting the production list.
 */
export function migrate(db: Db, extra: Migration[] = []): void {
  const current = readUserVersion(db);
  const pending = [...MIGRATIONS, ...extra]
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
