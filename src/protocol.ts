import { isFormat, isSize } from './layout';
import { readPaletteChoice, record } from './palette';
import type { BuildOptions, SelectionState } from './figma/scene';
import type { LibraryState } from './figma/library';

export type Command =
  | { type: 'build'; mode: 'names' | 'title'; query: string; options: BuildOptions }
  | { type: 'add'; sceneId: string; id: string }
  | { type: 'role'; sceneId: string; itemId: string }
  | { type: 'palette'; sceneId: string; choice: BuildOptions['palette'] }
  | { type: 'alternative' | 'export' | 'migrate'; sceneId: string }
  | { type: 'ready' | 'prepare-library' | 'verify-library' | 'export-library' | 'cancel-library' };

export type Message =
  | { type: 'selection'; selection: SelectionState }
  | { type: 'library'; state: LibraryState; error?: string }
  | { type: 'progress'; text: string }
  | { type: 'result'; ok: boolean; text: string; report?: object; libraryBundle?: object; download?: { sceneId: string; filename: string; svg: string } };

function readId(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value;
}

export function readCommand(value: unknown): Command {
  const command = record(value);
  const sceneId = () => readId(command.sceneId, 'Выделите композицию.');
  switch (command.type) {
    case 'ready':
    case 'prepare-library':
    case 'verify-library':
    case 'export-library':
    case 'cancel-library':
      return { type: command.type };
    case 'alternative':
    case 'export':
    case 'migrate':
      return { type: command.type, sceneId: sceneId() };
    case 'role':
      return { type: 'role', sceneId: sceneId(), itemId: readId(command.itemId, 'Выделите предмет.') };
    case 'add':
      if (typeof command.id === 'string') return { type: 'add', sceneId: sceneId(), id: command.id };
      break;
    case 'palette': {
      const choice = readPaletteChoice(command.choice);
      return { type: 'palette', sceneId: sceneId(), choice };
    }
    case 'build': {
      const opts = record(command.options);
      if (command.mode !== 'names' && command.mode !== 'title') break;
      if (typeof command.query !== 'string' || !command.query.trim() || command.query.length > 4096) {
        throw new Error('Введите заголовок или список названий длиной до 4096 символов.');
      }
      if (!isFormat(opts.format) || !isSize(opts.size)) throw new Error('Выберите формат и детализацию.');
      const query = command.query.trim();
      const title = query.replace(/\s+/g, ' ').slice(0, 80);
      return {
        type: 'build', mode: command.mode, query,
        options: { format: opts.format, size: opts.size, title, palette: readPaletteChoice(opts.palette) }
      };
    }
  }
  throw new Error('Неизвестная или неполная команда.');
}
