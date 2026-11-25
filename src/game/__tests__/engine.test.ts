import { describe, expect, test } from '@jest/globals';
import {
  DEFAULT_SETTINGS,
  FORFEIT_AFTER_REJECTIONS,
  GIVER_REWARDS,
  MAX_CLUE_ROUNDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  OPTIONS_PER_TURN,
  canForfeit,
  createGame,
  currentGiver,
  currentGuesser,
  gameReducer,
  giverRewardIfRoundFails,
  guesserOptions,
  isGameOver,
  nextRandom,
  rankedPlayers,
  rejectionsUntilForfeit,
  sanitizeSettings,
  turnNumber,
  winners,
} from '../index';
import type { GameAction, GameSettings, GameState } from '../index';

/** 60 distinct lower-case words. */
const DECK: readonly string[] = Array.from({ length: 60 }, (_, i) => {
  const a = String.fromCharCode(97 + (i % 26));
  const b = String.fromCharCode(97 + Math.floor(i / 26));
  return `w${b}${a}x`;
});

const SEED = 12345;

function settings(overrides: Partial<GameSettings> = {}): GameSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function newGame(names: string[] = ['Ann', 'Bob', 'Cy'], s: GameSettings = settings(), seed = SEED, deck = DECK) {
  return createGame(names, s, deck, seed);
}

function run(state: GameState, actions: GameAction[], deck: readonly string[] = DECK): GameState {
  return actions.reduce((s, a) => gameReducer(s, a, deck), state);
}

function score(state: GameState, id: string): number {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new Error(`no player ${id}`);
  return p.score;
}

/** handoff-giver (start of turn) -> clue, choosing options[0] as the hidden word. */
function chooseWord(state: GameState): GameState {
  return run(state, [{ type: 'REVEAL' }, { type: 'CHOOSE_WORD', word: state.options[0] }]);
}

let clueCounter = 0;
function freshClue(): string {
  clueCounter += 1;
  return `clue${String.fromCharCode(97 + (clueCounter % 26))}${String.fromCharCode(97 + Math.floor(clueCounter / 26) % 26)}`;
}

/** From 'clue': accept a clue, then every guesser submits the guess produced by guessFor. Ends in 'round-result'. */
function playRound(state: GameState, guessFor: (playerId: string, s: GameState) => string): GameState {
  let s = gameReducer(state, { type: 'CLUE_ACCEPTED', clue: freshClue(), score: 0.97 }, DECK);
  expect(s.phase).toBe('handoff-guesser');
  for (let i = 0; i < state.guesserOrder.length; i++) {
    const guesser = currentGuesser(s);
    if (!guesser) throw new Error('expected a guesser');
    s = gameReducer(s, { type: 'REVEAL' }, DECK);
    expect(s.phase).toBe('guess');
    s = gameReducer(s, { type: 'SUBMIT_GUESS', guess: guessFor(guesser.id, s) }, DECK);
  }
  expect(s.phase).toBe('round-result');
  return s;
}

/** A wrong guess that is valid in both modes: an option other than the hidden word. */
function wrong(s: GameState): string {
  const w = s.options.find((o) => o !== s.hiddenWord);
  if (!w) throw new Error('no wrong option');
  return w;
}

function right(s: GameState): string {
  if (s.hiddenWord === null) throw new Error('no hidden word');
  return s.hiddenWord;
}

/** Plays a whole turn in which nobody ever guesses correctly. Ends in 'turn-result'. */
function playFailedTurn(state: GameState): GameState {
  let s = chooseWord(state);
  for (let r = 1; r <= MAX_CLUE_ROUNDS; r++) {
    s = playRound(s, (_id, st) => wrong(st));
    s = gameReducer(s, { type: 'NEXT' }, DECK);
    if (r < MAX_CLUE_ROUNDS) s = gameReducer(s, { type: 'REVEAL' }, DECK);
  }
  expect(s.phase).toBe('turn-result');
  return s;
}

/** Plays a whole turn where everybody guesses correctly in round 1. Ends in 'turn-result'. */
function playQuickTurn(state: GameState): GameState {
  let s = chooseWord(state);
  s = playRound(s, (_id, st) => right(st));
  return gameReducer(s, { type: 'NEXT' }, DECK);
}

describe('constants', () => {
  test('match the contract', () => {
    expect(GIVER_REWARDS).toEqual([1, 2, 6]);
    expect(MAX_CLUE_ROUNDS).toBe(3);
    expect(FORFEIT_AFTER_REJECTIONS).toBe(5);
    expect(OPTIONS_PER_TURN).toBe(5);
    expect(MIN_PLAYERS).toBe(2);
    expect(MAX_PLAYERS).toBe(8);
    expect(DEFAULT_SETTINGS).toEqual({
      turnsPerPlayer: 2,
      threshold: 0.95,
      guessMode: 'open',
      requireDictionaryNoun: true,
    });
  });
});

