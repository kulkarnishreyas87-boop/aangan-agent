import { createServer } from '../src/http-server.js';
import { startWorker } from '../src/worker.js';
import { db } from '../src/db.js';
import { settings, opt } from '../src/config.js';
import { missingEnv } from '../src/env-check.js';

// Fail loudly at start-up, with the names of what is missing, instead of on the first live call.
const missing = missingEnv();
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
// A background timer must never run on Vercel: the instance is frozen between requests, which would freeze a half-done job.
// There the outbox is drained by the cron route and after each webhook instead.
const worker = process.env.VERCEL ? null : startWorker();

// Finish in-flight requests, stop the worker and close the database pool on shutdown (deploys, Ctrl+C).
let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  if (worker) clearInterval(worker);
  server.close(async () => {
    try { await db().end(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
