/* global figma, LIBRARY_PLAN */
// Built by build.mjs. This is a one-time migration, not the composition plugin.
'use strict';

const P = LIBRARY_PLAN;
const created = { sections: [], nodes: [], variables: [], collections: [], styles: [] };
const rgbKey = c => [c.r, c.g, c.b].map(v => v.toFixed(7)).join(',');
const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const coordinateTolerance = 0.002;
const unitTolerance = 1e-6;

figma.showUI(`<!doctype html><meta charset="utf-8"><style>
body{font:14px system-ui;padding:16px;color:#181817}button{padding:10px;margin:8px 8px 8px 0}
pre{white-space:pre-wrap}img{width:100%;height:auto;border:1px solid #ddd}
</style><h2>Подготовка библиотеки</h2><pre id="status">Проверка исходников…</pre>
<button id="save" disabled>Скачать каталог и отчёт</button><button id="close">Закрыть</button><img id="preview" hidden>
<script>
let report;
onmessage=({data})=>{const m=data.pluginMessage;if(!m)return;
 if(m.status)document.getElementById('status').textContent=m.status;
 if(m.report){report=m.report;document.getElementById('save').disabled=false;}
 if(m.preview){const img=document.getElementById('preview');img.src=URL.createObjectURL(new Blob([new Uint8Array(m.preview)],{type:'image/png'}));img.hidden=false;}
};
document.getElementById('save').onclick=()=>{const u=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='figma-library.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
document.getElementById('close').onclick=()=>parent.postMessage({pluginMessage:{type:'close'}},'*');
</script>`, { width: 540, height: 640 });
figma.ui.onmessage = m => { if (m.type === 'close') figma.closePlugin(); };
const status = message => figma.ui.postMessage({ status: message });

function allNodes(root) {
  const result = [], stack = [root];
  while (stack.length) {
    const n = stack.pop(); result.push(n);
    if ('children' in n) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return result;
}

function artworkSnapshot(root) {
  const rows = [];
  const visit = (node, parent, path) => {
    const { name, type, width, height, visible } = node;
    const children = node.children || [];
    const row = { type, width, height, visible, children: children.length };
    if (parent) {
      // Figma reports a group or boolean's children relative to the same
      // container as that parent. Remove its offset before comparing artwork.
      const sharedContainer = parent.type === 'GROUP' || parent.type === 'BOOLEAN_OPERATION';
      row.transform = sharedContainer
        ? matrixMultiply(inverse(parent.relativeTransform), node.relativeTransform)
        : node.relativeTransform;
      row.name = name;
    }
    for (const field of ['isMask', 'maskType', 'opacity', 'blendMode', 'clipsContent', 'strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'cornerRadius', 'vectorPaths', 'effects']) {
      if (field in node) {
        const value = node[field];
        row[field] = typeof value === 'symbol' ? 'mixed' : value;
      }
    }
    for (const channel of ['fills', 'strokes']) {
      if (!(channel in node)) continue;
      const paints = node[channel];
      row[channel] = Array.isArray(paints) ? paints.map(paint => ({
        type: paint.type, visible: paint.visible ?? true, opacity: paint.opacity ?? 1,
        blendMode: paint.blendMode ?? 'NORMAL',
        ...(paint.type === 'SOLID' ? { color: paint.color } : {})
      })) : 'mixed';
    }
    rows.push({ label: `${path} «${name}»`, row });
    children.forEach((child, index) => visit(child, node, `${path}/${index + 1}`));
  };
  visit(root, null, '1');
  return rows;
}

function near(expected, actual, tolerance) {
  return Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) <= tolerance;
}

function transformDifference(expected, actual) {
  for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
    if (!near(expected[row][col], actual[row][col], col === 2 ? coordinateTolerance : unitTolerance)) {
      return `transform[${row}][${col}]: ${expected[row][col]} → ${actual[row][col]}`;
    }
  }
}

