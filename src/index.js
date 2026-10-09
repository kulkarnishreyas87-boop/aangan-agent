import { createServer } from './server.js';
import { startWorker } from './worker.js';
import { db } from './db.js';
import { settings, opt } from './config.js';

// Fail loudly at start-up, with the names of what is missing, instead of on the first live call.
const REQUIRED = [
  'DATABASE_URL', 'GEMINI_API_KEY', 'GEMINI_MODEL',
  'VAANI_WEBHOOK_SECRET', 'VAANI_BYOL_TOKEN',
  'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_DESIGNERS', 'EMAIL_ESCALATION', 'EMAIL_FRONTDESK', 'PUBLIC_BASE_URL', 'ACTION_LINK_SECRET',
  'CALCOM_API_KEY', 'CALCOM_EVENT_TYPE_ID_SITE_VISIT', 'CALCOM_EVENT_TYPE_ID_PHONE', 'CALCOM_SLOTS_API_VERSION', 'CALCOM_BOOKINGS_API_VERSION', 'CALCOM_WEBHOOK_SECRET',
  'HUBSPOT_ACCESS_TOKEN', 'HUBSPOT_DEAL_TO_CONTACT_ASSOC_ID',
  'HUBSPOT_STAGE_QUALIFIED', 'HUBSPOT_STAGE_BOOKED', 'HUBSPOT_STAGE_WON', 'HUBSPOT_STAGE_LOST', 'HUBSPOT_STAGE_DECLINED', 'HUBSPOT_STAGE_OTHER'
];
const missing = REQUIRED.filter((k) => !opt(k));
if (missing.length) {
  console.error(`Missing required environment variables:\n  ${missing.join('\n  ')}\nSee .env.example.`);
  process.exit(1);
}
if (!opt('VAANI_API_KEY') || !opt('VAANI_CONFIRM_AGENT_ID')) {
  console.warn('VAANI_API_KEY or VAANI_CONFIRM_AGENT_ID not set: confirmation calls are off, the front desk will get an email task instead.');
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message ?? e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message ?? e));

const server = createServer();
server.listen(settings.port(), () => console.log(`aangan-agent listening on :${settings.port()}`));
const worker = startWorker();

// Finish in-flight requests, stop the worker and close the database pool on shutdown (deploys, Ctrl+C).
let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  clearInterval(worker);
  server.close(async () => {
    try { await db().end(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
