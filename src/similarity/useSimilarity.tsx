import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { createSimilarityStore, type SimilarityStatus, type SimilarityStore } from './store';
import { findLink as bundledFindLink } from '../data/links';
import type { Embedder, FindLink, SimilarityResult } from './types';

export interface SimilarityContextValue {
  status: SimilarityStatus;
  /** Set when status is 'error'. */
  error?: string;
  /** After an error: try loading the model again. */
  retry(): void;
  /** Waits for the model if it is still loading; rejects if loading failed. */
  similarity(a: string, b: string): Promise<SimilarityResult>;
}

const SimilarityContext = createContext<SimilarityStore | null>(null);

function createDefaultEmbedder(): Embedder & { load(): Promise<void> } {
  // Required lazily so that importing this module (or the barrel) does not
  // pull the native ExecuTorch module into tests and tools.
  const mod = require('./executorchEmbedder') as typeof import('./executorchEmbedder');
  return mod.createExecutorchEmbedder();
}

export interface SimilarityProviderProps {
  children: ReactNode;
  /** Override the on-device model, e.g. with a fake in tests or storybook-style screens. */
  embedder?: Embedder & { load?: () => Promise<void> };
  /** Dictionary link lookup; defaults to the bundled WordNet / ConceptNet table. Pass null to disable. */
  findLink?: FindLink | null;
}

/** Owns the similarity model for the whole app and starts loading it on mount. */
export function SimilarityProvider({ children, embedder, findLink }: SimilarityProviderProps) {
  const [store] = useState(() =>
    createSimilarityStore(embedder ?? createDefaultEmbedder(), {
      findLink: findLink === undefined ? bundledFindLink : findLink,
    }),
  );
  useEffect(() => {
    store.load();
  }, [store]);
  return <SimilarityContext.Provider value={store}>{children}</SimilarityContext.Provider>;
}

export function useSimilarity(): SimilarityContextValue {
  const store = useContext(SimilarityContext);
  if (store === null) {
    throw new Error('useSimilarity must be used inside <SimilarityProvider>.');
  }
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(
    () => ({
      status: snapshot.status,
      error: snapshot.error,
      retry: store.retry,
      similarity: store.similarity,
    }),
    [snapshot, store],
  );
}
