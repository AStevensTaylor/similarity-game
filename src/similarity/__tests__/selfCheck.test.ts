import { GOLDEN_PAIRS, RAW_GATE } from '../calibration';
import { runSelfCheck } from '../selfCheck';
import { createSimilarityService } from '../service';
import { createFakeEmbedder } from './fakeEmbedder';

const deg = (cos: number) => (Math.acos(cos) * 180) / Math.PI;

describe('runSelfCheck', () => {
  it('reports raw, expectedRaw and delta for each pair', async () => {
    const service = createSimilarityService(createFakeEmbedder({ dog: 0, puppy: deg(0.8), cat: 0, car: deg(0.3) }));
    const report = await runSelfCheck(service, [
      { a: 'dog', b: 'puppy', raw: 0.78 },
      { a: 'cat', b: 'car', raw: 0.35 },
    ]);
    expect(report.pairs).toHaveLength(2);
    expect(report.pairs[0]).toMatchObject({ a: 'dog', b: 'puppy', expectedRaw: 0.78, gateFlipped: false });
    expect(report.pairs[0]!.raw).toBeCloseTo(0.8, 5);
    expect(report.pairs[0]!.delta).toBeCloseTo(0.02, 5);
    expect(report.pairs[1]!.delta).toBeCloseTo(-0.05, 5);
    expect(report.maxAbsDelta).toBeCloseTo(0.05, 5);
    expect(report.meanAbsDelta).toBeCloseTo(0.035, 5);
    expect(report.gateFlips).toBe(0);
  });

  it('flags pairs that land on the other side of the gate', async () => {
    const service = createSimilarityService(createFakeEmbedder({ a: 0, b: deg(RAW_GATE - 0.02) }));
    const report = await runSelfCheck(service, [{ a: 'a', b: 'b', raw: RAW_GATE + 0.02 }]);
    expect(report.pairs[0]!.gateFlipped).toBe(true);
    expect(report.gateFlips).toBe(1);
  });

  it('defaults to the golden pairs from the calibration file', async () => {
    const calls: Array<[string, string]> = [];
    const report = await runSelfCheck({
      similarity: async (a, b) => {
        calls.push([a, b]);
        const expected = GOLDEN_PAIRS.find((p) => p.a === a && p.b === b)!.raw;
        return { raw: expected, score: 0 };
      },
    });
    expect(calls).toEqual(GOLDEN_PAIRS.map((p) => [p.a, p.b]));
    expect(report.maxAbsDelta).toBe(0);
    expect(report.gateFlips).toBe(0);
  });

  it('handles an empty pair list', async () => {
    const report = await runSelfCheck({ similarity: async () => ({ raw: 0, score: 0 }) }, []);
    expect(report).toEqual({ pairs: [], meanAbsDelta: 0, maxAbsDelta: 0, gateFlips: 0 });
  });
});
