import { schemes } from '../palette';
import { libraryKeys as bundleKeys, loadColors, openLibrary } from './library';
export { bundleKeys };

const paintFields = ['fills', 'strokes'];
const properties = [
  'opacity', 'blendMode', 'isMask', 'maskType', 'maskOutline', 'clipsContent',
  'strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'dashPattern',
  'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight',
  'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius', 'cornerSmoothing',
  'arcData', 'pointCount', 'innerRadius', 'booleanOperation', 'effects'
];

const drawableTypes = new Set([
  'FRAME', 'COMPONENT', 'INSTANCE', 'GROUP', 'BOOLEAN_OPERATION', 'VECTOR',
  'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR'
]);

export function validateBundle(bundle) {
  const variants = Array.isArray(bundle?.variants) ? bundle.variants : [];
  const keys = new Set(variants.map(variant => variant?.key));
  if (bundle?.version !== 1 || keys.size !== bundleKeys.length ||
      bundle.variants.length !== bundleKeys.length || bundleKeys.some(key => !keys.has(key)) ||
      !Array.isArray(bundle.palettes) || bundle.palettes.length !== Object.keys(schemes).length ||
      Object.keys(schemes).some(scheme => !bundle.palettes.some(palette => palette?.id === scheme &&
        ['background', 'object'].every(channel => Array.isArray(palette[channel]) &&
          palette[channel].length === 4 && palette[channel].every(isRGB))))) {
    throw new Error('Ожидается выгрузка библиотеки из 46 мастеров и трёх палитр.');
  }
  for (const { key, tree } of variants) {
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node.name !== 'string' || !drawableTypes.has(node.type) ||
          ![node.width, node.height].every(value => Number.isFinite(value) && value >= 0) ||
          !Array.isArray(node.transform) || node.transform.length !== 2 ||
          !node.transform.every(row => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite)) ||
          typeof node.visible !== 'boolean' || typeof node.locked !== 'boolean' ||
          !node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties) ||
          (node.children !== undefined && !Array.isArray(node.children)) ||
          (node.type === 'VECTOR' && !node.vector)) {
        throw new Error(`Некорректные данные слоя «${node?.name ?? '?'}» в ${key}.`);
      }
      for (const field of paintFields) {
        if (node[field] === undefined) continue;
        if (!Array.isArray(node[field]) || !node[field].every(paint => paint?.type === 'SOLID' && isRGB(paint.color) &&
          (paint.slot === 'fixed' || (Object.prototype.hasOwnProperty.call(schemes, paint.scheme) &&
            /^(background|object)\/[0-3]$/.test(paint.slot))))) {
          throw new Error(`Некорректная цветовая привязка «${node.name}» в ${key}.`);
        }
      }
      for (const child of node.children ?? []) pending.push(child);
    }
  }
  return bundle;
}

function isRGB(color) {
  return color && ['r', 'g', 'b'].every(channel =>
    Number.isFinite(color[channel]) && color[channel] >= 0 && color[channel] <= 1);
}

function capturePaint(paint, colors, name) {
  const binding = paint.boundVariables?.color;
  const slot = binding && colors.roles.get(binding.id);
  if (paint.type !== 'SOLID' || !slot) throw new Error(`Нет цветовой привязки в слое «${name}».`);
  const scheme = slot === 'fixed' ? undefined :
    Object.keys(schemes).find(scheme => colors.matchesToken(binding.id, scheme, slot));
  if (slot !== 'fixed' && !scheme) throw new Error(`Не определена палитра слоя «${name}».`);
  const { type, color, opacity, visible, blendMode } = paint;
  return { type, color, opacity, visible, blendMode, slot, scheme };
}

function copyEffects(effects) {
  return effects.map(({ boundVariables, ...effect }) => effect);
}

function captureNode(node, colors) {
  if (!drawableTypes.has(node.type)) throw new Error(`Слой «${node.name}» имеет неподдерживаемый тип ${node.type}.`);
  const result = {
    type: node.type, name: node.name, width: node.width, height: node.height,
    transform: node.relativeTransform, visible: node.visible, locked: node.locked,
    properties: {}
  };
  for (const field of properties) {
    const value = node[field];
    if (value === undefined || typeof value === 'symbol') continue;
    result.properties[field] = field === 'effects' ? copyEffects(value) : value;
  }
  if (node.type === 'VECTOR') {
    const network = node.vectorNetwork;
    result.vector = {
      ...network,
      ...(network.regions && { regions: network.regions.map(region => region.fills ? ({
        ...region,
        fills: region.fills.map(({ boundVariables, ...paint }) => paint)
      }) : region) })
    };
  }
  for (const field of paintFields) {
    const paints = node[field];
    if (paints === undefined) continue;
    if (!Array.isArray(paints)) throw new Error(`Смешанные краски в слое «${node.name}».`);
    result[field] = paints.map(paint => capturePaint(paint, colors, node.name));
  }
  if (node.children) result.children = node.children.map(child => captureNode(child, colors));
  return result;
}

