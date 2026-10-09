// Creates the Vaani agent with BYOL already enabled (POST /api/create-agent). BYOL has to be set at creation:
// Vaani's PATCH /api/agent/{id}/persona accepts the request but silently drops brain.llm.extra_params, so the URL, the
// enable flag and the Auth Token cannot be added afterwards through the public API. Running this again makes ANOTHER agent.
// Usage: node --env-file=.env scripts/vaani-create-agent.js "<display name>" <wss-url>
import { need } from '../src/config.js';

const [name, url] = process.argv.slice(2);
if (!name || !url) { console.log('Usage: node --env-file=.env scripts/vaani-create-agent.js "<display name>" <wss-url>'); process.exit(2); }
const H = { 'X-API-Key': need('VAANI_API_KEY'), 'content-type': 'application/json' };
const body = {
  agent_display_name: name,
  config: {
    persona: {
      identity: {
        system_prompt: 'You are the phone front desk of Aangan Studio, a Pune interior design studio. Every reply is written by the studio server, so this prompt is only a safety net. Never state any price, rate or budget figure. If you must speak without the server, say that a team member will call back shortly and end the call.',
        greeting_message: { agent_message: 'Good morning, Aangan Studio. How can I help you today?', interruptible: true, let_user_speak_first: false }
      },
      senses_capabilities: {
        language: 'en',
        auto_detect: true,
        brain: { llm: { extra_params: { llm_websocket_url: url, custom_llm: true, llm_websocket_auth_token: need('VAANI_BYOL_TOKEN'), fallback: 'none' } } }
      }
    }
  }
};
const r = await fetch('https://api.vaanivoice.ai/api/create-agent', { method: 'POST', headers: H, body: JSON.stringify(body) });
const j = await r.json().catch(() => ({}));
if (!r.ok || !j.agent_id) { console.log('Create failed', r.status, JSON.stringify(j).slice(0, 300)); process.exit(1); }
console.log('created agent', j.agent_id);
const g = await (await fetch(`https://api.vaanivoice.ai/api/agent/${j.agent_id}`, { headers: { 'X-API-Key': H['X-API-Key'] } })).json();
const ep = g.persona?.senses_capabilities?.brain?.llm?.extra_params ?? {};
console.log('BYOL stored:', JSON.stringify({ url: ep.llm_websocket_url, enabled: ep.custom_llm, token: ep.llm_websocket_auth_token ? 'set' : 'MISSING', fallback: ep.fallback }));
