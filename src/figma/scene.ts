import { checkItemCount, itemName, type Item } from '../catalog';
import {
  isFormat, isSize, keepCenter, planAddition, planLayout, transformedBounds,
  type Format, type Size
} from '../layout';
import { isScheme, readPaletteSnapshot, record, type AppliedPalette, type PaletteChoice } from '../palette';
import { prepareSvgExport, svgFilename } from '../svg';
import type { Component, Container, Drawable, Frame, Host, Instance, Node, Page, Section, SolidPaint } from './host';
import { commitPaints, loadColors, openLibrary, planPaints, type ColorLibrary } from './library';
import { preserveOverrides } from './overrides';

const sceneKey = 'illustration-scene';
const itemKey = 'illustration-item';
const backgroundKey = 'illustration-background';
const namespace = 'ochenIllustrationComposer';
type Scene = {
  version: 1; format: Format; size: Size; color: AppliedPalette;
  layout: string; scale: number; title: string;
};
export type BuildOptions = { format: Format; size: Size; palette: PaletteChoice; title: string };
export type SelectionState = {
  scene?: { id: string; name: string; palette: PaletteChoice; legacy?: boolean };
  item?: { id: string; name: string; role: Item['role'] };
};

function addInstance(frame: Frame, component: Component, scale: number, label: string, item?: Item) {
  const node = component.createInstance();
  try {
    frame.appendChild(node);
    node.name = label;
    if (!Number.isFinite(scale) || scale <= 0) throw new Error(`Неверный масштаб «${label}».`);
    node.rescale(scale);
    if (item) node.setSharedPluginData(namespace, itemKey, JSON.stringify(item));
    else node.setSharedPluginData(namespace, backgroundKey, '1');
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

function placeBeside(page: Page, source: Frame, frame: Frame) {
  let anchor: Drawable = source;
  let parent = anchor.parent;
  while (parent && parent.type !== 'PAGE' && parent.type !== 'SECTION' &&
         (parent.type !== 'FRAME' || (parent as Frame).layoutMode !== 'NONE')) {
    anchor = parent as Drawable;
    parent = anchor.parent;
  }
  const container = (parent ?? page) as Page | Container;
  container.appendChild(frame);
  const bounds = transformedBounds(anchor.relativeTransform, anchor);
  let x = bounds.x + bounds.width + 80;
  const y = bounds.y;
  const neighbors = container.children.filter(node => node !== frame && node !== anchor)
    .map(node => transformedBounds(node.relativeTransform, node)).sort((a, b) => a.x - b.x);
  for (const other of neighbors) {
    if (other.y < y + frame.height && other.y + other.height > y &&
        other.x < x + frame.width + 80 && other.x + other.width + 80 > x) {
      x = other.x + other.width + 80;
    }
  }
  frame.x = x;
  frame.y = y;
  if (container.type === 'SECTION') {
    const section = container as Section;
    const width = Math.max(section.width, x + frame.width + 80);
    const height = Math.max(section.height, y + frame.height + 80);
    if (width !== section.width || height !== section.height) section.resizeWithoutConstraints(width, height);
  }
}

function proportionalScale(node: Instance, master: Component): number {
  const scale = node.width / master.width;
  const heightScale = node.height / master.height;
  if (!Number.isFinite(scale) || scale <= 0 ||
      Math.abs(scale - heightScale) > Math.max(scale, heightScale) * 0.001) {
    throw new Error('Восстановите пропорции экземпляра. Для масштабирования используйте инструмент K.');
  }
  return scale;
}

function useSwap(original: Instance, after: Component, scale: number) {
  const node = original.clone();
  try {
    node.swapComponent(after);
    const correction = scale / (node.scaleFactor ?? node.width / after.width);
    if (Math.abs(correction - 1) > 0.001) node.rescale(correction);
    const width = after.width * scale, height = after.height * scale;
    if (Math.abs(node.width - width) > 0.002 || Math.abs(node.height - height) > 0.002) {
      node.resizeWithoutConstraints(width, height);
    }
    node.name = original.name;
    node.visible = original.visible;
    return node;
  } catch (error) {
    node.remove();
    throw error;
  }
}

export function createComposer(host: Host) {
  host.skipInvisibleInstanceChildren = false;

  function metadata(node: Node, key: string): string {
    return node.getSharedPluginData(namespace, key) || (host.pluginId ? node.getPluginData(key) : '');
  }

  function writeScene(frame: Frame, data: Scene) {
    const value = JSON.stringify(data);
    if (!host.pluginId || frame.getSharedPluginData(namespace, sceneKey) || !frame.getPluginData(sceneKey)) {
      frame.setSharedPluginData(namespace, sceneKey, value);
    } else {
      frame.setPluginData(sceneKey, value);
    }
  }

  function paletteChoice(color: AppliedPalette): PaletteChoice {
    return color.scheme ? { kind: 'preset', scheme: color.scheme } : { kind: 'custom', palette: color.palette };
  }

  function sceneData(frame: Frame): Scene {
    const data = record(JSON.parse(metadata(frame, sceneKey)));
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
    const raw = metadata(node, itemKey);
    if (!raw) return undefined;
    const { id, role } = record(JSON.parse(raw));
    if (typeof id !== 'string' || (role !== 'main' && role !== 'background')) throw new Error('Повреждены данные предмета.');
    itemName(id);
    return { id, role };
  }

  function sceneAncestor(node: Node): Frame | undefined {
    for (let n: Node | null = node; n && n.type !== 'PAGE'; n = n.parent) {
      if (n.type === 'FRAME' && metadata(n, sceneKey)) return n as Frame;
    }
  }

  function selectedFrame(): Frame | undefined {
    const nodes = host.currentPage.selection;
    if (!nodes.length) return undefined;
    const first = sceneAncestor(nodes[0]!);
    return first && nodes.every(node => sceneAncestor(node) === first) ? first : undefined;
  }

  function selectedItem(frame: Frame): { node: Instance; item: Item } | undefined {
    if (host.currentPage.selection.length !== 1) return undefined;
    for (let node: Node | null = host.currentPage.selection[0]!; node && node !== frame; node = node.parent) {
      if (node.type !== 'INSTANCE') continue;
      let parent = node.parent;
      while (parent?.type === 'GROUP') parent = parent.parent;
      if (parent !== frame) continue;
      const item = readItem(node);
      if (item) return { node: node as Instance, item };
    }
  }

  function requireFrame(expectedId: string): Frame {
    const frame = selectedFrame();
    if (!frame || frame.id !== expectedId) throw new Error('Выделение изменилось. Выберите нужную композицию и повторите действие.');
    return frame;
  }

  function managedChildren(frame: Frame) {
    function visit(node: Drawable, parentsVisible: boolean): { node: Instance; item?: Item; visible: boolean }[] {
      const item = readItem(node);
      const backdrop = metadata(node, backgroundKey) === '1';
      const visible = parentsVisible && node.visible;
      if (!item && !backdrop) {
        return node.type === 'GROUP' ? (node as Container).children.flatMap(child => visit(child, visible)) : [];
      }
      if (node.type !== 'INSTANCE') throw new Error(`Верните слой «${node.name}» к экземпляру компонента.`);
      return [{ node: node as Instance, item, visible }];
    }
    return frame.children.flatMap(node => visit(node, true));
  }

  function selection(): SelectionState {
    const frame = selectedFrame();
    if (!frame) return {};
    const selected = selectedItem(frame);
    return {
      scene: { id: frame.id, name: frame.name, palette: paletteChoice(sceneData(frame).color),
        legacy: !frame.getSharedPluginData(namespace, sceneKey) },
      item: selected ? { id: selected.node.id, name: selected.node.name, role: selected.item.role } : undefined
    };
  }

  async function makeScene(
    items: Item[], options: Omit<BuildOptions, 'palette'>,
    palette: PaletteChoice, variant?: {
      source: Frame; previous: Scene; visibility: boolean[]; backdrop: Component | null; backdropVisible?: boolean
    }
  ) {
    if (!items.length) throw new Error('Добавьте в композицию хотя бы один предмет.');
    checkItemCount(items.length);
    const [library, colors] = await Promise.all([openLibrary(host), loadColors(host)]);
    const color = colors.applyChoice(palette);
    const components = items.map(item => library.object(options.size, item));
    const backdrop = color.scheme ? library.background(options.size, color.scheme) :
      variant?.backdrop ?? library.background(options.size, 'violet');
    const demo = variant ? undefined : library.demo();
    if (backdrop.width <= 0 || backdrop.height <= 0) throw new Error('Фон имеет нулевой размер.');
    const layout = planLayout(components.map((component, i) => ({
      width: component.width, height: component.height, role: items[i]!.role
    })), options.format, variant?.previous.layout);
    const data: Scene = {
      version: 1, format: options.format, size: options.size,
      color, layout: layout.id, scale: layout.scale, title: options.title
    };
    if (variant) requireFrame(variant.source.id);
    else if (host.currentPage !== library.page) await host.setCurrentPageAsync(library.page);
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
      background.visible = variant?.backdropVisible ?? true;
      const patches = planPaints(host, backdrop, background, colors, color, true);
      for (const place of layout.places) {
        const item = items[place.index]!;
        const master = components[place.index]!;
        const instance = addInstance(frame, master, layout.scale, itemName(item.id), item);
        instance.x = place.x;
        instance.y = place.y;
        instance.visible = variant?.visibility[place.index] ?? true;
        patches.push(...planPaints(host, master, instance, colors, color, item.role === 'background'));
      }
      commitPaints(patches, () => writeScene(frame, data));
      if (demo) {
        demo.appendChild(frame);
        placeFrame(demo, frame);
      } else if (variant) {
        placeBeside(host.currentPage, variant.source, frame);
      }
    } catch (error) {
      frame.remove();
      throw error;
    }
    host.currentPage.selection = [frame];
    host.viewport.scrollAndZoomIntoView([frame]);
    return frame;
  }

  async function recolor(choice: PaletteChoice, expectedSceneId: string) {
    const frame = requireFrame(expectedSceneId);
    const [colors, library] = await Promise.all([
      loadColors(host), choice.kind === 'preset' ? openLibrary(host) : undefined
    ]);
    const data = sceneData(frame);
    const color = colors.applyChoice(choice);
    const entries = managedChildren(frame);
    const masters = await Promise.all(entries.map(entry => entry.node.getMainComponentAsync()));
    requireFrame(expectedSceneId);
    const currentEntries = managedChildren(frame);
    if (entries.length !== currentEntries.length || entries.some((entry, i) => entry.node !== currentEntries[i]?.node)) {
      throw new Error('Состав сцены изменился. Повторите применение палитры.');
    }
    const fills = frame.fills;
    if (typeof fills === 'symbol' || fills.length !== 1 || fills[0]?.type !== 'SOLID') {
      throw new Error('Для перекраски кадру нужна одна сплошная заливка.');
    }
    const replacementMaster = color.scheme && library ? library.background(data.size, color.scheme) : undefined;
    const replacements: { original: Instance; node: Instance; checkOverrides: () => string[] }[] = [];
    try {
      const patches = entries.flatMap(({ node, item }, index) => {
        const master = masters[index];
        if (!master) throw new Error(`Недоступен мастер слоя «${node.name}».`);
        if (item || !replacementMaster || replacementMaster.id === master.id) {
          return planPaints(host, master, node, colors, color, item?.role !== 'main');
        }
        const beforeCover = Math.max(frame.width / master.width, frame.height / master.height);
        const afterCover = Math.max(frame.width / replacementMaster.width, frame.height / replacementMaster.height);
        const parent = node.parent as Container;
        const draft = addInstance(frame, replacementMaster, proportionalScale(node, master) * afterCover / beforeCover, node.name);
        // Attach the new backdrop immediately before the old one, also inside groups.
        replacements.push({ original: node, node: draft, checkOverrides: () => [] });
        parent.insertChild(parent.children.indexOf(node), draft);
        draft.relativeTransform = keepCenter(node.relativeTransform, node, draft);
        draft.visible = node.visible;
        draft.locked = node.locked;
        replacements[replacements.length - 1]!.checkOverrides =
          preserveOverrides(node, master, draft, replacementMaster, colors, data.color);
        return planPaints(host, replacementMaster, draft, colors, color, true);
      });
      patches.push({ node: frame, field: 'fills', before: fills, after: [framePaint(host, colors, color, fills[0])] });
      const warnings: string[] = [];
      commitPaints(patches, () => {
        warnings.push(...replacements.flatMap(entry => entry.checkOverrides()));
        writeScene(frame, { ...data, color });
      });
      for (const entry of replacements) entry.original.remove();
      return warnings;
    } catch (error) {
      for (const entry of replacements) entry.node.remove();
      throw error;
    }
  }

  async function add(item: Item, expectedSceneId: string) {
    const frame = requireFrame(expectedSceneId);
    const [library, colors] = await Promise.all([openLibrary(host), loadColors(host)]);
    requireFrame(expectedSceneId);
    const data = sceneData(frame);
    const master = library.object(data.size, item);
    const entries = managedChildren(frame).filter(entry => entry.item);
    checkItemCount(entries.length + 1);
    const occupied = entries.filter(entry => entry.visible)
      .map(({ node, item }) => ({ ...transformedBounds(node.relativeTransform, node), role: item!.role }));
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
    if (selectedFrame() === frame) host.currentPage.selection = [node];
  }

  async function changeRole(expectedSceneId: string, expectedItemId: string) {
    const frame = requireFrame(expectedSceneId);
    const selected = selectedItem(frame);
    if (!selected || selected.node.id !== expectedItemId) throw new Error('Выделение изменилось. Выберите нужный предмет.');
    const { node: original, item } = selected;
    const [library, colors, currentMaster] = await Promise.all([
      openLibrary(host), loadColors(host), original.getMainComponentAsync()
    ]);
    requireFrame(expectedSceneId);
    if (selectedItem(frame)?.node.id !== expectedItemId || !currentMaster || !original.parent) {
      throw new Error('Выделение изменилось или выбранный предмет недоступен.');
    }
    const data = sceneData(frame);
    const parent = original.parent as Container;
    const changed: Item = { id: item.id, role: item.role === 'main' ? 'background' : 'main' };
    const master = library.object(data.size, changed);
    const node = useSwap(original, master, proportionalScale(original, currentMaster));
    let warnings: string[];
    try {
      parent.insertChild(parent.children.indexOf(original), node);
      node.relativeTransform = keepCenter(original.relativeTransform, original, node);
      node.setSharedPluginData(namespace, itemKey, JSON.stringify(changed));
      const checkOverrides = preserveOverrides(original, currentMaster, node, master, colors, data.color);
      commitPaints(planPaints(host, master, node, colors, data.color, changed.role === 'background', true));
      warnings = checkOverrides();
      node.locked = original.locked;
      original.remove();
    } catch (error) {
      node.remove();
      throw error;
    }
    host.currentPage.selection = [node];
    return warnings;
  }

  return {
    selection,
    build: (items: Item[], options: BuildOptions) => makeScene(items, options, options.palette),
    async alternative(expectedSceneId: string) {
      const frame = requireFrame(expectedSceneId);
      const data = sceneData(frame);
      const entries = managedChildren(frame);
      const items = entries.filter(entry => entry.item);
      const decorative = entries.find(entry => !entry.item);
      const backdrop = data.color.scheme ? null : await decorative?.node.getMainComponentAsync() ?? null;
      return makeScene(items.map(entry => entry.item!), data, paletteChoice(data.color), {
        source: frame, previous: data, visibility: items.map(entry => entry.visible), backdrop,
        backdropVisible: decorative?.visible
      });
    },
    migrate(expectedSceneId: string) {
      const frame = requireFrame(expectedSceneId);
      if (frame.getSharedPluginData(namespace, sceneKey)) throw new Error('Этот кадр уже доступен для передачи.');
      const data = sceneData(frame);
      const writes = managedChildren(frame).map(({ node, item }) => ({
        node: node as Node, key: item ? itemKey : backgroundKey, value: item ? JSON.stringify(item) : '1'
      }));
      writes.push({ node: frame, key: sceneKey, value: JSON.stringify(data) });
      const migrated: typeof writes = [];
      try {
        for (const entry of writes) {
          if (entry.node.getSharedPluginData(namespace, entry.key)) continue;
          entry.node.setSharedPluginData(namespace, entry.key, entry.value);
          migrated.push(entry);
        }
      } catch (error) {
        for (const entry of migrated.reverse()) entry.node.setSharedPluginData(namespace, entry.key, '');
        throw error;
      }
    },
    recolor, add, changeRole,
    async exportSvg(expectedSceneId: string) {
      const frame = requireFrame(expectedSceneId);
      const bytes = await frame.exportAsync({ format: 'SVG', svgIdAttribute: true, svgSimplifyStroke: false });
      requireFrame(expectedSceneId);
      return { sceneId: frame.id, filename: svgFilename(frame.name), svg: prepareSvgExport(bytes) };
    }
  };
}

