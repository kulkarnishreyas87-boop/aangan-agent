// HTTP entry points. Plain node:http, no framework.
//   WS   /vaani/llm/<call_id>      Vaani's per-turn connection (Bring Your Own LLM), bearer token required
//   POST /vaani/webhook/<secret>   Vaani call events (call_started, call_postprocessing)
//   GET  /lead/{claim|won|lost}?id&sig   confirmation page linked from the handoff email
//   POST /lead/action        performs the claim / won / lost (form post from that page)
//   POST /calcom/webhook     booking cancelled or rescheduled
//   GET  /health             database reachable, outbox pending and dead counts
import http from 'node:http';
import * as vaani from './vaani.js';
import * as store from './db.js';
import * as email from './email.js';
import * as cal from './calcom.js';
import { onVaaniEvent } from './vaani-events.js';
import { attach } from './byol.js';
import { drain } from './worker.js';
import { background } from './background.js';
import { safeEqual } from './vaani.js';
import { restoreUrl } from './url.js';
import { serveStatic } from './static.js';
import * as auth from './auth.js';
import { dashboardData, publicStats } from './dashboard-data.js';

const MAX_BODY = 2_000_000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const parseJson = (raw) => {
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'invalid JSON'); }
};

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const page = (res, status, title, inner) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${esc(title)}</h1>${inner}</body>`);
};

const LABEL = { claim: 'Claim this lead', won: 'Mark this lead Won', lost: 'Mark this lead Lost' };

function confirmPage(res, url) {
  const id = Number(url.searchParams.get('id'));
  const action = url.pathname.split('/').pop();
  const sig = url.searchParams.get('sig');
  if (!Number.isInteger(id) || !email.verifyAction(id, action, sig)) return page(res, 400, 'Link not valid', '<p>This link is not valid or was changed.</p>');
  const name = action === 'claim' ? '<p><label>Your name<br><input name="name" required style="padding:.5rem;width:100%"></label></p>' : '';
  return page(res, 200, LABEL[action], `<form method="post" action="/lead/action">
