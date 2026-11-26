/**
 * Wire protocol for local-network play: message types and runtime validators.
 *
 * Every message is one JSON object with a protocol version `v` and a type `t`
 * (the adapter frames them as newline-delimited JSON, at most MAX_LINE_BYTES per
 * line). Both sides run every inbound object through a parser here; the parsers
 * build a fresh, fully-typed object from validated fields only, so nothing from
 * the wire is ever used unchecked. Unknown keys are ignored.
 *
 * A client's seat is bound to its connection by the host after 'hello'; no
 * client message carries "who I am".
 */
import {
  copyLink,
  isWordLink,
  MAX_PLAYERS,
  MAX_THRESHOLD,
  MAX_TURNS_PER_PLAYER,
  MIN_PLAYERS,
  MIN_THRESHOLD,
  MIN_TURNS_PER_PLAYER,
  OPTIONS_PER_TURN,
} from '../game';
import type { ClueAttempt, ClueRejectReason, GameSettings, Guess, RoundRecord, TurnSummary, WordLink } from '../game';
import type { GameView, GiverView, GuessStatus, HostControls, NetPhase, PlayerView, ViewPlayer } from './view';

/** 2: word links (settings.useWordLinks, ClueAttempt.link / RoundRecord.link, ClueResult.link). */
export const PROTOCOL_VERSION = 2;
/** Maximum size of one serialised message (one line), in bytes. */
export const MAX_LINE_BYTES = 64 * 1024;
/** mDNS/Bonjour service type (i.e. _simgame._tcp). */
export const SERVICE_TYPE = 'simgame';

/** Display names: at most this many characters (same limit as pass-and-play). */
export const MAX_NAME_LENGTH = 16;
/** Raw length limit for typed words (clues, guesses, chosen word) on the wire. */
export const MAX_WORD_INPUT_LENGTH = 40;
export const MIN_TOKEN_LENGTH = 8;
export const MAX_TOKEN_LENGTH = 64;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_MESSAGE_TEXT = 300;
const MAX_SAFE = 1_000_000_000;

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** First message on a connection: join the lobby, or reclaim a seat with a known token. */
  | { v: number; t: 'hello'; name: string; token: string }
  | { v: number; t: 'ping'; n: number }
  | { v: number; t: 'pong'; n: number }
  /** Deliberate leave. */
  | { v: number; t: 'leave' }
  /** Host seat only. */
  | { v: number; t: 'start' }
  | { v: number; t: 'choose'; word: string }
  /** `id` is echoed in the matching clueResult. */
  | { v: number; t: 'clue'; id: number; clue: string }
  | { v: number; t: 'forfeit' }
  | { v: number; t: 'guess'; guess: string }
  /** `step` must equal the current GameView.step. */
  | { v: number; t: 'next'; step: number }
  /** Host seat only: record a blank guess for a disconnected guesser. */
  | { v: number; t: 'skip'; seat: number }
  /** Host seat only: forfeit the turn of a disconnected giver. */
  | { v: number; t: 'forfeitGiver' }
  /** Host seat only, lobby only: remove a player. */
  | { v: number; t: 'remove'; seat: number }
  /** Host seat only, game over: back to the lobby with the same players. */
  | { v: number; t: 'again' };

export type ClientMessageType = ClientMessage['t'];

export type RefusedReason =
  /** Protocol versions differ: "update the app". */
  | 'version'
  /** The lobby already has MAX_PLAYERS players. */
  | 'full'
  /** A game is running and the token does not match a seat. */
  | 'in-progress'
  /** The host removed this device from the lobby; it cannot rejoin until the lobby is reopened. */
  | 'removed';

export type ByeReason = 'host-left' | 'removed' | 'replaced';

