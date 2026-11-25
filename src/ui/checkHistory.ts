/** Session history of the similarity checker. Pure. */

export interface CheckEntry {
  id: number;
  a: string;
  b: string;
  raw: number;
  score: number;
}

export const MAX_CHECK_HISTORY = 10;

/** Newest first, capped; an identical pair (in either order) moves to the top instead of repeating. */
export function addCheck(history: readonly CheckEntry[], entry: CheckEntry): CheckEntry[] {
  const samePair = (e: CheckEntry) => (e.a === entry.a && e.b === entry.b) || (e.a === entry.b && e.b === entry.a);
  return [entry, ...history.filter((e) => !samePair(e))].slice(0, MAX_CHECK_HISTORY);
}
