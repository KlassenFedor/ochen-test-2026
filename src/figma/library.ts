import { catalog, type Item } from '../catalog';
import { isSize, type Size } from '../layout';
import { isScheme, isSlot, paletteColor, readPaletteSnapshot, record, rgb, schemes,
  type AppliedPalette, type PaletteChoice, type Scheme, type Slot } from '../palette';
import type { Component, Host, Instance, Node, Paint, Section, Variable } from './host';

const libraryPageName = 'Библиотека компонентов';
export const librarySectionName = 'Библиотека · Компоненты';
export const demoSectionName = 'Демо · Плагин';
export const libraryMetadata = { namespace: 'ochenIllustrationComposer', pageKey: 'library-page' } as const;
const collectionPrefix = 'Illustration / Palette / ';
const detailsName = 'Illustration / Details';
const objectIds = new Set(catalog.map(item => item.id));
const channels = ['background', 'object'] as const;
const fields = ['fills', 'strokes'] as const;

function unique<T>(entries: T[], name: string): T {
  if (entries.length !== 1) {
    throw new Error(entries.length ? `Найдены дубликаты «${name}».` :
      `Не найдено «${name}». Проверьте библиотеку через «Помощь и инструкции» или откройте демофайл задания.`);
  }
  return entries[0]!;
}

export async function findLibrarySections(host: Host) {
  const saved = host.root.getSharedPluginData?.(libraryMetadata.namespace, libraryMetadata.pageKey);
  const page = saved ? host.root.children.find(node => node.id === saved) : undefined;
  const candidates = page ? [page] : host.root.children.filter(node => node.name === libraryPageName);
  if (!candidates.length) return;
  const libraryPage = unique(candidates, libraryPageName);
  await libraryPage.loadAsync();
  const sections = (name: string) => libraryPage.children
    .filter((node): node is Section => node.type === 'SECTION' && node.name === name);
  return { page: libraryPage, masters: sections(librarySectionName), demos: sections(demoSectionName) };
}

export async function librarySections(host: Host) {
  const found = await findLibrarySections(host);
  if (!found) throw new Error(`Не найдена библиотека в этом файле. Откройте файл задания с мастерами.`);
  return found;
}

export type LibraryState = 'ready' | 'needs-setup' | 'unavailable' | 'bundled';

export async function libraryState(host: Host): Promise<Exclude<LibraryState, 'bundled'>> {
  const found = await findLibrarySections(host);
  if (!found) return 'unavailable';
  const { masters, demos } = found;
  if (masters.length > 1) unique(masters, librarySectionName);
  if (demos.length > 1) unique(demos, demoSectionName);
  return masters.length && demos.length ? 'ready' : 'needs-setup';
}

export async function openLibrary(host: Host) {
  const { page, masters: sections } = await librarySections(host);
  const masters = unique(sections, librarySectionName);

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
    page, demo: () => unique(page.children
      .filter((node): node is Section => node.type === 'SECTION' && node.name === demoSectionName), demoSectionName),
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
  const names = new Map(collections.map(collection => [collection.id, collection.name]));
  const byCollection = new Map<string, Variable[]>();
  for (const variable of variables) {
    const name = names.get(variable.variableCollectionId);
    if (name === detailsName && variable.name.startsWith('detail/')) {
      roles.set(variable.id, 'fixed');
    }
    if (name?.startsWith(collectionPrefix) && isScheme(name.slice(collectionPrefix.length)) && isSlot(variable.name)) {
      roles.set(variable.id, variable.name);
      const list = byCollection.get(variable.variableCollectionId) ?? [];
      list.push(variable);
      byCollection.set(variable.variableCollectionId, list);
    }
  }
  const token = (scheme: Scheme, slot: Slot) => {
    const name = collectionPrefix + scheme;
    const collection = unique(collections.filter(entry => entry.name === name), name);
    return unique(byCollection.get(collection.id)?.filter(variable => variable.name === slot) ?? [], `${scheme}/${slot}`);
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
  function matchesToken(id: string, scheme: Scheme, slot: Slot): boolean {
    const variable = byId.get(id);
    return Boolean(variable && roles.get(id) === slot &&
      names.get(variable.variableCollectionId) === collectionPrefix + scheme);
  }
  return { roles, applyChoice, token, matchesToken };
}

export type ColorLibrary = Awaited<ReturnType<typeof loadColors>>;
export type PaintPatch = { node: Node; field: 'fills' | 'strokes'; before: readonly Paint[]; after: readonly Paint[] };

export function planPaints(
  host: Host, master: Component, instance: Instance, colors: ColorLibrary, applied: AppliedPalette,
  backgroundOnly: boolean, swapped = false
): PaintPatch[] {
  const patches: PaintPatch[] = [];
  const stack: [Node, Node][] = [[master, instance]];
  while (stack.length) {
    const [source, target] = stack.pop()!;
    if ((source !== master && source.type !== target.type) ||
        (source.children?.length ?? 0) !== (target.children?.length ?? 0)) {
      throw new Error(`Структура «${instance.name}» отличается от мастера у слоя «${source.name}».`);
    }
    for (const field of fields) {
      const input = source[field];
      if (input === undefined) continue;
      if (typeof input === 'symbol') throw new Error(`Смешанная краска мастера в «${source.name}».`);
      const current = target[field];
      if (!current || typeof current === 'symbol') {
        if (!input.length) continue;
        throw new Error(`Число красок у слоя «${source.name}» изменилось.`);
      }
      if (!input.length && !swapped) continue;
      if (!swapped && input.length !== current.length) {
        throw new Error(`Число красок у слоя «${source.name}» изменилось.`);
      }
      let changed = swapped && input.length !== current.length;
      const after = input.map((paint, index) => {
        const old = swapped && (input.length !== current.length || current[index]?.type !== 'SOLID')
          ? paint : current[index]!;
        const binding = paint.type === 'SOLID' && paint.boundVariables?.color;
        const slot = binding ? colors.roles.get(binding.id) : undefined;
        if (!slot || old.type !== 'SOLID') throw new Error(`Нет привязки ${field}[${index + 1}] у слоя «${source.name}».`);
        if (slot === 'fixed') {
          if (!swapped || paint.type !== 'SOLID') return old;
          changed = true;
          return { ...old, color: paint.color, boundVariables: paint.boundVariables };
        }
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
