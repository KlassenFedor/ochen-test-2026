// Russian Snowball stemming rules, expressed directly in Cyrillic.
// https://snowballstem.org/algorithms/russian/stemmer.html
const vowels = /[аеиоуыэюя]/;
const region = /[аеиоуыэюя][^аеиоуыэюя]/;
type Ending = { text: string; afterAOrYa: boolean };

function endings(unconditional: string, conditional = ''): Ending[] {
  return [
    ...unconditional.split(' ').map(text => ({ text, afterAOrYa: false })),
    ...conditional.split(' ').filter(Boolean).map(text => ({ text, afterAOrYa: true }))
  ].sort((a, b) => b.text.length - a.text.length);
}

const gerund = endings('ив ивши ившись ыв ывши ывшись', 'в вши вшись');
const adjective = endings('ее ие ые ое ими ыми ей ий ый ой ем им ым ом его ого ему ому их ых ую юю ая яя ою ею');
const participle = endings('ивш ывш ующ', 'ем нн вш ющ щ');
const verb = endings(
  'ила ыла ена ейте уйте ите или ыли ей уй ил ыл им ым ен ило ыло ено ят ует уют ит ыт ены ить ыть ишь ую ю',
  'ла на ете йте ли й л ем н ло но ет ют ны ть ешь нно'
);
const noun = endings('а ев ов ие ье е иями ями ами еи ии и ией ей ой ий й иям ям ием ем ам ом о у ах иях ях ы ь ию ью ю ия ья я');

function cut(word: string, rules: Ending[]): string | undefined {
  const ending = rules.find(rule => word.endsWith(rule.text) &&
    (!rule.afterAOrYa || /[ая]/.test(word.charAt(word.length - rule.text.length - 1))));
  return ending && word.slice(0, -ending.text.length);
}

function nextRegion(word: string, from: number): number {
  const index = word.slice(from).search(region);
  return index < 0 ? word.length : from + index + 2;
}

export function russianStem(normalized: string): string {
  if (!/^[а-я]+$/.test(normalized)) return normalized;
  const firstVowel = normalized.search(vowels);
  if (firstVowel < 0) return normalized;
  const rvStart = firstVowel + 1;
  const r2Start = nextRegion(normalized, nextRegion(normalized, 0));
  const prefix = normalized.slice(0, rvStart);
  let rv = normalized.slice(rvStart);
  const perfective = cut(rv, gerund);
  if (perfective !== undefined) {
    rv = perfective;
  } else {
    rv = rv.replace(/(?:ся|сь)$/, '');
    const adjectival = cut(rv, adjective);
    rv = adjectival === undefined
      ? cut(rv, verb) ?? cut(rv, noun) ?? rv
      : cut(adjectival, participle) ?? adjectival;
  }
  rv = rv.replace(/и$/, '');
  const derivational = /ость?$/.exec(rv);
  if (derivational && rvStart + derivational.index >= r2Start) rv = rv.slice(0, derivational.index);
  if (rv.endsWith('ь')) return prefix + rv.slice(0, -1);
  return prefix + rv.replace(/ейше?$/, '').replace(/нн$/, 'н');
}
