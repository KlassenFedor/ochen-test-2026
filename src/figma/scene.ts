import { itemName, type Item } from '../catalog';
import {
  isFormat, isSize, keepCenter, planAddition, planLayout, transformedBounds,
  type Format, type Size
} from '../layout';
import { isScheme, readPaletteSnapshot, record, type AppliedPalette, type PaletteChoice } from '../palette';
import { prepareSvgExport, svgFilename } from '../svg';
import type { Component, Drawable, Frame, Host, Instance, Node, Section, SolidPaint } from './host';
import { commitPaints, loadColors, openLibrary, planPaints, type ColorLibrary } from './library';

const sceneKey = 'illustration-scene';
const itemKey = 'illustration-item';
const backgroundKey = 'illustration-background';
type Scene = {
  version: 1; format: Format; size: Size; color: AppliedPalette;
  layout: string; scale: number; title: string;
};
export type BuildOptions = { format: Format; size: Size; palette: PaletteChoice; title: string };
export type SelectionState = { scene?: string; item?: { name: string; role: Item['role'] } };

function sceneData(frame: Frame): Scene {
  const data = record(JSON.parse(frame.getPluginData(sceneKey)));
  const color = record(data.color);
  if (data.version !== 1 || !isFormat(data.format) || !isSize(data.size) ||
    typeof data.title !== 'string' || typeof data.layout !== 'string' ||
    typeof data.scale !== 'number' || !Number.isFinite(data.scale) || data.scale <= 0 ||
    (color.scheme !== undefined && !isScheme(color.scheme))) {
    throw new Error('Метаданные сцены не поддерживаются этой версией плагина.');
  }
  return {
    version: 1, format: data.format, size: data.size, layout: data.layout,
    scale: data.scale, title: data.title,
    color: { scheme: color.scheme, palette: readPaletteSnapshot(color.palette) }
  };
}

function readItem(node: Node): Item | undefined {
  const raw = node.getPluginData(itemKey);
  if (!raw) return undefined;
  const { id, role } = record(JSON.parse(raw));
  if (typeof id !== 'string' || (role !== 'main' && role !== 'background')) throw new Error('Повреждены данные предмета.');
  itemName(id);
  return { id, role };
}

function sceneAncestor(node: Node): Frame | undefined {
  for (let n: Node | null = node; n && n.type !== 'PAGE'; n = n.parent) {
    if (n.type === 'FRAME' && n.getPluginData(sceneKey)) return n as Frame;
  }
}

function selectedFrame(host: Host): Frame | undefined {
  const nodes = host.currentPage.selection;
  if (!nodes.length) return undefined;
  const first = sceneAncestor(nodes[0]!);
  return first && nodes.every(node => sceneAncestor(node) === first) ? first : undefined;
}

function selectedItem(host: Host, frame: Frame): { node: Instance; item: Item } | undefined {
  if (host.currentPage.selection.length !== 1) return undefined;
  let node: Node | null = host.currentPage.selection[0]!;
  while (node && node !== frame && node.parent !== frame) node = node.parent;
  if (!node || node === frame || node.type !== 'INSTANCE') return undefined;
  const item = readItem(node);
  if (item) return { node: node as Instance, item };
}

function requireFrame(host: Host): Frame {
  const frame = selectedFrame(host);
  if (!frame) throw new Error('Выделите один кадр композиции или слой внутри него.');
  return frame;
}

function managedChildren(frame: Frame) {
  return frame.children.flatMap(node => {
    const item = readItem(node);
    const backdrop = node.getPluginData(backgroundKey) === '1';
    if (!item && !backdrop) return [];
    if (node.type !== 'INSTANCE') throw new Error(`Верните слой «${node.name}» к экземпляру компонента.`);
    return [{ node: node as Instance, item }];
  });
}

function addInstance(frame: Frame, component: Component, scale: number, label: string, item?: Item) {
  const node = component.createInstance();
  try {
    frame.appendChild(node);
    node.name = label;
    if (!Number.isFinite(scale) || scale <= 0) throw new Error(`Неверный масштаб «${label}».`);
    node.rescale(scale);
    if (item) node.setPluginData(itemKey, JSON.stringify(item));
    else node.setPluginData(backgroundKey, '1');
    return node;
  } catch (error) {
    node.remove();
    throw error;
  }
}

