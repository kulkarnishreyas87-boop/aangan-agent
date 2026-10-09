// One-time HubSpot setup, safe to run again: creates the six aangan_* deal properties and a dedicated deal pipeline,
// then prints the stage ids to put in .env. Needs a token with deal schema write (and pipeline write for the pipeline).
// Usage: node --env-file=.env scripts/hubspot-setup.js
import { need } from '../src/config.js';

const H = { Authorization: `Bearer ${need('HUBSPOT_ACCESS_TOKEN')}`, 'content-type': 'application/json' };
async function hs(path, method = 'GET', body) {
  const r = await fetch(`https://api.hubapi.com${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

const PROPS = [
  { name: 'aangan_route', label: 'Aangan route', type: 'enumeration', fieldType: 'select',
    options: ['QUALIFY', 'CLARIFY', 'DECLINE', 'ESCALATE', 'LOG_ONLY'].map((v, i) => ({ label: v, value: v, displayOrder: i, hidden: false })) },
  { name: 'aangan_reason_codes', label: 'Aangan decline reasons', type: 'string', fieldType: 'text' },
  { name: 'aangan_answer_seconds', label: 'Aangan answer time (seconds)', type: 'number', fieldType: 'number' },
  { name: 'aangan_call_cost_inr', label: 'Aangan call cost (INR)', type: 'number', fieldType: 'number' },
  { name: 'aangan_booking_start', label: 'Aangan consultation time', type: 'datetime', fieldType: 'date' },
  { name: 'aangan_handoff_note', label: 'Aangan handoff note', type: 'string', fieldType: 'textarea' }
];

const existing = await hs('/crm/v3/properties/deals');
if (existing.status !== 200) { console.log('Cannot read deal properties:', existing.status, existing.j.message); process.exit(1); }
const have = new Set(existing.j.results.map((p) => p.name));
for (const p of PROPS) {
  if (have.has(p.name)) { console.log(`property ${p.name}: already exists`); continue; }
  const r = await hs('/crm/v3/properties/deals', 'POST', { groupName: 'dealinformation', ...p });
  console.log(`property ${p.name}: ${r.status === 201 ? 'created' : `FAILED ${r.status} ${JSON.stringify(r.j).slice(0, 250)}`}`);
}

const LABEL = 'Aangan phone enquiries';
const pipes = await hs('/crm/v3/pipelines/deals');
let pipe = pipes.j.results?.find((p) => p.label === LABEL);
if (!pipe) {
  const stages = [
    ['Qualified', 0.1, false], ['Consultation booked', 0.3, false], ['Won', 1, true], ['Lost', 0, true], ['Declined', 0, true], ['Other', 0, true]
  ].map(([label, prob, closed], i) => ({
    label, displayOrder: i,
    metadata: closed ? { isClosed: 'true', probability: String(prob) } : { isClosed: 'false', probability: String(prob) }
  }));
  const r = await hs('/crm/v3/pipelines/deals', 'POST', { label: LABEL, displayOrder: 10, stages });
  if (r.status !== 201) { console.log(`pipeline: FAILED ${r.status} ${JSON.stringify(r.j).slice(0, 400)}`); process.exit(2); }
  pipe = r.j;
  console.log('pipeline: created');
} else console.log('pipeline: already exists');

const idOf = (label) => pipe.stages.find((s) => s.label === label)?.id;
console.log('\nPut these in .env:');
console.log(`HUBSPOT_PIPELINE_ID=${pipe.id}`);
for (const [k, l] of [['QUALIFIED', 'Qualified'], ['BOOKED', 'Consultation booked'], ['WON', 'Won'], ['LOST', 'Lost'], ['DECLINED', 'Declined'], ['OTHER', 'Other']]) {
  console.log(`HUBSPOT_STAGE_${k}=${idOf(l)}`);
}
