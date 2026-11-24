import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import example from '../data/example-palette.json';

class Element {
  value = '';
  textContent = '';
  hidden = false;
  disabled = false;
  opened = false;
  href?: string;
  dataset = {};
  files?: { size: number; text(): Promise<string> }[];
  private selectedOption = false;
  private events = new Map<string, (event: unknown) => void>();
  onclick?: () => void;
  onchange?: () => unknown;

  addEventListener(name: string, listener: (event: unknown) => void) { this.events.set(name, listener); }
  emit(name: string, event: unknown) { this.events.get(name)?.(event); }
  add(option: { value: string }) {
    if (this.selectedOption) return;
    this.value = option.value;
    this.selectedOption = true;
  }
  setAttribute() {}
  removeAttribute(name: string) { if (name === 'href') this.href = undefined; }
  focus() {}
  click() { if (!this.disabled) this.onclick?.(); }
  showModal() { this.opened = true; }
  close() { this.opened = false; }
}

test('the panel stages imports in the matching tab and confirms recoloring for only the displayed frame', async () => {
  const html = await readFile('src/ui.html', 'utf8');
  const ui = new Map(Array.from(html.matchAll(/\bid="([^"]+)"/g), match => [match[1]!, new Element()]));
  const get = (id: string) => ui.get(id)!;
  get('format').value = 'square';
  get('size').value = 'large';
  const channel = new Element();
  const posted: { type: string; [key: string]: unknown }[] = [];
  const environment = {
    window: channel,
    document: { getElementById: (id: string) => get(id), querySelectorAll: () => [] },
    parent: { postMessage: ({ pluginMessage }) => posted.push(pluginMessage) },
    Option: class { constructor(readonly label: string, readonly value: string) {} }
  };
  const globals = Object.entries(environment).map(([key, value]) => {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    return { key, before };
  });
  const host = (message: object) => channel.emit('message', { data: { pluginMessage: message } });
  const select = (id: string, scheme: string, item?: object) => host({
    type: 'selection', selection: { scene: {
      id, name: 'Книга, телефон · L', palette: { kind: 'preset', scheme }
    }, item }
  });
  const load = async (scope: 'build' | 'scene', name: string) => {
    const input = get(scope + '-palette-file');
    input.files = [{ size: 200, text: async () => JSON.stringify({ ...example, name }) }];
    get('import-' + scope + '-palette').click();
    await input.onchange?.();
  };

  try {
    await import('../src/ui');
    assert.deepEqual(posted.splice(0), [{ type: 'ready' }]);
    assert.equal(get('scene-empty').hidden, false);
    assert.equal(get('build').disabled, true);
    host({ type: 'library', state: 'unavailable' });
    assert.match(get('library-status').textContent, /Откройте файл задания/);
    assert.equal(get('prepare-library').hidden, true);
    host({ type: 'library', state: 'bundled' });
    assert.equal(get('build').disabled, false);
    assert.match(get('library-status').textContent, /Встроенная библиотека/);
    assert.equal(get('prepare-library').hidden, true);
    host({ type: 'library', state: 'needs-setup' });
    get('prepare-library').click();
    assert.deepEqual(posted.splice(0), [{ type: 'prepare-library' }]);
    assert.equal(get('cancel-library').hidden, false);
    host({ type: 'progress', text: 'Проверка SVG' });
    assert.equal(get('status').textContent, 'Проверка SVG');
    get('cancel-library').click();
    assert.deepEqual(posted.splice(0), [{ type: 'cancel-library' }]);
    host({ type: 'result', ok: false, text: 'Подготовка отменена.' });
    assert.equal(get('cancel-library').hidden, true);
    host({ type: 'library', state: 'ready' });
    assert.equal(get('library-notice').hidden, true);
    assert.equal(get('build').disabled, false);
    get('help-open').click();
    assert.ok(get('help').opened);
    assert.match(html, /Быстрый старт[\s\S]+Примеры[\s\S]+Частые вопросы/);
    get('verify-library').click();
    assert.equal(get('help').opened, false);
    assert.deepEqual(posted.splice(0), [{ type: 'verify-library' }]);
    host({ type: 'result', ok: true, text: 'Готово.', report: { version: 1 } });
    const report = get('library-report');
    assert.equal(report.hidden, false);
    assert.deepEqual(await (await fetch(report.href!)).json(), { version: 1 });

    select('A', 'violet');
    assert.equal(get('scene-palette').value, 'violet');
    assert.ok(get('apply').disabled);
    assert.ok(get('add').disabled, 'the add control requires an explicit item');
    assert.ok(get('role').hidden, 'role is unavailable with only the frame selected');

    get('create-tab').click();
    await load('build', 'Палитра для новой сцены');
    assert.equal(get('scene-palette').value, 'violet');
    assert.deepEqual(posted, [], 'loading a creation palette cannot edit a selected frame');
    get('query').value = 'Книга, телефон';
    get('compose').emit('submit', { preventDefault() {} });
    assert.equal(posted[0].type, 'build');
    assert.equal(posted[0].options.palette.palette.name, 'Палитра для новой сцены');
    host({ type: 'result', ok: true, text: 'Собрано.' });
    assert.equal(get('edit-panel').hidden, false);
    posted.length = 0;

    await load('scene', 'Палитра для перекраски');
    assert.deepEqual(posted, [], 'choosing a file alone cannot recolor a frame');
    assert.match(get('current-palette').textContent, /Сиреневая/);
    assert.match(get('build-palette').value, /Палитра для новой сцены/);
    select('A', 'violet', { id: 'A-phone', name: 'Телефон', role: 'main' });
    assert.match(get('scene-palette').value, /Палитра для перекраски/);
    assert.equal(get('role').textContent, 'Сделать фоновым');
    get('apply').click();
    assert.equal(posted[0].type, 'palette');
    assert.equal(posted[0].sceneId, 'A');
    assert.equal(posted[0].choice.palette.name, 'Палитра для перекраски');
    host({ type: 'result', ok: true, text: 'Композиция перекрашена.' });
    select('B', 'peach');
    assert.equal(get('scene-palette').value, 'peach', 'switching between identical titles resets the editor');
    assert.ok(get('apply').disabled);
    assert.match(get('current-palette').textContent, /Персиковая/);

    const input = get('scene-palette-file');
    let finish!: (value: string) => void;
    const text = new Promise<string>(resolve => { finish = resolve; });
    input.files = [{ size: 200, text: () => text }];
    get('import-scene-palette').click();
    const loading = input.onchange?.();
    select('C', 'turquoise');
    finish(JSON.stringify({ ...example, name: 'Палитра для предыдущего кадра' }));
    await loading;
    assert.equal(get('scene-palette').value, 'turquoise');
    assert.ok(get('apply').disabled);
    assert.equal(posted.length, 1, 'selection changes during file reads must never post another edit');

    select('A', 'violet', { id: 'A-phone', name: 'Телефон', role: 'main' });
    get('role').click();
    assert.deepEqual(posted.pop(), { type: 'role', sceneId: 'A', itemId: 'A-phone' });
    host({ type: 'result', ok: true, text: 'Готово.' });
    get('item').value = 'book';
    get('item').onchange?.();
    get('add').click();
    assert.deepEqual(posted.pop(), { type: 'add', sceneId: 'A', id: 'book' });
    host({ type: 'result', ok: true, text: 'Готово.' });
    get('alternative').click();
    assert.deepEqual(posted.pop(), { type: 'alternative', sceneId: 'A' });
    host({ type: 'result', ok: true, text: 'Готово.' });
    get('export').click();
    assert.deepEqual(posted.pop(), { type: 'export', sceneId: 'A' });
    const download = { type: 'result', ok: true, text: 'SVG', download: { sceneId: 'A', filename: 'A.svg', svg: '<svg/>' } };
    host(download);
    const href = get('download').href;
    assert.ok(href);
    assert.equal(get('download').hidden, false);
    select('B', 'peach');
    assert.equal(get('download').hidden, true);
    assert.equal(get('download').href, undefined);
    assert.equal((await fetch(href).catch(() => undefined)), undefined, 'the old object URL is revoked');
    host(download);
    assert.equal(get('download').hidden, true, 'a late export must not attach a link to the next frame');
  } finally {
    channel.emit('unload', undefined);
    for (const { key, before } of globals) {
      if (before) Object.defineProperty(globalThis, key, before);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