export async function captureLibrary(host) {
  const [library, colors] = await Promise.all([openLibrary(host), loadColors(host)]);
  const palettes = Object.keys(schemes).map(id => ({
    ...colors.applyChoice({ kind: 'preset', scheme: id }).palette, id
  }));
  const variants = bundleKeys.map(key => {
    const [family, size, variant] = key.split('/');
    const master = family === 'background'
      ? library.background(size, variant) : library.object(size, { id: family, role: variant });
    return { key, tree: captureNode(master, colors) };
  });
  return validateBundle({ version: 1, palettes, variants });
}

export function bundleExtras(bundle, keyFor) {
  const extras = new Map();
  const pending = bundle.variants.map(variant => variant.tree);
  while (pending.length) {
    const node = pending.pop();
    for (const field of paintFields) for (const paint of node[field] ?? []) {
      if (paint.slot === 'fixed') extras.set(keyFor(paint.color), paint.color);
    }
    pending.push(...(node.children ?? []));
  }
  return extras;
}

const creators = {
  FRAME: 'createFrame', COMPONENT: 'createFrame', INSTANCE: 'createFrame',
  VECTOR: 'createVector', RECTANGLE: 'createRectangle', ELLIPSE: 'createEllipse',
  LINE: 'createLine', POLYGON: 'createPolygon', STAR: 'createStar'
};
const operations = { UNION: 'union', SUBTRACT: 'subtract', INTERSECT: 'intersect', EXCLUDE: 'exclude' };

export async function restoreArtwork(host, attempt, parent, data, tokens, keyFor) {
  const { created, checkOpen } = attempt;
  checkOpen();
  let node;
  const combined = data.type === 'GROUP' || data.type === 'BOOLEAN_OPERATION';
  if (combined) {
    const children = [];
    for (const child of data.children ?? []) {
      children.push(await restoreArtwork(host, attempt, parent, child, tokens, keyFor));
    }
    checkOpen();
    const action = data.type === 'GROUP' ? 'group' : operations[data.properties.booleanOperation];
    if (!action || !children.length) throw new Error(`Не удалось восстановить группу «${data.name}».`);
    node = host[action](children, parent);
    created.nodes.push(node);
  } else {
    const action = creators[data.type];
    if (!action) throw new Error(`Неподдерживаемый слой «${data.name}».`);
    node = host[action]();
    created.nodes.push(node);
    parent.appendChild(node);
    if (data.vector) {
      await node.setVectorNetworkAsync(data.vector);
      checkOpen();
    }
    if (Math.abs(node.width - data.width) > 0.001 || Math.abs(node.height - data.height) > 0.001) {
      node.resizeWithoutConstraints(Math.max(0.01, data.width), data.type === 'LINE' ? 0 : Math.max(0.01, data.height));
    }
    node.relativeTransform = data.transform;
  }
  return applyArtwork(host, attempt, node, data, tokens, keyFor, combined);
}

export async function applyArtwork(host, attempt, node, data, tokens, keyFor, combined = false) {
  node.name = data.name;
  for (const [field, value] of Object.entries(data.properties)) {
    if (field === 'booleanOperation' || !properties.includes(field) || !(field in node)) continue;
    node[field] = value;
  }
  for (const field of paintFields) {
    if (!data[field]) continue;
    node[field] = data[field].map(({ slot, scheme, ...paint }) => {
      const variable = slot === 'fixed' ? tokens.details.get(keyFor(paint.color))?.variable : tokens.palettes[scheme]?.[slot];
      if (!variable) throw new Error(`Не найдена переменная ${slot} в «${data.name}».`);
      return host.variables.setBoundVariableForPaint(paint, 'color', variable);
    });
  }
  if (!combined) {
    for (const child of data.children ?? []) {
      await restoreArtwork(host, attempt, node, child, tokens, keyFor);
    }
  }
  attempt.checkOpen();
  node.visible = data.visible;
  node.locked = data.locked;
  return node;
}
