import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNames } from '../src/catalog';
import type { Host, Paint, SolidPaint, Variable } from '../src/figma/host';
import { createComposer } from '../src/figma/scene';
import type { Transform } from '../src/layout';
import { fromHex, parsePalette, type Slot } from '../src/palette';
import example from '../data/example-palette.json';

let nodeId = 0;
class MockNode {
  readonly id = `mock-${++nodeId}`;
  children: MockNode[] = [];
  parent: MockNode | null = null;
  removed = false;
  private data = new Map<string, string>();
  private shared = new Map<string, string>();
  overrides: { id: string; overriddenFields: string[] }[] = [];
  layoutMode = "NONE";
  opacity = 1;
  private fillPaints: readonly Paint[] = [];
  strokes: readonly Paint[] = [];
  relativeTransform: Transform = [[1, 0, 0], [0, 1, 0]];
  visible = true;
  locked = false;
  clipsContent = false;
  selection: MockNode[] = [];
  master: MockNode | null = null;
  variantProperties?: Record<string, string>;
  loaded = false;
  failWrite = false;
  exported?: object;
  svg = '<svg><path d="M0 0Z"/></svg>';

  constructor(readonly type: string, public name = type, public width = 100, public height = 100) {}
  get x() { return this.relativeTransform[0][2]; }
  set x(x: number) { this.relativeTransform[0][2] = x; }
  get y() { return this.relativeTransform[1][2]; }
  set y(y: number) { this.relativeTransform[1][2] = y; }
  get fills() { return this.fillPaints; }
  set fills(paints: readonly Paint[]) {
    if (this.failWrite) throw new Error('Paint setter failed');
    this.fillPaints = paints;
  }
  appendChild(node: MockNode) { this.insertChild(this.children.length, node); }
  insertChild(index: number, node: MockNode) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    this.children.splice(index, 0, node);
    node.parent = this;
    node.removed = false;
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
    this.removed = true;
    while (this.children.length) this.children[0].remove();
  }
  async loadAsync() { this.loaded = true; }
  resizeWithoutConstraints(width: number, height: number) { this.width = width; this.height = height; }
  rescale(scale: number) { this.width *= scale; this.height *= scale; }
  getSharedPluginData(namespace: string, key: string) { return this.shared.get(namespace + '/' + key) ?? ''; }
  setSharedPluginData(namespace: string, key: string, value: string) { this.shared.set(namespace + '/' + key, value); }
  getPluginData(key: string) { return this.data.get(key) ?? ''; }
  setPluginData(key: string, value: string) { this.data.set(key, value); }
  async getMainComponentAsync() { return this.master; }
  async exportAsync(options: object) { this.exported = options; return new TextEncoder().encode(this.svg); }
  clone(type = this.type) {
    const copy = new MockNode(type, this.name, this.width, this.height);
    copy.relativeTransform = structuredClone(this.relativeTransform);
    copy.fills = structuredClone(this.fills);
    copy.strokes = structuredClone(this.strokes);
    copy.master = this.master;
    copy.visible = this.visible;
    copy.locked = this.locked;
    copy.opacity = this.opacity;
    copy.data = new Map(this.data);
    copy.shared = new Map(this.shared);
    this.children.forEach(child => copy.appendChild(child.clone()));
    return copy;
  }
  swapComponent(master: MockNode) {
    const scale = this.width / this.master!.width;
    this.master = master;
    this.resizeWithoutConstraints(master.width * scale, master.height * scale);
    while (this.children.length) this.children[0]!.remove();
    master.children.forEach(child => this.appendChild(child.clone()));
  }
  createInstance() {
    const copy = this.clone('INSTANCE');
    copy.master = this;
    pageFor(this).appendChild(copy);
    return copy;
  }
}

function pageFor(node: MockNode): MockNode {
  if (node.type === 'PAGE') return node;
  if (!node.parent) throw new Error('No page');
  return pageFor(node.parent);
}

const sceneKey = 'illustration-scene';
const namespace = 'ochenIllustrationComposer';
const readScene = (n: MockNode) => n.getSharedPluginData(namespace, sceneKey);
const custom = { kind: 'custom', palette: parsePalette(JSON.stringify(example)) } as const;
const violet = { kind: 'preset', scheme: 'violet' } as const;
const options = { format: 'square', size: 'large', palette: violet, title: 'Книга, телефон' } as const;
const paint = (token: string, opacity = 1): SolidPaint => ({
  type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity, boundVariables: { color: { id: token } }
});

