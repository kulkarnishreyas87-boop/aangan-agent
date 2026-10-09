// Full flow against the REAL Gemini, Neon, Cal.com and HubSpot. Only Resend is stubbed (no emails are sent).
// Takes the T01 transcript through finalise, scheduling, HubSpot sync and a designer "Won", checks the result in each
// real system, then cancels the booking and deletes the HubSpot deal and contact and the Neon rows.
// Usage: node --env-file=.env scripts/e2e-live.js <enquiries.txt>
import { readFileSync } from 'node:fs';
import { cleanupTestRows } from './_cleanup.js';
import { need } from '../src/config.js';

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('api.resend.com')) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'stub-email' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

const store = await import('../src/db.js');
const { finalizeCall } = await import('../src/pipeline.js');
const { drain } = await import('../src/worker.js');

const text = readFileSync(process.argv[2], 'utf8').split('SECTION 2')[0];
const t01 = text.split(/\n(?=T\d\d\s)/).find((b) => b.startsWith('T01')).replace(/\s*\n\s*/g, '\n');
const hsH = { Authorization: `Bearer ${need('HUBSPOT_ACCESS_TOKEN')}`, 'content-type': 'application/json' };
const hs = async (p, m = 'GET') => { const r = await realFetch(`https://api.hubapi.com${p}`, { method: m, headers: hsH }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const calH = { Authorization: `Bearer ${need('CALCOM_API_KEY')}`, 'cal-api-version': need('CALCOM_BOOKINGS_API_VERSION'), 'content-type': 'application/json' };

let bad = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' | ' + d : ''}`); if (!ok) bad++; };
const drainAll = async () => { for (let i = 0; i < 12; i++) { await drain(); const n = (await store.db().query('SELECT count(*)::int n FROM outbox WHERE done_at IS NULL AND run_after <= now()')).rows[0].n; if (!n) return; } };

const startedTest = new Date();
let callId, booking, contactId, dealId;
try {
  const ext = `live-${Date.now()}`;
  const phone = '+919999900005';
  const call = await store.upsertCall({ externalCallId: ext, callerPhone: phone, startedAt: new Date(Date.now() - 300000), answeredAt: new Date(Date.now() - 297000) });
  callId = call.id;
  const r = await finalizeCall({ externalCallId: ext, callerPhone: phone, startedAt: call.started_at, answeredAt: call.answered_at, endedAt: new Date(), durationS: 252, transcript: t01 });
  check('Gemini qualified the T01 call', r.route === 'QUALIFY', `route=${r.route}`);
  await drainAll();

  const row = await store.getCall(callId);
  booking = await store.bookingForCall(callId);
  contactId = row.hubspot_contact_id; dealId = row.hubspot_deal_id;
  check('booking saved in Neon', Boolean(booking?.calcom_uid), booking && `${booking.visit_type} at ${booking.start_at.toISOString()}`);

  const cb = await realFetch(`https://api.cal.com/v2/bookings/${booking.calcom_uid}`, { headers: calH });
  const cj = await cb.json();
  check('booking exists in Cal.com and is accepted', cb.status === 200 && cj.data?.status === 'accepted', `HTTP ${cb.status} status=${cj.data?.status}`);

  const d = await hs(`/crm/v3/objects/deals/${dealId}?properties=dealstage,pipeline,aangan_route,aangan_answer_seconds,aangan_booking_start,aangan_handoff_note,aangan_reason_codes`);
  check('HubSpot deal is in the Aangan pipeline at the Consultation booked stage', d.j.properties?.pipeline === need('HUBSPOT_PIPELINE_ID') && d.j.properties?.dealstage === need('HUBSPOT_STAGE_BOOKED'), `pipeline=${d.j.properties?.pipeline} stage=${d.j.properties?.dealstage}`);
  check('HubSpot custom properties were stored', d.j.properties?.aangan_route === 'QUALIFY' && Number(d.j.properties?.aangan_answer_seconds) === 3 && Boolean(d.j.properties?.aangan_booking_start) && Boolean(d.j.properties?.aangan_handoff_note),
    `route=${d.j.properties?.aangan_route} answer_s=${d.j.properties?.aangan_answer_seconds} booking=${d.j.properties?.aangan_booking_start}`);
  const a = await hs(`/crm/v4/objects/deals/${dealId}/associations/contacts`);
  check('HubSpot deal is linked to the contact', a.j.results?.some((x) => String(x.toObjectId) === String(contactId)));
  const c = await hs(`/crm/v3/objects/contacts/${contactId}?properties=phone,firstname`);
  check('HubSpot contact has the caller phone and name', c.j.properties?.phone === phone && Boolean(c.j.properties?.firstname), `${c.j.properties?.firstname} ${c.j.properties?.phone}`);
  check('handoff email would go to designers with signed links', sent.some((m) => /New lead/.test(m.subject) && /\/lead\/won\?id=\d+&sig=/.test(m.text)));

  // Designer taps Won: the same path the signed-link page takes
  const handoff = (await store.db().query('SELECT * FROM handoffs WHERE call_id=$1', [callId])).rows[0];
  await store.claimHandoff(handoff.id, 'Test designer');
  await store.setOutcome(handoff.id, 'won');
  await store.enqueue('hubspot_sync', { callId });
  await drainAll();
  const d2 = await hs(`/crm/v3/objects/deals/${dealId}?properties=dealstage`);
  check('after "Won" the HubSpot deal moves to the Won stage', d2.j.properties?.dealstage === need('HUBSPOT_STAGE_WON'), `stage=${d2.j.properties?.dealstage}`);
} catch (e) {
  bad++; console.log('ERROR', e.stack);
} finally {
  if (booking?.calcom_uid) { const r = await realFetch(`https://api.cal.com/v2/bookings/${booking.calcom_uid}/cancel`, { method: 'POST', headers: calH, body: JSON.stringify({ cancellationReason: 'Automated integration test' }) }); console.log('cancel Cal.com booking:', r.status); }
  if (dealId) console.log('delete HubSpot deal:', (await hs(`/crm/v3/objects/deals/${dealId}`, 'DELETE')).s);
  if (contactId) console.log('delete HubSpot contact:', (await hs(`/crm/v3/objects/contacts/${contactId}`, 'DELETE')).s);
  if (callId) {
    await cleanupTestRows(store, { startedTest, callIds: [callId], phones: ['+919999900005'] });
    console.log('test rows removed from Neon');
  }
  await store.db().end();
  console.log(bad ? `\n${bad} check(s) FAILED` : '\nAll checks passed');
  process.exitCode = bad ? 1 : 0;
}
