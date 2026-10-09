// Pushes the variables from .env to the linked Vercel project (production). Values are sent on stdin, never printed.
// Secrets are stored as write-only "sensitive" values. Usage: node scripts/vercel-env.js [--only NAME,NAME]
import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const SKIP = new Set(['PORT']);                       // local only
const SECRET = /KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL/;
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;

const vars = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const i = line.indexOf('=');
  vars[line.slice(0, i)] = line.slice(i + 1).trim();
}
if (!vars.CRON_SECRET) {
  vars.CRON_SECRET = randomBytes(24).toString('hex'); // Vercel Cron sends this as a bearer token
  appendFileSync(new URL('../.env', import.meta.url), `CRON_SECRET=${vars.CRON_SECRET}
`);
}

let bad = 0;
for (const [name, value] of Object.entries(vars)) {
  if (SKIP.has(name) || !value || (only && !only.includes(name))) continue;
  const sensitive = SECRET.test(name);
  const r = spawnSync('npx', ['--yes', 'vercel@latest', 'env', 'add', name, 'production', sensitive ? '--sensitive' : '--no-sensitive', '--force'],
    { input: value, encoding: 'utf8', shell: process.platform === 'win32' });
  const ok = r.status === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'set   ' : 'FAILED'} ${name}${sensitive ? '  (sensitive)' : ''}${ok ? '' : '  ' + (r.stderr || r.stdout).trim().split('\n').pop()}`);
}
console.log(bad ? `${bad} failed` : 'all set');
