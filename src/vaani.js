// Vaani (vaanivoice.ai) client and webhook helpers. Contracts below come from https://docs.vaanivoice.ai (checked 2026-10):
//   Outbound call : POST https://api.vaanivoice.ai/api/trigger-call/   header X-API-Key, body {agent_id, medium, contact_number, name, metadata,...}
//   Call details  : GET  https://api.vaanivoice.ai/api/call_details/{call_id}
//   Webhooks      : POST to the URL set in the Vaani dashboard (Settings > Webhooks). Docs list events but NO signature scheme,
//                   so the URL itself carries a secret path segment, and events are only acted on for calls we know.
//   BYOL          : Vaani opens a WebSocket to our server per call (see byol.js).
// Unverified until a real call runs: whether webhook `room_name` equals the BYOL `call_id`, and that `phone_number` on
// `call_started` is the caller for inbound calls. The code reads either id spelling so it keeps working if they differ in name only.
import { createHash, timingSafeEqual } from 'node:crypto';
import { opt, need } from './config.js';

export class NotConfigured extends Error {}

const BASE = () => opt('VAANI_API_BASE', 'https://api.vaanivoice.ai');

/** Constant-time comparison that does not leak length. */
export function safeEqual(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

export const verifyPathSecret = (given) => safeEqual(given ?? '', need('VAANI_WEBHOOK_SECRET'));
export const verifyByolToken = (authorization) => safeEqual(authorization ?? '', `Bearer ${need('VAANI_BYOL_TOKEN')}`);

/** The call id as it appears in either a webhook payload or a BYOL connection. */
export const callIdOf = (body) => String(body?.call_id ?? body?.data?.call_id ?? body?.room_name ?? body?.data?.room_name ?? '');

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const date = (x) => { if (!x) return null; const d = new Date(x); return Number.isNaN(d.getTime()) ? null : d; };

/** Normalise a webhook body. Malformed numbers and dates become null instead of breaking the call. */
export function parseEvent(body) {
  const data = body?.data ?? {};
  const ms = num(data.call_duration);
  const sec = num(body?.call_duration);
  return {
    event: body?.event ?? '',
    callId: callIdOf(body),
    phone: String(body?.phone_number ?? data.phone_number ?? '').replace(/s+/g, '') || null,
    transcript: typeof data.transcript === 'string' ? data.transcript : (typeof body?.transcript === 'string' ? body.transcript : ''),
    // Docs: call_postprocessing.data.call_duration is in MILLISECONDS; call_ended.call_duration is in SECONDS.
    durationS: ms != null ? Math.round(ms / 1000) : sec != null ? Math.round(sec) : null,
    timestamp: date(body?.timestamp),
    summary: data.summary ?? null
  };
}

async function vaani(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: { 'X-API-Key': need('VAANI_API_KEY'), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vaani ${method} ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** Fallback when a webhook arrives without a transcript. */
export async function getCallDetails(callId) {
  const j = await vaani(`/api/call_details/${encodeURIComponent(callId)}`);
  return { transcript: typeof j.transcription === 'string' ? j.transcription : '', summary: j.summary ?? null };
}

/**
 * Outbound confirmation call. Needs VAANI_API_KEY and VAANI_CONFIRM_AGENT_ID (a second agent, see vaani/CONFIRM_AGENT_PROMPT.md).
 * `metadata` fills the template variables configured on that agent. dnd_check_skipped stays false: we respect Do Not Disturb.
 */
export async function placeOutboundCall({ phone, name, whenText, visitType }) {
  if (!opt('VAANI_API_KEY') || !opt('VAANI_CONFIRM_AGENT_ID')) throw new NotConfigured('Set VAANI_API_KEY and VAANI_CONFIRM_AGENT_ID to enable confirmation calls.');
  const body = {
    agent_id: need('VAANI_CONFIRM_AGENT_ID'),
    medium: 'telephony',
    contact_number: phone,
    name: name || 'there',
    metadata: { customer_name: name || 'there', consultation_time: whenText, visit_type: visitType === 'site_visit' ? 'site visit' : 'phone call' },
    dnd_check_skipped: false
  };
  if (opt('VAANI_OUTBOUND_NUMBER')) body.outbound_number = opt('VAANI_OUTBOUND_NUMBER');
  const j = await vaani('/api/trigger-call/', { method: 'POST', body });
  if (!j.success || !j.output?.call_id) throw new Error(`Vaani trigger-call did not start a call: ${JSON.stringify(j).slice(0, 200)}`);
  return { callId: j.output.call_id };
}
