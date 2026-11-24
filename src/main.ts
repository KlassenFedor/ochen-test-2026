import { itemName, parseNames, suggestItems } from './catalog';
import { inflate } from 'pako/lib/inflate.js';
import type { Frame, Host, Node, NodeChangeEvent } from './figma/host';
import { libraryState } from './figma/library';
import { createPreparation } from './figma/prepare-library.js';
import { captureLibrary, type LibraryBundle } from './figma/library-bundle.js';
import { createComposer } from './figma/scene';
import { readCommand, type Message } from './protocol';

declare const __html__: string;
declare const __PORTABLE_LIBRARY__: string | null | undefined;
declare const figma: Host & {
  showUI(html: string, options: { width: number; height: number; themeColors: boolean }): void;
  on(event: 'selectionchange' | 'currentpagechange' | 'close', listener: () => void): void;
  commitUndo(): void;
  base64Decode(value: string): Uint8Array;
  ui: { onmessage: (data: unknown) => void; postMessage(message: Message): void };
};

const composer = createComposer(figma);
const portable = typeof __PORTABLE_LIBRARY__ === 'undefined' ? undefined : __PORTABLE_LIBRARY__;
figma.showUI(__html__, { width: 408, height: 680, themeColors: true });
let busy = false;
let closed = false;
let preparation: ReturnType<typeof createPreparation> | undefined;
let exported: { frame: Frame; ids: Set<string>; ancestors: Set<string> } | undefined;
let currentPage = figma.currentPage;
const send = (message: Message) => {
  if (!closed) figma.ui.postMessage(message);
};

function sendSelection() {
  if (closed) return;
  try {
    const selection = composer.selection();
    if (exported && selection.scene?.id !== exported.frame.id) invalidateExport();
    send({ type: 'selection', selection });
  }
  catch { send({ type: 'selection', selection: {} }); }
}
async function sendLibraryState() {
  if (closed) return;
  try {
    const state = await libraryState(figma);
    send(state === 'damaged'
      ? { type: 'library', state, autoRepair: Boolean(portable) }
      : { type: 'library', state: portable && state !== 'ready' ? 'bundled' : state });
  } catch (error) {
    send({ type: 'library', state: 'unavailable', error: error instanceof Error ? error.message : String(error) });
  }
}

function watchExport(frame: Frame) {
  const ids = new Set<string>();
  const pending: Node[] = [frame];
  while (pending.length) {
    const node = pending.pop()!;
    ids.add(node.id);
    for (const child of node.children ?? []) pending.push(child);
  }
  const ancestors = new Set<string>();
  for (let node = frame.parent; node && node.type !== 'PAGE'; node = node.parent) ancestors.add(node.id);
  return exported = { frame, ids, ancestors };
}

function invalidateExport() {
  if (!exported) return;
  const sceneId = exported.frame.id;
  exported = undefined;
  send({ type: 'invalidate-export', sceneId });
}

function onNodeChange({ nodeChanges }: NodeChangeEvent) {
  const snapshot = exported;
  if (!snapshot) return;
  for (const change of nodeChanges) {
    const node = change.node;
    if (snapshot.ids.has(node.id) || (change.type === 'DELETE' && snapshot.ancestors.has(node.id))) {
      invalidateExport();
      return;
    }
    if (node.removed) continue;
    for (let parent = node.parent; parent && parent.type !== 'PAGE'; parent = parent.parent) {
      if (parent.id === snapshot.frame.id) {
        invalidateExport();
        return;
      }
    }
  }
}

currentPage.on('nodechange', onNodeChange);
figma.on('selectionchange', sendSelection);
figma.on('currentpagechange', () => {
  if (currentPage.id !== figma.currentPage.id) {
    currentPage.off('nodechange', onNodeChange);
    currentPage = figma.currentPage;
    currentPage.on('nodechange', onNodeChange);
    invalidateExport();
  }
  sendSelection();
});
figma.on('close', () => {
  closed = true;
  preparation?.cancel();
});

figma.ui.onmessage = async (data: unknown) => {
  if (closed) return;
  if (busy) {
    if ((data as { type?: unknown } | null)?.type === 'cancel-library') preparation?.cancel();
    return;
  }
  busy = true;
  let refreshLibrary = false;
  let response: Extract<Message, { type: 'result' }> | undefined;
  try {
    const command = readCommand(data);
    let text: string;
    switch (command.type) {
      case 'ready':
        await sendLibraryState();
        return;
      case 'cancel-library':
        return;
      case 'export-library':
        response = { type: 'result', ok: true, text: 'Комплект библиотеки готов к скачиванию.', libraryBundle: await captureLibrary(figma) };
        return;
      case 'prepare-library':
      case 'verify-library': {
        refreshLibrary = true;
        preparation = createPreparation(figma, text => send({ type: 'progress', text }));
        const result = await preparation.run(command.type === 'prepare-library' ? 'setup' : 'verify');
        response = { type: 'result', ok: true, ...result };
        return;
      }
      case 'build': {
        const items = command.mode === 'names' ? parseNames(command.query) : suggestItems(command.query);
        if (portable && await libraryState(figma) !== 'ready') {
          if (closed) return;
          refreshLibrary = true;
          preparation = createPreparation(figma, text => send({ type: 'progress', text }));
          const bundle = JSON.parse(inflate(figma.base64Decode(portable), { to: 'string' })) as LibraryBundle;
          await preparation.install(bundle);
          preparation = undefined;
          if (closed) return;
        }
        await composer.build(items, command.options);
        text = `Собрано: ${items.map(item => itemName(item.id)).join(', ')}.`;
        break;
      }
      case 'alternative':
        await composer.alternative(command.sceneId);
        text = 'Кадр с другой раскладкой создан рядом.';
        break;
      case 'palette':
        text = 'Композиция перекрашена.' + overrideWarning(await composer.recolor(command.choice, command.sceneId));
        break;
      case 'add':
        itemName(command.id);
        await composer.add({ id: command.id, role: 'main' }, command.sceneId);
        text = `Добавлен предмет «${itemName(command.id)}».`;
        break;
      case 'role':
        text = 'Роль предмета изменена.' + overrideWarning(await composer.changeRole(command.sceneId, command.itemId));
        break;
      case 'migrate':
        composer.migrate(command.sceneId);
        text = 'Этот кадр доступен для редактирования с другой установкой плагина.';
        break;
      case 'export': {
        let snapshot: typeof exported;
        const download = await composer.exportSvg(command.sceneId, frame => { snapshot = watchExport(frame); });
        if (!snapshot || exported !== snapshot) throw new Error('Композиция изменилась во время экспорта. Экспортируйте SVG снова.');
        response = { type: 'result', ok: true, text: 'SVG подготовлен.', download };
        return;
      }
    }
    invalidateExport();
    figma.commitUndo();
    response = { type: 'result', ok: true, text };
  } catch (error) {
    response = { type: 'result', ok: false, text: error instanceof Error ? error.message : String(error) };
  } finally {
    preparation = undefined;
    if (refreshLibrary) await sendLibraryState();
    busy = false;
    if (response) send(response);
    sendSelection();
  }
};

function overrideWarning(lost: string[]) {
  return lost.length ? ` Не удалось перенести правки (${lost.length}): ${lost.slice(0, 3).join(', ')}${lost.length > 3 ? ' и другие' : ''}. При необходимости отмените действие в Figma.` : '';
}
