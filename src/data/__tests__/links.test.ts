import { describe, expect, test } from '@jest/globals';

import { LINK_RELATIONS, isWordLink } from '../../game';
import linksJson from '../links.json';
import { findLink, linkCount } from '../links';
import nounsJson from '../nouns.json';

describe('the bundled link table', () => {
  test('matches the relation list and nouns.json', () => {
    expect(linksJson.format).toBe(1);
    expect(linksJson.relations).toEqual([...LINK_RELATIONS]);
    const p = linksJson.pairs;
    expect(p.length % 3).toBe(0);
    expect(linkCount()).toBe(p.length / 3); // no duplicate pairs
    expect(linkCount()).toBeGreaterThan(70000);
    let prev = -1;
    for (let k = 0; k < p.length; k += 3) {
      const [i, j, code] = [p[k]!, p[k + 1]!, p[k + 2]!];
      expect(i < j && j < nounsJson.length).toBe(true);
      expect(i * 65536 + j > prev).toBe(true); // sorted
      prev = i * 65536 + j;
      expect(code >> 4 < LINK_RELATIONS.length && (code & 3) !== 0 && ((code >> 2) & 3) !== 3).toBe(true);
      // Words that contain each other are blocked as clues anyway, so the table leaves them out.
      const [a, b] = [nounsJson[i]!, nounsJson[j]!];
      if (a.includes(b) || b.includes(a)) throw new Error(`overlapping pair ${a} / ${b}`);
    }
  });

  test('every link decodes to a valid WordLink', () => {
    const p = linksJson.pairs;
    for (let k = 0; k < p.length; k += 3 * 97) {
      const link = findLink(nounsJson[p[k]!]!, nounsJson[p[k + 1]!]!);
      expect(isWordLink(link)).toBe(true);
    }
  });
});

describe('findLink', () => {
  test('knows the pairs the model scores too low', () => {
    for (const [a, b] of [
      ['tree', 'root'],
      ['tree', 'trunk'],
      ['car', 'wheel'],
      ['house', 'roof'],
      ['bird', 'nest'],
      ['fish', 'fin'],
      ['book', 'page'],
      ['flower', 'petal'],
      ['key', 'lock'],
      ['bread', 'butter'],
    ]) {
      expect(findLink(a!, b!)).not.toBeNull();
    }
  });

  test('a directed relation reads the right way round whatever the argument order', () => {
    const expected = { relation: 'part', from: 'trunk', to: 'tree' };
    expect(findLink('tree', 'trunk')).toMatchObject(expected);
    expect(findLink('trunk', 'tree')).toMatchObject(expected);
    expect(findLink('tree', 'trunk')?.sources).toEqual(['wordnet', 'conceptnet']);
    expect(findLink('oak', 'tree')).toMatchObject({ relation: 'kind', from: 'oak', to: 'tree' });
  });

  test('a symmetric relation keeps the argument order', () => {
    expect(findLink('sofa', 'couch')).toMatchObject({ relation: 'synonym', from: 'sofa', to: 'couch' });
    expect(findLink('couch', 'sofa')).toMatchObject({ relation: 'synonym', from: 'couch', to: 'sofa' });
  });

  test('normalises input and returns null for unlinked, unknown or identical words', () => {
    expect(findLink('  Tree ', 'ROOT')).toMatchObject({ from: 'root', to: 'tree' });
    expect(findLink('apple', 'democracy')).toBeNull();
    expect(findLink('cat', 'car')).toBeNull();
    expect(findLink('tree', 'xyzzyplugh')).toBeNull();
    expect(findLink('tree', 'tree')).toBeNull();
  });
});
