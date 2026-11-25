import { createSimilarityService } from './service';
import type { Embedder, SimilarityResult, SimilarityService } from './types';

export type SimilarityStatus = 'loading' | 'ready' | 'error';

export interface SimilaritySnapshot {
  status: SimilarityStatus;
  error?: string;
}

export interface SimilarityStore {
  /** Current status; the same object is returned until the status changes. */
  getSnapshot(): SimilaritySnapshot;
  subscribe(listener: () => void): () => void;
  /** Starts loading the model. Does nothing while loading or once ready. */
  load(): void;
  /** After a failed load: try again. */
  retry(): void;
  /** Waits for the model if it is still loading; rejects if loading failed. */
  similarity(a: string, b: string): Promise<SimilarityResult>;
  readonly service: SimilarityService;
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'The similarity model could not be loaded.';
}

/**
 * Framework-free model lifecycle (loading -> ready | error, with retry) around
 * a similarity service. React reads it through useSyncExternalStore; tests
 * drive it directly with a fake embedder.
 */
export function createSimilarityStore(
  embedder: Embedder & { load?: () => Promise<void> },
): SimilarityStore {
  const service = createSimilarityService(embedder);
  const listeners = new Set<() => void>();
  let snapshot: SimilaritySnapshot = { status: 'loading' };
  let loading: Promise<void> | null = null;

  function set(next: SimilaritySnapshot): void {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  function load(): void {
    if (loading !== null) return;
    if (snapshot.status !== 'loading') set({ status: 'loading' });
    const attempt = (async () => {
      await embedder.load?.();
    })();
    loading = attempt;
    attempt.then(
      () => {
        if (loading === attempt) set({ status: 'ready' });
      },
      (error: unknown) => {
        if (loading === attempt) set({ status: 'error', error: describe(error) });
      },
    );
  }

  return {
    service,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    retry() {
      if (snapshot.status !== 'error') return;
      loading = null;
      load();
    },
    async similarity(a, b) {
      load();
      await loading;
      return service.similarity(a, b);
    },
  };
}
