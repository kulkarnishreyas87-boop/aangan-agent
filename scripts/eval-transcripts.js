// Live check of the decision step against the September phone transcripts (T01-T20).
// Usage: node --env-file=.env scripts/eval-transcripts.js <enquiries.txt> [model ...]
// Costs a few cents of Gemini usage. The expected routes are the reviewer's reading of each call, not ground truth from the studio.
import { readFileSync } from 'node:fs';
import { decide } from '../src/gemini.js';
import { deriveRoute } from '../src/rules.js';

const [file, ...models] = process.argv.slice(2);
const text = readFileSync(file, 'utf8').split('SECTION 2')[0];
const parts = text.split(/\n(?=T\d\d\s)/).filter((b) => /^T\d\d\s/.test(b));
const calls = parts.map((b) => ({ id: b.slice(0, 3), body: b.replace(/\s*\n\s*/g, '\n').trim() }));

const EXPECT = { T01: 'QUALIFY', T02: 'QUALIFY', T03: 'DECLINE', T04: 'DECLINE', T05: 'QUALIFY', T06: 'QUALIFY', T07: 'DECLINE',
  T09: 'ESCALATE', T10: 'DECLINE', T11: 'QUALIFY', T12: 'QUALIFY', T13: 'QUALIFY', T14: 'QUALIFY', T15: 'QUALIFY', T17: 'QUALIFY',
  T19: 'DECLINE', T20: 'QUALIFY' }; // T08 missed call, T16 and T18 are judgement calls: shown, not scored

for (const model of models) {
  process.env.GEMINI_MODEL = model;
  let ok = 0, scored = 0, ms = 0;
  console.log(`\n=== ${model} ===`);
  for (const c of calls) {
    if (c.id === 'T08') continue;
    const t0 = Date.now();
    try {
      const { json } = await decide({ transcript: c.body, history: '' });
      const dt = Date.now() - t0; ms += dt;
      let v = deriveRoute(json, { clarifyCount: 0 });
      if (v.route === 'CLARIFY') v = { ...v, route: 'LOG_ONLY' };
      const want = EXPECT[c.id];
      const mark = want ? (v.route === want ? 'ok ' : 'XX ') : '-- ';
      if (want) { scored++; if (v.route === want) ok++; }
      const why = v.reasonCodes.join(',') || v.flags.join(',') || '';
      console.log(`${mark}${c.id} got ${v.route.padEnd(8)} want ${(want ?? '?').padEnd(8)} ${String(dt).padStart(5)}ms ${why} | ${json.criteria.real_project.status}/${json.criteria.service_area.status}/${json.criteria.timeline.status}/${json.criteria.budget.status}/${json.criteria.decision_maker.status}`);
    } catch (e) { console.log(`ERR ${c.id} ${e.message.slice(0, 160)}`); }
  }
  console.log(`${model}: ${ok}/${scored} scored calls match, avg ${Math.round(ms / calls.length)}ms per call`);
}
