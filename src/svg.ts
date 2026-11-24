import { parser } from 'sax';

const svgNamespace = 'http://www.w3.org/2000/svg';
const xlinkNamespace = 'http://www.w3.org/1999/xlink';
const resourceTags = new Set(['defs', 'clipPath', 'mask', 'marker', 'pattern', 'filter', 'symbol']);
const shapes = new Map([
  ['path', ['d']], ['rect', ['width', 'height']], ['circle', ['r']], ['ellipse', ['rx', 'ry']],
  ['polygon', ['points']], ['polyline', ['points']], ['line', []]
]);
const openingTags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^\s!?/<>]+(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
type Element = { name: string; namespace: string; attributes: Map<string, string>; children: Element[]; text?: string };

export function validateSvg(svg: string): string {
  const invalid = () => { throw new Error('Figma вернула неполный SVG или некорректный XML.'); };
  const raster = () => { throw new Error('SVG содержит растровую вставку или встроенный HTML. Уберите этот слой и повторите экспорт.'); };
  const markup = svg.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, '');
  // Check XML rules that the streaming parser accepts for compatibility with HTML.
  if (/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(svg) ||
      /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(markup)) invalid();
  for (const tag of markup.match(openingTags) ?? []) {
    if ((tag.match(/"[^"]*"|'[^']*'/g) ?? []).some(value => value.includes('<'))) invalid();
  }

  const xml = parser(true, { xmlns: true, strictEntities: true });
  xml.onerror = invalid;
  const stack: Element[] = [];
  let root: Element | undefined;
  const ids = new Map<string, Element>();
  const references = new Map<Element, string>();
  const attributeKeys = new Set<string>();
  xml.onattribute = ({ uri, local }) => {
    const key = uri + '\n' + local;
    if (attributeKeys.has(key)) invalid();
    attributeKeys.add(key);
  };
  xml.ondoctype = invalid;
  xml.onopentag = tag => {
    attributeKeys.clear();
    if (/^(?:image|feImage|foreignObject)$/i.test(tag.local)) raster();
    const attributes = new Map(Object.values(tag.attributes)
      .filter(attr => !attr.uri || (attr.uri === xlinkNamespace && attr.local === 'href'))
      .map(attr => [attr.uri ? 'xlink:href' : attr.local, attr.value]));
    const node = { name: tag.local, namespace: tag.uri, attributes, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else {
      if (root || node.name !== 'svg' || (node.namespace && node.namespace !== svgNamespace)) invalid();
      root = node;
    }
    const id = attributes.get('id');
    if (id && !ids.has(id)) ids.set(id, node);
    if (node.name === 'use') {
      const href = attributes.get('href') ?? attributes.get('xlink:href');
      if (!href?.startsWith('#') || href === '#') raster();
      else references.set(node, href.slice(1));
    }
    stack.push(node);
  };
  xml.onclosetag = () => { stack.pop(); };
  xml.ontext = text => {
    const node = stack[stack.length - 1];
    if (node && text.trim()) node.text = text;
    if (!node && text.trim()) invalid();
  };
  xml.oncdata = text => {
    if (!stack.length) invalid();
    xml.ontext(text);
  };
  try {
    xml.write(svg).close();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SVG содержит')) throw error;
    invalid();
  }
  if (!root || stack.length) return invalid();
  const document = root as Element;
  for (const id of references.values()) if (!ids.has(id)) invalid();
  const pending = [{ node: document, referenced: false }];
  const visited = new Set<Element>();
  while (pending.length) {
    const { node, referenced } = pending.pop()!;
    if (node.namespace !== document.namespace || (!referenced && resourceTags.has(node.name)) || visited.has(node)) continue;
    visited.add(node);
    const required = shapes.get(node.name);
    if (required?.every(name => {
      const value = node.attributes.get(name)?.trim();
      return value && (name === 'd' || name === 'points' || parseFloat(value) > 0);
    }) || ((node.name === 'text' || node.name === 'tspan') && node.text)) return svg;
    const reference = references.get(node);
    if (reference) pending.push({ node: ids.get(reference)!, referenced: true });
    for (const child of node.children) pending.push({ node: child, referenced: false });
  }
  throw new Error('В SVG нет векторного содержимого. Проверьте видимость слоёв композиции.');
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
  return validateSvg(svg).replace(openingTags, tag => {
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
