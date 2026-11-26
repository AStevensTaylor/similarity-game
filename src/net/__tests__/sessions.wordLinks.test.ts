import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import type { WordLink } from '../../game';
import { parseHostMessage } from '../protocol';
import type { ScoreFn } from '../hostSession';
import { flush, settings, setup, submitClue, wrongGuess } from './harness';

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

/** Scores every clue at 0.948 (just below 0.95); "link*" clues come with a word link to the hidden word. */
const linkingScore: ScoreFn = async (clue, hiddenWord) => {
  const result: { raw: number; score: number; link?: WordLink } = { raw: 0.509, score: 0.948 };
  if (clue.startsWith('link')) result.link = { relation: 'part', from: clue, to: hiddenWord, sources: ['conceptnet'] };
  return result;
};

async function clueTurn(useWordLinks = true) {
  const h = await setup({ score: linkingScore, settings: settings({ useWordLinks }) });
  const giver = h.giverIndex();
  h.clients[giver].chooseWord(h.game().options[0]);
  await flush();
  const word = h.game().hiddenWord as string;
  const guessers = h.clients.map((_, i) => i).filter((i) => i !== giver);
  return { h, giver, word, guessers };
}

describe('word links over Wi-Fi', () => {
  test('a linked clue below the threshold is accepted and the giver is told why', async () => {
    const { h, giver, word } = await clueTurn();
    const result = await submitClue(h.clients[giver], 'linkaa');
    expect(result).toEqual({
      kind: 'accepted',
      clue: 'linkaa',
      score: 0.948,
      raw: 0.509,
      link: { relation: 'part', from: 'linkaa', to: word, sources: ['conceptnet'] },
    });
    expect(h.gameView(giver).phase).toBe('guess');
    expect(h.game().acceptedClues[0]?.link?.to).toBe(word);
  });

  test('an unlinked clue at the same score is rejected', async () => {
    const { h, giver } = await clueTurn();
    expect((await submitClue(h.clients[giver], 'plainaa')).kind).toBe('rejected');
  });

  test('with word links off the host rejects even a linked clue', async () => {
    const { h, giver } = await clueTurn(false);
    const result = await submitClue(h.clients[giver], 'linkaa');
    expect(result.kind).toBe('rejected');
    expect(h.game().phase).toBe('clue');
  });

  test('guessers never see the link (it names the hidden word) until the turn is over', async () => {
    const { h, giver, word, guessers } = await clueTurn();
    await submitClue(h.clients[giver], 'linkaa');
    await flush();
    for (const i of guessers) {
      const view = h.gameView(i);
      expect(view.acceptedClues).toEqual([{ clue: 'linkaa', score: 0.948 }]);
      expect(JSON.stringify(view)).not.toContain(`"${word}"`);
    }
    expect(h.gameView(giver).acceptedClues[0]?.link?.to).toBe(word);

    // Everyone guesses wrong: a failed round. The round record still hides the link from guessers.
    for (const i of guessers) h.clients[i].submitGuess(wrongGuess(h));
    await flush();
    expect(h.game().phase).toBe('round-result');
    for (const i of guessers) {
      expect(h.gameView(i).rounds[0]).not.toHaveProperty('link');
      expect(JSON.stringify(h.gameView(i))).not.toContain(`"${word}"`);
    }
    expect(h.gameView(giver).rounds[0]?.link?.from).toBe('linkaa');
  });

  test('the link survives the wire format, and malformed links are refused', () => {
    const link = { relation: 'part', from: 'root', to: 'tree', sources: ['wordnet'] };
    const ok = parseHostMessage({ v: 2, t: 'clueResult', id: 1, result: { kind: 'accepted', clue: 'root', score: 0.9, raw: 0.5, link } });
    expect(ok.ok && ok.msg).toMatchObject({ result: { kind: 'accepted', link } });
    const bad = parseHostMessage({
      v: 2,
      t: 'clueResult',
      id: 1,
      result: { kind: 'accepted', clue: 'root', score: 0.9, raw: 0.5, link: { ...link, relation: 'teleports' } },
    });
    expect(bad.ok).toBe(false);
  });
});
