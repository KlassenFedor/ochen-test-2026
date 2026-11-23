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

export function prepareSvgExport(bytes: Uint8Array): string {
  // The Figma plugin sandbox has no TextDecoder. Interpret the native bytes as
  // UTF-8 before converting Unicode in XML attributes to character references.
  let raw = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  let svg: string;
  try {
    svg = raw.replace(/[\x80-\xFF]+/g, run => decodeURIComponent(
      Array.from(run, byte => '%' + byte.charCodeAt(0).toString(16)).join('')
    )).replace(/^\uFEFF/, '');
  } catch {
    throw new Error('Figma вернула SVG с некорректной кодировкой UTF-8.');
  }

  // Encode the same characters in ids and references, including url(#…).
  // Opening tags are scanned separately so comments, text and CDATA stay intact.
  return validateSvg(svg).replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[A-Za-z][^\s/>]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, tag => {
    if (tag.startsWith('<!')) return tag;
    return tag.replace(/"[^"]*"|'[^']*'/g, value => value.replace(/[^\x00-\x7F]/gu,
      char => '&#x' + char.codePointAt(0)!.toString(16) + ';'
    ));
  });
}

export function svgFilename(name: string): string {
  const base = name.replace(/[^\p{L}\p{N}\s_-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 80);
  return `${base || 'illustration'}.svg`;
}
