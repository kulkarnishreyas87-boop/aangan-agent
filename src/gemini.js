// Gemini: the decision layer. It reads qualified.md only (Nikhil's rubric) and returns structured JSON.
// Endpoint and request shape follow https://ai.google.dev/api/generate-content (checked 2026-10).
// GEMINI_MODEL has no default on purpose: pick a current model from Google's model list.
import { readFile } from 'node:fs/promises';
import { need } from './config.js';
import { containsPriceFigure } from './rules.js';

const QUALIFIED_MD = new URL('./knowledge/qualified.md', import.meta.url);
let rubricCache;
async function rubric() {
  rubricCache ??= await readFile(QUALIFIED_MD, 'utf8');
  return rubricCache;
}

async function generate({ system, user, schema }) {
  const model = need('GEMINI_MODEL');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': need('GEMINI_API_KEY') },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema }
    }),
    signal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS ?? 15000))
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) throw new Error(`Gemini returned no text (finishReason=${body?.candidates?.[0]?.finishReason ?? 'unknown'})`);
  const u = body.usageMetadata ?? {};
  return {
    json: JSON.parse(text),
    usage: { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0 }
  };
}

const STATUS = { type: 'STRING', enum: ['pass', 'fail', 'unclear'] };
const CRIT = {
  type: 'OBJECT',
  properties: { status: STATUS, evidence: { type: 'STRING' } },
  required: ['status', 'evidence']
};

const DECISION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    criteria: {
      type: 'OBJECT',
      properties: { real_project: CRIT, service_area: CRIT, timeline: CRIT, budget: CRIT, decision_maker: CRIT },
      required: ['real_project', 'service_area', 'timeline', 'budget', 'decision_maker']
    },
    extracted: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', nullable: true },
        area: { type: 'STRING', nullable: true },
        property_type: { type: 'STRING', nullable: true },
        project_category: { type: 'STRING', enum: ['home', 'office', 'clinic_studio', 'restaurant_hotel_retail', 'gym', 'advisory_only', 'other'] },
        size_sqft: { type: 'NUMBER', nullable: true },
        scope: { type: 'STRING', nullable: true },
        timeline_text: { type: 'STRING', nullable: true },
        needed_by_weeks: { type: 'NUMBER', nullable: true },
        budget_text: { type: 'STRING', nullable: true },
        referrer: { type: 'STRING', nullable: true },
        decision_maker_note: { type: 'STRING', nullable: true }
      }
    },
    existing_client_complaint: { type: 'BOOLEAN' },
    asking_price: { type: 'BOOLEAN' },
    availability_given: { type: 'BOOLEAN' },
    call_complete: { type: 'BOOLEAN' },
    next_question: { type: 'STRING', nullable: true },
    summary: { type: 'STRING' }
  },
  required: ['criteria', 'extracted', 'existing_client_complaint', 'asking_price', 'availability_given', 'call_complete', 'summary']
};

/** Decide on the transcript so far. `history` is a short text about earlier calls from this number (no phone number). */
export async function decide({ transcript, history = '' }) {
  const system = [
    "You are the decision layer for Aangan Studio's phone enquiry agent. Decide using ONLY the rubric below.",
    'Rubric (Nikhil Deshpande, studio founder):',
    await rubric(),
    '',
    'Rules for your output:',
    '- Score each of the five criteria as pass, fail or unclear, with a short evidence note that quotes or paraphrases the caller.',
    '- Use "unclear" when the caller has not said enough. Never guess. Budget and decision_maker are only "fail" when the rubric says so.',
    '- A budget that nobody mentioned is "unclear", not "fail".',
    '- extracted.project_category is a label for the kind of space, nothing more. Do not let it change your criteria scores.',
    '- Set existing_client_complaint true only when the caller is an existing client complaining about an ongoing project.',
    '- Set asking_price true ONLY when the caller\'s most recent message asks what it costs. If they asked earlier and the conversation has moved on, set it false.',
    '- Set availability_given true only when the caller has said when they are free for a first consultation (days or times), or said any time works. Otherwise false.',
    '- next_question: ONE direct question for the first unclear criterion among real_project, service_area, timeline. Never mention any price, rate or number of rupees.',
    '- needed_by_weeks: weeks from now until the caller needs the work finished, only if they stated a date or event; otherwise null.',
    '- Do not include the caller\'s phone number anywhere.'
  ].join('\n');
  const user = `Earlier calls from this number:\n${history || 'None.'}\n\nTranscript so far:\n${transcript}`;
  return generate({ system, user, schema: DECISION_SCHEMA });
}

const NOTE_SCHEMA = { type: 'OBJECT', properties: { note: { type: 'STRING' } }, required: ['note'] };

