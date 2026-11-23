import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const plan = JSON.parse(await readFile(new URL('library-plan.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('main.js', import.meta.url), 'utf8');
const figma = {
  showUI() {}, ui: { postMessage() {} },
  variables: { setBoundVariableForPaint: (paint, field, variable) => ({ ...paint, boundVariables: { [field]: { type:'VARIABLE_ALIAS', id:variable.id } } }) }
};
const context = vm.createContext({ figma, LIBRARY_PLAN:plan, console });
vm.runInContext(source.slice(0, source.lastIndexOf('\nrun().catch')) + '\nglobalThis.checked={tasks,inverse,matrixMultiply,fingerprint,bindArtwork};', context);
const { tasks, inverse, matrixMultiply, fingerprint, bindArtwork } = context.checked;
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

// A root can move; a contour or an internal layer cannot change unnoticed.
const vector={type:'VECTOR',width:20,height:30,visible:true,relativeTransform:[[1,0,3],[0,1,4]],vectorPaths:[{data:'M 0 0 L 20 30',windingRule:'NONZERO'}]};
const group={type:'GROUP',width:20,height:30,visible:true,relativeTransform:[[1,0,100],[0,1,200]],children:[vector]};
const before=fingerprint(group);group.relativeTransform[0][2]=0;assert.deepEqual(normal(fingerprint(group)),normal(before));
vector.relativeTransform[0][2]=5;assert.notEqual(fingerprint(group).hash,before.hash);
vector.relativeTransform[0][2]=3;vector.vectorPaths[0].data='M 0 0 L 19 30';assert.notEqual(fingerprint(group).hash,before.hash);

// Colour bindings must preserve opacity and distinguish a white background detail.
const palette={background:[{r:0.8,g:0.7,b:0.9},{r:0.6,g:0.5,b:0.8},{r:0.4,g:0.3,b:0.7},{r:0.1,g:0.1,b:0.1}],object:[{r:1,g:0.9,b:0.7},{r:1,g:0.6,b:0.7},{r:1,g:0.9,b:0.9},{r:1,g:1,b:1}]};
const slots=Object.fromEntries(['background','object'].flatMap(ch=>palette[ch].map((c,i)=>[`${ch}/${i}`,{id:`${ch}-${i}`}])));
const tokens={palettes:{violet:slots},details:new Map([['1.0000000,1.0000000,1.0000000',{name:'detail/white',variable:{id:'fixed-white'}}]])};
const artwork={type:'VECTOR',fills:[{type:'SOLID',color:palette.object[3],opacity:0.35}],strokes:[{type:'SOLID',color:palette.background[2],opacity:0.6}]};
bindArtwork(artwork,{key:'background/large/violet',family:'background',scheme:'violet'},palette,tokens);
assert.equal(artwork.fills[0].boundVariables.color.id,'fixed-white');assert.equal(artwork.fills[0].opacity,0.35);
assert.equal(artwork.strokes[0].boundVariables.color.id,'background-2');assert.equal(artwork.strokes[0].opacity,0.6);
console.log('Проверено: 46 вариантов и 2 отдельные детали; преобразования координат; контроль геометрии; назначения и прозрачность красок. Запуск в Figma не выполнялся.');
