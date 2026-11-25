/**
 * Wraps the bundled word lists:
 *  - deck.json: the words offered to clue-givers
 *  - nouns.json: lower-case noun dictionary used to validate clues
 */
import deckJson from './deck.json';
import nounsJson from './nouns.json';

export const DECK: readonly string[] = deckJson;

let nounSet: Set<string> | null = null;

/** True when the word (trimmed, lower-cased) is in the noun dictionary. The Set is built once, lazily. */
export function isNoun(word: string): boolean {
  if (nounSet === null) {
    nounSet = new Set<string>(nounsJson);
  }
  return nounSet.has(word.trim().toLowerCase());
}
