// The agent's opening line is fixed text in Vaani ("the exact first words the agent says"), with no time-of-day variable. So the
// text is kept right by rewriting it when the part of the day changes: PATCH /api/agent/{id}/persona (deep-merged, other fields stay).
// syncGreeting() is idempotent: it reads the current text first and only writes when it is wrong.
import { opt } from './config.js';
import { timeOfDay } from './gemini.js';

const BASE = () => opt('VAANI_API_BASE', 'https://api.vaanivoice.ai');
export const greetingText = (now = new Date()) => `${timeOfDay(now).greeting}, Aangan Studio. How can I help you today?`;

async function vaani(path, init = {}) {
  const res = await fetch(`${BASE()}${path}`, { ...init, headers: { 'X-API-Key': opt('VAANI_API_KEY'), 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vaani ${init.method ?? 'GET'} ${path} ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

let lastCheck = 0;
/** Returns {changed, text}. `minGapMs` keeps frequent callers (the dashboard) from hitting Vaani more than once per interval. */
export async function syncGreeting({ minGapMs = 0, now = new Date() } = {}) {
  const agentId = opt('VAANI_AGENT_ID');
  if (!agentId || !opt('VAANI_API_KEY')) return { skipped: 'VAANI_AGENT_ID or VAANI_API_KEY not set' };
  if (minGapMs && Date.now() - lastCheck < minGapMs) return { skipped: 'checked recently' };
  lastCheck = Date.now();
  const want = greetingText(now);
  const agent = await vaani(`/api/agent/${agentId}`);
  const current = agent?.persona?.identity?.greeting_message?.agent_message ?? '';
  if (current === want) return { changed: false, text: want };
  await vaani(`/api/agent/${agentId}/persona`, { method: 'PATCH', body: JSON.stringify({ identity: { greeting_message: { agent_message: want } } }) });
  return { changed: true, text: want, was: current };
}
