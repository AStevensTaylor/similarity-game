import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createGame, gameReducer } from '../../game';
import type { GameAction, GameState, GuessMode } from '../../game';
import type { PlayerView } from '../view';
import { DECK, SEED, badClue, flush, okClue, settings, setup, submitClue, toGuessPhase, wrongGuess } from './harness';
import type { Harness } from './harness';

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

/** Small deterministic PRNG for arrival orders. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function withoutGuessOptions(view: PlayerView): string {
  return JSON.stringify({ ...view, game: view.game ? { ...view.game, guessOptions: null } : null });
}

/**
 * While the word is secret, no guesser's snapshot and no 'view' message on the
 * wire to a guesser may contain it (outside the five shuffled options in list mode).
 */
function assertSecret(h: Harness, hidden: string, wireFrom: number): number {
  const giver = h.giverIndex();
  h.clients.forEach((c, i) => {
    if (i === giver) return;
    const view = c.getSnapshot().view as PlayerView;
    expect(view.game?.giver).toBeNull();
    if (withoutGuessOptions(view).includes(hidden)) throw new Error(`client ${i} can see the hidden word`);
  });
  const log = h.net.log;
  for (let i = wireFrom; i < log.length; i++) {
    const entry = log[i];
    if (entry.dir !== 'to-client') continue;
    if (entry.msg.t === 'view') {
      const view = entry.msg.view as PlayerView;
      if (view.game && view.game.role === 'guesser' && withoutGuessOptions(view).includes(hidden)) {
        throw new Error(`a wire view for seat ${view.you.seat} contains the hidden word`);
      }
    } else if (entry.msg.t === 'clueResult') {
      // Clue results only ever travel on the giver's connection.
      const giverSeat = h.gameView(0).giverSeat;
      const links = h.net.linksFrom(`10.0.0.${giver + 1}`);
      expect(h.clients[giver].getSnapshot().seat).toBe(giverSeat);
      expect(links).toContain(entry.link);
    }
  }
  return log.length;
}

/**
 * Plays a whole game through the clients only, mirroring every accepted action
 * on a reference engine state. Turn outcomes cycle through: guessed in round 1,
 * never guessed, guessed in round 2 by one player, forfeited after 5 rejections.
 */
