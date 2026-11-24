import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = await readFile(new URL('../src/ui.html', import.meta.url), 'utf8');
const placeholder = '<!-- UI_SCRIPT -->';
if (!html.includes(placeholder)) throw new Error('No UI script placeholder in src/ui.html');

const config = {
  absWorkingDir: root,
  bundle: true,
  target: 'es2019',
  format: 'iife',
  external: ['stream', 'string_decoder'],
  charset: 'utf8',
  write: false
};
const [main, ui] = await Promise.all([
  build({
    ...config, entryPoints: ['src/main.ts'],
    banner: { js: '/*! Includes sax-js, Blue Oak Model License 1.0.0: https://blueoakcouncil.org/license/1.0.0 */' }
  }),
  build({ ...config, entryPoints: ['src/ui.ts'] })
]);
const script = ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const panel = html.replace(placeholder, () => `<script>\n${script}</script>`);
const directory = new URL('../dist/', import.meta.url);
await mkdir(directory, { recursive: true });
await Promise.all([
  writeFile(new URL('main.js', directory), main.outputFiles[0].text),
  writeFile(new URL('ui.html', directory), panel)
]);
console.log('Built dist/main.js and dist/ui.html');
