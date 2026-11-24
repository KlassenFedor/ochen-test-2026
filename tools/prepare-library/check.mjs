import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const plan = JSON.parse(await readFile(new URL('library-plan.json', import.meta.url), 'utf8'));
const figma = {
  variables: { setBoundVariableForPaint: (paint, field, variable) => ({ ...paint, boundVariables: { [field]: { type:'VARIABLE_ALIAS', id:variable.id } } }) }
};
const context = vm.createContext({ console });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import * as preparation from '../../src/figma/prepare-library.js';
      import { prepareSvgExport } from '../../src/svg';
      globalThis.checked = { ...preparation, prepareSvgExport };
    `,
    resolveDir: fileURLToPath(new URL('./', import.meta.url))
  },
  bundle: true, format: 'iife', write: false, external: ['stream', 'string_decoder']
});
vm.runInContext(outputFiles[0].text, context);
const { tasks, inverse, matrixMultiply, artworkSnapshot, verifyArtwork, bindArtwork,
  demoSection, prepareTokens, prepareSvgExport, createPreparation } = context.checked;
const normal = value => JSON.parse(JSON.stringify(value));

// The inventory must cover both roles at both sizes, without losing an original.
const work = normal(tasks());
assert.equal(work.length, 46);
assert.equal(new Set(work.map(t=>t.key)).size, 46);
assert.equal(new Set(work.flatMap(t=>[t.sourceId, ...t.companions])).size, 48);
assert.deepEqual(work.find(t=>t.key==='book/large/main').companions,['21:29952']);
for(const item of plan.objects)assert.equal(work.filter(t=>t.family===item.id).length,4);

// Relative placement of loose book details must survive translation of the master.
const original=[[1,0,-6521.356],[0,1,91.3735]],detail=[[1,0,-5494.948],[0,1,538.99]];
const relative=normal(matrixMultiply(inverse(original),detail));
assert.ok(Math.abs(relative[0][2]-1026.408)<1e-8);
assert.ok(Math.abs(relative[1][2]-447.6165)<1e-8);
assert.deepEqual(normal(matrixMultiply(inverse(original),original)),[[1,0,0],[0,1,0]]);

// Figma reports children of groups and boolean operations in their container's
// coordinates. Frame children keep their own local position.
function bookAt(x, y) {
  const position = (dx, dy) => [[1, 0, Math.fround(x + dx)], [0, 1, Math.fround(y + dy)]];
  const vector = {
    name: 'Контур', type: 'VECTOR', width: 20, height: 30, visible: true,
    relativeTransform: position(3.12345, 4.23456), vectorPaths: [{ data: 'M 0 0 L 20 30', windingRule: 'NONZERO' }]
  };
  const boolean = {
    name: 'Тень', type: 'BOOLEAN_OPERATION', width: 20, height: 30, visible: true,
    relativeTransform: position(3.12345, 4.23456), children: [vector]
  };
  const frame = {
    name: 'Рамка', type: 'FRAME', width: 30, height: 35, visible: true,
    relativeTransform: position(4, 5), children: [
      { ...vector, name: 'Деталь внутри фрейма', relativeTransform: [[1, 0, 2], [0, 1, 3]] }
    ]
  };
  return {
    name: x || y ? 'Книга' : 'Artwork', type: 'GROUP', width: 45, height: 50, visible: true,
    relativeTransform: position(0, 0), children: [boolean, frame]
  };
}
const book = bookAt(-5521.356, 3914.99);
const clone = bookAt(0, 0);
const expected = artworkSnapshot(book);
const origin = [[1, 0, 0], [0, 1, 0]];
const verify = () => verifyArtwork('book/large/main', '21:29965', expected, clone, origin);
assert.equal(verify().nodes, 5);

const contour = clone.children[0].children[0];
contour.relativeTransform[0][2] += 0.05;
assert.throws(verify, /Контур.*transform\[0\]\[2\]/);
contour.relativeTransform[0][2] -= 0.05;
contour.vectorPaths[0].data = 'M 0 0 L 19 30';
assert.throws(verify, /Контур.*vectorPaths/);
contour.vectorPaths[0].data = 'M 0 0 L 20 30';
clone.relativeTransform[1][2] = 3;
assert.throws(verify, /исходник 21:29965: transform\[1\]\[2\]/);
clone.relativeTransform[1][2] = 0;
clone.children[1].children[0].relativeTransform[0][2] = 3;
assert.throws(verify, /Деталь внутри фрейма.*transform/);

// Colour bindings must preserve opacity and distinguish a white background detail.
const palette={background:[{r:0.8,g:0.7,b:0.9},{r:0.6,g:0.5,b:0.8},{r:0.4,g:0.3,b:0.7},{r:0.1,g:0.1,b:0.1}],object:[{r:1,g:0.9,b:0.7},{r:1,g:0.6,b:0.7},{r:1,g:0.9,b:0.9},{r:1,g:1,b:1}]};
const slots=Object.fromEntries(['background','object'].flatMap(ch=>palette[ch].map((c,i)=>[`${ch}/${i}`,{id:`${ch}-${i}`}])));
const tokens={palettes:{violet:slots},details:new Map([['1.0000000,1.0000000,1.0000000',{name:'detail/white',variable:{id:'fixed-white'}}]])};
const artwork={type:'VECTOR',fills:[{type:'SOLID',color:palette.object[3],opacity:0.35}],strokes:[{type:'SOLID',color:palette.background[2],opacity:0.6}]};
bindArtwork(figma, artwork,{key:'background/large/violet',family:'background',scheme:'violet'},palette,tokens);
assert.equal(artwork.fills[0].boundVariables.color.id,'fixed-white');assert.equal(artwork.fills[0].opacity,0.35);
assert.equal(artwork.strokes[0].boundVariables.color.id,'background-2');assert.equal(artwork.strokes[0].opacity,0.6);
console.log('Проверено: 46 вариантов и 2 отдельные детали; преобразования координат; контроль геометрии; назначения и прозрачность красок. Запуск в Figma не выполнялся.');

const collision = { ...palette, object: [palette.background[2], ...palette.object.slice(1)] };
const affected = () => ({ name: 'Контур', fills: [{ type: 'SOLID', color: palette.background[2] }] });
const main = { key: 'book/large/main', family: 'book', role: 'main', scheme: 'violet' };
assert.throws(() => bindArtwork(figma, affected(), main, collision, tokens),
  /book\/large\/main.*Контур.*fills\[1\].*background\/2, object\/0/);
const background = affected();
bindArtwork(figma, background, { ...main, role: 'background' }, collision, tokens);
assert.equal(background.fills[0].boundVariables.color.id, 'background-2');
assert.throws(() => bindArtwork(figma, {
  name: 'Фоновый контур', fills: [{ type: 'SOLID', color: palette.object[1] }]
}, { ...main, role: 'background' }, palette, tokens), /Фоновый контур.*object\/1/);

for (const svg of ['<svg><g></svg>', '<svg/>', '<svg><feImage/></svg>',
  '<svg xmlns:s="http://www.w3.org/2000/svg"><s:image/></svg>']) {
  assert.throws(() => prepareSvgExport(new TextEncoder().encode(svg)), /XML|векторного|растровую/);
}
assert.equal(prepareSvgExport(new TextEncoder().encode('<svg><path d="M0 0Z"/></svg>')),
  '<svg><path d="M0 0Z"/></svg>');

const paletteFixture = plan.palettes.map(({ id }) => ({ ...palette, id }));
const collections = [], variables = [];
const removed = [];
const track = (list, value) => {
  const entry = { ...value, remove() { this.removed = true; list.splice(list.indexOf(this), 1); removed.push(this.name); } };
  list.push(entry);
  return entry;
};
let written = 0;
Object.assign(figma.variables, {
  async getLocalVariableCollectionsAsync() { return [...collections]; },
  async getLocalVariablesAsync() { return [...variables]; },
  createVariableCollection(name) {
    return track(collections, { id: name, name, defaultModeId: 'mode', renameMode() {} });
  },
  createVariable(name, collection) {
    return track(variables, {
      name, id: collection.id + '/' + name, variableCollectionId: collection.id, valuesByMode: {},
      setValueForMode(mode, color) { written++; this.valuesByMode[mode] = color; },
      setVariableCodeSyntax() { written++; }
    });
  }
});
const created = { variables: [], collections: [], sections: [] };
const attempt = { created, checkOpen() {} };
const fixed = new Map([['0.1230000,0.2340000,0.3450000', {r:0.123,g:0.234,b:0.345}]]);
await prepareTokens(figma, attempt, paletteFixture, fixed);
// Treat the first batch as already committed and modify existing metadata.
for (const entries of Object.values(created)) entries.length = 0;
const existing = variables.find(variable => variable.name.startsWith('detail/') &&
  variable.variableCollectionId === 'Illustration / Details');
existing.description = 'Ручное описание';
existing.scopes = ['SHAPE_FILL'];
written = 0;
await prepareTokens(figma, attempt, paletteFixture, fixed);
assert.equal(written, 0);
assert.equal(existing.description, 'Ручное описание');
assert.deepEqual(existing.scopes, ['SHAPE_FILL']);

const page = {
  name: 'Библиотека компонентов', children: [], async loadAsync() {},
  appendChild(node) { this.children.push(node); }
};
figma.createSection = () => ({
  type: 'SECTION', resizeWithoutConstraints(w, h) { this.width = w; this.height = h; },
  remove() { this.removed = true; page.children.splice(page.children.indexOf(this), 1); }
});
const demo = demoSection(figma, created, page, { x: 100, y: 160, height: 120 });
assert.equal(demo.name, plan.demoSection);
assert.equal(demoSection(figma, created, page, { x: 100, y: 160, height: 120 }), demo);
page.children.push({ type: 'SECTION', name: plan.demoSection });
assert.throws(() => demoSection(figma, created, page), /дубликаты/);
page.children.pop();

// A prepared copy can restore the demo without reading the original layer IDs.
demo.remove();
const masters = { type: 'SECTION', name: plan.librarySection, x: 100, y: 160, height: 120,
  children: [...new Set(work.map(task => task.family))].map(name => ({
    type: 'COMPONENT_SET', name,
    children: work.filter(task => task.family === name).map(({ size, scheme, role }) => ({
      type: 'COMPONENT', name: `Size=${size}, ${role ? `Role=${role}` : `Scheme=${scheme}`}`
    }))
  }))
};
page.children.push(masters);
figma.root = { children: [page] };
figma.setCurrentPageAsync = async () => {};
figma.getNodeByIdAsync = async () => { throw new Error('Original IDs were remapped'); };
let commits = 0;
figma.commitUndo = () => { commits++; };
let status;
let preparation = createPreparation(figma, text => { status = text; });
assert.match((await preparation.run('setup')).text, /Библиотека готова/);
assert.equal(page.children.filter(node => node.name === plan.demoSection).length, 1);
assert.equal(commits, 1);
assert.match(status, /Проверка/);
preparation.cancel();
assert.equal(page.children.length, 2, 'closing after commit preserves the new section');
assert.match((await createPreparation(figma, () => {}).run('setup')).text, /готова/);
assert.equal(commits, 1, 'a repeated setup does not touch the document');

page.children[1].remove();
let resume;
figma.setCurrentPageAsync = () => new Promise(resolve => { resume = resolve; });
preparation = createPreparation(figma, () => {});
const pending = preparation.run('setup');
while (!resume) await Promise.resolve();
preparation.cancel();
resume();
await assert.rejects(pending, /Подготовка отменена/);
assert.deepEqual(page.children, [masters]);

figma.setCurrentPageAsync = async () => {};
figma.commitUndo = () => { throw new Error('Commit failed'); };
await assert.rejects(createPreparation(figma, () => {}).run('setup'), /Commit failed/);
assert.deepEqual(page.children, [masters], 'a late failure rolls back the created section');
assert.ok(variables.includes(existing));
console.log('Проверено: неоднозначные RGB, общий SVG-валидатор, сохранение переменных, восстановление демосекции из копии, отмена и откат.');
