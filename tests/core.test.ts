import assert from 'node:assert/strict';
import { test } from 'node:test';
import plan from '../tools/prepare-library/library-plan.json';
import { catalog, parseNames, suggestItems } from '../src/catalog';
import { russianStem } from '../src/russian-stem';
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
test('the Russian stemmer keeps related grammatical forms together', () => {
  for (const [word, stem] of [
    ['книгами', 'книг'], ['смартфонами', 'смартфон'], ['важнейшими', 'важн'],
    ['падением', 'паден'], ['перечитывая', 'перечитыв'], ['пазухи', 'пазух']
  ] as const) assert.equal(russianStem(word), stem);
});
test('title recognition handles new inflections of names and phrases', () => {
  assert.deepEqual(suggestItems('Кошельками и телефонами').map(item => item.id), ['phone', 'wallet']);
  assert.deepEqual(suggestItems('Знаниями в дорогах').map(item => item.id), ['book', 'headphones']);
  assert.deepEqual(suggestItems('Пролили свет').map(item => item.id), ['lamp']);
});
test('curated word families cover prefixes and alternating stems inside metaphors', () => {
  for (const [title, ids] of [
    ['Перезвони мне вечером', ['phone']],
    ['Переписывала ночью', ['pen']],
    ['Собирали по кусочкам', ['puzzle']],
    ['Раскладывали по полкам', ['folder']],
    ['Грызли гранит науки', ['book']]
  ] as const) assert.deepEqual(suggestItems(title).map(item => item.id), ids, title);
});
test('new idioms choose useful motifs and keep exact phrases first among matches of the same length', () => {
  assert.deepEqual(suggestItems('Отложили на чёрный день').map(item => item.id), ['coin', 'wallet']);
  assert.deepEqual(suggestItems('Мы сошлись на одной волне').map(item => item.id), ['phone']);
  assert.deepEqual(suggestItems('Тёмная погода. Светлая мысль и подписали документы.').map(item => item.id),
    ['lamp', 'pen', 'folder']);
  assert.deepEqual(suggestItems('Две стороны одной медали').map(item => item.id), ['coin']);
});
test('a shared substring or an unrelated broad stem does not by itself pick a subject', () => {
  for (const title of ['Позвонок', 'Светодиодная панель', 'Чёрный квадрат', 'Звонкий голос']) {
    assert.throws(() => suggestItems(title), /Подходящих предметов не найдено/, title);
  }
  assert.deepEqual(suggestItems('Чёрными чернилами').map(item => item.id), ['pen']);
  assert.deepEqual(suggestItems('С пропущенными звонками').map(item => item.id), ['phone']);
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

test('SVG uses readable ASCII layer names and updates clip, mask and use references', () => {
  const title = 'Книга™📘 &amp; телефон';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg">' +
    '<!-- id="Книга" --><title>Книга</title><desc><![CDATA[Пример id="Книга"]]></desc>' +
    '<defs><clipPath id="Обрезка"><path d="M0 0Z"/></clipPath><mask id="Маска"><use href="#Контур"/></mask></defs>' +
    '<g id="' + title + '" clip-path="url(#Обрезка)" mask="url(#Маска)"><path id="Контур" d="M1 1Z"/></g></svg>';
  const out = prepareSvgExport(new TextEncoder().encode('\uFEFF' + svg));
  const id = /clipPath id="([^"]+)"/.exec(out)![1];
  const ref = /clip-path="url\(#([^)]+)\)"/.exec(out)![1];
  assert.equal(id, 'Obrezka');
  assert.equal(ref, id);
  assert.equal(/<g id="([^"]+)"/.exec(out)![1], 'KnigaTM-telefon');
  assert.match(out, /mask="url\(#Maska\)"/);
  assert.match(out, /<use href="#Kontur"\/>/);
  assert.match(out, /<!-- id="Книга" --><title>Книга<\/title><desc><!\[CDATA\[Пример id="Книга"\]\]><\/desc>/);
  assert.match(out, /<path id="Kontur" d="M1 1Z"\/>/);
  assert.equal(validateSvg(out), out);
});

