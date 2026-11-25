/**
 * One clue submission, end to end: rule check -> model score -> the engine
 * action to dispatch. Kept free of React so it can be tested directly.
 */
import { validateClue, type GameAction, type GameState } from '../../game';
import type { SimilarityResult } from '../../similarity';

export type ClueAttemptResult =
  /** Broke a rule; nothing was scored and it does not count as an attempt. */
  | { kind: 'invalid'; message: string }
  /** The model could not score it; nothing is recorded, the giver may retry. */
  | { kind: 'error'; message: string }
  | { kind: 'scored'; accepted: boolean; clue: string; score: number; raw: number; action: GameAction };

export interface ClueAttemptDeps {
  similarity(a: string, b: string): Promise<SimilarityResult>;
  isNoun(word: string): boolean;
}

function describeError(error: unknown): string {
  const detail = error instanceof Error && error.message ? error.message : typeof error === 'string' ? error : '';
  return detail
    ? `The word model could not score that clue (${detail}). Nothing was counted - try again.`
    : 'The word model could not score that clue. Nothing was counted - try again.';
}

export async function attemptClue(input: string, state: GameState, deps: ClueAttemptDeps): Promise<ClueAttemptResult> {
  if (state.phase !== 'clue' || state.hiddenWord === null) {
    return { kind: 'error', message: 'It is not time to give a clue.' };
  }
  const validation = validateClue(input, {
    options: state.options,
    tried: state.triedClues,
    requireDictionaryNoun: state.settings.requireDictionaryNoun,
    isNoun: deps.isNoun,
  });
  if (!validation.ok) return { kind: 'invalid', message: validation.message };

  let result: SimilarityResult;
  try {
    result = await deps.similarity(validation.clue, state.hiddenWord);
  } catch (error) {
    return { kind: 'error', message: describeError(error) };
  }
  if (!Number.isFinite(result.score) || !Number.isFinite(result.raw)) {
    return { kind: 'error', message: describeError('the model returned an invalid score') };
  }

  // Same comparison the engine makes, so the dispatched action is always valid.
  const accepted = result.score >= state.settings.threshold;
  return {
    kind: 'scored',
    accepted,
    clue: validation.clue,
    score: result.score,
    raw: result.raw,
    action: { type: accepted ? 'CLUE_ACCEPTED' : 'CLUE_REJECTED', clue: validation.clue, score: result.score },
  };
}
