/**
 * Pure game engine: createGame + gameReducer + selectors.
 *
 * Phase flow for one turn:
 *
 *   handoff-giver --REVEAL--> choose-word --CHOOSE_WORD--> clue
 *   clue --CLUE_REJECTED--> clue          (FORFEIT_TURN allowed after 5 rejections in the round)
 *   handoff-giver | choose-word | clue --ABANDON_TURN--> turn-result   (network play: giver dropped out)
 *   guess --SKIP_GUESS--> like SUBMIT_GUESS with a blank, wrong guess  (network play: guesser dropped out)
 *   clue --CLUE_ACCEPTED--> handoff-guesser --REVEAL--> guess --SUBMIT_GUESS-->
 *        handoff-guesser (next guesser) | round-result (all guessers done; points credited)
 *   round-result --NEXT--> turn-result            (somebody correct, or last round failed)
 *                        | handoff-giver          (round failed, rounds remain; REVEAL then goes to 'clue')
 *   turn-result --NEXT--> handoff-giver (next giver, new options) | game-over
 *
 * Any action that is not valid for the current phase returns the SAME state object.
 */
import { isCorrectGuess, normalizeWord } from './clues';
import {
  FORFEIT_AFTER_REJECTIONS,
  GIVER_REWARDS,
  MAX_CLUE_ROUNDS,
  MAX_PLAYERS,
  MAX_THRESHOLD,
  MAX_TURNS_PER_PLAYER,
  MIN_PLAYERS,
  MIN_THRESHOLD,
  MIN_TURNS_PER_PLAYER,
  OPTIONS_PER_TURN,
} from './types';
import type {
  GameAction,
  GameSettings,
  GameState,
  Guess,
  Player,
  RankedPlayer,
  RoundRecord,
  TurnOutcome,
  TurnSummary,
} from './types';

// ---------------------------------------------------------------------------
// PRNG (mulberry32). The state is a uint32 stored in GameState.rngState.
// ---------------------------------------------------------------------------

/** One mulberry32 step: returns a float in [0, 1) and the next state. */
export function nextRandom(rngState: number): { value: number; rngState: number } {
  const a = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, rngState: a >>> 0 };
}

