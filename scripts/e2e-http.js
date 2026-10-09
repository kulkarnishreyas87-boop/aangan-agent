// HTTP surface of our own server against the real Neon database (no Gemini, no vendor calls):
// signed email links (claim, won, lost), the Cal.com webhook signature, /health, and malformed input.
// Usage: node --env-file=.env scripts/e2e-http.js
import { createHmac } from 'node:crypto';
import { cleanupTestRows } from './_cleanup.js';

Object.assign(process.env, {
  PUBLIC_BASE_URL: 'https://example.test', ACTION_LINK_SECRET: 'http-test-link-secret',
  CALCOM_WEBHOOK_SECRET: 'http-test-cal-secret', VAANI_WEBHOOK_SECRET: 'http-test-path-secret', VAANI_BYOL_TOKEN: 'http-test-byol'
});
const store = await import('../src/db.js');
const email = await import('../src/email.js');
const { createServer } = await import('../src/http-server.js');
const server = createServer();
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const startedTest = new Date();

let bad = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' | ' + d : ''}`); if (!ok) bad++; };
const q = (t, p) => store.db().query(t, p);
const req = async (method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers, body });
  return { s: r.status, t: await r.text() };
};
const link = (id, action, tamper = false) => { const u = new URL(email.actionLink(id, action)); return `${u.pathname}${u.search.replace(/sig=(.)/, tamper ? 'sig=0' : 'sig=$1')}`; };
const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

let callId;
try {
  const call = await store.upsertCall({ externalCallId: `http-${Date.now()}`, callerPhone: '+919999900007' });
  callId = call.id;
  const h = await store.createHandoff(callId);

  const health = await req('GET', '/health');
  check('GET /health reports the database and outbox counts', health.s === 200 && JSON.parse(health.t).db === true && typeof JSON.parse(health.t).outbox.dead === 'number', health.t);

  process.env.CRON_SECRET = 'http-test-cron-secret';
  const cronNone = await req('GET', '/cron/drain');
  check('cron endpoint refuses a request with no secret', cronNone.s === 401);
  const cronBad = await req('GET', '/cron/drain', undefined, { authorization: 'Bearer wrong' });
  check('cron endpoint refuses the wrong secret', cronBad.s === 401);
  const cronOk = await req('GET', '/cron/drain', undefined, { authorization: 'Bearer http-test-cron-secret' });
  check('cron endpoint with the right secret drains the outbox', cronOk.s === 200 && JSON.parse(cronOk.t).ok === true, cronOk.t);

  const unknown = await req('GET', '/nope');
  check('unknown path returns 404', unknown.s === 404);

  const good = await req('GET', link(h.id, 'won'));
  check('Won link opens a confirmation page and changes nothing yet', good.s === 200 && /Mark this lead Won/.test(good.t) && (await q('SELECT outcome FROM handoffs WHERE id=$1', [h.id])).rows[0].outcome === null);
  const tampered = await req('GET', link(h.id, 'won', true));
  check('tampered link is rejected', tampered.s === 400);

  const sig = new URL(email.actionLink(h.id, 'claim')).searchParams.get('sig');
  const claim = await req('POST', '/lead/action', form({ id: h.id, action: 'claim', sig, name: 'Asha <b>' }), FORM);
  const row1 = (await q('SELECT claimed_by FROM handoffs WHERE id=$1', [h.id])).rows[0];
  check('claim stores the designer name, escaped on the page', claim.s === 200 && row1.claimed_by === 'Asha <b>' && !/<b>/.test(claim.t) && /&lt;b&gt;/.test(claim.t), row1.claimed_by);

  const claim2 = await req('POST', '/lead/action', form({ id: h.id, action: 'claim', sig, name: 'Ravi' }), FORM);
  check('a second designer cannot take a lead that is already claimed', claim2.s === 409 && /already claimed/i.test(claim2.t) && (await q('SELECT claimed_by FROM handoffs WHERE id=$1', [h.id])).rows[0].claimed_by === 'Asha <b>');

  const wrongAction = await req('POST', '/lead/action', form({ id: h.id, action: 'lost', sig }), FORM);
  check('a claim signature cannot be used to mark Lost', wrongAction.s === 400);

  const wonSig = new URL(email.actionLink(h.id, 'won')).searchParams.get('sig');
  const won = await req('POST', '/lead/action', form({ id: h.id, action: 'won', sig: wonSig }), FORM);
  const row2 = (await q('SELECT outcome FROM handoffs WHERE id=$1', [h.id])).rows[0];
  const queued = (await q("SELECT count(*)::int n FROM outbox WHERE kind='hubspot_sync' AND created_at >= $1 AND payload->>'callId' = $2", [startedTest, String(callId)])).rows[0].n;
  check('Won is saved and queues a HubSpot sync', won.s === 200 && row2.outcome === 'won' && queued === 1, `outcome=${row2.outcome} queued=${queued}`);

  const lostSig = new URL(email.actionLink(h.id, 'lost')).searchParams.get('sig');
  const flip = await req('POST', '/lead/action', form({ id: h.id, action: 'lost', sig: lostSig }), FORM);
  check('a lead already marked Won cannot be flipped to Lost from an email link', flip.s === 409 && (await q('SELECT outcome FROM handoffs WHERE id=$1', [h.id])).rows[0].outcome === 'won');

  const missing = await req('POST', '/lead/action', form({ id: 99999999, action: 'won', sig: new URL(email.actionLink(99999999, 'won')).searchParams.get('sig') }), FORM);
  check('a validly signed link for a lead that does not exist returns 404', missing.s === 404);
  const junk = await req('POST', '/lead/action', 'id=abc&action=won&sig=zz', FORM);
  check('garbage form data is rejected, not a crash', junk.s === 400);

  // Cal.com webhook
  const b = await store.insertBooking({ callId, uid: `http-uid-${Date.now()}`, id: 1, eventTypeId: 1, visitType: 'phone', start: new Date(Date.now() + 86400000), status: 'accepted' });
  const evt = JSON.stringify({ triggerEvent: 'BOOKING_CANCELLED', payload: { uid: b.calcom_uid } });
  const goodSig = createHmac('sha256', process.env.CALCOM_WEBHOOK_SECRET).update(evt).digest('hex');
  const bad1 = await req('POST', '/calcom/webhook', evt, { 'content-type': 'application/json', 'x-cal-signature-256': 'deadbeef' });
  check('Cal.com webhook with a wrong signature is rejected', bad1.s === 401);
  const none = await req('POST', '/calcom/webhook', evt, { 'content-type': 'application/json' });
  check('Cal.com webhook with no signature is rejected', none.s === 401);
  const ok = await req('POST', '/calcom/webhook', evt, { 'content-type': 'application/json', 'x-cal-signature-256': goodSig });
  const bk = (await q('SELECT status FROM bookings WHERE id=$1', [b.id])).rows[0];
  check('signed Cal.com cancellation updates the booking', ok.s === 200 && bk.status === 'cancelled', `status=${bk.status}`);

  // Vaani webhook hardening
  const badJson = await req('POST', `/vaani/webhook/${process.env.VAANI_WEBHOOK_SECRET}`, '{not json', { 'content-type': 'application/json' });
  check('malformed JSON on the Vaani webhook returns 400, not 500', badJson.s === 400, `HTTP ${badJson.s}`);
  const noId = await req('POST', `/vaani/webhook/${process.env.VAANI_WEBHOOK_SECRET}`, JSON.stringify({ event: 'call_started' }), { 'content-type': 'application/json' });
  check('a webhook with no call id is ignored safely', noId.s === 200 && /no call id/.test(noId.t), noId.t);
  const wrongPath = await req('POST', '/vaani/webhook/wrong', JSON.stringify({}), { 'content-type': 'application/json' });
  check('wrong webhook secret returns 404', wrongPath.s === 404);
  const bigBody = 'x'.repeat(2_100_000);
  let bigOk = false;
  try { const r = await req('POST', `/vaani/webhook/${process.env.VAANI_WEBHOOK_SECRET}`, bigBody, { 'content-type': 'application/json' }); bigOk = r.s >= 400; } catch { bigOk = true; }
  check('an oversized body is refused', bigOk);
  const after = await req('GET', '/health');
  check('server still healthy after all the bad input', after.s === 200);
} catch (e) {
  bad++; console.log('ERROR', e.stack);
} finally {
  if (callId) {
    await cleanupTestRows(store, { startedTest, callIds: [callId], phones: ['+919999900007'] });
    console.log('test rows removed from Neon');
  }
  server.close(); await store.db().end();
  console.log(bad ? `\n${bad} check(s) FAILED` : '\nAll checks passed');
  process.exit(bad ? 1 : 0);
}
