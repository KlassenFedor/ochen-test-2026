import type { Transform } from './layout';

type Point = readonly [number, number];
type Curve = Point[];
type Distance = (point: Point) => number;
const number = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[eE][-+]?\\d+)?';
const tokens = new RegExp(`[a-zA-Z]|${number}`, 'g');
const numbers = new RegExp(number, 'g');
const coordinatesPerCommand: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2 };

export const identity: Transform = [[1, 0, 0], [0, 1, 0]];

function multiply(a: Transform, b: Transform): Transform {
  return a.map(([x, y, z]) => [
    x * b[0][0] + y * b[1][0], x * b[0][1] + y * b[1][1], x * b[0][2] + y * b[1][2] + z
  ]) as Transform;
}

export function svgTransform(value: string, parent: Transform): Transform | undefined {
  const transforms = /([a-zA-Z]+)\(([^)]*)\)/g;
  let result = parent;
  let position = 0;
  for (const match of value.matchAll(transforms)) {
    if (value.slice(position, match.index).replace(/[\s,]/g, '') || match[2]!.replace(numbers, '').replace(/[\s,]/g, '')) return;
    position = match.index! + match[0].length;
    const args = (match[2]!.match(numbers) ?? []).map(Number);
    if (!args.every(Number.isFinite)) return;
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = args;
    const theta = a * Math.PI / 180;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    let local: Transform;
    switch (match[1]) {
      case 'matrix':
        if (args.length !== 6) return;
        local = [[a, c, e], [b, d, f]];
        break;
      case 'translate':
        if (args.length < 1 || args.length > 2) return;
        local = [[1, 0, a], [0, 1, b]];
        break;
      case 'scale':
        if (args.length < 1 || args.length > 2) return;
        local = [[a, 0, 0], [0, args[1] ?? a, 0]];
        break;
      case 'rotate':
        if (args.length !== 1 && args.length !== 3) return;
        local = [[cos, -sin, b - cos * b + sin * c], [sin, cos, c - sin * b - cos * c]];
        break;
      case 'skewX':
      case 'skewY':
        if (args.length !== 1) return;
        local = match[1] === 'skewX' ? [[1, Math.tan(theta), 0], [0, 1, 0]] : [[1, 0, 0], [Math.tan(theta), 1, 0]];
        break;
      default: return;
    }
    result = multiply(result, local);
  }
  if (value.slice(position).replace(/[\s,]/g, '') || !result.flat().every(Number.isFinite)) return;
  return result;
}

const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
const end = (curve: Curve) => curve[curve.length - 1]!;

