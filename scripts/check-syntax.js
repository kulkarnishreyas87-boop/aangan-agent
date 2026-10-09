// Parses every source file without running it (syntax only). The import test in test/ checks named exports.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

let bad = 0;
for (const dir of ['src', 'scripts', 'test']) {
  for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((n) => n.endsWith('.js'))) {
    const p = new URL(`../${dir}/${f}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    if (r.status !== 0) { bad++; console.error(`FAIL ${dir}/${f}\n${r.stderr}`); } else console.log(`ok   ${dir}/${f}`);
  }
}
process.exit(bad ? 1 : 0);
