import { describe, expect, jest, test } from '@jest/globals';
import { isCorrectGuess, isMorphologicalVariant, normalizeWord, stem, validateClue } from '../index';
import type { ClueContext, ClueRejectReason } from '../index';
import { DECK, isNoun } from '../../data/nouns';

const OPTIONS = ['cat', 'bake', 'berry', 'knife', 'mountain'];
const NOUNS = new Set(['kitten', 'oven', 'fruit', 'blade', 'hill', 'dog', 'ox', 'bakery', 'cats', 'concatenation']);

function ctx(overrides: Partial<ClueContext> = {}): ClueContext {
  return {
    options: OPTIONS,
    tried: [],
    requireDictionaryNoun: true,
    isNoun: (w) => NOUNS.has(w),
    ...overrides,
  };
}

function reasonOf(input: string, c: ClueContext = ctx()): ClueRejectReason | 'ok' {
  const r = validateClue(input, c);
  return r.ok ? 'ok' : r.reason;
}

describe('validateClue', () => {
  test('accepts a valid clue and returns it normalised', () => {
    expect(validateClue('  Kitten ', ctx())).toEqual({ ok: true, clue: 'kitten' });
    expect(validateClue('OX', ctx())).toEqual({ ok: true, clue: 'ox' });
  });

  test('every rejection carries a non-empty message', () => {
    const inputs = ['', 'two words', 'caf3', 'a', 'a'.repeat(21), 'cat', 'cats', 'baking', 'dog', 'zzzz'];
    for (const input of inputs) {
      const r = validateClue(input, ctx({ tried: ['dog'] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  });

  test('empty', () => {
    expect(reasonOf('')).toBe('empty');
    expect(reasonOf('   \t ')).toBe('empty');
  });

  test('not-single-word', () => {
    expect(reasonOf('ice cream')).toBe('not-single-word');
    expect(reasonOf('ice\tcream')).toBe('not-single-word');
  });

  test('invalid-characters', () => {
    expect(reasonOf('ice-cream')).toBe('invalid-characters');
    expect(reasonOf('caf3')).toBe('invalid-characters');
    expect(reasonOf("dog's")).toBe('invalid-characters');
    expect(reasonOf('café')).toBe('invalid-characters');
    expect(reasonOf('dog.')).toBe('invalid-characters');
  });

  test('too-short / too-long (2-20 letters allowed)', () => {
    const open = ctx({ requireDictionaryNoun: false });
    expect(reasonOf('a', open)).toBe('too-short');
    expect(reasonOf('ox', open)).toBe('ok');
    expect(reasonOf('z'.repeat(20), open)).toBe('ok');
    expect(reasonOf('z'.repeat(21), open)).toBe('too-long');
  });

  test('matches-option: equal to ANY of the five words, case-insensitively', () => {
    for (const option of OPTIONS) {
      expect(reasonOf(option)).toBe('matches-option');
      expect(reasonOf(` ${option.toUpperCase()} `)).toBe('matches-option');
    }
    expect(reasonOf('cat', ctx({ options: ['Dog', ' CAT '] }))).toBe('matches-option');
  });

  test('contains-option: contains or is contained in an option', () => {
    expect(reasonOf('cats')).toBe('contains-option'); // plural, caught by containment
    expect(reasonOf('concatenation')).toBe('contains-option');
    expect(reasonOf('bakery')).toBe('contains-option');
    expect(reasonOf('mount')).toBe('contains-option'); // contained in "mountain"
    expect(reasonOf('at')).toBe('contains-option'); // contained in "cat"
    expect(reasonOf('mountains')).toBe('contains-option');
  });

  test('variant-of-option: morphological variants that are not substrings', () => {
    const open = ctx({ requireDictionaryNoun: false });
    expect(reasonOf('baking', open)).toBe('variant-of-option');
    expect(reasonOf('baker', open)).toBe('contains-option');
    expect(reasonOf('baked', open)).toBe('contains-option');
    expect(reasonOf('bakers', open)).toBe('contains-option');
    expect(reasonOf('berries', open)).toBe('variant-of-option');
    expect(reasonOf('knives', open)).toBe('variant-of-option');
    expect(reasonOf('running', ctx({ options: ['run'], requireDictionaryNoun: false }))).toBe('contains-option');
    expect(reasonOf('run', ctx({ options: ['running'], requireDictionaryNoun: false }))).toBe('contains-option');
    expect(reasonOf('swimmer', ctx({ options: ['swimming'], requireDictionaryNoun: false }))).toBe('variant-of-option');
    expect(reasonOf('boxes', ctx({ options: ['boxing'], requireDictionaryNoun: false }))).toBe('variant-of-option');
    expect(reasonOf('city', ctx({ options: ['cities'], requireDictionaryNoun: false }))).toBe('variant-of-option');
  });

  test('already-tried (accepted or rejected clues of the turn)', () => {
    expect(reasonOf('kitten', ctx({ tried: ['oven', 'kitten'] }))).toBe('already-tried');
    expect(reasonOf(' KITTEN ', ctx({ tried: ['Kitten'] }))).toBe('already-tried');
    expect(reasonOf('kitten', ctx({ tried: ['oven'] }))).toBe('ok');
  });

  test('not-a-noun only when requireDictionaryNoun is true', () => {
    expect(reasonOf('quickly')).toBe('not-a-noun');
    expect(reasonOf('quickly', ctx({ requireDictionaryNoun: false }))).toBe('ok');
    const spy = jest.fn((_w: string) => true);
    expect(reasonOf('quickly', ctx({ requireDictionaryNoun: false, isNoun: spy }))).toBe('ok');
    expect(spy).not.toHaveBeenCalled();
    expect(reasonOf('Quickly ', ctx({ isNoun: spy }))).toBe('ok');
    expect(spy).toHaveBeenCalledWith('quickly');
  });

  test('checks run in a fixed order', () => {
    // format before options
    expect(reasonOf('cat dog')).toBe('not-single-word');
    expect(reasonOf('cat1')).toBe('invalid-characters');
    // option rules before already-tried and dictionary
    expect(reasonOf('cat', ctx({ tried: ['cat'] }))).toBe('matches-option');
    expect(reasonOf('cats', ctx({ tried: ['cats'] }))).toBe('contains-option');
    // already-tried before dictionary
    expect(reasonOf('zzzz', ctx({ tried: ['zzzz'] }))).toBe('already-tried');
  });

  test('unrelated words are not flagged as variants', () => {
    const open = ctx({ requireDictionaryNoun: false });
    for (const clue of ['kitten', 'oven', 'fruit', 'blade', 'hill', 'beer', 'bike', 'king', 'ring', 'bus']) {
      expect(reasonOf(clue, open)).toBe('ok');
    }
  });

  test('works with the bundled dictionary and deck', () => {
    expect(DECK.length).toBeGreaterThan(500);
    expect(new Set(DECK).size).toBe(DECK.length);
    expect(DECK.every((w) => /^[a-z]+$/.test(w))).toBe(true);
    expect(isNoun('kitten')).toBe(true);
    expect(isNoun('  Kitten ')).toBe(true);
    expect(isNoun('qwertyzz')).toBe(false);
    expect(isNoun('')).toBe(false);
    const real = { options: OPTIONS, tried: [], requireDictionaryNoun: true, isNoun };
    expect(validateClue('kitten', real)).toEqual({ ok: true, clue: 'kitten' });
    expect(reasonOf('qwertyzz', real)).toBe('not-a-noun');
  });
});

describe('stem / isMorphologicalVariant', () => {
  test('simple suffixes share a stem', () => {
    const groups = [
      ['bake', 'bakes', 'baked', 'baking', 'baker', 'bakers'],
      ['run', 'runs', 'running', 'runner', 'runners'],
      ['berry', 'berries'],
      ['knife', 'knives'],
      ['box', 'boxes', 'boxed', 'boxing', 'boxer'],
      ['tree', 'trees'],
      ['glass', 'glasses'],
      ['paint', 'paints', 'painted', 'painting', 'painter', 'paintings', 'painters'],
      ['baker', 'baking'],
      ['swimmer', 'swimming'],
      ['boxes', 'boxing'],
      ['city', 'cities'],
      ['elf', 'elves'],
      ['fly', 'flies', 'flier', 'fliers'],
      ['ice', 'icing', 'iced'],
      ['carry', 'carried', 'carrier', 'carriers', 'carries'],
      ['copy', 'copier', 'copied'],
      ['study', 'studied'],
    ];
    for (const group of groups) {
      for (const w of group) {
        expect([w, isMorphologicalVariant(w, group[0])]).toEqual([w, true]);
        expect([w, isMorphologicalVariant(group[0], w)]).toEqual([w, true]);
      }
    }
  });

  test('y-to-i and short-stem inflections of an offered word are rejected', () => {
    const cases: [clue: string, option: string][] = [
      ['flier', 'fly'],
      ['icing', 'ice'],
      ['carrier', 'carry'],
      ['carried', 'carry'],
      ['copier', 'copy'],
      ['studied', 'study'],
      ['cities', 'city'],
    ];
    for (const [clue, option] of cases) {
      const r = validateClue(clue, { options: [option], tried: [], requireDictionaryNoun: false, isNoun: () => true });
      expect([clue, option, r.ok ? 'ok' : r.reason]).toEqual([clue, option, 'variant-of-option']);
    }
    // Reachable with the real deck and dictionary.
    expect(DECK).toEqual(expect.arrayContaining(['fly', 'ice']));
    const real = (clue: string, option: string) =>
      validateClue(clue, { options: [option], tried: [], requireDictionaryNoun: true, isNoun });
    expect(real('flier', 'fly')).toMatchObject({ ok: false, reason: 'variant-of-option' });
    expect(real('icing', 'ice')).toMatchObject({ ok: false, reason: 'variant-of-option' });
  });

  test('unrelated lookalike nouns are not variants', () => {
    const pairs: [string, string][] = [
      ['water', 'watt'],
      ['cheese', 'chess'],
      ['cheese', 'cheer'],
      ['mouse', 'mousse'],
      ['mouse', 'moue'],
      ['statue', 'status'],
      ['tree', 'tress'],
      ['string', 'stress'],
      ['purse', 'purr'],
      ['purse', 'puree'],
      ['coffee', 'coffer'],
      ['pill', 'pile'],
      ['ball', 'bale'],
      ['doll', 'dole'],
      ['wall', 'wale'],
      ['mule', 'mull'],
      ['hammer', 'hame'],
      ['copper', 'cope'],
      ['copper', 'copse'],
      ['brass', 'brae'],
      ['burger', 'burgess'],
      ['drawer', 'drawee'],
      ['lightning', 'lightness'],
      ['flute', 'flutter'],
      ['hole', 'holler'],
      ['bee', 'being'],
      ['sky', 'skiing'],
      ['pie', 'pier'],
      ['tie', 'tier'],
      ['deer', 'deed'],
      ['seed', 'seer'],
      ['sled', 'sling'],
    ];
    for (const [option, clue] of pairs) {
      expect([option, clue, isMorphologicalVariant(option, clue)]).toEqual([option, clue, false]);
      expect([option, clue, isMorphologicalVariant(clue, option)]).toEqual([option, clue, false]);
    }
    // The giver scenario from the bug report: "watt" while "water" is on offer.
    expect(
      validateClue('watt', { options: ['water', 'tree', 'cheese'], tried: [], requireDictionaryNoun: true, isNoun }),
    ).toEqual({ ok: true, clue: 'watt' });
  });

  test('stem strips a single suffix layer only', () => {
    expect(stem('baking')).toBe('bak');
    expect(stem('running')).toBe('run');
    expect(stem('berries')).toBe('berry');
    expect(stem('boxes')).toBe('box');
    expect(stem('cheese')).toBe('cheese');
    expect(stem('watt')).toBe('watt');
    expect(stem('ball')).toBe('ball');
  });

  test('short words are left alone and different words differ', () => {
    expect(stem('bus')).toBe('bus');
    expect(stem('bed')).toBe('bed');
    expect(stem('king')).toBe('king');
    expect(isMorphologicalVariant('cat', 'dog')).toBe(false);
    expect(isMorphologicalVariant('bake', 'bike')).toBe(false);
    expect(isMorphologicalVariant('', '')).toBe(false);
    expect(isMorphologicalVariant(' Cat', 'cat ')).toBe(true);
  });

  test('normalizeWord', () => {
    expect(normalizeWord('  HeLLo \n')).toBe('hello');
  });
});

describe('isCorrectGuess', () => {
  test('exact match after trim + lower-case', () => {
    expect(isCorrectGuess('cat', 'cat')).toBe(true);
    expect(isCorrectGuess('  CaT \n', 'cat')).toBe(true);
    expect(isCorrectGuess('cat', ' CAT ')).toBe(true);
  });

  test('trivial plural either way', () => {
    expect(isCorrectGuess('cats', 'cat')).toBe(true);
    expect(isCorrectGuess('cat', 'cats')).toBe(true);
    expect(isCorrectGuess(' Cats', 'cat')).toBe(true);
  });

  test('anything else is wrong', () => {
    expect(isCorrectGuess('dog', 'cat')).toBe(false);
    expect(isCorrectGuess('catss', 'cat')).toBe(false);
    expect(isCorrectGuess('boxes', 'box')).toBe(false); // only the bare +s plural is accepted
    expect(isCorrectGuess('berries', 'berry')).toBe(false);
    expect(isCorrectGuess('scat', 'cat')).toBe(false);
    expect(isCorrectGuess('ca', 'cat')).toBe(false);
    expect(isCorrectGuess('c at', 'cat')).toBe(false);
    expect(isCorrectGuess('kitten', 'cat')).toBe(false);
  });

  test('empty input never matches', () => {
    expect(isCorrectGuess('', 'cat')).toBe(false);
    expect(isCorrectGuess('   ', 'cat')).toBe(false);
    expect(isCorrectGuess('', '')).toBe(false);
    expect(isCorrectGuess('s', '')).toBe(false);
    expect(isCorrectGuess('', 's')).toBe(false);
  });
});