function fixture() {
  const drawing = new MockNode('PAGE', 'Задание');
  const page = new MockNode('PAGE', 'Библиотека компонентов');
  const library = new MockNode('SECTION', 'Библиотека · Компоненты', 4000, 2200);
  const demo = new MockNode('SECTION', 'Демо · Плагин', 4200, 2600);
  page.appendChild(library);
  page.appendChild(demo);
  const schemes = ['violet', 'peach', 'turquoise'];
  const collections = [
    ...schemes.map(scheme => ({ id: scheme, name: `Illustration / Palette / ${scheme}`, defaultModeId: 'base' })),
    { id: 'detail', name: 'Illustration / Details', defaultModeId: 'base' },
    { id: 'source', name: 'Illustration / Source', defaultModeId: 'base' }
  ];
  const variables: Variable[] = [{ id: 'fixed', name: 'detail/white', variableCollectionId: 'detail', valuesByMode: { base: fromHex('#FFFFFF') } }];
  const keys = new Map<string, MockNode>();
  const slots: Slot[] = ['background/0', 'background/1', 'background/2', 'background/3',
    'object/0', 'object/1', 'object/2', 'object/3'];
  for (const [i, scheme] of schemes.entries()) for (const [j, slot] of slots.entries()) {
    const id = `${scheme}/${slot}`;
    const source = `source/${id}`;
    variables.push(
      { id, name: slot, variableCollectionId: scheme, valuesByMode: { base: { type: 'VARIABLE_ALIAS', id: source } } },
      { id: source, name: id, variableCollectionId: 'source', valuesByMode: { base: { r: (i + 1) / 7, g: (j + 1) / 9, b: 0 } } }
    );
  }
  for (const name of ['book', 'phone', 'headphones', 'background']) {
    const family = new MockNode('COMPONENT_SET', name);
    library.appendChild(family);
    for (const size of ['large', 'small']) for (const variant of name === 'background' ? schemes : ['main', 'background']) {
      const decorative = name === 'background';
      const monochrome = decorative || variant === 'background';
      const master = new MockNode('COMPONENT', `Size=${size}, ${decorative ? 'Scheme' : 'Role'}=${variant}`,
        decorative ? 1500 : variant === 'main' ? 600 : 800, decorative ? 820 : 400);
      // Exercise resolution via both the native variant properties and the canonical names.
      if (size === 'large') master.variantProperties = decorative ? { Size: size, Scheme: variant } : { Size: size, Role: variant };
      const ink = new MockNode('VECTOR', 'Artwork');
      const scheme = decorative ? variant : 'violet';
      ink.fills = [paint(`${scheme}/${monochrome ? 'background' : 'object'}/0`, 0.42), paint('fixed', 0.6)];
      ink.strokes = [paint(`${scheme}/background/3`)];
      master.appendChild(ink);
      family.appendChild(master);
      keys.set(`${name}/${size}/${variant}`, master);
    }
  }
  const host = {
    root: { children: [drawing, page] },
    currentPage: drawing,
    skipInvisibleInstanceChildren: true,
    async setCurrentPageAsync(value: MockNode) { this.currentPage = value; },
    createFrame() {
      const frame = new MockNode('FRAME');
      this.currentPage.appendChild(frame);
      return frame;
    },
    variables: {
      async getLocalVariableCollectionsAsync() { return collections; },
      async getLocalVariablesAsync() { return variables; },
      setBoundVariableForPaint(value: SolidPaint, _field: 'color', variable: Variable | null) {
        const { boundVariables, ...detached } = value;
        return variable ? { ...detached, boundVariables: { color: { id: variable.id } } } : detached;
      }
    },
    viewport: { scrollAndZoomIntoView() {} }
  };
  const composer = createComposer(host as unknown as Host);
  return { composer, host, drawing, page, demo, keys, variables, collections };
}

async function build(f: ReturnType<typeof fixture>, text = 'книга, телефон') {
  return await f.composer.build(parseNames(text), options) as unknown as MockNode;
}

