import express from 'express';
import { getDb } from '../db/index.js';
import { identify } from '../identify/identify.js';
import { shopDetails } from '../shops/details.js';
import { sendError } from './errors.js';
import { requireIngestToken } from './ingestAuth.js';

/** POST /api/identify — an app describes shops: contacts and shop details. */
export function identifyRouter(): express.Router {
  const router = express.Router();

  router.post('/', requireIngestToken, express.json({ limit: '1mb' }), (request, response) => {
    try {
      response.json({ results: identify(request.body, getDb()) });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

/** Dashboard read of a shop's details, mounted behind requireAuth. */
export function shopDetailsHandler(request: express.Request, response: express.Response): void {
  try {
    response.json(shopDetails(String(request.params.shopId), getDb()));
  } catch (error) {
    sendError(response, error);
  }
}
