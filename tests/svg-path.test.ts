import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipFilledPath, identity, svgTransform } from '../src/svg-path';

test('rectangular clipping covers every edge, corner, tangent and outside position', () => {
  const offsets = [-21, -20, -10, 0, 40, 80, 90, 100, 101];
  for (const x of offsets) for (const y of offsets) {
    const path = `M${x} ${y}h20v20h-20z`;
    const clipped = clipFilledPath(path, identity, 100, 100);
    const left = Math.max(0, x), right = Math.min(100, x + 20);
    const top = Math.max(0, y), bottom = Math.min(100, y + 20);
    if (left >= right || top >= bottom) {
      assert.equal(clipped, '', `invisible at (${x}, ${y})`);
      continue;
    }
    const points = [...clipped!.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
      .map(([, a, b]) => [Number(a), Number(b)] as const);
    if (!points.length || clipped === path) {
      assert.equal(clipped, path);
      assert.ok(x >= 0 && x + 20 <= 100 && y >= 0 && y + 20 <= 100);
    } else {
      assert.deepEqual([...new Set(points.map(point => point.join(',')))].sort(),
        [`${left},${top}`, `${left},${bottom}`, `${right},${top}`, `${right},${bottom}`].sort());
    }
  }
});

test('clipping preserves contours, winding and cubic pieces without flattening them', () => {
  const hollow = 'M-10 -10h120v120h-120ZM20 20v60h60v-60Z';
  assert.equal(clipFilledPath(hollow, identity, 100, 100), 'M100 0L100 100L0 100L0 0L100 0ZM20 20L20 80L80 80L80 20L20 20Z');
  const cubic = clipFilledPath('M-10 10C90 20 -90 30 10 40L40 60L-30 70Z', identity, 100, 100)!;
  assert.equal((cubic.match(/C/g) ?? []).length, 2);
  assert.match(cubic, /^M0 /);
  assert.doesNotMatch(cubic, /NaN|Infinity/);
  assert.equal(clipFilledPath('M10 10q12 -1 20 10t20 15s0 10 10 10Z', identity, 100, 100),
    'M10 10q12 -1 20 10t20 15s0 10 10 10Z');
});

test('clipping uses the combined affine transform and leaves unsupported paths to the SVG mask', () => {
  const transform = svgTransform('translate(5 0) rotate(90)', identity)!;
  const clipped = clipFilledPath('M2 2H8V8H2Z', transform, 100, 100)!;
  assert.match(clipped, /8 5/);
  assert.match(clipped, /2 5/);
  const nested = svgTransform('scale(-2 1)', svgTransform('translate(5 0)', identity)!)!;
  assert.equal(clipFilledPath('m1 1h3v2h-3z', nested, 100, 100), 'M1 1L2.5 1L2.5 3L1 3L1 1Z');
  assert.equal(clipFilledPath('M1 1A1 1 0 0 1 2 2Z', identity, 100, 100), undefined);
  assert.equal(svgTransform('matrix(1 0 0 1 missing 0)', identity), undefined);
});
