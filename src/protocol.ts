import { isFormat, isSize } from './layout';
import { readPaletteChoice, record } from './palette';
import type { BuildOptions, SelectionState } from './figma/scene';

export type Command =
  | { type: 'build'; mode: 'names' | 'title'; query: string; options: BuildOptions }
  | { type: 'add'; id: string }
  | { type: 'palette'; choice: BuildOptions['palette'] }
  | { type: 'ready' | 'alternative' | 'role' | 'export' };

export type Message =
  | { type: 'selection'; selection: SelectionState }
  | { type: 'result'; ok: boolean; text: string; download?: { filename: string; svg: string } };

export function readCommand(value: unknown): Command {
  const command = record(value);
  switch (command.type) {
    case 'ready':
    case 'alternative':
    case 'role':
    case 'export':
      return { type: command.type };
    case 'add':
      if (typeof command.id === 'string') return { type: 'add', id: command.id };
      break;
    case 'palette':
      return { type: 'palette', choice: readPaletteChoice(command.choice) };
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
