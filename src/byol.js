// Vaani "Bring Your Own LLM" server. Vaani opens one WebSocket per call to <llm_websocket_url>/<call_id>
// (set in the Vaani dashboard: Brain > Reasoning Language Model > BYOL, with an Auth Token).
// Protocol (https://docs.vaanivoice.ai/guides/byol): we send two handshake frames (config, greeting); Vaani then sends
// {interaction_type:'response_required', response_id, call_id, transcript:[{role,content}], req_body}; we reply with
// {response_type:'response', response_id, content, content_complete, end_call?}. Content is text that Vaani speaks.
//
// Every turn: Gemini decides from qualified.md, the rules check guards it, then Gemini writes the spoken words from the
// studio playbook. Every word we send is passed through the price filter, so nothing priced can ever be spoken.
import { WebSocketServer } from 'ws';
import { verifyByolToken } from './vaani.js';
import { decideTurn, geminiCostRows } from './pipeline.js';
import { speak } from './gemini.js';
import { scrubPrice, PRICE_DEFLECTION } from './rules.js';
import * as store from './db.js';
import { restoreUrl } from './url.js';

const ENDING_ROUTES = new Set(['DECLINE', 'ESCALATE', 'LOG_ONLY']);
const MAX_AVAILABILITY_ASKS = 2; // after this many asks we wrap up anyway and let the confirmation call sort out the time

const TOPIC = {
  real_project: 'whether they want a full redesign with design and execution, or only advice',
  service_area: 'which area of Pune or Pimpri-Chinchwad the property is in',
  timeline: 'when they would like the project to be finished',
  budget: null,
  decision_maker: null
};
const DECLINE_WHY = {
  service_area: 'we only work in Pune and Pimpri-Chinchwad because our execution depends on our own contractors being on site',
  real_project: 'we only take projects where we do both the design and the execution',
  timeline: 'our design phase takes 3 to 4 weeks and a room 8 to 10 weeks, so we cannot do justice to that deadline; offer to start after their date',
  budget: 'the budget they mentioned is well below what a project of that scope costs with us, so a local contractor may suit them better; say it kindly and do not mention any number',
  decision_maker: 'the decision maker needs to be part of the conversation'
};

/** Pure: turn the system's verdict into the instruction the speech model follows. Returns {directive, endCall}. */
export function directiveFor(reply, state = {}) {
  const parts = [];
  let endCall = false;
  switch (reply.route) {
    case 'CLARIFY': {
      const q = reply.question || (TOPIC[reply.ask_about] ? `Ask ${TOPIC[reply.ask_about]}.` : 'Ask one short question to understand the project.');
      parts.push(`Ask exactly one question, nothing more: "${q}" Rephrase it naturally. Then stop and wait for the answer.`);
      break;
    }
    case 'QUALIFY':
      if (!state.askedAvailability && !reply.availability_given) {
        parts.push('The caller is a good fit. Thank them warmly in one short sentence, then ask when they are free for a first consultation (days and times, and who will attend). Do NOT offer or book a specific time. Say a team member will call them right after this call to confirm the time.');
      } else if (reply.availability_given || (state.availabilityAsks ?? 0) >= MAX_AVAILABILITY_ASKS) {
        parts.push('Wrap up warmly: say we will call them shortly to confirm a consultation time, thank them, and say goodbye.');
        endCall = true;
      } else {
        parts.push('The caller has not yet said when they are free. If they asked something, answer it briefly first. Then ask again, gently, which days and times suit them for a first consultation. Do not end the call.');
      }
      break;
    case 'DECLINE':
      parts.push(`Politely decline. Reason to give: ${reply.reason_codes.map((c) => DECLINE_WHY[c] ?? c).join('; ') || 'it is not the right fit right now'}. Offer a useful redirect if the playbook has one, say they are welcome to reach out if things change, and say goodbye.`);
      endCall = true;
      break;
    case 'ESCALATE':
      parts.push('This is an existing client with a complaint. Apologise plainly without excuses, promise a senior person will call them back within 15 minutes, thank them for their patience, and say goodbye.');
      endCall = true;
      break;
    case 'LOG_ONLY':
      parts.push('Say a team member will call them back soon, thank them for calling, and say goodbye.');
      endCall = true;
      break;
    default:
      parts.push('Ask one short question to understand the project.');
  }
  const deflect = reply.deflect_price && !state.priceDeflected; // say it once, not on every later turn
  if (deflect && !endCall) {
    parts.push(`The caller also asked about price. Say this idea first, in your own natural words and with no number: "${PRICE_DEFLECTION}"`);
  } else if (deflect) {
    parts.push(`The caller asked about price. Include this idea with no number: "${PRICE_DEFLECTION}"`);
  }
  return { directive: parts.join('\n'), endCall };
}

