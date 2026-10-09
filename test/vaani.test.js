import test from 'node:test';
import assert from 'node:assert/strict';
process.env.VAANI_WEBHOOK_SECRET = 'path-secret-test';
process.env.VAANI_BYOL_TOKEN = 'byol-token-test';
const vaani = await import('../src/vaani.js');
const { directiveFor, toTranscript } = await import('../src/byol.js');

test('webhook path secret: right one passes, wrong or empty fails', () => {
  assert.equal(vaani.verifyPathSecret('path-secret-test'), true);
  assert.equal(vaani.verifyPathSecret('path-secret-tesT'), false);
  assert.equal(vaani.verifyPathSecret(''), false);
  assert.equal(vaani.verifyPathSecret(undefined), false);
});

test('BYOL bearer token: exact match only', () => {
  assert.equal(vaani.verifyByolToken('Bearer byol-token-test'), true);
  assert.equal(vaani.verifyByolToken('byol-token-test'), false);
  assert.equal(vaani.verifyByolToken('Bearer wrong'), false);
  assert.equal(vaani.verifyByolToken(undefined), false);
});

test('call id is read from either payload spelling', () => {
  assert.equal(vaani.callIdOf({ call_id: 'c1' }), 'c1');
  assert.equal(vaani.callIdOf({ room_name: 'r1' }), 'r1');
  assert.equal(vaani.callIdOf({ data: { room_name: 'r2' } }), 'r2');
  assert.equal(vaani.callIdOf({}), '');
});

test('call_postprocessing: duration is milliseconds, transcript and number are picked up', () => {
  const e = vaani.parseEvent({ event: 'call_postprocessing', call_id: 'c9', timestamp: '2026-10-12T10:00:00Z', data: { room_name: 'c9', call_duration: 55150.02, transcript: 'AGENT: hi\nUSER: hello' } });
  assert.equal(e.durationS, 55);
  assert.equal(e.callId, 'c9');
  assert.match(e.transcript, /USER: hello/);
  const s = vaani.parseEvent({ event: 'call_ended', room_name: 'c9', call_duration: 42.5 });
  assert.equal(s.durationS, 43); // call_ended is in seconds
  assert.equal(vaani.parseEvent({ event: 'call_started', room_name: 'c9', phone_number: '+911234567890' }).phone, '+911234567890');
});

test('BYOL transcript: system turn dropped, roles labelled for the decision model', () => {
  const t = toTranscript([{ role: 'system', content: 'prompt' }, { role: 'assistant', content: 'Good morning' }, { role: 'user', content: 'I want a redesign' }, { role: 'user', content: '  ' }]);
  assert.equal(t, 'AGENT: Good morning\nUSER: I want a redesign');
});

test('directive: clarify asks one question and keeps the call open', () => {
  const d = directiveFor({ route: 'CLARIFY', ask_about: 'timeline', question: 'When would you like it done?', reason_codes: [], deflect_price: false });
  assert.equal(d.endCall, false);
  assert.match(d.directive, /exactly one question/);
});

test('directive: qualify asks availability first, re-asks if not answered, wraps up once given', () => {
  const r = { route: 'QUALIFY', reason_codes: [], deflect_price: false, availability_given: false };
  const first = directiveFor(r, { askedAvailability: false });
  assert.equal(first.endCall, false);
  assert.match(first.directive, /Do NOT offer or book a specific time/);
  const noAnswer = directiveFor(r, { askedAvailability: true, availabilityAsks: 1 });
  assert.equal(noAnswer.endCall, false, 'a caller who has not answered must not be hung up on');
  assert.match(noAnswer.directive, /ask again/i);
  const answered = directiveFor({ ...r, availability_given: true }, { askedAvailability: true, availabilityAsks: 1 });
  assert.equal(answered.endCall, true);
  const gaveUp = directiveFor(r, { askedAvailability: true, availabilityAsks: 2 });
  assert.equal(gaveUp.endCall, true, 'after two asks we wrap up anyway');
});

test('directive: decline, escalate and log-only end the call', () => {
  for (const route of ['DECLINE', 'ESCALATE', 'LOG_ONLY']) assert.equal(directiveFor({ route, reason_codes: ['service_area'], deflect_price: false }).endCall, true, route);
  assert.match(directiveFor({ route: 'DECLINE', reason_codes: ['service_area'] }).directive, /Pune and Pimpri-Chinchwad/);
});

test('directive: a price question carries the approved line and no number', () => {
  const d = directiveFor({ route: 'CLARIFY', ask_about: 'service_area', question: null, reason_codes: [], deflect_price: true });
  assert.match(d.directive, /Pricing depends on the site/);
  assert.doesNotMatch(d.directive, /₹|lakh|per sq/i);
});

test('required environment list names every service and reports what is missing', async () => {
  const { REQUIRED_ENV, missingEnv } = await import('../src/env-check.js');
  assert.ok(['DATABASE_URL', 'GEMINI_API_KEY', 'VAANI_BYOL_TOKEN', 'RESEND_API_KEY', 'CALCOM_API_KEY', 'HUBSPOT_ACCESS_TOKEN'].every((k) => REQUIRED_ENV.includes(k)));
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  assert.ok(missingEnv().includes('GEMINI_API_KEY'));
  if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
});

test('Vercel rewrite: the original path is restored from the __p parameter', async () => {
  const { restoreUrl } = await import('../src/url.js');
  const a = { url: '/api/server?__p=vaani%2Fllm%2Fabc' };
  assert.equal(restoreUrl(a), '/vaani/llm/abc');
  const b = { url: '/api/server?__p=lead/won&id=5&sig=xyz' };
  assert.equal(restoreUrl(b), '/lead/won?id=5&sig=xyz');
  const c = { url: '/health' };
  assert.equal(restoreUrl(c), '/health', 'a normal Node host is left alone');
  const d = { url: '/api/server' };
  assert.equal(restoreUrl(d), '/api/server', 'no __p means nothing to restore');
});

test('directive: the price line is said once, then not repeated on later turns', () => {
  const r = { route: 'CLARIFY', ask_about: 'timeline', question: 'When do you want it done?', reason_codes: [], deflect_price: true };
  assert.match(directiveFor(r, { priceDeflected: false }).directive, /Pricing depends on the site/);
  assert.doesNotMatch(directiveFor(r, { priceDeflected: true }).directive, /Pricing depends/);
});

test('directive: a caller who already gave their availability is wrapped up, not asked again', () => {
  const r = { route: 'QUALIFY', reason_codes: [], deflect_price: false, availability_given: true };
  const d = directiveFor(r, { askedAvailability: false });
  assert.equal(d.endCall, true);
  assert.doesNotMatch(d.directive, /ask when|when they are free/i);
});
