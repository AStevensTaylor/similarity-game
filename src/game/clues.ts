/**
 * Pure, synchronous clue and guess rules. These run BEFORE the (async, on-device)
 * similarity scoring.
 */
import type { ClueContext, ClueValidation } from './types';

export const MIN_CLUE_LENGTH = 2;
export const MAX_CLUE_LENGTH = 20;

/** Trim + lower-case. Used for clues, guesses and words alike. */
export function normalizeWord(input: string): string {
  return input.trim().toLowerCase();
}

const MIN_STEM_LENGTH = 3;

type SuffixKind =
  /** Plain removal: "boxes" -> "box". */
  | 'plain'
  /** y-to-i spelling: "berries" / "carried" / "flier" -> "berry" / "carry" / "fly". */
  | 'y'
  /** f-to-v plural: "knives" -> "knife", "elves" -> "elf". */
  | 'f'
  /** Ending that may have dropped an "e" or doubled a consonant: "baking", "swimmer". */
  | 'verbal';

// Longest first. Each entry is ONE inflection layer ("ers" / "ings" / "iers" count as one).
const SUFFIXES: readonly (readonly [suffix: string, kind: SuffixKind])[] = [
  ['iers', 'y'],
  ['ings', 'verbal'],
  ['ies', 'y'],
  ['ied', 'y'],
  ['ier', 'y'],
  ['ves', 'f'],
  ['ing', 'verbal'],
  ['ers', 'verbal'],
  ['es', 'plain'],
  ['ed', 'verbal'],
  ['er', 'verbal'],
  ['s', 'plain'],
];

const isConsonant = (ch: string | undefined): boolean => ch !== undefined && !/[aeiou]/.test(ch);

const isUsableBase = (base: string): boolean => base.length >= MIN_STEM_LENGTH && /[aeiouy]/.test(base);

/**
 * The plausible bases left after removing one suffix, most literal first.
 * Bases shorter than three letters or without a vowel are dropped, so "king"
 * is not "k" + "ing" and "string" is not "str" + "ing".
 */
function basesForSuffix(word: string, suffix: string, kind: SuffixKind): string[] {
  const rest = word.slice(0, word.length - suffix.length);
  const last = rest[rest.length - 1];
  let out: string[];
  switch (kind) {
    case 'plain':
      out = [rest];
      break;
    case 'y':
      out = [`${rest}y`];
      break;
    case 'f':
      out = [`${rest}f`, `${rest}fe`];
      break;
    case 'verbal':
      out = [rest];
      // e-drop: bake -> baking, ice -> icing. Only after a consonant that follows a vowel, so
      // "being" is not "bee" + "ing", "seed" is not "see" + "d" and "sled" is not "sle" + "d".
      if (isConsonant(last) && /[aeiouy]/.test(rest)) out.push(`${rest}e`);
      // Consonant doubling: swim -> swimming.
      if (rest.length >= 2 && last === rest[rest.length - 2] && isConsonant(last)) out.push(rest.slice(0, -1));
      break;
  }
  return out.filter(isUsableBase);
}

/**
 * The word itself plus every base it could be a simple inflection of, removing
 * at most ONE suffix layer (plural / -s / -es / -ing / -ed / -er, with y-to-i,
 * f-to-v, e-drop and consonant doubling repaired).
 *
 * Nothing is stripped repeatedly and an un-suffixed word is never shortened,
 * which is what keeps unrelated nouns apart (water / watt, cheese / chess,
 * pill / pile).
 */
function candidateBases(word: string): Set<string> {
  const bases = new Set<string>([word]);
  for (const [suffix, kind] of SUFFIXES) {
    if (!word.endsWith(suffix)) continue;
    for (const base of basesForSuffix(word, suffix, kind)) bases.add(base);
  }
  return bases;
}

