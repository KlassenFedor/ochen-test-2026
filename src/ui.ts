import { catalog, names } from './catalog';
import { isFormat, isSize } from './layout';
import { isScheme, parsePalette, schemes, type PaletteChoice } from './palette';
import type { SelectionState } from './figma/scene';
import type { Command, Message } from './protocol';

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id)! as T;
}
const button = (id: string) => element<HTMLButtonElement>(id);
const query = element<HTMLTextAreaElement>('query');
const format = element<HTMLSelectElement>('format');
const size = element<HTMLSelectElement>('size');
const items = element<HTMLSelectElement>('item');
const buildPalette = element<HTMLSelectElement>('build-palette');
const scenePalette = element<HTMLSelectElement>('scene-palette');
const status = element('status');
const download = element<HTMLAnchorElement>('download');
const options = new Map<string, PaletteChoice>();

type View = 'create' | 'edit';
let view: View = 'create';
let tabChosen = false;
let receivedSelection = false;
let pending: Exclude<Command['type'], 'ready'> | 'import' | undefined;
let mode: 'names' | 'title' = 'names';
let selection: SelectionState = {};
let appliedPalette = '';
let downloadUrl: string | undefined;

function paletteName(choice: PaletteChoice): string {
  return choice.kind === 'preset' ? schemes[choice.scheme] : choice.palette.name;
}

function paletteOption(choice: PaletteChoice): string {
  const key = choice.kind === 'preset' ? choice.scheme : JSON.stringify(choice.palette);
  if (!options.has(key)) {
    options.set(key, choice);
    for (const picker of [buildPalette, scenePalette]) picker.add(new Option(paletteName(choice), key));
  }
  return key;
}

for (const scheme of Object.keys(schemes).filter(isScheme)) paletteOption({ kind: 'preset', scheme });
for (const { id, name } of catalog) items.add(new Option(name, id));
button('help-open').onclick = () => element<HTMLDialogElement>('help').showModal();

function feedback(text: string, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

function switchView(next: View, focus = false) {
  if (view !== next) element('panel-main').scrollTop = 0;
  view = next;
  for (const name of ['create', 'edit'] as const) {
    const active = name === view;
    const tab = button(name + '-tab');
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    element(name + '-panel').hidden = !active;
  }
  if (focus) button(next + '-tab').focus();
}

function update() {
  const busy = Boolean(pending);
  for (const id of ['build', 'import-build-palette']) button(id).disabled = busy;
  for (const id of ['alternative', 'export', 'import-scene-palette']) button(id).disabled = busy || !selection.scene;

  element('scene-empty').hidden = Boolean(selection.scene);
  element('scene-tools').hidden = !selection.scene;
  const selectionText = element('selection');
  selectionText.textContent = selection.scene?.name ?? '';
  selectionText.title = selectionText.textContent;
  items.disabled = busy || !selection.scene;
  button('add').disabled = items.disabled || !items.value;
  scenePalette.disabled = busy || !selection.scene;
  button('apply').disabled = scenePalette.disabled || !scenePalette.value || scenePalette.value === appliedPalette;

  const item = selection.item;
  element('role-selection').textContent = item ? `«${item.name}» · ${item.role === 'main' ? 'главный предмет' : 'фоновый предмет'}` :
    'Выделите один предмет на холсте, чтобы сменить его роль.';
  const role = button('role');
  role.hidden = !item;
  role.disabled = busy || !item;
  role.textContent = item?.role === 'background' ? 'Сделать главным' : 'Сделать фоновым';
  element('role-hint').hidden = !item;
}

function updateMode() {
  const namesMode = mode === 'names';
  query.placeholder = namesMode ? 'Книга, телефон' : 'Учиться в дороге';
  element('query-label').textContent = namesMode ? 'Предметы через запятую' : 'Заголовок или метафора';
  element('query-hint').textContent = namesMode ? names : 'Плагин подберёт 1–3 предмета по смыслу.';
}

function updateSelection(next: SelectionState) {
  const previousId = selection.scene?.id;
  selection = next;
  const scene = next.scene;
  const current = scene ? paletteOption(scene.palette) : '';
  if (scene?.id !== previousId) items.value = '';
  if (scene && (scene.id !== previousId || current !== appliedPalette)) scenePalette.value = current;
  appliedPalette = current;
  element('current-palette').textContent = scene ? `Текущая палитра: ${paletteName(scene.palette)}` : '';
  if (!receivedSelection && !tabChosen && scene) switchView('edit');
  receivedSelection = true;
  update();
}

function send(command: Command) {
  if (pending) return;
  if (command.type === 'export' && downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = undefined;
    download.hidden = true;
    download.removeAttribute('href');
  }
  if (command.type !== 'ready') {
    pending = command.type;
    update();
    feedback('Выполняется…');
  }
  parent.postMessage({ pluginMessage: command }, '*');
}

for (const name of ['create', 'edit'] as const) {
  const tab = button(name + '-tab');
  tab.onclick = () => {
    tabChosen = true;
    switchView(name);
  };
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    tabChosen = true;
    const next = event.key === 'Home' ? 'create' : event.key === 'End' ? 'edit' :
      view === 'create' ? 'edit' : 'create';
    switchView(next, true);
  };
}

