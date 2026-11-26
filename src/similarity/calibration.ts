import generated from './calibration.generated.json';

/**
 * Raw cosine that maps to SCORE_GATE. Measured by `npm run calibrate`
 * (tools/calibrate.mjs): the raw cosine at which about 90% of deck words still
 * have at least 8 valid dictionary clues. Do not edit by hand; re-run the tool.
 */
export const RAW_GATE: number = generated.rawGate;

/**
 * Lowest raw cosine at which a dictionary link may lift a clue over the
 * threshold. Links that rely on a rare sense of a word ("bread" as money,
 * "fin" as a five-dollar bill) mostly score below it; genuine ones such as
 * flower / petal (0.37) and root / carrot (0.33) score above. Chosen by
 * inspecting samples of WordNet / ConceptNet links at each cosine band
 * (tools/build-links.mjs documents the link sources).
 */
export const LINK_RAW_FLOOR = 0.25;

/** Calibrated score that RAW_GATE maps to (the default game threshold). */
export const SCORE_GATE = 0.95;

if (!(RAW_GATE > 0 && RAW_GATE < 1)) {
  throw new Error(`calibration.generated.json: rawGate must be in (0, 1), got ${RAW_GATE}`);
}

/**
 * Maps a raw cosine onto the calibrated score shown in the app.
 *
 * Raw cosines between two different nouns almost never reach 0.95 with
 * all-MiniLM-L6-v2 (synonyms land around 0.8), so the app shows a fixed,
 * monotonic, piecewise-linear rescaling instead:
 *   raw <= 0          -> 0
 *   0 .. RAW_GATE     -> 0 .. 0.95   (linear)
 *   RAW_GATE .. 1     -> 0.95 .. 1   (linear)
 * It only relabels the axis: the ordering of word pairs is unchanged.
 */
export function calibrate(raw: number): number {
  if (!(raw > 0)) return 0; // also covers NaN
  if (raw >= 1) return 1;
  if (raw < RAW_GATE) return (SCORE_GATE * raw) / RAW_GATE;
  return Math.min(1, SCORE_GATE + ((1 - SCORE_GATE) * (raw - RAW_GATE)) / (1 - RAW_GATE));
}

/** Inverse of calibrate() on (0, 1): the raw cosine needed to reach a calibrated score. */
export function rawForScore(score: number): number {
  if (!(score > 0)) return 0;
  if (score >= 1) return 1;
  if (score < SCORE_GATE) return (score * RAW_GATE) / SCORE_GATE;
  return RAW_GATE + ((score - SCORE_GATE) * (1 - RAW_GATE)) / (1 - SCORE_GATE);
}

/** One reference pair measured with the fp32 Node stand-in for the device model. */
export interface GoldenPair {
  a: string;
  b: string;
  /** Raw cosine from the reference model. */
  raw: number;
}

export const GOLDEN_PAIRS: readonly GoldenPair[] = generated.goldenPairs;

/** Provenance of the calibration, for the "about scoring" text. */
export const CALIBRATION_INFO: { readonly model: string; readonly generatedAt: string } = {
  model: generated.model,
  generatedAt: generated.generatedAt,
};
