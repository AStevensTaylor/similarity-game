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
}

export interface SimilarityService {
  similarity(a: string, b: string): Promise<SimilarityResult>;
  embed(word: string): Promise<Float32Array>;
}
