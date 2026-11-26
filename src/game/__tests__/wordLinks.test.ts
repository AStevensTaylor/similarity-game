import { describe, expect, test } from '@jest/globals';

import {
  DEFAULT_SETTINGS,
  cluePasses,
  copyLink,
  createGame,
  gameReducer,
  isWordLink,
  sanitizeSettings,
  type GameSettings,
  type GameState,
  type WordLink,
} from '../index';

const DECK: readonly string[] = ['tree', 'river', 'candle', 'garden', 'pencil', 'window', 'bottle', 'ladder', 'mirror', 'pocket'];

function clueState(overrides: Partial<GameSettings> = {}): GameState {
  let s = createGame(['Ann', 'Bob'], { ...DEFAULT_SETTINGS, ...overrides }, DECK, 99);
  s = gameReducer(s, { type: 'REVEAL' }, DECK);
  s = gameReducer(s, { type: 'CHOOSE_WORD', word: s.options[0] }, DECK);
  expect(s.phase).toBe('clue');
  return s;
}

const linkTo = (s: GameState, clue: string, relation: WordLink['relation'] = 'part'): WordLink => ({
  relation,
  from: clue,
  to: s.hiddenWord!,
  sources: ['conceptnet'],
});

describe('isWordLink', () => {
  test('accepts well-formed links only', () => {
    expect(isWordLink({ relation: 'part', from: 'root', to: 'tree', sources: ['wordnet', 'conceptnet'] })).toBe(true);
    expect(isWordLink(null)).toBe(false);
    expect(isWordLink({ relation: 'nonsense', from: 'root', to: 'tree', sources: ['wordnet'] })).toBe(false);
    expect(isWordLink({ relation: 'part', from: 'root', to: 'root', sources: ['wordnet'] })).toBe(false);
    expect(isWordLink({ relation: 'part', from: '', to: 'tree', sources: ['wordnet'] })).toBe(false);
    expect(isWordLink({ relation: 'part', from: 'root', to: 'tree', sources: [] })).toBe(false);
    expect(isWordLink({ relation: 'part', from: 'root', to: 'tree', sources: ['google'] })).toBe(false);
    expect(isWordLink({ relation: 'part', from: 'root', to: 'tree', sources: ['wordnet', 'wordnet', 'wordnet'] })).toBe(false);
    expect(isWordLink({ relation: 'part', from: 'root', to: 'tree', sources: ['wordnet', 'wordnet'] })).toBe(false);
  });

  test('copyLink does not share the sources array', () => {
    const link: WordLink = { relation: 'kind', from: 'oak', to: 'tree', sources: ['wordnet'] };
    const copy = copyLink(link);
    expect(copy).toEqual(link);
    expect(copy.sources).not.toBe(link.sources);
  });
});

describe('cluePasses', () => {
  const link: WordLink = { relation: 'part', from: 'root', to: 'tree', sources: ['conceptnet'] };
  test('a score at the threshold passes with or without a link', () => {
    expect(cluePasses(DEFAULT_SETTINGS, 0.95, null)).toBe(true);
    expect(cluePasses({ ...DEFAULT_SETTINGS, useWordLinks: false }, 0.95, link)).toBe(true);
  });
  test('below the threshold only a valid link with word links on passes', () => {
    expect(cluePasses(DEFAULT_SETTINGS, 0.948, null)).toBe(false);
    expect(cluePasses(DEFAULT_SETTINGS, 0.948, link)).toBe(true);
    expect(cluePasses({ ...DEFAULT_SETTINGS, useWordLinks: false }, 0.948, link)).toBe(false);
    expect(cluePasses(DEFAULT_SETTINGS, 0.948, { ...link, relation: 'bogus' } as unknown as WordLink)).toBe(false);
  });
});

describe('settings', () => {
  test('word links default to on, also for settings saved before the option existed', () => {
    expect(DEFAULT_SETTINGS.useWordLinks).toBe(true);
    const old = { turnsPerPlayer: 2, threshold: 0.9, guessMode: 'open', requireDictionaryNoun: true } as unknown as GameSettings;
    expect(sanitizeSettings(old).useWordLinks).toBe(true);
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, useWordLinks: false }).useWordLinks).toBe(false);
  });
});

describe('CLUE_ACCEPTED with a word link', () => {
  test('a linked clue below the threshold is accepted and remembers its link', () => {
    const s = clueState();
    const link = linkTo(s, 'root');
    const next = gameReducer(s, { type: 'CLUE_ACCEPTED', clue: ' Root ', score: 0.948, link }, DECK);
    expect(next.phase).toBe('handoff-guesser');
    expect(next.acceptedClues).toEqual([{ clue: 'root', score: 0.948, link }]);
    expect(next.acceptedClues[0]!.link).not.toBe(link); // copied, not shared
  });

  test('the link may name the words in either order', () => {
    const s = clueState();
    const link: WordLink = { relation: 'part', from: s.hiddenWord!, to: 'root', sources: ['wordnet'] };
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'root', score: 0.6, link }, DECK).phase).toBe('handoff-guesser');
  });

  test('it is refused when word links are off', () => {
    const s = clueState({ useWordLinks: false });
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'root', score: 0.948, link: linkTo(s, 'root') }, DECK)).toBe(s);
  });

  test('a link between other words, or a malformed link, does not count', () => {
    const s = clueState();
    const other: WordLink = { relation: 'part', from: 'root', to: 'flower', sources: ['wordnet'] };
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'root', score: 0.9, link: other }, DECK)).toBe(s);
    const wrongClue = linkTo(s, 'branch');
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'root', score: 0.9, link: wrongClue }, DECK)).toBe(s);
    // The clue being the hidden word itself cannot borrow a link to some third word.
    const self: WordLink = { relation: 'part', from: s.hiddenWord!, to: 'zzz', sources: ['wordnet'] };
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: s.hiddenWord!, score: 0.1, link: self }, DECK)).toBe(s);
    const bad = { relation: 'part', from: 'root', to: s.hiddenWord, sources: 'wordnet' } as unknown as WordLink;
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'root', score: 0.9, link: bad }, DECK)).toBe(s);
  });

  test('a clue that reaches the threshold is stored without a link', () => {
    const s = clueState();
    const next = gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'root', score: 0.97, link: linkTo(s, 'root') }, DECK);
    expect(next.acceptedClues).toEqual([{ clue: 'root', score: 0.97 }]);
  });

  test('the round record and the turn summary keep the link', () => {
    let s = clueState();
    const link = linkTo(s, 'root');
    s = gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'root', score: 0.948, link }, DECK);
    s = gameReducer(s, { type: 'REVEAL' }, DECK);
    s = gameReducer(s, { type: 'SUBMIT_GUESS', guess: s.hiddenWord! }, DECK);
    expect(s.phase).toBe('round-result');
    expect(s.rounds[0]).toMatchObject({ clue: 'root', score: 0.948, link });
    s = gameReducer(s, { type: 'NEXT' }, DECK);
    expect(s.turnSummary?.clues).toEqual([{ clue: 'root', score: 0.948, link }]);
    // Plain JSON: survives a round trip unchanged.
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  test('CLUE_REJECTED below the threshold is still allowed (the scorer found no usable link)', () => {
    const s = clueState();
    const next = gameReducer(s, { type: 'CLUE_REJECTED', clue: 'root', score: 0.948 }, DECK);
    expect(next.rejectedThisRound).toEqual([{ clue: 'root', score: 0.948 }]);
  });
});
