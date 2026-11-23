export type RGB = { readonly r: number; readonly g: number; readonly b: number };
type Colors<T> = [T, T, T, T];
export type Channel = 'background' | 'object';
export type Slot = `${Channel}/${0 | 1 | 2 | 3}`;
export type Palette = {
  version: 1;
  name: string;
  background: Colors<RGB>;
  object: Colors<RGB>;
};

export const schemes = { violet: 'Сиреневая', peach: 'Персиковая', turquoise: 'Бирюзовая' };
export type Scheme = keyof typeof schemes;
export type PaletteChoice = { kind: 'preset'; scheme: Scheme } | { kind: 'custom'; palette: Palette };
export type AppliedPalette = { scheme?: Scheme; palette: Palette };

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ожидается объект.');
  return value as Record<string, unknown>;
}

export function isScheme(value: unknown): value is Scheme {
  return value === 'violet' || value === 'peach' || value === 'turquoise';
}

export function isSlot(value: string): value is Slot {
  return /^(background|object)\/[0-3]$/.test(value);
}

export function fromHex(value: unknown): RGB {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Ожидается цвет #RRGGBB.');
  return { r: parseInt(value.slice(1, 3), 16) / 255, g: parseInt(value.slice(3, 5), 16) / 255, b: parseInt(value.slice(5, 7), 16) / 255 };
}

export function rgb(value: unknown): RGB {
  const { r, g, b } = record(value);
  if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number'
    || ![r, g, b].every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1)) {
    throw new Error('Недопустимые каналы RGB.');
  }
  return { r, g, b };
}

function readPalette(value: unknown, readColor: (value: unknown) => RGB): Palette {
  const data = record(value);
  if (data.version !== 1) throw new Error('В палитре требуется version: 1.');
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80) {
    throw new Error('Укажите название палитры длиной от 1 до 80 символов.');
  }
  const colors = (channel: Channel): Colors<RGB> => {
    const entries = data[channel];
    if (!Array.isArray(entries) || entries.length !== 4) throw new Error(`В «${channel}» нужно ровно четыре цвета.`);
    return Array.from(entries, (color, index) => {
      try { return readColor(color); }
      catch (error) { throw new Error(`${channel}[${index + 1}]: ${(error as Error).message}`); }
    }) as Colors<RGB>;
  };
  return { version: 1, name: data.name.trim(), background: colors('background'), object: colors('object') };
}

export function parsePalette(text: string): Palette {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Не удалось прочитать JSON палитры.'); }
  return readPalette(value, fromHex);
}

export function readPaletteSnapshot(value: unknown): Palette {
  return readPalette(value, rgb);
}

export function readPaletteChoice(value: unknown): PaletteChoice {
  const data = record(value);
  if (data.kind === 'preset' && isScheme(data.scheme)) return { kind: data.kind, scheme: data.scheme };
  if (data.kind === 'custom') return { kind: data.kind, palette: readPaletteSnapshot(data.palette) };
  throw new Error('Выберите доступную палитру.');
}

export function paletteColor(palette: Palette, slot: Slot): RGB {
  const [channel, index] = slot.split('/') as [Channel, '0' | '1' | '2' | '3'];
  return palette[channel][index];
}
