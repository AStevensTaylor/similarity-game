/**
 * Per-player projection of the host's authoritative state.
 *
 * `projectView(state, seat)` is pure. It is the ONLY place that decides what a
 * player may see, and every player - including the host's own - receives nothing
 * else. Rules:
 *  - the hidden word, the giver's five options, rejected clue attempts (and their
 *    scores) and the tried-clue list go to the giver only (`game.giver`);
 *  - in 'list' guess mode guessers get the turn's shuffled options
 *    (`game.guessOptions`); in 'open' mode they get no options at all;
 *  - a guess is private to its author (`game.yourGuess`) until the round resolves;
 *    everyone only sees who has submitted (`game.guessStatus`);
 *  - resolved rounds (`game.rounds`) and the turn summary (`game.turnSummary`,
 *    which reveals the hidden word) are public.
 */
import {
  copyLink,
  FORFEIT_AFTER_REJECTIONS,
  GIVER_REWARDS,
  MAX_CLUE_ROUNDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
} from '../game';
import type { ClueAttempt, GameSettings, GameState, RoundRecord, TurnSummary } from '../game';
import { MAX_REJECTED_IN_VIEW, MAX_TRIED_IN_VIEW } from './protocol';

/** Who may tap "continue" on the round-result / turn-result screens. */
export type ContinueBy = 'host' | 'anyone';

export interface SessionSeat {
  /** Stable id of the seat for the lifetime of the host session (never reused). */
  seat: number;
  name: string;
  connected: boolean;
  isHost: boolean;
}

/**
 * Everything the host knows that is relevant to a view. Plain JSON. Reconnect
 * tokens are deliberately NOT part of it, so they cannot leak through a view.
 */
export interface SessionState {
  stage: 'lobby' | 'game';
  /** In the 'game' stage seats[i] is engine player i (game.players[i]). */
  seats: SessionSeat[];
  /** Lobby: the host's current settings. Game: the settings the game was created with. */
  settings: GameSettings;
  game: GameState | null;
  /**
   * Incremented on every game change that all seats can see; echoed by the
   * 'next' message to make it idempotent. NOT incremented for giver-only
   * changes (a rejected clue), so guessers cannot count them.
   */
  step: number;
  /**
   * Guesses buffered in the current guess round, keyed by engine player id.
   * A string is the normalised guess; null means "skipped by the host".
   */
  pendingGuesses: Record<string, string | null>;
  /** True while the host is scoring a clue of the current giver. */
  scoring: boolean;
  continueBy: ContinueBy;
  /**
   * True once the game has waited for the current word / clue / guesses longer
   * than the host's idle limit. The host may then also skip or forfeit for
   * seats that are still connected. Absent means false.
   */
  idleExpired?: boolean;
}

export interface ViewPlayer {
  seat: number;
  /** Engine player id ('p1', ...) during a game - the id used in rounds / turnSummary; null in the lobby. */
  id: string | null;
  name: string;
  score: number;
  connected: boolean;
  isHost: boolean;
}

/** Network phases. The pass-and-play hand-off phases do not exist over the network. */
export type NetPhase = 'choose-word' | 'clue' | 'guess' | 'round-result' | 'turn-result' | 'game-over';

export interface GuessStatus {
  seat: number;
  status: 'pending' | 'submitted' | 'skipped';
}

/** Giver-only information. */
export interface GiverView {
  /** The five options, in the giver's order. */
  options: string[];
  hiddenWord: string | null;
  /** Clues rejected in the current clue round, with their scores. */
  rejected: ClueAttempt[];
  /** Every clue tried this turn (accepted or rejected), normalised. */
  triedClues: string[];
  rejectionsUntilForfeit: number;
  canForfeit: boolean;
  /** True while the host is scoring a submitted clue. */
  scoring: boolean;
}

export interface GameView {
  /** Pass back in next(): a continue for an older step is ignored. */
  step: number;
  phase: NetPhase;
  /** 1-based. */
  turnNumber: number;
  totalTurns: number;
  /** 1-based clue round within the turn. */
  clueRound: number;
  giverSeat: number;
  role: 'giver' | 'guesser';
  /** Accepted clues of the turn so far (public). */
  acceptedClues: ClueAttempt[];
  /** 'list' mode, guessers only: the shuffled options. Null in 'open' mode and for the giver. */
  guessOptions: string[] | null;
  /** One entry per guesser, in guessing order. Empty outside the 'guess' phase. */
  guessStatus: GuessStatus[];
  /** Your own guess in the running guess round, once submitted; null otherwise. */
  yourGuess: string | null;
  /** Present only when you are the giver. */
  giver: GiverView | null;
  /** Resolved rounds of the current turn, including everyone's guesses (public). */
  rounds: RoundRecord[];
  giverTurnPoints: number;
  /** The giver's cumulative turn total if the current round fails. */
  rewardIfRoundFails: number;
  /** Set in 'turn-result' and 'game-over'; reveals the hidden word. */
  turnSummary: TurnSummary | null;
  /** True when you may call next() now. */
  canContinue: boolean;
}