describe('createGame', () => {
  test('initial state', () => {
    const s = newGame();
    expect(s.phase).toBe('handoff-giver');
    expect(s.players).toEqual([
      { id: 'p1', name: 'Ann', score: 0 },
      { id: 'p2', name: 'Bob', score: 0 },
      { id: 'p3', name: 'Cy', score: 0 },
    ]);
    expect(s.giverIndex).toBe(0);
    expect(currentGiver(s).id).toBe('p1');
    expect(currentGuesser(s)).toBeNull();
    expect(s.options).toHaveLength(OPTIONS_PER_TURN);
    expect(new Set(s.options).size).toBe(OPTIONS_PER_TURN);
    s.options.forEach((o) => expect(DECK).toContain(o));
    expect(s.guessOptions.slice().sort()).toEqual(s.options.slice().sort());
    expect(s.hiddenWord).toBeNull();
    expect(s.clueRound).toBe(1);
    expect(s.acceptedClues).toEqual([]);
    expect(s.rejectedThisRound).toEqual([]);
    expect(s.guesserOrder).toEqual([1, 2]);
    expect(s.guesses).toEqual([]);
    expect(s.rounds).toEqual([]);
    expect(s.turnSummary).toBeNull();
    expect(s.totalTurns).toBe(6);
    expect(turnNumber(s)).toBe(1);
    expect(s.usedWords).toEqual(s.options);
  });

  test('trims names and fills blank ones', () => {
    const s = newGame(['  Ann ', '', '   ']);
    expect(s.players.map((p) => p.name)).toEqual(['Ann', 'Player 2', 'Player 3']);
  });

  test('rejects bad player counts and tiny decks', () => {
    expect(() => newGame(['Solo'])).toThrow();
    expect(() => newGame(Array.from({ length: 9 }, (_, i) => `P${i}`))).toThrow();
    expect(() => newGame(['A', 'B'], settings(), SEED, ['a', 'b', 'c', 'd'])).toThrow();
    expect(() => newGame(['A', 'B'])).not.toThrow();
    expect(() => newGame(Array.from({ length: 8 }, (_, i) => `P${i}`))).not.toThrow();
  });

  test('sanitises settings', () => {
    expect(sanitizeSettings(settings({ turnsPerPlayer: 99, threshold: 0.5 }))).toEqual(
      settings({ turnsPerPlayer: 5, threshold: 0.8 }),
    );
    expect(sanitizeSettings(settings({ turnsPerPlayer: 0, threshold: 1 }))).toEqual(
      settings({ turnsPerPlayer: 1, threshold: 0.99 }),
    );
    expect(sanitizeSettings(settings({ turnsPerPlayer: 2.6, threshold: 0.8700000001 }))).toEqual(
      settings({ turnsPerPlayer: 3, threshold: 0.87 }),
    );
    expect(newGame(['A', 'B'], settings({ turnsPerPlayer: 9 })).totalTurns).toBe(10);
  });

  test('does not mutate its inputs', () => {
    const names = ['Ann', 'Bob'];
    const s = settings();
    const deck = Object.freeze(DECK.slice());
    createGame(names, Object.freeze(s), deck, SEED);
    expect(names).toEqual(['Ann', 'Bob']);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });
});

