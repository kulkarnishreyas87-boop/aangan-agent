import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ACTION_LINK_SECRET = 'test-secret-not-real';
process.env.PUBLIC_BASE_URL = 'https://example.test/';
const email = await import('../src/email.js');

test('action link verifies for the same id and action', () => {
  const url = new URL(email.actionLink(42, 'won'));
  assert.equal(url.origin + url.pathname, 'https://example.test/lead/won');
  assert.equal(email.verifyAction(42, 'won', url.searchParams.get('sig')), true);
});

test('a link cannot be reused for another lead or another action', () => {
  const sig = new URL(email.actionLink(42, 'won')).searchParams.get('sig');
  assert.equal(email.verifyAction(43, 'won', sig), false);
  assert.equal(email.verifyAction(42, 'lost', sig), false);
  assert.equal(email.verifyAction(42, 'won', sig.slice(0, -1) + 'x'), false);
  assert.equal(email.verifyAction(42, 'delete', sig), false);
  assert.equal(email.verifyAction(42, 'won', ''), false);
});
