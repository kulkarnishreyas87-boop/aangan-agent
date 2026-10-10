// Times the two Gemini calls of one conversation turn. Usage: node --env-file=.env scripts/bench-turn.js
import { decide, speak } from '../src/gemini.js';
const t = 'AGENT: Good morning, Aangan Studio, How can I help you today?\nUSER: Good morning. I am Shayos and I want to redo my two BHK.\nAGENT: Good morning, Shayos. Which area is your property in?\nUSER: It is near Kothrud.';
const ms = async (f) => { const s = performance.now(); const r = await f(); return [Math.round(performance.now() - s), r]; };
for (let i = 0; i < 3; i++) {
  const [a, d] = await ms(() => decide({ transcript: t, lite: true }));
  const [b] = await ms(() => speak({ transcript: t, directive: 'Ask by when they want the work finished.' }));
  console.log(`run ${i + 1}: decide ${a} ms (${d.usage.output} out tokens), speak ${b} ms`);
}
