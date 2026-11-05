import express from 'express';
import { getDb } from '../db/index.js';
import { escapeHtml } from '../email/render.js';
import { TEST_SOURCE, verifyLink, type LinkPayload } from '../email/links.js';
import {
  preferencesFor,
  setPreferences,
  unsubscribeAllMarketing,
  type PreferenceSource,
} from '../email/preferences.js';
import { getSettings } from '../email/settings.js';
import { getEmailType } from '../email/types.js';

/**
 * The public email-preference page at /p/:token.
 *
 * No login: the signed token in each email is the credential. Server-rendered,
 * works without JavaScript, and in the sender's name — it never says
 * PartnerDex. A GET never changes anything, because mail scanners open every
 * link in an email before a person does; every change is a POST.
 */

const CSS = `
:root{--ground:#f4f6f9;--paper:#fff;--ink:#111827;--ink-2:#4b5563;--muted:#6b7280;--rule:#e2e6ec;
--accent:#2e72d2;--accent-ink:#fff;--ok:#15803d;--ok-soft:#e7f6ec;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--ground:#0f1115;--paper:#181b21;--ink:#e7e9ee;--ink-2:#b4bac5;--muted:#9aa1ad;
--rule:#2b3038;--accent:#6ba3e8;--accent-ink:#0b1220;--ok:#4ade80;--ok-soft:#163222;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.55 var(--sans)}
.page{padding:40px max(16px,env(safe-area-inset-right,0px)) 64px max(16px,env(safe-area-inset-left,0px))}
.col{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
.sender{display:flex;align-items:center;gap:10px;font-weight:650;font-size:17px}
.mark{width:30px;height:30px;border-radius:8px;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;font-size:14px;font-weight:700}
h1{font-size:24px;line-height:1.25;margin:0}
.lead{margin:6px 0 0;color:var(--ink-2)}
.lead b{color:var(--ink);font-weight:600;overflow-wrap:anywhere}
.notice{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:var(--ok-soft);
border:1px solid color-mix(in srgb,var(--ok) 35%,transparent);border-radius:10px;padding:12px 14px}
.notice p{margin:0;min-width:0}
.notice form{margin:0}
.linkish{font:inherit;background:none;border:0;color:var(--accent);cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:2px}
.card{background:var(--paper);border:1px solid var(--rule);border-radius:12px}
.types{list-style:none;margin:0;padding:0}
.type{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:16px 18px}
.type+.type{border-top:1px solid var(--rule)}
.type-name{font-weight:600}
.type-desc{color:var(--muted);font-size:14px;margin-top:2px}
.always{font-size:12px;color:var(--muted);white-space:nowrap}
.switch{position:relative;display:inline-flex;cursor:pointer}
.switch input{position:absolute;opacity:0;width:1px;height:1px}
.track{width:42px;height:24px;border-radius:999px;background:var(--rule);position:relative;transition:background .15s}
.track::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--paper);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.switch input:checked+.track{background:var(--accent)}
.switch input:checked+.track::after{transform:translateX(18px)}
.switch input:focus-visible+.track,.btn:focus-visible,.linkish:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.actions form{margin:0}
.btn{font:inherit;font-weight:600;border-radius:8px;padding:10px 16px;cursor:pointer;border:1px solid var(--rule);background:var(--paper);color:var(--ink);text-decoration:none;display:inline-block}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.quiet{border:0;background:none;color:var(--ink-2);padding-inline:0;font-weight:500;text-decoration:underline;text-underline-offset:3px}
.saved{font-size:14px;color:var(--ok)}
.foot{font-size:13px;color:var(--muted);border-top:1px solid var(--rule);padding-top:16px;display:flex;flex-direction:column;gap:4px}
.big{padding:28px 22px;display:flex;flex-direction:column;gap:10px}
.big h2{margin:0;font-size:19px}
.big p{margin:0;color:var(--ink-2)}
@media (prefers-reduced-motion:reduce){.track,.track::after{transition:none}}
`;

interface Context {
  token: string;
  link: LinkPayload;
  senderName: string;
  footerAddress: string;
  shopName: string | null;
  isTest: boolean;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? words[0]?.[1] ?? '')).toLowerCase() || '·';
}

