import { parser } from 'sax';

const svgNamespace = 'http://www.w3.org/2000/svg';
const xlinkNamespace = 'http://www.w3.org/1999/xlink';
const resourceTags = new Set(['defs', 'clipPath', 'mask', 'marker', 'pattern', 'filter', 'symbol']);
const shapes = new Map([
  ['path', ['d']], ['rect', ['width', 'height']], ['circle', ['r']], ['ellipse', ['rx', 'ry']],
  ['polygon', ['points']], ['polyline', ['points']], ['line', []]
]);
const openingTags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^\s!?/<>]+(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
type Element = {
  name: string; qualifiedName: string; namespace: string; attributes: Map<string, string>; rawAttributes: Map<string, string>;
  children: Element[]; text?: string; start: number; openEnd: number; closeStart: number; end: number;
};

function parseSvg(svg: string) {
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
  const elements: Element[] = [];
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
    const node: Element = {
      name: tag.local, qualifiedName: tag.name, namespace: tag.uri, attributes,
      rawAttributes: new Map(Object.values(tag.attributes).map(attr => [attr.name, attr.value])),
      children: [], start: xml.startTagPosition - 1, openEnd: xml.position, closeStart: xml.position, end: xml.position
    };
    elements.push(node);
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
  xml.onclosetag = () => {
    const node = stack.pop()!;
    node.end = xml.position;
    node.closeStart = node.openEnd === node.end ? node.end : xml.startTagPosition - 1;
  };
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
    }) || ((node.name === 'text' || node.name === 'tspan') && node.text)) return { root: document, elements, ids };
    const reference = references.get(node);
    if (reference) pending.push({ node: ids.get(reference)!, referenced: true });
    for (const child of node.children) pending.push({ node: child, referenced: false });
  }
  throw new Error('В SVG нет векторного содержимого. Проверьте видимость слоёв композиции.');
}

export function validateSvg(svg: string): string {
  parseSvg(svg);
  return svg;
}

function decodeSvg(bytes: Uint8Array): string {
  // The Figma plugin sandbox has no TextDecoder.
  let raw = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  try {
    return raw.replace(/[\x80-\xFF]+/g, run => decodeURIComponent(
      Array.from(run, byte => '%' + byte.charCodeAt(0).toString(16)).join('')
    )).replace(/^\uFEFF/, '');
  } catch {
    throw new Error('Figma вернула SVG с некорректной кодировкой UTF-8.');
  }
}

const cyrillic = new Map(
  Array.from('абвгдеёжзийклмнопрстуфхцчшщъыьэюя').map((letter, i) => [
    letter, 'a b v g d e yo zh z i y k l m n o p r s t u f kh ts ch sh shch _ y _ e yu ya'.split(' ')[i]!
  ])
);
const asciiId = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
function layerId(name: string): string {
  const latin = name.replace(/[а-яё]/gi, char => {
    const letter = cyrillic.get(char.toLowerCase())!;
    if (letter === '_') return '';
    return char === char.toUpperCase() ? letter[0]!.toUpperCase() + letter.slice(1) : letter;
  }).normalize('NFKD').replace(/\p{M}/gu, '');
  const slug = latin.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  return !slug ? 'Layer' : asciiId.test(slug) ? slug : `Layer-${slug}`;
}

function allocateIds(elements: Element[]) {
  const used = new Set<string>();
  const byNode = new Map<Element, string>();
  const bySource = new Map<string, string>();
  function reserve(base: string) {
    let id = base;
    for (let index = 2; used.has(id); index++) id = `${base}-${index}`;
    used.add(id);
    return id;
  }

  // Reserve native resource IDs first. References stay stable even if a
  // transliterated layer name happens to equal a clip or gradient ID.
  for (const node of elements) {
    const id = node.attributes.get('id');
    if (id && asciiId.test(id)) used.add(id);
  }
  for (const node of elements) {
    const original = node.attributes.get('id');
    if (original === undefined) continue;
    const id = asciiId.test(original) && !bySource.has(original) ? original : reserve(layerId(original));
    byNode.set(node, id);
    if (!bySource.has(original)) bySource.set(original, id);
  }
  return { byNode, bySource, reserve };
}

