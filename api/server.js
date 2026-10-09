// Vercel entry point. Vercel Functions serve WebSockets when the default export is a Node http.Server with a `ws` server
// attached (https://vercel.com/docs/functions/websockets). vercel.json rewrites every path here.
// There is no long-running process on Vercel: the outbox is drained by the cron route and after each webhook.
import { createServer } from '../src/http-server.js';
import { missingEnv } from '../src/env-check.js';

const missing = missingEnv();
if (missing.length) console.error(`Missing environment variables: ${missing.join(', ')}`);

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message ?? e));

export default createServer();
