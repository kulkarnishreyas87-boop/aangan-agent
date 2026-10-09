// Races real workers against the real database to prove the reliability fixes.
//   1. Three drains run at once with two hubspot_sync jobs for one call: exactly ONE HubSpot deal may be created.
//   2. Two schedule jobs for one qualified call: exactly ONE Cal.com booking may be made, even when run in parallel.
//   3. A Cal.com failure releases the reserved booking so a retry can book; nothing is left half-booked.
//   4. A job that keeps failing backs off, is marked dead on the 6th attempt, and a person is emailed.
// Real: Neon and Gemini (slot choice). Fake: Cal.com, HubSpot, Resend and Vaani.
// Usage: node --env-file=.env scripts/e2e-concurrency.js
import { cleanupTestRows } from './_cleanup.js';

Object.assign(process.env, {
  CALCOM_API_KEY: 'cal_mock', CALCOM_EVENT_TYPE_ID_SITE_VISIT: '111', CALCOM_EVENT_TYPE_ID_PHONE: '222',
  CALCOM_SLOTS_API_VERSION: '2024-09-04', CALCOM_BOOKINGS_API_VERSION: '2026-02-25',
  HUBSPOT_ACCESS_TOKEN: 'pat_mock', HUBSPOT_DEAL_TO_CONTACT_ASSOC_ID: '3', HUBSPOT_PIPELINE_ID: 'p1',
  HUBSPOT_STAGE_QUALIFIED: 's_q', HUBSPOT_STAGE_BOOKED: 's_b', HUBSPOT_STAGE_WON: 's_w', HUBSPOT_STAGE_LOST: 's_l', HUBSPOT_STAGE_DECLINED: 's_d', HUBSPOT_STAGE_OTHER: 's_o',
  PUBLIC_BASE_URL: 'https://example.test', EMAIL_ESCALATION: 'alerts@example.test', EMAIL_FRONTDESK: 'desk@example.test', EMAIL_DESIGNERS: 'designers@example.test'
});
delete process.env.VAANI_API_KEY; delete process.env.VAANI_CONFIRM_AGENT_ID; // confirmation falls back to an email task

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;
const ok = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
const log = { dealPosts: 0, contactPosts: 0, bookings: 0, emails: [], calFail: false, resendDown: false };

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (u.includes('api.cal.com')) {
    if (u.includes('/v2/slots')) {
      const data = {};
      for (let d = 2; d <= 4; d++) { const k = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10); data[k] = [{ start: `${k}T05:00:00.000Z` }, { start: `${k}T13:30:00.000Z` }]; }
      return ok({ status: 'success', data });
    }
    if (u.endsWith('/v2/bookings') && method === 'POST') {
      await sleep(600); // slow vendor: widens the race window
      if (log.calFail) return ok({ status: 'error', error: 'upstream down' }, 502);
      log.bookings++;
      return ok({ status: 'success', data: { uid: `conc-${Date.now()}-${log.bookings}`, id: 1, status: 'accepted', start: body.start, eventTypeId: body.eventTypeId } }, 201);
    }
  }
  if (u.includes('api.hubapi.com')) {
    await sleep(700); // slow vendor: widens the race window
    if (u.includes('/search')) return ok({ results: [] });
    if (u.endsWith('/crm/v3/objects/contacts') && method === 'POST') { log.contactPosts++; return ok({ id: `c-${log.contactPosts}` }, 201); }
    if (u.endsWith('/crm/v3/objects/deals') && method === 'POST') { log.dealPosts++; return ok({ id: `d-${log.dealPosts}` }, 201); }
    return ok({ id: 'ok' });
  }
  if (u.includes('api.resend.com')) {
    log.emails.push(body);
    if (log.resendDown) return ok({ error: 'down' }, 500);
    return ok({ id: 'stub' });
  }
  return realFetch(url, init);
};

