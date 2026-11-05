import type Database from 'better-sqlite3';
import { ADD_APP_CLICK_EVENT, LISTING_VIEW_EVENT } from '../bigquery/events.js';

type Db = Database.Database;

/**
 * Schema changes `CREATE TABLE IF NOT EXISTS` cannot make on its own.
 *
 * SCHEMA_SQL is idempotent for a *new* database and silent for an existing one:
 * a table that is already there is left exactly as it was, including columns
 * that have since moved or been dropped. Closing that gap needs a record of
 * what a database has already seen, and SQLite ships one — `PRAGMA
 * user_version`, an integer in the file header that costs nothing to read.
 *
 * Minimal on purpose: read the pragma, run each pending up() inside a
 * transaction, bump the version. No down-migrations, no framework, no ledger
 * table.
 *
 * Every migration body below is also individually idempotent — each one checks
 * the database before it writes. That is deliberate belt and braces, not
 * redundancy. Migrations 1 and 2 were previously applied by an unversioned
 * function that ran on every open, so databases exist that hold the changes
 * while user_version is still 0; replaying them has to be a no-op rather than a
 * `duplicate column name` crash. Later migrations are free to drop the checks
 * where the change genuinely cannot be detected after the fact.
 */

export interface Migration {
  version: number;
  up: (db: Db) => void;
}

/** The column names a table currently has, or an empty set if it has none. */
function columns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * Contacts store — Role 4. The Partner API never had this data, so nothing here
 * can be recovered by re-syncing. Email is the natural key (email-global
 * suppression assumes it). contact_shops is a separate table because one person
 * can manage many stores and the same person can appear across apps;
 * contact_suppressions is separate so an opt-out survives every rewrite of the
 * rows around it. A contact_suppressions row is do-not-contact / opt-out, not
 * erasure (erasure would delete the person).
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

/**
 * Saved audiences: a name and a rule (one app, store statuses, roles) over the
 * contacts store. The rule is stored, not the people — membership is resolved
 * live every time, so a store that stops paying leaves "Paying owners" without
 * anyone editing the list.
 */
