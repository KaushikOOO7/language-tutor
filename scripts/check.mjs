import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(mjs|js)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) { console.error(result.stderr); process.exitCode = 1; }
    }
  }
}
for (const dir of ['server', 'public', 'scripts', 'tests']) await walk(dir);
if (!process.exitCode) console.log('All JavaScript modules passed syntax checks.');
