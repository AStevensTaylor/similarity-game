import type { WordLink } from '../game';

/** Anything that can turn a piece of text into an embedding vector. */
export interface Embedder {
  embed(text: string): Promise<Float32Array>;
}

/** An embedder whose model has to be loaded before first use. */
export interface LoadableEmbedder extends Embedder {
  /** Loads the model. Safe to call repeatedly; a failed load can be retried. */
  load(): Promise<void>;
}

export interface SimilarityResult {
  /** Raw cosine similarity of the two embeddings, in [-1, 1]. */
  raw: number;
  /** Calibrated score in [0, 1]; this is what the game threshold is compared against. */
  score: number;
  /**
   * A dictionary link between the two words, present only when one exists and
   * the raw cosine reaches LINK_RAW_FLOOR. With word links on, it lets a clue pass below the threshold.
   */
  link?: WordLink;
}

/** Looks up a dictionary link between two words (src/data/links.ts in the app). */
export type FindLink = (a: string, b: string) => WordLink | null;

export interface SimilarityService {
  similarity(a: string, b: string): Promise<SimilarityResult>;
  embed(word: string): Promise<Float32Array>;
}
