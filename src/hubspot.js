// HubSpot CRM v3 (private app token). Contacts and deals. The dashboard itself is built in the HubSpot UI.
// Custom properties used below must exist in HubSpot first (see README): aangan_route, aangan_reason_codes,
// aangan_answer_seconds, aangan_call_cost_inr, aangan_booking_start, aangan_handoff_note.
import { need, opt } from './config.js';

async function hs(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${need('HUBSPOT_ACCESS_TOKEN')}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HubSpot ${method} ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function findContactByPhone(phone) {
  const r = await hs('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: { filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }], limit: 1 }
  });
  return r.results?.[0]?.id ?? null;
}

export async function upsertContact({ phone, name }) {
  const props = { phone };
  if (name) props.firstname = name;
  const existing = phone ? await findContactByPhone(phone) : null;
  if (existing) {
    await hs(`/crm/v3/objects/contacts/${existing}`, { method: 'PATCH', body: { properties: props } });
    return existing;
  }
  return (await hs('/crm/v3/objects/contacts', { method: 'POST', body: { properties: props } })).id;
}

/** stage ids are HubSpot internal ids from your pipeline, not labels. */
export const stageId = (key) => need(`HUBSPOT_STAGE_${key}`);

export async function upsertDeal({ dealId, contactId, name, stage, properties }) {
  const props = { dealname: name, dealstage: stage, ...properties };
  const pipeline = opt('HUBSPOT_PIPELINE_ID');
  if (pipeline) props.pipeline = pipeline;
  if (dealId) {
    await hs(`/crm/v3/objects/deals/${dealId}`, { method: 'PATCH', body: { properties: props } });
    return dealId;
  }
  const body = {
    properties: props,
    associations: [{
      to: { id: contactId },
      // The deal-to-contact association type id comes from HubSpot's associations guide. Set it explicitly.
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: Number(need('HUBSPOT_DEAL_TO_CONTACT_ASSOC_ID')) }]
    }]
  };
  return (await hs('/crm/v3/objects/deals', { method: 'POST', body })).id;
}