/** Host-only controls; null for everybody else. */
export interface HostControls {
  /** Lobby: 2-8 connected players are present. */
  canStart: boolean;
  /** Lobby: seats the host may remove (everyone but the host). */
  removableSeats: number[];
  /** Guess phase: guessers whose pending guess may be skipped (disconnected, or connected but idle for too long). */
  skippableSeats: number[];
  /** The giver is disconnected (or connected but idle for too long) and their turn can be forfeited now. */
  canForfeitGiver: boolean;
  /** Game over: the host may return everyone to the lobby. */
  canPlayAgain: boolean;
}

export interface PlayerView {
  stage: 'lobby' | 'game';
  you: { seat: number; name: string; isHost: boolean };
  /** Lobby: everyone in the lobby, in join order. Game: the players in seating (engine) order. */
  players: ViewPlayer[];
  settings: GameSettings;
  minPlayers: number;
  maxPlayers: number;
  continueBy: ContinueBy;
  game: GameView | null;
  host: HostControls | null;
}

export function netPhase(game: GameState): NetPhase {
  switch (game.phase) {
    case 'handoff-giver':
      // Transient on the host (auto-revealed); mapped for completeness.
      return game.hiddenWord === null ? 'choose-word' : 'clue';
    case 'handoff-guesser':
    case 'guess':
      return 'guess';
    default:
      return game.phase;
  }
}

const copyClue = (c: ClueAttempt): ClueAttempt =>
  c.link ? { clue: c.clue, score: c.score, link: copyLink(c.link) } : { clue: c.clue, score: c.score };

/** A clue without its word link: the link names the hidden word, so guessers must not see it mid-turn. */
const clueWithoutLink = (c: ClueAttempt): ClueAttempt => ({ clue: c.clue, score: c.score });

function copyRound(r: RoundRecord, withLink = true): RoundRecord {
  return {
    round: r.round,
    clue: r.clue,
    score: r.score,
    ...(r.link && withLink ? { link: copyLink(r.link) } : {}),
    guesses: r.guesses.map((g) => ({ ...g })),
    anyCorrect: r.anyCorrect,
    correctGuesserIds: r.correctGuesserIds.slice(),
    giverPointsAwarded: r.giverPointsAwarded,
  };
}

function copySummary(t: TurnSummary): TurnSummary {
  return { ...t, correctGuesserIds: t.correctGuesserIds.slice(), clues: t.clues.map(copyClue) };
}

/** Number of connected seats; the lobby can start when this is within MIN_PLAYERS..MAX_PLAYERS. */
export function connectedCount(state: SessionState): number {
  return state.seats.filter((s) => s.connected).length;
}

export function canStartGame(state: SessionState): boolean {
  const n = connectedCount(state);
  return state.stage === 'lobby' && n >= MIN_PLAYERS && n <= MAX_PLAYERS;
}

/**
 * Seats of guessers that have neither guessed nor been skipped in the running
 * guess round and that the host may skip: disconnected ones at once, connected
 * ones (never the host's own) only after the idle limit.
 */
export function skippableSeats(state: SessionState): number[] {
  const game = state.game;
  if (state.stage !== 'game' || !game || netPhase(game) !== 'guess') return [];
  const out: number[] = [];
  for (const index of game.guesserOrder) {
    const seat = state.seats[index];
    const id = game.players[index].id;
    if (!seat || id in state.pendingGuesses) continue;
    if (!seat.connected || (state.idleExpired === true && !seat.isHost)) out.push(seat.seat);
  }
  return out;
}

/**
 * True when the engine is waiting for the giver (choosing or giving a clue) and
 * the host may end their turn: the giver is disconnected, or is connected (and
 * not the host) but has been idle past the limit with no clue being scored.
 */
