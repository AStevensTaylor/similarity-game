import { describe, expect, test } from '@jest/globals';
import { createGame, gameReducer } from '../../game';
import type { GameAction, GameState, GuessMode } from '../../game';
import { parsePlayerView } from '../protocol';
import { canForfeitGiver, canStartGame, projectView, skippableSeats } from '../view';
import type { PlayerView, SessionState } from '../view';
import { DECK, settings } from './harness';

/** Seat ids are deliberately not 0..n-1 so seat/index mix-ups show up. */
const SEATS = [10, 11, 12, 13];
const NAMES = ['Ann', 'Bob', 'Cy', 'Di'];

function session(game: GameState | null, extra: Partial<SessionState> = {}): SessionState {
  return {
    stage: game ? 'game' : 'lobby',
    seats: SEATS.map((seat, i) => ({ seat, name: NAMES[i], connected: true, isHost: i === 0 })),
    settings: game ? game.settings : settings(),
    game,
    step: 5,
    pendingGuesses: {},
    scoring: false,
    continueBy: 'host',
    ...extra,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

interface Snap {
  label: string;
  state: SessionState;
}

/**
 * Walks one whole game (4 players, 1 turn each) through every engine phase -
 * including the hand-off phases the host normally skips - and records a session
 * state at each step. Turn 0 fails all three rounds, turn 1 is guessed in round
 * 2, turn 2 is forfeited after five rejections, turn 3 is guessed in round 1.
 */
function walk(guessMode: GuessMode): Snap[] {
  const snaps: Snap[] = [];
  let g = createGame(NAMES, settings({ guessMode, turnsPerPlayer: 1 }), DECK, 99);
  let n = 0;
  const unique = (prefix: string) => `${prefix}${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n++ / 26))}zz`;
  const act = (a: GameAction) => {
    const next = gameReducer(g, a, DECK);
    if (next === g) throw new Error(`action ${a.type} was a no-op in ${g.phase}`);
    g = next;
  };
  const snap = (label: string, extra: Partial<SessionState> = {}) => {
    snaps.push({ label: `${guessMode} t${g.turnIndex} r${g.clueRound} ${g.phase} ${label}`, state: session(g, extra) });
  };
  const wrongFor = (k: number) => (guessMode === 'open' ? unique('guess') : g.options.filter((o) => o !== g.hiddenWord)[k % 4]);

  /** Collects guesses "simultaneously" (buffered, as the host does), snapshotting every partial buffer. */
  const guessRound = (correct: boolean) => {
    const ids = g.guesserOrder.map((i) => g.players[i].id);
    const guesses = ids.map((_, k) => (correct && k === 1 ? (g.hiddenWord as string) : wrongFor(k)));
    const pending: Record<string, string | null> = {};
    snap('nobody guessed');
    // Arrival order differs from guessing order; the last one is skipped by the host.
    for (const k of [2, 0]) {
      pending[ids[k]] = guesses[k];
      snap(`buffered ${Object.keys(pending).length}`, { pendingGuesses: { ...pending } });
    }
    if (correct) pending[ids[1]] = guesses[1];
    else pending[ids[1]] = null;
    snap('all buffered', { pendingGuesses: { ...pending } });
    for (const id of ids) {
      act({ type: 'REVEAL' });
      snap('engine mid-apply', { pendingGuesses: { ...pending } });
      const guess = pending[id];
      act(guess === null ? { type: 'SKIP_GUESS' } : { type: 'SUBMIT_GUESS', guess });
    }
    snap('resolved');
  };

  const clueRound = (rejections: number) => {
    for (let i = 0; i < rejections; i++) {
      act({ type: 'CLUE_REJECTED', clue: unique('rej'), score: 0.4 + i / 100 });
      snap(`rejected ${i + 1}`, { scoring: i % 2 === 0 });
    }
  };

  for (let turn = 0; turn < 4; turn++) {
    snap('start');
    act({ type: 'REVEAL' });
    snap('choosing');
    act({ type: 'CHOOSE_WORD', word: g.options[turn % 5] });
    snap('chosen');
    if (turn === 2) {
      clueRound(5);
      act({ type: 'FORFEIT_TURN' });
    } else {
      const failedRounds = turn === 0 ? 3 : turn === 1 ? 1 : 0;
      for (let r = 0; r <= failedRounds && r < 3; r++) {
        clueRound(r + 1);
        act({ type: 'CLUE_ACCEPTED', clue: unique('acc'), score: 0.96 });
        guessRound(r === failedRounds);
        act({ type: 'NEXT' });
        if (g.phase === 'handoff-giver') {
          snap('between rounds');
          act({ type: 'REVEAL' });
          snap('next clue');
        }
      }
    }
    snap('turn over');
    act({ type: 'NEXT' });
  }
  snap('end');
  expect(g.phase).toBe('game-over');
  return snaps;
}

/** Every string a non-giver must not see, unless it has become public. */
function secretsOf(state: SessionState): { hidden: string | null; options: string[]; attempts: string[] } {
  const g = state.game as GameState;
  const accepted = new Set(g.acceptedClues.map((c) => c.clue));
  return {
    hidden: g.hiddenWord,
    options: g.options,
    // Clues that were tried but never accepted.
    attempts: g.triedClues.filter((c) => !accepted.has(c)),
  };
}

function publicWords(state: SessionState, view: PlayerView): Set<string> {
  const g = state.game as GameState;
  const words = new Set<string>();
  // Guesses of resolved rounds are public (that is how a correct guess reveals the word).
  for (const r of g.rounds) for (const guess of r.guesses) words.add(guess.guess);
  if ((g.phase === 'turn-result' || g.phase === 'game-over') && g.turnSummary) words.add(g.turnSummary.hiddenWord);
  // 'list' mode: guessers get the shuffled options, exactly as in pass-and-play.
  if (g.settings.guessMode === 'list' && view.game?.role === 'guesser' && g.phase !== 'game-over') {
    for (const o of g.guessOptions) words.add(o);
  }
  return words;
}

describe.each(['open', 'list'] as const)('projectView leak check (%s mode)', (mode) => {
  const snaps = walk(mode);

  test('the walk covers every engine phase', () => {
    const phases = new Set(snaps.map((s) => (s.state.game as GameState).phase));
    expect([...phases].sort()).toEqual(
      ['choose-word', 'clue', 'game-over', 'guess', 'handoff-giver', 'handoff-guesser', 'round-result', 'turn-result'].sort(),
    );
    expect(snaps.length).toBeGreaterThan(80);
  });

  test('no non-giver view ever contains the hidden word, private options, rejected attempts or other guesses', () => {
    let checkedHidden = 0;
    let checkedGuesses = 0;
    for (const { label, state } of snaps) {
      const g = state.game as GameState;
      const secrets = secretsOf(state);
      for (let i = 0; i < SEATS.length; i++) {
        if (i === g.giverIndex) continue;
        const view = projectView(state, SEATS[i]);
        const json = JSON.stringify(view);
        const allowed = publicWords(state, view);
        // A guesser naturally sees their own buffered guess (which may happen to be the word).
        const own = state.pendingGuesses[g.players[i].id];
        if (typeof own === 'string') allowed.add(own);
        const where = `${label}, seat ${SEATS[i]}`;

        expect(view.game?.giver).toBeNull();
        if (secrets.hidden !== null && !allowed.has(secrets.hidden)) {
          checkedHidden++;
          if (json.includes(secrets.hidden)) throw new Error(`hidden word leaked: ${where}`);
        }
        // In 'list' mode the hidden word may only appear as one option among five, never singled out.
        if (secrets.hidden !== null && mode === 'list') {
          const publicElsewhere =
            own === secrets.hidden ||
            g.rounds.some((r) => r.guesses.some((x) => x.guess === secrets.hidden)) ||
            ((g.phase === 'turn-result' || g.phase === 'game-over') && g.turnSummary !== null);
          const without = JSON.stringify({ ...view, game: { ...view.game, guessOptions: null } });
          if (!publicElsewhere) {
            checkedHidden++;
            if (without.includes(secrets.hidden)) throw new Error(`hidden word singled out: ${where}`);
          }
        }
        for (const option of secrets.options) {
          if (!allowed.has(option) && json.includes(option)) throw new Error(`option ${option} leaked: ${where}`);
        }
        for (const attempt of secrets.attempts) {
          if (json.includes(attempt)) throw new Error(`rejected attempt ${attempt} leaked: ${where}`);
        }
        // Buffered guesses: only your own.
        const myId = g.players[i].id;
        for (const [id, guess] of Object.entries(state.pendingGuesses)) {
          if (id === myId || guess === null) continue;
          checkedGuesses++;
          const body = JSON.stringify({ ...view, game: { ...view.game, guessOptions: null } });
          const alreadyPublic = g.rounds.some((r) => r.guesses.some((x) => x.guess === guess));
          if (!alreadyPublic && body.includes(guess)) throw new Error(`guess of ${id} leaked: ${where}`);
        }
        // Guesses already fed to the engine but not yet resolved (state.guesses) stay private too.
        if (g.phase === 'guess' || g.phase === 'handoff-guesser') {
          for (const pendingGuess of g.guesses) {
            if (pendingGuess.playerId === myId || pendingGuess.guess === '') continue;
            const body = JSON.stringify({ ...view, game: { ...view.game, guessOptions: null } });
            const alreadyPublic = g.rounds.some((r) => r.guesses.some((x) => x.guess === pendingGuess.guess));
            if (!alreadyPublic && body.includes(pendingGuess.guess)) throw new Error(`engine guess leaked: ${where}`);
          }
        }
        // Rejected-attempt scores are giver-only: no score below the threshold is anywhere in the view.
        const scores = json.match(/"score":0\.\d+/g) ?? [];
        for (const s of scores) expect(Number(s.split(':')[1])).toBeGreaterThanOrEqual(g.settings.threshold);
      }
    }
    expect(checkedHidden).toBeGreaterThan(100);
    expect(checkedGuesses).toBeGreaterThan(20);
  });

  test('guessers get options only in list mode; nobody but the giver gets the giver block', () => {
    for (const { state } of snaps) {
      const g = state.game as GameState;
      for (let i = 0; i < SEATS.length; i++) {
        const view = projectView(state, SEATS[i]).game!;
        const isGiver = i === g.giverIndex;
        expect(view.role).toBe(isGiver ? 'giver' : 'guesser');
        expect(view.giverSeat).toBe(SEATS[g.giverIndex]);
        if (isGiver) {
          expect(view.guessOptions).toBeNull();
          if (g.phase !== 'game-over') {
            expect(view.giver).toMatchObject({
              options: g.options,
              hiddenWord: g.hiddenWord,
              rejected: g.rejectedThisRound,
              triedClues: g.triedClues,
              scoring: state.scoring,
            });
          } else {
            expect(view.giver).toBeNull();
          }
        } else if (mode === 'list' && g.phase !== 'game-over') {
          expect(view.guessOptions).toEqual(g.guessOptions);
        } else {
          expect(view.guessOptions).toBeNull();
        }
      }
    }
  });

  test('guess status shows who has submitted, and yourGuess only to its author', () => {
    for (const { state } of snaps) {
      const g = state.game as GameState;
      const guessing = g.phase === 'guess' || g.phase === 'handoff-guesser';
      for (let i = 0; i < SEATS.length; i++) {
        const view = projectView(state, SEATS[i]).game!;
        if (!guessing) {
          expect(view.guessStatus).toEqual([]);
          expect(view.yourGuess).toBeNull();
          continue;
        }
        expect(view.phase).toBe('guess');
        expect(view.guessStatus.map((s) => s.seat)).toEqual(g.guesserOrder.map((p) => SEATS[p]));
        for (const s of view.guessStatus) {
          const id = g.players[SEATS.indexOf(s.seat)].id;
          const pending = state.pendingGuesses[id];
          expect(s.status).toBe(pending === undefined ? 'pending' : pending === null ? 'skipped' : 'submitted');
        }
        const mine = state.pendingGuesses[g.players[i].id];
        expect(view.yourGuess).toBe(typeof mine === 'string' && i !== g.giverIndex ? mine : null);
      }
    }
  });

  test('every projected view is plain JSON that passes the wire validator unchanged', () => {
    for (const { state } of snaps) {
      for (const seat of SEATS) {
        const view = projectView(state, seat);
        const wire: unknown = JSON.parse(JSON.stringify(view));
        expect(wire).toEqual(view);
        expect(parsePlayerView(wire)).toEqual(view);
      }
    }
  });

  test('is pure: frozen input, equal output on repeat, no shared references with the state', () => {
    for (const { state } of snaps) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(state)) as SessionState);
      const before = JSON.stringify(frozen);
      const a = projectView(frozen, SEATS[1]);
      const b = projectView(frozen, SEATS[1]);
      expect(a).toEqual(b);
      expect(JSON.stringify(frozen)).toBe(before);
      // Mutating a view must not be able to touch the state (the frozen input would throw).
      const g = frozen.game as GameState;
      const giverView = projectView(frozen, SEATS[g.giverIndex]);
      expect(() => {
        giverView.game!.giver?.options.push('x');
        giverView.game!.rounds.forEach((r) => r.guesses.push({ playerId: 'p1', guess: 'x', correct: false }));
        giverView.game!.acceptedClues.push({ clue: 'x', score: 1 });
        giverView.players.push({ seat: 99, id: null, name: 'x', score: 0, connected: true, isHost: false });
        giverView.settings.threshold = 0;
      }).not.toThrow();
      expect(JSON.stringify(frozen)).toBe(before);
    }
  });
});

