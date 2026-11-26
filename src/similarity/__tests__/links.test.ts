import { describe, expect, jest, test } from '@jest/globals';

import type { WordLink } from '../../game';
import { LINK_RAW_FLOOR, RAW_GATE } from '../calibration';
import { createSimilarityService } from '../service';
import type { Embedder } from '../types';

/** "tree" and every other word embed as unit vectors with the given cosine between them. */
function embedderFor(cos: number): Embedder {
  const angle = Math.acos(cos);
  return {
    embed: async (w: string) => new Float32Array(w === 'tree' ? [1, 0] : [Math.cos(angle), Math.sin(angle)]),
  };
}

const LINK: WordLink = { relation: 'part', from: 'root', to: 'tree', sources: ['conceptnet'] };

describe('word links in the similarity service', () => {
  test('the floor sits well below the gate', () => {
    expect(LINK_RAW_FLOOR).toBeGreaterThan(0);
    expect(LINK_RAW_FLOOR).toBeLessThan(RAW_GATE);
  });

  test('a link is attached when the raw cosine reaches the floor', async () => {
    const findLink = jest.fn((_a: string, _b: string): WordLink | null => LINK);
    const service = createSimilarityService(embedderFor(0.4), { findLink });
    const result = await service.similarity(' Root ', 'TREE');
    expect(result.link).toEqual(LINK);
    expect(findLink).toHaveBeenCalledWith('root', 'tree');
  });

  test('no link below the floor, or without a lookup', async () => {
    const below = createSimilarityService(embedderFor(LINK_RAW_FLOOR - 0.01), { findLink: () => LINK });
    expect(await below.similarity('root', 'tree')).not.toHaveProperty('link');
    const none = createSimilarityService(embedderFor(0.4));
    expect(await none.similarity('root', 'tree')).not.toHaveProperty('link');
    const unlinked = createSimilarityService(embedderFor(0.4), { findLink: () => null });
    expect(await unlinked.similarity('root', 'tree')).not.toHaveProperty('link');
  });
});