describe('full turn flow', () => {
  test("open mode: every phase in order, guessers don't get the options", () => {
    let s = newGame();
    expect(guesserOptions(s)).toBeNull();

    s = gameReducer(s, { type: 'REVEAL' }, DECK);
    expect(s.phase).toBe('choose-word');

    const hidden = s.options[2];
    s = gameReducer(s, { type: 'CHOOSE_WORD', word: `  ${hidden.toUpperCase()} ` }, DECK);
    expect(s.phase).toBe('clue');
    expect(s.hiddenWord).toBe(hidden);

    s = gameReducer(s, { type: 'CLUE_REJECTED', clue: ' Nope ', score: 0.4 }, DECK);
    expect(s.phase).toBe('clue');
    expect(s.rejectedThisRound).toEqual([{ clue: 'nope', score: 0.4 }]);
    expect(s.triedClues).toEqual(['nope']);

    s = gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'Hint', score: 0.96 }, DECK);
    expect(s.phase).toBe('handoff-guesser');
    expect(s.acceptedClues).toEqual([{ clue: 'hint', score: 0.96 }]);
    expect(s.rejectedThisRound).toEqual([]);
    expect(s.triedClues).toEqual(['nope', 'hint']);
    expect(currentGuesser(s)?.id).toBe('p2');

    s = gameReducer(s, { type: 'REVEAL' }, DECK);
    expect(s.phase).toBe('guess');
    expect(currentGuesser(s)?.id).toBe('p2');

    // Open mode accepts any word, including one that is not an option.
    s = gameReducer(s, { type: 'SUBMIT_GUESS', guess: '  Banana ' }, DECK);
    expect(s.phase).toBe('handoff-guesser');
    expect(currentGuesser(s)?.id).toBe('p3');
    expect(s.guesses).toEqual([{ playerId: 'p2', guess: 'banana', correct: false }]);
    expect(s.players.every((p) => p.score === 0)).toBe(true);

    s = gameReducer(s, { type: 'REVEAL' }, DECK);
    s = gameReducer(s, { type: 'SUBMIT_GUESS', guess: hidden.toUpperCase() }, DECK);
    expect(s.phase).toBe('round-result');
    expect(currentGuesser(s)).toBeNull();
    expect(s.guesses).toEqual([
      { playerId: 'p2', guess: 'banana', correct: false },
      { playerId: 'p3', guess: hidden, correct: true },
    ]);
    expect(s.rounds).toEqual([
      {
        round: 1,
        clue: 'hint',
        score: 0.96,
        guesses: s.guesses,
        anyCorrect: true,
        correctGuesserIds: ['p3'],
        giverPointsAwarded: 0,
      },
    ]);
    expect(s.players.map((p) => p.score)).toEqual([0, 0, 1]);

    s = gameReducer(s, { type: 'NEXT' }, DECK);
    expect(s.phase).toBe('turn-result');
    expect(s.turnSummary).toEqual({
      giverId: 'p1',
      hiddenWord: hidden,
      outcome: 'guessed',
      roundsPlayed: 1,
      giverPoints: 0,
      correctGuesserIds: ['p3'],
      clues: [{ clue: 'hint', score: 0.96 }],
    });

    s = gameReducer(s, { type: 'NEXT' }, DECK);
    expect(s.phase).toBe('handoff-giver');
    expect(currentGiver(s).id).toBe('p2');
    expect(s.guesserOrder).toEqual([2, 0]);
    expect(s.hiddenWord).toBeNull();
    expect(s.turnSummary).toBeNull();
    expect(s.acceptedClues).toEqual([]);
    expect(s.triedClues).toEqual([]);
    expect(s.rounds).toEqual([]);
    expect(s.clueRound).toBe(1);
    expect(turnNumber(s)).toBe(2);
    expect(s.players.map((p) => p.score)).toEqual([0, 0, 1]);
  });

  test('list mode: guessers see a fixed shuffled list and must pick from it', () => {
    let s = newGame(['Ann', 'Bob', 'Cy'], settings({ guessMode: 'list' }));
    const shown = guesserOptions(s);
    expect(shown).not.toBeNull();
    expect(shown!.slice().sort()).toEqual(s.options.slice().sort());

    s = chooseWord(s);
    const hidden = right(s);
    s = run(s, [{ type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.95 }, { type: 'REVEAL' }]);
    expect(s.phase).toBe('guess');
    expect(guesserOptions(s)).toEqual(shown);

    // Not one of the five options -> invalid in list mode.
    expect(gameReducer(s, { type: 'SUBMIT_GUESS', guess: 'banana' }, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'SUBMIT_GUESS', guess: `${hidden}s` }, DECK)).toBe(s);

    s = gameReducer(s, { type: 'SUBMIT_GUESS', guess: wrong(s) }, DECK);
    expect(s.phase).toBe('handoff-guesser');
    s = run(s, [{ type: 'REVEAL' }, { type: 'SUBMIT_GUESS', guess: hidden }]);
    expect(s.phase).toBe('round-result');
    expect(s.players.map((p) => p.score)).toEqual([0, 0, 1]);
    expect(guesserOptions(s)).toEqual(shown);

    // The list stays fixed for a second round of the same turn too.
    let t = chooseWord(newGame(['Ann', 'Bob', 'Cy'], settings({ guessMode: 'list' })));
    t = playRound(t, (_id, st) => wrong(st));
    t = run(t, [{ type: 'NEXT' }, { type: 'REVEAL' }]);
    expect(t.phase).toBe('clue');
    expect(guesserOptions(t)).toEqual(shown);
  });

  test('a failed round sends the device back to the giver for another clue', () => {
    let s = chooseWord(newGame());
    const hidden = right(s);
    s = playRound(s, (_id, st) => wrong(st));
    expect(s.rounds[0].anyCorrect).toBe(false);
    expect(s.rounds[0].giverPointsAwarded).toBe(1);

    s = gameReducer(s, { type: 'NEXT' }, DECK);
    expect(s.phase).toBe('handoff-giver');
    expect(s.clueRound).toBe(2);
    expect(s.hiddenWord).toBe(hidden);
    expect(s.guesses).toEqual([]);
    expect(s.turnSummary).toBeNull();
    expect(giverRewardIfRoundFails(s)).toBe(2);

    s = gameReducer(s, { type: 'REVEAL' }, DECK);
    expect(s.phase).toBe('clue'); // not 'choose-word': the word is already chosen
    expect(s.acceptedClues).toHaveLength(1);

    // All accepted clues of the turn stay visible in later rounds.
    s = gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'second', score: 0.99 }, DECK);
    expect(s.acceptedClues.map((c) => c.clue)).toEqual([s.rounds[0].clue, 'second']);
    expect(currentGuesser(s)?.id).toBe('p2');
  });
});