describe('projectView basics', () => {
  test('lobby view', () => {
    const state = session(null);
    const v = projectView(state, 11);
    expect(v).toEqual({
      stage: 'lobby',
      you: { seat: 11, name: 'Bob', isHost: false },
      players: SEATS.map((seat, i) => ({ seat, id: null, name: NAMES[i], score: 0, connected: true, isHost: i === 0 })),
      settings: settings(),
      minPlayers: 2,
      maxPlayers: 8,
      continueBy: 'host',
      game: null,
      host: null,
    });
    expect(projectView(state, 10).host).toEqual({
      canStart: true,
      removableSeats: [11, 12, 13],
      skippableSeats: [],
      canForfeitGiver: false,
      canPlayAgain: false,
    });
  });

  test('an unknown seat throws', () => {
    expect(() => projectView(session(null), 99)).toThrow();
  });

  test('canStart needs 2-8 connected players', () => {
    const state = session(null);
    const only = (n: number): SessionState => ({
      ...state,
      seats: state.seats.map((s, i) => ({ ...s, connected: i < n })),
    });
    expect(canStartGame(only(1))).toBe(false);
    expect(canStartGame(only(2))).toBe(true);
    expect(projectView(only(1), 10).host?.canStart).toBe(false);
  });

  test('players carry engine ids and live scores during a game', () => {
    let g = createGame(NAMES, settings(), DECK, 1);
    g = { ...g, players: g.players.map((p, i) => ({ ...p, score: i * 2 })) };
    const v = projectView(session(g), 12);
    expect(v.players.map((p) => [p.seat, p.id, p.score])).toEqual([
      [10, 'p1', 0],
      [11, 'p2', 2],
      [12, 'p3', 4],
      [13, 'p4', 6],
    ]);
  });

  test('continue permission follows continueBy', () => {
    let g = createGame(NAMES, settings(), DECK, 1);
    for (const a of [
      { type: 'REVEAL' },
      { type: 'CHOOSE_WORD', word: g.options[0] },
      { type: 'CLUE_ACCEPTED', clue: 'hint', score: 0.99 },
      ...[1, 2, 3].flatMap(() => [{ type: 'REVEAL' }, { type: 'SUBMIT_GUESS', guess: 'nope' }]),
    ] as GameAction[]) {
      g = gameReducer(g, a, DECK);
    }
    expect(g.phase).toBe('round-result');
    expect(projectView(session(g), 10).game?.canContinue).toBe(true);
    expect(projectView(session(g), 11).game?.canContinue).toBe(false);
    expect(projectView(session(g, { continueBy: 'anyone' }), 11).game?.canContinue).toBe(true);
    const clue = gameReducer(gameReducer(g, { type: 'NEXT' }, DECK), { type: 'REVEAL' }, DECK);
    expect(projectView(session(clue, { continueBy: 'anyone' }), 10).game?.canContinue).toBe(false);
  });

  test('host controls: skippable guessers and forfeitable giver depend on who is disconnected', () => {
    let g = createGame(NAMES, settings(), DECK, 1);
    g = gameReducer(g, { type: 'REVEAL' }, DECK);
    const offline = (state: SessionState, ...seats: number[]): SessionState => ({
      ...state,
      seats: state.seats.map((s) => (seats.includes(s.seat) ? { ...s, connected: false } : s)),
    });
    // Seat 10 is giver (and host) in turn 0: use a state where player 2 gives instead.
    const turn2 = { ...g, giverIndex: 1, guesserOrder: [2, 3, 0] };
    expect(canForfeitGiver(session(turn2))).toBe(false);
    expect(canForfeitGiver(offline(session(turn2), 11))).toBe(true);
    expect(canForfeitGiver(offline(session(turn2), 12))).toBe(false);
    expect(projectView(offline(session(turn2), 11), 10).host?.canForfeitGiver).toBe(true);
    expect(projectView(offline(session(turn2), 11), 12).host).toBeNull();

    const guessing = { ...turn2, phase: 'handoff-guesser' as const, hiddenWord: turn2.options[0] };
    expect(canForfeitGiver(offline(session(guessing), 11))).toBe(false);
    expect(skippableSeats(session(guessing))).toEqual([]);
    expect(skippableSeats(offline(session(guessing), 12, 13, 11))).toEqual([12, 13]);
    expect(skippableSeats(offline(session(guessing, { pendingGuesses: { p3: 'x', p4: null } }), 12, 13))).toEqual([]);
    expect(skippableSeats(offline(session(turn2), 12))).toEqual([]);
  });
});