export const AUDIENCES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audiences (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  definition  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audiences_name ON audiences (lower(name));
`;

/**
 * Shop details: the same five facts for every store (domain, country, currency,
 * time zone, Shopify plan). One row per shop; any app may send them, and the
 * last write wins. Apps read these from Shopify, so they are not app-specific.
 */
export const SHOP_DETAILS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS shop_details (
  shop_id        TEXT PRIMARY KEY,
  primary_domain TEXT,
  country        TEXT,
  currency       TEXT,
  timezone       TEXT,
  shopify_plan   TEXT,
  updated_at     TEXT NOT NULL,
  updated_by_app TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * Sending email: the sender settings, the per-app admin links that page
 * buttons open, campaigns, one row per recipient per campaign, and the email
 * types a recipient can turn off one by one. Role 4 — none of it can be
 * re-synced. The S4 event columns on email_sends (delivered_at … complained_at)
 * ship now so the webhook sprint needs no migration.
 *
 * An unsubscribe lives in email_preferences, not in contact_suppressions: a
 * person who turns off the weekly recap still wants account notices, and a
 * suppression would stop both.
 */
export const EMAIL_SEND_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS email_settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  from_name      TEXT NOT NULL DEFAULT '',
  from_email     TEXT NOT NULL DEFAULT '',
  reply_to       TEXT NOT NULL DEFAULT '',
  footer_address TEXT NOT NULL DEFAULT '',
  button_color   TEXT NOT NULL DEFAULT '#2e72d2',
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_links (
  app_id       TEXT PRIMARY KEY,
  admin_handle TEXT NOT NULL,
  pages        TEXT NOT NULL DEFAULT '[]',
  updated_at   TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS email_types (
  key             TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  description     TEXT NOT NULL,
  can_unsubscribe INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS email_preferences (
  email      TEXT NOT NULL,
  type_key   TEXT NOT NULL,
  subscribed INTEGER NOT NULL,
  source     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (email, type_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS email_campaigns (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  preview_text    TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  audience        TEXT NOT NULL,
  audience_id     TEXT,
  email_type      TEXT NOT NULL DEFAULT 'product_updates',
  status          TEXT NOT NULL DEFAULT 'draft',
  from_name       TEXT,
  from_email      TEXT,
  reply_to        TEXT,
  footer_address  TEXT,
  button_color    TEXT,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count      INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  batch_seq       INTEGER NOT NULL DEFAULT 0,
  batch_started_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  prepared_at     TEXT,
  started_at      TEXT,
  finished_at     TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS email_sends (
  campaign_id     TEXT NOT NULL,
  email           TEXT NOT NULL,
  shop_id         TEXT NOT NULL,
  merge           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  skip_reason     TEXT,
  batch_key       TEXT,
  resend_id       TEXT,
  error           TEXT,
  sent_at         TEXT,
  delivered_at    TEXT,
  opened_at       TEXT,
  clicked_at      TEXT,
  bounced_at      TEXT,
  complained_at   TEXT,
  unsubscribed_at TEXT,
  PRIMARY KEY (campaign_id, email)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_email_sends_status ON email_sends (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_email_sends_resend ON email_sends (resend_id) WHERE resend_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_sends_email ON email_sends (email);

INSERT INTO email_types (key, label, description, can_unsubscribe, sort) VALUES
  ('product_updates', 'Product updates', 'New features and what changed in the app.', 1, 1),
  ('weekly_recap', 'Weekly recap', 'A summary of your week in the app.', 1, 2),
  ('tips', 'Tips and setup help', 'Short guides to get more out of the app.', 1, 3),
  ('account_notices', 'Account notices', 'Trial ending, billing problems. Sent only when something needs you.', 0, 4)
ON CONFLICT(key) DO NOTHING;
`;

export const MIGRATIONS: Migration[] = [
  /*
   * The BigQuery connection stopped carrying per-app and per-spelling settings.
   *
   * Two changes with one cause: values that looked like configuration were not.
   * The GA4 export dataset is per *property*, so a partner running one property
   * per listing has a dataset per app and a single connection-level value made
   * the common case the awkward one. The GA4 event names had exactly one
   * spelling that works, and a field offering to change them only offered a way
   * to break the report.
   *
   * Dropping the event names is the destructive half. A database configured
   * before this holds whichever names were entered and the listing traffic
   * collected under them. Rows are typed by *step*, not by event name, so
   * anything pulled as `view_item` is already labelled "listing view" and would
   * sit beside the `page_view` rows counting the same visit twice. Where the
   * stored names differ from the ones now compiled in, the collected traffic
   * and its watermarks go, and the next sync re-reads the range. Nothing is
   * lost that BigQuery cannot re-serve.
   */
  {
    version: 1,
    up: (db) => {
      const connection = columns(db, 'bigquery_connection');
      if (connection.has('dataset')) {
        db.exec('ALTER TABLE bigquery_connection DROP COLUMN dataset');
      }

      if (connection.has('view_event') || connection.has('click_event')) {
        const row = db
          .prepare('SELECT view_event, click_event FROM bigquery_connection')
          .get() as { view_event?: string; click_event?: string } | undefined;

        if (
          row &&
          (row.view_event !== LISTING_VIEW_EVENT || row.click_event !== ADD_APP_CLICK_EVENT)
        ) {
          db.exec('DELETE FROM listing_events');
          db.exec(`DELETE FROM sync_state WHERE key LIKE 'bigquery:%'`);
          db.exec('DELETE FROM metric_cache');
        }

        if (connection.has('view_event')) {
          db.exec('ALTER TABLE bigquery_connection DROP COLUMN view_event');
        }
        if (connection.has('click_event')) {
          db.exec('ALTER TABLE bigquery_connection DROP COLUMN click_event');
        }
      }

      const sources = columns(db, 'bigquery_app_sources');
      if (sources.size > 0 && !sources.has('location')) {
        db.exec('ALTER TABLE bigquery_app_sources ADD COLUMN location TEXT');
      }

      // Who a listing event belongs to became a resolved value rather than
      // always the browser cookie. Existing rows keep a blank one and fall back
      // to `anonymous_id` at read time, so no re-sync is needed to keep
      // counting.
      const listing = columns(db, 'listing_events');
      if (listing.size > 0) {
        if (!listing.has('user_key')) {
          db.exec(`ALTER TABLE listing_events ADD COLUMN user_key TEXT NOT NULL DEFAULT ''`);
        }
        // Only once the column is certain to exist. In the schema block this
        // ran before the ALTER above and brought the process down on any
        // database created before the column.
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_listing_events_user
             ON listing_events (app_id, type, user_key)`,
        );
      }
    },
  },

  /*
   * Install intervals learned which event opened them.
   *
   * Separate from migration 1 because it is a separate fact about a separate
   * table: `install_intervals` is derived from the Partner API and would carry
   * this column whether or not a partner ever connects BigQuery. Only the
   * reason for wanting it is shared — a funnel that starts with someone reading
   * the listing must end with someone choosing the app, and a shop that was
   * closed and has reopened chose nothing.
   *
   * The column defaults to 'installed', which is wrong for every interval a
   * reopening opened — and the table is only rewritten by the next sync, so a
   * default left to stand would report reopenings as installs until then. The
   * backfill reads it straight off the raw events the interval was built from:
   * an exact match on the opening timestamp, preferring a real install where a
   * shop somehow carries both at the same instant. Cached figures computed
   * under the old reading go with it.
   */
  {
    version: 2,
    up: (db) => {
      const installs = columns(db, 'install_intervals');
      if (installs.size === 0 || installs.has('started_by')) return;

      db.exec(
        `ALTER TABLE install_intervals ADD COLUMN started_by TEXT NOT NULL DEFAULT 'installed'`,
      );
      db.exec(
        `UPDATE install_intervals AS t
            SET started_by = 'reactivated'
          WHERE EXISTS (SELECT 1 FROM app_events e
                         WHERE e.app_id = t.app_id AND e.shop_id = t.shop_id
                           AND e.occurred_at = t.started_at
                           AND e.type = 'RELATIONSHIP_REACTIVATED')
            AND NOT EXISTS (SELECT 1 FROM app_events e
                             WHERE e.app_id = t.app_id AND e.shop_id = t.shop_id
                               AND e.occurred_at = t.started_at
                               AND e.type = 'RELATIONSHIP_INSTALLED')`,
      );
      db.exec('DELETE FROM metric_cache');
    },
  },

  /*
   * A trial conversion's event id stopped carrying its date.
   *
   * The date is provisional — the billing date until the first sale settles,
   * then the sale's — so the old id `app|shop|derived:trial_converted|<at>|charge`
   * changed underneath an event that had already been announced, and the
   * delivery ledger, keyed on the id, could not recognise it. The compiler now
   * emits `app|shop|derived:trial_converted|charge`.
   *
   * Every conversion a channel was already told about has to be recorded under
   * the new id too, or the first dispatch after this release announces it again
   * — and with `NOTIFICATION_MAX_AGE_HOURS=0` that would be every conversion
   * since the topic was switched on. The dated rows are kept rather than
   * rewritten: `customer_events` still holds dated ids until the next sync
   * rebuilds it, and a manual dispatch before then must find them delivered.
   * A channel told twice already has two dated rows for one charge; both map
   * to the same new id and the second is ignored.
   *
   * The id format is spelled out here rather than imported, so this migration
   * keeps meaning what it meant if the compiler's format moves again.
   */
  {
    version: 3,
    up: (db) => {
      const rows = db
        .prepare(
          `SELECT channel_id, event_id, delivered_at, ok, error
             FROM notification_deliveries
            WHERE event_id LIKE '%|derived:trial_converted|%'
            ORDER BY delivered_at`,
        )
        .all() as Array<{
        channel_id: string;
        event_id: string;
        delivered_at: string;
        ok: number;
        error: string | null;
      }>;

      const insert = db.prepare(
        `INSERT INTO notification_deliveries (channel_id, event_id, delivered_at, ok, error)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, event_id) DO NOTHING`,
      );
      for (const row of rows) {
        const parts = row.event_id.split('|');
        // Already undated: nothing to carry.
        if (parts.length !== 5 || parts[2] !== 'derived:trial_converted') continue;
        const [appId, shopId, kind, , chargeId] = parts;
        insert.run(
          row.channel_id,
          `${appId}|${shopId}|${kind}|${chargeId}`,
          row.delivered_at,
          row.ok,
          row.error,
        );
      }
    },
  },

  /*
   * The contacts store: the people who log into an app, the stores they belong
   * to, and the addresses that must never be emailed. Every statement is
   * IF NOT EXISTS, so a database that already holds the tables replays it
   * safely.
   */
  {
    version: 4,
    up: (db) => {
      db.exec(CONTACTS_SCHEMA_SQL);
    },
  },
  {
    version: 5,
    up: (db) => {
      db.exec(AUDIENCES_SCHEMA_SQL);
    },
  },
  {
    version: 6,
    up: (db) => {
      db.exec(SHOP_DETAILS_SCHEMA_SQL);
    },
  },
  {
    version: 7,
    up: (db) => {
      db.exec(EMAIL_SEND_SCHEMA_SQL);
    },
  },
];

export function readUserVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0;
}

/**
 * Apply every migration whose version is greater than the database's current
 * user_version. Idempotent: a caught-up database runs zero migrations.
 *
 * `extra` is a test seam — production callers leave it undefined so only
 * MIGRATIONS runs. Tests pass a temporary migration (or a throwing one) without
 * polluting the production list.
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
