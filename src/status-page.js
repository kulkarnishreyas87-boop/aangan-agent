// A small public status page for the front address. It shows whether the system is live and healthy, with counts and times
// only: no phone numbers, names, transcripts, secrets or variable names. (/health already exposes the same health facts.)
import * as store from './db.js';
import { opt } from './config.js';
import { missingEnv } from './env-check.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const GROUPS = [
  ['Database (Neon)', ['DATABASE_URL']],
  ['Decisions (Gemini)', ['GEMINI_API_KEY', 'GEMINI_MODEL']],
  ['Voice (Vaani) link', ['VAANI_WEBHOOK_SECRET', 'VAANI_BYOL_TOKEN']],
  ['Email (Resend)', ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_DESIGNERS', 'EMAIL_ESCALATION', 'EMAIL_FRONTDESK', 'PUBLIC_BASE_URL', 'ACTION_LINK_SECRET']],
  ['Calendar (Cal.com)', ['CALCOM_API_KEY', 'CALCOM_EVENT_TYPE_ID_SITE_VISIT', 'CALCOM_EVENT_TYPE_ID_PHONE', 'CALCOM_SLOTS_API_VERSION', 'CALCOM_BOOKINGS_API_VERSION', 'CALCOM_WEBHOOK_SECRET']],
  ['CRM (HubSpot)', ['HUBSPOT_ACCESS_TOKEN', 'HUBSPOT_DEAL_TO_CONTACT_ASSOC_ID', 'HUBSPOT_STAGE_QUALIFIED', 'HUBSPOT_STAGE_BOOKED', 'HUBSPOT_STAGE_WON', 'HUBSPOT_STAGE_LOST', 'HUBSPOT_STAGE_DECLINED', 'HUBSPOT_STAGE_OTHER']],
  ['Confirmation calls (Vaani)', ['VAANI_API_KEY', 'VAANI_CONFIRM_AGENT_ID'], 'optional']
];

const ago = (d) => {
  if (!d) return 'no calls yet';
  const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 90) return s + ' seconds ago';
  if (s < 5400) return Math.round(s / 60) + ' minutes ago';
  if (s < 129600) return Math.round(s / 3600) + ' hours ago';
  return Math.round(s / 86400) + ' days ago';
};

export async function statusPage(host) {
  let db = false, outbox = { pending: 0, dead: 0 }, calls = { total: 0, last_24h: 0, last_at: null, qualified: 0 };
  try { outbox = await store.outboxStats(); calls = await store.callStats(); db = true; } catch { db = false; }
  const missing = new Set(missingEnv());
  const rows = GROUPS.map(([label, vars, kind]) => {
    const ok = vars.every((v) => opt(v));
    const state = ok ? ['ok', 'Connected'] : kind === 'optional' ? ['warn', 'Not set up (the front desk gets an email instead)'] : ['bad', 'Incomplete'];
    return '<tr><td>' + esc(label) + '</td><td class="' + state[0] + '">' + esc(state[1]) + '</td></tr>';
  }).join('');
  const healthy = db && outbox.dead === 0 && missing.size === 0;
  const wss = 'wss://' + host + '/vaani/llm';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aangan Enquiry Agent</title>' +
    '<style>:root{--bg:#f6f7f9;--fg:#14213a;--muted:#5b6678;--card:#fff;--line:#d7dde8;--ok:#1b7a3c;--warn:#a86a00;--bad:#b3261e}' +
    '@media (prefers-color-scheme:dark){:root{--bg:#0f1521;--fg:#e7ebf3;--muted:#9aa5b8;--card:#18223a;--line:#2d3a52;--ok:#58c07a;--warn:#e3b64a;--bad:#ff8a80}}' +
    'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:24px 16px}main{max-width:720px;margin:0 auto}' +
    'h1{font-size:22px;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 20px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:16px}' +
    '.badge{display:inline-block;padding:3px 10px;border-radius:99px;font-weight:600;font-size:13px;border:1px solid currentColor}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}' +
    'table{border-collapse:collapse;width:100%}td{padding:7px 0;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}td:last-child{text-align:right;font-weight:600}' +
    '.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}.stat b{display:block;font-size:22px}.stat span{color:var(--muted);font-size:13px}' +
    'code{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:2px 6px;word-break:break-all}h2{font-size:15px;margin:0 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}</style></head><body><main>' +
    '<h1>Aangan Enquiry Agent</h1><p class="sub">Answers phone enquiries, qualifies them, books consultations and hands qualified leads to designers.</p>' +
    '<div class="card"><span class="badge ' + (healthy ? 'ok' : 'bad') + '">' + (healthy ? 'Live and healthy' : 'Needs attention') + '</span>' +
    '<p style="margin:10px 0 0;color:var(--muted)">' + (db ? 'Database reachable.' : 'Database not reachable.') + (outbox.dead ? ' ' + outbox.dead + ' background job(s) failed for good.' : '') + (missing.size ? ' Some settings are missing.' : '') + '</p></div>' +
    '<div class="card"><h2>Activity</h2><div class="stats"><div class="stat"><b>' + calls.total + '</b><span>calls handled</span></div><div class="stat"><b>' + calls.last_24h + '</b><span>in the last 24 hours</span></div><div class="stat"><b>' + calls.qualified + '</b><span>qualified leads</span></div><div class="stat"><b>' + esc(ago(calls.last_at)) + '</b><span>last call</span></div></div>' +
    '<p style="margin:12px 0 0;color:var(--muted);font-size:13px">Background jobs waiting: ' + outbox.pending + '</p></div>' +
    '<div class="card"><h2>Connections</h2><table>' + rows + '</table></div>' +
    '<div class="card"><h2>For the voice platform setup</h2><p style="margin:0 0 6px">BYOL WebSocket address: <code>' + esc(wss) + '</code></p><p style="margin:0;color:var(--muted);font-size:13px">The webhook address ends in a private secret, kept in the project settings and never shown here.</p></div>' +
    '<p style="color:var(--muted);font-size:13px">Health data for monitors: <a href="/health" style="color:inherit">/health</a></p></main></body></html>';
}