function artworkDifference(expected, actual) {
  if (expected.length !== actual.length) return `число слоёв: ${expected.length} → ${actual.length}`;
  for (const [index, { row, label }] of expected.entries()) {
    const candidate = actual[index].row;
    for (const field of new Set([...Object.keys(row), ...Object.keys(candidate)])) {
      const a = row[field], b = candidate[field];
      if (field === 'transform' && a && b) {
        const difference = transformDifference(a, b);
        if (difference) return `${label}, ${difference}`;
        continue;
      }
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      if (['width', 'height', 'strokeWeight', 'cornerRadius'].includes(field) && near(a, b, coordinateTolerance)) continue;
      const show = value => (JSON.stringify(value) ?? 'отсутствует').slice(0, 120);
      return `${label}, ${field}: ${show(a)} → ${show(b)}`;
    }
  }
}

function fingerprint(snapshot) {
  const text = JSON.stringify(snapshot.map(entry => entry.row));
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return { hash: (hash >>> 0).toString(16), nodes: snapshot.length, bytes: text.length };
}

function matrixMultiply(a, b) {
  return [
    [a[0][0]*b[0][0]+a[0][1]*b[1][0], a[0][0]*b[0][1]+a[0][1]*b[1][1], a[0][0]*b[0][2]+a[0][1]*b[1][2]+a[0][2]],
    [a[1][0]*b[0][0]+a[1][1]*b[1][0], a[1][0]*b[0][1]+a[1][1]*b[1][1], a[1][0]*b[0][2]+a[1][1]*b[1][2]+a[1][2]]
  ];
}

function inverse(m) {
  const d = m[0][0]*m[1][1]-m[0][1]*m[1][0];
  if (Math.abs(d) < 1e-10) throw new Error('Вырожденная матрица исходника');
  const a=m[1][1]/d,b=-m[0][1]/d,c=-m[1][0]/d,e=m[0][0]/d;
  return [[a,b,-a*m[0][2]-b*m[1][2]],[c,e,-c*m[0][2]-e*m[1][2]]];
}

function tasks() {
  const result = [];
  for (const item of P.objects) for (const size of ['large', 'small']) for (const role of ['main', 'background']) {
    const key = `${item.id}/${size}/${role}`;
    result.push({ key, family: item.id, label: item.name, size, role, scheme: 'violet', sourceId: item.sources[size][role], companions: P.companions[key] || [] });
  }
  for (const b of P.backgrounds) result.push({ key: `background/${b.size}/${b.scheme}`, family: 'background', label: 'Фон', size: b.size, scheme: b.scheme, sourceId: b.id, companions: [] });
  return result;
}

async function inspectSources(page, work) {
  const sources = new Map();
  const ids = new Set(work.flatMap(t => [t.sourceId, ...t.companions]));
  for (const id of ids) {
    const n = await figma.getNodeByIdAsync(id);
    if (!n || !('absoluteTransform' in n) || n.width <= 0 || n.height <= 0) throw new Error(`Не найден или повреждён исходник ${id}`);
    let ancestor = n.parent;
    while (ancestor && ancestor.type !== 'PAGE') ancestor = ancestor.parent;
    if (!ancestor || ancestor.id !== page.id) throw new Error(`Исходник ${id} находится на другой странице`);
    sources.set(id, n);
  }
  for (const t of work) {
    const source = sources.get(t.sourceId), m = source.relativeTransform;
    if (!['GROUP', 'FRAME'].includes(source.type)) throw new Error(`Неожиданный тип исходника ${t.key}`);
    if (Math.abs(m[0][0]-1)>1e-6 || Math.abs(m[1][1]-1)>1e-6 || Math.abs(m[0][1])>1e-6 || Math.abs(m[1][0])>1e-6) throw new Error(`Изменилась ориентация исходника ${t.key}; требуется повторная инвентаризация`);
  }
  return sources;
}

