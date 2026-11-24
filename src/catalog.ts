import data from '../data/catalog.json';
import themes from '../data/themes.json';
import wordFamilies from '../data/word-families.json';
import wordForms from '../data/word-forms.json';
import { russianStem } from './russian-stem';

export const catalog = data;
export const names = catalog.map(item => item.name).join(', ');
export type Role = 'main' | 'background';
export type Item = { id: string; role: Role };
export const maxSceneItems = 24;

export function checkItemCount(count: number) {
  if (count > maxSceneItems) throw new Error(`В одной композиции может быть до ${maxSceneItems} предметов. Разделите список или удалите лишние предметы.`);
}

export function normalize(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const aliases = new Map<string, string>();
for (const item of catalog) {
  for (const word of [item.name, ...item.aliases]) {
    const key = normalize(word);
    const prior = aliases.get(key);
    if (prior && prior !== item.id) throw new Error(`Неоднозначный синоним: ${word}`);
    aliases.set(key, item.id);
  }
}

export function itemName(id: string): string {
  const item = catalog.find(entry => entry.id === id);
  if (!item) throw new Error(`Предмет «${id}» отсутствует в каталоге.`);
  return item.name;
}

export function parseNames(query: string): Item[] {
  const entries = query.split(',').map(word => word.trim());
  checkItemCount(entries.length);
  const unknown = entries.filter(word => !aliases.has(normalize(word)));
  if (unknown.length) {
    throw new Error(`Не распознано: ${unknown.map(word => word ? `«${word}»` : 'пустая позиция').join(', ')}. Предметы: ${names}.`);
  }
  return entries.map(word => ({ id: aliases.get(normalize(word))!, role: 'main' }));
}

const familyByStem = new Map<string, string>();
const stemOverrides = new Map(Object.entries(wordForms));
const wordStem = (word: string) => stemOverrides.get(word) ?? russianStem(word);
for (const [family, forms] of Object.entries(wordFamilies)) {
  for (const form of [family, ...forms]) {
    const stem = wordStem(normalize(form));
    const earlier = familyByStem.get(stem);
    if (earlier && earlier !== family) throw new Error(`Неоднозначная группа слов: ${form}`);
    familyByStem.set(stem, family);
  }
}

function tokens(text: string) {
  return normalize(text).split(' ').filter(Boolean).map(word => {
    const stem = wordStem(word);
    return { word, stem, family: familyByStem.get(stem) };
  });
}

type Token = ReturnType<typeof tokens>[number];
type Match = { length: number; quality: number; literal: boolean };

const titleTerms = [
  ...[...aliases].map(([term, id]) => ({ tokens: tokens(term), items: [id], literal: true })),
  ...themes.flatMap(({ terms, items }) => terms.map(term => ({ tokens: tokens(term), items, literal: false })))
].filter(term => term.tokens.length > 0);

function tokenMatch(query: Token, term: Token): number {
  if (query.word === term.word) return 3;
  if (query.stem.length >= 3 && query.stem === term.stem) return 2;
  if (query.family && query.family === term.family) return 1;
  return 0;
}

function phraseMatch(query: Token[], term: Token[]): number {
  let best = 0;
  for (let start = 0; start <= query.length - term.length; start++) {
    let weakest = 3;
    for (const [offset, token] of term.entries()) {
      weakest = Math.min(weakest, tokenMatch(query[start + offset]!, token));
      if (!weakest) break;
    }
    if (weakest === 3) return weakest;
    best = Math.max(best, weakest);
  }
  return best;
}

function compareMatch(a: Match, b: Match): number {
  return a.length - b.length || a.quality - b.quality || Number(a.literal) - Number(b.literal);
}

export function suggestItems(query: string): Item[] {
  const input = tokens(query);
  const scores = new Map<string, Match>();
  for (const term of titleTerms) {
    const quality = phraseMatch(input, term.tokens);
    if (!quality) continue;
    const match = { length: term.tokens.length, quality, literal: term.literal };
    for (const id of term.items) {
      const previous = scores.get(id);
      if (!previous || compareMatch(match, previous) > 0) scores.set(id, match);
    }
  }
  const result = catalog.flatMap(({ id }) => {
    const score = scores.get(id);
    return score ? [{ id, score }] : [];
  }).sort((a, b) => compareMatch(b.score, a.score)).slice(0, 3)
    .map<Item>(({ id }, i) => ({ id, role: i === 0 ? 'main' : 'background' }));
  if (!result.length) throw new Error(`Подходящих предметов не найдено. Уточните заголовок или выберите названия из списка: ${names}.`);
  return result;
}
