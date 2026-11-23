import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
const source = await readFile(new URL('main.js', directory), 'utf8');
await mkdir(new URL('build/', directory), { recursive: true });
const output = new URL('build/code.js', directory);
await writeFile(output, `const LIBRARY_PLAN = ${JSON.stringify(plan)};\n${source}`);
console.log(fileURLToPath(output));
