import express from 'express';
import { getAppLinks, saveAppLinks } from '../apps/links.js';
import {
  asFilter,
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  listSends,
  pauseCampaign,
  prepareCampaign,
  previewRecipients,
  renderPreview,
  resumeCampaign,
  sendTest,
  startSend,
  updateCampaign,
} from '../email/campaigns.js';
import { EmailError } from '../email/errors.js';
import { sendingBlockedReason } from '../email/guard.js';
import { MERGE_FIELDS } from '../email/render.js';
import { fromDomain, getSettings, saveSettings } from '../email/settings.js';
import { getTransport } from '../email/transport.js';
import { listEmailTypes } from '../email/types.js';
import { sendError } from './errors.js';

/**
 * The Email page's API. Mounted behind requireAuth at /api/email. Nothing
 * here is configured from the environment except the guard: the sender and
 * the app links are entered in the dashboard.
 */

type Handler = (request: express.Request, response: express.Response) => unknown;

function handle(fn: Handler): express.RequestHandler {
  return (request, response) => {
    Promise.resolve()
      .then(() => fn(request, response))
      .catch((error: unknown) => sendError(response, error));
  };
}

function bodyOf(request: express.Request): Record<string, unknown> {
  const body = request.body as unknown;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function campaignOr404(id: string) {
  const campaign = getCampaign(id);
  if (!campaign) throw new EmailError(`No campaign with id ${id}.`, 404);
  return campaign;
}

export function emailRouter(): express.Router {
  const router = express.Router();

  router.get(
    '/settings',
    handle((_request, response) => {
      response.json({
        settings: getSettings(),
        blockedReason: sendingBlockedReason(),
        types: listEmailTypes(),
        mergeFields: MERGE_FIELDS,
      });
    }),
  );

  router.put(
    '/settings',
    handle((request, response) => {
      const settings = saveSettings(bodyOf(request));
      response.json({ settings, blockedReason: sendingBlockedReason() });
    }),
  );

  router.get(
    '/settings/domain',
    handle(async (_request, response) => {
      const domain = fromDomain(getSettings());
      const transport = getTransport();
      const status = domain && transport ? await transport.domainStatus(domain) : null;
      response.json({ domain: domain || null, status, blockedReason: sendingBlockedReason() });
    }),
  );

  router.get(
    '/apps/:appId/links',
    handle((request, response) => {
      response.json(getAppLinks(request.params.appId!));
    }),
  );

  router.put(
    '/apps/:appId/links',
    handle((request, response) => {
      const body = bodyOf(request);
      response.json(saveAppLinks(request.params.appId!, { adminHandle: body.adminHandle, pages: body.pages }));
    }),
  );

  router.get(
    '/campaigns',
    handle((_request, response) => {
      response.json({ campaigns: listCampaigns(), blockedReason: sendingBlockedReason() });
    }),
  );

  router.post(
    '/campaigns',
    handle((request, response) => {
      response.status(201).json(createCampaign(bodyOf(request)));
    }),
  );

  router.get(
    '/campaigns/:id',
    handle((request, response) => {
      response.json(campaignOr404(request.params.id!));
    }),
  );

  router.put(
    '/campaigns/:id',
    handle((request, response) => {
      response.json(updateCampaign(request.params.id!, bodyOf(request)));
    }),
  );

  router.delete(
    '/campaigns/:id',
    handle((request, response) => {
      deleteCampaign(request.params.id!);
      response.status(204).end();
    }),
  );

  router.post(
    '/campaigns/:id/render',
    handle((request, response) => {
      const body = bodyOf(request);
      response.json(renderPreview(request.params.id!, { email: body.email, filter: asFilter(body.filter) }));
    }),
  );

  // The "Preview as" picker: the people the campaign would go to, searchable.
  router.get(
    '/campaigns/:id/recipients',
    handle((request, response) => {
      const pick = (name: string) => (typeof request.query[name] === 'string' ? (request.query[name] as string) : undefined);
      response.json(
        previewRecipients(request.params.id!, {
          q: pick('q'),
          filter: asFilter(pick('filter')),
          offset: Number(pick('offset') ?? 0) || 0,
          limit: Number(pick('limit') ?? 50) || 50,
        }),
      );
    }),
  );

  router.post(
    '/campaigns/:id/test',
    handle(async (request, response) => {
      const body = bodyOf(request);
      response.json(await sendTest(request.params.id!, body.to, body.as));
    }),
  );

  router.post(
    '/campaigns/:id/prepare',
    handle(async (request, response) => {
      response.json(await prepareCampaign(request.params.id!));
    }),
  );

  router.post(
    '/campaigns/:id/send',
    handle((request, response) => {
      const body = bodyOf(request);
      response.json(startSend(request.params.id!, body.confirmCount, undefined, undefined, body.pauseAfter));
    }),
  );

  router.post(
    '/campaigns/:id/pause',
    handle((request, response) => {
      response.json(pauseCampaign(request.params.id!));
    }),
  );

  router.post(
    '/campaigns/:id/resume',
    handle((request, response) => {
      response.json(resumeCampaign(request.params.id!, bodyOf(request).pauseAfter));
    }),
  );

  // Who got the email already (or who failed, or was skipped): the paused screen's list.
  router.get(
    '/campaigns/:id/sends',
    handle((request, response) => {
      const status = request.query.status;
      response.json(
        listSends(request.params.id!, {
          status: status === 'failed' || status === 'skipped' || status === 'queued' ? status : 'sent',
          limit: Number(request.query.limit ?? 50) || 50,
          offset: Number(request.query.offset ?? 0) || 0,
        }),
      );
    }),
  );

  router.post(
    '/campaigns/:id/cancel',
    handle((request, response) => {
      response.json(cancelCampaign(request.params.id!));
    }),
  );

  return router;
}