async function playFullGame(h: Harness, seed: number): Promise<GameState> {
  const random = rng(seed);
  const names = h.view(0).players.map((p) => p.name);
  let ref = createGame(names, h.view(0).settings, DECK, SEED);
  const R = (a: GameAction) => {
    const next = gameReducer(ref, a, DECK);
    if (next === ref) throw new Error(`reference rejected ${a.type} in ${ref.phase}`);
    ref = next;
  };
  const expectSameScores = () => {
    for (let i = 0; i < h.clients.length; i++) {
      expect(h.view(i).players.map((p) => [p.id, p.name, p.score])).toEqual(ref.players.map((p) => [p.id, p.name, p.score]));
    }
  };
  R({ type: 'REVEAL' });
  let wire = 0;
  let turn = 0;

  while (h.gameView(0).phase !== 'game-over') {
    const giver = h.giverIndex();
    expect(giver).toBe(ref.giverIndex);
    for (let i = 0; i < h.clients.length; i++) {
      expect(h.gameView(i).phase).toBe('choose-word');
      expect(h.gameView(i).turnNumber).toBe(turn + 1);
      expect(h.gameView(i).role).toBe(i === giver ? 'giver' : 'guesser');
    }
    expect(h.gameView(giver).giver?.options).toEqual(ref.options);
    const word = ref.options[turn % 5];
    // Before the choice nobody else may see any option (open mode) / which one it will be.
    h.clients[giver].chooseWord(word);
    R({ type: 'CHOOSE_WORD', word });
    wire = assertSecret(h, word, wire);
    expect(h.gameView(giver).giver?.hiddenWord).toBe(word);

    const outcome = turn % 4;
    for (let round = 1; round <= 3; round++) {
      const rejections = outcome === 3 ? 5 : (turn + round) % 3;
      for (let k = 0; k < rejections; k++) {
        const clue = badClue();
        const result = await submitClue(h.clients[giver], clue);
        expect(result).toEqual({ kind: 'rejected', clue, score: 0.5, raw: 0.3 });
        R({ type: 'CLUE_REJECTED', clue, score: 0.5 });
        expect(h.gameView(giver).giver?.rejected).toEqual(ref.rejectedThisRound);
        wire = assertSecret(h, word, wire);
      }
      if (outcome === 3) {
        expect(h.gameView(giver).giver?.canForfeit).toBe(true);
        h.clients[giver].forfeit();
        R({ type: 'FORFEIT_TURN' });
        break;
      }
      const clue = okClue();
      expect(await submitClue(h.clients[giver], clue)).toEqual({ kind: 'accepted', clue, score: 0.97, raw: 0.7 });
      R({ type: 'CLUE_ACCEPTED', clue, score: 0.97 });
      wire = assertSecret(h, word, wire);

      const order = ref.guesserOrder;
      const correctOnes =
        outcome === 0 ? new Set(order) : outcome === 2 && round === 2 ? new Set([order[order.length - 1]]) : new Set<number>();
      const guesses = new Map<number, string>();
      const arrival = shuffled(order, random);
      arrival.forEach((idx, n) => {
        const view = h.gameView(idx);
        expect(view.phase).toBe('guess');
        expect(view.acceptedClues).toEqual(ref.acceptedClues);
        if (ref.settings.guessMode === 'list') expect(view.guessOptions).toEqual(ref.guessOptions);
        else expect(view.guessOptions).toBeNull();
        const guess = correctOnes.has(idx) ? word : wrongGuess(h);
        guesses.set(idx, guess);
        expect(h.clients[idx].submitGuess(guess)).toBe(true);
        if (n < arrival.length - 1) {
          // Everyone sees who has submitted - and nothing else.
          const done = new Set(arrival.slice(0, n + 1).map((i) => h.clients[i].getSnapshot().seat));
          for (let i = 0; i < h.clients.length; i++) {
            expect(h.gameView(i).phase).toBe('guess');
            expect(h.gameView(i).guessStatus).toEqual(
              order.map((o) => {
                const seat = h.clients[o].getSnapshot().seat as number;
                return { seat, status: done.has(seat) ? 'submitted' : 'pending' };
              }),
            );
            expect(h.gameView(i).rounds).toHaveLength(round - 1);
          }
          expect(h.gameView(idx).yourGuess).toBe(guess);
          // While guesses are still coming in, the word stays secret - unless your own guess is the word.
          if (![...guesses.values()].includes(word)) wire = assertSecret(h, word, wire);
        }
      });
      for (const idx of order) {
        R({ type: 'REVEAL' });
        R({ type: 'SUBMIT_GUESS', guess: guesses.get(idx) as string });
      }
      expect(ref.phase).toBe('round-result');
      for (let i = 0; i < h.clients.length; i++) {
        expect(h.gameView(i).phase).toBe('round-result');
        expect(h.gameView(i).rounds).toEqual(ref.rounds);
        expect(h.gameView(i).giverTurnPoints).toBe(ref.giverTurnPoints);
        expect(h.gameView(i).canContinue).toBe(i === 0);
      }
      expectSameScores();
      if (correctOnes.size === 0) wire = assertSecret(h, word, wire);
      else wire = h.net.log.length;

      expect(h.clients[0].next()).toBe(true);
      R({ type: 'NEXT' });
      if (ref.phase === 'turn-result') break;
      R({ type: 'REVEAL' });
      for (let i = 0; i < h.clients.length; i++) expect(h.gameView(i).phase).toBe('clue');
      expect(h.gameView(0).clueRound).toBe(round + 1);
    }

    expect(ref.phase).toBe('turn-result');
    for (let i = 0; i < h.clients.length; i++) {
      expect(h.gameView(i).phase).toBe('turn-result');
      expect(h.gameView(i).turnSummary).toEqual(ref.turnSummary);
    }
    expectSameScores();
    h.clients[0].next();
    R({ type: 'NEXT' });
    if (ref.phase === 'handoff-giver') R({ type: 'REVEAL' });
    wire = h.net.log.length;
    turn++;
  }

  expect(ref.phase).toBe('game-over');
  expect(turn).toBe(ref.totalTurns);
  expectSameScores();
  // The host's engine state is exactly what the pure engine produces for the same actions.
  expect(h.game()).toEqual(ref);
  for (let i = 0; i < h.clients.length; i++) {
    expect(h.gameView(i).phase).toBe('game-over');
    expect(h.gameView(i).turnSummary).toEqual(ref.turnSummary);
    expect(h.clients[i].getSnapshot().status).toBe('connected');
  }
  return ref;
}