/** Outcome of one clue submission, sent to the giver only. */
export type ClueResult =
  /** Broke a rule; nothing was scored and it does not count as an attempt. */
  | { kind: 'invalid'; reason: ClueRejectReason; message: string }
  /** Could not be scored (model not ready / failed / timed out / not your turn). Nothing was counted; retry. */
  | { kind: 'error'; message: string }
  /** Another clue of yours is still being scored; this one was dropped. */
  | { kind: 'busy' }
  | { kind: 'rejected'; clue: string; score: number; raw: number }
  /** `link`: set when the clue passed below the threshold because of this dictionary link. */
  | { kind: 'accepted'; clue: string; score: number; raw: number; link?: WordLink };

export type HostMessage =
  | { v: number; t: 'welcome'; seat: number; name: string }
  | { v: number; t: 'refused'; reason: RefusedReason; hostVersion: number }
  | { v: number; t: 'view'; view: PlayerView }
  | { v: number; t: 'clueResult'; id: number; result: ClueResult }
  | { v: number; t: 'ping'; n: number }
  | { v: number; t: 'pong'; n: number }
  | { v: number; t: 'bye'; reason: ByeReason };

export type ParseResult<T> =
  | { ok: true; msg: T }
  /** 'version': a well-formed envelope from a different protocol version. */
  | { ok: false; reason: 'invalid' | 'version'; version?: number };

// ---------------------------------------------------------------------------
// Primitive checks
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isStr(x: unknown, max: number, min = 0): x is string {
  return typeof x === 'string' && x.length >= min && x.length <= max;
}
function isInt(x: unknown, min: number, max: number): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
}
function isNum(x: unknown, min: number, max: number): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
}
function isBool(x: unknown): x is boolean {
  return typeof x === 'boolean';
}
/** Maps every element through `f`; null if x is not an array, is too long, or any element fails. */
function list<T>(x: unknown, max: number, f: (e: unknown) => T | null): T[] | null {
  if (!Array.isArray(x) || x.length > max) return null;
  const out: T[] = [];
  for (const e of x) {
    const v = f(e);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}
const word = (x: unknown): string | null => (isStr(x, MAX_WORD_INPUT_LENGTH) ? x : null);
const seatId = (x: unknown): number | null => (isInt(x, 0, MAX_SAFE) ? x : null);
const playerId = (x: unknown): string | null => (isStr(x, 8, 1) ? x : null);

export function isValidToken(x: unknown): x is string {
  return isStr(x, MAX_TOKEN_LENGTH, MIN_TOKEN_LENGTH) && TOKEN_PATTERN.test(x);
}

/** [first, last] code point ranges that are always removed from display names (they render as nothing or as a blank). */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates
  [0x2800, 0x2800], // blank braille
  [0x3164, 0x3164], // Hangul filler
  [0xd800, 0xdfff], // lone surrogates
  [0xfe00, 0xfe0f], // variation selectors
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xfff0, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff], // tags and variation selectors supplement
];

function isInvisible(c: number): boolean {
  for (const [first, last] of INVISIBLE_RANGES) if (c >= first && c <= last) return true;
  return false;
}

/**
 * Cleans a display name: control characters become spaces, invisible and
 * blank-rendering characters are removed, whitespace is collapsed and trimmed,
 * and the result is cut to MAX_NAME_LENGTH characters. May return ''.
 */
export function cleanPlayerName(name: string): string {
  let cleaned = '';
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    if (isInvisible(c)) continue;
    // Control characters, zero-width / directional marks and line separators become spaces.
    const hidden =
      c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || c === 0xfeff;
    cleaned += hidden ? ' ' : ch;
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
}

/** A few Cyrillic and Greek letters that look exactly like Latin ones (lower case). Not a full confusables table. */
const LOOKALIKES: Record<string, string> = {
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043e': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0445': 'x',
  '\u0443': 'y',
  '\u0456': 'i',
  '\u0458': 'j',
  '\u0455': 's',
  '\u04bb': 'h',
  '\u0501': 'd',
  '\u03bf': 'o',
  '\u03b1': 'a',
  '\u03bd': 'v',
  '\u03b9': 'i',
  '\u03ba': 'k',
  '\u03c1': 'p',
  '\u03c4': 't',
  '\u03c5': 'u',
  '\u03c7': 'x',
};

