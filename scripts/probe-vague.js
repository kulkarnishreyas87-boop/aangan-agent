// Replays a vague caller against the deployed server: the agent must decline once, not repeat itself, and the call must be
// finalised as soon as the link closes. Deletes its own rows. Usage: node --env-file=.env scripts/probe-vague.js [url]
import { WebSocket } from 'ws';
import pg from 'pg';
const base = (process.argv[2] ?? 'https://aangan-agent-one.vercel.app').replace(/\/$/, '');
const callId = 'vague-probe-' + Date.now();
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/vaani/llm/${callId}`, { headers: { Authorization: `Bearer ${process.env.VAANI_BYOL_TOKEN}` } });
const lines = ["No, I don't need any help.", 'Okay.', "This doesn't make any sense.", 'Yeah, I know.'];
const transcript = []; let turn = 0; const replies = [];
const next = () => { if (turn >= lines.length) { ws.close(); return; } transcript.push({ role: 'user', content: lines[turn] }); turn++; ws.send(JSON.stringify({ interaction_type: 'response_required', response_id: turn, call_id: callId, transcript })); };
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.interaction_type === 'greeting') return setTimeout(next, 300);
  if (m.response_type !== 'response') return;
  console.log(`caller: ${lines[turn - 1]}\nagent : ${m.content}  [end_call=${m.end_call}]`);
  replies.push(m.content); transcript.push({ role: 'agent', content: m.content }); next();
});
ws.on('close', async () => {
  await new Promise((r) => setTimeout(r, 12000)); // finalisation runs after the socket closes
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const r = await c.query('SELECT id, route, reason_codes, finalized_at, duration_s FROM calls WHERE external_call_id=$1', [callId]);
  console.log('row:', JSON.stringify(r.rows[0]));
  for (const x of r.rows) { for (const t of ['costs', 'sync_log', 'handoffs', 'bookings']) await c.query(`DELETE FROM ${t} WHERE call_id=$1`, [x.id]); await c.query("DELETE FROM outbox WHERE payload::text LIKE $1", ['%"' + x.id + '"%']); await c.query('DELETE FROM calls WHERE id=$1', [x.id]); }
  await c.end();
});
