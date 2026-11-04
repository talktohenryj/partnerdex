import express from 'express';
import { getDb } from '../db/index.js';
import { listContacts, shopCandidates, type ContactLinkedFilter, type ContactSort } from '../contacts/list.js';
import {
  ContactsError,
  matchContactToShop,
  suppressContact,
  unsuppressContact,
  upsertContact,
  type ContactRole,
  type ContactSource,
} from '../contacts/upsert.js';
import { sendError } from './errors.js';
import { requireIngestToken } from './ingestAuth.js';

function stringField(body: unknown, name: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function shopField(body: unknown): {
  appId?: string;
  shopId?: string;
  myshopifyDomain?: string;
} {
  if (!body || typeof body !== 'object') return {};
  const shop = (body as Record<string, unknown>).shop;
  if (!shop || typeof shop !== 'object') {
    // Flat body shorthand: appId / shopId / myshopifyDomain at the top level.
    return {
      appId: stringField(body, 'appId'),
      shopId: stringField(body, 'shopId'),
      myshopifyDomain: stringField(body, 'myshopifyDomain'),
    };
  }
  const record = shop as Record<string, unknown>;
  return {
    appId: typeof record.appId === 'string' ? record.appId : undefined,
    shopId: typeof record.shopId === 'string' ? record.shopId : undefined,
    myshopifyDomain:
      typeof record.myshopifyDomain === 'string' ? record.myshopifyDomain : undefined,
  };
}

/** Machine-to-machine ingest for app producers, behind the app ingest token. */
export function contactsRouter(): express.Router {
  const router = express.Router();

  router.post('/ingest', requireIngestToken, (request, response) => {
    try {
      const email = stringField(request.body, 'email');
      const shop = shopField(request.body);
      const role = stringField(request.body, 'role') as ContactRole | undefined;
      const source = (stringField(request.body, 'source') ?? 'app_capture') as ContactSource;
      const seenAt = stringField(request.body, 'seenAt') ?? new Date().toISOString();

      if (!email) {
        throw new ContactsError('email is required.', 422);
      }
      if (!shop.appId) {
        throw new ContactsError('shop.appId (or appId) is required.', 422);
      }

      const result = upsertContact(
        {
          email,
          firstName: stringField(request.body, 'firstName') ?? null,
          lastName: stringField(request.body, 'lastName') ?? null,
          shop: {
            appId: shop.appId,
            shopId: shop.shopId ?? null,
            myshopifyDomain: shop.myshopifyDomain ?? null,
          },
          role,
          source,
          seenAt,
        },
        getDb(),
      );

      response.json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

/**
 * Dashboard reads and the two human writes.
 *
 * Mounted behind `requireAuth`, unlike the ingest router above — a browser
 * session is the credential, not the producer token. The two routers share
 * the `/api/contacts` prefix; ingest is registered first and only handles
 * POST /ingest, so everything else falls through to the gate and then here.
 */
export function contactsDashboardRouter(): express.Router {
  const router = express.Router();

  router.get('/', (request, response) => {
    try {
      const pick = (name: string): string | undefined => {
        const value = request.query[name];
        return typeof value === 'string' ? value : undefined;
      };
      const appIds = pick('appIds');
      const limit = Number(pick('limit'));
      const offset = Number(pick('offset'));
      response.json(
        listContacts({
          search: pick('q') ?? '',
          linked: (pick('linked') ?? 'all') as ContactLinkedFilter,
          sort: (pick('sort') ?? 'name') as ContactSort,
          limit: Number.isFinite(limit) ? limit : undefined,
          offset: Number.isFinite(offset) ? offset : undefined,
          appIds: appIds ? appIds.split(',').filter(Boolean) : [],
          shopId: pick('shopId'),
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/candidates', (request, response) => {
    try {
      const search = typeof request.query.q === 'string' ? request.query.q : '';
      response.json({ candidates: shopCandidates(search) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put('/:email/shop', (request, response) => {
    try {
      const body = request.body as { shopId?: unknown; appId?: unknown };
      const shopId = typeof body?.shopId === 'string' ? body.shopId : '';
      const appId = typeof body?.appId === 'string' ? body.appId : undefined;
      response.json(
        matchContactToShop(request.params.email, { shopId, appId }, getDb()),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put('/:email/suppression', (request, response) => {
    try {
      const body = request.body as { suppressed?: unknown; reason?: unknown };
      const suppressed = body?.suppressed === true;
      const reason = typeof body?.reason === 'string' ? body.reason : null;
      const email = request.params.email;
      if (suppressed) {
        suppressContact(email, { source: 'manual', reason }, getDb());
      } else {
        unsuppressContact(email, getDb());
      }
      response.json({ ok: true, email, isSuppressed: suppressed });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
