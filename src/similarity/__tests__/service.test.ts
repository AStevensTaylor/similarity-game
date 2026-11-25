import { RAW_GATE, SCORE_GATE, calibrate } from '../calibration';
import { cosine, createSimilarityService, normaliseWord } from '../service';
import { createFakeEmbedder, vectorAt } from './fakeEmbedder';

const deg = (cos: number) => (Math.acos(cos) * 180) / Math.PI;

describe('cosine', () => {
  it('is 1 for identical, 0 for orthogonal, -1 for opposite vectors', () => {
    expect(cosine(vectorAt(30), vectorAt(30))).toBeCloseTo(1, 6);
    expect(cosine(vectorAt(0), vectorAt(90))).toBeCloseTo(0, 6);
    expect(cosine(vectorAt(0), vectorAt(180))).toBeCloseTo(-1, 6);
  });

  it('does not require normalised input', () => {
    const a = new Float32Array([3, 0, 0]);
    const b = new Float32Array([5, 5, 0]);
    expect(cosine(a, b)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('never leaves [-1, 1] despite float32 rounding', () => {
    const v = new Float32Array(384).fill(0.1234567);
    expect(cosine(v, v)).toBeLessThanOrEqual(1);
    expect(cosine(v, v)).toBeCloseTo(1, 6);
  });

  it('returns 0 for a zero vector and throws on mismatched lengths', () => {
    expect(cosine(new Float32Array(3), new Float32Array([1, 0, 0]))).toBe(0);
    expect(() => cosine(new Float32Array(3), new Float32Array(4))).toThrow(/lengths differ/);
  });
});

describe('normaliseWord', () => {
  it('trims and lower-cases', () => {
    expect(normaliseWord('  KiTTen \n')).toBe('kitten');
  });
});

describe('createSimilarityService', () => {
  it('returns the raw cosine and its calibrated score', async () => {
    const service = createSimilarityService(createFakeEmbedder({ cat: 0, kitten: 60 }));
    const result = await service.similarity('cat', 'kitten');
    expect(result.raw).toBeCloseTo(0.5, 6);
    expect(result.score).toBe(calibrate(result.raw));
  });

  it('scores a pair at the gate as 0.95 and identical words as 1', async () => {
    const service = createSimilarityService(
      createFakeEmbedder({ a: 0, gate: deg(RAW_GATE + 1e-4), far: 90 }),
    );
    expect((await service.similarity('a', 'gate')).score).toBeCloseTo(SCORE_GATE, 3);
    expect((await service.similarity('a', 'a')).score).toBe(1);
    expect(await service.similarity('a', 'far')).toEqual({ raw: expect.closeTo(0, 6), score: expect.closeTo(0, 6) });
  });

  it('clamps negative cosines to a score of 0', async () => {
    const service = createSimilarityService(createFakeEmbedder({ up: 0, down: 170 }));
    const result = await service.similarity('up', 'down');
    expect(result.raw).toBeLessThan(0);
    expect(result.score).toBe(0);
  });

  it('normalises input before embedding and caching', async () => {
    const fake = createFakeEmbedder({ cat: 0, dog: 45 });
    const service = createSimilarityService(fake);
    await service.similarity('  Cat ', 'DOG');
    await service.similarity('cat', 'dog  ');
    expect(fake.calls).toEqual(['cat', 'dog']);
  });

  it('embeds a word compared with itself only once', async () => {
    const fake = createFakeEmbedder({ cat: 0 });
    const service = createSimilarityService(fake);
    await service.similarity('cat', 'Cat');
    expect(fake.calls).toEqual(['cat']);
  });

  it('rejects empty input without calling the embedder', async () => {
    const fake = createFakeEmbedder({ cat: 0 });
    const service = createSimilarityService(fake);
    await expect(service.similarity('cat', '   ')).rejects.toThrow(/empty/i);
    await expect(service.embed('')).rejects.toThrow(/empty/i);
    expect(fake.calls).not.toContain('');
  });

  it('never calls the embedder concurrently', async () => {
    const fake = createFakeEmbedder({ a: 0, b: 10, c: 20, d: 30, e: 40, f: 50 }, { delayMs: 3 });
    const service = createSimilarityService(fake);
    const results = await Promise.all([
      service.similarity('a', 'b'),
      service.similarity('c', 'd'),
      service.similarity('e', 'f'),
      service.similarity('a', 'f'),
    ]);
    expect(fake.maxConcurrent).toBe(1);
    expect(fake.calls).toHaveLength(6);
    expect(results[0]!.raw).toBeCloseTo(Math.cos((10 * Math.PI) / 180), 6);
    expect(results[3]!.raw).toBeCloseTo(Math.cos((50 * Math.PI) / 180), 6);
  });

  it('does not cache failures and keeps working after one', async () => {
    const options = { failOn: ['dog'] };
    const fake = createFakeEmbedder({ cat: 0, dog: 45, cow: 90 }, options);
    const service = createSimilarityService(fake);
    const failing = service.similarity('cat', 'dog');
    const queuedBehind = service.similarity('cat', 'cow');
    await expect(failing).rejects.toThrow('cannot embed dog');
    await expect(queuedBehind).resolves.toMatchObject({ score: expect.any(Number) });
    options.failOn = [];
    await expect(service.similarity('cat', 'dog')).resolves.toMatchObject({ raw: expect.closeTo(Math.SQRT1_2, 6) });
    expect(fake.calls.filter((w) => w === 'dog')).toHaveLength(2);
    expect(fake.calls.filter((w) => w === 'cat')).toHaveLength(1);
  });

  it('rejects when the embedder returns an empty vector', async () => {
    const service = createSimilarityService({ embed: async () => new Float32Array(0) });
    await expect(service.embed('cat')).rejects.toThrow(/no vector/);
  });

  it('evicts the least recently used embedding when the cache is full', async () => {
    const fake = createFakeEmbedder({ a: 0, b: 10, c: 20 });
    const service = createSimilarityService(fake, { cacheSize: 2 });
    await service.embed('a');
    await service.embed('b');
    await service.embed('a'); // refresh a; b is now the oldest
    await service.embed('c'); // evicts b
    expect(fake.calls).toEqual(['a', 'b', 'c']);
    await service.embed('a'); // still cached
    expect(fake.calls).toEqual(['a', 'b', 'c']);
    await service.embed('b'); // was evicted
    expect(fake.calls).toEqual(['a', 'b', 'c', 'b']);
  });

  it('bounds the default cache at 500 words', async () => {
    const calls: string[] = [];
    const service = createSimilarityService({
      embed: async (text) => {
        calls.push(text);
        return vectorAt(0);
      },
    });
    for (let i = 0; i < 501; i++) await service.embed(`w${i}`);
    await service.embed('w500'); // newest: cached
    await service.embed('w1'); // second oldest: cached
    expect(calls).toHaveLength(501);
    await service.embed('w0'); // oldest: evicted by w500
    expect(calls).toHaveLength(502);
  });
});