function layout(ctx: Pick<Context, 'senderName' | 'footerAddress'>, title: string, inner: string): string {
  const name = escapeHtml(ctx.senderName);
  const footer = [ctx.senderName, ctx.footerAddress].filter(Boolean).map(escapeHtml).join(' · ');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main class="page"><div class="col">` +
    (ctx.senderName ? `<div class="sender"><span class="mark" aria-hidden="true">${escapeHtml(initials(ctx.senderName))}</span>${name}</div>` : '') +
    inner +
    `<div class="foot">${footer ? `<span>${footer}</span>` : ''}` +
    `<span>This page works without signing in. The link in each email is unique to you.</span></div>` +
    `</div></main></body></html>`
  );
}

function send(response: express.Response, status: number, html: string): void {
  response
    .status(status)
    .set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    })
    .type('html')
    .send(html);
}

function badToken(response: express.Response): void {
  send(
    response,
    400,
    layout(
      { senderName: '', footerAddress: '' },
      'Link not valid',
      `<div class="card big"><h2>This link does not work</h2><p>Open the newest email and use the link in it.</p></div>`,
    ),
  );
}

function contextFor(token: string): Context | null {
  const link = verifyLink(token);
  if (!link) return null;
  const settings = getSettings();
  let shopName: string | null = null;
  if (link.sourceId !== TEST_SOURCE) {
    const row = getDb()
      .prepare('SELECT merge FROM email_sends WHERE campaign_id = ? AND email = ?')
      .get(link.sourceId, link.email) as { merge: string } | undefined;
    if (row) {
      try {
        shopName = (JSON.parse(row.merge) as { fields?: { shop_name?: string | null } }).fields?.shop_name ?? null;
      } catch {
        shopName = null;
      }
    }
  }
  return {
    token,
    link,
    senderName: settings.fromName,
    footerAddress: settings.footerAddress,
    shopName,
    isTest: link.sourceId === TEST_SOURCE,
  };
}

function typeLabel(key: string): string {
  return getEmailType(key)?.label ?? key;
}

function action(ctx: Context, suffix = ''): string {
  return `/p/${encodeURIComponent(ctx.token)}${suffix}`;
}

function testNotice(): string {
  return `<div class="notice" role="status"><p>This was a test email — nothing changed.</p></div>`;
}

function managePage(ctx: Context, notice: string, saved: boolean): string {
  const name = ctx.senderName || 'us';
  const rows = preferencesFor(ctx.link.email)
    .map((type, index) => {
      const id = `t${index}`;
      const control = type.canUnsubscribe
        ? `<label class="switch"><input type="checkbox" name="types" value="${escapeHtml(type.key)}" aria-labelledby="${id}"${type.subscribed ? ' checked' : ''}><span class="track" aria-hidden="true"></span></label>`
        : `<span class="always">Always on</span>`;
      return (
        `<li class="type"><div><div class="type-name" id="${id}">${escapeHtml(type.label)}</div>` +
        `<div class="type-desc">${escapeHtml(type.description)}</div></div>${control}</li>`
      );
    })
    .join('');
  return layout(
    ctx,
    `Email preferences`,
    `<div><h1>Choose the emails you get from ${escapeHtml(name)}</h1>` +
      `<p class="lead">For <b>${escapeHtml(ctx.link.email)}</b>${ctx.shopName ? ` · ${escapeHtml(ctx.shopName)}` : ''}</p></div>` +
      notice +
      `<form method="post" action="${action(ctx)}" id="prefs"><input type="hidden" name="save" value="1">` +
      `<div class="card"><ul class="types">${rows}</ul></div></form>` +
      `<div class="actions"><div><button type="submit" form="prefs" class="btn primary">Save preferences</button>` +
      (saved ? ` <span class="saved" role="status">Saved.</span>` : '') +
      `</div><form method="post" action="${action(ctx, '/all')}"><button type="submit" class="btn quiet">Unsubscribe from all marketing email</button></form></div>`,
  );
}

function offNotice(ctx: Context): string {
  return (
    `<div class="notice" role="status"><p>You are unsubscribed from <b>${escapeHtml(typeLabel(ctx.link.typeKey))}</b>.</p>` +
    `<form method="post" action="${action(ctx, '/undo')}"><button type="submit" class="linkish">Undo</button></form></div>`
  );
}

/** "Unsubscribe from X" in the footer: confirm with one button, no JavaScript. */
function confirmOffNotice(ctx: Context): string {
  return (
    `<div class="notice" role="status"><p>Turn off <b>${escapeHtml(typeLabel(ctx.link.typeKey))}</b>?</p>` +
    `<form method="post" action="${action(ctx, '/off')}"><button type="submit" class="btn primary">Unsubscribe</button></form></div>`
  );
}

function allPage(ctx: Context): string {
  const name = ctx.senderName || 'us';
  const marketing = preferencesFor(ctx.link.email)
    .filter((type) => type.canUnsubscribe)
    .map((type) => type.label.toLowerCase());
  const covers = marketing.length > 1 ? `${marketing.slice(0, -1).join(', ')}, and ${marketing.at(-1)}` : (marketing[0] ?? 'marketing email');
  return layout(
    ctx,
    'Unsubscribed',
    `<div class="card big"><h2>You will not get marketing email from ${escapeHtml(name)}</h2>` +
      `<p>That covers ${escapeHtml(covers)} for <b>${escapeHtml(ctx.link.email)}</b>. We still send account notices when something needs you, such as a billing problem.</p>` +
      `<div><a class="btn" href="${action(ctx)}">Choose emails again</a></div></div>`,
  );
}

function markUnsubscribed(link: LinkPayload): void {
  getDb()
    .prepare(
      `UPDATE email_sends SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE campaign_id = ? AND email = ?`,
    )
    .run(new Date().toISOString(), link.sourceId, link.email);
}

function turnOff(link: LinkPayload, source: PreferenceSource): void {
  setPreferences(link.email, { [link.typeKey]: false }, source);
  markUnsubscribed(link);
}

function withContext(
  fn: (ctx: Context, request: express.Request, response: express.Response) => void,
): express.RequestHandler {
  return (request, response) => {
    try {
      const ctx = contextFor(request.params.token ?? '');
      if (!ctx) {
        badToken(response);
        return;
      }
      fn(ctx, request, response);
    } catch (error) {
      console.error('[partnerdex] preference page:', error);
      send(response, 500, layout({ senderName: '', footerAddress: '' }, 'Error', `<div class="card big"><h2>Something went wrong</h2><p>Try again in a minute.</p></div>`));
    }
  };
}

function testAnswer(ctx: Context, response: express.Response): void {
  send(response, 200, managePage(ctx, testNotice(), false));
}

export function preferencesRouter(): express.Router {
  const router = express.Router();

  router.get(
    '/:token',
    withContext((ctx, request, response) => {
      if (ctx.isTest) {
        testAnswer(ctx, response);
        return;
      }
      const notice =
        request.query.done === 'off' ? offNotice(ctx) : request.query.off === '1' ? confirmOffNotice(ctx) : '';
      send(response, 200, managePage(ctx, notice, request.query.saved === '1'));
    }),
  );

  // List-Unsubscribe-Post from the mail app (RFC 8058). Turns off this type only.
  router.post(
    '/:token/one-click',
    withContext((ctx, _request, response) => {
      if (!ctx.isTest) turnOff(ctx.link, 'one_click');
      send(
        response,
        200,
        layout(
          ctx,
          'Unsubscribed',
          `<div class="card big"><h2>${ctx.isTest ? 'This was a test email — nothing changed.' : `You are unsubscribed from ${escapeHtml(typeLabel(ctx.link.typeKey))}`}</h2></div>`,
        ),
      );
    }),
  );

  router.post(
    '/:token/off',
    withContext((ctx, _request, response) => {
      if (ctx.isTest) return testAnswer(ctx, response);
      turnOff(ctx.link, 'preference_page');
      response.redirect(303, `${action(ctx)}?done=off`);
    }),
  );

  router.post(
    '/:token/undo',
    withContext((ctx, _request, response) => {
      if (ctx.isTest) return testAnswer(ctx, response);
      setPreferences(ctx.link.email, { [ctx.link.typeKey]: true }, 'preference_page');
      response.redirect(303, `${action(ctx)}?saved=1`);
    }),
  );

  router.post(
    '/:token/all',
    withContext((ctx, _request, response) => {
      if (ctx.isTest) return testAnswer(ctx, response);
      unsubscribeAllMarketing(ctx.link.email, 'preference_page');
      markUnsubscribed(ctx.link);
      send(response, 200, allPage(ctx));
    }),
  );

  router.post(
    '/:token',
    withContext((ctx, request, response) => {
      if (ctx.isTest) return testAnswer(ctx, response);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const raw = body.types;
      const chosen = new Set(Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : []);
      const choices: Record<string, boolean> = {};
      for (const type of preferencesFor(ctx.link.email)) {
        if (type.canUnsubscribe) choices[type.key] = chosen.has(type.key);
      }
      setPreferences(ctx.link.email, choices, 'preference_page');
      response.redirect(303, `${action(ctx)}?saved=1`);
    }),
  );

  return router;
}
