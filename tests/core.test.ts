import assert from 'node:assert/strict';
import { test } from 'node:test';
import plan from '../tools/prepare-library/library-plan.json';
import { catalog, parseNames, suggestItems } from '../src/catalog';
import { keepCenter, planLayout, planAddition } from '../src/layout';
import { fromHex, parsePalette, readPaletteChoice } from '../src/palette';
import { readCommand } from '../src/protocol';
import { prepareSvgExport, svgFilename, validateSvg } from '../src/svg';
import example from '../data/example-palette.json';

const shape = (width: number, height: number, role: 'main' | 'background' = 'main') => ({ width, height, role });

test('catalog matches every motif prepared in the working file', () => {
  assert.deepEqual(catalog.map(item => [item.id, item.name]), plan.objects.map(item => [item.id, item.name]));
});
test('explicit list recognizes aliases and retains the sequence and duplicates', () => {
  assert.deepEqual(parseNames(' КОШЕЛЕК, книжку, смартфон, кошелёк ').map(item => item.id),
    ['wallet', 'book', 'phone', 'wallet']);
});
test('unknown names and empty positions fail the whole explicit list', () => {
  assert.throws(() => parseNames('книга, калькулятор, , кресло'), /калькулятор.*пустая позиция.*кресло.*Телефон/);
});
test('thematic title and its paraphrase choose the same two items in order', () => {
  for (const title of ['Учиться в дороге', 'Учимся в пути!', 'Слушаю учебник']) {
    assert.deepEqual(suggestItems(title), [{ id: 'book', role: 'main' }, { id: 'headphones', role: 'background' }]);
  }
});
test('title suggestions are bounded and word boundaries prevent substring matches', () => {
  assert.equal(suggestItems('Чтение, музыка, финансы, свет, папка').length, 3);
  assert.throws(() => suggestItems('Просветление в горах'), /Подходящих предметов не найдено/);
});
test('a longer exact catalog phrase outranks one-word names when the title has many matches', () => {
  assert.equal(suggestItems('Книга, пазлы, телефон, папка для документов')[0].id, 'folder');
});
test('very long lists of valid names stop before composition', () => {
  assert.equal(parseNames(Array(24).fill('ваза').join(', ')).length, 24);
  assert.throws(() => parseNames(Array(819).fill('ваза').join(',')), /до 24/);
});
test('custom palette accepts duplicate slots, validates version, lengths and every hex value', () => {
  const palette = parsePalette(JSON.stringify({ ...example, background: ['#AAAAAA', '#AAAAAA', '#7700aa', '#112233'] }));
  assert.deepEqual(palette.background[0], palette.background[1]);
  assert.deepEqual(palette.background[2], fromHex('#7700AA'));
  assert.throws(() => parsePalette('bad json'), /JSON/);
  assert.throws(() => parsePalette(JSON.stringify({ ...example, version: 2 })), /version/);
  assert.throws(() => parsePalette(JSON.stringify({ ...example, object: ['#AA0077'] })), /object.*четыре/);
  assert.throws(() => parsePalette(JSON.stringify({ ...example, background: ['#AAAAAA', '#ABC', '#AAAAAA', '#AAAAAA'] })),
    /background\[2\].*#RRGGBB/);
  assert.throws(() => readPaletteChoice({ kind: 'custom', palette: { ...palette, object: [{ r: -1, g: 0, b: 0 }, ...palette.object.slice(1)] } }), /object\[1\]/);
});
test('build commands validate format, size and palettes at the document boundary', () => {
  const cmd = {
    type: 'build', mode: 'names', query: ' Книга,  телефон ',
    options: { format: 'horizontal', size: 'small', palette: { kind: 'preset', scheme: 'violet' } }
  };
  assert.equal(readCommand(cmd).options.title, 'Книга, телефон');
  assert.throws(() => readCommand({ ...cmd, options: { ...cmd.options, format: 'letter' } }), /формат/);
  assert.throws(() => readCommand({ ...cmd, query: '   ' }), /Введите/);
  assert.throws(() => readCommand({ type: 'palette', choice: { kind: 'preset', scheme: '__proto__' } }), /палитру/);
  for (const type of ['add', 'alternative', 'role', 'export', 'migrate']) {
    assert.throws(() => readCommand({ type, id: 'book' }), /композицию/);
  }
  assert.throws(() => readCommand({ type: 'role', sceneId: '1:2' }), /предмет/);
});
test('initial pair is diagonal with the phone in front and shares one proportional scale', () => {
  const items = [shape(730, 560), shape(480, 680)];
  const layout = planLayout(items, 'square');
  assert.equal(layout.id, 'diagonal');
  assert.deepEqual(layout.places.map(place => place.index), [0, 1]);
  assert.equal(layout.places[0].width, items[0].width * layout.scale);
  assert.equal(layout.places[1].height, items[1].height * layout.scale);
  assert.equal(layout.places[0].x + layout.places[0].width / 2, 0.35 * layout.frame.width);
  assert.notEqual(planLayout(items, 'square', layout.id).id, layout.id);
});
test('crowded explicit lists keep every item inside each format with no grid overlap', () => {
  const items = Array.from({ length: 19 }, (_, i) => shape(180 + 32 * i, 470 - 12 * i, i % 2 ? 'main' : 'background'));
  for (const format of ['square', 'horizontal', 'vertical'] as const) {
    const { frame, places, scale, id } = planLayout(items, format);
    assert.match(id, /^rows-/);
    assert.deepEqual(places.map(place => place.index).sort((a, b) => a - b), items.map((_, i) => i));
    for (const [i, p] of places.entries()) {
      assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.width <= frame.width && p.y + p.height <= frame.height);
      assert.ok(Math.abs(p.width / items[p.index].width - scale) < 1e-12, 'shared scale');
      for (const q of places.slice(i + 1)) {
        assert.ok(p.x + p.width <= q.x || q.x + q.width <= p.x ||
          p.y + p.height <= q.y || q.y + q.height <= p.y);
      }
    }
  }
});
test('background goes behind the main figure, and fully covered mains trigger an alternative', () => {
  const layered = planLayout([shape(200, 230), shape(400, 360, 'background')], 'horizontal');
  assert.deepEqual(layered.places.map(place => place.index), [1, 0]);
  const crowded = planLayout([shape(20, 20), shape(300, 300)], 'square', 'diagonal');
  assert.match(crowded.id, /^rows-/);
});
test('adding a piece keeps it in frame and chooses free space over the center', () => {
  const result = planAddition(shape(100, 200), { width: 800, height: 500 }, 1.2, [
    { x: 300, y: 140, width: 200, height: 220 }
  ]);
  assert.equal(result.scale, 1.2);
  assert.ok(result.x + result.width <= 300 || result.x >= 500);
});
test('adding a second large square reduces its scale to protect a centered main subject', () => {
  const frame = { width: 1000, height: 1000 };
  const centered = { x: 135, y: 135, width: 730, height: 730 };
  const added = planAddition(shape(1000, 1000), frame, 0.73, [centered]);
  const overlap = (Math.min(added.x + added.width, 865) - Math.max(added.x, 135)) *
    (Math.min(added.y + added.height, 865) - Math.max(added.y, 135));
  assert.ok(added.scale < 0.73);
  assert.ok(overlap / (730 * 730) <= 0.25);
});
test('replacing a rotated item preserves its center with different master dimensions', () => {
  assert.deepEqual(keepCenter([[0, -1, 100], [1, 0, 200]], shape(80, 30), shape(60, 90)),
    [[0, -1, 130], [1, 0, 210]]);
});
test('SVG keeps vector effects but rejects raster and foreign HTML markup', () => {
  const vector = '<svg><defs><clipPath id="c"><path d="M0 0Z"/></clipPath></defs><path d="M1 0Z" clip-path="url(#c)" /></svg>';
  assert.equal(validateSvg(vector), vector);
  for (const tag of ['image', 'svg:image', 'feImage', 'foreignObject']) {
    assert.throws(() => validateSvg(`<svg xmlns:svg="http://www.w3.org/2000/svg"><${tag}/></svg>`), /растровую вставку/);
  }
  assert.throws(() => validateSvg('<svg>'), /неполный SVG/);
  assert.equal(svgFilename('Книга, телефон · L'), 'Книга-телефон-L.svg');
});
test('SVG needs well-formed XML with a vector outside resource definitions or a local reference to one', () => {
  for (const svg of ['<svg><g></svg>', '<svg/><svg/>', '<svg><use href="#missing"/></svg>',
    '<svg><path d="M0 0" d="M1 1"/></svg>', '<svg><path d="M0 0" id="broken<name"/></svg>']) {
    assert.throws(() => validateSvg(svg), /некорректный XML/);
  }
  for (const svg of ['<svg></svg>', '<svg><path/></svg>', '<svg><defs><path d="M1 1Z"/></defs></svg>']) {
    assert.throws(() => validateSvg(svg), /нет векторного содержимого/);
  }
  const reusable = '<svg xmlns="http://www.w3.org/2000/svg"><defs><symbol id="p"><path d="M1 1Z"/></symbol></defs><use href="#p"/></svg>';
  assert.equal(validateSvg(reusable), reusable);
});

