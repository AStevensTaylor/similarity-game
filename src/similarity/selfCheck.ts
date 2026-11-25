import { GOLDEN_PAIRS, RAW_GATE, type GoldenPair } from './calibration';
import type { SimilarityResult } from './types';

export interface SelfCheckPair {
  a: string;
  b: string;
  /** Raw cosine measured just now by the live (on-device) model. */
  raw: number;
  /** Raw cosine of the fp32 Node reference used to calibrate RAW_GATE. */
  expectedRaw: number;
  /** raw - expectedRaw. */
  delta: number;
  /** Calibrated score of the live measurement. */
  score: number;
  /** True when the live model and the reference disagree on which side of RAW_GATE the pair falls. */
  gateFlipped: boolean;
}

export interface SelfCheckReport {
  pairs: SelfCheckPair[];
  meanAbsDelta: number;
  maxAbsDelta: number;
  /** Number of pairs with gateFlipped. */
  gateFlips: number;
}

/**
 * Runs the golden pairs through the live similarity function and reports how
 * far each raw cosine is from the Node reference. The app ships an int8
 * quantised ExecuTorch export, while RAW_GATE was calibrated with the fp32
 * ONNX export of the same weights, so some drift is expected; this makes it
 * visible on a real device (nothing else can).
 */
export async function runSelfCheck(
  source: { similarity(a: string, b: string): Promise<SimilarityResult> },
  pairs: readonly GoldenPair[] = GOLDEN_PAIRS,
): Promise<SelfCheckReport> {
  const out: SelfCheckPair[] = [];
  for (const pair of pairs) {
    const { raw, score } = await source.similarity(pair.a, pair.b);
    out.push({
      a: pair.a,
      b: pair.b,
      raw,
      expectedRaw: pair.raw,
      delta: raw - pair.raw,
      score,
      gateFlipped: raw >= RAW_GATE !== pair.raw >= RAW_GATE,
    });
  }
  const abs = out.map((p) => Math.abs(p.delta));
  return {
    pairs: out,
    meanAbsDelta: abs.length ? abs.reduce((sum, d) => sum + d, 0) / abs.length : 0,
    maxAbsDelta: abs.length ? Math.max(...abs) : 0,
    gateFlips: out.filter((p) => p.gateFlipped).length,
  };
}
