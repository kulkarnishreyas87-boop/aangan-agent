// Stand-in Vaani. Starts our real server, then behaves the way Vaani's docs say it does: opens the BYOL WebSocket,
// sends response_required turns, posts webhooks (call_started, call_postprocessing) and answers our trigger-call.
// Real: Gemini and Neon. Fake: Cal.com, HubSpot, Resend and the Vaani outbound API.
// It proves OUR side follows the documented contract. It cannot prove Vaani's real servers behave exactly as documented.
// Usage: node --env-file=.env scripts/simulate-vaani.js
import { WebSocket } from 'ws';
import { cleanupTestRows } from './_cleanup.js';

Object.assign(process.env, {
  CALCOM_API_KEY: 'cal_mock', CALCOM_EVENT_TYPE_ID_SITE_VISIT: '111', CALCOM_EVENT_TYPE_ID_PHONE: '222',
  CALCOM_SLOTS_API_VERSION: '2024-09-04', CALCOM_BOOKINGS_API_VERSION: '2026-02-25',
  HUBSPOT_ACCESS_TOKEN: 'pat_mock', HUBSPOT_DEAL_TO_CONTACT_ASSOC_ID: '3',
  HUBSPOT_STAGE_QUALIFIED: 's_q', HUBSPOT_STAGE_BOOKED: 's_b', HUBSPOT_STAGE_WON: 's_w', HUBSPOT_STAGE_LOST: 's_l', HUBSPOT_STAGE_DECLINED: 's_d', HUBSPOT_STAGE_OTHER: 's_o',
  HUBSPOT_PIPELINE_ID: 'p1', PUBLIC_BASE_URL: 'https://example.test',
  VAANI_API_KEY: 'vaani_test_key', VAANI_CONFIRM_AGENT_ID: 'agent-confirm-test'
});

const seen = [];
const realFetch = globalThis.fetch;
const ok = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (u.includes('api.vaanivoice.ai')) {
    seen.push({ vendor: 'vaani', path: new URL(u).pathname, headers: init.headers, body });
    return ok({ success: true, message: 'Call initiated successfully', output: { agent_name: 'x', call_id: 'outbound-sim-1' }, error: null });
  }
  if (u.includes('api.cal.com')) {
    if (u.includes('/v2/slots')) {
      const data = {};
      for (let d = 2; d <= 6; d++) { const k = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10); data[k] = [{ start: `${k}T05:00:00.000Z` }, { start: `${k}T13:30:00.000Z` }, { start: `${k}T14:30:00.000Z` }]; } // 10:30, 19:00 and 20:00 India time
      return ok({ status: 'success', data });
    }
    seen.push({ vendor: 'calcom', body });
    return ok({ status: 'success', data: { uid: `sim-${Date.now()}`, id: 1, status: 'accepted', start: body.start, eventTypeId: body.eventTypeId } }, 201);
  }
  if (u.includes('api.hubapi.com')) {
    if (u.includes('/search')) return ok({ results: [] });
    if (u.endsWith('/contacts')) return ok({ id: 'c1' }, 201);
    if (u.endsWith('/deals')) return ok({ id: 'd1' }, 201);
    return ok({ id: 'ok' });
  }
  if (u.includes('api.resend.com')) { seen.push({ vendor: 'resend', body }); return ok({ id: 'stub' }); }
  return realFetch(url, init);
};

const store = await import('../src/db.js');
const { createServer } = await import('../src/http-server.js');
const server = createServer();
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const startedTest = new Date();