test('SVG preserves Unicode IDs and references even when the text encoding is misdetected', () => {
  const title = 'Книга™📘 &amp; телефон';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg">' +
    '<!-- id="Книга" --><title>Книга</title><desc><![CDATA[Пример id="Книга"]]></desc>' +
    '<defs><clipPath id="Обрезка"><path d="M0 0Z"/></clipPath></defs>' +
    '<g id="' + title + '" clip-path="url(#Обрезка)"><path d="M1 1Z"/></g></svg>';
  const out = prepareSvgExport(new TextEncoder().encode('\uFEFF' + svg));
  const id = /clipPath id="([^"]+)"/.exec(out)![1];
  const ref = /clip-path="url\(#([^)]+)\)"/.exec(out)![1];
  assert.match(id, /^(&#x[0-9a-f]+;)+$/);
  assert.equal(ref, id);
  const decode = (value: string) => value.replace(/&#x([0-9a-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
  assert.equal(decode(id), 'Обрезка');
  assert.equal(decode(/<g id="([^"]+)"/.exec(out)![1]), title);
  assert.match(out, /<!-- id="Книга" --><title>Книга<\/title><desc><!\[CDATA\[Пример id="Книга"\]\]><\/desc>/);
  assert.match(out, /<path d="M1 1Z"\/>/);
});

test('SVG rejects invalid UTF-8 instead of downloading corrupted characters', () => {
  assert.throws(() => prepareSvgExport(Uint8Array.of(0x3c, 0xd0)), /UTF-8/);
});
