export function validateSvg(svg: string): string {
  if (!/<svg(?:\s|>)/i.test(svg) || !/<\/svg\s*>/i.test(svg)) {
    throw new Error('Figma вернула неполный SVG.');
  }
  const markup = svg.replace(/<!--[\s\S]*?-->/g, '');
  if (/<(?:[\w.-]+:)?(?:image|feImage|foreignObject)(?=[\s/>])/i.test(markup)) {
    throw new Error('SVG содержит растровую вставку или встроенный HTML. Уберите этот слой и повторите экспорт.');
  }
  return svg;
}

export function svgFilename(name: string): string {
  const base = name.replace(/[^\p{L}\p{N}\s_-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 80);
  return `${base || 'illustration'}.svg`;
}
