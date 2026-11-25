import { createSimilarityStore } from '../store';
import { createFakeEmbedder } from './fakeEmbedder';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createSimilarityStore', () => {
  it('starts in loading and becomes ready once the model has loaded', async () => {
    const gate = deferred();
    const load = jest.fn(() => gate.promise);
    const store = createSimilarityStore({ ...createFakeEmbedder({ cat: 0 }), load });
    const listener = jest.fn();
    store.subscribe(listener);

    expect(store.getSnapshot()).toEqual({ status: 'loading' });
    store.load();
    store.load(); // idempotent
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().status).toBe('loading');

    gate.resolve();
    await flush();
    expect(store.getSnapshot()).toEqual({ status: 'ready' });
    expect(listener).toHaveBeenCalledTimes(1);
    store.load();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('returns a stable snapshot object between changes', () => {
    const store = createSimilarityStore(createFakeEmbedder({}));
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it('is ready immediately (next tick) for an embedder without load()', async () => {
    const store = createSimilarityStore(createFakeEmbedder({ cat: 0, dog: 60 }));
    store.load();
    await flush();
    expect(store.getSnapshot().status).toBe('ready');
    expect((await store.similarity('cat', 'dog')).raw).toBeCloseTo(0.5, 6);
  });

  it('reports a load failure and recovers on retry', async () => {
    const load = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('model file missing'))
      .mockResolvedValue(undefined);
    const store = createSimilarityStore({ ...createFakeEmbedder({ cat: 0, dog: 60 }), load });
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().status));

    store.load();
    await flush();
    expect(store.getSnapshot()).toEqual({ status: 'error', error: 'model file missing' });
    await expect(store.similarity('cat', 'dog')).rejects.toThrow('model file missing');
    expect(load).toHaveBeenCalledTimes(1); // similarity() does not retry by itself

    store.retry();
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
    await flush();
    expect(store.getSnapshot()).toEqual({ status: 'ready' });
    expect(seen).toEqual(['error', 'loading', 'ready']);
    await expect(store.similarity('cat', 'dog')).resolves.toMatchObject({ raw: expect.closeTo(0.5, 6) });
  });

  it('ignores retry() unless the load failed', async () => {
    const load = jest.fn(async () => undefined);
    const store = createSimilarityStore({ ...createFakeEmbedder({}), load });
    store.retry();
    expect(load).not.toHaveBeenCalled();
    store.load();
    await flush();
    store.retry();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('gives a fallback message for errors without one', async () => {
    const store = createSimilarityStore({ ...createFakeEmbedder({}), load: () => Promise.reject(undefined) });
    store.load();
    await flush();
    expect(store.getSnapshot().error).toMatch(/could not be loaded/);
  });

  it('similarity() waits for a load that is still in progress', async () => {
    const gate = deferred();
    const fake = createFakeEmbedder({ cat: 0, dog: 60 });
    const store = createSimilarityStore({ ...fake, embed: fake.embed, load: () => gate.promise });
    const pending = store.similarity('cat', 'dog'); // also starts the load
    await flush();
    expect(fake.calls).toEqual([]);
    gate.resolve();
    await expect(pending).resolves.toMatchObject({ raw: expect.closeTo(0.5, 6) });
    expect(store.getSnapshot().status).toBe('ready');
  });

  it('stops notifying after unsubscribe', async () => {
    const store = createSimilarityStore(createFakeEmbedder({}));
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.load();
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });
});