/** Fisher-Yates shuffle of a copy of items. */
function shuffle<T>(items: readonly T[], rngState: number): { result: T[]; rngState: number } {
  const result = items.slice();
  let s = rngState;
  for (let i = result.length - 1; i > 0; i--) {
    const r = nextRandom(s);
    s = r.rngState;
    const j = Math.floor(r.value * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return { result, rngState: s };
}

/** Picks count distinct items from pool (count <= pool.length). */
function sample<T>(pool: readonly T[], count: number, rngState: number): { result: T[]; rngState: number } {
  const work = pool.slice();
  let s = rngState;
  const n = Math.min(count, work.length);
  for (let i = 0; i < n; i++) {
    const r = nextRandom(s);
    s = r.rngState;
    const j = i + Math.floor(r.value * (work.length - i));
    const tmp = work[i];
    work[i] = work[j];
    work[j] = tmp;
  }
  return { result: work.slice(0, n), rngState: s };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueWords(deck: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of deck) {
    const w = normalizeWord(raw);
    if (w.length > 0 && !seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/** Clamps settings into their legal ranges (turnsPerPlayer 1-5, threshold 0.80-0.99 in 0.01 steps). */
export function sanitizeSettings(settings: GameSettings): GameSettings {
  const turns = Number.isFinite(settings.turnsPerPlayer) ? Math.round(settings.turnsPerPlayer) : MIN_TURNS_PER_PLAYER;
  const threshold = Number.isFinite(settings.threshold) ? settings.threshold : MAX_THRESHOLD;
  return {
    turnsPerPlayer: Math.min(MAX_TURNS_PER_PLAYER, Math.max(MIN_TURNS_PER_PLAYER, turns)),
    threshold: Math.round(Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, threshold)) * 100) / 100,
    guessMode: settings.guessMode === 'list' ? 'list' : 'open',
    requireDictionaryNoun: settings.requireDictionaryNoun !== false,
  };
}

interface Deal {
  options: string[];
  guessOptions: string[];
  usedWords: string[];
  rngState: number;
}

/**
 * Deals OPTIONS_PER_TURN words not offered before in this game. If fewer than
 * that remain unused, the remaining unused words are all dealt and the rest
 * come from the recycled deck (the used list starts over).
 */
function dealOptions(deck: readonly string[], usedWords: readonly string[], rngState: number): Deal {
  const words = uniqueWords(deck);
  const used = new Set(usedWords);
  const fresh = words.filter((w) => !used.has(w));

  let options: string[];
  let nextUsed: string[];
  let s = rngState;

  if (fresh.length >= OPTIONS_PER_TURN) {
    const picked = sample(fresh, OPTIONS_PER_TURN, s);
    options = picked.result;
    s = picked.rngState;
    nextUsed = [...usedWords, ...options];
  } else {
    const freshSet = new Set(fresh);
    const recycled = words.filter((w) => !freshSet.has(w));
    const picked = sample(recycled, OPTIONS_PER_TURN - fresh.length, s);
    const mixed = shuffle([...fresh, ...picked.result], picked.rngState);
    options = mixed.result;
    s = mixed.rngState;
    nextUsed = options.slice();
  }

  const forGuessers = shuffle(options, s);
  return { options, guessOptions: forGuessers.result, usedWords: nextUsed, rngState: forGuessers.rngState };
}

function guesserOrderFor(giverIndex: number, playerCount: number): number[] {
  const order: number[] = [];
  for (let i = 1; i < playerCount; i++) {
    order.push((giverIndex + i) % playerCount);
  }
  return order;
}

function addPoints(players: readonly Player[], points: ReadonlyMap<string, number>): Player[] {
  return players.map((p) => {
    const extra = points.get(p.id) ?? 0;
    return extra === 0 ? p : { ...p, score: p.score + extra };
  });
}

function summarize(
  state: GameState,
  outcome: TurnOutcome,
  rounds: readonly RoundRecord[],
  giverPoints: number,
): TurnSummary {
  const last = rounds.length > 0 ? rounds[rounds.length - 1] : null;
  return {
    giverId: state.players[state.giverIndex].id,
    hiddenWord: state.hiddenWord ?? '',
    outcome,
    roundsPlayed: rounds.length,
    giverPoints,
    correctGuesserIds: outcome === 'guessed' && last ? last.correctGuesserIds.slice() : [],
    clues: state.acceptedClues.map((c) => ({ clue: c.clue, score: c.score })),
  };
}

// ---------------------------------------------------------------------------
// createGame
// ---------------------------------------------------------------------------

/**
 * Creates a new game. Blank player names become "Player N". Throws if the
 * player count is outside MIN_PLAYERS..MAX_PLAYERS or the deck has fewer than
 * OPTIONS_PER_TURN distinct words.
 */
export function createGame(
  playerNames: string[],
  settings: GameSettings,
  deck: readonly string[],
  seed: number,
): GameState {
  if (playerNames.length < MIN_PLAYERS || playerNames.length > MAX_PLAYERS) {
    throw new Error(`A game needs ${MIN_PLAYERS}-${MAX_PLAYERS} players (got ${playerNames.length}).`);
  }
  if (uniqueWords(deck).length < OPTIONS_PER_TURN) {
    throw new Error(`The deck needs at least ${OPTIONS_PER_TURN} distinct words.`);
  }

  const cleanSettings = sanitizeSettings(settings);
  const players: Player[] = playerNames.map((name, i) => ({
    id: `p${i + 1}`,
    name: name.trim().length > 0 ? name.trim() : `Player ${i + 1}`,
    score: 0,
  }));

  const normalizedSeed = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
  const deal = dealOptions(deck, [], normalizedSeed);

  return {
    phase: 'handoff-giver',
    players,
    settings: cleanSettings,
    giverIndex: 0,
    turnIndex: 0,
    totalTurns: players.length * cleanSettings.turnsPerPlayer,
    options: deal.options,
    guessOptions: deal.guessOptions,
    hiddenWord: null,
    clueRound: 1,
    acceptedClues: [],
    rejectedThisRound: [],
    triedClues: [],
    guesserOrder: guesserOrderFor(0, players.length),
    guesserPos: 0,
    guesses: [],
    rounds: [],
    giverTurnPoints: 0,
    turnSummary: null,
    usedWords: deal.usedWords,
    seed: normalizedSeed,
    rngState: deal.rngState,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function resolveRound(state: GameState, guesses: Guess[]): GameState {
  const accepted = state.acceptedClues[state.acceptedClues.length - 1];
  const correctGuesserIds = guesses.filter((g) => g.correct).map((g) => g.playerId);
  const anyCorrect = correctGuesserIds.length > 0;

  const points = new Map<string, number>();
  let giverPointsAwarded = 0;
  if (anyCorrect) {
    for (const id of correctGuesserIds) points.set(id, 1);
  } else {
    const total = GIVER_REWARDS[state.clueRound - 1] ?? state.giverTurnPoints;
    giverPointsAwarded = Math.max(0, total - state.giverTurnPoints);
    points.set(state.players[state.giverIndex].id, giverPointsAwarded);
  }

  const record: RoundRecord = {
    round: state.clueRound,
    clue: accepted.clue,
    score: accepted.score,
    guesses,
    anyCorrect,
    correctGuesserIds,
    giverPointsAwarded,
  };

  return {
    ...state,
    phase: 'round-result',
    players: addPoints(state.players, points),
    guesses,
    rounds: [...state.rounds, record],
    giverTurnPoints: state.giverTurnPoints + giverPointsAwarded,
  };
}

function startNextTurn(state: GameState, deck: readonly string[]): GameState {
  const turnIndex = state.turnIndex + 1;
  if (turnIndex >= state.totalTurns) {
    return { ...state, phase: 'game-over' };
  }
  const giverIndex = turnIndex % state.players.length;
  const deal = dealOptions(deck, state.usedWords, state.rngState);
  return {
    ...state,
    phase: 'handoff-giver',
    giverIndex,
    turnIndex,
    options: deal.options,
    guessOptions: deal.guessOptions,
    hiddenWord: null,
    clueRound: 1,
    acceptedClues: [],
    rejectedThisRound: [],
    triedClues: [],
    guesserOrder: guesserOrderFor(giverIndex, state.players.length),
    guesserPos: 0,
    guesses: [],
    rounds: [],
    giverTurnPoints: 0,
    turnSummary: null,
    usedWords: deal.usedWords,
    rngState: deal.rngState,
  };
}

/**
 * Pure reducer. `deck` is only read when a new turn starts. Actions that are
 * not valid in the current phase (or carry invalid payloads) return the same
 * state object, so callers can detect a no-op with `next === state`.
 */
export function gameReducer(state: GameState, action: GameAction, deck: readonly string[]): GameState {
  switch (action.type) {
    case 'REVEAL': {
      if (state.phase === 'handoff-giver') {
        return { ...state, phase: state.hiddenWord === null ? 'choose-word' : 'clue' };
      }
      if (state.phase === 'handoff-guesser') {
        return { ...state, phase: 'guess' };
      }
      return state;
    }

    case 'CHOOSE_WORD': {
      if (state.phase !== 'choose-word' || typeof action.word !== 'string') return state;
      const word = normalizeWord(action.word);
      if (!state.options.includes(word)) return state;
      return { ...state, phase: 'clue', hiddenWord: word };
    }

    case 'CLUE_REJECTED':
    case 'CLUE_ACCEPTED': {
      if (state.phase !== 'clue' || state.hiddenWord === null) return state;
      if (typeof action.clue !== 'string' || typeof action.score !== 'number' || !Number.isFinite(action.score)) {
        return state;
      }
      const clue = normalizeWord(action.clue);
      if (clue.length === 0 || state.triedClues.includes(clue)) return state;
      const passes = action.score >= state.settings.threshold;

      if (action.type === 'CLUE_REJECTED') {
        // A clue that reaches the threshold is not a rejection.
        if (passes) return state;
        return {
          ...state,
          rejectedThisRound: [...state.rejectedThisRound, { clue, score: action.score }],
          triedClues: [...state.triedClues, clue],
        };
      }

      if (!passes) return state;
      return {
        ...state,
        phase: 'handoff-guesser',
        acceptedClues: [...state.acceptedClues, { clue, score: action.score }],
        rejectedThisRound: [],
        triedClues: [...state.triedClues, clue],
        guesserPos: 0,
        guesses: [],
      };
    }

    case 'FORFEIT_TURN': {
      if (!canForfeit(state)) return state;
      return {
        ...state,
        phase: 'turn-result',
        turnSummary: summarize(state, 'forfeit', state.rounds, state.giverTurnPoints),
      };
    }

    case 'SUBMIT_GUESS': {
      if (state.phase !== 'guess' || state.hiddenWord === null || typeof action.guess !== 'string') return state;
      const guess = normalizeWord(action.guess);
      if (guess.length === 0) return state;
      if (state.settings.guessMode === 'list' && !state.options.includes(guess)) return state;

      const guesser = state.players[state.guesserOrder[state.guesserPos]];
      const guesses: Guess[] = [
        ...state.guesses,
        { playerId: guesser.id, guess, correct: isCorrectGuess(guess, state.hiddenWord) },
      ];
      if (state.guesserPos + 1 < state.guesserOrder.length) {
        return { ...state, phase: 'handoff-guesser', guesserPos: state.guesserPos + 1, guesses };
      }
      return resolveRound(state, guesses);
    }

    case 'SKIP_GUESS': {
      if (state.phase !== 'guess' || state.hiddenWord === null) return state;
      const guesser = state.players[state.guesserOrder[state.guesserPos]];
      const guesses: Guess[] = [...state.guesses, { playerId: guesser.id, guess: '', correct: false, skipped: true }];
      if (state.guesserPos + 1 < state.guesserOrder.length) {
        return { ...state, phase: 'handoff-guesser', guesserPos: state.guesserPos + 1, guesses };
      }
      return resolveRound(state, guesses);
    }

    case 'ABANDON_TURN': {
      if (state.phase !== 'handoff-giver' && state.phase !== 'choose-word' && state.phase !== 'clue') return state;
      return {
        ...state,
        phase: 'turn-result',
        turnSummary: summarize(state, 'forfeit', state.rounds, state.giverTurnPoints),
      };
    }

    case 'NEXT': {
      if (state.phase === 'round-result') {
        const last = state.rounds[state.rounds.length - 1];
        if (last.anyCorrect || state.clueRound >= MAX_CLUE_ROUNDS) {
          return {
            ...state,
            phase: 'turn-result',
            turnSummary: summarize(
              state,
              last.anyCorrect ? 'guessed' : 'not-guessed',
              state.rounds,
              state.giverTurnPoints,
            ),
          };
        }
        return {
          ...state,
          phase: 'handoff-giver',
          clueRound: state.clueRound + 1,
          rejectedThisRound: [],
          guesserPos: 0,
          guesses: [],
        };
      }
      if (state.phase === 'turn-result') {
        return startNextTurn(state, deck);
      }
      return state;
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function currentGiver(state: GameState): Player {
  return state.players[state.giverIndex];
}

/** The player whose guess is awaited; null outside 'handoff-guesser' / 'guess'. */
export function currentGuesser(state: GameState): Player | null {
  if (state.phase !== 'handoff-guesser' && state.phase !== 'guess') return null;
  const index = state.guesserOrder[state.guesserPos];
  return index === undefined ? null : state.players[index];
}

/** True when the giver may forfeit: in 'clue' with FORFEIT_AFTER_REJECTIONS rejections this round. */
export function canForfeit(state: GameState): boolean {
  return state.phase === 'clue' && state.rejectedThisRound.length >= FORFEIT_AFTER_REJECTIONS;
}

/** How many more rejections are needed before forfeiting becomes available. */
export function rejectionsUntilForfeit(state: GameState): number {
  return Math.max(0, FORFEIT_AFTER_REJECTIONS - state.rejectedThisRound.length);
}

/** Options as a guesser should see them: the turn's fixed shuffled list in 'list' mode, null in 'open' mode. */
export function guesserOptions(state: GameState): string[] | null {
  return state.settings.guessMode === 'list' ? state.guessOptions : null;
}

/** The giver's cumulative turn total if the current round fails. */
export function giverRewardIfRoundFails(state: GameState): number {
  return GIVER_REWARDS[Math.min(state.clueRound, MAX_CLUE_ROUNDS) - 1];
}

export function isGameOver(state: GameState): boolean {
  return state.phase === 'game-over';
}

/** 1-based number of the current turn, for "Turn 3 of 8" displays. */
export function turnNumber(state: GameState): number {
  return Math.min(state.turnIndex + 1, state.totalTurns);
}

export function playerById(state: GameState, id: string): Player | null {
  return state.players.find((p) => p.id === id) ?? null;
}

/**
 * Players sorted by score (highest first; seating order breaks display ties)
 * with competition ranks: equal scores share a rank and the next rank skips
 * (1, 1, 3, ...).
 */
export function rankedPlayers(state: GameState): RankedPlayer[] {
  const sorted = state.players
    .map((p, index) => ({ p, index }))
    .sort((a, b) => b.p.score - a.p.score || a.index - b.index)
    .map(({ p }) => p);
  return sorted.map((p) => ({
    ...p,
    rank: 1 + sorted.filter((o) => o.score > p.score).length,
    tied: sorted.some((o) => o.id !== p.id && o.score === p.score),
  }));
}

/** The players with the top score (more than one on a tie). */
export function winners(state: GameState): Player[] {
  const top = Math.max(...state.players.map((p) => p.score));
  return state.players.filter((p) => p.score === top);
}
