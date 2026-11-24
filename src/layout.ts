import layouts from '../data/layouts.json';
import type { Role } from './catalog';

export type Format = keyof typeof layouts;
export type Size = 'large' | 'small';
export type Dimensions = { width: number; height: number };
export type Rect = Dimensions & { x: number; y: number };
export type Transform = [[number, number, number], [number, number, number]];
type LayoutItem = Dimensions & { role: Role };
type Place = Rect & { index: number };

export function isFormat(value: unknown): value is Format {
  return value === 'square' || value === 'horizontal' || value === 'vertical';
}

export function isSize(value: unknown): value is Size {
  return value === 'large' || value === 'small';
}

export function frameSize(format: Format): Dimensions {
  const { width, height } = layouts[format];
  return { width, height };
}

function centered(dim: Dimensions, x: number, y: number, scale: number): Rect {
  const width = dim.width * scale;
  const height = dim.height * scale;
  return { x: x - width / 2, y: y - height / 2, width, height };
}

function frameScale(dim: Dimensions, frame: Dimensions, fraction: number): number {
  return Math.min(frame.width / dim.width, frame.height / dim.height) * fraction;
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x, y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y)
  };
}

function area(rect: Rect) {
  return rect.width * rect.height;
}

function subtract(rect: Rect, cover: Rect): Rect[] {
  const cut = intersect(rect, cover);
  if (!area(cut)) return [rect];
  const right = cut.x + cut.width, bottom = cut.y + cut.height;
  return [
    { ...rect, width: cut.x - rect.x },
    { ...rect, x: right, width: rect.x + rect.width - right },
    { x: cut.x, y: rect.y, width: cut.width, height: cut.y - rect.y },
    { x: cut.x, y: bottom, width: cut.width, height: rect.y + rect.height - bottom }
  ].filter(part => area(part) > 0);
}

function visibleEnough(items: LayoutItem[], places: Place[]): boolean {
  return places.every((place, i) => {
    if (items[place.index]!.role === 'background') return true;
    // Templates have at most three objects. Count intersecting covers once.
    const covers = places.slice(i + 1).map(top => intersect(place, top));
    const covered = covers.reduce((sum, cover) => sum + area(cover), 0)
      - (covers[0] && covers[1] ? area(intersect(covers[0], covers[1])) : 0);
    return covered <= area(place) * 0.45;
  });
}

function anchored(
  items: LayoutItem[], order: number[], frame: Dimensions,
  id: string, points: number[][], fraction: number
) {
  const margin = 0.045;
  const scale = Math.min(...order.map((index, i) => {
    const item = items[index]!;
    const [x = 0.5, y = 0.5] = points[i]!;
    return Math.min(
      frameScale(item, frame, fraction),
      2 * (Math.min(x, 1 - x) - margin) * frame.width / item.width,
      2 * (Math.min(y, 1 - y) - margin) * frame.height / item.height
    );
  }));
  const places = order.map((index, i) => ({
    index,
    ...centered(items[index]!, frame.width * points[i]![0]!, frame.height * points[i]![1]!, scale)
  }));
  return { id, scale, places };
}

function grid(items: LayoutItem[], order: number[], frame: Dimensions, columns: number) {
  const rows = Math.ceil(order.length / columns);
  const cellW = frame.width * 0.92 / columns;
  const cellH = frame.height * 0.92 / rows;
  let scale = Infinity;
  for (const item of items) {
    scale = Math.min(scale, frameScale(item, { width: cellW, height: cellH }, 0.84));
  }
  const places = order.map((index, i) => {
    const row = Math.floor(i / columns);
    const rowCount = Math.min(columns, order.length - row * columns);
    const x = frame.width / 2 + (i % columns + 0.5 - rowCount / 2) * cellW;
    const y = frame.height / 2 + (row + 0.5 - rows / 2) * cellH;
    return { index, ...centered(items[index]!, x, y, scale) };
  });
  return { id: `rows-${columns}`, scale, places };
}

