import { build } from 'esbuild';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = (await readdir(resolve(root, 'tests'))).filter(name => name.endsWith('.test.ts'));
if (!tests.length) throw new Error('No tests found');
const output = resolve(root, 'tmp');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(resolve(output, 'tests-'));
try {
  await build({
    absWorkingDir: root, entryPoints: tests.map(name => `tests/${name}`), outdir: temp,
    outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    sourcemap: 'inline'
  });
  process.setSourceMapsEnabled(true);
  for (const name of tests) await import(pathToFileURL(resolve(temp, name.replace(/\.ts$/, '.mjs'))));
} finally {
  await rm(temp, { recursive: true, force: true });
}
