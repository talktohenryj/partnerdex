import crypto from 'node:crypto';
import { getDb, type Db } from '../db/index.js';
import { appInScope, validateDefinition, type AudienceDefinition } from './audience.js';
import { AudienceError } from './errors.js';

/**
 * Saved audiences. A name and a rule; the people are resolved on every read.
 */

export interface SavedAudience {
  id: string;
  name: string;
  definition: AudienceDefinition;
  /** The rule names an app that is no longer in reporting scope. */
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AudienceRow {
  id: string;
  name: string;
  definition: string;
  created_at: string;
  updated_at: string;
}

const NAME_MAX = 80;

function cleanName(input: unknown): string {
  const name = typeof input === 'string' ? input.trim() : '';
  if (name.length < 1 || name.length > NAME_MAX) {
    throw new AudienceError(`name must be 1 to ${NAME_MAX} characters.`, 422);
  }
  return name;
}

function fromRow(row: AudienceRow, db: Db): SavedAudience {
  const definition = JSON.parse(row.definition) as AudienceDefinition;
  return {
    id: row.id,
    name: row.name,
    definition,
    stale: !appInScope(definition.appId, db),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertNameFree(db: Db, name: string, exceptId: string | null): void {
  const clash = db
    .prepare('SELECT id FROM audiences WHERE lower(name) = lower(?) AND id <> ?')
    .get(name, exceptId ?? '') as { id: string } | undefined;
  if (clash) {
    throw new AudienceError(`An audience named "${name}" already exists.`, 409);
  }
}

export function listAudiences(db: Db = getDb()): SavedAudience[] {
  const rows = db
    .prepare('SELECT * FROM audiences ORDER BY created_at ASC, lower(name) ASC')
    .all() as AudienceRow[];
  return rows.map((row) => fromRow(row, db));
}

export function getAudience(id: string, db: Db = getDb()): SavedAudience | null {
  const row = db.prepare('SELECT * FROM audiences WHERE id = ?').get(id) as
    | AudienceRow
    | undefined;
  return row ? fromRow(row, db) : null;
}

export function createAudience(
  input: { name?: unknown; definition?: unknown },
  db: Db = getDb(),
): SavedAudience {
  const name = cleanName(input.name);
  const definition = validateDefinition(input.definition, db);
  assertNameFree(db, name, null);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO audiences (id, name, definition, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, JSON.stringify(definition), now, now);
  return getAudience(id, db)!;
}

export function updateAudience(
  id: string,
  input: { name?: unknown; definition?: unknown },
  db: Db = getDb(),
): SavedAudience {
  const current = getAudience(id, db);
  if (!current) throw new AudienceError(`No audience with id ${id}.`, 404);
  const name = input.name === undefined ? current.name : cleanName(input.name);
  const definition =
    input.definition === undefined ? current.definition : validateDefinition(input.definition, db);
  assertNameFree(db, name, id);
  db.prepare(
    `UPDATE audiences SET name = ?, definition = ?, updated_at = ? WHERE id = ?`,
  ).run(name, JSON.stringify(definition), new Date().toISOString(), id);
  return getAudience(id, db)!;
}

export function deleteAudience(id: string, db: Db = getDb()): void {
  const result = db.prepare('DELETE FROM audiences WHERE id = ?').run(id);
  if (result.changes === 0) throw new AudienceError(`No audience with id ${id}.`, 404);
}
