import { describe, expect, it, jest } from '@jest/globals';

import { createGame, gameReducer, type GameState } from '../../game';
import type { SimilarityResult } from '../../similarity';
import { attemptClue } from '../game/clueAttempt';

const DECK = ['river', 'candle', 'garden', 'pencil', 'window', 'bottle', 'ladder', 'mirror', 'pocket', 'saddle'];
const SETTINGS = { turnsPerPlayer: 1, threshold: 0.95, guessMode: 'open', requireDictionaryNoun: true } as const;

function clueState(): GameState {
  let state = createGame(['Ana', 'Bo'], SETTINGS, DECK, 7);
  state = gameReducer(state, { type: 'REVEAL' }, DECK);
  state = gameReducer(state, { type: 'CHOOSE_WORD', word: state.options[0] }, DECK);
  expect(state.phase).toBe('clue');
  return state;
}

function deps(result: SimilarityResult | Error, nouns: string[] = ['stream', 'flame']) {
  const similarity = jest.fn(async (_a: string, _b: string): Promise<SimilarityResult> => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { similarity, isNoun: (w: string) => nouns.includes(w) };
}

describe('attemptClue', () => {
  it('rejects rule-breaking clues without calling the model', async () => {
    const state = clueState();
    const d = deps({ raw: 0.9, score: 0.99 });
    expect(await attemptClue(state.options[1], state, d)).toEqual({
      kind: 'invalid',
      message: 'A clue cannot be one of the five words.',
    });
    expect((await attemptClue('two words', state, d)).kind).toBe('invalid');
    expect((await attemptClue('notinlist', state, d)).kind).toBe('invalid');
    expect(d.similarity).not.toHaveBeenCalled();
  });

  it('produces CLUE_ACCEPTED at or above the threshold, and the engine takes it', async () => {
    const state = clueState();
    const d = deps({ raw: 0.51, score: 0.95 });
    const result = await attemptClue('  Stream ', state, d);
    expect(d.similarity).toHaveBeenCalledWith('stream', state.options[0]);
    expect(result).toEqual({
      kind: 'scored',
      accepted: true,
      clue: 'stream',
      score: 0.95,
      raw: 0.51,
      action: { type: 'CLUE_ACCEPTED', clue: 'stream', score: 0.95 },
    });
    if (result.kind !== 'scored') throw new Error('unreachable');
    const next = gameReducer(state, result.action, DECK);
    expect(next.phase).toBe('handoff-guesser');
    expect(next.acceptedClues).toEqual([{ clue: 'stream', score: 0.95 }]);
  });

  it('produces CLUE_REJECTED just below the threshold, and then refuses the same clue again', async () => {
    const state = clueState();
    const d = deps({ raw: 0.5, score: 0.9499 });
    const result = await attemptClue('stream', state, d);
    if (result.kind !== 'scored') throw new Error('expected a scored result');
    expect(result.accepted).toBe(false);
    expect(result.action.type).toBe('CLUE_REJECTED');
    const next = gameReducer(state, result.action, DECK);
    expect(next).not.toBe(state);
    expect(next.rejectedThisRound).toEqual([{ clue: 'stream', score: 0.9499 }]);

    const again = await attemptClue('stream', next, d);
    expect(again).toEqual({ kind: 'invalid', message: 'You already tried that clue this turn.' });
    expect(d.similarity).toHaveBeenCalledTimes(1);
  });

  it('uses the game threshold, not the default', async () => {
    const base = clueState();
    const state: GameState = { ...base, settings: { ...base.settings, threshold: 0.8 } };
    const result = await attemptClue('stream', state, deps({ raw: 0.45, score: 0.84 }));
    expect(result.kind === 'scored' && result.accepted).toBe(true);
  });

  it('skips the dictionary check when the setting is off', async () => {
    const base = clueState();
    const state: GameState = { ...base, settings: { ...base.settings, requireDictionaryNoun: false } };
    expect((await attemptClue('notinlist', state, deps({ raw: 0.1, score: 0.2 }))).kind).toBe('scored');
  });

  it('turns model failures and invalid scores into errors that record nothing', async () => {
    const state = clueState();
    const failed = await attemptClue('stream', state, deps(new Error('RESOURCE_BUSY')));
    expect(failed.kind).toBe('error');
    expect(failed.kind === 'error' && failed.message).toContain('RESOURCE_BUSY');
    expect((await attemptClue('stream', state, deps({ raw: Number.NaN, score: Number.NaN }))).kind).toBe('error');
  });

  it('refuses outside the clue phase', async () => {
    const state = createGame(['Ana', 'Bo'], SETTINGS, DECK, 7);
    const d = deps({ raw: 1, score: 1 });
    expect((await attemptClue('stream', state, d)).kind).toBe('error');
    expect(d.similarity).not.toHaveBeenCalled();
  });
});
