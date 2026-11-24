import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = new URL('./', import.meta.url);
const idArgument = process.argv.indexOf('--plugin-id');
if (idArgument !== -1) {
  const id = process.argv[idArgument + 1];
  if (!id || !/^\d+$/.test(id)) throw new Error('После --plugin-id нужен ID, выданный Figma при создании плагина.');
  const manifestUrl = new URL('manifest.json', directory);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  manifest.id = id;
  await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
}
const plan = JSON.parse(await readFile(new URL('library-plan.json', directory), 'utf8'));
await mkdir(new URL('build/', directory), { recursive: true });
const output = new URL('build/code.js', directory);
await build({
  entryPoints: [fileURLToPath(new URL('main.js', directory))],
  outfile: fileURLToPath(output),
  define: { LIBRARY_PLAN: JSON.stringify(plan) },
  bundle: true,
  format: 'iife',
  target: 'es2019',
  charset: 'utf8',
  banner: { js: '/*! Includes sax-js, Blue Oak Model License 1.0.0: https://blueoakcouncil.org/license/1.0.0 */' },
  external: ['stream', 'string_decoder']
});
console.log(fileURLToPath(output));