async function readPalettes() {
  const palettes = [];
  for (const entry of P.palettes) {
    const group = await figma.getNodeByIdAsync(entry.sourceId);
    if (!group || !('children' in group)) throw new Error(`Не найдены образцы ${entry.id}`);
    const swatches = group.children.filter(n => n.type === 'RECTANGLE').sort((a,b) => a.x-b.x || a.y-b.y);
    if (swatches.length !== 8 || swatches.some(n => n.fills.length !== 1 || n.fills[0].type !== 'SOLID')) throw new Error(`Изменилась структура палитры ${entry.id}`);
    palettes.push({ id: entry.id, name: entry.name, background: swatches.slice(0,4).map(n=>n.fills[0].color), object: swatches.slice(4).map(n=>n.fills[0].color) });
  }
  return palettes;
}

async function prepareTokens(palettes, work, sources) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync('COLOR');
  const collection = name => {
    const found = collections.filter(c=>c.name===name);
    if (found.length>1) throw new Error(`Дублируется коллекция ${name}`);
    if (found.length) return found[0];
    const c=figma.variables.createVariableCollection(name); c.renameMode(c.defaultModeId,'Value');
    collections.push(c); created.collections.push(c); return c;
  };
  const variable = (c,name,value,scopes,syntax) => {
    const found=variables.filter(v=>v.variableCollectionId===c.id&&v.name===name);
    if(found.length>1)throw new Error(`Дублируется переменная ${c.name}/${name}`);
    const v=found[0]||figma.variables.createVariable(name,c,'COLOR');
    if(!found.length){variables.push(v);created.variables.push(v);}
    const current=v.valuesByMode[c.defaultModeId];
    if(found.length && JSON.stringify(current)!==JSON.stringify(value))throw new Error(`Существующая переменная изменена: ${c.name}/${name}`);
    v.setValueForMode(c.defaultModeId,value);v.scopes=scopes;v.setVariableCodeSyntax('WEB',`var(--${syntax})`);return v;
  };
  const sourceCollection=collection('Illustration / Source');
  const detailCollection=collection('Illustration / Details');
  const tokens={ palettes:{}, details:new Map() };
  const scopes=['FRAME_FILL','SHAPE_FILL','STROKE_COLOR'];
  for(const palette of palettes){
    const c=collection(`Illustration / Palette / ${palette.id}`);tokens.palettes[palette.id]={};
    for(const channel of ['background','object'])for(let i=0;i<4;i++){
      const slot=`${channel}/${i}`,rgb=palette[channel][i];
      const primitive=variable(sourceCollection,`${palette.id}/${slot}`,{...rgb,a:1},[],`source-${palette.id}-${channel}-${i}`);
      tokens.palettes[palette.id][slot]=variable(c,slot,{type:'VARIABLE_ALIAS',id:primitive.id},scopes,`illustration-${palette.id}-${channel}-${i}`);
    }
  }
  // Preserve all non-palette colours, including hidden source artwork, exactly.
  const extras=new Map();
  for(const task of work){
    const palette=palettes.find(p=>p.id===task.scheme);
    for(const id of [task.sourceId,...task.companions])for(const n of allNodes(sources.get(id)))for(const field of ['fills','strokes'])if(field in n && Array.isArray(n[field]))for(const paint of n[field]){
      if(paint.type!=='SOLID')throw new Error(`Неподдерживаемая краска ${paint.type} в ${task.key}`);
      const matches=['background','object'].some(ch=>palette[ch].some(c=>rgbKey(c)===rgbKey(paint.color)));
      if(!matches || (task.family==='background'&&rgbKey(paint.color)==='1.0000000,1.0000000,1.0000000')) extras.set(rgbKey(paint.color),paint.color);
    }
  }
  const used=new Set();
  for(const [key,rgb]of extras){
    let name=`detail/source-${hex(rgb).slice(1).toLowerCase()}`,suffix=2;
    while(used.has(name))name=`detail/source-${hex(rgb).slice(1).toLowerCase()}-${suffix++}`;
    used.add(name);
    const primitive=variable(sourceCollection,name,{...rgb,a:1},[],`source-${name.replaceAll('/','-')}`);
    const semantic=variable(detailCollection,name,{type:'VARIABLE_ALIAS',id:primitive.id},scopes,`illustration-${name.replaceAll('/','-')}`);
    semantic.description='Точный оттенок исходника вне основных позиций. Постоянная деталь; не угадывать слот палитры.';
    tokens.details.set(key,{variable:semantic,rgb,name});
  }
  return tokens;
}