describe('scoring', () => {
  test('giver rewards are cumulative totals 1 / 2 / 6', () => {
    let s = chooseWord(newGame());
    const totals: number[] = [];
    for (let r = 1; r <= 3; r++) {
      expect(giverRewardIfRoundFails(s)).toBe(GIVER_REWARDS[r - 1]);
      s = playRound(s, (_id, st) => wrong(st));
      totals.push(score(s, 'p1'));
      expect(s.giverTurnPoints).toBe(GIVER_REWARDS[r - 1]);
      s = gameReducer(s, { type: 'NEXT' }, DECK);
      if (r < 3) s = gameReducer(s, { type: 'REVEAL' }, DECK);
    }
    expect(totals).toEqual([1, 2, 6]);
    expect(s.rounds.map((r) => r.giverPointsAwarded)).toEqual([1, 1, 4]);
    expect(s.phase).toBe('turn-result');
    expect(s.turnSummary).toMatchObject({
      giverId: 'p1',
      outcome: 'not-guessed',
      roundsPlayed: 3,
      giverPoints: 6,
      correctGuesserIds: [],
    });
    expect(s.turnSummary?.hiddenWord).toBe(s.hiddenWord);
    expect(s.turnSummary?.clues).toHaveLength(3);
    expect(s.players.map((p) => p.score)).toEqual([6, 0, 0]);
  });

  test('guessed in round 2: giver keeps 1, guesser gets 1', () => {
    let s = chooseWord(newGame());
    s = playRound(s, (_id, st) => wrong(st));
    s = run(s, [{ type: 'NEXT' }, { type: 'REVEAL' }]);
    s = playRound(s, (id, st) => (id === 'p3' ? right(st) : wrong(st)));
    expect(s.players.map((p) => p.score)).toEqual([1, 0, 1]);
    expect(s.rounds[1].giverPointsAwarded).toBe(0);

    s = gameReducer(s, { type: 'NEXT' }, DECK);
    expect(s.phase).toBe('turn-result');
    expect(s.turnSummary).toMatchObject({
      outcome: 'guessed',
      roundsPlayed: 2,
      giverPoints: 1,
      correctGuesserIds: ['p3'],
    });
    expect(s.players.map((p) => p.score)).toEqual([1, 0, 1]);
  });

  test('guessed in round 3: giver keeps 2', () => {
    let s = chooseWord(newGame());
    for (let r = 0; r < 2; r++) {
      s = playRound(s, (_id, st) => wrong(st));
      s = run(s, [{ type: 'NEXT' }, { type: 'REVEAL' }]);
    }
    s = playRound(s, (id, st) => (id === 'p2' ? right(st) : wrong(st)));
    s = gameReducer(s, { type: 'NEXT' }, DECK);
    expect(s.phase).toBe('turn-result');
    expect(s.turnSummary).toMatchObject({ outcome: 'guessed', roundsPlayed: 3, giverPoints: 2 });
    expect(s.players.map((p) => p.score)).toEqual([2, 1, 0]);
  });

  test('guessed in round 1: giver gets nothing', () => {
    const s = playQuickTurn(newGame());
    expect(s.turnSummary).toMatchObject({ outcome: 'guessed', giverPoints: 0, roundsPlayed: 1 });
    expect(score(s, 'p1')).toBe(0);
  });

  test('every correct guesser gets +1 and the turn ends', () => {
    let s = chooseWord(newGame(['A', 'B', 'C', 'D']));
    s = playRound(s, (id, st) => (id === 'p3' ? wrong(st) : right(st)));
    expect(s.players.map((p) => p.score)).toEqual([0, 1, 0, 1]);
    expect(s.rounds[0].correctGuesserIds).toEqual(['p2', 'p4']);
    s = gameReducer(s, { type: 'NEXT' }, DECK);
    expect(s.phase).toBe('turn-result');
    expect(s.turnSummary?.correctGuesserIds).toEqual(['p2', 'p4']);
    expect(s.turnSummary?.giverPoints).toBe(0);
  });

  test('all guessers still guess after an earlier one is correct', () => {
    let s = chooseWord(newGame(['A', 'B', 'C', 'D']));
    s = run(s, [
      { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.99 },
      { type: 'REVEAL' },
      { type: 'SUBMIT_GUESS', guess: right(s) },
    ]);
    expect(s.phase).toBe('handoff-guesser');
    expect(score(s, 'p2')).toBe(0); // nothing is credited until the round resolves
    expect(currentGuesser(s)?.id).toBe('p3');
  });

  test('trivial plural guesses count in open mode', () => {
    let s = chooseWord(newGame(['A', 'B']));
    s = playRound(s, (_id, st) => `${right(st)}s`);
    expect(s.guesses[0].correct).toBe(true);
    expect(s.players.map((p) => p.score)).toEqual([0, 1]);
  });
});

describe('clue acceptance and rejection', () => {
  test('CLUE_ACCEPTED below the threshold is invalid; at the threshold it is accepted', () => {
    const s = chooseWord(newGame());
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.9499 }, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'hint', score: Number.NaN }, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.95 }, DECK).phase).toBe('handoff-guesser');
  });

  test('the threshold setting is respected', () => {
    const low = chooseWord(newGame(['A', 'B'], settings({ threshold: 0.8 })));
    expect(gameReducer(low, { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.8 }, DECK).phase).toBe('handoff-guesser');
    expect(gameReducer(low, { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.79 }, DECK)).toBe(low);

    const high = chooseWord(newGame(['A', 'B'], settings({ threshold: 0.99 })));
    expect(gameReducer(high, { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.98 }, DECK)).toBe(high);
  });

  test('CLUE_REJECTED with a passing score, an empty clue or a repeated clue is invalid', () => {
    let s = chooseWord(newGame());
    expect(gameReducer(s, { type: 'CLUE_REJECTED', clue: 'hint', score: 0.95 }, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'CLUE_REJECTED', clue: '   ', score: 0.1 }, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'CLUE_REJECTED', clue: 'hint', score: Number.NaN }, DECK)).toBe(s);

    s = gameReducer(s, { type: 'CLUE_REJECTED', clue: 'hint', score: 0.1 }, DECK);
    expect(s.rejectedThisRound).toHaveLength(1);
    expect(gameReducer(s, { type: 'CLUE_REJECTED', clue: ' HINT ', score: 0.2 }, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.99 }, DECK)).toBe(s);
  });

  test('a clue used in an earlier round of the turn cannot be reused', () => {
    let s = chooseWord(newGame(['A', 'B']));
    s = run(s, [
      { type: 'CLUE_REJECTED', clue: 'bad', score: 0.2 },
      { type: 'CLUE_ACCEPTED', clue: 'good', score: 0.96 },
      { type: 'REVEAL' },
      { type: 'SUBMIT_GUESS', guess: 'nothing' },
      { type: 'NEXT' },
      { type: 'REVEAL' },
    ]);
    expect(s.phase).toBe('clue');
    expect(s.clueRound).toBe(2);
    expect(s.rejectedThisRound).toEqual([]);
    expect(s.triedClues).toEqual(['bad', 'good']);
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'good', score: 0.96 }, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'CLUE_REJECTED', clue: 'bad', score: 0.2 }, DECK)).toBe(s);
  });
});

