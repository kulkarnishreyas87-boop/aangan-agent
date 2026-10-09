// Email via Resend: handoff notes, escalations and front-desk tasks. Replaces Telegram.
// API: POST https://api.resend.com/emails with Bearer key, body {from, to, subject, text, html}.
// Idempotency-Key (optional, 24h) is sent so a retried job never sends the same email twice.
// Recipients can be Gmail or any other address. Resend itself only sends; EMAIL_FROM must be an address Resend allows
// (a verified domain, or Resend's test sender while you are testing; check your Resend dashboard for what your account permits).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { need } from './config.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const GROUPS = { designers: 'EMAIL_DESIGNERS', escalation: 'EMAIL_ESCALATION', frontdesk: 'EMAIL_FRONTDESK' };
export const recipients = (group) => {
  const to = list(need(GROUPS[group]));
  if (!to.length) throw new Error(`${GROUPS[group]} has no addresses`);
  return to;
};

export async function send({ to, subject, text, html, idempotencyKey }) {
  const headers = { Authorization: `Bearer ${need('RESEND_API_KEY')}`, 'content-type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 256);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({ from: need('EMAIL_FROM'), to, subject, text, html }),
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json.id;
}

// ---- signed action links (claim / won / lost) -------------------------------------------------------------
const sign = (id, action) => createHmac('sha256', need('ACTION_LINK_SECRET')).update(`${action}:${id}`).digest('hex');

export function verifyAction(id, action, sig) {
  if (!['claim', 'won', 'lost'].includes(action) || !sig) return false;
  const a = Buffer.from(sign(id, action));
  const b = Buffer.from(String(sig));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The link opens a confirmation page. The change is made by a POST from that page, so mail scanners that open links cannot trigger it. */
export const actionLink = (id, action) =>
  `${need('PUBLIC_BASE_URL').replace(/\/$/, '')}/lead/${action}?id=${id}&sig=${sign(id, action)}`;

// ---- messages ---------------------------------------------------------------------------------------------
export async function sendHandoff({ handoffId, call, note, flags, booking, idempotencyKey }) {
  const phone = call.caller_phone ?? 'unknown number';
  const lines = [
    'New qualified lead',
    `Phone: ${phone}`,
    '',
    note,
    '',
    flags?.length ? `Not yet confirmed: ${flags.join(', ')}` : null,
    booking ? `Consultation: ${booking}` : 'Consultation time will follow in a separate email once scheduled.',
    '',
    `Claim this lead: ${actionLink(handoffId, 'claim')}`,
    `Mark Won: ${actionLink(handoffId, 'won')}`,
    `Mark Lost: ${actionLink(handoffId, 'lost')}`
  ].filter((l) => l !== null);
  const html = `<p><b>New qualified lead</b></p><p>Phone: <a href="tel:${esc(phone)}">${esc(phone)}</a></p>
<p style="white-space:pre-wrap">${esc(note)}</p>
${flags?.length ? `<p>Not yet confirmed: ${esc(flags.join(', '))}</p>` : ''}
<p>${booking ? `Consultation: ${esc(booking)}` : 'Consultation time will follow in a separate email once scheduled.'}</p>
<p><a href="${actionLink(handoffId, 'claim')}">Claim</a> &nbsp;|&nbsp; <a href="${actionLink(handoffId, 'won')}">Won</a> &nbsp;|&nbsp; <a href="${actionLink(handoffId, 'lost')}">Lost</a></p>`;
  return send({ to: recipients('designers'), subject: `New lead: ${phone}`, text: lines.join('\n'), html, idempotencyKey });
}

export const sendEscalation = ({ call, note, idempotencyKey }) =>
  send({
    to: recipients('escalation'),
    subject: `ESCALATION, call back within 15 minutes: ${call.caller_phone ?? 'unknown number'}`,
    text: `Call back within 15 minutes.\nCaller: ${call.caller_phone ?? 'unknown'}\n\n${note}`,
    html: `<p><b>Call back within 15 minutes.</b></p><p>Caller: <a href="tel:${esc(call.caller_phone)}">${esc(call.caller_phone ?? 'unknown')}</a></p><p style="white-space:pre-wrap">${esc(note)}</p>`,
    idempotencyKey
  });

export const sendTask = ({ text, to = 'frontdesk', idempotencyKey }) =>
  send({ to: recipients(to), subject: String(text).slice(0, 80), text, html: `<p style="white-space:pre-wrap">${esc(text)}</p>`, idempotencyKey });
