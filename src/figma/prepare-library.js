import { prepareSvgExport } from '../svg';
import P from '../../tools/prepare-library/library-plan.json';
import { demoSectionName, findLibrarySections, indexLibrary, libraryKeys, libraryMetadata, librarySectionName,
  librarySections, validateInstalledLibrary } from './library';
import { applyArtwork, bundleExtras, validateBundle } from './library-bundle.js';

const rgbKey = c => [c.r, c.g, c.b].map(v => v.toFixed(7)).join(',');
const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const coordinateTolerance = 0.002;
const unitTolerance = 1e-6;

function allNodes(root) {
  const result = [], stack = [root];
  while (stack.length) {
    const n = stack.pop(); result.push(n);
    if ('children' in n) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return result;
}

export function artworkSnapshot(root) {
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

export function matrixMultiply(a, b) {
  return [
    [a[0][0]*b[0][0]+a[0][1]*b[1][0], a[0][0]*b[0][1]+a[0][1]*b[1][1], a[0][0]*b[0][2]+a[0][1]*b[1][2]+a[0][2]],
    [a[1][0]*b[0][0]+a[1][1]*b[1][0], a[1][0]*b[0][1]+a[1][1]*b[1][1], a[1][0]*b[0][2]+a[1][1]*b[1][2]+a[1][2]]
  ];
}

export function inverse(m) {
  const d = m[0][0]*m[1][1]-m[0][1]*m[1][0];
  if (Math.abs(d) < 1e-10) throw new Error('Вырожденная матрица исходника');
  const a=m[1][1]/d,b=-m[0][1]/d,c=-m[1][0]/d,e=m[0][0]/d;
  return [[a,b,-a*m[0][2]-b*m[1][2]],[c,e,-c*m[0][2]-e*m[1][2]]];
}

export function tasks() {
  const result = [];
  for (const item of P.objects) for (const size of ['large', 'small']) for (const role of ['main', 'background']) {
    const key = `${item.id}/${size}/${role}`;
    result.push({ key, family: item.id, label: item.name, size, role, scheme: 'violet', sourceId: item.sources[size][role], companions: P.companions[key] || [] });
  }
  for (const b of P.backgrounds) result.push({ key: `background/${b.size}/${b.scheme}`, family: 'background', label: 'Фон', size: b.size, scheme: b.scheme, sourceId: b.id, companions: [] });
  return result;
}

async function inspectSources(figma, page, work, checkOpen) {
  const sources = new Map();
  const ids = new Set(work.flatMap(t => [t.sourceId, ...t.companions]));
  for (const id of ids) {
    const n = await figma.getNodeByIdAsync(id);
    checkOpen();
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

async function readPalettes(figma, checkOpen) {
  const palettes = [];
  for (const entry of P.palettes) {
    const group = await figma.getNodeByIdAsync(entry.sourceId);
    checkOpen();
    if (!group || !('children' in group)) throw new Error(`Не найдены образцы ${entry.id}`);
    const swatches = group.children.filter(n => n.type === 'RECTANGLE').sort((a,b) => a.x-b.x || a.y-b.y);
    if (swatches.length !== 8 || swatches.some(n => n.fills.length !== 1 || n.fills[0].type !== 'SOLID')) throw new Error(`Изменилась структура палитры ${entry.id}`);
    palettes.push({ id: entry.id, name: entry.name, background: swatches.slice(0,4).map(n=>n.fills[0].color), object: swatches.slice(4).map(n=>n.fills[0].color) });
  }
  return palettes;
}

export async function prepareTokens(figma, { created, checkOpen }, palettes, extras, reuseOnly = false) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync('COLOR');
  checkOpen();
  const collection = name => {
    const found = collections.filter(c=>c.name===name);
    if (found.length>1) throw new Error(`Дублируется коллекция ${name}`);
    if (found.length) return found[0];
    if (reuseOnly) throw new Error(`Не найдена коллекция «${name}».`);
    const c=figma.variables.createVariableCollection(name);
    created.collections.push(c); collections.push(c); c.renameMode(c.defaultModeId,'Value'); return c;
  };
  const variable = (c,name,value,scopes,syntax,description) => {
    const found=variables.filter(v=>v.variableCollectionId===c.id&&v.name===name);
    if(found.length>1)throw new Error(`Дублируется переменная ${c.name}/${name}`);
    if (found.length) {
      const current = found[0].valuesByMode[c.defaultModeId];
      if (!current || Object.keys(value).some(key => current[key] !== value[key])) {
        throw new Error(`Существующая переменная изменена: ${c.name}/${name}`);
      }
      return found[0];
    }
    if (reuseOnly) throw new Error(`Не найдена переменная «${c.name}/${name}».`);
    const v=figma.variables.createVariable(name,c,'COLOR');
    created.variables.push(v); variables.push(v);
    v.setValueForMode(c.defaultModeId,value); v.scopes=scopes; v.setVariableCodeSyntax('WEB',`var(--${syntax})`);
    if (description) v.description = description;
    return v;
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
  const used=new Set();
  for(const [key,rgb]of extras){
    let name=`detail/source-${hex(rgb).slice(1).toLowerCase()}`,suffix=2;
    while(used.has(name))name=`detail/source-${hex(rgb).slice(1).toLowerCase()}-${suffix++}`;
    used.add(name);
    const primitive=variable(sourceCollection,name,{...rgb,a:1},[],`source-${name.replaceAll('/','-')}`);
    const semantic=variable(detailCollection,name,{type:'VARIABLE_ALIAS',id:primitive.id},scopes,
      `illustration-${name.replaceAll('/','-')}`,'Точный оттенок исходника вне основных позиций. Постоянная деталь; не угадывать слот палитры.');
    tokens.details.set(key,{variable:semantic,rgb,name});
  }
  return tokens;
}

function paletteSlots(palette) {
  const slots = new Map();
  for (const channel of ['background', 'object']) for (const [index, color] of palette[channel].entries()) {
    const key = rgbKey(color);
    const matches = slots.get(key) ?? [];
    matches.push(`${channel}/${index}`);
    slots.set(key, matches);
  }
  return slots;
}

function paintSlot(slots, task, node, field, index, paint) {
  const where = `${task.key}, слой «${node.name}» (${node.id ?? 'копия'}), ${field}[${index + 1}]`;
  if (paint.type !== 'SOLID') throw new Error(`Неподдерживаемая краска ${paint.type}: ${where}`);
  const key = rgbKey(paint.color);
  if (task.family === 'background' && key === '1.0000000,1.0000000,1.0000000') return;
  const matches = slots.get(key) ?? [];
  const allowed = task.family === 'background' || task.role === 'background'
    ? matches.filter(slot => slot.startsWith('background/')) : matches;
  if (allowed.length > 1 || (matches.length && !allowed.length)) {
    throw new Error(`Неоднозначная или недопустимая привязка ${hex(paint.color)}: ${where}. Позиции: ${matches.join(', ')}.`);
  }
  return allowed[0];
}

function inspectPaintSlots(palettes, work, sources) {
  const extras = new Map();
  for (const task of work) {
    const slots = paletteSlots(palettes.find(palette => palette.id === task.scheme));
    for (const id of [task.sourceId, ...task.companions]) for (const node of allNodes(sources.get(id))) {
      for (const field of ['fills', 'strokes']) {
        if (!Array.isArray(node[field])) continue;
        for (const [index, paint] of node[field].entries()) {
          if (!paintSlot(slots, task, node, field, index, paint)) extras.set(rgbKey(paint.color), paint.color);
        }
      }
    }
  }
  return extras;
}

export function bindArtwork(figma, root, task, palette, tokens) {
  const slots = paletteSlots(palette);
  const bindings=[],stack=[{node:root,path:[]}];
  while(stack.length){
    const {node:n,path}=stack.pop();
    for(const channel of ['fills','strokes'])if(channel in n && Array.isArray(n[channel])){
      n[channel]=n[channel].map((paint,index)=>{
        const slot = paintSlot(slots, task, n, channel, index, paint);
        const key=rgbKey(paint.color),fixed=tokens.details.get(key);
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

function createVariant(figma, created, task, section, sources) {
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

export function verifyArtwork(key, sourceId, before, clone, local) {
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

async function makeOverview(figma, { created, checkOpen }, section, entries, tokens) {
  const label=await figma.getNodeByIdAsync('27:11478');
  checkOpen();
  const font=label&&label.type==='TEXT'&&label.fontName!==figma.mixed?label.fontName:{family:'Inter',style:'Regular'};
  await figma.loadFontAsync(font);
  checkOpen();
  const local=await figma.getLocalTextStylesAsync();
  checkOpen();
  const style=(name,size)=>{let s=local.find(s=>s.name===name);if(!s){s=figma.createTextStyle();created.styles.push(s);s.name=name;s.fontName=font;s.fontSize=size;}return s;};
  const body=style('Illustration / Documentation / Body',22),title=style('Illustration / Documentation / Title',36);
  const paint=variable=>figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r:1,g:1,b:1}},'color',variable);
  const text=async(value,heading=false)=>{checkOpen();const n=figma.createText();created.nodes.push(n);await n.setTextStyleIdAsync((heading?title:body).id);checkOpen();n.characters=value;n.fills=[paint(tokens.palettes.violet['background/3'])];return n;};
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

async function validateAndReport({ checkOpen, status }, section, work, sources, palettes, tokens) {
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
    const slots = paletteSlots(palettes.find(palette => palette.id === task.scheme));
    const names=new Map();for(const [scheme,slots]of Object.entries(tokens.palettes))for(const [slot,v]of Object.entries(slots))names.set(v.id,{slot,scheme,fixed:false});
    for(const d of tokens.details.values())names.set(d.variable.id,{slot:d.name,fixed:true});
    while(stack.length){const{node:n,path}=stack.pop();for(const channel of ['fills','strokes'])if(channel in n&&Array.isArray(n[channel]))for(let i=0;i<n[channel].length;i++){
      const paint=n[channel][i],binding=paint.boundVariables&&paint.boundVariables.color,meta=binding&&names.get(binding.id);
      if(paint.type!=='SOLID'||!meta)throw new Error(`Непривязанный канал в ${task.key}`);
      const expected = paintSlot(slots, task, n, channel, i, paint);
      if (expected ? meta.slot !== expected || meta.scheme !== task.scheme : !meta.fixed) {
        throw new Error(`Неверная привязка в ${task.key}, слой «${n.name}», ${channel}[${i + 1}]: ${meta.slot}.`);
      }
      bindings.push({path,channel,index:i,...meta});
    }if('children'in n)for(let i=n.children.length-1;i>=0;i--)stack.push({node:n.children[i],path:[...path,i]});}
    status(`Проверка SVG ${index+1}/${work.length}: ${task.key}`);
    const bytes=await component.exportAsync({format:'SVG',svgIdAttribute:true});
    checkOpen();
    try { prepareSvgExport(bytes); }
    catch (error) { throw new Error(`${task.key}: ${error.message}`); }
    variants.push({key:task.key,family:task.family,size:task.size,...(task.role?{role:task.role}:{}),scheme:task.scheme,sourceName:source.name,width:component.width,height:component.height,bindings});
    inspection.push({key:task.key,componentId:component.id,svgBytes:bytes.length,geometryVerified:true,rasterFree:true,pieces});
  }
  return {version:1,fileKey:P.fileKey,pageName:section.parent.name,sectionName:librarySectionName,sectionId:section.id,resolver:{setName:'family',properties:{size:'Size',role:'Role',scheme:'Scheme'},note:'ID исходников используются только в inspection, не при поиске компонентов.'},objects:P.objects.map(({id,name})=>({id,name})),variants,palettes:palettes.map(p=>({id:p.id,name:p.name,background:p.background.map(hex),object:p.object.map(hex),sourceRgb:{background:p.background,object:p.object}})),fixedDetails:[...tokens.details.values()].map(d=>({name:d.name,color:hex(d.rgb),rgb:d.rgb,policy:'preserve'})),inspection,manualChecks:['Визуально сверить обзор с исходниками','Экспортировать сцену с книгой и телефоном и повторно импортировать SVG в Figma']};
}

export function demoSection(figma, created, page, library) {
  const sections = page.children.filter(node => node.type === 'SECTION' && node.name === demoSectionName);
  if (sections.length > 1) throw new Error(`Найдены дубликаты «${demoSectionName}»`);
  if (!library || sections.length) return sections[0];
  const demo = figma.createSection();
  created.sections.push(demo);
  page.appendChild(demo);
  demo.name = demoSectionName;
  demo.x = library.x;
  demo.y = library.y + library.height + 400;
  demo.resizeWithoutConstraints(4200, 2600);
  return demo;
}

export function createPreparation(figma, status) {
  const created = { sections: [], nodes: [], variables: [], collections: [], styles: [] };
  let cancelled = false;
  let rollbackFailed = false;
  let revertPageLink;
  const resized = new Map();
  const checkOpen = () => {
    if (cancelled) throw new Error('Подготовка отменена.');
  };

  function rollback() {
    const failures = [];
    if (revertPageLink) {
      try { revertPageLink(); } catch (error) { failures.push(error); }
      revertPageLink = undefined;
    }
    for (const kind of ['sections', 'nodes', 'styles', 'variables', 'collections']) {
      for (const entry of created[kind].splice(0).reverse()) {
        try { if (!entry.removed) entry.remove(); }
        catch (error) { failures.push(error); }
      }
    }
    for (const [node, { width, height }] of [...resized].reverse()) {
      try { if (!node.removed) node.resizeWithoutConstraints(width, height); }
      catch (error) { failures.push(error); }
    }
    resized.clear();
    if (failures.length) {
      rollbackFailed = true;
      console.error('Не удалось полностью откатить подготовку библиотеки', failures);
    }
  }

  const attempt = { created, checkOpen, status };
  function commit() {
    if (resized.size || Object.values(created).some(entries => entries.length)) figma.commitUndo();
    for (const entries of Object.values(created)) entries.length = 0;
    resized.clear();
    revertPageLink = undefined;
  }

  function expand(node, width, height) {
    if (width <= node.width && height <= node.height) return;
    if (!resized.has(node)) resized.set(node, { width: node.width, height: node.height });
    node.resizeWithoutConstraints(Math.max(node.width, width), Math.max(node.height, height));
  }

  async function install(bundle) {
    validateBundle(bundle);
    const found = await findLibrarySections(figma);
    checkOpen();
    if (found?.masters.length > 1 || found?.demos.length > 1) throw new Error('Найдены дубликаты секций библиотеки.');
    const existing = found?.masters[0];
    const indexed = existing && indexLibrary(existing);
    const page = found?.page ?? figma.currentPage;
    await figma.setCurrentPageAsync(page);
    checkOpen();
    const missing = bundle.variants.filter(({ key }) => !indexed?.index.has(key));
    if (existing && !missing.length) {
      // Common repair: the demo section was removed but the library and palette are intact.
      const intact = await validateInstalledLibrary(figma, existing).then(() => true, () => false);
      checkOpen();
      if (intact) {
        demoSection(figma, created, page, existing);
        commit();
        return;
      }
    }
    status('Установка палитр…');
    const tokens = await prepareTokens(figma, attempt, bundle.palettes, bundleExtras(bundle, rgbKey));
    checkOpen();

    const section = existing ?? figma.createSection();
    if (!existing) {
      created.sections.push(section);
      page.appendChild(section);
      section.name = librarySectionName;
      section.x = page.children.reduce((right, node) => node === section ? right : Math.max(right, node.x + node.width), 0) +
        (page.children.length > 1 ? 160 : 0);
      section.y = 0;
    }
    const families = new Map();
    for (const [index, { key, tree }] of missing.entries()) {
      checkOpen();
      status(`Установка библиотеки · ${index + 1}/${missing.length}`);
      const master = figma.createComponent();
      created.nodes.push(master);
      section.appendChild(master);
      master.resizeWithoutConstraints(tree.width, tree.height);
      await applyArtwork(figma, attempt, master, tree, tokens, rgbKey);
      const [family, size, variant] = key.split('/');
      master.name = `Size=${size}, ${family === 'background' ? 'Scheme' : 'Role'}=${variant}`;
      const set = indexed?.families.get(family);
      if (set) {
        const right = Math.max(60, ...set.children.map(node => node.x + node.width + 60));
        set.appendChild(master);
        master.x = right;
        master.y = 60;
        expand(set, right + master.width + 60, master.height + 120);
        continue;
      }
      const entries = families.get(family) ?? [];
      entries.push(master);
      families.set(family, entries);
    }
    checkOpen();
    const sets = [...families].map(([family, masters]) => {
      const set = figma.combineAsVariants(masters, section);
      created.nodes.push(set);
      set.name = family;
      gridSet(set);
      return set;
    });
    if (sets.length) {
      const left = existing ? Math.max(40, ...section.children.filter(node => !sets.includes(node))
        .map(node => node.x + node.width + 120)) : 40;
      const cellWidth = Math.max(...sets.map(set => set.width)) + 120;
      const cellHeight = Math.max(...sets.map(set => set.height)) + 120;
      sets.forEach((set, i) => {
        set.x = left + (i % 2) * cellWidth;
        set.y = 40 + Math.floor(i / 2) * cellHeight;
      });
    }
    expand(section, Math.max(...section.children.map(node => node.x + node.width)) + 40,
      Math.max(...section.children.map(node => node.y + node.height)) + 40);
    demoSection(figma, created, page, section);
    if (!found) {
      const { namespace, pageKey } = libraryMetadata;
      const previous = figma.root.getSharedPluginData(namespace, pageKey);
      figma.root.setSharedPluginData(namespace, pageKey, page.id);
      revertPageLink = () => figma.root.setSharedPluginData(namespace, pageKey, previous);
    }
    await validateInstalledLibrary(figma, section);
    checkOpen();
    commit();
  }

  async function prepare(mode) {
    status('Проверка библиотеки…');
    const { page, masters } = await librarySections(figma);
    checkOpen();
    if (masters.length > 1) throw new Error('Найдены дубликаты подготовленной библиотеки.');
    let section = masters[0];
    const demo = demoSection(figma, created, page);
    if (mode === 'verify' && (!section || !demo)) throw new Error('Сначала нажмите «Подготовить библиотеку».');

    if (section) await validateInstalledLibrary(figma, section);
    checkOpen();
    if (section && mode === 'setup') {
      if (!demo) {
        await figma.setCurrentPageAsync(page);
        checkOpen();
        demoSection(figma, created, page, section);
        commit();
      }
      return { text: 'Библиотека готова. Можно собирать композиции.' };
    }

    const work = tasks();
    let overview = section?.children.find(n => n.type === 'FRAME' && n.name === 'Обзор · 46 экземпляров');
    if (mode === 'verify') {
      const sample = await figma.getNodeByIdAsync(work[0].sourceId);
      checkOpen();
      let ancestor = sample?.parent;
      while (ancestor && ancestor.type !== 'PAGE') ancestor = ancestor.parent;
      if (ancestor?.id !== page.id) {
        return {
          text: 'Проверены 46 установленных мастеров, три палитры и цветовые привязки.',
          report: { version: 1, pageName: page.name, sectionId: section.id, variants: libraryKeys }
        };
      }
    }
    status('Проверка исходных слоёв и палитр…');
    const sources = await inspectSources(figma, page, work, checkOpen);
    const palettes = await readPalettes(figma, checkOpen);
    checkOpen();
    await figma.setCurrentPageAsync(page);
    checkOpen();
    const tokens = await prepareTokens(figma, attempt, palettes, inspectPaintSlots(palettes, work, sources), mode === 'verify');
    checkOpen();

    if (!section) {
      status('Создание 46 мастер-компонентов…');
      const right = Math.max(0, ...page.children.map(n => n.x + n.width));
      section = figma.createSection();
      created.sections.push(section);
      page.appendChild(section);
      section.name = librarySectionName;
      section.x = right + 600;
      section.y = -3376;
      const entries = work.map(task => {
        const component = createVariant(figma, created, task, section, sources);
        bindArtwork(figma, component, task, palettes.find(p => p.id === task.scheme), tokens);
        return { task, component };
      });
      const sets = [...P.objects.map(object => object.id), 'background'].map(family => {
        const set = figma.combineAsVariants(entries.filter(e => e.task.family === family).map(e => e.component), section);
        created.nodes.push(set);
        set.name = family;
        set.description = family === 'background'
          ? 'Фоны из оригинала. Size: large/small; Scheme: violet/peach/turquoise.'
          : `${P.objects.find(object => object.id === family).name}. Size: large/small; Role: main/background. Ключ: ${family}/{Size}/{Role}.`;
        gridSet(set);
        return set;
      });
      overview = await makeOverview(figma, attempt, section, entries, tokens);
      checkOpen();
      const cellW = Math.max(...sets.map(set => set.width)) + 120;
      const cellH = Math.max(...sets.map(set => set.height)) + 160;
      const top = overview.y + overview.height + 160;
      sets.forEach((set, i) => {
        set.x = 40 + (i % 2) * cellW;
        set.y = top + Math.floor(i / 2) * cellH;
      });
      section.resizeWithoutConstraints(Math.max(overview.width + 80, cellW * 2 + 80),
        top + Math.ceil(sets.length / 2) * cellH + 80);
    }
    if (!overview || allNodes(overview).filter(node => node.type === 'INSTANCE').length !== 46) {
      throw new Error('Обзор должен содержать 46 экземпляров.');
    }
    demoSection(figma, created, page, section);
    const report = await validateAndReport(attempt, section, work, sources, palettes, tokens);
    checkOpen();
    figma.currentPage.selection = [overview];
    figma.viewport.scrollAndZoomIntoView([overview]);
    commit();
    return { text: 'Библиотека готова. В обзоре 40 вариантов предметов и 6 фонов.', report };
  }

  async function run(operation) {
    try {
      return await operation();
    } catch (error) {
      rollback();
      if (rollbackFailed) {
        throw new Error('Откат неполный. Проверьте изменения в Figma.', { cause: error });
      }
      if (cancelled) throw new Error('Подготовка отменена. Изменения удалены.');
      throw new Error(`Не удалось подготовить библиотеку. ${error.message}`, { cause: error });
    }
  }

  return {
    run: mode => run(() => prepare(mode)),
    install: bundle => run(() => install(bundle)),
    cancel() {
      cancelled = true;
      rollback();
    }
  };
}
