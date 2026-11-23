import { catalog, type Item } from '../catalog';
import { isSize, type Size } from '../layout';
import { isScheme, isSlot, paletteColor, readPaletteSnapshot, record, rgb, schemes,
  type AppliedPalette, type PaletteChoice, type Scheme, type Slot } from '../palette';
import type { Component, Host, Instance, Node, Paint, Section, Variable } from './host';

const libraryPageName = 'Библиотека компонентов';
const librarySectionName = 'Библиотека · Компоненты';
const demoSectionName = 'Демо · Плагин';
const collectionPrefix = 'Illustration / Palette / ';
const detailsName = 'Illustration / Details';
const objectIds = new Set(catalog.map(item => item.id));
const channels = ['background', 'object'] as const;
const fields = ['fills', 'strokes'] as const;

function unique<T>(entries: T[], name: string): T {
  if (entries.length !== 1) {
    throw new Error(entries.length ? `Найдены дубликаты «${name}».` :
      `Не найдено «${name}». Запустите плагин подготовки библиотеки в этом файле.`);
  }
  return entries[0]!;
}

export async function openLibrary(host: Host) {
  const page = unique(host.root.children.filter(node => node.name === libraryPageName), libraryPageName);
  await page.loadAsync();
  const section = (name: string) => unique(page.children
    .filter((node): node is Section => node.type === 'SECTION' && node.name === name), name);
  const masters = section(librarySectionName);
  const demo = section(demoSectionName);

  const index = new Map<string, Component>();
  const families = new Set<string>();
  for (const set of masters.children) {
    if (set.type !== 'COMPONENT_SET' || (!objectIds.has(set.name) && set.name !== 'background')) continue;
    if (families.has(set.name)) throw new Error(`Дубликат набора «${set.name}».`);
    families.add(set.name);
    for (const node of set.children ?? []) {
      if (node.type !== 'COMPONENT') continue;
      const component = node as Component;
      const properties = component.variantProperties ?? Object.fromEntries(component.name.split(',')
        .map(pair => pair.split('=').map(part => part.trim())).filter(pair => pair.length === 2));
      if (!properties || !isSize(properties.Size)) continue;
      const variant = set.name === 'background' ? properties.Scheme : properties.Role;
      const valid = set.name === 'background' ? isScheme(variant) : variant === 'main' || variant === 'background';
      if (!valid) continue;
      const key = `${set.name}/${properties.Size}/${variant}`;
      if (index.has(key)) throw new Error(`Дубликат варианта «${key}».`);
      index.set(key, component);
    }
  }
  const component = (key: string) => unique(index.has(key) ? [index.get(key)!] : [], key);
  return {
    page, demo,
    object: (size: Size, item: Item) => component(`${item.id}/${size}/${item.role}`),
    background: (size: Size, scheme: Scheme) => component(`background/${size}/${scheme}`)
  };
}

export async function loadColors(host: Host) {
  const [collections, variables] = await Promise.all([
    host.variables.getLocalVariableCollectionsAsync(),
    host.variables.getLocalVariablesAsync('COLOR')
  ]);
  const byId = new Map(variables.map(variable => [variable.id, variable]));
  const modes = new Map(collections.map(collection => [collection.id, collection.defaultModeId]));
  const roles = new Map<string, Slot | 'fixed'>();
  const byScheme = new Map<Scheme, Map<Slot, Variable>>();
  const details = collections.filter(collection => collection.name === detailsName);
  if (details.length > 1) throw new Error(`Дубликат коллекции «${detailsName}».`);
  for (const variable of variables) {
    if (variable.variableCollectionId === details[0]?.id && variable.name.startsWith('detail/')) {
      roles.set(variable.id, 'fixed');
    }
  }
  for (const scheme of Object.keys(schemes).filter(isScheme)) {
    const collectionName = collectionPrefix + scheme;
    const collection = unique(collections.filter(entry => entry.name === collectionName), collectionName);
    const tokens = new Map<Slot, Variable>();
    for (const variable of variables) {
      if (variable.variableCollectionId !== collection.id || !isSlot(variable.name)) continue;
      if (tokens.has(variable.name)) throw new Error(`Дубликат переменной «${scheme}/${variable.name}».`);
      tokens.set(variable.name, variable);
      roles.set(variable.id, variable.name);
    }
    byScheme.set(scheme, tokens);
  }
  const token = (scheme: Scheme, slot: Slot) => {
    const variable = byScheme.get(scheme)?.get(slot);
    if (!variable) throw new Error(`Нет переменной «${scheme}/${slot}».`);
    return variable;
  };
  const tokenColor = (variable: Variable, seen = new Set<string>()): ReturnType<typeof rgb> => {
    if (seen.has(variable.id)) throw new Error(`Циклическая ссылка в «${variable.name}».`);
    seen.add(variable.id);
    const mode = modes.get(variable.variableCollectionId);
    const value = record(mode ? variable.valuesByMode[mode] : undefined);
    if (value.type !== 'VARIABLE_ALIAS') return rgb(value);
    const next = typeof value.id === 'string' ? byId.get(value.id) : undefined;
    if (!next) throw new Error(`Нет источника цвета для «${variable.name}».`);
    return tokenColor(next, seen);
  };
  function applyChoice(choice: PaletteChoice): AppliedPalette {
    if (choice.kind === 'custom') return { palette: choice.palette };
    const { scheme } = choice;
    const values = (channel: 'background' | 'object') =>
      ([0, 1, 2, 3] as const).map(index => tokenColor(token(scheme, `${channel}/${index}`)));
    return { scheme, palette: readPaletteSnapshot({
      version: 1, name: schemes[scheme], background: values(channels[0]), object: values(channels[1])
    }) };
  }
  return { roles, applyChoice, token };
}

