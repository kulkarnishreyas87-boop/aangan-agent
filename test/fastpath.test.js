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
