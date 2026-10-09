// Rules check tested against the real September 2026 phone transcripts (T01-T20).
// The Gemini output is hand-written to match what the transcript says. These tests prove the ROUTING and the
// hard limits. They do not prove Gemini scores the criteria correctly: that needs a live Gemini key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRoute, classifyArea, containsPriceFigure, scrubPrice, PRICE_DEFLECTION } from '../src/rules.js';

const P = (evidence = '') => ({ status: 'pass', evidence });
const F = (evidence = '') => ({ status: 'fail', evidence });
const U = (evidence = '') => ({ status: 'unclear', evidence });

const base = (over = {}) => ({
  criteria: { real_project: P(), service_area: P(), timeline: P(), budget: U(), decision_maker: P() },
  extracted: { project_category: 'home', area: 'Kothrud', needed_by_weeks: null },
  existing_client_complaint: false,
  asking_price: false,
  call_complete: true,
  summary: '',
  ...over
});

test('T01 full 3BHK redo in Kothrud, owners on the call: QUALIFY, budget unclear is only a flag', () => {
  const v = deriveRoute(base());
  assert.equal(v.route, 'QUALIFY');
  assert.deepEqual(v.flags, ['budget']);
});

test('T03 Nashik home office: DECLINE on service area (area list overrides a wrong pass)', () => {
  const v = deriveRoute(base({ extracted: { project_category: 'home', area: 'Nashik' } }));
  assert.equal(v.route, 'DECLINE');
  assert.deepEqual(v.reasonCodes, ['service_area']);
});

test('T04 advice only: DECLINE on real_project', () => {
  const v = deriveRoute(base({ criteria: { ...base().criteria, real_project: F('wants colour and furniture suggestions only') } }));
  assert.equal(v.route, 'DECLINE');
  assert.deepEqual(v.reasonCodes, ['real_project']);
});

test('T07 wants it before Diwali, about 3 weeks: DECLINE on timeline (hard floor overrides a wrong pass)', () => {
  const v = deriveRoute(base({ extracted: { project_category: 'home', area: 'Pune', needed_by_weeks: 3 } }));
  assert.equal(v.route, 'DECLINE');
  assert.deepEqual(v.reasonCodes, ['timeline']);
});

test('T09 existing client complaint: ESCALATE, never a lead', () => {
  const v = deriveRoute(base({ existing_client_complaint: true }));
  assert.equal(v.route, 'ESCALATE');
});

test('T10 Rs 1 to 1.5 lakh for kitchen and bedroom: DECLINE on budget (Gemini marks it fail per qualified.md)', () => {
  const v = deriveRoute(base({ criteria: { ...base().criteria, budget: F('volunteered 1 to 1.5 lakh for two rooms with execution') } }));
  assert.equal(v.route, 'DECLINE');
  assert.deepEqual(v.reasonCodes, ['budget']);
});

test('T12 villa, timeline not yet stated: CLARIFY with one question about timeline', () => {
  const v = deriveRoute(base({ criteria: { ...base().criteria, timeline: U() } }));
  assert.equal(v.route, 'CLARIFY');
  assert.equal(v.askAbout, 'timeline');
});

test('T14 son calling for parents: decision_maker unclear still QUALIFY with a flag', () => {
  const v = deriveRoute(base({ criteria: { ...base().criteria, decision_maker: U('son doing initial checking') } }));
  assert.equal(v.route, 'QUALIFY');
  assert.ok(v.flags.includes('decision_maker'));
});

test('T19 restaurant in Koregaon Park: DECLINE even though no qualified.md criterion mentions it', () => {
  const v = deriveRoute(base({ extracted: { project_category: 'restaurant_hotel_retail', area: 'Koregaon Park' } }));
  assert.equal(v.route, 'DECLINE');
  assert.deepEqual(v.reasonCodes, ['real_project']);
});

test('Gym is declined the same way', () => {
  assert.equal(deriveRoute(base({ extracted: { project_category: 'gym', area: 'Kothrud' } })).route, 'DECLINE');
});

test('Two fails still decline (qualified.md boundary rule)', () => {
  const v = deriveRoute(base({ extracted: { project_category: 'home', area: 'Mumbai', needed_by_weeks: 2 } }));
  assert.equal(v.route, 'DECLINE');
  assert.deepEqual(v.reasonCodes.sort(), ['service_area', 'timeline']);
});

test('After maxClarify questions a human takes over instead of looping forever', () => {
  const d = base({ criteria: { ...base().criteria, timeline: U() } });
  assert.equal(deriveRoute(d, { clarifyCount: 2, maxClarify: 3 }).route, 'CLARIFY');
  assert.equal(deriveRoute(d, { clarifyCount: 3, maxClarify: 3 }).route, 'LOG_ONLY');
});

test('Malformed Gemini output degrades to unclear, never to a silent pass', () => {
  const v = deriveRoute({ criteria: { real_project: { status: 'maybe' } }, extracted: {} });
  assert.equal(v.route, 'CLARIFY');
});

test('Area list: Hinjewadi in, Talegaon out, an unknown place stays unknown', () => {
  assert.equal(classifyArea('Hinjewadi Phase 1'), 'in');
  assert.equal(classifyArea('Talegaon Dabhade'), 'out');
  assert.equal(classifyArea('Somewhere new'), 'unknown');
});

test('Price filter catches figures and rates, and leaves normal sentences alone', () => {
  for (const bad of ['It will be around ₹2,000 per sq ft', 'about 8 lakh', 'Rs. 5000', 'our rate per sq ft is', '1.5 lakhs']) {
    assert.equal(containsPriceFigure(bad), true, bad);
  }
  for (const ok of ['Which area is the flat in?', 'We take 8 to 10 weeks for a room', 'A 3BHK of 1,400 sq ft carpet']) {
    assert.equal(containsPriceFigure(ok), false, ok);
  }
  assert.equal(scrubPrice('around 8 lakh'), PRICE_DEFLECTION);
});

test('Price filter catches spelled-out, abbreviated and Hindi or Marathi amounts', () => {
  for (const bad of ['five lakh', 'fifty thousand rupees', 'around 50k', 'a 5L budget', '15,000', '1,50,000', 'three times the cost', 'twice the price', '3x the cost', 'पाच लाख', 'दो हजार रुपये', 'it costs 2 crore']) {
    assert.equal(containsPriceFigure(bad), true, bad);
  }
});

test('Price filter leaves sizes, times and phone numbers alone', () => {
  for (const ok of ['A 3BHK of 1,400 sq ft carpet', 'a 2,500 sq ft office', 'We will call at 10:30 am', 'Your number is 9999900001', 'You can reach us after six', 'a 4 bedroom villa']) {
    assert.equal(containsPriceFigure(ok), false, ok);
  }
});

test('Scrubbing removes only the priced sentence, so a goodbye is not cut off', () => {
  const out = scrubPrice('Sure thing. The cost is about 8 lakh. Thanks for calling, goodbye!');
  assert.match(out, /^Pricing depends on the site/);
  assert.match(out, /goodbye!$/);
  assert.doesNotMatch(out, /lakh/);
  assert.equal(scrubPrice('Which area is the flat in?'), 'Which area is the flat in?');
});