test('assembly builds an editable cutout frame from stable masters on another page', async () => {
  const f = fixture();
  const frame = await build(f);
  assert.ok(f.page.loaded);
  assert.equal(f.host.currentPage, f.page);
  assert.deepEqual(f.page.selection, [frame]);
  assert.equal(frame.parent, f.demo);
  assert.equal(frame.width, 1080);
  assert.equal(frame.clipsContent, true);
  assert.deepEqual(frame.children.map(node => node.name), ['Фон', 'Книга', 'Телефон']);
  assert.equal(frame.children[0].locked, true);
  assert.equal(frame.children[0].master, f.keys.get('background/large/violet'));
  assert.equal(frame.children[2].master, f.keys.get('phone/large/main'));
  assert.equal(frame.children[2].children[0].fills[0].color.r, 1 / 7, 'exact aliased color');
  assert.equal(frame.children[2].children[0].fills[0].opacity, 0.42);
});

test('missing and duplicate variants fail before creating a frame', async () => {
  const f = fixture();
  const book = f.keys.get('book/large/main');
  const duplicate = book.clone();
  book.parent.appendChild(duplicate);
  await assert.rejects(build(f), /Дубликат варианта.*book\/large\/main/);
  duplicate.remove();
  book.remove();
  await assert.rejects(build(f), /Не найдено.*book\/large\/main/);
  assert.equal(f.demo.children.length, 0);
  assert.equal(f.host.currentPage.name, 'Задание');
});

test('missing binding in a new object rolls back the whole draft', async () => {
  const f = fixture();
  f.keys.get('phone/large/main').children[0].strokes = [paint('unknown')];
  await assert.rejects(build(f), /Нет привязки strokes\[1\].*Artwork/);
  assert.equal(f.demo.children.length, 0);
  assert.equal(f.page.children.filter(node => node.type === 'FRAME' || node.type === 'INSTANCE').length, 0);
});

test('custom then standard recoloring uses master slots and preserves edited transforms and layer order', async () => {
  const f = fixture();
  const frame = await build(f);
  const [, book, phone] = frame.children;
  book.remove();
  phone.relativeTransform = [[0, 1, 390], [-1, 0, 510]];
  const duplicate = phone.clone();
  frame.insertChild(1, duplicate);
  f.page.selection = [phone.children[0]];
  const order = [...frame.children];
  const transforms = order.map(node => structuredClone(node.relativeTransform));
  const same = { kind: 'custom', palette: parsePalette(JSON.stringify({
    ...example, object: [example.background[3], ...example.object.slice(1)]
  })) } as const;
  await f.composer.recolor(same, frame.id);
  const ink = phone.children[0];
  assert.deepEqual(ink.fills[0].color, same.palette.object[0]);
  assert.deepEqual(ink.strokes[0].color, same.palette.background[3]);
  assert.deepEqual(ink.fills[0].color, ink.strokes[0].color);
  assert.deepEqual(duplicate.children[0].fills, ink.fills);
  assert.equal(ink.fills[0].boundVariables, undefined);
  assert.equal(ink.fills[1].boundVariables.color.id, 'fixed');
  assert.equal(ink.fills[0].opacity, 0.42);
  await f.composer.recolor({ kind: 'preset', scheme: 'peach' }, frame.id);
  assert.equal(ink.fills[0].boundVariables.color.id, 'peach/object/0');
  assert.equal(ink.strokes[0].boundVariables.color.id, 'peach/background/3');
  assert.notDeepEqual(ink.fills[0].color, ink.strokes[0].color);
  assert.equal(frame.fills[0].boundVariables.color.id, 'peach/background/0');
  assert.equal(frame.children[0].master, f.keys.get('background/large/peach'));
  assert.deepEqual(frame.children.slice(1), order.slice(1));
  assert.deepEqual(frame.children.map(node => node.relativeTransform), transforms);
});

test('palette preflight and a failing write both leave a previous scene intact', async () => {
  const f = fixture();
  const frame = await build(f);
  const [, book, phone] = frame.children;
  const before = readScene(frame);
  const paintBefore = book.children[0].fills;
  const originalStroke = phone.master.children[0].strokes;
  phone.master.children[0].strokes = [paint('unknown')];
  await assert.rejects(f.composer.recolor(custom, frame.id), /Нет привязки/);
  assert.equal(book.children[0].fills, paintBefore);
  phone.master.children[0].strokes = originalStroke;
  phone.children[0].failWrite = true;
  await assert.rejects(f.composer.recolor(custom, frame.id), /Paint setter failed/);
  assert.deepEqual(book.children[0].fills, paintBefore);
  assert.equal(readScene(frame), before);
});

