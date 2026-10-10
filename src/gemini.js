// Gemini: the decision layer. It reads qualified.md only (Nikhil's rubric) and returns structured JSON.
// Endpoint and request shape follow https://ai.google.dev/api/generate-content (checked 2026-10).
// GEMINI_MODEL has no default on purpose: pick a current model from Google's model list.
import { readFile } from 'node:fs/promises';
import { need } from './config.js';
import { containsPriceFigure } from './rules.js';

/**
 * Time of day in the studio's time zone. The phone agent's opening line is fixed text in Vaani, so greetings that come from us
 * must follow the clock, not the persona prompt's "Good morning".
 */
export function timeOfDay(now = new Date(), timeZone = process.env.STUDIO_TIME_ZONE ?? 'Asia/Kolkata') {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
  const clock = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(now);
  const greeting = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 17 ? 'Good afternoon' : hour >= 17 || hour < 1 ? 'Good evening' : 'Hello';
  const part = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 21 ? 'evening' : 'night';
  return { hour, clock, greeting, part, label: `${clock}, ${part}` };
}

const QUALIFIED_MD =new URL('./knowledge/qualified.md', import.meta.url);
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
    caller_question: { type: 'BOOLEAN' },
    call_complete: { type: 'BOOLEAN' },
    next_question: { type: 'STRING', nullable: true },
    summary: { type: 'STRING' }
  },
  required: ['criteria', 'extracted', 'existing_client_complaint', 'asking_price', 'availability_given', 'caller_question', 'call_complete', 'summary']
};

/**
 * Live-call variant: statuses only, no evidence text and no summary. Roughly 40% fewer output tokens, and output tokens are what
 * the caller waits for. The end-of-call decision (full schema) is what the dashboard, the handoff and HubSpot use.
 */
const LITE_SCHEMA = (() => {
  const s = structuredClone(DECISION_SCHEMA);
  for (const k of Object.keys(s.properties.criteria.properties)) s.properties.criteria.properties[k] = { type: 'OBJECT', properties: { status: STATUS }, required: ['status'] };
  delete s.properties.summary;
  s.required = s.required.filter((r) => r !== 'summary');
  return s;
})();

/** Decide on the transcript so far. `history` is a short text about earlier calls from this number (no phone number). */
export async function decide({ transcript, history = '', lite = false }) {
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
    "- Set caller_question true when the caller's most recent message asks the studio something it should answer (what it does, how it works, how long things take, where it works, whether it can help with something), other than price. False for greetings, \"are you there?\", filler, and plain answers to our questions.",
    '- Set availability_given true only when the caller has said when they are free for a first consultation (days or times), or said any time works. Otherwise false.',
    lite
      ? "- next_question: the exact words the phone agent says next, in the caller's language: a warm, specific acknowledgment that shows you listened (use their own words, for example the place or the type of home they just named; if they asked how you are, answer that kindly first), then ONE short question for the first unclear criterion among real_project, service_area, timeline. At most two short sentences. Never mention any price, rate or number of rupees. This is mid-call: do not say good morning, good afternoon, good evening or good night." + ` (It is ${timeOfDay().label} in India now; only if the caller greets you first, you may return that greeting.)`
      : '- next_question: ONE direct question for the first unclear criterion among real_project, service_area, timeline. Never mention any price, rate or number of rupees.',
    '- needed_by_weeks: weeks from now until the caller needs the work finished, only if they stated a date or event; otherwise null.',
    "- The transcript comes from speech recognition: names and places are often misheard or misspelled. Read them generously and write extracted.area as the nearest real Pune or Pimpri-Chinchwad locality (for example 'Banir' or 'Baner' both mean Baner; 'Kotrud' means Kothrud). Judge criteria on what the caller most likely said, not on spelling.",
    '- Use EVERYTHING the caller has said anywhere in the transcript. Never ask again for something they already told you, even if it came earlier or in a broken sentence.',
    '- If the caller mentions a type of home (for example 2 BHK) and wants to redo, renovate or design it, real_project passes.',
    '- Do not end a conversation just because it is slow: callers answer in pieces. Only the rubric decides.',
    '- Do not include the caller\'s phone number anywhere.',
    '- Be brief: every evidence note at most 10 words, summary one sentence of at most 25 words. Shorter output means a faster reply.'
  ].join('\n');
  const user = `Earlier calls from this number:\n${history || 'None.'}\n\nTranscript so far:\n${transcript}`;
  return generate({ system, user, schema: lite ? LITE_SCHEMA : DECISION_SCHEMA });
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
  const t = timeOfDay();
  const conduct =
    '\n\nHOW TO TREAT THE CALLER (applies to every reply): you are a warm, patient front-desk person who genuinely listens. ' +
    'First respond to what the caller just said, using their own words (their area, their home, their worry). If they asked a question, answer it clearly and politely before anything else. ' +
    'If they ask how you are, answer kindly. If you did not catch something, apologise briefly and ask them to repeat it. ' +
    'Never rush them off the phone and never push them to "consult later" or "wait for a call-back" while they still have something to say or ask. ' +
    'Do not repeat a question they already answered. Short, natural sentences, no lists, no jargon.';
  const clock =
    `\n\nCURRENT TIME (overrides any greeting in the playbook): it is ${t.clock} in India, so the right greeting now is "${t.greeting}". ` +
    'The call has already been opened with a greeting, so do NOT greet again unless the caller greets you first, and never say "Good morning" unless that is the right greeting now.';
  return generate({ system: (await agentPrompt()) + conduct + clock, user, schema: SPEAK_SCHEMA });
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