function solid(color: SolidPaint['color']): SolidPaint {
  return { type: 'SOLID', color };
}

function framePaint(host: Host, colors: ColorLibrary, applied: AppliedPalette, previous?: SolidPaint) {
  return host.variables.setBoundVariableForPaint({
    ...(previous ?? solid(applied.palette.background[0])), color: applied.palette.background[0]
  }, 'color', applied.scheme ? colors.token(applied.scheme, 'background/0') : null);
}

function placeFrame(demo: Section, frame: Frame) {
  const padding = 80;
  const existing = demo.children.filter(node => node !== frame);
  const right = existing.reduce((x, node) => Math.max(x, node.x + node.width + padding), padding);
  frame.x = right;
  frame.y = padding;
  if (right + frame.width + padding > demo.width || frame.height + 2 * padding > demo.height) {
    demo.resizeWithoutConstraints(Math.max(demo.width, right + frame.width + padding),
      Math.max(demo.height, frame.height + 2 * padding));
  }
}

export function createComposer(host: Host) {
  host.skipInvisibleInstanceChildren = false;

  function selection(): SelectionState {
    const frame = selectedFrame(host);
    const item = frame ? selectedItem(host, frame)?.item : undefined;
    return { scene: frame?.name, item: item ? { name: itemName(item.id), role: item.role } : undefined };
  }

  async function makeScene(
    items: Item[], options: Omit<BuildOptions, 'palette'>,
    palette: PaletteChoice, previous?: string
  ) {
    if (!items.length) throw new Error('Добавьте в композицию хотя бы один предмет.');
    const [library, colors] = await Promise.all([openLibrary(host), loadColors(host)]);
    const color = colors.applyChoice(palette);
    const components = items.map(item => library.object(options.size, item));
    const backdrop = library.background(options.size, color.scheme ?? 'violet');
    if (backdrop.width <= 0 || backdrop.height <= 0) throw new Error('Фон имеет нулевой размер.');
    const layout = planLayout(components.map((component, i) => ({
      width: component.width, height: component.height, role: items[i]!.role
    })), options.format, previous);
    const data: Scene = {
      version: 1, format: options.format, size: options.size,
      color, layout: layout.id, scale: layout.scale, title: options.title
    };
    if (host.currentPage !== library.page) await host.setCurrentPageAsync(library.page);
    const frame = host.createFrame();
    try {
      frame.name = `${options.title} · ${options.size === 'large' ? 'L' : 'S'}`;
      frame.resizeWithoutConstraints(layout.frame.width, layout.frame.height);
      frame.clipsContent = true;
      frame.fills = [framePaint(host, colors, color)];

      const coverScale = Math.max(frame.width / backdrop.width, frame.height / backdrop.height);
      const background = addInstance(frame, backdrop, coverScale, 'Фон');
      background.x = (frame.width - background.width) / 2;
      background.y = (frame.height - background.height) / 2;
      background.locked = true;
      const patches = planPaints(host, backdrop, background, colors, color, true);
      for (const place of layout.places) {
        const item = items[place.index]!;
        const master = components[place.index]!;
        const instance = addInstance(frame, master, layout.scale, itemName(item.id), item);
        instance.x = place.x;
        instance.y = place.y;
        patches.push(...planPaints(host, master, instance, colors, color, item.role === 'background'));
      }
      commitPaints(patches, () => frame.setPluginData(sceneKey, JSON.stringify(data)));
      library.demo.appendChild(frame);
      placeFrame(library.demo, frame);
    } catch (error) {
      frame.remove();
      throw error;
    }
    host.currentPage.selection = [frame];
    host.viewport.scrollAndZoomIntoView([frame]);
    return frame;
  }

  async function recolor(choice: PaletteChoice) {
    const frame = requireFrame(host);
    const colors = await loadColors(host);
    const data = sceneData(frame);
    const color = colors.applyChoice(choice);
    const entries = managedChildren(frame);
    const masters = await Promise.all(entries.map(entry => entry.node.getMainComponentAsync()));
    const currentEntries = managedChildren(frame);
    if (entries.length !== currentEntries.length || entries.some((entry, i) => entry.node !== currentEntries[i]?.node)) {
      throw new Error('Состав сцены изменился. Повторите применение палитры.');
    }
    const fills = frame.fills;
    if (typeof fills === 'symbol' || fills.length !== 1 || fills[0]?.type !== 'SOLID') {
      throw new Error('Для перекраски кадру нужна одна сплошная заливка.');
    }
    const patches = entries.flatMap(({ node, item }, index) => {
      const master = masters[index];
      if (!master) throw new Error(`Недоступен мастер слоя «${node.name}».`);
      return planPaints(host, master, node, colors, color, item?.role !== 'main');
    });
    patches.push({ node: frame, field: 'fills', before: fills, after: [framePaint(host, colors, color, fills[0])] });
    commitPaints(patches, () => frame.setPluginData(sceneKey, JSON.stringify({ ...data, color })));
  }

  async function add(item: Item) {
    const frame = requireFrame(host);
    const [library, colors] = await Promise.all([openLibrary(host), loadColors(host)]);
    if (frame.removed) throw new Error('Кадр композиции удалён.');
    const data = sceneData(frame);
    const master = library.object(data.size, item);
    const occupied = managedChildren(frame).filter(entry => entry.item && entry.node.visible)
      .map(({ node }) => transformedBounds(node.relativeTransform, node));
    const placement = planAddition(master, frame, data.scale, occupied);
    const node = addInstance(frame, master, placement.scale, itemName(item.id), item);
    try {
      node.x = placement.x;
      node.y = placement.y;
      commitPaints(planPaints(host, master, node, colors, data.color, item.role === 'background'));
    } catch (error) {
      node.remove();
      throw error;
    }
    if (selectedFrame(host) === frame) host.currentPage.selection = [node];
  }

  async function changeRole() {
    const frame = requireFrame(host);
    const selected = selectedItem(host, frame);
    if (!selected) throw new Error('Выделите один предмет внутри композиции.');
    const { node: original, item } = selected;
    const [library, colors, currentMaster] = await Promise.all([
      openLibrary(host), loadColors(host), original.getMainComponentAsync()
    ]);
    const data = sceneData(frame);
    const index = frame.children.indexOf(original);
    if (!currentMaster || index < 0 || original.removed) throw new Error('Выбранный предмет недоступен.');
    const changed: Item = { id: item.id, role: item.role === 'main' ? 'background' : 'main' };
    const master = library.object(data.size, changed);
    const scaleW = original.width / currentMaster.width, scaleH = original.height / currentMaster.height;
    if (Math.abs(scaleW - scaleH) > Math.max(scaleW, scaleH) * 0.001) {
      throw new Error('Для смены роли восстановите пропорции предмета. Для масштабирования используйте инструмент K.');
    }
    const node = addInstance(frame, master, scaleW, original.name, changed);
    const shouldSelect = selectedItem(host, frame)?.node === original;
    try {
      node.relativeTransform = keepCenter(original.relativeTransform, original, node);
      node.visible = original.visible;
      frame.insertChild(index, node);
      commitPaints(planPaints(host, master, node, colors, data.color, changed.role === 'background'));
      node.locked = original.locked;
      original.remove();
    } catch (error) {
      node.remove();
      throw error;
    }
    if (shouldSelect) host.currentPage.selection = [node];
  }

  return {
    selection,
    build: (items: Item[], options: BuildOptions) => makeScene(items, options, options.palette),
    alternative() {
      const frame = requireFrame(host);
      const data = sceneData(frame);
      const items = managedChildren(frame).flatMap(entry => entry.item ? [entry.item] : []);
      const choice: PaletteChoice = data.color.scheme ? {kind: 'preset', scheme: data.color.scheme} :
        {kind: 'custom', palette: data.color.palette};
      return makeScene(items, data, choice, data.layout);
    },
    recolor, add, changeRole,
    async exportSvg() {
      const frame = requireFrame(host);
      const bytes = await frame.exportAsync({ format: 'SVG', svgIdAttribute: true, svgSimplifyStroke: false });
      return { filename: svgFilename(frame.name), svg: prepareSvgExport(bytes) };
    }
  };
}