function bindArtwork(root, task, palette, tokens) {
  const slots={};
  for(const channel of ['background','object'])for(let i=0;i<4;i++)slots[rgbKey(palette[channel][i])]=`${channel}/${i}`;
  const bindings=[],stack=[{node:root,path:[]}];
  while(stack.length){
    const {node:n,path}=stack.pop();
    for(const channel of ['fills','strokes'])if(channel in n && Array.isArray(n[channel])){
      n[channel]=n[channel].map((paint,index)=>{
        if(paint.type!=='SOLID')throw new Error(`Неподдерживаемая краска в ${task.key}`);
        const key=rgbKey(paint.color),fixed=tokens.details.get(key);
        const forceDetail=task.family==='background'&&key==='1.0000000,1.0000000,1.0000000';
        const slot=!forceDetail?slots[key]:undefined;
        const variable=slot?tokens.palettes[task.scheme][slot]:fixed&&fixed.variable;
        if(!variable)throw new Error(`Нет привязки цвета ${hex(paint.color)} в ${task.key}`);
        bindings.push({path,channel,index,slot:slot||(fixed&&fixed.name),fixed:!slot});
        return figma.variables.setBoundVariableForPaint(paint,'color',variable);
      });
    }
    if('children'in n)for(let i=n.children.length-1;i>=0;i--)stack.push({node:n.children[i],path:[...path,i]});
  }
  return bindings;
}

function createVariant(task, section, sources) {
  const source=sources.get(task.sourceId),component=figma.createComponent();created.nodes.push(component);section.appendChild(component);
  component.name=task.family==='background'?`Size=${task.size}, Scheme=${task.scheme}`:`Size=${task.size}, Role=${task.role}`;
  component.resizeWithoutConstraints(source.width,source.height);component.fills=[];component.clipsContent=false;
  component.description=`${task.label}. Устойчивый ключ: ${task.key}. Исходные габариты и геометрия сохранены.`;
  const transform = inverse(source.absoluteTransform);
  for (const [index, id] of [task.sourceId, ...task.companions].entries()) {
    const original = sources.get(id);
    const before = artworkSnapshot(original);
    const local = matrixMultiply(transform, original.absoluteTransform);
    const clone = original.clone();
    created.nodes.push(clone);
    component.appendChild(clone);
    clone.relativeTransform = local;
    clone.name = index === 0 ? 'Artwork' : `Source detail ${index}`;
    verifyArtwork(task.key, id, before, clone, local);
  }
  return component;
}

function verifyArtwork(key, sourceId, before, clone, local) {
  const snapshot = artworkSnapshot(clone);
  const difference = transformDifference(local, clone.relativeTransform) || artworkDifference(before, snapshot);
  if (difference) throw new Error(`Нарушена геометрия ${key}, исходник ${sourceId}: ${difference}`);
  return fingerprint(snapshot);
}

function gridSet(set) {
  const columns=set.name==='background'?3:2,gap=60,padding=60;
  const w=Math.max(...set.children.map(c=>c.width)),h=Math.max(...set.children.map(c=>c.height));
  set.children.forEach((n,i)=>{n.x=padding+(i%columns)*(w+gap);n.y=padding+Math.floor(i/columns)*(h+gap);});
  set.resizeWithoutConstraints(padding*2+columns*w+(columns-1)*gap,padding*2+Math.ceil(set.children.length/columns)*h+(Math.ceil(set.children.length/columns)-1)*gap);
}