export type ColorLibrary = Awaited<ReturnType<typeof loadColors>>;
export type PaintPatch = { node: Node; field: 'fills' | 'strokes'; before: readonly Paint[]; after: readonly Paint[] };

export function planPaints(
  host: Host, master: Component, instance: Instance, colors: ColorLibrary, applied: AppliedPalette,
  backgroundOnly: boolean
): PaintPatch[] {
  const patches: PaintPatch[] = [];
  const stack: [Node, Node][] = [[master, instance]];
  while (stack.length) {
    const [source, target] = stack.pop()!;
    if ((source !== master && (source.type !== target.type || source.name !== target.name)) ||
        (source.children?.length ?? 0) !== (target.children?.length ?? 0)) {
      throw new Error(`Структура «${instance.name}» отличается от мастера у слоя «${source.name}».`);
    }
    for (const field of fields) {
      const input = source[field];
      if (input === undefined) continue;
      if (typeof input === 'symbol') throw new Error(`Смешанная краска мастера в «${source.name}».`);
      if (!input.length) continue;
      const current = target[field];
      if (!current || typeof current === 'symbol' || input.length !== current.length) {
        throw new Error(`Число красок у слоя «${source.name}» изменилось.`);
      }
      let changed = false;
      const after = input.map((paint, index) => {
        const old = current[index]!;
        const binding = paint.type === 'SOLID' && paint.boundVariables?.color;
        const slot = binding ? colors.roles.get(binding.id) : undefined;
        if (!slot || old.type !== 'SOLID') throw new Error(`Нет привязки ${field}[${index + 1}] у слоя «${source.name}».`);
        if (slot === 'fixed') return old;
        if (backgroundOnly && !slot.startsWith('background/')) {
          throw new Error(`Фоновый слой «${source.name}» использует слот ${slot}.`);
        }
        changed = true;
        const solid = { ...old, color: paletteColor(applied.palette, slot) };
        return host.variables.setBoundVariableForPaint(solid, 'color', applied.scheme ? colors.token(applied.scheme, slot) : null);
      });
      if (changed) patches.push({ node: target, field, before: current, after });
    }
    source.children?.forEach((child, i) => stack.push([child, target.children![i]!]));
  }
  return patches;
}

export function commitPaints(patches: PaintPatch[], finish: () => void = () => {}) {
  let written = 0;
  try {
    for (const patch of patches) {
      patch.node[patch.field] = patch.after;
      written++;
    }
    finish();
  } catch (error) {
    const rollbackFailures = [];
    for (let i = written - 1; i >= 0; i--) {
      const patch = patches[i]!;
      try { patch.node[patch.field] = patch.before; }
      catch { rollbackFailures.push(patch.node.name); }
    }
    if (rollbackFailures.length) {
      throw new Error(`Figma не смогла восстановить краски в слоях «${rollbackFailures.join(', ')}». Отмените последнюю операцию в Figma.`, {cause: error});
    }
    throw error;
  }
}