/**
 * The form in which two names count as "the same" to a reader: cleaned,
 * compatibility-normalised, lower-cased, without whitespace, and with common
 * look-alike letters folded to Latin.
 */
export function playerNameKey(name: string): string {
  let key = cleanPlayerName(name);
  try {
    key = key.normalize('NFKC');
  } catch {
    // No normalisation support: compare the cleaned name as it is.
  }
  key = key.toLowerCase().replace(/\s+/g, '');
  let out = '';
  for (const ch of key) out += LOOKALIKES[ch] ?? ch;
  return out;
}

/**
 * A name that reads differently (see playerNameKey) from every name in
 * `taken`: the cleaned name itself, or with " 2", " 3", ... appended
 * (shortening the base to stay within MAX_NAME_LENGTH). A blank name becomes
 * "Player".
 */
export function uniquePlayerName(name: string, taken: readonly string[]): string {
  const base = cleanPlayerName(name) || 'Player';
  const used = new Set(taken.map(playerNameKey));
  if (!used.has(playerNameKey(base))) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const head = Array.from(base)
      .slice(0, MAX_NAME_LENGTH - suffix.length)
      .join('')
      .trim();
    const candidate = `${head}${suffix}`;
    if (!used.has(playerNameKey(candidate))) return candidate;
  }
}

/**
 * True when a typed guess is acceptable over the network: after trimming and
 * lower-casing it is one word of the letters a-z (the rule clues follow) and
 * no longer than MAX_WORD_INPUT_LENGTH. Lower-casing can lengthen a string, so
 * the length is checked on the normalised form.
 */
export function isGuessWord(raw: string): boolean {
  const guess = raw.trim().toLowerCase();
  return guess.length <= MAX_WORD_INPUT_LENGTH && /^[a-z]+$/.test(guess);
}

/** A random reconnect token (not cryptographic; it only has to be unguessable by accident). */
export function createToken(random: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 24; i++) out += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  return out;
}

// ---------------------------------------------------------------------------
// Framing helpers (for adapters)
// ---------------------------------------------------------------------------

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** One line of NDJSON without the trailing newline, or null if it cannot be serialised or is too large. */
export function encodeLine(msg: unknown): string | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(msg);
  } catch {
    return null;
  }
  if (typeof text !== 'string' || utf8Length(text) > MAX_LINE_BYTES) return null;
  return text;
}

