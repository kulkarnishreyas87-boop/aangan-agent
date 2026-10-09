// Smoke test of a DEPLOYED server (for example on Vercel) with REAL services behind it: Gemini, Neon, Cal.com, HubSpot, Resend.
// A stand-in Vaani on this machine opens the BYOL WebSocket and posts webhooks to the public URL, runs a qualified call,
// then checks the booking in Cal.com and the deal in HubSpot, and finally cancels the booking and deletes the deal, contact and rows.
// It sends real emails to the configured designer, escalation and front-desk addresses (marked as test leads).
// Usage: node --env-file=.env scripts/remote-smoke.js https://your-host
import { WebSocket } from 'ws';
import { need } from '../src/config.js';
import { cleanupTestRows } from './_cleanup.js';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) { console.log('Usage: node --env-file=.env scripts/remote-smoke.js https://your-host'); process.exit(2); }
const wsBase = base.replace(/^http/, 'ws');
const store = await import('../src/db.js');

const startedTest = new Date();
const phone = '+919999900009';
const callId = `remote-smoke-${Date.now()}`;
let bad = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' | ' + d : ''}`); if (!ok) bad++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hsH = { Authorization: `Bearer ${need('HUBSPOT_ACCESS_TOKEN')}`, 'content-type': 'application/json' };
const hs = async (p, m = 'GET') => { const r = await fetch(`https://api.hubapi.com${p}`, { method: m, headers: hsH }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const calH = { Authorization: `Bearer ${need('CALCOM_API_KEY')}`, 'cal-api-version': need('CALCOM_BOOKINGS_API_VERSION'), 'content-type': 'application/json' };
const hook = async (body) => { const r = await fetch(`${base}/vaani/webhook/${need('VAANI_WEBHOOK_SECRET')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };

function connect() {
  return new Promise((resolve, reject) => {
    const frames = [];
    const ws = new WebSocket(`${wsBase}/vaani/llm/${callId}`, { headers: { Authorization: `Bearer ${need('VAANI_BYOL_TOKEN')}` } });
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
    ws.on('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}
async function turn({ ws, frames }, id, messages) {
  const t0 = Date.now();
  ws.send(JSON.stringify({ interaction_type: 'response_required', response_id: id, call_id: callId, transcript: [{ role: 'system', content: 'unused' }, ...messages], req_body: null }));
  for (let i = 0; i < 600; i++) {
    const f = frames.find((x) => x.response_type === 'response' && x.response_id === id);
    if (f) return { ...f, ms: Date.now() - t0 };
    await sleep(100);
  }
  throw new Error(`no reply to turn ${id}`);
}

let booking, contactId, dealId, callRowId;
try {
  const health = await fetch(`${base}/health`).then((r) => r.json());
  check('deployed /health is ok and reaches the database', health.ok === true && health.db === true, JSON.stringify(health));

  const started = await hook({ event: 'call_started', room_name: callId, status: 'dialing', phone_number: phone });
  check('call_started webhook accepted by the deployed server', started.s === 200 && started.j.ok === 'call_started', JSON.stringify(started.j));

  const C = await connect();
  await sleep(500);
  check('WebSocket handshake over the public URL: config then greeting', C.frames[0]?.interaction_type === 'config' && C.frames[1]?.interaction_type === 'greeting');
  const convo = [{ role: 'assistant', content: 'Good morning, Aangan Studio, how can I help?' }];
  const say = async (n, text) => {
    convo.push({ role: 'user', content: text });
    const r = await turn(C, n, convo);
    console.log(`      caller: "${text.slice(0, 90)}${text.length > 90 ? '…' : ''}"\n      agent : "${r.content}" end_call=${r.end_call} (${r.ms} ms)`);
    convo.push({ role: 'assistant', content: r.content });
    return r;
  };
  const t1 = await say(1, "Hi, I'm Test Caller. A friend gave me your number. We have a 3BHK in Kothrud and want to redo the whole flat: kitchen, living room and both bedrooms. How much per square foot do you charge?");
  check('turn 1: reply, call open, no price spoken', Boolean(t1.content) && t1.end_call === false && !/₹|\blakh|per\s*sq/i.test(t1.content));
  await say(2, "About 1,400 square feet carpet. We'd like it done by March. I'm the owner and my husband agrees.");
  const t3 = await say(3, 'Weekday mornings work best for us, around ten or eleven.');
  check('turn 3: call wrapped up and ended', t3.end_call === true);
  C.ws.close();

  const transcript = convo.map((m) => `${m.role === 'user' ? 'USER' : 'AGENT'}: ${m.content}`).join('\n');
  const fin = await hook({ event: 'call_postprocessing', call_id: callId, timestamp: new Date().toISOString(), data: { room_name: callId, call_id: callId, call_duration: 180000, transcript } });
  check('call_postprocessing finalised the call as QUALIFY on the deployed server', fin.j.ok === 'finalized' && fin.j.route === 'QUALIFY', JSON.stringify(fin.j));

  // The background jobs (email, HubSpot, Cal.com, confirmation) run on the deployed server after the response.
  let row;
  for (let i = 0; i < 240; i++) {
    row = (await store.db().query('SELECT * FROM calls WHERE external_call_id=$1', [callId])).rows[0];
    booking = row && (await store.db().query('SELECT * FROM bookings WHERE call_id=$1', [row.id])).rows[0];
    if (booking?.calcom_uid && row.hubspot_deal_id) break;
    await sleep(1000);
  }
  callRowId = row?.id;
  contactId = row?.hubspot_contact_id; dealId = row?.hubspot_deal_id;
  check('caller number from call_started reached the call record', row?.caller_phone === phone, row?.caller_phone);
  check('background work ran on the deployed server: booking created', Boolean(booking?.calcom_uid), booking && `${booking.visit_type} ${booking.start_at?.toISOString()}`);

  const cb = booking?.calcom_uid && await fetch(`https://api.cal.com/v2/bookings/${booking.calcom_uid}`, { headers: calH }).then(async (r) => ({ s: r.status, j: await r.json() }));
  check('the booking exists in Cal.com and is accepted', cb?.s === 200 && cb.j.data?.status === 'accepted', cb && `status=${cb.j.data?.status}`);
  await sleep(4000);
  const d = dealId && await hs(`/crm/v3/objects/deals/${dealId}?properties=dealstage,pipeline,aangan_route`);
  check('HubSpot deal exists in the Aangan pipeline with the route stored', d?.j.properties?.pipeline === need('HUBSPOT_PIPELINE_ID') && d.j.properties.aangan_route === 'QUALIFY', d && `stage=${d.j.properties?.dealstage}`);
  const jobs = (await store.db().query("SELECT kind, attempts, done_at IS NOT NULL AS done, last_error FROM outbox WHERE created_at >= $1 ORDER BY id", [startedTest])).rows;
  console.log('      outbox:', JSON.stringify(jobs.map((j) => `${j.kind}:${j.done ? 'done' : 'pending'}${j.last_error ? '!' + j.last_error.slice(0, 60) : ''}`)));
  check('no job failed on the deployed server', jobs.every((j) => !j.last_error), jobs.filter((j) => j.last_error).map((j) => j.kind).join(','));
} catch (e) {
  bad++; console.log('ERROR', e.stack);
} finally {
  if (booking?.calcom_uid) console.log('cancel Cal.com booking:', (await fetch(`https://api.cal.com/v2/bookings/${booking.calcom_uid}/cancel`, { method: 'POST', headers: calH, body: JSON.stringify({ cancellationReason: 'Automated deployment smoke test' }) })).status);
  if (dealId) console.log('delete HubSpot deal:', (await hs(`/crm/v3/objects/deals/${dealId}`, 'DELETE')).s);
  if (contactId) console.log('delete HubSpot contact:', (await hs(`/crm/v3/objects/contacts/${contactId}`, 'DELETE')).s);
  await sleep(3000); // let any in-flight background job on the server finish before the rows disappear
  const ids = callRowId ? [callRowId] : (await store.db().query('SELECT id FROM calls WHERE external_call_id=$1', [callId])).rows.map((r) => r.id);
  await cleanupTestRows(store, { startedTest, callIds: ids, phones: [phone] });
  console.log('test rows removed from Neon');
  await store.db().end();
  console.log(bad ? `\n${bad} check(s) FAILED` : '\nAll checks passed');
  process.exit(bad ? 1 : 0);
}