element<HTMLFormElement>('compose').addEventListener('submit', event => {
  event.preventDefault();
  const palette = options.get(buildPalette.value);
  if (!isFormat(format.value) || !isSize(size.value) || !palette) return;
  send({
    type: 'build', mode, query: query.value,
    options: { format: format.value, size: size.value, palette, title: '' }
  });
});
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=mode]')) {
  radio.addEventListener('change', () => {
    mode = radio.value === 'title' ? 'title' : 'names';
    updateMode();
  });
}

function connectImport(scope: 'build' | 'scene', picker: HTMLSelectElement) {
  const file = element<HTMLInputElement>(scope + '-palette-file');
  let targetSceneId: string | undefined;
  button('import-' + scope + '-palette').onclick = () => {
    targetSceneId = selection.scene?.id;
    file.click();
  };
  file.onchange = async () => {
    const paletteFile = file.files?.[0];
    const intendedScene = targetSceneId;
    file.value = '';
    if (!paletteFile || pending) return;
    pending = 'import';
    update();
    try {
      if (paletteFile.size > 65536) throw new Error('Размер файла палитры не должен превышать 64 КБ.');
      const palette = parsePalette(await paletteFile.text());
      const key = paletteOption({ kind: 'custom', palette });
      if (scope === 'build') {
        picker.value = key;
        feedback(`Палитра «${palette.name}» выбрана для новой композиции.`);
      } else if (intendedScene && intendedScene === selection.scene?.id) {
        picker.value = key;
        feedback(key === appliedPalette ? `Палитра «${palette.name}» уже применяется в этом кадре.` :
          `Палитра «${palette.name}» загружена. Нажмите «Перекрасить кадр».`);
      } else {
        feedback(`Палитра «${palette.name}» загружена. Выберите её в списке для нужного кадра.`);
      }
    } catch (error) {
      feedback(error instanceof Error ? error.message : String(error), true);
    } finally {
      pending = undefined;
      update();
    }
  };
}
connectImport('build', buildPalette);
connectImport('scene', scenePalette);

items.onchange = update;
scenePalette.onchange = update;
button('alternative').onclick = () => send({ type: 'alternative' });
button('add').onclick = () => {
  if (!items.value) return;
  send({ type: 'add', id: items.value });
};
button('role').onclick = () => send({ type: 'role' });
button('apply').onclick = () => {
  const choice = options.get(scenePalette.value);
  if (selection.scene && choice && scenePalette.value !== appliedPalette) {
    send({ type: 'palette', sceneId: selection.scene.id, choice });
  }
};
button('export').onclick = () => send({ type: 'export' });

window.addEventListener('message', event => {
  const message = event.data?.pluginMessage as Message | undefined;
  if (!message) return;
  if (message.type === 'selection') {
    updateSelection(message.selection);
  } else if (message.type === 'result') {
    const operation = pending;
    pending = undefined;
    feedback(message.text, !message.ok);
    if (message.ok && operation === 'build' && view === 'create') switchView('edit', true);
    if (message.download) {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(new Blob([message.download.svg], { type: 'image/svg+xml;charset=utf-8' }));
      download.href = downloadUrl;
      download.download = message.download.filename;
      download.hidden = false;
      download.click();
    }
    update();
  }
});
window.addEventListener('unload', () => {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
});
updateMode();
update();
send({ type: 'ready' });
