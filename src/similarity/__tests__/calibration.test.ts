import generated from '../calibration.generated.json';
import { GOLDEN_PAIRS, RAW_GATE, SCORE_GATE, calibrate, rawForScore } from '../calibration';

describe('calibration constants', () => {
  it('takes RAW_GATE from the generated calibration file', () => {
    expect(RAW_GATE).toBe(generated.rawGate);
    expect(RAW_GATE).toBeGreaterThan(0.3);
    expect(RAW_GATE).toBeLessThan(0.7);
    expect(Math.round(RAW_GATE * 100) / 100).toBe(RAW_GATE);
    expect(SCORE_GATE).toBe(0.95);
  });

  it('ships golden pairs with plausible reference cosines', () => {
    expect(GOLDEN_PAIRS.length).toBeGreaterThanOrEqual(10);
    for (const pair of GOLDEN_PAIRS) {
      expect(pair.a).toMatch(/^[a-z]+$/);
      expect(pair.b).toMatch(/^[a-z]+$/);
      expect(pair.raw).toBeGreaterThan(-1);
      expect(pair.raw).toBeLessThan(1);
    }
    const raw = (a: string, b: string) => GOLDEN_PAIRS.find((p) => p.a === a && p.b === b)?.raw;
    // Close synonyms pass the gate, unrelated words do not.
    expect(raw('dog', 'puppy')).toBeGreaterThan(RAW_GATE);
    expect(raw('cat', 'kitten')).toBeGreaterThan(RAW_GATE);
    expect(raw('apple', 'democracy')).toBeLessThan(RAW_GATE);
  });
});

describe('calibrate', () => {
  it('maps the anchor points exactly', () => {
    expect(calibrate(0)).toBe(0);
    expect(calibrate(RAW_GATE)).toBeCloseTo(SCORE_GATE, 12);
    expect(calibrate(RAW_GATE)).toBeGreaterThanOrEqual(SCORE_GATE);
    expect(calibrate(1)).toBe(1);
  });

  it('is linear below the gate', () => {
    expect(calibrate(RAW_GATE / 2)).toBeCloseTo(SCORE_GATE / 2, 12);
    expect(calibrate(RAW_GATE / 4)).toBeCloseTo(SCORE_GATE / 4, 12);
  });

  it('is linear above the gate', () => {
    const mid = (RAW_GATE + 1) / 2;
    expect(calibrate(mid)).toBeCloseTo((SCORE_GATE + 1) / 2, 12);
  });

  it('clamps to [0, 1]', () => {
    expect(calibrate(-0.4)).toBe(0);
    expect(calibrate(-1)).toBe(0);
    expect(calibrate(1.0000001)).toBe(1);
    expect(calibrate(5)).toBe(1);
    expect(calibrate(Number.NaN)).toBe(0);
  });

  it('is strictly increasing on (0, 1) and stays inside [0, 1]', () => {
    let previous = calibrate(0);
    for (let i = 1; i <= 1000; i++) {
      const value = calibrate(i / 1000);
      expect(value).toBeGreaterThan(previous);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
  });

  it('puts a raw cosine just under the gate just under 0.95', () => {
    expect(calibrate(RAW_GATE - 0.001)).toBeLessThan(SCORE_GATE);
    expect(calibrate(RAW_GATE + 0.001)).toBeGreaterThan(SCORE_GATE);
  });

  it('is inverted by rawForScore', () => {
    for (const raw of [0.05, 0.2, RAW_GATE, 0.6, 0.8, 0.99]) {
      expect(rawForScore(calibrate(raw))).toBeCloseTo(raw, 10);
    }
    expect(rawForScore(SCORE_GATE)).toBeCloseTo(RAW_GATE, 12);
    expect(rawForScore(0)).toBe(0);
    expect(rawForScore(1)).toBe(1);
  });
});
