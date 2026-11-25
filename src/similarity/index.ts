// Similarity layer: on-device BERT embeddings -> raw cosine -> calibrated score.
//
// createExecutorchEmbedder is deliberately NOT re-exported here: importing
// './executorchEmbedder' loads the native ExecuTorch module. SimilarityProvider
// requires it lazily; import it from that file directly if you need it.
export type { Embedder, LoadableEmbedder, SimilarityResult, SimilarityService } from './types';
export {
  RAW_GATE,
  SCORE_GATE,
  GOLDEN_PAIRS,
  CALIBRATION_INFO,
  calibrate,
  rawForScore,
  type GoldenPair,
} from './calibration';
export { cosine, normaliseWord, createSimilarityService, DEFAULT_CACHE_SIZE } from './service';
export {
  createSimilarityStore,
  type SimilarityStatus,
  type SimilaritySnapshot,
  type SimilarityStore,
} from './store';
export {
  SimilarityProvider,
  useSimilarity,
  type SimilarityContextValue,
  type SimilarityProviderProps,
} from './useSimilarity';
export { runSelfCheck, type SelfCheckPair, type SelfCheckReport } from './selfCheck';
