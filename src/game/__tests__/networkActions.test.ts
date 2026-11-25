import { describe, expect, test } from '@jest/globals';
import { DEFAULT_SETTINGS, createGame, gameReducer } from '../index';
import type { GameAction, GameSettings, GameState } from '../index';

/** Tests for the two engine actions added for network play: SKIP_GUESS and ABANDON_TURN. */

const DECK: readonly string[] = Array.from({ length: 40 }, (_, i) => `w${String.fromCharCode(97 + (i % 26))}${i < 26 ? 'a' : 'b'}x`);

function run(state: GameState, actions: GameAction[]): GameState {
  return actions.reduce((s, a) => gameReducer(s, a, DECK), state);
}

function inGuess(overrides: Partial<GameSettings> = {}, names = ['Ann', 'Bob', 'Cy']): GameState {
  const s = createGame(names, { ...DEFAULT_SETTINGS, ...overrides }, DECK, 7);
  return run(s, [
    { type: 'REVEAL' },
    { type: 'CHOOSE_WORD', word: s.options[0] },
    { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.99 },
    { type: 'REVEAL' },
  ]);
}

describe('SKIP_GUESS', () => {
  test.each(['open', 'list'] as const)('%s mode: records a blank wrong guess and moves to the next guesser', (guessMode) => {
    const s = inGuess({ guessMode });
    expect(s.phase).toBe('guess');
    const next = gameReducer(s, { type: 'SKIP_GUESS' }, DECK);
    expect(next.phase).toBe('handoff-guesser');
    expect(next.guesserPos).toBe(1);
    expect(next.guesses).toEqual([{ playerId: 'p2', guess: '', correct: false, skipped: true }]);
  });

  test('a skip as the last guess resolves the round; an all-skipped round pays the giver like a failed round', () => {
    const s = run(inGuess(), [{ type: 'SKIP_GUESS' }, { type: 'REVEAL' }, { type: 'SKIP_GUESS' }]);
    expect(s.phase).toBe('round-result');
    expect(s.rounds[0].anyCorrect).toBe(false);
    expect(s.rounds[0].giverPointsAwarded).toBe(1);
    expect(s.players.map((p) => p.score)).toEqual([1, 0, 0]);
  });

  test('a skip next to a correct guess: only the correct guesser scores', () => {
    const start = inGuess();
    const s = run(start, [{ type: 'SKIP_GUESS' }, { type: 'REVEAL' }, { type: 'SUBMIT_GUESS', guess: start.hiddenWord! }]);
    expect(s.phase).toBe('round-result');
    expect(s.rounds[0].correctGuesserIds).toEqual(['p3']);
    expect(s.players.map((p) => p.score)).toEqual([0, 0, 1]);
    expect(s.rounds[0].guesses[0]).toEqual({ playerId: 'p2', guess: '', correct: false, skipped: true });
    expect(s.rounds[0].guesses[1]).toEqual({ playerId: 'p3', guess: start.hiddenWord, correct: true });
  });

  test('is ignored outside the guess phase and does not mutate', () => {
    const fresh = createGame(['A', 'B'], DEFAULT_SETTINGS, DECK, 1);
    const choose = gameReducer(fresh, { type: 'REVEAL' }, DECK);
    const clue = gameReducer(choose, { type: 'CHOOSE_WORD', word: choose.options[1] }, DECK);
    const handoff = gameReducer(clue, { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.99 }, DECK);
    for (const s of [fresh, choose, clue, handoff]) {
      expect(gameReducer(s, { type: 'SKIP_GUESS' }, DECK)).toBe(s);
    }
    const guess = gameReducer(handoff, { type: 'REVEAL' }, DECK);
    const before = JSON.stringify(guess);
    const resolved = gameReducer(guess, { type: 'SKIP_GUESS' }, DECK);
    expect(resolved.phase).toBe('round-result');
    expect(JSON.stringify(guess)).toBe(before);
    expect(gameReducer(resolved, { type: 'SKIP_GUESS' }, DECK)).toBe(resolved);
  });

  test('a normal guess carries no skipped key', () => {
    const s = gameReducer(inGuess(), { type: 'SUBMIT_GUESS', guess: 'nope' }, DECK);
    expect(s.guesses).toEqual([{ playerId: 'p2', guess: 'nope', correct: false }]);
    expect('skipped' in s.guesses[0]).toBe(false);
  });
});

describe('ABANDON_TURN', () => {
  test('before a word was chosen: forfeit summary with an empty hidden word, then the next turn starts', () => {
    const fresh = createGame(['A', 'B'], DEFAULT_SETTINGS, DECK, 3);
    for (const s of [fresh, gameReducer(fresh, { type: 'REVEAL' }, DECK)]) {
      const ended = gameReducer(s, { type: 'ABANDON_TURN' }, DECK);
      expect(ended.phase).toBe('turn-result');
      expect(ended.turnSummary).toEqual({
        giverId: 'p1',
        hiddenWord: '',
        outcome: 'forfeit',
        roundsPlayed: 0,
        giverPoints: 0,
        correctGuesserIds: [],
        clues: [],
      });
      const next = gameReducer(ended, { type: 'NEXT' }, DECK);
      expect(next.phase).toBe('handoff-giver');
      expect(next.giverIndex).toBe(1);
    }
  });

  test('in the clue phase without any rejections (unlike FORFEIT_TURN)', () => {
    const fresh = createGame(['A', 'B'], DEFAULT_SETTINGS, DECK, 3);
    const clue = run(fresh, [{ type: 'REVEAL' }, { type: 'CHOOSE_WORD', word: fresh.options[2] }]);
    expect(gameReducer(clue, { type: 'FORFEIT_TURN' }, DECK)).toBe(clue);
    const ended = gameReducer(clue, { type: 'ABANDON_TURN' }, DECK);
    expect(ended.phase).toBe('turn-result');
    expect(ended.turnSummary?.outcome).toBe('forfeit');
    expect(ended.turnSummary?.hiddenWord).toBe(fresh.options[2]);
  });

  test('between clue rounds: points already earned are kept', () => {
    const s = run(inGuess({}, ['A', 'B']), [{ type: 'SUBMIT_GUESS', guess: 'nope' }, { type: 'NEXT' }]);
    expect(s.phase).toBe('handoff-giver');
    const ended = gameReducer(s, { type: 'ABANDON_TURN' }, DECK);
    expect(ended.turnSummary).toMatchObject({ outcome: 'forfeit', roundsPlayed: 1, giverPoints: 1 });
    expect(ended.players[0].score).toBe(1);
  });

  test('is ignored while guesses are being collected and on result screens', () => {
    const guess = inGuess();
    const handoff = gameReducer(guess, { type: 'SUBMIT_GUESS', guess: 'nope' }, DECK);
    const result = run(handoff, [{ type: 'REVEAL' }, { type: 'SUBMIT_GUESS', guess: 'nah' }]);
    const turnResult = run(result, [{ type: 'NEXT' }, { type: 'REVEAL' }, { type: 'ABANDON_TURN' }]);
    expect(turnResult.phase).toBe('turn-result');
    for (const s of [guess, handoff, result, turnResult]) {
      expect(gameReducer(s, { type: 'ABANDON_TURN' }, DECK)).toBe(s);
    }
  });
});