const store = await import('../src/db.js');
const { drain } = await import('../src/worker.js');
const startedTest = new Date();
let bad = 0;
const check = (n, pass, d = '') => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${d ? ' | ' + d : ''}`); if (!pass) bad++; };
const q = (t, p) => store.db().query(t, p);
const callIds = [];

const transcript = 'AGENT: Good morning, Aangan Studio.\nUSER: Hi, I am Priya. We have a 3BHK in Kothrud, about 1,400 square feet, and want the whole flat redone by March. I am the owner. We are free on weekday evenings after seven or any weekend.';
async function newQualifiedCall(tag) {
  const c = await store.upsertCall({ externalCallId: `conc-${tag}-${Date.now()}`, callerPhone: '+919999900008', startedAt: new Date(), answeredAt: new Date() });
  callIds.push(c.id);
  await q("UPDATE calls SET route='QUALIFY', transcript=$2, decision=$3, handoff_note='Test note', finalized_at=now() WHERE id=$1", [c.id, transcript, { extracted: { name: 'Priya', area: 'Kothrud' } }]);
  return c.id;
}
const dueNow = () => q("UPDATE outbox SET run_after = now() WHERE done_at IS NULL AND dead_at IS NULL AND created_at >= $1", [startedTest]);

try {
  // 1 + 2: parallel drains, duplicate jobs
  const id1 = await newQualifiedCall('race');
  await store.enqueue('hubspot_sync', { callId: id1 });
  await store.enqueue('hubspot_sync', { callId: id1 });
  await store.enqueue('schedule', { callId: id1 });
  await store.enqueue('schedule', { callId: id1 });
  await Promise.all([drain(), drain(), drain()]);
  for (let i = 0; i < 4; i++) { await dueNow(); await Promise.all([drain(), drain()]); }

  const row = (await q('SELECT * FROM calls WHERE id=$1', [id1])).rows[0];
  const bookings = (await q('SELECT * FROM bookings WHERE call_id=$1', [id1])).rows;
  check('two hubspot_sync jobs run in parallel create exactly one HubSpot deal', log.dealPosts === 1, `deal POSTs=${log.dealPosts}`);
  check('and exactly one HubSpot contact', log.contactPosts === 1, `contact POSTs=${log.contactPosts}`);
  check('the single deal id is saved on the call', row.hubspot_deal_id === 'd-1', row.hubspot_deal_id);
  check('two schedule jobs for one call make exactly one Cal.com booking', log.bookings === 1 && bookings.length === 1, `Cal.com bookings=${log.bookings}, rows=${bookings.length}`);
  check('the booking row is complete, not left pending', Boolean(bookings[0]?.calcom_uid) && bookings[0].status === 'accepted', bookings[0] && `status=${bookings[0].status}`);

  // 3: Cal.com failure releases the reservation
  const id2 = await newQualifiedCall('fail');
  log.calFail = true;
  await store.enqueue('schedule', { callId: id2 });
  await drain();
  const afterFail = (await q('SELECT * FROM bookings WHERE call_id=$1', [id2])).rows;
  const failedJob = (await q("SELECT attempts, last_error, run_after > now() AS backed_off FROM outbox WHERE kind='schedule' AND payload->>'callId'=$1", [String(id2)])).rows[0];
  check('a Cal.com failure leaves no half-made booking behind', afterFail.length === 0, `rows=${afterFail.length}`);
  check('the failed job is kept for retry with a backoff', failedJob?.attempts === 1 && failedJob.backed_off === true && /Cal\.com/.test(failedJob.last_error ?? ''), JSON.stringify(failedJob));
  log.calFail = false;
  await dueNow(); await drain(); await dueNow(); await drain();
  const afterRetry = (await q('SELECT * FROM bookings WHERE call_id=$1', [id2])).rows;
  check('once Cal.com is back the retry books exactly once', afterRetry.length === 1 && Boolean(afterRetry[0].calcom_uid), `rows=${afterRetry.length}`);

  // 4: dead-lettering
  const id3 = await newQualifiedCall('dead');
  log.resendDown = true;
  await store.enqueue('email_task', { text: `dead-letter probe for call ${id3} +919999900008` });
  const alertsBefore = log.emails.length;
  const runAts = [];
  for (let i = 0; i < 8; i++) {
    await drain();
    const j = (await q("SELECT attempts, dead_at, run_after FROM outbox WHERE kind='email_task' AND payload->>'text' LIKE $1", [`%call ${id3} %`])).rows[0];
    runAts.push(j);
    if (j.dead_at) break;
    await q("UPDATE outbox SET run_after = now() WHERE kind='email_task' AND payload->>'text' LIKE $1 AND dead_at IS NULL", [`%call ${id3} %`]);
  }
  const last = runAts[runAts.length - 1];
  check('a job that keeps failing is marked dead on the 6th attempt', last.attempts === 6 && Boolean(last.dead_at), `attempts=${last.attempts}`);
  const stats = await store.outboxStats();
  check('the dead job shows up in the health counts', stats.dead >= 1, JSON.stringify(stats));
  check('an alert email was attempted when the job died', log.emails.length > alertsBefore && log.emails.some((e) => /failed 6 times/.test(e.text ?? '')));
  await drain();
  const still = (await q("SELECT attempts FROM outbox WHERE kind='email_task' AND payload->>'text' LIKE $1", [`%call ${id3} %`])).rows[0];
  check('a dead job is never claimed again', still.attempts === 6, `attempts=${still.attempts}`);
} catch (e) {
  bad++; console.log('ERROR', e.stack);
} finally {
  await q("DELETE FROM outbox WHERE created_at >= $1 AND (payload->>'callId' = ANY($2) OR payload->>'text' LIKE '%+919999900008%' OR payload->>'bookingId' IN (SELECT id::text FROM bookings WHERE call_id = ANY($3)))", [startedTest, callIds.map(String), callIds]);
  await cleanupTestRows(store, { startedTest, callIds, phones: ['+919999900008'] });
  console.log('test rows removed from Neon');
  await store.db().end();
  console.log(bad ? `\n${bad} check(s) FAILED` : '\nAll checks passed');
  process.exit(bad ? 1 : 0);
}