const localUrl = /url\(\s*(['"]?)#([^)'"]+)\1\s*\)/g;
const attributeValue = /([^\s=<>]+)(\s*=\s*)(?:"[^"]*"|'[^']*')/g;
const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const nonVisual = new Set([...resourceTags, 'title', 'desc', 'metadata', 'style']);
const visibleChildren = (node: Element) => node.children.filter(child => !nonVisual.has(child.name));

export type SvgFrame = {
  name: string; width: number; height: number; inside: ReadonlySet<string>;
};

function matchesCanvas(node: Element, frame: SvgFrame) {
  return node.name === 'rect' && Number(node.attributes.get('x') ?? 0) === 0 &&
    Number(node.attributes.get('y') ?? 0) === 0 &&
    Number(node.attributes.get('width')) === frame.width && Number(node.attributes.get('height')) === frame.height &&
    !node.attributes.has('transform');
}

function frameWrapper(node: Element, frame: SvgFrame) {
  const name = node.attributes.get('id');
  return node.name === 'g' && !!name && layerId(name) === layerId(frame.name) && node.attributes.size === 1;
}

function canvasClip(root: Element, ids: Map<string, Element>, frame?: SvgFrame) {
  if (!frame) return;
  let layers = visibleChildren(root);
  const shell = layers.length === 1 && frameWrapper(layers[0]!, frame) ? layers[0] : undefined;
  if (shell) layers = visibleChildren(shell);
  const candidates = layers.filter(node => node.name === 'g' && node.attributes.has('clip-path'));
  const [container] = candidates;
  if (!container || candidates.length !== 1 || layers.some(node => node !== container && !matchesCanvas(node, frame)) ||
      [...container.attributes.keys()].some(name => name !== 'id' && name !== 'clip-path')) return;
  const match = /^url\(\s*(['"]?)#([^)'"]+)\1\s*\)$/.exec(container.attributes.get('clip-path') ?? '');
  if (!match) return;
  const clip = ids.get(match[2]!.trim());
  if (!clip || clip.name !== 'clipPath' || clip.attributes.has('transform') ||
      (clip.attributes.get('clipPathUnits') ?? 'userSpaceOnUse') !== 'userSpaceOnUse') return;
  const viewport = root.attributes.get('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewport && (viewport.length !== 4 || viewport[0] !== 0 || viewport[1] !== 0 ||
      viewport[2] !== frame.width || viewport[3] !== frame.height)) return;
  const [rect] = clip.children;
  // A rounded or authored mask can blend overlapping artwork at the edge as
  // one group. Preserve that mask and its original compositing order.
  if (!rect || clip.children.length !== 1 || !matchesCanvas(rect, frame) ||
      Number(rect.attributes.get('rx') ?? 0) || Number(rect.attributes.get('ry') ?? 0) ||
      rect.attributes.has('clip-path') || rect.attributes.has('style')) return;
  return { shell, container, clip, frame };
}

export function prepareSvgExport(bytes: Uint8Array, frame?: SvgFrame): string {
  const svg = decodeSvg(bytes);
  const { root, elements, ids } = parseSvg(svg);
  const { byNode, bySource, reserve } = allocateIds(elements);
  const candidate = elements.some(node => node.name === 'style') ? undefined : canvasClip(root, ids, frame);
  function hasReferences(node: Element): boolean {
    const id = node.attributes.get('id');
    return !!id && elements.some(element => [...element.rawAttributes].some(([key, value]) =>
      ((key === 'href' || key.endsWith(':href')) && value === '#' + id) ||
      [...value.matchAll(localUrl)].some(match => match[2]?.trim() === id)));
  }
  const originalClip = candidate && (hasReferences(candidate.container) ||
    (candidate.shell && hasReferences(candidate.shell))) ? undefined : candidate;
  function findId(source: string) {
    if (bySource.has(source)) return bySource.get(source);
    try { return bySource.get(decodeURIComponent(source)); } catch { return undefined; }
  }
  function rewriteUrls(value: string) {
    return value.replace(localUrl, (url, quote: string, reference: string) => {
      const id = findId(reference.trim());
      return id && id !== reference ? `url(${quote}#${id}${quote})` : url;
    });
  }
  function opening(node: Element) {
    return svg.slice(node.start, node.openEnd).replace(attributeValue, (attribute, key: string, equals: string) => {
      const value = node.rawAttributes.get(key);
      if (value === undefined) return attribute;
      let next = rewriteUrls(value);
      if (key === 'id') next = byNode.get(node)!;
      else if (key === 'data-name' || key === 'inkscape:label') next = layerId(value);
      else if ((key === 'href' || key.endsWith(':href')) && value.startsWith('#')) {
        const id = findId(value.slice(1));
        if (id) next = '#' + id;
      } else if (key === 'aria-labelledby' || key === 'aria-describedby') {
        next = value.replace(/\S+/g, id => findId(id) ?? id);
      }
      return next === value ? attribute : `${key}${equals}"${escapeAttribute(next)}"`;
    });
  }
  function content(node: Element, renderChild: (child: Element) => string): string {
    let position = node.openEnd;
    const pieces: string[] = [];
    for (const child of node.children) {
      pieces.push(svg.slice(position, child.start), renderChild(child));
      position = child.end;
    }
    return pieces.join('') + svg.slice(position, node.closeStart);
  }
  function render(node: Element): string {
    const body = content(node, render);
    const markup = node.name === 'style' ? rewriteUrls(body).replace(/([^{}]*)\{/g, (match, selector: string) => {
      const renamed = selector.replace(/#([\p{L}\p{N}_-]+)/gu, (reference, id: string) => {
        const next = findId(id);
        return next ? '#' + next : reference;
      });
      return renamed + match.slice(selector.length);
    }) : body;
    return opening(node) + markup + svg.slice(node.closeStart, node.end);
  }
  function splitLayers(boundary: NonNullable<typeof originalClip>) {
    const group = root.qualifiedName.slice(0, -3) + 'g';
    const clipId = byNode.get(boundary.clip);
    const renderLayer = (node: Element): string => {
      if (nonVisual.has(node.name)) return render(node);
      const name = node.attributes.get('id');
      const sceneWrapper = frameWrapper(node, boundary.frame) && node.children.length > 1 && !hasReferences(node);
      if (sceneWrapper) return content(node, renderLayer);
      const rectInside = matchesCanvas(node, boundary.frame) && !node.attributes.has('stroke') &&
        !node.attributes.has('style') && !node.attributes.has('filter');
      if (rectInside || (name && boundary.frame.inside.has(name))) return render(node);
      const label = reserve(`${byNode.get(node) ?? 'Layer'}-crop`);
      return `<${group} id="${label}"><${group} clip-path="url(#${clipId})">${render(node)}</${group}></${group}>`;
    };
    return content(boundary.container, renderLayer);
  }
  function renderRootChild(node: Element): string {
    if (node === originalClip?.container) return splitLayers(originalClip);
    if (node === originalClip?.shell) return content(node, renderRootChild);
    return render(node);
  }
  const rewritten = originalClip
    ? opening(root) + content(root, renderRootChild) + svg.slice(root.closeStart, root.end)
    : render(root);
  return svg.slice(0, root.start) + rewritten + svg.slice(root.end);
}

export function svgFilename(name: string): string {
  const base = name.replace(/[^\p{L}\p{N}\s_-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 80);
  return `${base || 'illustration'}.svg`;
}
