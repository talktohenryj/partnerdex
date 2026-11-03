import express from 'express';
import { getDb } from '../db/index.js';
import {
  isContactSort,
  matchesSearch,
  optionCounts,
  resolveAudience,
  sortRecipients,
  validateDefinition,
  type AudienceDefinition,
} from '../audiences/audience.js';
import { toCsv } from '../audiences/csv.js';
import { AudienceError } from '../audiences/errors.js';
import {
  createAudience,
  deleteAudience,
  getAudience,
  listAudiences,
  updateAudience,
} from '../audiences/store.js';
import { sendError } from './errors.js';

/**
 * Audiences: saved rules over the contacts store, resolved live.
 *
 * Mounted behind `requireAuth`. Nothing here sends anything; the export is a
 * CSV for the dashboard user.
 */

const EXCLUDED_SAMPLE = 25;

function bodyOf(request: express.Request): Record<string, unknown> {
  const body = request.body as unknown;
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function listParam(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map((part) => part.trim()).filter(Boolean) : [];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function audiencesRouter(): express.Router {
  const router = express.Router();

  router.post('/preview', (request, response) => {
    try {
      const db = getDb();
      const body = bodyOf(request);
      const definition = validateDefinition(body.definition, db);
      const search = typeof body.q === 'string' ? body.q : '';
      const sort = isContactSort(body.sort) ? body.sort : 'recent';
      const limit = intIn(body.limit, 1, 200, 50);
      const offset = intIn(body.offset, 0, Number.MAX_SAFE_INTEGER, 0);

      const result = resolveAudience(definition, db);
      const matching = sortRecipients(
        result.recipients.filter((row) => matchesSearch(row, search)),
        sort,
      );

      response.json({
        definition,
        count: result.recipients.length,
        matching: matching.length,
        stores: result.stores,
        multiStorePeople: result.recipients.filter((row) => row.otherShops > 0).length,
        excluded: result.excluded,
        byStatus: result.byStatus,
        byRole: result.byRole,
        optionCounts: optionCounts(definition, db),
        rows: matching.slice(offset, offset + limit),
        excludedSample: sortRecipients(result.excludedPeople, sort).slice(0, EXCLUDED_SAMPLE),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/', (_request, response) => {
    try {
      const db = getDb();
      response.json({
        audiences: listAudiences(db).map((audience) => ({
          id: audience.id,
          name: audience.name,
          definition: audience.definition,
          stale: audience.stale,
          count: audience.stale ? null : resolveAudience(audience.definition, db).recipients.length,
        })),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/', (request, response) => {
    try {
      const body = bodyOf(request);
      response.status(201).json(createAudience({ name: body.name, definition: body.definition }));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/export.csv', (request, response) => {
    try {
      const db = getDb();
      let definition: AudienceDefinition;
      const id = typeof request.query.id === 'string' ? request.query.id : '';
      if (id) {
        const saved = getAudience(id, db);
        if (!saved) throw new AudienceError(`No audience with id ${id}.`, 404);
        if (saved.stale) {
          throw new AudienceError(
            `Audience "${saved.name}" names an app outside the reporting scope.`,
            422,
          );
        }
        definition = saved.definition;
      } else {
        definition = validateDefinition(
          {
            appId: typeof request.query.appId === 'string' ? request.query.appId : '',
            statuses: listParam(request.query.statuses),
            roles: listParam(request.query.roles),
          },
          db,
        );
      }
      const csv = toCsv(resolveAudience(definition, db).recipients);
      response
        .status(200)
        .type('text/csv; charset=utf-8')
        .set('Content-Disposition', `attachment; filename="audience-${today()}.csv"`)
        .send(csv);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put('/:id', (request, response) => {
    try {
      const body = bodyOf(request);
      response.json(
        updateAudience(request.params.id, { name: body.name, definition: body.definition }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete('/:id', (request, response) => {
    try {
      deleteAudience(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