test('SVG makes distinct ID slugs for duplicate layers and protects existing ASCII IDs', () => {
  const result = prepareSvgExport(new TextEncoder().encode('<svg><g id="Книга"><path d="M0 0Z"/></g>' +
    '<g id="Kniga"><path d="M1 1Z"/></g><use href="#Книга"/><g id="Книга"><path d="M2 2Z"/></g></svg>'));
  assert.deepEqual([...result.matchAll(/ id="([^"]+)"/g)].map(match => match[1]), ['Kniga-2', 'Kniga', 'Kniga-3']);
  assert.match(result, /<use href="#Kniga-2"\/>/);
});

test('SVG keeps named objects as sibling groups and clips only layers that can overflow', () => {
  const svg = '<svg width="100" height="80" viewBox="0 0 100 80" xmlns="http://www.w3.org/2000/svg">' +
    '<g clip-path="url(#clip0)"><g id="Сцена"><rect width="100" height="80" fill="white"/>' +
    '<g id="Фон"><path d="M-1 0L101 0L101 81Z"/></g>' +
    '<g id="Книга"><path d="M20 20L30 40Z"/></g>' +
    '<g id="Телефон"><path d="M45 20L50 30Z"/></g></g></g>' +
    '<defs><clipPath id="clip0"><rect width="100" height="80"/></clipPath></defs></svg>';
  const result = prepareSvgExport(new TextEncoder().encode(svg),
    { name: 'Сцена', width: 100, height: 80, inside: new Set(['Книга', 'Телефон']) });
  assert.match(result, /<rect width="100" height="80" fill="white"\/><g id="Fon-crop"><g clip-path="url\(#clip0\)"><g id="Fon"/);
  assert.match(result, /<\/g><\/g><\/g><g id="Kniga"><path[^>]+\/><\/g><g id="Telefon">/);
  assert.equal(validateSvg(result), result);
});

test('SVG preserves authored group effects and round viewport clipping', () => {
  const frame = { name: 'Кадр', width: 100, height: 80, inside: new Set(['Книга']) };
  const clipped = '<svg><g id="Кадр" clip-path="url(#c)"><g id="Книга"><path d="M0 0Z"/></g></g>' +
    '<defs><clipPath id="c"><rect width="100" height="80" rx="10"/></clipPath></defs></svg>';
  const result = prepareSvgExport(new TextEncoder().encode(clipped), frame);
  assert.match(result, /<g id="Kadr" clip-path="url\(#c\)"><g id="Kniga">/);
  const opacity = prepareSvgExport(new TextEncoder().encode(clipped.replace('<g id="Кадр"', '<g opacity=".5" id="Кадр"')), frame);
  assert.match(opacity, /<g opacity=".5" id="Kadr" clip-path="url\(#c\)"><g id="Kniga">/);
});

test('SVG preserves a composition layer with the frame name even when its bounds are unknown', () => {
  const frame = { name: 'Кадр', width: 100, height: 80, inside: new Set<string>(), layers: new Set(['Кадр']) };
  const clip = '<defs><clipPath id="c"><rect width="100" height="80"/></clipPath></defs>';
  const artwork = '<path d="M0 0Z"/><path d="M2 2Z"/>';
  for (const svg of [
    `<svg><g clip-path="url(#c)"><g id="Кадр">${artwork}</g></g>${clip}</svg>`,
    `<svg><g id="Кадр"><g clip-path="url(#c)">${artwork}</g></g>${clip}</svg>`
  ]) {
    const result = prepareSvgExport(new TextEncoder().encode(svg), frame);
    assert.match(result, /<g id="Kadr">/);
    assert.equal(validateSvg(result), result);
  }
});

test('SVG retains namespace declarations on candidate frame and clip wrappers', () => {
  const frame = { name: 'Кадр', width: 100, height: 80, inside: new Set(['Книга']) };
  const ns = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
  const clip = '<defs><clipPath id="c"><rect width="100" height="80"/></clipPath><path id="p" d="M0 0Z"/></defs>';
  const book = '<g id="Книга"><use xlink:href="#p"/></g>';
  for (const group of [
    `<g id="Кадр" ${ns}><g clip-path="url(#c)">${book}</g></g>`,
    `<g clip-path="url(#c)" ${ns}><g id="Кадр">${book}</g></g>`,
    `<g clip-path="url(#c)"><g id="Кадр" ${ns}>${book}<path d="M0 0Z"/></g></g>`
  ]) {
    const result = prepareSvgExport(new TextEncoder().encode(`<svg>${group}${clip}</svg>`), frame);
    assert.match(result, /xmlns:xlink=/);
    assert.match(result, /<use xlink:href="#p"\/>/);
    assert.equal(validateSvg(result), result);
  }
});

test('SVG rejects invalid UTF-8 instead of downloading corrupted characters', () => {
  assert.throws(() => prepareSvgExport(Uint8Array.of(0x3c, 0xd0)), /UTF-8/);
});