export function planLayout(items: LayoutItem[], format: Format, previous?: string) {
  if (!items.length || items.some(item => ![item.width, item.height].every(v => Number.isFinite(v) && v > 0))) {
    throw new Error('Для раскладки нужны предметы с положительными габаритами.');
  }
  const frame = layouts[format];
  // Background figures go behind main figures, preserving order within each role.
  const order = items.map((_, index) => index).sort((a, b) =>
    Number(items[a]!.role === 'main') - Number(items[b]!.role === 'main'));
  const candidates = [];
  if (items.length === 1) {
    candidates.push(anchored(items, order, frame, 'center', [[0.5, 0.5]], 0.73));
    candidates.push(anchored(items, order, frame, 'offset', [[0.59, 0.46]], 0.68));
  } else if (items.length === 2) {
    const mixed = items[0]!.role !== items[1]!.role;
    if (mixed) candidates.push(anchored(items, order, frame, 'foreground', frame.overlap, 0.65));
    candidates.push(anchored(items, order, frame, 'diagonal', frame.diagonal, 0.57));
    if (!mixed) candidates.push(anchored(items, order, frame, 'overlap', frame.overlap, 0.65));
  } else if (items.length === 3) {
    candidates.push(anchored(items, order, frame, 'trio', frame.trio, 0.48));
    candidates.push(anchored(items, order, frame, 'trio-mirrored',
      frame.trio.map(([x, y]) => [1 - x!, y!]), 0.48));
  }
  const valid = candidates.filter(candidate => visibleEnough(items, candidate.places));
  const columns = Math.min(items.length, Math.ceil(Math.sqrt(items.length * frame.width / frame.height)));
  valid.push(grid(items, order, frame, columns));
  if (items.length > 1) {
    const otherColumns = columns > 1 ? columns - 1 : columns + 1;
    valid.push(grid(items, order, frame, otherColumns));
  }
  const previousIndex = valid.findIndex(candidate => candidate.id === previous);
  return { ...valid[(previousIndex + 1) % valid.length]!, frame: frameSize(format) };
}

export function planAddition(item: Dimensions, frame: Dimensions, scale: number, occupied: (Rect & { role?: Role })[]) {
  const fitted = Math.min(scale, frameScale(item, frame, 0.8));
  const anchors = [0.5, 0.25, 0.75, 0, 1, 0.125, 0.375, 0.625, 0.875];
  const clipped = occupied.map(rect => ({
    rect: intersect(rect, { ...frame, x: 0, y: 0 }), main: rect.role !== 'background'
  })).filter(({ rect }) => area(rect) > 0);
  // Treat each layer's bounding box as opaque. Measure only the parts still
  // exposed after clipping and overlap with higher layers.
  const visible = clipped.map(({ rect, main }, i) => {
    const parts = clipped.slice(i + 1).reduce<Rect[]>((result, top) =>
      result.flatMap(part => subtract(part, top.rect)), [rect]);
    return { parts, main, area: parts.reduce((sum, part) => sum + area(part), 0) };
  });
  for (const fraction of [1, 0.85, 0.7, 0.55, 0.4]) {
    const candidateScale = fitted * fraction;
    if (candidateScale < 0.01) break;
    const halfW = item.width * candidateScale / 2, halfH = item.height * candidateScale / 2;
    let best: (Rect & { scale: number }) | undefined;
    let lowest = Infinity;
    for (const y of anchors) for (const x of anchors) {
      const candidate = centered(item, halfW + x * (frame.width - 2 * halfW),
        halfH + y * (frame.height - 2 * halfH), candidateScale);
      const covers = visible.map(({ parts }) =>
        parts.reduce((sum, part) => sum + area(intersect(part, candidate)), 0));
      if (visible.some(({ main, area }, index) => main && covers[index]! > area * 0.25)) continue;
      const overlap = covers.reduce((sum, value) => sum + value, 0);
      if (overlap < lowest) {
        best = { ...candidate, scale: candidateScale };
        lowest = overlap;
      }
    }
    if (best) return best;
  }
  throw new Error('Нет места для нового предмета. Освободите место в кадре и повторите добавление.');
}

export function keepCenter(transform: Transform, before: Dimensions, after: Dimensions): Transform {
  const [[a, b, x], [c, d, y]] = transform;
  const dx = (before.width - after.width) / 2;
  const dy = (before.height - after.height) / 2;
  return [[a, b, x + a * dx + b * dy], [c, d, y + c * dx + d * dy]];
}

export function transformedBounds([[a, b, x], [c, d, y]]: Transform, dim: Dimensions): Rect {
  const xs = [x, x + a * dim.width, x + b * dim.height, x + a * dim.width + b * dim.height];
  const ys = [y, y + c * dim.width, y + d * dim.height, y + c * dim.width + d * dim.height];
  const left = Math.min(...xs), top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}