export function canForfeitGiver(state: SessionState): boolean {
  const game = state.game;
  if (state.stage !== 'game' || !game) return false;
  const phase = netPhase(game);
  if (phase !== 'choose-word' && phase !== 'clue') return false;
  const seat = state.seats[game.giverIndex];
  if (seat === undefined) return false;
  return !seat.connected || (state.idleExpired === true && !state.scoring && !seat.isHost);
}

function projectGame(state: SessionState, game: GameState, playerIndex: number, isHost: boolean): GameView {
  const phase = netPhase(game);
  const isGiver = playerIndex === game.giverIndex;
  const me = game.players[playerIndex];
  const listMode = game.settings.guessMode === 'list';

  const guessStatus: GuessStatus[] =
    phase === 'guess'
      ? game.guesserOrder.map((index) => {
          const id = game.players[index].id;
          const pending = state.pendingGuesses[id];
          return {
            seat: state.seats[index].seat,
            status: pending === undefined ? 'pending' : pending === null ? 'skipped' : 'submitted',
          };
        })
      : [];

  const mine = phase === 'guess' && !isGiver ? state.pendingGuesses[me.id] : undefined;
  const awaitingContinue = phase === 'round-result' || phase === 'turn-result';
  // A word link contains the hidden word: only the giver sees links before the word is revealed.
  const showLinks = isGiver || phase === 'turn-result' || phase === 'game-over';

  return {
    step: state.step,
    phase,
    turnNumber: Math.min(game.turnIndex + 1, game.totalTurns),
    totalTurns: game.totalTurns,
    clueRound: game.clueRound,
    giverSeat: state.seats[game.giverIndex].seat,
    role: isGiver ? 'giver' : 'guesser',
    acceptedClues: game.acceptedClues.map(showLinks ? copyClue : clueWithoutLink),
    guessOptions: listMode && !isGiver && phase !== 'game-over' ? game.guessOptions.slice() : null,
    guessStatus,
    yourGuess: typeof mine === 'string' ? mine : null,
    giver:
      isGiver && phase !== 'game-over'
        ? {
            options: game.options.slice(),
            hiddenWord: game.hiddenWord,
            // Only the latest ones, so a view can never exceed what the client's validator accepts.
            rejected: game.rejectedThisRound.slice(-MAX_REJECTED_IN_VIEW).map(copyClue),
            triedClues: game.triedClues.slice(-MAX_TRIED_IN_VIEW),
            rejectionsUntilForfeit: Math.max(0, FORFEIT_AFTER_REJECTIONS - game.rejectedThisRound.length),
            canForfeit: phase === 'clue' && game.rejectedThisRound.length >= FORFEIT_AFTER_REJECTIONS,
            scoring: state.scoring,
          }
        : null,
    rounds: game.rounds.map((r) => copyRound(r, showLinks)),
    giverTurnPoints: game.giverTurnPoints,
    rewardIfRoundFails: GIVER_REWARDS[Math.min(game.clueRound, MAX_CLUE_ROUNDS) - 1],
    turnSummary:
      (phase === 'turn-result' || phase === 'game-over') && game.turnSummary ? copySummary(game.turnSummary) : null,
    canContinue: awaitingContinue && (isHost || state.continueBy === 'anyone'),
  };
}

/**
 * The view for one seat. Throws when the seat does not exist (the host only
 * projects for seats it knows).
 */
export function projectView(state: SessionState, seat: number): PlayerView {
  const index = state.seats.findIndex((s) => s.seat === seat);
  if (index < 0) throw new Error(`projectView: unknown seat ${seat}`);
  const you = state.seats[index];
  const game = state.stage === 'game' ? state.game : null;

  const players: ViewPlayer[] = state.seats.map((s, i) => ({
    seat: s.seat,
    id: game ? game.players[i].id : null,
    name: s.name,
    score: game ? game.players[i].score : 0,
    connected: s.connected,
    isHost: s.isHost,
  }));

  return {
    stage: state.stage,
    you: { seat: you.seat, name: you.name, isHost: you.isHost },
    players,
    settings: { ...(game ? game.settings : state.settings) },
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    continueBy: state.continueBy,
    game: game ? projectGame(state, game, index, you.isHost) : null,
    host: you.isHost
      ? {
          canStart: canStartGame(state),
          removableSeats: state.stage === 'lobby' ? state.seats.filter((s) => !s.isHost).map((s) => s.seat) : [],
          skippableSeats: skippableSeats(state),
          canForfeitGiver: canForfeitGiver(state),
          canPlayAgain: state.stage === 'game' && game !== null && game.phase === 'game-over',
        }
      : null,
  };
}