test('palette confirmation cannot recolor a different selected scene with the same name', async () => {
  const f = fixture();
  const first = await build(f);
  const second = await build(f);
  assert.equal(first.name, second.name);
  assert.equal(f.composer.selection().scene.id, second.id);
  const before = readScene(second);
  await assert.rejects(f.composer.recolor(custom, first.id), /Выделение изменилось/);
  assert.equal(readScene(second), before);
  assert.deepEqual(f.composer.selection().scene.palette, violet);
  await f.composer.recolor(custom, second.id);
  assert.deepEqual(f.composer.selection().scene.palette, custom);
});

test('changing role keeps layer index, center, rotation and proportional scale', async () => {
  const f = fixture();
  const frame = await build(f);
  const book = frame.children[1];
  book.rescale(1.2);
  book.relativeTransform = [[0, -1, 570], [1, 0, 240]];
  const center = (n: MockNode) => [n.x - n.height / 2, n.y + n.width / 2];
  const position = center(book);
  const scale = book.width / book.master.width;
  f.page.selection = [book];
  await f.composer.changeRole(frame.id, book.id);
  const replacement = frame.children[1];
  assert.equal(replacement.master, f.keys.get('book/large/background'));
  assert.equal(replacement.width, replacement.master.width * scale);
  assert.deepEqual(center(replacement), position);
  assert.equal(replacement.children[0].fills[0].boundVariables.color.id, 'violet/background/0');
  assert.equal(frame.children[2].name, 'Телефон');
  assert.equal(book.removed, true);
  assert.deepEqual(f.composer.selection().item, { id: replacement.id, name: 'Книга', role: 'background' });
});

test('an alternate scene retains repeated live items and leaves the edited source in place', async () => {
  const f = fixture();
  const first = await build(f, 'книга, книга, телефон');
  const phone = first.children[3];
  phone.x = 172;
  const before = readScene(first);
  const next = await f.composer.alternative(first.id) as unknown as MockNode;
  assert.deepEqual(f.demo.children, [first, next]);
  assert.deepEqual(next.children.map(node => node.name), ['Фон', 'Книга', 'Книга', 'Телефон']);
  assert.notEqual(JSON.parse(before).layout, JSON.parse(readScene(next)).layout);
  assert.equal(readScene(first), before);
  assert.equal(phone.x, 172);
});

test('small master, an added item, and SVG export use the current selected scene', async () => {
  const f = fixture();
  const frame = await f.composer.build(parseNames('телефон'), { ...options, size: 'small', format: 'vertical', palette: custom }) as unknown as MockNode;
  assert.equal(frame.children[1].master, f.keys.get('phone/small/main'));
  const transform = structuredClone(frame.children[1].relativeTransform);
  await f.composer.add({ id: 'headphones', role: 'main' }, frame.id);
  assert.deepEqual(frame.children[1].relativeTransform, transform);
  const added = frame.children[2];
  assert.equal(added.master, f.keys.get('headphones/small/main'));
  assert.deepEqual(added.children[0].fills[0].color, custom.palette.object[0]);
  assert.equal((await f.composer.exportSvg(frame.id)).svg, frame.svg);
  assert.equal(frame.exported.format, 'SVG');
  frame.svg = '<svg><g id="Книга"> <path d="M0 0Z"/> </g></svg>';
  assert.match((await f.composer.exportSvg(frame.id)).svg, /id="&#x41a;&#x43d;&#x438;&#x433;&#x430;"/);
  frame.svg = '<svg><image href="data:image/png;base64,a"/></svg>';
  await assert.rejects(f.composer.exportSvg(frame.id), /растровую вставку/);
});

test('stale scene and item IDs are rejected before editing or exporting', async () => {
  const f = fixture();
  const a = await build(f);
  const b = await build(f);
  const [book, phone] = b.children.slice(1);
  f.page.selection = [phone];
  await assert.rejects(f.composer.add({ id: 'book', role: 'main' }, a.id), /Выделение изменилось/);
  await assert.rejects(f.composer.alternative(a.id), /Выделение изменилось/);
  await assert.rejects(f.composer.exportSvg(a.id), /Выделение изменилось/);
  await assert.rejects(f.composer.changeRole(a.id, phone.id), /Выделение изменилось/);
  await assert.rejects(f.composer.changeRole(b.id, book.id), /Выделение изменилось/);
  assert.equal(f.demo.children.length, 2);
  assert.deepEqual(b.children.slice(1), [book, phone]);
  assert.equal(b.exported, undefined);

  const pending = f.composer.add({ id: 'book', role: 'main' }, b.id);
  f.page.selection = [a];
  await assert.rejects(pending, /Выделение изменилось/);
  assert.equal(b.children.length, 3);
  f.page.selection = [b];
  const exporting = f.composer.exportSvg(b.id);
  f.page.selection = [a];
  await assert.rejects(exporting, /Выделение изменилось/);
});