function parsePath(path: string): Curve[][] | undefined {
  if (path.replace(tokens, '').replace(/[\s,]/g, '')) return;
  const input = path.match(tokens) ?? [];
  const contours: Curve[][] = [];
  let current: Curve[] = [];
  let point: Point = [0, 0];
  let origin = point;
  let command = '';
  let previous: Curve | undefined;
  let moved = false;
  function finish() {
    if (current.length) {
      if (!same(point, origin)) current.push([point, origin]);
      contours.push(current);
      current = [];
    }
  }

  for (let index = 0; index < input.length;) {
    if (/^[a-z]$/i.test(input[index]!)) command = input[index++]!;
    const upper = command.toUpperCase();
    if (upper === 'Z' && moved) {
      finish();
      point = origin;
      previous = undefined;
      command = '';
      continue;
    }
    const arity = coordinatesPerCommand[upper];
    if (!arity || (upper !== 'M' && !moved) || index + arity > input.length) return;
    const args = input.slice(index, index += arity).map(Number);
    if (!args.every(Number.isFinite)) return;
    const relative = command !== upper;
    const coordinates = (i: number): Point => [args[i]! + (relative ? point[0] : 0), args[i + 1]! + (relative ? point[1] : 0)];
    const reflected = (controlCount: number): Point => {
      const control = previous?.length === controlCount + 2 ? previous[controlCount]! : point;
      return [2 * point[0] - control[0], 2 * point[1] - control[1]];
    };
    let segment: Curve;
    switch (upper) {
      case 'M':
        finish();
        origin = point = coordinates(0);
        moved = true;
        previous = undefined;
        command = relative ? 'l' : 'L';
        continue;
      case 'L': segment = [point, coordinates(0)]; break;
      case 'H': segment = [point, [args[0]! + (relative ? point[0] : 0), point[1]]]; break;
      case 'V': segment = [point, [point[0], args[0]! + (relative ? point[1] : 0)]]; break;
      case 'C': segment = [point, coordinates(0), coordinates(2), coordinates(4)]; break;
      case 'S': segment = [point, reflected(2), coordinates(0), coordinates(2)]; break;
      case 'Q': segment = [point, coordinates(0), coordinates(2)]; break;
      case 'T': segment = [point, reflected(1), coordinates(0)]; break;
      default: return;
    }
    current.push(segment);
    previous = segment;
    point = end(segment);
  }
  finish();
  return contours;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function evaluate(values: number[], t: number): number {
  while (values.length > 1) values = values.slice(1).map((b, i) => mix(values[i]!, b, t));
  return values[0]!;
}

// Derivative roots split the curve into monotone parts. Each sign change
// brackets one crossing, even when a cubic crosses the same edge three times.
function roots(values: number[]): number[] {
  if (values.every(value => value >= 0) || values.every(value => value <= 0)) return [];
  if (values.length === 2) return [values[0]! / (values[0]! - values[1]!)];
  const extrema = roots(values.slice(1).map((b, i) => b - values[i]!));
  const ends = [0, ...extrema, 1];
  const crossings: number[] = [];
  for (let i = 1; i < ends.length; i++) {
    let a = ends[i - 1]!, b = ends[i]!;
    const atA = evaluate(values, a), atB = evaluate(values, b);
    if (i > 1 && atA === 0) crossings.push(a);
    if (atA * atB >= 0) continue;
    for (let step = 0; step < 44; step++) {
      const middle = (a + b) / 2;
      if ((evaluate(values, middle) > 0) === (atA > 0)) a = middle;
      else b = middle;
    }
    crossings.push((a + b) / 2);
  }
  return crossings;
}

function split(curve: Curve, t: number): [Curve, Curve] {
  const left = [curve[0]!];
  const right = [end(curve)];
  while (curve.length > 1) {
    curve = curve.slice(1).map(([x, y], i): Point => [mix(curve[i]![0], x, t), mix(curve[i]![1], y, t)]);
    left.push(curve[0]!);
    right.push(end(curve));
  }
  return [left, right.reverse()];
}

function clipContour(contour: Curve[], distance: Distance): Curve[] {
  const clipped: Curve[] = [];
  for (const original of contour) {
    const distances = original.map(distance);
    if (distances.every(value => value >= 0)) {
      clipped.push(original);
      continue;
    }
    let rest = original, start = 0;
    for (const stop of [...roots(distances), 1]) {
      const [piece, remainder] = stop === 1 ? [rest, rest] : split(rest, (stop - start) / (1 - start));
      if (evaluate(distances, (stop + start) / 2) >= 0) clipped.push(piece);
      rest = remainder;
      start = stop;
    }
  }
  // Join surviving segments along the clipping edge. Joins run in opposite
  // directions across gaps, preserving the winding of disconnected pieces.
  return clipped.flatMap((curve, index) => {
    const next = clipped[(index + 1) % clipped.length]![0]!;
    return same(end(curve), next) ? [curve] : [curve, [end(curve), next]];
  });
}

export function clipFilledPath(path: string, transform: Transform, width: number, height: number): string | undefined {
  const contours = parsePath(path);
  if (!contours) return;
  const [[a, b, tx], [c, d, ty]] = transform;
  const x = ([u, v]: Point) => a * u + b * v + tx;
  const y = ([u, v]: Point) => c * u + d * v + ty;
  const edges: Distance[] = [x, point => width - x(point), y, point => height - y(point)];
  if (contours.some(contour => contour.some(curve => curve.some(point => !Number.isFinite(x(point)) || !Number.isFinite(y(point)))))) return;
  if (contours.every(contour => contour.every(curve => curve.every(point => edges.every(edge => edge(point) >= 0))))) return path;
  const format = (point: Point) => point.map(value => Number(value.toFixed(10))).join(' ');
  const painted = (contour: Curve[]) => edges.every(edge => contour.some(curve => curve.some(point => edge(point) > 1e-9)));
  return contours.map(contour => edges.reduce(clipContour, contour)).filter(painted).map(([first, ...rest]) =>
    `M${format(first![0]!)}` + [first!, ...rest].map(curve =>
      ['L', 'Q', 'C'][curve.length - 2] + curve.slice(1).map(format).join(' ')).join('') + 'Z'
  ).join('');
}