describe('full games reach the same result as the pure engine', () => {
  const cases: [number, GuessMode, number][] = [
    [2, 'open', 2],
    [2, 'list', 2],
    [3, 'open', 2],
    [3, 'list', 2],
    [8, 'open', 1],
    [8, 'list', 1],
  ];
  test.each(cases)('%i players, %s mode', async (players, guessMode, turnsPerPlayer) => {
    const h = await setup({ players, settings: settings({ guessMode, turnsPerPlayer }) });
    expect(h.view(0).players).toHaveLength(players);
    const ref = await playFullGame(h, players * 7 + (guessMode === 'list' ? 1 : 0));
    expect(ref.totalTurns).toBe(players * turnsPerPlayer);
    // Somebody actually scored, and the scripted outcomes produced different totals.
    expect(ref.players.reduce((sum, p) => sum + p.score, 0)).toBeGreaterThan(0);
    const stopped = h.host.stop();
    jest.advanceTimersByTime(1000);
    await stopped;
    for (const c of h.clients.slice(1)) expect(c.getSnapshot().closeReason).toBe('host-left');
  });

  test('a longer game: 4 players, 3 turns each, threshold 0.9', async () => {
    const h = await setup({ players: 4, settings: settings({ turnsPerPlayer: 3, threshold: 0.9 }) });
    const ref = await playFullGame(h, 5);
    expect(ref.totalTurns).toBe(12);
    expect(ref.settings.threshold).toBe(0.9);
  });

  test('the game uses the host settings as they are when the game starts', async () => {
    let current = settings({ turnsPerPlayer: 1 });
    const h = await setup({ players: 2, startGame: false, settings: () => current });
    expect(h.view(1).settings.turnsPerPlayer).toBe(1);
    current = settings({ turnsPerPlayer: 3, guessMode: 'list', threshold: 0.9 });
    h.host.refreshSettings();
    expect(h.view(1).settings).toEqual(current);
    current = settings({ turnsPerPlayer: 4, guessMode: 'list', threshold: 0.85, requireDictionaryNoun: false });
    await h.start();
    expect(h.game().settings).toEqual(current);
    expect(h.view(1).settings).toEqual(current);
    expect(h.gameView(1).totalTurns).toBe(8);
  });
});

describe('simultaneous guesses', () => {
  const orders = [
    [1, 2, 3],
    [1, 3, 2],
    [2, 1, 3],
    [2, 3, 1],
    [3, 1, 2],
    [3, 2, 1],
  ];

  test.each(orders)('arrival order %i, %i, %i gives the same round', async (...arrival) => {
    const h = await setup({ players: 4 });
    const { word } = await toGuessPhase(h);
    const guessOf = (i: number) => (i === 2 ? word : `guess${'abc'[i - 1]}`);
    for (const i of arrival) h.clients[i].submitGuess(guessOf(i));
    const g = h.game();
    expect(g.phase).toBe('round-result');
    // Applied in guesserOrder, whatever the arrival order was.
    expect(g.rounds[0].guesses).toEqual([
      { playerId: 'p2', guess: 'guessa', correct: false },
      { playerId: 'p3', guess: word, correct: true },
      { playerId: 'p4', guess: 'guessc', correct: false },
    ]);
    expect(g.players.map((p) => p.score)).toEqual([0, 0, 1, 0]);
    for (let i = 0; i < 4; i++) expect(h.gameView(i).rounds).toEqual(g.rounds);
  });

  test('guesses held on the network and delivered in reverse still resolve identically', async () => {
    const h = await setup({ players: 4 });
    const { word } = await toGuessPhase(h);
    h.net.pause();
    h.clients[1].submitGuess('first');
    h.clients[2].submitGuess(word);
    h.clients[3].submitGuess('third');
    expect(h.game().guesses).toEqual([]);
    const held = h.net.pending.filter((e) => e.kind === 'to-host');
    expect(held.map((e) => e.msg?.t)).toEqual(['guess', 'guess', 'guess']);
    for (const ev of held.slice().reverse()) {
      expect(h.net.deliverWhere((e) => e === ev)).toBe(1);
    }
    // The host has resolved, but nobody has been told yet.
    expect(h.game().phase).toBe('round-result');
    expect(h.gameView(1).phase).toBe('guess');
    h.net.resume();
    for (let i = 0; i < 4; i++) expect(h.gameView(i).phase).toBe('round-result');
    expect(h.game().rounds[0].guesses.map((x) => x.guess)).toEqual(['first', word, 'third']);
  });

  test('the round does not resolve until the last guess is in, and nobody sees a guess early', async () => {
    const h = await setup({ players: 4 });
    await toGuessPhase(h);
    h.clients[3].submitGuess('secretguessone');
    h.clients[1].submitGuess('secretguesstwo');
    expect(h.game().phase).toBe('handoff-guesser');
    expect(h.game().guesses).toEqual([]);
    for (let i = 0; i < 4; i++) {
      const json = JSON.stringify(h.view(i));
      expect(json.includes('secretguessone')).toBe(i === 3);
      expect(json.includes('secretguesstwo')).toBe(i === 1);
      expect(h.gameView(i).guessStatus.map((s) => s.status)).toEqual(['submitted', 'pending', 'submitted']);
    }
    h.clients[2].submitGuess('secretguessthree');
    for (let i = 0; i < 4; i++) {
      const json = JSON.stringify(h.view(i));
      expect(json).toContain('secretguessone');
      expect(json).toContain('secretguessthree');
    }
  });

  test('guesses are normalised like in pass-and-play; a plural still counts', async () => {
    const h = await setup({ players: 3 });
    const { word } = await toGuessPhase(h);
    h.clients[1].submitGuess(`  ${word.toUpperCase()}S `);
    h.clients[2].submitGuess('Nope');
    expect(h.game().rounds[0].guesses).toEqual([
      { playerId: 'p2', guess: `${word}s`, correct: true },
      { playerId: 'p3', guess: 'nope', correct: false },
    ]);
  });

  test('list mode refuses a guess that is not one of the options', async () => {
    const h = await setup({ players: 2, settings: settings({ guessMode: 'list' }) });
    const { word } = await toGuessPhase(h);
    h.clients[1].submitGuess('zzwrong');
    expect(h.game().phase).toBe('handoff-guesser');
    expect(h.gameView(1).yourGuess).toBeNull();
    h.clients[1].submitGuess(word);
    expect(h.game().phase).toBe('round-result');
  });
});

