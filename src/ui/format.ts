/** Pure display helpers. No React, no React Native. */
import type { LinkSource, WordLink } from '../game';

/**
 * Calibrated score with 3 decimals, truncated (never rounded up) so a score
 * just below the threshold can never be displayed as if it had reached it.
 */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return '-';
  const clamped = Math.min(1, Math.max(0, score));
  return (Math.floor(clamped * 1000 + 1e-7) / 1000).toFixed(3);
}

/** Raw cosine with 3 decimals (may be negative). */
export function formatRaw(raw: number): string {
  if (!Number.isFinite(raw)) return '-';
  const rounded = Math.round(raw * 1000) / 1000;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(3);
}

const SOURCE_NAMES: Record<LinkSource, string> = { wordnet: 'WordNet', conceptnet: 'ConceptNet' };

/** The dictionaries a link comes from, e.g. "WordNet and ConceptNet". */
export function formatLinkSources(link: WordLink): string {
  return link.sources.map((s) => SOURCE_NAMES[s]).join(' and ');
}

/** A word link as a short sentence, e.g. `"root" is part of "tree"`. */
export function describeLink(link: WordLink): string {
  const f = `"${link.from}"`;
  const t = `"${link.to}"`;
  switch (link.relation) {
    case 'synonym':
      return `${f} means about the same as ${t}`;
    case 'opposite':
      return `${f} is the opposite of ${t}`;
    case 'kind':
      return `${f} is a kind of ${t}`;
    case 'part':
      return `${f} is part of ${t}`;
    case 'member':
      return `${f} is a member of ${t}`;
    case 'material':
      return `${f} is made of ${t}`;
    case 'used-for':
      return `${f} is used for ${t}`;
    case 'cause':
      return `${f} causes ${t}`;
    case 'found-at':
      return `${f} is found at ${t}`;
    case 'associated':
      return `${f} and ${t} go together`;
  }
}

/** Threshold with 2 decimals, e.g. 0.95. */
export function formatThreshold(threshold: number): string {
  return threshold.toFixed(2);
}

export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatPoints(points: number): string {
  return pluralize(points, 'point');
}

/** "+1 point", "+4 points", "0 points". */
export function formatGain(points: number): string {
  return points > 0 ? `+${formatPoints(points)}` : formatPoints(points);
}

/** "Ana", "Ana and Bo", "Ana, Bo and Cy". */
export function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Rank label for a leaderboard row: "1" or "=1" when tied. */
export function rankLabel(rank: number, tied: boolean): string {
  return tied ? `=${rank}` : `${rank}`;
}

/** Spoken version of a rank, for accessibility labels. */
export function rankSpoken(rank: number, tied: boolean): string {
  return tied ? `tied for place ${rank}` : `place ${rank}`;
}

/** First letter of a name for an avatar, upper-cased; "?" if none. */
export function initial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

/** Steps a threshold by `delta` hundredths, clamped, without float drift. */
export function stepThreshold(threshold: number, delta: number, min: number, max: number): number {
  const next = Math.round(threshold * 100) + delta;
  return Math.min(Math.round(max * 100), Math.max(Math.round(min * 100), next)) / 100;
}

/** Fresh uint32 seed for a new game. */
export function makeSeed(now: number = Date.now(), random: number = Math.random()): number {
  return ((now >>> 0) ^ Math.floor(random * 4294967296)) >>> 0;
}
