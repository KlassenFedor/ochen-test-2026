import { itemName, parseNames, suggestItems } from './catalog';
import type { Host } from './figma/host';
import { libraryState } from './figma/library';
import { createPreparation } from './figma/prepare-library.js';
import { captureLibrary, type LibraryBundle } from './figma/library-bundle.js';
import { createComposer } from './figma/scene';
import { readCommand, type Message } from './protocol';

declare const __html__: string;
declare const __PORTABLE_LIBRARY__: LibraryBundle | null | undefined;
declare const figma: Host & {
  showUI(html: string, options: { width: number; height: number; themeColors: boolean }): void;
  on(event: 'selectionchange' | 'currentpagechange' | 'close', listener: () => void): void;
  commitUndo(): void;
  ui: { onmessage: (data: unknown) => void; postMessage(message: Message): void };
};

const composer = createComposer(figma);
const portable = typeof __PORTABLE_LIBRARY__ === 'undefined' ? undefined : __PORTABLE_LIBRARY__;
figma.showUI(__html__, { width: 408, height: 680, themeColors: true });
let busy = false;
let closed = false;
let preparation: ReturnType<typeof createPreparation> | undefined;
const send = (message: Message) => {
  if (!closed) figma.ui.postMessage(message);
};

function sendSelection() {
  if (closed) return;
  try { send({ type: 'selection', selection: composer.selection() }); }
  catch { send({ type: 'selection', selection: {} }); }
}
async function sendLibraryState() {
  if (closed) return;
  try {
    const state = await libraryState(figma);
    send({ type: 'library', state: portable && state !== 'ready' ? 'bundled' : state });
  } catch (error) {
    send({ type: 'library', state: 'unavailable', error: error instanceof Error ? error.message : String(error) });
  }
}
figma.on('selectionchange', sendSelection);
figma.on('currentpagechange', sendSelection);
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
          await preparation.install(portable);
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
      case 'export':
        response = { type: 'result', ok: true, text: 'SVG подготовлен.', download: await composer.exportSvg(command.sceneId) };
        return;
    }
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
