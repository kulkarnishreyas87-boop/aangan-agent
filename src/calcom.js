// Cal.com API v2. Header values were taken from the Cal.com reference pages (checked 2026-10):
//   GET  /v2/slots      -> cal-api-version 2024-09-04
//   POST /v2/bookings   -> cal-api-version 2026-02-25
// Both are env-configurable because Cal.com versions each endpoint separately.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { need, opt, settings } from './config.js';

const BASE = () => opt('CALCOM_BASE_URL', 'https://api.cal.com');

async function cal(path, { method = 'GET', version, body } = {}) {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${need('CALCOM_API_KEY')}`,
      'cal-api-version': version,
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Cal.com ${method} ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

export const eventTypeIdFor = (visitType) =>
  Number(need(visitType === 'site_visit' ? 'CALCOM_EVENT_TYPE_ID_SITE_VISIT' : 'CALCOM_EVENT_TYPE_ID_PHONE'));

/** Open slots for an event type, as a flat sorted list of UTC ISO start times. */
export async function openSlots(visitType, from = new Date()) {
  const end = new Date(from.getTime() + settings.scheduleWindowDays() * 86400000);
  const qs = new URLSearchParams({
    eventTypeId: String(eventTypeIdFor(visitType)),
    start: from.toISOString(),
    end: end.toISOString(),
    timeZone: 'UTC'
  });
  const json = await cal(`/v2/slots?${qs}`, { version: need('CALCOM_SLOTS_API_VERSION') });
  const out = [];
  for (const day of Object.values(json.data ?? {})) {
    for (const s of day) out.push(typeof s === 'string' ? s : s.start); // the docs show both shapes
  }
  return out.sort();
}

/**
 * Book a slot. Cal.com's reference lists attendee.name and attendee.timeZone as required and email as not required
 * in the schema; whether your event type accepts a booking without an email depends on its booking fields.
 */
export async function book({ visitType, startIso, name, phone, email, timeZone }) {
  const attendee = { name, timeZone };
  if (email) attendee.email = email;
  if (phone) attendee.phoneNumber = phone; // international format, e.g. +919876543210
  const json = await cal('/v2/bookings', {
    method: 'POST',
    version: need('CALCOM_BOOKINGS_API_VERSION'),
    body: { start: startIso, eventTypeId: eventTypeIdFor(visitType), attendee }
  });
  const b = Array.isArray(json.data) ? json.data[0] : json.data;
  return { uid: b.uid, id: b.id, status: b.status, start: b.start ?? startIso, eventTypeId: b.eventTypeId ?? eventTypeIdFor(visitType) };
}

/** Verify a Cal.com webhook. VERIFY against your Cal.com webhook settings: this assumes x-cal-signature-256 = HMAC-SHA256(secret, rawBody) in hex. */
export function verifyWebhook(rawBody, signatureHex) {
  if (!signatureHex) return false;
  const expected = createHmac('sha256', need('CALCOM_WEBHOOK_SECRET')).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHex);
  return a.length === b.length && timingSafeEqual(a, b);
}