/**
 * A deliberately crude single-pass stemmer: removes ONE plural / -s / -es /
 * -ing / -ed / -er ending (the longest that leaves a usable base) and, only
 * when an ending was removed, un-doubles a trailing doubled consonant
 * ("running" -> "run"). Words without such an ending are returned unchanged.
 *
 * Variant detection does NOT compare stems (see isMorphologicalVariant); this
 * is kept as a small tested helper.
 */
export function stem(word: string): string {
  const w = normalizeWord(word);
  for (const [suffix, kind] of SUFFIXES) {
    if (!w.endsWith(suffix)) continue;
    const bases = basesForSuffix(w, suffix, kind);
    if (bases.length === 0) continue;
    // The un-doubled form, when there is one, is the shortest candidate.
    return bases.reduce((shortest, base) => (base.length < shortest.length ? base : shortest));
  }
  return w;
}

/**
 * True when a and b are the same word or simple morphological variants of each
 * other: one is the other's base plus a single listed suffix, or both are
 * single-suffix forms of one base ("baker" / "baking").
 *
 * Crude on purpose, so a few lookalikes still collide (dinner / diner through
 * "din", skier / sky through the y-to-i rule). That errs on the strict side.
 */
export function isMorphologicalVariant(a: string, b: string): boolean {
  const x = normalizeWord(a);
  const y = normalizeWord(b);
  if (x.length === 0 || y.length === 0) return false;
  if (x === y) return true;
  const basesOfY = candidateBases(y);
  for (const base of candidateBases(x)) {
    if (basesOfY.has(base)) return true;
  }
  return false;
}

function reject(reason: Exclude<ClueValidation, { ok: true }>['reason'], message: string): ClueValidation {
  return { ok: false, reason, message };
}

/**
 * Validates a typed clue against the rules that do not need the model.
 * Checks run in a fixed order, so exactly one reason is reported.
 */
export function validateClue(input: string, ctx: ClueContext): ClueValidation {
  const clue = normalizeWord(input);

  if (clue.length === 0) {
    return reject('empty', 'Type a clue first.');
  }
  if (/\s/.test(clue)) {
    return reject('not-single-word', 'A clue must be a single word.');
  }
  if (!/^[a-z]+$/.test(clue)) {
    return reject('invalid-characters', 'Use letters a-z only (no digits, hyphens or punctuation).');
  }
  if (clue.length < MIN_CLUE_LENGTH) {
    return reject('too-short', `A clue needs at least ${MIN_CLUE_LENGTH} letters.`);
  }
  if (clue.length > MAX_CLUE_LENGTH) {
    return reject('too-long', `A clue can have at most ${MAX_CLUE_LENGTH} letters.`);
  }

  const options = ctx.options.map(normalizeWord).filter((o) => o.length > 0);

  if (options.includes(clue)) {
    return reject('matches-option', 'A clue cannot be one of the five words.');
  }
  if (options.some((o) => clue.includes(o) || o.includes(clue))) {
    return reject('contains-option', 'A clue cannot contain, or be part of, one of the five words.');
  }
  if (options.some((o) => isMorphologicalVariant(clue, o))) {
    return reject('variant-of-option', 'A clue cannot be a variant of one of the five words.');
  }
  if (ctx.tried.some((t) => normalizeWord(t) === clue)) {
    return reject('already-tried', 'You already tried that clue this turn.');
  }
  if (ctx.requireDictionaryNoun && !ctx.isNoun(clue)) {
    return reject('not-a-noun', 'That word is not in the noun dictionary.');
  }

  return { ok: true, clue };
}

/**
 * A guess is correct when it equals the hidden word after normalisation
 * (trim, lower-case), also accepting a trivial plural either way.
 */
export function isCorrectGuess(guess: string, hiddenWord: string): boolean {
  const g = normalizeWord(guess);
  const w = normalizeWord(hiddenWord);
  if (g.length === 0 || w.length === 0) return false;
  return g === w || g === w + 's' || w === g + 's';
}
