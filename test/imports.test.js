// Loads every module so a wrong named import or a syntax slip fails here instead of at 2am on a live call.
// Importing does not open any connection or need any environment variable.
import test from 'node:test';
import assert from 'node:assert/strict';

for (const m of ['config', 'rules', 'gemini', 'db', 'email', 'hubspot', 'calcom', 'vaani', 'pipeline', 'worker', 'http-server', 'url', 'background', 'env-check']) {
  test(`imports src/${m}.js`, async () => {
    const mod = await import(`../src/${m}.js`);
    assert.ok(Object.keys(mod).length > 0);
  });
}