async function makeOverview(section, entries, tokens) {
  const label=await figma.getNodeByIdAsync('27:11478');
  const font=label&&label.type==='TEXT'&&label.fontName!==figma.mixed?label.fontName:{family:'Inter',style:'Regular'};
  await figma.loadFontAsync(font);
  const local=await figma.getLocalTextStylesAsync();
  const style=(name,size)=>{let s=local.find(s=>s.name===name);if(!s){s=figma.createTextStyle();created.styles.push(s);s.name=name;s.fontName=font;s.fontSize=size;}return s;};
  const body=style('Illustration / Documentation / Body',22),title=style('Illustration / Documentation / Title',36);
  const paint=variable=>figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r:1,g:1,b:1}},'color',variable);
  const text=async(value,heading=false)=>{const n=figma.createText();created.nodes.push(n);await n.setTextStyleIdAsync((heading?title:body).id);n.characters=value;n.fills=[paint(tokens.palettes.violet['background/3'])];return n;};
  const frame=(name,mode)=>{const n=figma.createFrame();created.nodes.push(n);n.name=name;n.layoutMode=mode;n.layoutSizingHorizontal='HUG';n.layoutSizingVertical='HUG';n.itemSpacing=24;n.fills=[];return n;};
  const gallery=frame('Обзор · 46 экземпляров','VERTICAL');section.appendChild(gallery);gallery.x=40;gallery.y=40;
  gallery.paddingTop=32;gallery.paddingBottom=32;gallery.paddingLeft=32;gallery.paddingRight=32;gallery.fills=[paint(tokens.palettes.violet['object/3'])];
  gallery.appendChild(await text('Библиотека иллюстраций',true));
  gallery.appendChild(await text('10 предметов · L/S · главная/фоновая роль · 3 исходные палитры'));
  for(const item of [...P.objects,{id:'background',name:'Фоны'}]){
    gallery.appendChild(await text(`${item.name} / ${item.id}`,true));
    const family=entries.filter(e=>e.task.family===item.id);
    for(let start=0;start<family.length;start+=item.id==='background'?3:4){
      const row=frame(`${item.id} / row-${start}`,'HORIZONTAL');gallery.appendChild(row);
      for(const entry of family.slice(start,start+(item.id==='background'?3:4))){
        const cell=frame(entry.task.key,'VERTICAL');row.appendChild(cell);
        cell.appendChild(await text(entry.task.family==='background'?`${entry.task.size} · ${entry.task.scheme}`:`${entry.task.size} · ${entry.task.role}`));
        const preview=figma.createFrame();created.nodes.push(preview);cell.appendChild(preview);preview.name='Preview';preview.resize(260,210);preview.fills=[];preview.clipsContent=false;
        const instance=entry.component.createInstance();created.nodes.push(instance);preview.appendChild(instance);
        const scale=Math.min(240/instance.width,190/instance.height);instance.rescale(scale);instance.x=(260-instance.width)/2;instance.y=(210-instance.height)/2;
      }
    }
  }
  return gallery;
}

function resolveComponent(section, task) {
  const sets=section.children.filter(n=>n.type==='COMPONENT_SET'&&n.name===task.family);
  if(sets.length!==1)throw new Error(`Ожидался один набор ${task.family}`);
  const nodes=sets[0].children.filter(n=>n.type==='COMPONENT'&&n.variantProperties.Size===task.size&&(task.family==='background'?n.variantProperties.Scheme===task.scheme:n.variantProperties.Role===task.role));
  if(nodes.length!==1)throw new Error(`Нет уникального варианта ${task.key}`);
  return nodes[0];
}

