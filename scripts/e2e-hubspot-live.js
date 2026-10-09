// Live HubSpot check using our own hubspot.js: contact upsert (create, then find by phone), deal create + association,
// stage change, read back, then delete both. Uses the default pipeline unless HUBSPOT_PIPELINE_ID is set.
// Usage: node --env-file=.env scripts/e2e-hubspot-live.js  (set HUBSPOT_STAGE_* and HUBSPOT_DEAL_TO_CONTACT_ASSOC_ID first)
import * as hubspot from '../src/hubspot.js';
import { need } from '../src/config.js';

const H = { Authorization: `Bearer ${need('HUBSPOT_ACCESS_TOKEN')}`, 'content-type': 'application/json' };
const api = async (path, method = 'GET') => { const r = await fetch(`https://api.hubapi.com${path}`, { method, headers: H }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
let bad = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' | ' + d : ''}`); if (!ok) bad++; };
let contactId, dealId;
try {
  const phone = '+919999900003';
  contactId = await hubspot.upsertContact({ phone, name: 'TEST Aangan (safe to delete)' });
  check('contact created', Boolean(contactId), `id=${contactId}`);
  await new Promise((r) => setTimeout(r, 12000)); // HubSpot search lags 3 to 8 seconds behind creation
  const again = await hubspot.upsertContact({ phone, name: 'TEST Aangan (safe to delete)' });
  check('second upsert finds the same contact by phone (no duplicate)', again === contactId, `id=${again}`);

  dealId = await hubspot.upsertDeal({ contactId, name: 'TEST Aangan phone enquiry', stage: hubspot.stageId('QUALIFIED'), properties: JSON.parse(process.env.TEST_DEAL_PROPS ?? '{}') });
  check('deal created', Boolean(dealId), `id=${dealId}`);
  await hubspot.upsertDeal({ dealId, contactId, name: 'TEST Aangan phone enquiry', stage: hubspot.stageId('BOOKED'), properties: {} });
  const d = await api(`/crm/v3/objects/deals/${dealId}?properties=dealstage,dealname`);
  check('stage changed to the booked stage', d.j.properties?.dealstage === hubspot.stageId('BOOKED'), `dealstage=${d.j.properties?.dealstage}`);
  const assoc = await api(`/crm/v4/objects/deals/${dealId}/associations/contacts`);
  check('deal is associated with the contact', assoc.j.results?.some((a) => String(a.toObjectId) === String(contactId)), `association type ${need('HUBSPOT_DEAL_TO_CONTACT_ASSOC_ID')} -> ${JSON.stringify(assoc.j.results?.map((a) => a.toObjectId))}`);
} catch (e) { bad++; console.log('ERROR', e.message); }
finally {
  if (dealId) console.log('delete deal:', (await api(`/crm/v3/objects/deals/${dealId}`, 'DELETE')).s);
  if (contactId) console.log('delete contact:', (await api(`/crm/v3/objects/contacts/${contactId}`, 'DELETE')).s);
  console.log(bad ? `${bad} check(s) FAILED` : 'All checks passed');
  process.exitCode = bad ? 1 : 0;
}