/** Parses one line; null unless it is a JSON object within the size limit. */
export function decodeLine(line: string): Record<string, unknown> | null {
  if (typeof line !== 'string' || utf8Length(line) > MAX_LINE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Client -> host
// ---------------------------------------------------------------------------

const INVALID = { ok: false, reason: 'invalid' } as const;

function envelope(raw: unknown): { ok: true; o: Obj; t: string } | { ok: false; reason: 'invalid' | 'version'; version?: number } {
  if (!isObj(raw)) return INVALID;
  if (!isInt(raw.v, 0, MAX_SAFE) || !isStr(raw.t, 32, 1)) return INVALID;
  if (raw.v !== PROTOCOL_VERSION) return { ok: false, reason: 'version', version: raw.v };
  return { ok: true, o: raw, t: raw.t };
}

/** Validates a message received by the host. */
export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  const env = envelope(raw);
  if (!env.ok) return env;
  const { o, t } = env;
  const v = PROTOCOL_VERSION;
  switch (t) {
    case 'hello':
      // The name is cleaned (and cut) by the host; only bound its raw size here.
      if (!isStr(o.name, 200) || !isValidToken(o.token)) return INVALID;
      return { ok: true, msg: { v, t, name: o.name, token: o.token } };
    case 'ping':
    case 'pong':
      if (!isInt(o.n, 0, MAX_SAFE)) return INVALID;
      return { ok: true, msg: { v, t, n: o.n } };
    case 'leave':
    case 'start':
    case 'forfeit':
    case 'forfeitGiver':
    case 'again':
      return { ok: true, msg: { v, t } };
    case 'choose':
      if (!isStr(o.word, MAX_WORD_INPUT_LENGTH, 1)) return INVALID;
      return { ok: true, msg: { v, t, word: o.word } };
    case 'clue':
      if (!isInt(o.id, 0, MAX_SAFE) || !isStr(o.clue, MAX_WORD_INPUT_LENGTH)) return INVALID;
      return { ok: true, msg: { v, t, id: o.id, clue: o.clue } };
    case 'guess':
      if (!isStr(o.guess, MAX_WORD_INPUT_LENGTH, 1)) return INVALID;
      return { ok: true, msg: { v, t, guess: o.guess } };
    case 'next':
      if (!isInt(o.step, 0, MAX_SAFE)) return INVALID;
      return { ok: true, msg: { v, t, step: o.step } };
    case 'skip':
    case 'remove':
      if (!isInt(o.seat, 0, MAX_SAFE)) return INVALID;
      return { ok: true, msg: { v, t, seat: o.seat } };
    default:
      return INVALID;
  }
}

// ---------------------------------------------------------------------------
// Host -> client
// ---------------------------------------------------------------------------

const CLUE_REASONS: readonly ClueRejectReason[] = [
  'empty',
  'not-single-word',
  'invalid-characters',
  'too-short',
  'too-long',
  'matches-option',
  'contains-option',
  'variant-of-option',
  'already-tried',
  'not-a-noun',
];
const PHASES: readonly NetPhase[] = ['choose-word', 'clue', 'guess', 'round-result', 'turn-result', 'game-over'];
const MAX_CLUES = 64;
/** The most rejected attempts / tried clues a giver's view may carry; the host sends only the latest ones. */
export const MAX_REJECTED_IN_VIEW = MAX_CLUES * 4;
export const MAX_TRIED_IN_VIEW = MAX_CLUES * 16;

function oneOf<T extends string>(x: unknown, values: readonly T[]): x is T {
  return typeof x === 'string' && (values as readonly string[]).includes(x);
}

/** An optional WordLink field: absent is fine, present must be valid. Returns false when invalid. */
function parseOptionalLink(x: unknown): WordLink | undefined | false {
  if (x === undefined) return undefined;
  if (!isWordLink(x) || !isStr(x.from, MAX_WORD_INPUT_LENGTH) || !isStr(x.to, MAX_WORD_INPUT_LENGTH)) return false;
  return copyLink(x);
}

function parseClueAttempt(x: unknown): ClueAttempt | null {
  if (!isObj(x) || !isStr(x.clue, MAX_WORD_INPUT_LENGTH) || !isNum(x.score, -1, 1)) return null;
  const link = parseOptionalLink(x.link);
  if (link === false) return null;
  return link ? { clue: x.clue, score: x.score, link } : { clue: x.clue, score: x.score };
}

function parseGuess(x: unknown): Guess | null {
  if (!isObj(x) || !isStr(x.playerId, 8, 1) || !isStr(x.guess, MAX_WORD_INPUT_LENGTH) || !isBool(x.correct)) return null;
  const g: Guess = { playerId: x.playerId, guess: x.guess, correct: x.correct };
  if (x.skipped === true) g.skipped = true;
  return g;
}

function parseRound(x: unknown): RoundRecord | null {
  if (!isObj(x)) return null;
  const guesses = list(x.guesses, MAX_PLAYERS, parseGuess);
  const correctGuesserIds = list(x.correctGuesserIds, MAX_PLAYERS, playerId);
  if (
    !isInt(x.round, 1, 16) ||
    !isStr(x.clue, MAX_WORD_INPUT_LENGTH) ||
    !isNum(x.score, -1, 1) ||
    guesses === null ||
    !isBool(x.anyCorrect) ||
    correctGuesserIds === null ||
    !isInt(x.giverPointsAwarded, 0, 1000)
  ) {
    return null;
  }
  const link = parseOptionalLink(x.link);
  if (link === false) return null;
  return {
    round: x.round,
    clue: x.clue,
    score: x.score,
    ...(link ? { link } : {}),
    guesses,
    anyCorrect: x.anyCorrect,
    correctGuesserIds,
    giverPointsAwarded: x.giverPointsAwarded,
  };
}

function parseSummary(x: unknown): TurnSummary | null {
  if (!isObj(x)) return null;
  const correctGuesserIds = list(x.correctGuesserIds, MAX_PLAYERS, playerId);
  const clues = list(x.clues, 16, parseClueAttempt);
  if (
    !isStr(x.giverId, 8, 1) ||
    !isStr(x.hiddenWord, MAX_WORD_INPUT_LENGTH) ||
    !oneOf(x.outcome, ['guessed', 'not-guessed', 'forfeit'] as const) ||
    !isInt(x.roundsPlayed, 0, 16) ||
    !isInt(x.giverPoints, 0, 1000) ||
    correctGuesserIds === null ||
    clues === null
  ) {
    return null;
  }
  return {
    giverId: x.giverId,
    hiddenWord: x.hiddenWord,
    outcome: x.outcome,
    roundsPlayed: x.roundsPlayed,
    giverPoints: x.giverPoints,
    correctGuesserIds,
    clues,
  };
}

function parseSettings(x: unknown): GameSettings | null {
  if (
    !isObj(x) ||
    !isInt(x.turnsPerPlayer, MIN_TURNS_PER_PLAYER, MAX_TURNS_PER_PLAYER) ||
    !isNum(x.threshold, MIN_THRESHOLD, MAX_THRESHOLD) ||
    !oneOf(x.guessMode, ['open', 'list'] as const) ||
    !isBool(x.requireDictionaryNoun) ||
    !isBool(x.useWordLinks)
  ) {
    return null;
  }
  return {
    turnsPerPlayer: x.turnsPerPlayer,
    threshold: x.threshold,
    guessMode: x.guessMode,
    requireDictionaryNoun: x.requireDictionaryNoun,
    useWordLinks: x.useWordLinks,
  };
}

function parseViewPlayer(x: unknown): ViewPlayer | null {
  if (
    !isObj(x) ||
    !isInt(x.seat, 0, MAX_SAFE) ||
    !(x.id === null || isStr(x.id, 8, 1)) ||
    !isStr(x.name, MAX_NAME_LENGTH * 2, 1) ||
    !isInt(x.score, 0, 100000) ||
    !isBool(x.connected) ||
    !isBool(x.isHost)
  ) {
    return null;
  }
  return { seat: x.seat, id: x.id, name: x.name, score: x.score, connected: x.connected, isHost: x.isHost };
}

function parseGuessStatus(x: unknown): GuessStatus | null {
  if (!isObj(x) || !isInt(x.seat, 0, MAX_SAFE) || !oneOf(x.status, ['pending', 'submitted', 'skipped'] as const)) {
    return null;
  }
  return { seat: x.seat, status: x.status };
}

function parseGiver(x: unknown): GiverView | null {
  if (!isObj(x)) return null;
  const options = list(x.options, OPTIONS_PER_TURN, word);
  const rejected = list(x.rejected, MAX_REJECTED_IN_VIEW, parseClueAttempt);
  const triedClues = list(x.triedClues, MAX_TRIED_IN_VIEW, word);
  if (
    options === null ||
    !(x.hiddenWord === null || isStr(x.hiddenWord, MAX_WORD_INPUT_LENGTH)) ||
    rejected === null ||
    triedClues === null ||
    !isInt(x.rejectionsUntilForfeit, 0, 100) ||
    !isBool(x.canForfeit) ||
    !isBool(x.scoring)
  ) {
    return null;
  }
  return {
    options,
    hiddenWord: x.hiddenWord,
    rejected,
    triedClues,
    rejectionsUntilForfeit: x.rejectionsUntilForfeit,
    canForfeit: x.canForfeit,
    scoring: x.scoring,
  };
}

function parseGameView(x: unknown): GameView | null {
  if (!isObj(x)) return null;
  const acceptedClues = list(x.acceptedClues, 16, parseClueAttempt);
  const guessOptions = x.guessOptions === null ? null : list(x.guessOptions, OPTIONS_PER_TURN, word);
  const guessStatus = list(x.guessStatus, MAX_PLAYERS, parseGuessStatus);
  const giver = x.giver === null ? null : parseGiver(x.giver);
  const rounds = list(x.rounds, 16, parseRound);
  const turnSummary = x.turnSummary === null ? null : parseSummary(x.turnSummary);
  if (
    !isInt(x.step, 0, MAX_SAFE) ||
    !oneOf(x.phase, PHASES) ||
    !isInt(x.turnNumber, 1, 1000) ||
    !isInt(x.totalTurns, 1, 1000) ||
    !isInt(x.clueRound, 1, 16) ||
    !isInt(x.giverSeat, 0, MAX_SAFE) ||
    !oneOf(x.role, ['giver', 'guesser'] as const) ||
    acceptedClues === null ||
    (x.guessOptions !== null && guessOptions === null) ||
    guessStatus === null ||
    !(x.yourGuess === null || isStr(x.yourGuess, MAX_WORD_INPUT_LENGTH)) ||
    (x.giver !== null && giver === null) ||
    rounds === null ||
    !isInt(x.giverTurnPoints, 0, 1000) ||
    !isInt(x.rewardIfRoundFails, 0, 1000) ||
    (x.turnSummary !== null && turnSummary === null) ||
    !isBool(x.canContinue)
  ) {
    return null;
  }
  return {
    step: x.step,
    phase: x.phase,
    turnNumber: x.turnNumber,
    totalTurns: x.totalTurns,
    clueRound: x.clueRound,
    giverSeat: x.giverSeat,
    role: x.role,
    acceptedClues,
    guessOptions,
    guessStatus,
    yourGuess: x.yourGuess,
    giver,
    rounds,
    giverTurnPoints: x.giverTurnPoints,
    rewardIfRoundFails: x.rewardIfRoundFails,
    turnSummary,
    canContinue: x.canContinue,
  };
}

function parseHostControls(x: unknown): HostControls | null {
  if (!isObj(x)) return null;
  const removableSeats = list(x.removableSeats, MAX_PLAYERS, seatId);
  const skippable = list(x.skippableSeats, MAX_PLAYERS, seatId);
  if (
    !isBool(x.canStart) ||
    removableSeats === null ||
    skippable === null ||
    !isBool(x.canForfeitGiver) ||
    !isBool(x.canPlayAgain)
  ) {
    return null;
  }
  return {
    canStart: x.canStart,
    removableSeats,
    skippableSeats: skippable,
    canForfeitGiver: x.canForfeitGiver,
    canPlayAgain: x.canPlayAgain,
  };
}

/** Validates a PlayerView received from the host; null when it is malformed. */
export function parsePlayerView(x: unknown): PlayerView | null {
  if (!isObj(x)) return null;
  const you = x.you;
  const players = list(x.players, MAX_PLAYERS, parseViewPlayer);
  const settings = parseSettings(x.settings);
  const game = x.game === null ? null : parseGameView(x.game);
  const host = x.host === null ? null : parseHostControls(x.host);
  if (
    !oneOf(x.stage, ['lobby', 'game'] as const) ||
    !isObj(you) ||
    !isInt(you.seat, 0, MAX_SAFE) ||
    !isStr(you.name, MAX_NAME_LENGTH * 2, 1) ||
    !isBool(you.isHost) ||
    players === null ||
    players.length < 1 ||
    settings === null ||
    x.minPlayers !== MIN_PLAYERS ||
    x.maxPlayers !== MAX_PLAYERS ||
    !oneOf(x.continueBy, ['host', 'anyone'] as const) ||
    (x.game !== null && game === null) ||
    (x.host !== null && host === null)
  ) {
    return null;
  }
  // Internal consistency the UI relies on.
  if (!players.some((p) => p.seat === you.seat)) return null;
  if ((x.stage === 'game') !== (game !== null)) return null;
  if (game && !players.some((p) => p.seat === game.giverSeat)) return null;
  return {
    stage: x.stage,
    you: { seat: you.seat, name: you.name, isHost: you.isHost },
    players,
    settings,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    continueBy: x.continueBy,
    game,
    host,
  };
}

function parseClueResult(x: unknown): ClueResult | null {
  if (!isObj(x)) return null;
  switch (x.kind) {
    case 'invalid':
      if (!oneOf(x.reason, CLUE_REASONS) || !isStr(x.message, MAX_MESSAGE_TEXT)) return null;
      return { kind: 'invalid', reason: x.reason, message: x.message };
    case 'error':
      if (!isStr(x.message, MAX_MESSAGE_TEXT)) return null;
      return { kind: 'error', message: x.message };
    case 'busy':
      return { kind: 'busy' };
    case 'rejected':
    case 'accepted':
      if (!isStr(x.clue, MAX_WORD_INPUT_LENGTH, 1) || !isNum(x.score, -1, 1) || !isNum(x.raw, -1.0001, 1.0001)) return null;
      if (x.kind === 'rejected') return { kind: x.kind, clue: x.clue, score: x.score, raw: x.raw };
      {
        const link = parseOptionalLink(x.link);
        if (link === false) return null;
        return link
          ? { kind: x.kind, clue: x.clue, score: x.score, raw: x.raw, link }
          : { kind: x.kind, clue: x.clue, score: x.score, raw: x.raw };
      }
    default:
      return null;
  }
}

/** Validates a message received by a client. */
export function parseHostMessage(raw: unknown): ParseResult<HostMessage> {
  const env = envelope(raw);
  if (!env.ok) return env;
  const { o, t } = env;
  const v = PROTOCOL_VERSION;
  switch (t) {
    case 'welcome':
      if (!isInt(o.seat, 0, MAX_SAFE) || !isStr(o.name, MAX_NAME_LENGTH * 2, 1)) return INVALID;
      return { ok: true, msg: { v, t, seat: o.seat, name: o.name } };
    case 'refused':
      if (!oneOf(o.reason, ['version', 'full', 'in-progress', 'removed'] as const) || !isInt(o.hostVersion, 0, MAX_SAFE)) {
        return INVALID;
      }
      return { ok: true, msg: { v, t, reason: o.reason, hostVersion: o.hostVersion } };
    case 'view': {
      const view = parsePlayerView(o.view);
      if (view === null) return INVALID;
      return { ok: true, msg: { v, t, view } };
    }
    case 'clueResult': {
      const result = parseClueResult(o.result);
      if (!isInt(o.id, 0, MAX_SAFE) || result === null) return INVALID;
      return { ok: true, msg: { v, t, id: o.id, result } };
    }
    case 'ping':
    case 'pong':
      if (!isInt(o.n, 0, MAX_SAFE)) return INVALID;
      return { ok: true, msg: { v, t, n: o.n } };
    case 'bye':
      if (!oneOf(o.reason, ['host-left', 'removed', 'replaced'] as const)) return INVALID;
      return { ok: true, msg: { v, t, reason: o.reason } };
    default:
      return INVALID;
  }
}