async function validateAndReport(section, work, sources, palettes, tokens) {
  const variants=[],inspection=[];
  const expectedSets=new Set(work.map(t=>t.family));
  const sets=section.children.filter(n=>n.type==='COMPONENT_SET');
  if(sets.length!==expectedSets.size)throw new Error('Неверное число наборов вариантов');
  for(const set of sets)if(set.children.length!==(set.name==='background'?6:4))throw new Error(`Неверное число вариантов ${set.name}`);
  for(let index=0;index<work.length;index++){
    const task=work[index],component=resolveComponent(section,task),source=sources.get(task.sourceId);
    if (!near(source.width, component.width, coordinateTolerance) || !near(source.height, component.height, coordinateTolerance)) {
      throw new Error(`Изменены габариты ${task.key}: ${source.width} × ${source.height} → ${component.width} × ${component.height}`);
    }
    if(component.children.length!==1+task.companions.length)throw new Error(`Неверный состав ${task.key}`);
    const pieces=[];
    const transform = inverse(source.absoluteTransform);
    for (const [i, id] of [task.sourceId, ...task.companions].entries()) {
      const original = sources.get(id);
      const local = matrixMultiply(transform, original.absoluteTransform);
      const geometry = verifyArtwork(task.key, id, artworkSnapshot(original), component.children[i], local);
      pieces.push({ sourceId: id, ...geometry });
    }
    const bindings=[],stack=[{node:component,path:[]}];
    const names=new Map();for(const [scheme,slots]of Object.entries(tokens.palettes))for(const [slot,v]of Object.entries(slots))names.set(v.id,{slot,scheme,fixed:false});
    for(const d of tokens.details.values())names.set(d.variable.id,{slot:d.name,fixed:true});
    while(stack.length){const{node:n,path}=stack.pop();for(const channel of ['fills','strokes'])if(channel in n&&Array.isArray(n[channel]))for(let i=0;i<n[channel].length;i++){
      const paint=n[channel][i],binding=paint.boundVariables&&paint.boundVariables.color,meta=binding&&names.get(binding.id);
      if(paint.type!=='SOLID'||!meta)throw new Error(`Непривязанный канал в ${task.key}`);
      bindings.push({path,channel,index:i,...meta});
    }if('children'in n)for(let i=n.children.length-1;i>=0;i--)stack.push({node:n.children[i],path:[...path,i]});}
    status(`Проверка SVG ${index+1}/${work.length}: ${task.key}`);
    const bytes=await component.exportAsync({format:'SVG',svgIdAttribute:true});
    let svg='';for(let start=0;start<bytes.length;start+=8192)svg+=String.fromCharCode(...bytes.slice(start,start+8192));
    if(!/<svg[\s>]/i.test(svg)||/<(?:image|foreignObject)(?:\s|>)/i.test(svg))throw new Error(`SVG ${task.key} содержит растр или недопустимую структуру`);
    variants.push({key:task.key,family:task.family,size:task.size,...(task.role?{role:task.role}:{}),scheme:task.scheme,sourceName:source.name,width:component.width,height:component.height,bindings});
    inspection.push({key:task.key,componentId:component.id,svgBytes:bytes.length,geometryVerified:true,rasterFree:true,pieces});
  }
  return {version:1,fileKey:P.fileKey,pageName:'Библиотека компонентов',sectionName:P.librarySection,sectionId:section.id,resolver:{setName:'family',properties:{size:'Size',role:'Role',scheme:'Scheme'},note:'ID исходников используются только в inspection, не при поиске компонентов.'},objects:P.objects.map(({id,name})=>({id,name})),variants,palettes:palettes.map(p=>({id:p.id,name:p.name,background:p.background.map(hex),object:p.object.map(hex),sourceRgb:{background:p.background,object:p.object}})),fixedDetails:[...tokens.details.values()].map(d=>({name:d.name,color:hex(d.rgb),rgb:d.rgb,policy:'preserve'})),inspection,manualChecks:['Визуально сверить обзор с исходниками','Экспортировать сцену с книгой и телефоном и повторно импортировать SVG в Figma']};
}

