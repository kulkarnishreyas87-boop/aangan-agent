// End-to-end run of OUR code with Cal.com, HubSpot and Resend replaced by stand-ins.
// Real: Gemini (decision, handoff note, slot choice) and the Neon database. Fake: the three vendor APIs below.
// This proves our flow, request bodies and database writes. It does NOT prove the real vendors accept those requests:
// run scripts/e2e-live.js (needs real keys) for that.
// Usage: node --env-file=.env scripts/e2e-mock.js <enquiries.txt>
import { readFileSync } from 'node:fs';
import { cleanupTestRows } from './_cleanup.js';

// Fake vendor settings, only for this process. Real values come from .env in production.
Object.assign(process.env, {
  CALCOM_API_KEY: 'cal_mock', CALCOM_EVENT_TYPE_ID_SITE_VISIT: '111', CALCOM_EVENT_TYPE_ID_PHONE: '222',
  CALCOM_SLOTS_API_VERSION: '2024-09-04', CALCOM_BOOKINGS_API_VERSION: '2026-02-25',
  HUBSPOT_ACCESS_TOKEN: 'pat_mock', HUBSPOT_DEAL_TO_CONTACT_ASSOC_ID: '3',
  HUBSPOT_STAGE_QUALIFIED: 'stage_qualified', HUBSPOT_STAGE_BOOKED: 'stage_booked', HUBSPOT_STAGE_WON: 'stage_won',
  HUBSPOT_STAGE_LOST: 'stage_lost', HUBSPOT_STAGE_DECLINED: 'stage_declined', HUBSPOT_STAGE_OTHER: 'stage_other',
  PUBLIC_BASE_URL: 'https://example.test'
});

const seen = [];
const realFetch = globalThis.fetch;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (u.includes('api.cal.com')) {
    seen.push({ vendor: 'calcom', method, path: new URL(u).pathname + new URL(u).search, headers: init.headers, body });
    if (u.includes('/v2/slots')) {
      const data = {};
      for (let d = 2; d <= 6; d++) {
        const day = new Date(Date.now() + d * 86400000);
        const key = day.toISOString().slice(0, 10);
        data[key] = [{ start: `${key}T05:00:00.000Z` }, { start: `${key}T12:30:00.000Z` }];
      }
      return reply({ status: 'success', data });
    }
    if (u.endsWith('/v2/bookings')) return reply({ status: 'success', data: { uid: `mock-${Date.now()}`, id: 9001, status: 'accepted', start: body.start, eventTypeId: body.eventTypeId } }, 201);
  }
  if (u.includes('api.hubapi.com')) {
    seen.push({ vendor: 'hubspot', method, path: new URL(u).pathname, body });
    if (u.includes('/contacts/search')) return reply({ results: [] });
    if (u.endsWith('/crm/v3/objects/contacts')) return reply({ id: 'contact-1' }, 201);
    if (u.endsWith('/crm/v3/objects/deals')) return reply({ id: 'deal-1' }, 201);
    return reply({ id: 'ok' });
  }
  if (u.includes('api.resend.com')) {
    seen.push({ vendor: 'resend', method, path: '/emails', body });
    return reply({ id: 'mock-email-id' });
  }
  return realFetch(url, init); // Gemini and anything else is real
};

const store = await import('../src/db.js');
const { finalizeCall } = await import('../src/pipeline.js');
const { drain } = await import('../src/worker.js');

