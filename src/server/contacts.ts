import crypto from 'node:crypto';
import express from 'express';
import { getConfig } from '../config.js';
import { getDb } from '../db/index.js';
import {
  ContactsError,
  upsertContact,
  type ContactRole,
  type ContactSource,
} from '../contacts/upsert.js';
import { sendError } from './errors.js';

/**
 * Machine-to-machine ingest for app producers (iziGift in Sprint 3).
 *
 * Auth is a shared-secret bearer token (`CONTACTS_INGEST_TOKEN`), not the
 * dashboard password — that credential is for a human at a browser.
 */

function ingestToken(): string | null {
  return getConfig().auth.contactsIngestToken;
}

function bearerMatches(presented: string, actual: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(actual).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireIngestToken(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  const expected = ingestToken();
  if (!expected) {
    response.status(503).json({
      error: 'Contacts ingest is disabled. Set CONTACTS_INGEST_TOKEN to enable it.',
    });
    return;
  }

  const header = request.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const presented = match?.[1]?.trim() ?? '';
  if (!presented || !bearerMatches(presented, expected)) {
    response.status(401).json({ error: 'Invalid or missing ingest token.' });
    return;
  }
  next();
}

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
