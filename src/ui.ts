import { catalog, names } from './catalog';
import { isFormat, isSize } from './layout';
import { isScheme, parsePalette, schemes, type Palette, type PaletteChoice } from './palette';
import type { SelectionState } from './figma/scene';
import type { Command, Message } from './protocol';

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id)! as T;
}
const query = element<HTMLTextAreaElement>('query');
const palette = element<HTMLSelectElement>('palette');
const file = element<HTMLInputElement>('palette-file');
const items = element<HTMLSelectElement>('item');
const status = element('status');
const selectionText = element('selection');
const download = element<HTMLAnchorElement>('download');
const button = (id: string) => element<HTMLButtonElement>(id);
let busy = false;
let mode: 'names' | 'title' = 'names';
let selection: SelectionState = {};
let custom: Palette | undefined;
let downloadUrl: string | undefined;

for (const [id, label] of Object.entries(schemes)) palette.add(new Option(label, id));
for (const { id, name } of catalog) items.add(new Option(name, id));

function feedback(text: string, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

function update() {
  for (const id of ['build', 'import-palette']) button(id).disabled = busy;
  for (const id of ['add', 'alternative', 'apply', 'export']) button(id).disabled = busy || !selection.scene;
  button('role').disabled = busy || !selection.item;
  button('role').textContent = selection.item?.role === 'main' ? 'Сделать фоновым' :
    selection.item?.role === 'background' ? 'Сделать главным' : 'Сменить роль';
  const text = selection.scene ? [selection.scene, selection.item?.name].filter(Boolean).join(' / ') :
    'Выделите кадр или предмет в нём.';
  selectionText.textContent = text;
  selectionText.title = text;
}

function updateMode() {
  const namesMode = mode === 'names';
  query.placeholder = namesMode ? 'Книга, телефон' : 'Учиться в дороге';
  element('query-label').textContent = namesMode ? 'Предметы через запятую' : 'Заголовок или метафора';
  element('query-hint').textContent = namesMode ? names : 'Подбор 1–3 предметов по словам и фразам.';
}

function choice(): PaletteChoice {
  if (palette.value === 'custom' && custom) return { kind: 'custom', palette: custom };
  if (isScheme(palette.value)) return { kind: 'preset', scheme: palette.value };
  throw new Error('Выберите палитру.');
}

function send(command: Command) {
  if (busy) return;
  if (command.type === 'export' && downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = undefined;
    download.hidden = true;
    download.removeAttribute('href');
  }
  if (command.type !== 'ready') {
    busy = true;
    update();
    feedback('Выполняется…');
  }
  parent.postMessage({ pluginMessage: command }, '*');
}

element<HTMLFormElement>('compose').addEventListener('submit', event => {
  event.preventDefault();
  const format = element<HTMLSelectElement>('format').value;
  const size = element<HTMLSelectElement>('size').value;
  if (!isFormat(format) || !isSize(size)) return;
  send({ type: 'build', mode, query: query.value, options: { format, size, palette: choice(), title: '' } });
});
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=mode]')) {
  radio.addEventListener('change', () => {
    mode = radio.value === 'title' ? 'title' : 'names';
    updateMode();
  });
}
button('import-palette').onclick = () => file.click();
file.onchange = async () => {
  const paletteFile = file.files?.[0];
  file.value = '';
  if (!paletteFile || busy) return;
  busy = true;
  update();
  try {
    if (paletteFile.size > 65536) throw new Error('Размер JSON палитры должен быть меньше 64 КБ.');
    const parsed = parsePalette(await paletteFile.text());
    let option = palette.querySelector<HTMLOptionElement>('option[value=custom]');
    if (!option) {
      option = new Option('', 'custom');
      palette.add(option);
    }
    custom = parsed;
    option.textContent = parsed.name;
    palette.value = 'custom';
    feedback(`Палитра «${parsed.name}» загружена.`);
  } catch (error) {
    feedback(error instanceof Error ? error.message : String(error), true);
    return;
  } finally {
    busy = false;
    update();
  }
  if (selection.scene) send({ type: 'palette', choice: choice() });
};

button('alternative').onclick = () => send({ type: 'alternative' });
button('add').onclick = () => send({ type: 'add', id: items.value });
button('role').onclick = () => send({ type: 'role' });
button('apply').onclick = () => send({ type: 'palette', choice: choice() });
button('export').onclick = () => send({ type: 'export' });

window.addEventListener('message', event => {
  const message = event.data?.pluginMessage as Message | undefined;
  if (!message) return;
  if (message.type === 'selection') {
    selection = message.selection;
  } else if (message.type === 'result') {
    busy = false;
    feedback(message.text, !message.ok);
    if (message.download) {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(new Blob([message.download.svg], { type: 'image/svg+xml' }));
      download.href = downloadUrl;
      download.download = message.download.filename;
      download.hidden = false;
      download.click();
    }
  }
  update();
});
window.addEventListener('unload', () => {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
});
updateMode();
update();
send({ type: 'ready' });
