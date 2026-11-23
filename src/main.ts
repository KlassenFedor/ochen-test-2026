import { itemName, parseNames, suggestItems } from './catalog';
import type { Host } from './figma/host';
import { createComposer } from './figma/scene';
import { readCommand, type Message } from './protocol';

declare const __html__: string;
declare const figma: Host & {
  showUI(html: string, options: { width: number; height: number; themeColors: boolean }): void;
  on(event: 'selectionchange' | 'currentpagechange', listener: () => void): void;
  ui: { onmessage: (data: unknown) => void; postMessage(message: Message): void };
};

const composer = createComposer(figma);
figma.showUI(__html__, { width: 392, height: 645, themeColors: true });
let busy = false;
const send = (message: Message) => figma.ui.postMessage(message);

function sendSelection() {
  try { send({ type: 'selection', selection: composer.selection() }); }
  catch { send({ type: 'selection', selection: {} }); }
}
figma.on('selectionchange', sendSelection);
figma.on('currentpagechange', sendSelection);

figma.ui.onmessage = async (data: unknown) => {
  if (busy) return;
  busy = true;
  try {
    const command = readCommand(data);
    let text: string;
    switch (command.type) {
      case 'ready': return;
      case 'build': {
        const items = command.mode === 'names' ? parseNames(command.query) : suggestItems(command.query);
        await composer.build(items, command.options);
        text = `Собрано: ${items.map(item => itemName(item.id)).join(', ')}.`;
        break;
      }
      case 'alternative':
        await composer.alternative();
        text = 'Другой вариант создан рядом.';
        break;
      case 'palette':
        await composer.recolor(command.choice);
        text = 'Палитра применена к выделенной композиции.';
        break;
      case 'add':
        itemName(command.id);
        await composer.add({ id: command.id, role: 'main' });
        text = `Добавлен предмет «${itemName(command.id)}».`;
        break;
      case 'role':
        await composer.changeRole();
        text = 'Роль предмета изменена.';
        break;
      case 'export':
        send({ type: 'result', ok: true, text: 'SVG подготовлен.', download: await composer.exportSvg() });
        return;
    }
    send({ type: 'result', ok: true, text });
  } catch (error) {
    send({ type: 'result', ok: false, text: error instanceof Error ? error.message : String(error) });
  } finally {
    busy = false;
    sendSelection();
  }
};