describe('forfeit', () => {
  function reject(s: GameState, n: number, prefix = 'rej'): GameState {
    let out = s;
    for (let i = 0; i < n; i++) {
      out = gameReducer(out, { type: 'CLUE_REJECTED', clue: `${prefix}${String.fromCharCode(97 + i)}`, score: 0.3 }, DECK);
    }
    return out;
  }

  test('only available after 5 rejections in the round', () => {
    let s = chooseWord(newGame());
    expect(rejectionsUntilForfeit(s)).toBe(5);
    expect(canForfeit(s)).toBe(false);
    expect(gameReducer(s, { type: 'FORFEIT_TURN' }, DECK)).toBe(s);

    s = reject(s, 4);
    expect(s.rejectedThisRound).toHaveLength(4);
    expect(rejectionsUntilForfeit(s)).toBe(1);
    expect(canForfeit(s)).toBe(false);
    expect(gameReducer(s, { type: 'FORFEIT_TURN' }, DECK)).toBe(s);

    s = gameReducer(s, { type: 'CLUE_REJECTED', clue: 'fifth', score: 0.3 }, DECK);
    expect(rejectionsUntilForfeit(s)).toBe(0);
    expect(canForfeit(s)).toBe(true);
    const hidden = right(s);

    const f = gameReducer(s, { type: 'FORFEIT_TURN' }, DECK);
    expect(f.phase).toBe('turn-result');
    expect(f.turnSummary).toEqual({
      giverId: 'p1',
      hiddenWord: hidden,
      outcome: 'forfeit',
      roundsPlayed: 0,
      giverPoints: 0,
      correctGuesserIds: [],
      clues: [],
    });
    expect(f.players.every((p) => p.score === 0)).toBe(true);

    // The game carries on with the next giver.
    const n = gameReducer(f, { type: 'NEXT' }, DECK);
    expect(n.phase).toBe('handoff-giver');
    expect(currentGiver(n).id).toBe('p2');
  });

  test('a giver with 5 rejections may still get a clue accepted instead', () => {
    let s = reject(chooseWord(newGame()), 6);
    expect(canForfeit(s)).toBe(true);
    s = gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 'finally', score: 0.97 }, DECK);
    expect(s.phase).toBe('handoff-guesser');
    expect(canForfeit(s)).toBe(false);
    expect(gameReducer(s, { type: 'FORFEIT_TURN' }, DECK)).toBe(s);
  });

  test('the rejection count restarts each clue round; forfeiting in round 2 keeps the 1 point', () => {
    let s = reject(chooseWord(newGame()), 4, 'one');
    s = playRound(s, (_id, st) => wrong(st));
    s = run(s, [{ type: 'NEXT' }, { type: 'REVEAL' }]);
    expect(s.phase).toBe('clue');
    expect(s.rejectedThisRound).toEqual([]);
    expect(canForfeit(s)).toBe(false);

    s = reject(s, 1, 'two');
    expect(gameReducer(s, { type: 'FORFEIT_TURN' }, DECK)).toBe(s); // 4 + 1 across rounds does not count

    s = reject(s, 4, 'three');
    expect(canForfeit(s)).toBe(true);
    s = gameReducer(s, { type: 'FORFEIT_TURN' }, DECK);
    expect(s.phase).toBe('turn-result');
    expect(s.turnSummary).toMatchObject({ outcome: 'forfeit', roundsPlayed: 1, giverPoints: 1, correctGuesserIds: [] });
    expect(s.turnSummary?.clues).toHaveLength(1);
    expect(s.players.map((p) => p.score)).toEqual([1, 0, 0]);
  });

  test('forfeit is not possible outside the clue phase', () => {
    const start = newGame();
    expect(gameReducer(start, { type: 'FORFEIT_TURN' }, DECK)).toBe(start);
    const choosing = gameReducer(start, { type: 'REVEAL' }, DECK);
    expect(gameReducer(choosing, { type: 'FORFEIT_TURN' }, DECK)).toBe(choosing);
  });
});