const SAFE_RETRY = 'Sorry, could you say that once more?';
const SAFE_HANDOVER = 'I am sorry, we are having a little trouble. A team member will call you back shortly. Thank you for calling Aangan Studio.';

/** Role names are Vaani's: system first, then user and assistant. */
export function toTranscript(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m === 'object' && m.role !== 'system' && String(m.content ?? '').trim())
    .map((m) => `${m.role === 'user' ? 'USER' : 'AGENT'}: ${String(m.content).trim()}`)
    .join('\n');
}

export function attach(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 }); // 1 MB per frame

  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    restoreUrl(req);
    let callId = null;
    try {
      const m = new URL(req.url, 'http://x').pathname.match(/^\/vaani\/llm\/([^/]+)$/);
      if (m && verifyByolToken(req.headers.authorization)) callId = decodeURIComponent(m[1]);
    } catch { callId = null; } // bad %-escapes, missing secrets: refuse, never crash
    if (!callId) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, callId));
  });
  return wss;
}

function onConnection(ws, callId) {
  const state = { askedAvailability: false, availabilityAsks: 0, failures: 0, latest: 0, loaded: false };
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  ws.on('error', (e) => console.error(`[byol] socket error on call ${callId}:`, e.message));

  // Handshake frames, in this order. Vaani ignores their content.
  send({ interaction_type: 'config' });
  send({ interaction_type: 'greeting', content: '' });

  let chain = Promise.resolve();
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.response_type === 'ping_pong' || msg.interaction_type === 'ping_pong') return send({ response_type: 'ping_pong' });
    if (msg.interaction_type !== 'response_required') return;
    state.latest = msg.response_id; // a newer turn supersedes an older one still being computed
    chain = chain.then(() => handleTurn(msg)).catch((e) => console.error('[byol] turn failed:', e.message));
  });

  async function handleTurn(msg) {
    const id = msg.response_id;
    const transcript = toTranscript(msg.transcript);
    /** Returns true only if the frame was really sent (the caller may have spoken again, which supersedes this reply). */
    const reply = (text, endCall) => {
      if (state.latest !== id) return false;
      send({ response_type: 'response', response_id: id, content: scrubPrice(text), content_complete: true, end_call: Boolean(endCall) });
      return true;
    };
    if (!transcript) { reply(SAFE_RETRY, false); return; }

    try {
      const externalCallId = String(msg.call_id ?? callId);
      if (!state.loaded) {
        // A connection can drop and reconnect (Vercel closes WebSockets at the function's maximum duration). Resume where the call was.
        Object.assign(state, await store.loadByolState(externalCallId));
        state.loaded = true;
      }
      const verdict = await decideTurn({ externalCallId, transcript });
      const { directive, endCall } = directiveFor(verdict, state);
      const call = await store.upsertCall({ externalCallId });
      const { json, usage } = await speak({ transcript, directive });
      for (const c of geminiCostRows(usage)) await store.insertCost(call.id, c);
      state.failures = 0;
      const sent = reply(json.reply, endCall || ENDING_ROUTES.has(verdict.route));
      if (sent && verdict.deflect_price && !state.priceDeflected) {
        state.priceDeflected = true;
        await store.saveByolState(externalCallId, { askedAvailability: state.askedAvailability, availabilityAsks: state.availabilityAsks, priceDeflected: true });
      }
      // Only count the question as asked if the caller actually heard it.
      if (sent && verdict.route === 'QUALIFY') {
        if (state.askedAvailability) state.availabilityAsks += 1;
        else state.availabilityAsks = 1;
        state.askedAvailability = true;
        await store.saveByolState(externalCallId, { askedAvailability: true, availabilityAsks: state.availabilityAsks, priceDeflected: Boolean(state.priceDeflected) });
      }
    } catch (e) {
      state.failures += 1;
      console.error(`[byol] call ${callId} turn ${id}: ${e.message}`);
      if (state.failures >= 3) reply(SAFE_HANDOVER, true);
      else reply(SAFE_RETRY, false);
    }
  }
}
