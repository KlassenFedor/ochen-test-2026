import assert from 'node:assert/strict';
import { test } from 'node:test';
import plan from '../tools/prepare-library/library-plan.json';
import { catalog, parseNames, suggestItems } from '../src/catalog';
import { keepCenter, planLayout, planAddition } from '../src/layout';
import { fromHex, parsePalette, readPaletteChoice } from '../src/palette';
import { readCommand } from '../src/protocol';
import { svgFilename, validateSvg } from '../src/svg';
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
test('replacing a rotated item preserves its center with different master dimensions', () => {
  assert.deepEqual(keepCenter([[0, -1, 100], [1, 0, 200]], shape(80, 30), shape(60, 90)),
    [[0, -1, 130], [1, 0, 210]]);
});
test('SVG keeps vector effects but rejects raster and foreign HTML markup', () => {
  const vector = '<svg><defs><clipPath id="c"><path d="M0 0Z"/></clipPath></defs><path clip-path="url(#c)" /></svg>';
  assert.equal(validateSvg(vector), vector);
  for (const tag of ['image', 'svg:image', 'feImage', 'foreignObject']) {
    assert.throws(() => validateSvg(`<svg><${tag}/></svg>`), /растровую вставку/);
  }
  assert.throws(() => validateSvg('<svg>'), /неполный SVG/);
  assert.equal(svgFilename('Книга, телефон · L'), 'Книга-телефон-L.svg');
});