<input type="hidden" name="id" value="${id}"><input type="hidden" name="action" value="${esc(action)}"><input type="hidden" name="sig" value="${esc(sig)}">
${name}<p><button style="padding:.6rem 1rem;font-size:1rem">${esc(LABEL[action])}</button></p></form>`);
}

async function leadAction(res, raw) {
  const f = new URLSearchParams(raw);
  const id = Number(f.get('id'));
  const action = f.get('action');
  if (!Number.isInteger(id) || !email.verifyAction(id, action, f.get('sig'))) return page(res, 400, 'Link not valid', '<p>This link is not valid or was changed.</p>');
  const handoff = await store.getHandoff(id);
  if (!handoff) return page(res, 404, 'Lead not found', '<p>This lead no longer exists.</p>');
  if (action === 'claim') {
    const who = (f.get('name') ?? '').trim().slice(0, 80) || 'someone';
    if (await store.claimHandoff(id, who)) return page(res, 200, 'Claimed', `<p>${esc(who)}, this lead is yours.</p>`);
    const now = await store.getHandoff(id);
    return page(res, 409, 'Already claimed', `<p>${esc(now.claimed_by)} has already claimed this lead.</p>`);
  }
  if (handoff.outcome && handoff.outcome !== action) {
    return page(res, 409, 'Already marked', `<p>This lead was already marked ${esc(handoff.outcome)}. Ask the studio head to change it.</p>`);
  }
  await store.setOutcome(id, action);
  await store.enqueue('hubspot_sync', { callId: handoff.call_id });
  await background(drain(), { waitMs: 20000 });
  return page(res, 200, action === 'won' ? 'Marked Won' : 'Marked Lost', '<p>Thanks. HubSpot will update shortly.</p>');
}

// VERIFY the payload shape against Cal.com's webhook docs before relying on this. A reschedule may arrive under a new uid,
// so we match the old uid too and keep the new one.
async function onCalcom(evt) {
  const p = evt?.payload ?? {};
  const uids = [p.uid, p.rescheduleUid, p.rescheduledFromUid, p.bookingUid].filter(Boolean);
  if (!uids.length) return;
  const trig = evt.triggerEvent;
  let changed = 0;
  if (trig === 'BOOKING_CANCELLED') changed = await store.setBookingStatusByUid(uids, 'cancelled', null, null);
  else if (trig === 'BOOKING_RESCHEDULED') changed = await store.setBookingStatusByUid(uids, 'accepted', p.startTime ?? null, p.uid ?? null);
  else return;
  if (!changed) return; // not one of ours
  const booking = (await store.bookingByUid(p.uid ?? uids[0])) ?? null;
  if (booking) await store.enqueue('hubspot_sync', { callId: booking.call_id }); // stage and consultation time follow the calendar
  await store.enqueue('email_task', { text: `Cal.com booking ${uids[0]}: ${trig}. Check the calendar.`, to: 'designers' });
  await background(drain(), { waitMs: 20000 });
}

const routes = {
  'GET /lead/claim': async (req, res) => confirmPage(res, new URL(req.url, 'http://x')),
  'GET /lead/won': async (req, res) => confirmPage(res, new URL(req.url, 'http://x')),
  'GET /lead/lost': async (req, res) => confirmPage(res, new URL(req.url, 'http://x')),
  'POST /lead/action': async (req, res, raw) => leadAction(res, raw),
  'POST /calcom/webhook': async (req, res, raw) => {
    if (!cal.verifyWebhook(raw, req.headers['x-cal-signature-256'])) return json(res, 401, { error: 'bad signature' });
    await onCalcom(parseJson(raw));
    return json(res, 200, { ok: true });
  },
  // Vercel Cron calls this every minute (vercel.json) with Authorization: Bearer $CRON_SECRET. It replaces the in-process timer,
  // which does not exist on Vercel. It also retries any job whose backoff has expired.
  'GET /cron/drain': async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || !safeEqual(req.headers.authorization ?? '', 'Bearer ' + secret)) return json(res, 401, { error: 'unauthorized' });
    await drain(50);
    return json(res, 200, { ok: true, outbox: await store.outboxStats() });
  },
  // ---- dashboard API. Login gives a signed cookie; everything with customer data needs it. ----
  'POST /api/login': async (req, res, raw) => {
    const ip = auth.clientIp(req);
    if (!auth.dashboardEnabled()) return json(res, 503, { error: 'The dashboard login is not set up yet.' });
    if (auth.throttled(ip)) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    let password = '';
    try { password = JSON.parse(raw || '{}').password; } catch { return json(res, 400, { error: 'invalid JSON' }); }
    if (!auth.passwordOk(password)) {
      auth.recordFailure(ip);
      await new Promise((r) => setTimeout(r, 400)); // a wrong guess is never answered faster than a right one
      return json(res, 401, { error: 'That password is not right.' });
    }
    auth.clearFailures(ip);
    res.setHeader('set-cookie', auth.sessionCookie(req, auth.makeSession()));
    return json(res, 200, { ok: true });
  },
  'POST /api/logout': async (req, res) => {
    res.setHeader('set-cookie', auth.clearCookie(req));
    return json(res, 200, { ok: true });
  },
  'GET /api/me': async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    return json(res, 200, { enabled: auth.dashboardEnabled(), authed: auth.isAuthed(req) });
  },
  'GET /api/dashboard': async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    // No DASHBOARD_PASSWORD means an open dashboard (redacted). With a password, a valid login is required and nothing is redacted.
    if (auth.dashboardEnabled() && !auth.isAuthed(req)) return json(res, 401, { error: 'login required' });
    return json(res, 200, await dashboardData({ open: !auth.dashboardEnabled() }));
  },
  'GET /api/public-stats': async (req, res) => {
    res.setHeader('cache-control', 'public, max-age=15');
    try { return json(res, 200, await publicStats()); } catch { return json(res, 200, { total: 0, qualified: 0, last_24h: 0 }); }
  },
  'GET /favicon.ico': async (req, res) => { res.writeHead(302, { location: '/favicon.svg' }); res.end(); },
  'GET /health': async (req, res) => {
    try { return json(res, 200, { ok: true, db: true, outbox: await store.outboxStats() }); }
    catch { return json(res, 503, { ok: false, db: false }); }
  }
};

export function createServer() {
  const server = http.createServer(async (req, res) => {
    restoreUrl(req);
    const path = req.url.split('?')[0];
    try {
      if (req.method === 'POST' && path.startsWith('/vaani/webhook/')) {
        let secret = '';
        try { secret = decodeURIComponent(path.slice('/vaani/webhook/'.length)); } catch { /* bad escape: falls through to 404 */ }
        if (!vaani.verifyPathSecret(secret)) return json(res, 404, { error: 'not found' });
        return json(res, 200, await onVaaniEvent(parseJson(await readBody(req))));
      }
      const key = `${req.method} ${path}`;
      const handler = routes[key];
      if (!handler) {
        if (await serveStatic(req, res, path)) return;
        return json(res, 404, { error: 'not found' });
      }
      await handler(req, res, req.method === 'POST' ? await readBody(req) : '');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(`[${req.method} ${path.startsWith('/vaani/webhook/') ? '/vaani/webhook/…' : path}]`, e.message); // never log the secret path
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'internal error' : e.message });
    }
  });
  attach(server);
  return server;
}
