import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlainQuestion } from '../src/byol.js';

test('a clarifying question with no price is spoken straight from the decision call', () => {
  assert.equal(isPlainQuestion({ route: 'CLARIFY', question: 'Which area is it in?', deflect_price: false }), true);
});
test('a price question still goes through the full speech model', () => {
  assert.equal(isPlainQuestion({ route: 'CLARIFY', question: 'Which area?', deflect_price: true }, {}), false);
  assert.equal(isPlainQuestion({ route: 'CLARIFY', question: 'Which area?', deflect_price: true }, { priceDeflected: true }), true);
});
test('other routes and empty questions never take the fast path', () => {
  assert.equal(isPlainQuestion({ route: 'QUALIFY', question: 'x' }), false);
  assert.equal(isPlainQuestion({ route: 'DECLINE', question: 'x' }), false);
  assert.equal(isPlainQuestion({ route: 'CLARIFY', question: '  ' }), false);
  assert.equal(isPlainQuestion({ route: 'CLARIFY', question: null }), false);
});

import { directiveFor } from '../src/byol.js';
test('the agent does not hang up on a caller who is still asking something', () => {
  const asking = directiveFor({ route: 'LOG_ONLY', reason_codes: [], caller_question: true }, {});
  assert.equal(asking.endCall, false);
  assert.match(asking.directive, /Do NOT end the call/);
  const pricing = directiveFor({ route: 'LOG_ONLY', reason_codes: [], deflect_price: true }, {});
  assert.equal(pricing.endCall, false);
});
test('with nothing pending, a hand-over still ends warmly and summarises what was understood', () => {
  const done = directiveFor({ route: 'LOG_ONLY', reason_codes: [] }, {});
  assert.equal(done.endCall, true);
  assert.match(done.directive, /what you understood/);
});
test('a clarifying turn that carries a caller question answers first', () => {
  const d = directiveFor({ route: 'CLARIFY', question: 'Which area?', caller_question: true }, {});
  assert.match(d.directive, /Answer it first/);
});

import { asksAboutPrice, lastUserBlock } from '../src/rules.js';
test('only a question about money counts as a price question', () => {
  assert.equal(asksAboutPrice('But I wanted to inquire about this cost.'), true);
  assert.equal(asksAboutPrice('How much would it be for a 2 BHK?'), true);
  assert.equal(asksAboutPrice('kitna kharcha aayega'), true);
  assert.equal(asksAboutPrice('मला किंमत सांगा'), true);
  assert.equal(asksAboutPrice('I know. But do you speak Marathi?'), false);
  assert.equal(asksAboutPrice('Listen. Listen. Listen.'), false);
  assert.equal(asksAboutPrice('I want to redo my two BHK in Baner'), false);
});
test('the latest caller turn is the unbroken run of USER lines at the end', () => {
  assert.equal(lastUserBlock('AGENT: Hi\nUSER: hello\nAGENT: Which area?\nUSER: Baner\nUSER: near the road'), 'Baner near the road');
  assert.equal(lastUserBlock('USER: hi\nAGENT: bye'), '');
});
