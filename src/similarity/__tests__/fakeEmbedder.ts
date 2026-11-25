import type { Embedder } from '../types';

/** Unit vector at `degrees` in the plane, so cosines between fakes are exact and predictable. */
export function vectorAt(degrees: number, dim = 4): Float32Array {
  const v = new Float32Array(dim);
  const rad = (degrees * Math.PI) / 180;
  v[0] = Math.cos(rad);
  v[1] = Math.sin(rad);
  return v;
}

export interface FakeEmbedder extends Embedder {
  /** Every text passed to embed(), in call order. */
  calls: string[];
  /** Highest number of embed() calls that were in flight at the same time. */
  maxConcurrent: number;
}

/**
 * Embedder backed by a table of angles. Like the real ExecuTorch runner it
 * rejects when called while another call is in flight.
 */
export function createFakeEmbedder(
  angles: Record<string, number>,
  options: { delayMs?: number; failOn?: string[] } = {},
): FakeEmbedder {
  let inFlight = 0;
  const fake: FakeEmbedder = {
    calls: [],
    maxConcurrent: 0,
    async embed(text: string): Promise<Float32Array> {
      fake.calls.push(text);
      if (inFlight > 0) {
        fake.maxConcurrent = Math.max(fake.maxConcurrent, inFlight + 1);
        throw new Error('RESOURCE_BUSY');
      }
      inFlight++;
      fake.maxConcurrent = Math.max(fake.maxConcurrent, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 1));
        if (options.failOn?.includes(text)) throw new Error(`cannot embed ${text}`);
        const angle = angles[text];
        if (angle === undefined) throw new Error(`fake embedder has no vector for "${text}"`);
        return vectorAt(angle);
      } finally {
        inFlight--;
      }
    },
  };
  return fake;
}