describe('continuing', () => {
  test("by default only the host's continue counts", async () => {
    const h = await setup({ players: 3 });
    await toGuessPhase(h);
    h.clients[1].submitGuess('xa');
    h.clients[2].submitGuess('xb');
    expect(h.gameView(1).canContinue).toBe(false);
    h.clients[1].next();
    expect(h.game().phase).toBe('round-result');
    h.clients[0].next();
    expect(h.game().phase).toBe('clue');
  });

  test("continueBy 'anyone': two players tapping at once advance exactly one screen", async () => {
    const h = await setup({ players: 3, continueBy: 'anyone' });
    const { word } = await toGuessPhase(h);
    h.clients[1].submitGuess(word);
    h.clients[2].submitGuess('xb');
    expect(h.gameView(2).canContinue).toBe(true);
    h.net.pause();
    h.clients[1].next();
    h.clients[2].next();
    h.net.resume();
    // Both carried the same step: the second is stale and the turn-result screen is not skipped.
    expect(h.game().phase).toBe('turn-result');
    h.clients[2].next();
    expect(h.gameView(0).phase).toBe('choose-word');
    expect(h.gameView(0).turnNumber).toBe(2);
  });
});

describe('play again', () => {
  test('the host returns everyone to the lobby and a new game gets a new deal', async () => {
    const h = await setup({ players: 2, settings: settings({ turnsPerPlayer: 1 }) });
    const firstOptions = h.game().options;
    for (let t = 0; t < 2; t++) {
      const { word } = await toGuessPhase(h);
      h.clients[(h.giverIndex() + 1) % 2].submitGuess(word);
      h.clients[0].next();
      h.clients[0].next();
    }
    expect(h.gameView(1).phase).toBe('game-over');
    expect(h.view(0).host?.canPlayAgain).toBe(true);
    expect(h.view(1).players.map((p) => p.score)).toEqual([1, 1]);
    h.clients[1].playAgain(); // not the host: ignored
    expect(h.view(1).stage).toBe('game');
    h.clients[0].playAgain();
    for (let i = 0; i < 2; i++) {
      expect(h.view(i).stage).toBe('lobby');
      expect(h.view(i).game).toBeNull();
      expect(h.view(i).players.map((p) => [p.name, p.score, p.id])).toEqual([
        ['Host', 0, null],
        ['P2', 0, null],
      ]);
    }
    await h.start();
    expect(h.gameView(1).phase).toBe('choose-word');
    expect(h.game().seed).toBe(SEED + 1);
    expect(h.game().options).not.toEqual(firstOptions);
    await flush();
  });
});
