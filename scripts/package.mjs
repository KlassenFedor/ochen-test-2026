import { readFile, writeFile, copyFile, mkdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--plugin-id' || !/^\d+$/.test(args[1]))) {
  throw new Error('Usage: npm run package -- [--plugin-id FIGMA_PLUGIN_ID]');
}
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
if (args.length) manifest.id = args[1];
await Promise.all([
  import('./build.mjs'),
  run(process.execPath, ['tools/prepare-library/build.mjs'], { cwd: root })
]);

const artifacts = resolve(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const staging = await mkdtemp(resolve(artifacts, 'plugin-'));
try {
  const preparation = ['README.md', 'manifest.json', 'build/code.js'].map(file => `tools/prepare-library/${file}`);
  const files = [
    manifest.main, manifest.ui, ...preparation,
    'README.md', 'data/example-palette.json', 'data/layouts.json'
  ];
  for (const file of files) {
    const destination = resolve(staging, file);
    await mkdir(dirname(destination), { recursive: true });
    if (file === 'tools/prepare-library/manifest.json') {
      const helperManifest = JSON.parse(await readFile(resolve(root, file), 'utf8'));
      delete helperManifest.id;
      await writeFile(destination, JSON.stringify(helperManifest, null, 2) + '\n');
    } else {
      await copyFile(resolve(root, file), destination);
    }
  }
  for (const file of ['Задача-и-решение.md', 'Визуальная-проверка.md']) {
    try {
      await copyFile(resolve(root, 'docs', file), resolve(staging, file));
      files.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
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
  if (!manifest.id) console.log('Register a development plugin in Figma and add the assigned ID before importing the manifest.');
} finally {
  await rm(staging, { recursive: true, force: true });
}