test('grouped items are recolored and keep their group, compatible overrides and warnings on role swap', async () => {
  const f = fixture();
  const extra = new MockNode('VECTOR', 'Только в главной роли');
  f.keys.get('book/large/main').appendChild(extra);
  const frame = await build(f);
  const book = frame.children[1];
  const group = new MockNode('GROUP');
  frame.insertChild(1, group);
  group.appendChild(book);
  const inside = book.children[0];
  inside.visible = false;
  inside.x = 17;
  book.children[1].visible = false;
  book.overrides = [{ id: inside.id, overriddenFields: ['visible', 'x'] },
    { id: book.children[1].id, overriddenFields: ['visible'] }];
  f.page.selection = [inside];
  assert.equal(f.composer.selection().item.id, book.id);
  await f.composer.recolor(custom, frame.id);
  assert.deepEqual(inside.fills[0].color, custom.palette.object[0]);
  const warnings = await f.composer.changeRole(frame.id, book.id);
  assert.deepEqual(warnings, ['«Только в главной роли» (visible)']);
  const replacement = group.children[0];
  assert.equal(replacement.children[0].visible, false);
  assert.equal(replacement.children[0].x, 17);
  assert.equal(frame.children[1], group);
});

test('alternative stays on the source page and keeps both grouped and directly hidden items hidden', async () => {
  const f = fixture();
  const source = await build(f, 'книга, телефон, книга');
  f.drawing.appendChild(source);
  source.x = 500;
  source.y = 115;
  const group = new MockNode('GROUP');
  source.appendChild(group);
  group.appendChild(source.children[1]);
  group.visible = false;
  source.children[1].visible = false;
  f.demo.remove();
  await f.host.setCurrentPageAsync(f.drawing);
  f.drawing.selection = [source];
  const next = await f.composer.alternative(source.id) as unknown as MockNode;
  assert.equal(next.parent, f.drawing);
  assert.equal(next.x, 500 + source.width + 80);
  assert.equal(next.y, 115);
  const items = next.children.slice(1);
  assert.equal(items.length, 3);
  assert.equal(items.find(item => item.name === 'Телефон')!.visible, false);
  assert.deepEqual(items.filter(item => item.name === 'Книга').map(item => item.visible), [true, false]);
});

test('role swap preserves manual paint opacity and reports a manual color replaced by the new palette slot', async () => {
  const f = fixture();
  const frame = await build(f, 'книга');
  const book = frame.children[1];
  const layer = book.children[0];
  layer.fills = [{ type: 'SOLID', color: fromHex('#222222'), opacity: 0.19 }, layer.fills[1]];
  book.overrides = [{ id: layer.id, overriddenFields: ['fills'] }];
  f.page.selection = [book];
  assert.deepEqual(await f.composer.changeRole(frame.id, book.id), ['«Artwork» (fills), ручной цвет']);
  const [fill] = frame.children[1].children[0].fills;
  assert.equal(fill.opacity, 0.19);
  assert.equal(fill.boundVariables.color.id, 'violet/background/0');
});

test('color loading only requires the selected palette and bindings used by the scene', async () => {
  const f = fixture();
  const frame = await build(f);
  f.collections.splice(f.collections.findIndex(collection => collection.id === 'turquoise'), 1);
  await f.composer.recolor(custom, frame.id);
  await f.composer.recolor({ kind: 'preset', scheme: 'peach' }, frame.id);
  const before = readScene(frame);
  await assert.rejects(f.composer.recolor({ kind: 'preset', scheme: 'turquoise' }, frame.id), /Не найдено.*turquoise/);
  assert.equal(readScene(frame), before);
});