describe('invalid actions return the same state object', () => {
  const ALL: GameAction[] = [
    { type: 'REVEAL' },
    { type: 'CHOOSE_WORD', word: 'placeholder' },
    { type: 'CLUE_REJECTED', clue: 'zzz', score: 0.1 },
    { type: 'CLUE_ACCEPTED', clue: 'zzz', score: 0.99 },
    { type: 'FORFEIT_TURN' },
    { type: 'SUBMIT_GUESS', guess: 'zzz' },
    { type: 'NEXT' },
  ];

  function statesByPhase(): Record<string, GameState> {
    const handoffGiver = newGame();
    const chooseWordState = gameReducer(handoffGiver, { type: 'REVEAL' }, DECK);
    const clue = gameReducer(chooseWordState, { type: 'CHOOSE_WORD', word: chooseWordState.options[0] }, DECK);
    const handoffGuesser = gameReducer(clue, { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.99 }, DECK);
    const guess = gameReducer(handoffGuesser, { type: 'REVEAL' }, DECK);
    const roundResult = run(guess, [
      { type: 'SUBMIT_GUESS', guess: 'nah' },
      { type: 'REVEAL' },
      { type: 'SUBMIT_GUESS', guess: 'nope' },
    ]);
    const turnResult = playQuickTurn(newGame());
    let gameOver = newGame(['A', 'B'], settings({ turnsPerPlayer: 1 }));
    gameOver = gameReducer(playQuickTurn(gameOver), { type: 'NEXT' }, DECK);
    gameOver = gameReducer(playQuickTurn(gameOver), { type: 'NEXT' }, DECK);
    return {
      'handoff-giver': handoffGiver,
      'choose-word': chooseWordState,
      clue,
      'handoff-guesser': handoffGuesser,
      guess,
      'round-result': roundResult,
      'turn-result': turnResult,
      'game-over': gameOver,
    };
  }

  const VALID: Record<string, GameAction['type'][]> = {
    'handoff-giver': ['REVEAL'],
    'choose-word': [], // CHOOSE_WORD with a word that is not an option is invalid
    clue: ['CLUE_REJECTED', 'CLUE_ACCEPTED'],
    'handoff-guesser': ['REVEAL'],
    guess: ['SUBMIT_GUESS'],
    'round-result': ['NEXT'],
    'turn-result': ['NEXT'],
    'game-over': [],
  };

  test.each(Object.keys(VALID))('phase %s', (phase) => {
    const s = statesByPhase()[phase];
    expect(s.phase).toBe(phase);
    const snapshot = JSON.stringify(s);
    for (const action of ALL) {
      const next = gameReducer(s, action, DECK);
      if (VALID[phase].includes(action.type)) {
        expect(next).not.toBe(s);
      } else {
        expect(next).toBe(s);
      }
    }
    // The reducer never mutates its input.
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  test('CHOOSE_WORD only accepts one of the options', () => {
    const s = gameReducer(newGame(), { type: 'REVEAL' }, DECK);
    const outside = DECK.find((w) => !s.options.includes(w))!;
    expect(gameReducer(s, { type: 'CHOOSE_WORD', word: outside }, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'CHOOSE_WORD', word: '' }, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'CHOOSE_WORD', word: s.options[4] }, DECK).hiddenWord).toBe(s.options[4]);
  });

  test('an empty guess is invalid', () => {
    const s = run(chooseWord(newGame()), [{ type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.99 }, { type: 'REVEAL' }]);
    expect(gameReducer(s, { type: 'SUBMIT_GUESS', guess: '   ' }, DECK)).toBe(s);
  });

  test('unknown action types and malformed payloads are ignored', () => {
    const s = chooseWord(newGame());
    expect(gameReducer(s, { type: 'BOGUS' } as unknown as GameAction, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'CLUE_ACCEPTED', clue: 42, score: 1 } as unknown as GameAction, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'CLUE_REJECTED', clue: 'x', score: '0.1' } as unknown as GameAction, DECK)).toBe(s);
  });
});

describe('rotation and game end', () => {
  test.each([
    [2, 1],
    [3, 2],
    [4, 3],
    [8, 1],
  ])('%i players, %i turn(s) each', (playerCount, turnsPerPlayer) => {
    const names = Array.from({ length: playerCount }, (_, i) => `P${i + 1}`);
    let s = newGame(names, settings({ turnsPerPlayer }));
    const givers: string[] = [];
    const total = playerCount * turnsPerPlayer;
    expect(s.totalTurns).toBe(total);

    for (let t = 0; t < total; t++) {
      expect(s.phase).toBe('handoff-giver');
      expect(isGameOver(s)).toBe(false);
      expect(turnNumber(s)).toBe(t + 1);
      givers.push(currentGiver(s).id);
      // Guessers are everyone else, in turn order starting after the giver.
      expect(s.guesserOrder).toHaveLength(playerCount - 1);
      expect(s.guesserOrder).not.toContain(s.giverIndex);
      expect(s.guesserOrder[0]).toBe((s.giverIndex + 1) % playerCount);
      s = gameReducer(playQuickTurn(s), { type: 'NEXT' }, DECK);
    }

    expect(s.phase).toBe('game-over');
    expect(isGameOver(s)).toBe(true);
    expect(givers).toEqual(Array.from({ length: total }, (_, t) => `p${(t % playerCount) + 1}`));
    for (const p of s.players) {
      expect(givers.filter((g) => g === p.id)).toHaveLength(turnsPerPlayer);
    }
    // The last turn's summary is still available on the final screen; nothing moves any more.
    expect(s.turnSummary).not.toBeNull();
    expect(gameReducer(s, { type: 'NEXT' }, DECK)).toBe(s);
    expect(gameReducer(s, { type: 'REVEAL' }, DECK)).toBe(s);
  });

  test('scores accumulate across turns', () => {
    let s = newGame(['A', 'B'], settings({ turnsPerPlayer: 2 }));
    s = gameReducer(playFailedTurn(s), { type: 'NEXT' }, DECK); // A +6
    s = gameReducer(playQuickTurn(s), { type: 'NEXT' }, DECK); // A +1 (guesser)
    s = gameReducer(playQuickTurn(s), { type: 'NEXT' }, DECK); // B +1 (guesser)
    s = gameReducer(playFailedTurn(s), { type: 'NEXT' }, DECK); // B +6
    expect(s.phase).toBe('game-over');
    expect(s.players.map((p) => p.score)).toEqual([7, 7]);
  });
});

