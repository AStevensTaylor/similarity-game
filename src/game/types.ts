/**
 * Types and constants for the Similarity Game engine.
 *
 * Everything in GameState is plain JSON (no functions, classes, Sets, Maps or
 * undefined-valued keys) so the state can be persisted and restored verbatim.
 */

export type GuessMode = 'open' | 'list';

export interface GameSettings {
  /** How many times each player is the clue-giver (1-5). */
  turnsPerPlayer: number;
  /** Calibrated similarity score a clue must reach to be accepted (0.80-0.99). */
  threshold: number;
  guessMode: GuessMode;
  /** When true, a clue must be in the bundled noun dictionary. */
  requireDictionaryNoun: boolean;
  /**
   * When true, a clue below the threshold is still accepted if a dictionary
   * (WordNet / ConceptNet) links it to the hidden word, e.g. "root" is part of "tree".
   */
  useWordLinks: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  turnsPerPlayer: 2,
  threshold: 0.95,
  guessMode: 'open',
  requireDictionaryNoun: true,
  useWordLinks: true,
};

/**
 * Cumulative giver totals for a turn after 1, 2 and 3 failed guess rounds
 * (i.e. increments of +1, +1, +4).
 */
export const GIVER_REWARDS: readonly number[] = [1, 2, 6];
export const MAX_CLUE_ROUNDS = 3;
export const FORFEIT_AFTER_REJECTIONS = 5;
export const OPTIONS_PER_TURN = 5;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export const MIN_TURNS_PER_PLAYER = 1;
export const MAX_TURNS_PER_PLAYER = 5;
export const MIN_THRESHOLD = 0.8;
export const MAX_THRESHOLD = 0.99;

export type Phase =
  /** Device is being passed to the giver (start of turn, or between clue rounds). */
  | 'handoff-giver'
  /** Giver privately picks the hidden word from the 5 options. */
  | 'choose-word'
  /** Giver types clues until one is accepted (or forfeits). */
  | 'clue'
  /** Device is being passed to the current guesser. */
  | 'handoff-guesser'
  /** Current guesser privately submits one guess. */
  | 'guess'
  /** Public: all guesses of the round are revealed. */
  | 'round-result'
  /** Public: the hidden word and the turn's points are revealed. */
  | 'turn-result'
  | 'game-over';

export interface Player {
  id: string;
  name: string;
  score: number;
}

export const LINK_RELATIONS = [
  'synonym',
  'opposite',
  'kind',
  'part',
  'member',
  'material',
  'used-for',
  'cause',
  'found-at',
  'associated',
] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export const LINK_SOURCES = ['wordnet', 'conceptnet'] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];

/**
 * A dictionary link between two words. Directed relations read
 * "<from> <relation> <to>" ("root" is part of "tree"); for the symmetric ones
 * (synonym, opposite, associated) the order carries no meaning.
 */
export interface WordLink {
  relation: LinkRelation;
  from: string;
  to: string;
  sources: LinkSource[];
}

/** A clue attempt together with its calibrated similarity score. */
export interface ClueAttempt {
  clue: string;
  score: number;
  /** Present when the clue was accepted below the threshold because of this dictionary link. */
  link?: WordLink;
}

export interface Guess {
  playerId: string;
  /** Normalised (trimmed, lower-cased) guess text. */
  guess: string;
  correct: boolean;
  /**
   * Present (and true) only for a blank guess recorded with SKIP_GUESS, e.g. for a
   * network player who dropped out. A skipped guess has guess '' and is never correct.
   */
  skipped?: true;
}

/** One resolved clue round of the current turn. */
export interface RoundRecord {
  /** 1-based clue round number. */
  round: number;
  clue: string;
  score: number;
  /** Present when the clue was accepted below the threshold because of this dictionary link. */
  link?: WordLink;
  guesses: Guess[];
  anyCorrect: boolean;
  /** Ids of the guessers who were correct (each received +1). */
  correctGuesserIds: string[];
  /** Points credited to the giver when this round resolved (0 if somebody guessed). */
  giverPointsAwarded: number;
}

export type TurnOutcome =
  /** At least one guesser found the word. */
  | 'guessed'
  /** All MAX_CLUE_ROUNDS rounds failed; the giver earned the full reward. */
  | 'not-guessed'
  /** The giver forfeited the turn. */
  | 'forfeit';

