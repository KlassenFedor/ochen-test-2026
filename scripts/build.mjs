import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = await readFile(new URL('../src/ui.html', import.meta.url), 'utf8');
const placeholder = '<!-- UI_SCRIPT -->';
if (!html.includes(placeholder)) throw new Error('No UI script placeholder in src/ui.html');
const portable = await readFile(new URL('../data/portable-library.json', import.meta.url), 'utf8')
  .then(JSON.parse, error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
if (portable && (portable.version !== 1 || !Array.isArray(portable.variants) ||
    portable.variants.length !== 46 || portable.variants.some(variant => !variant?.tree) ||
    !Array.isArray(portable.palettes) || portable.palettes.length !== 3)) {
  throw new Error('data/portable-library.json must be the complete export of 46 masters and three palettes.');
}
const packedLibrary = portable
  ? gzipSync(JSON.stringify(portable), { level: 9 }).toString('base64')
  : null;
const pakoLicense = await readFile(new URL('../node_modules/pako/LICENSE', import.meta.url), 'utf8');
const pakoZlib = await readFile(new URL('../node_modules/pako/lib/zlib/inflate.js', import.meta.url), 'utf8');
const zlibNotice = pakoZlib.split('\n\n')[1];

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
    ...config, entryPoints: ['src/main.ts'], define: { __PORTABLE_LIBRARY__: JSON.stringify(packedLibrary) },
    banner: { js: `/*! Includes sax-js, Blue Oak Model License 1.0.0: https://blueoakcouncil.org/license/1.0.0 */\n/*! pako\n${pakoLicense}*/\n${zlibNotice}` }
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
if (portable) console.log('Bundled the portable component library.');