/** Designer handoff note: everything the front desk would have asked, so the designer does not ask again. */
export async function writeHandoffNote({ transcript, decision, flags, route }) {
  const system = [
    'Write a handoff note for an interior designer at Aangan Studio, in plain English, under 120 words.',
    'Include: who, where (area), property type and size, scope, current state, timeline, who decides, budget if the caller volunteered it, referrer, and what the caller asked for.',
    'End with a line "Uncertain:" listing anything not confirmed. Never state or estimate any price or rate.',
    `Route: ${route}. Flags: ${(flags ?? []).join(', ') || 'none'}.`
  ].join('\n');
  const user = `Decision facts:\n${JSON.stringify(decision?.extracted ?? {})}\n\nTranscript:\n${transcript}`;
  return generate({ system, user, schema: NOTE_SCHEMA });
}

const SLOT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    chosen_start: { type: 'STRING', nullable: true },
    alternates: { type: 'ARRAY', items: { type: 'STRING' } },
    visit_type: { type: 'STRING', enum: ['site_visit', 'phone'] },
    stated_availability: { type: 'STRING' },
    reason: { type: 'STRING' }
  },
  required: ['chosen_start', 'alternates', 'visit_type', 'stated_availability', 'reason']
};

/** Post-call: read the transcript for availability and pick from the open slots Cal.com returned. Never invents a time. */
export async function pickSlot({ transcript, slotsByType, nowIso, timeZone }) {
  const system = [
    'You schedule a first consultation for Aangan Studio from a call transcript.',
    `Current time: ${nowIso} (UTC), which is ${new Date(nowIso).toLocaleString('en-IN', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })} in the caller's time zone (${timeZone}). Resolve words like today, tomorrow and this weekend in that local time.`,
    'Open slots are given separately for site_visit and phone. Choose chosen_start ONLY from the list that matches the visit_type you pick, copied exactly. If none fits what the caller said, set chosen_start to null and list up to two alternates, also copied exactly.',
    'Honour any stated availability (days, times, "weekends only", "after 6pm"). The local time after each ISO value is already in the caller\'s time zone: judge by that local time and never convert. Prefer the earliest slot that fits.',
    'visit_type is site_visit for bare flats, villas, large homes and offices, or when the caller asked for a site visit; otherwise phone.',
    'stated_availability: what the caller said about when they are free, in their words, or "none stated".'
  ].join('\n');
  // Each slot is shown with its local time so the model never converts time zones. It must still return the ISO value.
  const label = (iso) =>
    `${iso} = ${new Date(iso).toLocaleString('en-IN', { timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true })}`;
  const user =
    `Open site_visit slots (ISO value = local time):\n${slotsByType.site_visit.map(label).join('\n') || 'none'}\n\n` +
    `Open phone slots (ISO value = local time):\n${slotsByType.phone.map(label).join('\n') || 'none'}\n\nTranscript:\n${transcript}`;
  return generate({ system, user, schema: SLOT_SCHEMA });
}

// ---- In-call speech and confirmation judging ---------------------------------------------------------------
const AGENT_PROMPT_MD = new URL('../vaani/AGENT_PROMPT.md', import.meta.url);
let promptCache;
async function agentPrompt() {
  if (!promptCache) {
    // The speaking model must never even see a price. Drop every line of the studio docs that carries a figure or a cost ratio.
    const raw = await readFile(AGENT_PROMPT_MD, 'utf8');
    promptCache = raw
      .split(/\r?\n/)
      .filter((l) => !containsPriceFigure(l) && !/\b\d+\s*[x×]/i.test(l) && !l.includes('₹'))
      .join('\n');
  }
  return promptCache;
}

const SPEAK_SCHEMA = { type: 'OBJECT', properties: { reply: { type: 'STRING' } }, required: ['reply'] };

/** What the phone agent says next. The route and directive come from our decision and rules, never from this call. */
export async function speak({ transcript, directive }) {
  const user =
    `Conversation so far:\n${transcript}\n\nSYSTEM DIRECTIVE (follow it exactly):\n${directive}\n\n` +
    'Write only what the agent says next: one to three short spoken sentences, in the caller\'s language.';
  return generate({ system: await agentPrompt(), user, schema: SPEAK_SCHEMA });
}

const CONFIRM_SCHEMA = {
  type: 'OBJECT',
  properties: { outcome: { type: 'STRING', enum: ['confirmed', 'wants_other_time', 'declined', 'unclear'] }, note: { type: 'STRING' } },
  required: ['outcome', 'note']
};

/** Reads the transcript of our confirmation call. */
export async function judgeConfirmation({ transcript }) {
  const system =
    'You read the transcript of a short call in which Aangan Studio asked a customer to confirm a consultation time. ' +
    'outcome: confirmed (customer accepted the time), wants_other_time (customer asked for a different time), declined (no longer interested), unclear (no real answer, voicemail or call cut). ' +
    'note: one sentence for the front desk, including any new time the customer asked for. Never mention prices.';
  return generate({ system, user: `Transcript:\n${transcript}`, schema: CONFIRM_SCHEMA });
}