test('preset decor matches a new frame, and importing custom colors retains that master', async () => {
  const f = fixture();
  const peach = { kind: 'preset', scheme: 'peach' } as const;
  const master = f.keys.get('background/large/peach');
  master.width = 960;
  master.height = 940;
  master.children[0].x = 32;
  master.children[0].fills = [paint('peach/background/0'), { ...paint('fixed'), color: fromHex('#FFFFFF') }];
  const expected = await f.composer.build(parseNames('книга'), { ...options, palette: peach }) as unknown as MockNode;
  const current = await build(f, 'книга');
  await f.composer.recolor(peach, current.id);
  const backdrop = current.children[0];
  assert.equal(backdrop.master, master);
  assert.deepEqual(backdrop.relativeTransform, expected.children[0].relativeTransform);
  assert.deepEqual(backdrop.children[0].fills, expected.children[0].children[0].fills);
  await f.composer.recolor(custom, current.id);
  assert.equal(current.children[0], backdrop);
  assert.deepEqual(backdrop.children[0].fills[0].color, custom.palette.background[0]);
});

test('old private metadata becomes readable by a different ID after explicit migration', async () => {
  const f = fixture();
  const frame = await build(f, 'книга');
  const [, book] = frame.children;
  const group = new MockNode('GROUP');
  frame.appendChild(group);
  group.appendChild(book);
  for (const [node, key] of [[frame, sceneKey], [frame.children[0], 'illustration-background'], [book, 'illustration-item']] as const) {
    node.setPluginData(key, node.getSharedPluginData(namespace, key));
    node.setSharedPluginData(namespace, key, '');
  }
  assert.equal(f.composer.selection().scene.legacy, true);
  f.composer.migrate(frame.id);
  for (const [node, key] of [[frame, sceneKey], [frame.children[0], 'illustration-background'], [book, 'illustration-item']] as const) {
    node.setPluginData(key, '');
  }
  assert.equal(f.composer.selection().scene.legacy, false);
  f.page.selection = [book];
  assert.equal(f.composer.selection().item.id, book.id);
  await f.composer.recolor(custom, frame.id);
  assert.deepEqual(book.children[0].fills[0].color, custom.palette.object[0]);
});

test('oversized requests and manually duplicated items are checked before creating any objects', async () => {
  const f = fixture();
  const item = { id: 'book', role: 'main' } as const;
  await assert.rejects(f.composer.build(Array(25).fill(item), options), /до 24/);
  assert.equal(f.demo.children.length, 0);
  const frame = await build(f, Array(24).fill('книга').join(', '));
  await assert.rejects(f.composer.add(item, frame.id), /до 24/);
  frame.appendChild(frame.children[1].clone());
  await assert.rejects(f.composer.alternative(frame.id), /до 24/);
  assert.equal(f.demo.children.length, 1);
});

test('the main entry commits undo once per successful write, including migration, and skips failures and export', async () => {
  const f = fixture();
  const messages: any[] = [];
  let commits = 0;
  const host = Object.assign(f.host, {
    showUI() {}, on() {}, commitUndo() { commits++; },
    ui: { onmessage: async (_message: unknown) => {}, postMessage(message: unknown) { messages.push(message); } }
  });
  const globals = Object.assign(globalThis, { figma: host, __html__: '' });
  try {
    await import('../src/main');
    const send = (message: object) => host.ui.onmessage(message);
    await send({ type: 'ready' });
    assert.equal(commits, 0);
    await send({ type: 'build', mode: 'names', query: 'книга', options });
    const [frame] = f.page.selection;
    assert.equal(commits, 1);
    await send({ type: 'export', sceneId: frame.id });
    await send({ type: 'add', sceneId: 'stale', id: 'phone' });
    assert.equal(commits, 1);
    await send({ type: 'add', sceneId: frame.id, id: 'phone' });
    await send({ type: 'role', sceneId: frame.id, itemId: f.page.selection[0].id });
    await send({ type: 'palette', sceneId: frame.id, choice: custom });
    const snapshot = readScene(frame);
    frame.setPluginData(sceneKey, snapshot);
    frame.setSharedPluginData(namespace, sceneKey, '');
    await send({ type: 'migrate', sceneId: frame.id });
    await send({ type: 'alternative', sceneId: frame.id });
    assert.equal(commits, 6);
    assert.deepEqual(messages.filter(message => message.type === 'result').map(message => message.ok),
      [true, true, false, true, true, true, true, true]);
  } finally {
    Reflect.deleteProperty(globals, 'figma');
    Reflect.deleteProperty(globals, '__html__');
  }
});
