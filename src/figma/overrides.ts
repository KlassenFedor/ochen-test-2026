import type { Component, Instance, Node, Paint, SolidPaint } from './host';
import { paletteColor, type AppliedPalette } from '../palette';
import type { ColorLibrary } from './library';

const restorable = new Set(['visible', 'locked', 'name', 'opacity', 'relativeTransform', 'x', 'y', 'rotation']);
const handledAtRoot = new Set(['name', 'visible', 'locked', 'x', 'y', 'relativeTransform', 'rotation',
  'width', 'height', 'scaleFactor', 'mainComponent', 'componentProperties']);

function property(node: Node): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.002;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
}

function comparePaints(value: unknown) {
  // Palette colors and variable bindings are assigned from the new master.
  return Array.isArray(value) ? value.map(paint => paint.type === 'SOLID' ? {
    type: 'SOLID', opacity: paint.opacity ?? 1, visible: paint.visible ?? true, blendMode: paint.blendMode ?? 'NORMAL'
  } : paint) : value;
}

function overridesPaletteColor(value: unknown, original: unknown, colors: ColorLibrary, applied: AppliedPalette): boolean {
  if (!Array.isArray(value) || !Array.isArray(original)) return false;
  return (value as Paint[]).some((paint, i) => {
    const base = (original as Paint[])[i];
    if (paint.type !== 'SOLID' || base?.type !== 'SOLID') return false;
    const sourceBinding = base.boundVariables?.color?.id;
    const actualBinding = paint.boundVariables?.color?.id;
    const slot = sourceBinding && colors.roles.get(sourceBinding);
    if (!slot) return false;
    if (slot === 'fixed') return actualBinding !== sourceBinding;
    if (applied.scheme) return !actualBinding || !colors.matchesToken(actualBinding, applied.scheme, slot);
    return Boolean(actualBinding) || !sameValue(paint.color, paletteColor(applied.palette, slot));
  });
}

function restorePaintAppearance(node: Node, field: 'fills' | 'strokes', value: unknown) {
  const current = node[field];
  if (!Array.isArray(value) || !Array.isArray(current) || value.length !== current.length ||
      !current.every((paint, i) => paint.type === 'SOLID' && value[i]?.type === 'SOLID')) return;
  try {
    node[field] = (current as SolidPaint[]).map((paint, i) => ({
      ...paint, opacity: value[i].opacity ?? 1, visible: value[i].visible ?? true,
      blendMode: value[i].blendMode ?? 'NORMAL'
    }));
  } catch { /* Figma may prohibit this override. */ }
}

export function preserveOverrides(
  original: Instance, before: Component, replacement: Instance, after: Component,
  colors: ColorLibrary, applied: AppliedPalette
): () => string[] {
  const overrides = new Map(original.overrides.map(entry => [entry.id, entry.overriddenFields]));
  const checks: (() => string | undefined)[] = [];
  function visit(source: Node, base: Node | undefined, target: Node | undefined, targetBase: Node | undefined) {
    const fields = overrides.get(source.id) ?? [];
    overrides.delete(source.id);
    for (const field of fields) {
      if (source === original && handledAtRoot.has(field)) continue;
      const label = `«${source.name}» (${field})`;
      const paints = field === 'fills' || field === 'strokes';
      const value = property(source)[field];
      const wanted = paints ? comparePaints(value) : value;
      if (paints && base && overridesPaletteColor(value, base[field], colors, applied)) {
        checks.push(() => `${label}, ручной цвет`);
      }
      if (paints && base && sameValue(wanted, comparePaints(base[field]))) {
        if (target && targetBase && !sameValue(comparePaints(targetBase[field]), comparePaints(target[field]))) {
          restorePaintAppearance(target, field, targetBase[field]);
        }
        continue;
      }
      if (paints && target && !sameValue(wanted, comparePaints(target[field]))) {
        restorePaintAppearance(target, field, value);
      }
      if (target && field in target && value !== undefined && restorable.has(field) &&
          !sameValue(wanted, property(target)[field])) {
        try { property(target)[field] = value; } catch { /* Figma may prohibit this override. */ }
      }
      checks.push(() => {
        if (!target || !(field in target) || value === undefined) return label;
        const current = property(target)[field];
        return sameValue(wanted, paints ? comparePaints(current) : current) ? undefined : label;
      });
    }

    source.children?.forEach((child, index) => {
      const baseChild = base?.children?.[index];
      // Match against master names because the instance layer can be renamed.
      const candidates = targetBase?.children?.map((node, i) => ({ node, i })).filter(({ node }) =>
        node.name === baseChild?.name && node.type === child.type) ?? [];
      const match = candidates.length === 1 ? candidates[0] : undefined;
      visit(child, baseChild, match ? target?.children?.[match.i] : undefined, match?.node);
    });
  }
  visit(original, before, replacement, after);
  return () => [
    ...checks.flatMap(check => check() ?? []),
    ...[...overrides.values()].flat().map(field => `вложенный слой (${field})`)
  ];
}