export interface TurnSummary {
  giverId: string;
  hiddenWord: string;
  outcome: TurnOutcome;
  /** Number of resolved guess rounds in the turn. */
  roundsPlayed: number;
  /** Total points the giver earned this turn. */
  giverPoints: number;
  /** Guessers who got it right in the final round (each earned +1). */
  correctGuesserIds: string[];
  /** Every accepted clue of the turn, in order. */
  clues: ClueAttempt[];
}

export interface GameState {
  phase: Phase;
  players: Player[];
  settings: GameSettings;

  /** Index into players of the current clue-giver. */
  giverIndex: number;
  /** 0-based index of the current turn within the game. */
  turnIndex: number;
  /** players.length * settings.turnsPerPlayer. */
  totalTurns: number;

  /** The 5 words offered to the giver this turn (order shown to the giver). */
  options: string[];
  /** The same 5 words in the shuffled order shown to guessers in 'list' mode; fixed for the turn. */
  guessOptions: string[];
  /** Null until the giver has chosen. */
  hiddenWord: string | null;

  /** 1-based clue round within the turn (1..MAX_CLUE_ROUNDS). */
  clueRound: number;
  /** Accepted clues of the turn so far, one per started guess round. */
  acceptedClues: ClueAttempt[];
  /** Clues rejected in the current clue round (reset when a clue is accepted). */
  rejectedThisRound: ClueAttempt[];
  /** Every clue tried this turn (accepted or rejected), normalised; for duplicate checks. */
  triedClues: string[];

  /** Player indexes of the guessers, in the order they guess this turn. */
  guesserOrder: number[];
  /** Position within guesserOrder of the current guesser. */
  guesserPos: number;
  /** Guesses submitted so far in the current guess round. */
  guesses: Guess[];

  /** Resolved rounds of the current turn. */
  rounds: RoundRecord[];
  /** Points the giver has earned so far this turn. */
  giverTurnPoints: number;
  /** Set in 'turn-result' (and kept in 'game-over' for the last turn); null otherwise. */
  turnSummary: TurnSummary | null;

  /** Words already offered in this game. */
  usedWords: string[];
  /** The seed the game was created with. */
  seed: number;
  /** Current mulberry32 state (uint32); advanced only inside the reducer. */
  rngState: number;
}

export type GameAction =
  | { type: 'REVEAL' }
  | { type: 'CHOOSE_WORD'; word: string }
  | { type: 'CLUE_REJECTED'; clue: string; score: number }
  /**
   * `link`: a dictionary link between the clue and the hidden word. With
   * settings.useWordLinks on, it lets a clue below the threshold pass.
   */
  | { type: 'CLUE_ACCEPTED'; clue: string; score: number; link?: WordLink }
  | { type: 'FORFEIT_TURN' }
  | { type: 'SUBMIT_GUESS'; guess: string }
  /** Records a blank, wrong guess for the current guesser (both guess modes). Used by network play. */
  | { type: 'SKIP_GUESS' }
  /**
   * Ends the turn as a forfeit regardless of the rejection count, before or between
   * guess rounds (phases handoff-giver / choose-word / clue). Used by network play
   * when the clue-giver has dropped out. Points already earned are kept.
   */
  | { type: 'ABANDON_TURN' }
  | { type: 'NEXT' };

export type ClueRejectReason =
  | 'empty'
  | 'not-single-word'
  | 'invalid-characters'
  | 'too-short'
  | 'too-long'
  | 'matches-option'
  | 'contains-option'
  | 'variant-of-option'
  | 'already-tried'
  | 'not-a-noun';

export type ClueValidation =
  | { ok: true; clue: string }
  | { ok: false; reason: ClueRejectReason; message: string };

export interface ClueContext {
  /** The 5 words offered this turn. */
  options: readonly string[];
  /** Clues already tried this turn (accepted or rejected). */
  tried: readonly string[];
  requireDictionaryNoun: boolean;
  isNoun: (w: string) => boolean;
}

export interface RankedPlayer extends Player {
  /** 1-based competition rank: tied players share a rank (1, 1, 3, ...). */
  rank: number;
  /** True when at least one other player has the same score. */
  tied: boolean;
}