let bad = 0;
const check = (n, pass, d = '') => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${d ? ' | ' + d : ''}`); if (!pass) bad++; };
const ids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => realFetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const hook = (body) => post(`/vaani/webhook/${process.env.VAANI_WEBHOOK_SECRET}`, body).then(async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) }));

function connect(callId, token = process.env.VAANI_BYOL_TOKEN) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vaani/llm/${callId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}
async function turn({ ws, frames }, callId, responseId, messages) {
  const t0 = Date.now();
  ws.send(JSON.stringify({ interaction_type: 'response_required', response_id: responseId, call_id: callId, transcript: [{ role: 'system', content: 'unused: our server uses its own prompt' }, ...messages], req_body: null }));
  for (let i = 0; i < 400; i++) {
    const f = frames.find((x) => x.response_type === 'response' && x.response_id === responseId);
    if (f) return { ...f, ms: Date.now() - t0 };
    await sleep(100);
  }
  throw new Error(`no reply to turn ${responseId}`);
}
const priced = (t) => /₹|\blakh|\bper\s*sq|\brs\.?\s?\d|\d+\s*(k|lakh|crore)\b/i.test(t);

try {
  // 1. Auth
  let rejected = false;
  try { await connect('x-bad', 'wrong-token'); } catch { rejected = true; }
  check('WebSocket with a wrong token is rejected', rejected);
  const wrongHook = await post('/vaani/webhook/not-the-secret', { event: 'call_started', room_name: 'z' });
  check('webhook with a wrong secret path is rejected', wrongHook.status === 404, `HTTP ${wrongHook.status}`);

  // 2. Price question must never be answered with a number
  const idP = `sim-price-${Date.now()}`; ids.push(idP);
  const P = await connect(idP);
  check('handshake frames arrive first: config then greeting', P.frames[0]?.interaction_type === 'config' && P.frames[1]?.interaction_type === 'greeting' || await sleep(300).then(() => P.frames[0]?.interaction_type === 'config' && P.frames[1]?.interaction_type === 'greeting'));
  const rp = await turn(P, idP, 1, [{ role: 'assistant', content: 'Good morning, Aangan Studio, how can I help?' }, { role: 'user', content: 'Hi, how much per square foot do you charge for a 2BHK in Wakad? Just give me a rough range.' }]);
  console.log(`      agent: "${rp.content}" (${rp.ms} ms)`);
  check('price question: reply exists, has no price, call stays open', Boolean(rp.content) && !priced(rp.content) && rp.end_call === false);
  P.ws.close();

  // 3. Out of area is declined and the call ends
  const idN = `sim-nashik-${Date.now()}`; ids.push(idN);
  const N = await connect(idN);
  const rn = await turn(N, idN, 1, [{ role: 'assistant', content: 'Good morning, Aangan Studio.' }, { role: 'user', content: 'Hello, I am in Nashik and want to redo my home office and study. Can you take it up?' }]);
  console.log(`      agent: "${rn.content}" (${rn.ms} ms)`);
  check('Nashik: polite decline and the call is ended', rn.end_call === true && Boolean(rn.content) && !priced(rn.content));
  N.ws.close();

  // 4. A qualified call, end to end
  const idQ = `sim-qualify-${Date.now()}`; ids.push(idQ);
  const phone = '+919999900006';
  const started = await hook({ event: 'call_started', room_name: idQ, status: 'dialing', phone_number: phone });
  check('call_started webhook accepted', started.s === 200 && started.j.ok === 'call_started');
  const Q = await connect(idQ);
  const convo = [{ role: 'assistant', content: 'Good morning, Aangan Studio, how can I help?' }];
  const say = async (n, userText) => {
    convo.push({ role: 'user', content: userText });
    const r = await turn(Q, idQ, n, convo);
    console.log(`      caller: "${userText}"\n      agent : "${r.content}" end_call=${r.end_call} (${r.ms} ms)`);
    convo.push({ role: 'assistant', content: r.content });
    return r;
  };
  const q1 = await say(1, "Hi, I'm Priya. A friend, Shruti Joshi, gave me your number. We have a 3BHK in Kothrud and want to redo the whole flat: kitchen, living room and both bedrooms.");
  check('turn 1: agent asks something and keeps the call open', Boolean(q1.content) && q1.end_call === false);
  const q2 = await say(2, "About 1,400 square feet carpet. We would like it done by March, no rush. I'm the owner, and my husband knows we're calling and agrees.");
  check('turn 2: qualified caller is asked when they are free, call stays open', q2.end_call === false && /\b(free|available|suit|convenient|time|day)/i.test(q2.content));
  const q3 = await say(3, 'Weekday evenings after six, or any weekend, works best for us. Both of us will be there.');
  check('turn 3: agent wraps up and ends the call', q3.end_call === true);
  check('no price was ever spoken on the qualified call', !convo.some((m) => m.role === 'assistant' && priced(m.content)));
  Q.ws.close();

  const transcriptText = convo.map((m) => `${m.role === 'user' ? 'USER' : 'AGENT'}: ${m.content}`).join('\n');
  const fin = await hook({ event: 'call_postprocessing', call_id: idQ, timestamp: new Date().toISOString(), data: { room_name: idQ, call_id: idQ, call_duration: 252000, transcript: transcriptText } });
  check('call_postprocessing finalises the call as QUALIFY', fin.j.ok === 'finalized' && fin.j.route === 'QUALIFY', JSON.stringify(fin.j));
  const dup = await hook({ event: 'call_postprocessing', call_id: idQ, timestamp: new Date().toISOString(), data: { room_name: idQ, call_id: idQ, call_duration: 252000, transcript: transcriptText } });
  check('a duplicate webhook is ignored (no second booking)', dup.j.duplicate === true, JSON.stringify(dup.j));

  // Wait for the outbox worker to do the real work: a booking row, then the confirmation call.
  const qCall = (await store.db().query('SELECT id FROM calls WHERE external_call_id=$1', [idQ])).rows[0];
  for (let i = 0; i < 180; i++) {
    const have = (await store.db().query('SELECT c.vaani_call_id FROM confirm_calls c JOIN bookings b ON b.id=c.booking_id WHERE b.call_id=$1', [qCall.id])).rows[0];
    if (have?.vaani_call_id) break;
    await sleep(500);
  }
  console.log('      outbox:', JSON.stringify((await store.db().query('SELECT kind, attempts, done_at IS NOT NULL AS done, last_error FROM outbox WHERE created_at >= $1 ORDER BY id', [startedTest])).rows));
  const failedJobs = (await store.db().query('SELECT kind, attempts, last_error FROM outbox WHERE created_at >= $1 AND last_error IS NOT NULL', [startedTest])).rows;
  for (const j of failedJobs) console.log(`      outbox job ${j.kind} failed: ${j.last_error}`);
  for (const m of seen.filter((x) => x.vendor === 'resend' && /auto-schedule/i.test(x.body.text))) console.log(`      scheduler could not book: ${m.body.text}`);
  const call = (await store.db().query('SELECT * FROM calls WHERE external_call_id=$1', [idQ])).rows[0];
  check('caller number from call_started is stored on the call', call?.caller_phone === phone, call?.caller_phone);
  check('duration converted from milliseconds to seconds', call?.duration_s === 252, String(call?.duration_s));
  const booking = (await store.db().query('SELECT * FROM bookings WHERE call_id=$1', [call.id])).rows[0];
  check('consultation booked after the call', Boolean(booking?.calcom_uid), booking && booking.visit_type);
  const trig = seen.find((s) => s.vendor === 'vaani');
  check('Vaani trigger-call sent with API key header, confirmation agent and the customer number', trig?.path === '/api/trigger-call/' && trig.headers?.['X-API-Key'] === 'vaani_test_key' && trig.body.agent_id === 'agent-confirm-test' && trig.body.contact_number === phone && trig.body.medium === 'telephony', JSON.stringify(trig?.body));
  check('trigger-call carries the template variables', Boolean(trig?.body?.metadata?.consultation_time) && Boolean(trig.body.metadata.customer_name) && ['site visit', 'phone call'].includes(trig.body.metadata.visit_type), JSON.stringify(trig?.body?.metadata));
  const placed = (await store.db().query('SELECT vaani_call_id FROM confirm_calls WHERE booking_id=$1', [booking.id])).rows.map((r) => r.vaani_call_id);
  check('confirmation call id is recorded for the booking', placed.includes('outbound-sim-1'), JSON.stringify(placed));

  // 5. The confirmation call's own webhooks
  const cs = await hook({ event: 'call_started', room_name: 'outbound-sim-1', status: 'dialing', phone_number: phone });
  check('call_started for our confirmation call is not treated as a new enquiry', Boolean(cs.j.ignored));
  const cp = await hook({ event: 'call_postprocessing', call_id: 'outbound-sim-1', timestamp: new Date().toISOString(), data: { room_name: 'outbound-sim-1', call_duration: 20000, transcript: 'AGENT: Hello Priya, this is Aangan Studio confirming your consultation. Does that time work?\nUSER: Yes, that works for us, thank you.' } });
  check('confirmation transcript is read as confirmed', cp.j.outcome === 'confirmed', JSON.stringify(cp.j));
  const after = (await store.db().query('SELECT confirmed_at FROM bookings WHERE id=$1', [booking.id])).rows[0];
  check('booking marked confirmed in Neon', Boolean(after.confirmed_at));
} catch (e) {
  bad++; console.log('ERROR', e.stack);
} finally {
  const q = (t, p) => store.db().query(t, p);
  const calls = (await q('SELECT id FROM calls WHERE external_call_id = ANY($1) OR external_call_id = $2', [ids, 'outbound-sim-1'])).rows.map((r) => r.id);
  await cleanupTestRows(store, { startedTest, callIds: calls, phones: ['+919999900006'] });
  console.log('test rows removed from Neon');
  server.close(); await store.db().end();
  console.log(bad ? `\n${bad} check(s) FAILED` : '\nAll checks passed');
  process.exit(bad ? 1 : 0);
}
