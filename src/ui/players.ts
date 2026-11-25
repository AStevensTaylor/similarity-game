/** Pure helpers for the player list on the setup screen. */
import { MAX_PLAYERS, MIN_PLAYERS } from '../game';

export const MAX_NAME_LENGTH = 16;
export const DEFAULT_PLAYER_NAMES: readonly string[] = ['Player 1', 'Player 2'];

/** Collapses whitespace and trims; used for comparing and for the final names. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

export interface PlayerNamesValidation {
  ok: boolean;
  /** One entry per name: null when fine, otherwise what is wrong with it. */
  errors: (string | null)[];
  /** Problem with the list as a whole (too few / too many), or null. */
  listError: string | null;
  /** The cleaned names; only meaningful when ok. */
  names: string[];
}

/** Names must be non-empty, at most MAX_NAME_LENGTH long and unique ignoring case. */
export function validatePlayerNames(input: readonly string[]): PlayerNamesValidation {
  const names = input.map(cleanName);
  const keys = names.map((n) => n.toLowerCase());
  const errors = names.map((name, i): string | null => {
    if (name.length === 0) return 'Enter a name.';
    if (Array.from(name).length > MAX_NAME_LENGTH) return `Use at most ${MAX_NAME_LENGTH} characters.`;
    if (keys.indexOf(keys[i]) !== i || keys.lastIndexOf(keys[i]) !== i) return 'Names must be different.';
    return null;
  });
  let listError: string | null = null;
  if (names.length < MIN_PLAYERS) listError = `Add at least ${MIN_PLAYERS} players.`;
  else if (names.length > MAX_PLAYERS) listError = `At most ${MAX_PLAYERS} players can play.`;
  return { ok: listError === null && errors.every((e) => e === null), errors, listError, names };
}

/** The first "Player N" not already taken (ignoring case). */
export function nextDefaultName(existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => cleanName(n).toLowerCase()));
  for (let n = existing.length + 1; ; n++) {
    const candidate = `Player ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
