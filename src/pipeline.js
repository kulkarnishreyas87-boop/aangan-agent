// The call loop. Two entry points:
//   decideTurn   - during the call: Gemini decides, the rules check guards it, Vaani gets the route back.
//   finalizeCall - after the call: final decision, handoff note, then Neon + outbox in one transaction.
import { decide, writeHandoffNote } from './gemini.js';
import { deriveRoute, scrubPrice, PRICE_DEFLECTION } from './rules.js';
import { settings } from './config.js';
import * as store from './db.js';

export function geminiCostRows(usage) {
  const r = settings.rate;
  const inRate = r.geminiInputPerMTok();
  const outRate = r.geminiOutputPerMTok();
  return [
    { provider: 'gemini', unitType: 'input_tokens', units: usage.input, amountInr: inRate == null ? null : (usage.input / 1e6) * inRate },
    { provider: 'gemini', unitType: 'output_tokens', units: usage.output, amountInr: outRate == null ? null : (usage.output / 1e6) * outRate }
  ];
}

/** What Vaani needs to speak. Wording comes from Vaani's own skill; we only send the route and intent. */
export function toVaaniReply(d) {
  const reply = {
    route: d.route,
    ask_about: d.askAbout,
    question: d.question ? scrubPrice(d.question) : null,
    reason_codes: d.reasonCodes,
    flags: d.flags,
    deflect_price: d.deflectPrice,
    availability_given: Boolean(d.availabilityGiven),
    price_line: d.deflectPrice ? PRICE_DEFLECTION : null,
    next: ''
  };
  reply.next = {
    CLARIFY: 'Ask the question, then wait for the answer.',
    QUALIFY: 'Ask when the caller is free, and tell them a consultation time will be confirmed by a call-back right after this call.',
    DECLINE: 'Close politely with the reason, a useful redirect and an open door.',
    ESCALATE: 'Apologise plainly and promise a senior call-back within 15 minutes.',
    LOG_ONLY: 'Take the number, say a team member will call back, and end the call.'
  }[d.route];
  return reply;
}

/**
 * Decide the turn WITHOUT writing anything: the caller is waiting, so the database writes (persistTurn) are done while the spoken
 * reply is being generated instead of before it.
 */
export async function evaluateTurn(p) {
  const call = await store.upsertCall(p);
  const history = await store.historyFor(call.caller_phone, call.id);
  const { json, usage } = await decide({ transcript: p.transcript, history, lite: true });
  const verdict = deriveRoute(json, { clarifyCount: call.clarify_count, maxClarify: settings.maxClarify() });
  return { call, json, usage, verdict, transcript: p.transcript };
}

/** Save what evaluateTurn decided. One statement for the decision, one for the costs. */
export async function persistTurn({ call, json, usage, verdict, transcript }) {
  await Promise.all([
    store.saveTurnDecision(call.id, {
      transcript,
      decision: { ...json, criteria: verdict.criteria, overrides: verdict.overrides },
      route: verdict.route,
      reasonCodes: verdict.reasonCodes,
      clarified: verdict.route === 'CLARIFY'
    }),
    store.insertCosts(call.id, geminiCostRows(usage))
  ]);
}

export async function decideTurn(p) {
  const ev = await evaluateTurn(p);
  await persistTurn(ev);
  const { json, verdict } = ev;
  return toVaaniReply({ ...verdict, question: json.next_question, availabilityGiven: json.availability_given });
}

const declineNote = (codes) => `Declined. Reason: ${codes.join(', ') || 'not a fit'}.`;

export async function finalizeCall(p) {
  const call = await store.upsertCall(p);
  if (call.finalized_at) return { duplicate: true, callId: call.id };

  // Heuristic, not a vendor fact: a transcript this short means the caller dropped before saying anything useful.
  const tooShort = p.transcript.trim().length < settings.minTranscriptChars();
  const costs = [];
  let decision = call.decision;
  let verdict;
  let note = null;

  if (tooShort) {
    // Dropped or empty call: nothing to decide. A person calls the number back.
    verdict = { route: 'LOG_ONLY', reasonCodes: ['dropped_call'], flags: [], criteria: {} };
    note = 'Call dropped before the caller said enough. Call back.';
  } else {
    const history = await store.historyFor(call.caller_phone, call.id);
    const { json, usage } = await decide({ transcript: p.transcript, history });
    costs.push(...geminiCostRows(usage));
    verdict = deriveRoute(json, { clarifyCount: 0 });
    // Still unclear when the caller hung up: a person follows up, we do not forward an incomplete lead.
    if (verdict.route === 'CLARIFY') verdict = { ...verdict, route: 'LOG_ONLY', reasonCodes: ['unresolved_at_hangup'] };
    decision = { ...json, criteria: verdict.criteria, overrides: verdict.overrides };
    if (verdict.route === 'QUALIFY' || verdict.route === 'ESCALATE') {
      const n = await writeHandoffNote({ transcript: p.transcript, decision, flags: verdict.flags, route: verdict.route });
      note = n.json.note;
      costs.push(...geminiCostRows(n.usage));
    } else {
      note = declineNote(verdict.reasonCodes);
    }
  }

  if (p.durationS != null) {
    const rate = settings.rate.voicePerMinute();
    costs.push({ provider: 'voice', unitType: 'call_seconds', units: p.durationS, amountInr: rate == null ? null : (p.durationS / 60) * rate });
  }

  const jobs = [{ kind: 'hubspot_sync', payload: { callId: call.id } }];
  if (verdict.route === 'QUALIFY') {
    jobs.unshift({ kind: 'email_handoff', payload: { callId: call.id, flags: verdict.flags } });
    jobs.push({ kind: 'schedule', payload: { callId: call.id } }); // gate: only a Qualify route is ever scheduled
  } else if (verdict.route === 'ESCALATE') {
    jobs.unshift({ kind: 'email_escalation', payload: { callId: call.id } });
  } else if (verdict.route === 'LOG_ONLY') {
    jobs.unshift({ kind: 'email_task', payload: { text: `Call back ${call.caller_phone ?? 'unknown number'}: ${verdict.reasonCodes.join(', ')}. ${note ?? ''}` } });
  }

  await store.finalizeCall(
    call.id,
    { endedAt: p.endedAt ?? new Date(), durationS: p.durationS, transcript: p.transcript, decision, route: verdict.route, reasonCodes: verdict.reasonCodes, note },
    costs,
    jobs
  );
  return { callId: call.id, route: verdict.route };
}
