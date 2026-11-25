import { calibrate } from './calibration';
import type { Embedder, SimilarityResult, SimilarityService } from './types';

export const DEFAULT_CACHE_SIZE = 500;

/**
 * Cosine similarity of two vectors, clamped to [-1, 1]. Does not assume the
 * inputs are normalised. Returns 0 if either vector has no length.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: vector lengths differ (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na * nb);
  if (!(denom > 0)) return 0;
  return Math.max(-1, Math.min(1, dot / denom));
}

/** The form in which words are embedded and cached. */
export function normaliseWord(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Wraps an embedder with input normalisation (trim, lower-case), a bounded LRU
 * cache of embeddings, and strict one-at-a-time access to the embedder (the
 * ExecuTorch runner rejects a call made while another is in flight).
 */
export function createSimilarityService(
  embedder: Embedder,
  options: { cacheSize?: number } = {},
): SimilarityService {
  const cacheSize = Math.max(1, Math.floor(options.cacheSize ?? DEFAULT_CACHE_SIZE));
  // Map iteration order is insertion order, so the first key is the least recently used.
  const cache = new Map<string, Float32Array>();
  let queue: Promise<unknown> = Promise.resolve();

  function embed(word: string): Promise<Float32Array> {
    const key = normaliseWord(word);
    if (key === '') return Promise.reject(new Error('Cannot score an empty word.'));

    const run = queue.then(async () => {
      // Looked up inside the queue so that a word requested twice in a row is
      // embedded once: the second request finds what the first one stored.
      const hit = cache.get(key);
      if (hit !== undefined) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const vector = await embedder.embed(key);
      if (!(vector instanceof Float32Array) || vector.length === 0) {
        throw new Error(`Embedder returned no vector for "${key}".`);
      }
      cache.set(key, vector);
      while (cache.size > cacheSize) {
        cache.delete(cache.keys().next().value as string);
      }
      return vector;
    });
    // A failed embedding must not block the calls queued behind it, and is not cached.
    queue = run.catch(() => undefined);
    return run;
  }

  async function similarity(a: string, b: string): Promise<SimilarityResult> {
    // Start both before awaiting so a rejection of the first cannot leave the
    // second one unhandled; the queue still runs them one after the other.
    const [va, vb] = await Promise.all([embed(a), embed(b)]);
    const raw = cosine(va, vb);
    return { raw, score: calibrate(raw) };
  }

  return { similarity, embed };
}
