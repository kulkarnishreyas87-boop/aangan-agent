// Rules check: hard limits that live in code, not in Gemini's judgement.
// Source of every rule is Nikhil's qualified.md and services.md. Nothing here is invented.

export const CRITERIA = ['real_project', 'service_area', 'timeline', 'budget', 'decision_maker'];

// services.md: "Service area" section, plus areas the front desk accepted in the September transcripts.
const AREAS_IN = [
  'pune', 'pcmc', 'pimpri', 'chinchwad', 'kothrud', 'dahanukar', 'baner', 'aundh', 'wakad', 'koregaon park',
  'kalyani nagar', 'viman nagar', 'hadapsar', 'magarpatta', 'nibm', 'kondhwa', 'undri', 'shivane', 'warje',
  'erandwane', 'deccan', 'pimple saudagar', 'pimple nilakh', 'ravet', 'hinjewadi', 'kharadi', 'nanded city'
];
// services.md: "We do not currently serve Talegaon, Lonavala, Nashik, Mumbai, or other cities outside this area."
const AREAS_OUT = ['talegaon', 'lonavala', 'nashik', 'mumbai'];

// services.md "What we don't do": restaurants, hotels, retail stores, gyms. qualified.md has no criterion for this,
// so Gemini only EXTRACTS a project_category and the rules check enforces the exclusion.
const OUT_OF_SCOPE_CATEGORIES = ['restaurant_hotel_retail', 'gym'];

// services.md: "we cannot begin execution on a project that needs to be ready in under 6 weeks from today."
// qualified.md asks for 8-10 weeks; Gemini applies that judgement. Code only enforces the hard floor.
export const HARD_LEAD_TIME_WEEKS = 6;

// Approved pricing line (pricing.md), adjusted for this system: the agent does not book a time on the call, so the booking
// clause is replaced by the after-call confirmation.
export const PRICE_DEFLECTION =
  'Pricing depends on the site, the materials you choose, and the scope. Your designer will walk you through it in detail at the consultation, and we will confirm a time with you after this call.';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const hasToken = (hay, list) => list.some((t) => ` ${hay} `.includes(` ${t} `));

/** 'in' | 'out' | 'unknown' for a free-text location. */
export function classifyArea(text) {
  const n = norm(text);
  if (!n) return 'unknown';
  if (hasToken(n, AREAS_OUT)) return 'out';
  if (hasToken(n, AREAS_IN)) return 'in';
  return 'unknown';
}

const NUMBER_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
const PRICE_RE = new RegExp(
  [
    '₹',
    '\\brs\\.?\\s?\\d',
    '\\binr\\b',
    '\\brupees?\\b',
    '\\d[\\d,.]*\\s*(?:lakh|lac|lakhs|lacs|crore|crores|cr|thousand|million|k|l)\\b', // 8 lakh, 50k, 5L, 2 crore
    '\\b' + NUMBER_WORD + '(?:[\\s-]+' + NUMBER_WORD + ')*\\s+(?:lakh|lac|lakhs|lacs|crore|crores|thousand)\\b', // five lakh, fifty thousand
    '\\b\\d{2,3}(?:,\\d{2,3})+\\b', // 15,000 and 1,50,000 (1,400 sq ft is not matched)
    '(?:रुपये|रुपए|रू\\.?|लाख|हज़ार|हजार|करोड)', // Hindi and Marathi
    '\\bper\\s*sq\\.?\\s*(?:ft|feet|foot)\\b',
    '\\/\\s*sq\\.?\\s*ft',
    '\\bsq\\.?\\s*ft\\.?\\s*(?:rate|cost|price)\\b',
    '\\b\\d+\\s*[x×]\\s*(?:the\\s+)?(?:cost|price)\\b', // "3x the cost"
    '\\b(?:twice|double|triple|\\w+\\s+times)\\s+(?:the\\s+)?(?:cost|price)\\b' // "three times the cost"
  ].join('|'),
  'i'
);

/** The caller's latest turn: the unbroken run of USER lines at the end of the transcript (Vaani splits one breath into several lines). */
export function lastUserBlock(transcript) {
  const lines = String(transcript ?? '').split(/\r?\n/).filter((l) => l.trim());
  const out = [];
  for (let i = lines.length - 1; i >= 0 && /^\s*USER\s*:/i.test(lines[i]); i--) out.unshift(lines[i].replace(/^\s*USER\s*:\s*/i, ''));
  return out.join(' ').trim();
}

