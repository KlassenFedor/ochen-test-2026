import { readFile, writeFile, copyFile, mkdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const portableOnly = process.argv.slice(2).includes('--portable');
const args = process.argv.slice(2).filter(arg => arg !== '--portable');
if (args.length && (args.length !== 2 || args[0] !== '--plugin-id' || !/^\d+$/.test(args[1]))) {
  throw new Error('Usage: npm run package -- [--portable] [--plugin-id FIGMA_PLUGIN_ID]');
}
if (portableOnly) {
  try {
    const data = JSON.parse(await readFile(resolve(root, 'data/portable-library.json'), 'utf8'));
    if (!data) throw new Error('Empty library bundle');
  } catch (error) {
    throw new Error('Для автономного ZIP нужна выгрузка data/portable-library.json из рабочего файла Figma.', { cause: error });
  }
}
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
if (args.length) manifest.id = args[1];
else delete manifest.id;
const docs = ['docs/Задача-и-решение.md', 'docs/Визуальная-проверка.md'];
await Promise.all(docs.map(async file => {
  try { await readFile(resolve(root, file)); }
  catch (error) { throw new Error(`В архиве требуется ${file}.`, { cause: error }); }
}));
await import('./build.mjs');

const artifacts = resolve(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const staging = await mkdtemp(resolve(artifacts, 'plugin-'));
try {
  const files = [
    manifest.main, manifest.ui, 'tools/prepare-library/README.md',
    'README.md', 'data/example-palette.json', 'data/layouts.json', ...docs
  ];
  for (const file of files) {
    const destination = resolve(staging, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(root, file), destination);
  }
  await writeFile(resolve(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const archive = resolve(staging, 'archive.zip');
  // zipfile marks non-ASCII entry names as UTF-8 in both ZIP headers.
  await run('python3', ['-c', `
import sys
from zipfile import ZipFile, ZIP_DEFLATED

with ZipFile(sys.argv[1], 'w', compression=ZIP_DEFLATED) as archive:
    for name in sys.argv[2:]:
        archive.write(name, arcname=name)
`, archive, 'manifest.json', ...files], { cwd: staging });
  const destination = resolve(artifacts, 'illustration-composer.zip');
  await rename(archive, destination);
  console.log(destination);
} finally {
  await rm(staging, { recursive: true, force: true });
}
