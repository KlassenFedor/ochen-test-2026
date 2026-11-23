import data from '../data/catalog.json';
import themes from '../data/themes.json';

export const catalog = data;
export const names = catalog.map(item => item.name).join(', ');
export type Role = 'main' | 'background';
export type Item = { id: string; role: Role };

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
  const unknown = entries.filter(word => !aliases.has(normalize(word)));
  if (unknown.length) {
    throw new Error(`Не распознано: ${unknown.map(word => word ? `«${word}»` : 'пустая позиция').join(', ')}. Предметы: ${names}.`);
  }
  return entries.map(word => ({ id: aliases.get(normalize(word))!, role: 'main' }));
}

export function suggestItems(query: string): Item[] {
  const text = ` ${normalize(query)} `;
  const scores = new Map<string, number>();
  for (const [term, id] of aliases) {
    if (text.includes(` ${term} `)) scores.set(id, Math.max(scores.get(id) ?? 0, 3));
  }
  for (const theme of themes) {
    const weight = Math.max(0, ...theme.terms.map(term => {
      const words = normalize(term);
      return text.includes(` ${words} `) ? 2 ** words.split(' ').length : 0;
    }));
    if (weight) for (const id of theme.items) scores.set(id, Math.max(scores.get(id) ?? 0, weight));
  }
  const result = catalog.map(item => ({ id: item.id, score: scores.get(item.id) ?? 0 }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 3)
    .map<Item>(({ id }, i) => ({ id, role: i === 0 ? 'main' : 'background' }));
  if (!result.length) throw new Error(`Подходящих предметов не найдено. Уточните заголовок или выберите названия из списка: ${names}.`);
  return result;
}