async function run() {
  const page=await figma.getNodeByIdAsync(P.pageId);if(!page||page.type!=='PAGE')throw new Error('Страница исходников не найдена');
  await page.loadAsync();await figma.setCurrentPageAsync(page);
  const work=tasks(),sources=await inspectSources(page,work),palettes=await readPalettes();
  const prepared=page.children.filter(n=>n.type==='SECTION'&&n.name===P.librarySection);
  if(prepared.length>1)throw new Error('Найдены дубликаты подготовленной библиотеки');
  const tokens=await prepareTokens(palettes,work,sources);
  let section=prepared[0],overview;
  if(!section){
    status('Создание 46 мастер-компонентов…');
    const right=Math.max(0,...page.children.map(n=>n.x+n.width));
    section=figma.createSection();page.appendChild(section);created.sections.push(section);section.name=P.librarySection;section.x=right+600;section.y=-3376;
    const entries=[];
    for(const task of work){const component=createVariant(task,section,sources);bindArtwork(component,task,palettes.find(p=>p.id===task.scheme),tokens);entries.push({task,component});}
    const sets=[];
    for(const family of [...P.objects.map(o=>o.id),'background']){
      const set=figma.combineAsVariants(entries.filter(e=>e.task.family===family).map(e=>e.component),section);set.name=family;
      set.description=family==='background'?'Фоны из оригинала. Size: large/small; Scheme: violet/peach/turquoise.':`${P.objects.find(o=>o.id===family).name}. Size: large/small; Role: main/background. Ключ: ${family}/{Size}/{Role}.`;
      gridSet(set);sets.push(set);
    }
    overview=await makeOverview(section,entries,tokens);
    const cellW=Math.max(...sets.map(s=>s.width))+120,cellH=Math.max(...sets.map(s=>s.height))+160,top=overview.y+overview.height+160;
    sets.forEach((set,i)=>{set.x=40+(i%2)*cellW;set.y=top+Math.floor(i/2)*cellH;});
    section.resizeWithoutConstraints(Math.max(overview.width+80,cellW*2+80),top+Math.ceil(sets.length/2)*cellH+80);
    if(!page.children.some(n=>n.type==='SECTION'&&n.name===P.demoSection)){
      const demo=figma.createSection();page.appendChild(demo);created.sections.push(demo);demo.name=P.demoSection;demo.x=section.x;demo.y=section.y+section.height+400;demo.resizeWithoutConstraints(4200,2600);
    }
  }else overview=section.children.find(n=>n.type==='FRAME'&&n.name==='Обзор · 46 экземпляров');
  if(!overview||allNodes(overview).filter(n=>n.type==='INSTANCE').length!==46)throw new Error('Обзор должен содержать 46 экземпляров');
  const report=await validateAndReport(section,work,sources,palettes,tokens);
  figma.currentPage.selection=[overview];figma.viewport.scrollAndZoomIntoView([overview]);
  // The mutation and structural/SVG validation are complete. Preview failure must
  // not remove a successfully prepared library.
  created.sections=[];created.nodes=[];created.variables=[];created.collections=[];created.styles=[];
  status('Готово: 10 предметов × 4 варианта, 6 фонов, палитры и каталог.\nПроверьте обзор и повторный импорт SVG.');
  figma.ui.postMessage({report});
  try{const bytes=await overview.exportAsync({format:'PNG',constraint:{type:'WIDTH',value:1200}});figma.ui.postMessage({preview:Array.from(bytes)});}catch(error){console.warn('Не удалось отрисовать превью',error);}
}

run().catch(error=>{
  for(const section of created.sections.reverse())if(!section.removed)section.remove();
  for(const node of created.nodes.reverse())try{if(!node.removed)node.remove();}catch(ignored){}
  for(const variable of created.variables.reverse())try{variable.remove();}catch(ignored){}
  for(const collection of created.collections.reverse())try{collection.remove();}catch(ignored){}
  for(const style of created.styles.reverse())try{style.remove();}catch(ignored){}
  console.error(error);status(`Подготовка не завершена: ${error.message}\nНовые объекты неудачного запуска удалены; исходники сохранены.`);
});