describe('ranking', () => {
  function withScores(scores: number[]): GameState {
    const s = newGame(scores.map((_, i) => `P${i + 1}`));
    return { ...s, players: s.players.map((p, i) => ({ ...p, score: scores[i] })) };
  }

  test('sorted by score with competition ranks and tie flags', () => {
    const ranked = rankedPlayers(withScores([3, 7, 3, 0, 7]));
    expect(ranked.map((p) => [p.id, p.score, p.rank, p.tied])).toEqual([
      ['p2', 7, 1, true],
      ['p5', 7, 1, true],
      ['p1', 3, 3, true],
      ['p3', 3, 3, true],
      ['p4', 0, 5, false],
    ]);
  });

  test('no ties', () => {
    const ranked = rankedPlayers(withScores([1, 5, 3]));
    expect(ranked.map((p) => [p.id, p.rank, p.tied])).toEqual([
      ['p2', 1, false],
      ['p3', 2, false],
      ['p1', 3, false],
    ]);
  });

  test('everybody tied at zero', () => {
    const s = newGame();
    expect(rankedPlayers(s).map((p) => [p.id, p.rank, p.tied])).toEqual([
      ['p1', 1, true],
      ['p2', 1, true],
      ['p3', 1, true],
    ]);
    expect(winners(s).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  test('winners and non-mutation', () => {
    const s = withScores([2, 9, 9]);
    const before = JSON.stringify(s);
    expect(winners(s).map((p) => p.id)).toEqual(['p2', 'p3']);
    rankedPlayers(s);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('determinism', () => {
  function playScript(seed: number): GameState[] {
    const trace: GameState[] = [];
    let s = newGame(['A', 'B', 'C'], settings({ turnsPerPlayer: 2 }), seed);
    trace.push(s);
    for (let t = 0; t < 6; t++) {
      s = t % 2 === 0 ? playFailedTurn(s) : playQuickTurn(s);
      trace.push(s);
      s = gameReducer(s, { type: 'NEXT' }, DECK);
      trace.push(s);
    }
    return trace;
  }

  function optionsOnly(trace: GameState[]): string[][] {
    return trace.map((s) => [...s.options, '|', ...s.guessOptions]);
  }

  test('same seed -> same options every turn', () => {
    clueCounter = 0;
    const a = playScript(777);
    clueCounter = 0;
    const b = playScript(777);
    expect(b).toEqual(a);
  });

  test('different seeds -> different deals', () => {
    expect(optionsOnly(playScript(1))).not.toEqual(optionsOnly(playScript(2)));
    expect(newGame(['A', 'B'], settings(), 1).options).not.toEqual(newGame(['A', 'B'], settings(), 2).options);
  });

  test('the PRNG only advances when a turn is dealt', () => {
    let s = newGame();
    const rng = s.rngState;
    s = playFailedTurn(s);
    expect(s.rngState).toBe(rng);
    s = gameReducer(s, { type: 'NEXT' }, DECK);
    expect(s.rngState).not.toBe(rng);
  });

  test('mulberry32 reference values', () => {
    // Reference implementation, written the way it is usually published.
    function mulberry32(seed: number): () => number {
      let a = seed;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    for (const seed of [0, 1, 42, 0xffffffff, 123456789]) {
      const ref = mulberry32(seed);
      let state = seed;
      for (let i = 0; i < 20; i++) {
        const r = nextRandom(state);
        expect(r.value).toBe(ref());
        expect(r.value).toBeGreaterThanOrEqual(0);
        expect(r.value).toBeLessThan(1);
        expect(Number.isInteger(r.rngState)).toBe(true);
        state = r.rngState;
      }
    }
  });

  test('odd seeds are normalised to a uint32', () => {
    for (const seed of [-5, 3.7, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 40]) {
      const s = newGame(['A', 'B'], settings(), seed);
      expect(Number.isInteger(s.seed)).toBe(true);
      expect(s.seed).toBeGreaterThanOrEqual(0);
      expect(s.options).toHaveLength(5);
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    }
  });
});

describe('options are not repeated within a game', () => {
  test('8 players x 5 turns on the real-sized deck never repeats a word', () => {
    const bigDeck = Array.from({ length: 1096 }, (_, i) => `word${i}`);
    const names = Array.from({ length: 8 }, (_, i) => `P${i + 1}`);
    let s = createGame(names, settings({ turnsPerPlayer: 5 }), bigDeck, 99);
    const seen: string[] = [];
    while (s.phase !== 'game-over') {
      expect(s.options).toHaveLength(5);
      seen.push(...s.options);
      s = run(
        s,
        [
          { type: 'REVEAL' },
          { type: 'CHOOSE_WORD', word: s.options[0] },
          { type: 'CLUE_ACCEPTED', clue: 'hint', score: 1 },
          ...s.guesserOrder.flatMap((): GameAction[] => [{ type: 'REVEAL' }, { type: 'SUBMIT_GUESS', guess: s.options[0] }]),
          { type: 'NEXT' },
          { type: 'NEXT' },
        ],
        bigDeck,
      );
    }
    expect(seen).toHaveLength(200);
    expect(new Set(seen).size).toBe(200);
  });

  test('uses the whole deck before recycling, and still deals 5 distinct words afterwards', () => {
    // 12 words, 2 players x 3 turns = 6 turns = 30 words needed.
    const tiny = DECK.slice(0, 12);
    let s = createGame(['A', 'B'], settings({ turnsPerPlayer: 3 }), tiny, 5);
    const deals: string[][] = [];
    while (s.phase !== 'game-over') {
      deals.push(s.options);
      expect(new Set(s.options).size).toBe(5);
      s.options.forEach((o) => expect(tiny).toContain(o));
      expect(s.guessOptions.slice().sort()).toEqual(s.options.slice().sort());
      s = run(
        s,
        [
          { type: 'REVEAL' },
          { type: 'CHOOSE_WORD', word: s.options[0] },
          { type: 'CLUE_ACCEPTED', clue: 'hint', score: 1 },
          { type: 'REVEAL' },
          { type: 'SUBMIT_GUESS', guess: s.options[0] },
          { type: 'NEXT' },
          { type: 'NEXT' },
        ],
        tiny,
      );
    }
    expect(deals).toHaveLength(6);
    // First two deals are disjoint; the third must contain the 2 words not yet offered.
    expect(new Set([...deals[0], ...deals[1]]).size).toBe(10);
    const leftover = tiny.filter((w) => !deals[0].includes(w) && !deals[1].includes(w));
    expect(leftover).toHaveLength(2);
    leftover.forEach((w) => expect(deals[2]).toContain(w));
    // After recycling, the next deal avoids the words of the deal that triggered it.
    deals[3].forEach((w) => expect(deals[2]).not.toContain(w));
  });

  test('duplicate and oddly-cased deck entries are collapsed', () => {
    const deck = ['Apple', 'apple', ' pear ', 'plum', 'fig', 'lime', 'kiwi', ''];
    const s = createGame(['A', 'B'], settings(), deck, 3);
    expect(new Set(s.options).size).toBe(5);
    s.options.forEach((o) => expect(['apple', 'pear', 'plum', 'fig', 'lime', 'kiwi']).toContain(o));
  });
});

describe('serialisation', () => {
  function roundTrip(s: GameState): GameState {
    const copy = JSON.parse(JSON.stringify(s)) as GameState;
    expect(copy).toEqual(s);
    return copy;
  }

  test('state survives a JSON round trip at every step and the game continues identically', () => {
    const script = (s0: GameState, viaJson: boolean): GameState => {
      let s = s0;
      const step = (action: GameAction) => {
        s = gameReducer(viaJson ? roundTrip(s) : s, action, DECK);
      };
      for (let turn = 0; turn < s0.totalTurns; turn++) {
        step({ type: 'REVEAL' });
        const hidden = s.options[1];
        step({ type: 'CHOOSE_WORD', word: hidden });
        step({ type: 'CLUE_REJECTED', clue: 'bad', score: 0.31 });
        step({ type: 'CLUE_ACCEPTED', clue: 'first', score: 0.951 });
        for (let g = 0; g < s0.players.length - 1; g++) {
          step({ type: 'REVEAL' });
          step({ type: 'SUBMIT_GUESS', guess: 'miss' });
        }
        step({ type: 'NEXT' });
        step({ type: 'REVEAL' });
        step({ type: 'CLUE_ACCEPTED', clue: 'second', score: 0.97 });
        for (let g = 0; g < s0.players.length - 1; g++) {
          step({ type: 'REVEAL' });
          step({ type: 'SUBMIT_GUESS', guess: g === 0 ? hidden : 'miss' });
        }
        step({ type: 'NEXT' });
        expect(s.phase).toBe('turn-result');
        step({ type: 'NEXT' });
      }
      return s;
    };

    const direct = script(newGame(['A', 'B', 'C'], settings({ turnsPerPlayer: 1 })), false);
    const viaJson = script(newGame(['A', 'B', 'C'], settings({ turnsPerPlayer: 1 })), true);
    expect(direct.phase).toBe('game-over');
    expect(viaJson).toEqual(direct);
    expect(direct.players.map((p) => p.score)).toEqual([2, 2, 2]);
  });

  test('mid-guess-round snapshot can be restored and finished', () => {
    let s = chooseWord(newGame(['A', 'B', 'C'], settings({ guessMode: 'list' })));
    const hidden = right(s);
    s = run(s, [
      { type: 'CLUE_REJECTED', clue: 'bad', score: 0.5 },
      { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.96 },
      { type: 'REVEAL' },
      { type: 'SUBMIT_GUESS', guess: wrong(s) },
    ]);
    expect(s.phase).toBe('handoff-guesser');

    const json = JSON.stringify(s);
    const restored = JSON.parse(json) as GameState;
    expect(restored).toEqual(s);
    expect(currentGuesser(restored)?.id).toBe('p3');
    expect(guesserOptions(restored)).toEqual(s.guessOptions);

    const finished = run(restored, [{ type: 'REVEAL' }, { type: 'SUBMIT_GUESS', guess: hidden }, { type: 'NEXT' }]);
    expect(finished.phase).toBe('turn-result');
    expect(finished.players.map((p) => p.score)).toEqual([0, 0, 1]);
    expect(JSON.stringify(restored)).toBe(json);
  });

  test('state contains only plain JSON values', () => {
    const check = (value: unknown, path: string): void => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
      if (typeof value === 'number') {
        expect(Number.isFinite(value)).toBe(true);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => check(v, `${path}[${i}]`));
        return;
      }
      if (typeof value === 'object') {
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        for (const [k, v] of Object.entries(value)) check(v, `${path}.${k}`);
        return;
      }
      throw new Error(`non-JSON value at ${path}: ${typeof value}`);
    };
    let s = newGame();
    check(s, 'state');
    s = playFailedTurn(s);
    check(s, 'state');
    s = gameReducer(s, { type: 'NEXT' }, DECK);
    check(s, 'state');
  });
});