const PRICE_ASK_RE = new RegExp(
  [
    '\\b(?:cost|costs|costing|price|prices|pricing|priced|rate|rates|charge|charges|charged|fee|fees|quote|quotation|estimate|how much)\\b',
    '\\b(?:kitna|kitne|kitni|kharcha|kharch|kimat|kimmat|paise|paisa|daam|dam|bhav|kiti|kimmat|kharch)\\b',
    '(?:कितना|कितने|कितनी|खर्च|खर्चा|कीमत|किंमत|दाम|भाव|पैसे|पैसा|रेट|किती|शुल्क)'
  ].join('|'),
  'i'
);
/** Did the caller's latest turn ask about money? Decided here, not by the model: a question about language or timing must never get the pricing line. */
export const asksAboutPrice = (text) => PRICE_ASK_RE.test(String(text ?? ''));

/** True when text contains something that reads like a price, rate or cost ratio. Used on every string we hand to the voice agent. */
export function containsPriceFigure(text) {
  return PRICE_RE.test(String(text ?? ''));
}

/**
 * Remove only the sentences that carry a price, keep the rest (so a goodbye survives), and put the approved line first.
 * Replacing the whole reply would cut off a call mid-farewell.
 */
export function scrubPrice(text) {
  const t = String(text ?? '');
  if (!containsPriceFigure(t)) return t;
  const kept = t.split(/(?<=[.!?।])\s+/).filter((s) => !containsPriceFigure(s)).join(' ').trim();
  return kept.includes('Pricing depends') ? kept : [PRICE_DEFLECTION, kept].filter(Boolean).join(' ');
}

/**
 * Normalise Gemini's criteria and apply the hard overrides.
 * status: 'pass' | 'fail' | 'unclear'
 */
export function applyHardRules(decision) {
  const crit = {};
  for (const k of CRITERIA) {
    const c = decision?.criteria?.[k] ?? {};
    crit[k] = { status: ['pass', 'fail', 'unclear'].includes(c.status) ? c.status : 'unclear', evidence: c.evidence ?? '' };
  }
  const x = decision?.extracted ?? {};
  const overrides = [];

  const area = classifyArea(x.area);
  if (area === 'out' && crit.service_area.status !== 'fail') {
    crit.service_area = { status: 'fail', evidence: `Location "${x.area}" is outside Pune and PCMC (services.md).` };
    overrides.push('service_area:out_list');
  } else if (area === 'in' && crit.service_area.status !== 'pass') {
    crit.service_area = { status: 'pass', evidence: `Location "${x.area}" is on the service-area list (services.md).` };
    overrides.push('service_area:in_list');
  }

  if (OUT_OF_SCOPE_CATEGORIES.includes(x.project_category) && crit.real_project.status !== 'fail') {
    crit.real_project = { status: 'fail', evidence: `Project type "${x.project_category}" is outside what the studio does (services.md).` };
    overrides.push('real_project:out_of_scope_category');
  }

  const w = x.needed_by_weeks;
  if (typeof w === 'number' && w > 0 && w < HARD_LEAD_TIME_WEEKS && crit.timeline.status !== 'fail') {
    crit.timeline = { status: 'fail', evidence: `Needs the project ready in about ${w} weeks; minimum lead time is ${HARD_LEAD_TIME_WEEKS} weeks (services.md).` };
    overrides.push('timeline:under_hard_floor');
  }
  return { criteria: crit, overrides };
}

/**
 * Route from qualified.md:
 *  - existing-client complaint -> ESCALATE (services/escalation, not a lead)
 *  - any criterion fails -> DECLINE gracefully (do not forward)
 *  - criteria 1-3 unclear -> CLARIFY with one direct question
 *  - criteria 4-5 unclear -> QUALIFY, uncertainty noted in the handoff note
 *  - all pass -> QUALIFY
 * After maxClarify questions with criteria 1-3 still unclear, a human takes over (LOG_ONLY + email task).
 */
export function deriveRoute(decision, { clarifyCount = 0, maxClarify = 3 } = {}) {
  const { criteria, overrides } = applyHardRules(decision);
  const fails = CRITERIA.filter((k) => criteria[k].status === 'fail');
  const unclearCore = ['real_project', 'service_area', 'timeline'].filter((k) => criteria[k].status === 'unclear');
  const unclearSoft = ['budget', 'decision_maker'].filter((k) => criteria[k].status === 'unclear');

  let route;
  let askAbout = null;
  if (decision?.existing_client_complaint) route = 'ESCALATE';
  else if (fails.length > 0) route = 'DECLINE';
  else if (unclearCore.length > 0) {
    if (clarifyCount >= maxClarify) route = 'LOG_ONLY';
    else { route = 'CLARIFY'; askAbout = unclearCore[0]; }
  } else route = 'QUALIFY';

  return {
    route,
    criteria,
    overrides,
    reasonCodes: route === 'DECLINE' ? fails : [],
    askAbout,
    flags: route === 'QUALIFY' ? unclearSoft : [],
    deflectPrice: Boolean(decision?.asking_price)
  };
}
