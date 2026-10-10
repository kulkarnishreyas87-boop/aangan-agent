// Times each conversation turn against the deployed server, the way Vaani drives it. Leaves one test call row, which it deletes.
// Usage: node --env-file=.env scripts/latency-probe.js https://your-app.vercel.app
import { WebSocket } from 'ws';
import pg from 'pg';
const base = (process.argv[2] ?? 'https://aangan-agent-one.vercel.app').replace(/\/$/, '');
const callId = 'latency-probe-' + Date.now();
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/vaani/llm/${callId}`, { headers: { Authorization: `Bearer ${process.env.VAANI_BYOL_TOKEN}` } });
const lines = ['Hello, I want to redo my two BHK.', 'It is near Kothrud.', 'We want it finished by March.', 'My wife and I decide together.'];
const transcript = [];
let sentAt = 0, turn = 0;
const times = [];
const next = () => {
  if (turn >= lines.length) { ws.close(); return; }
  transcript.push({ role: 'user', content: lines[turn] });
  turn++; sentAt = performance.now();
  ws.send(JSON.stringify({ interaction_type: 'response_required', response_id: turn, call_id: callId, transcript }));
};
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.interaction_type === 'greeting') return setTimeout(next, 300);
  if (m.response_type !== 'response') return;
  const ms = Math.round(performance.now() - sentAt); times.push(ms);
  console.log(`turn ${turn}: ${ms} ms  "${m.content.slice(0, 70)}"`);
  transcript.push({ role: 'agent', content: m.content });
  next();
});
ws.on('error', (e) => console.log('socket error', e.message));
ws.on('close', async () => {
  console.log('average', Math.round(times.reduce((a, b) => a + b, 0) / (times.length || 1)), 'ms');
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const r = await c.query('SELECT id FROM calls WHERE external_call_id=$1', [callId]);
  for (const x of r.rows) { for (const t of ['costs', 'sync_log', 'handoffs', 'bookings']) await c.query(`DELETE FROM ${t} WHERE call_id=$1`, [x.id]); await c.query('DELETE FROM calls WHERE id=$1', [x.id]); }
  await c.end();
});