const file = process.argv[2];
const text = readFileSync(file, 'utf8').split('SECTION 2')[0];
const t01 = text.split(/\n(?=T\d\d\s)/).find((b) => b.startsWith('T01')).replace(/\s*\n\s*/g, '\n');

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' | ' + detail : ''}`); if (!ok) failures++; };
let callId;
const startedTest = new Date();

try {
  const ext = `e2e-${Date.now()}`;
  const call = await store.upsertCall({ externalCallId: ext, callerPhone: '+919999900001', startedAt: new Date(Date.now() - 300000), answeredAt: new Date(Date.now() - 299000) });
  callId = call.id;
  const r = await finalizeCall({ externalCallId: ext, callerPhone: '+919999900001', startedAt: call.started_at, answeredAt: call.answered_at, endedAt: new Date(), durationS: 252, transcript: t01 });
  check('call finalised with real Gemini', r.route === 'QUALIFY', `route=${r.route}`);

  let guard = 0;
  while (guard++ < 12) {
    await drain();
    const pending = (await store.db().query('SELECT count(*)::int n FROM outbox WHERE done_at IS NULL AND run_after <= now()', [])).rows[0].n;
    if (!pending) break;
  }

  const row = await store.getCall(callId);
  const booking = await store.bookingForCall(callId);
  const book = seen.find((s) => s.vendor === 'calcom' && s.method === 'POST');
  const slotReqs = seen.filter((s) => s.vendor === 'calcom' && s.method === 'GET');
  const deals = seen.filter((s) => s.vendor === 'hubspot' && s.path.includes('/deals'));
  const mails = seen.filter((s) => s.vendor === 'resend');

  check('Cal.com slots requested for both event types', slotReqs.length === 2 && slotReqs.some((s) => s.path.includes('eventTypeId=111')) && slotReqs.some((s) => s.path.includes('eventTypeId=222')));
  check('Cal.com slots request sends the slots version header', slotReqs[0]?.headers?.['cal-api-version'] === '2024-09-04');
  check('Cal.com booking request sent', Boolean(book), book ? `eventTypeId=${book.body.eventTypeId} start=${book.body.start}` : '');
  check('Cal.com booking uses bookings version header and bearer auth', book?.headers?.['cal-api-version'] === '2026-02-25' && /^Bearer /.test(book?.headers?.Authorization ?? ''));
  check('Booked slot was one that Cal.com offered', Boolean(book) && /T(05:00|12:30):00\.000Z$/.test(book.body.start));
  check('Booking attendee has name, time zone and phone', Boolean(book?.body?.attendee?.name) && book.body.attendee.timeZone === 'Asia/Kolkata' && book.body.attendee.phoneNumber === '+919999900001', JSON.stringify(book?.body?.attendee));
  check('Booking row saved in Neon', Boolean(booking?.calcom_uid), booking && `uid=${booking.calcom_uid} ${booking.visit_type}`);
  check('HubSpot deal created then updated with booked stage', deals.some((d) => d.method === 'POST') && deals.some((d) => d.method === 'PATCH' && d.body.properties.dealstage === 'stage_booked'), deals.map((d) => `${d.method}:${d.body?.properties?.dealstage}`).join(' '));
  const created = deals.find((d) => d.method === 'POST');
  check('HubSpot deal associated to the contact', created?.body?.associations?.[0]?.to?.id === 'contact-1' && created.body.associations[0].types[0].associationTypeId === 3);
  check('HubSpot deal carries route, answer seconds and note', created?.body?.properties?.aangan_route === 'QUALIFY' && created.body.properties.aangan_answer_seconds === 1 && Boolean(created.body.properties.aangan_handoff_note));
  check('HubSpot ids saved on the call row', row.hubspot_contact_id === 'contact-1' && row.hubspot_deal_id === 'deal-1');
  check('Handoff email sent to designers with signed links', mails.some((m) => /New lead/.test(m.body.subject) && /\/lead\/won\?id=\d+&sig=/.test(m.body.text)));
  check('Confirmation falls back to an email task when Vaani confirmation calls are not configured', mails.some((m) => /confirm/i.test(m.body.text)));
  console.log('\nHubSpot deal properties sent:', JSON.stringify(created?.body?.properties));
} catch (e) {
  failures++;
  console.log('ERROR', e.stack);
} finally {
  if (callId) {
    await cleanupTestRows(store, { startedTest, callIds: [callId], phones: ['+919999900001'] });
    console.log('test rows removed from Neon');
  }
  await store.db().end();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
}
