import { describe, expect, it, jest } from '@jest/globals';

import { DECK } from '../../data/nouns';
import { createGame, type GameSettings } from '../../game';
import { SimilarityProvider } from '../../similarity';
import { GameScreen } from '../game/GameScreen';
import { createTestEmbedder, render, type Rendered } from './testUtils';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const NAMES = ['Ana', 'Bo', 'Cy'];
const SEED = 1234;

function settings(overrides: Partial<GameSettings> = {}): GameSettings {
  return { turnsPerPlayer: 1, threshold: 0.95, guessMode: 'open', requireDictionaryNoun: false, ...overrides };
}

async function renderGame(s: GameSettings, names = NAMES, embedder = createTestEmbedder()) {
  const callbacks = { onRequestQuit: jest.fn(), onHome: jest.fn(), onPlayAgain: jest.fn(), onPhaseChange: jest.fn() };
  const ui = await render(
    <SimilarityProvider embedder={embedder}>
      <GameScreen playerNames={names} settings={s} seed={SEED} {...callbacks} />
    </SimilarityProvider>,
  );
  // The reducer is deterministic, so the same seed tells the test what was dealt.
  const initial = createGame(names, s, DECK, SEED);
  return { ui, callbacks, options: initial.options };
}

function expectNoneVisible(ui: Rendered, words: readonly string[]) {
  const visible = ui.texts().join(' | ').toLowerCase();
  for (const word of words) expect(visible).not.toContain(word);
}

async function giveClue(ui: Rendered, clue: string) {
  await ui.type('clue-input', clue);
  await ui.press('submit-clue');
}

async function guess(ui: Rendered, word: string) {
  await ui.press('reveal');
  await ui.type('guess-input', word);
  await ui.press('submit-guess');
}

describe('GameScreen pass-and-play flow (open mode)', () => {
  it('keeps private information off public screens for a whole turn', async () => {
    const { ui, callbacks, options } = await renderGame(settings());
    const hidden = options[2];

    // Hand-off to the giver: names the giver, shows none of the words.
    expect(ui.byTestId('phase-handoff-giver')).toBeTruthy();
    expect(ui.allText()).toContain('ana');
    expectNoneVisible(ui, options);
    expect(callbacks.onPhaseChange).toHaveBeenLastCalledWith('handoff-giver');

    // Giver sees all five options and picks one.
    await ui.press('reveal');
    for (const word of options) expect(ui.allText()).toContain(word);
    await ui.press(`option-${hidden}`);
    await ui.press('confirm-word');
    expect(ui.byTestId('hidden-word').children).toEqual([hidden]);

    // A clue that breaks a rule is not scored and not counted.
    await giveClue(ui, hidden);
    expect(ui.byTestId('clue-feedback').children.join('')).toContain('cannot be one of the five words');
    expect(ui.allText()).not.toContain('rejected this round');

    // A clue the model scores too low is rejected, privately, with its score.
    await giveClue(ui, 'farclue');
    expect(ui.byTestId('phase-clue')).toBeTruthy();
    expect(ui.byTestId('rejected-farclue')).toBeTruthy();
    expect(ui.allText()).toContain('0.323');
    expect(ui.queryByTestId('forfeit')).toBeNull();

    // An accepted clue moves on to the first guesser's hand-off, which shows nothing secret.
    await giveClue(ui, 'closeclue');
    expect(ui.byTestId('phase-handoff-guesser')).toBeTruthy();
    expect(ui.allText()).toContain('bo');
    expectNoneVisible(ui, [...options, 'farclue', '0.323']);

    // First guesser: sees the accepted clue only (no options in open mode, no rejected attempts).
    await ui.press('reveal');
    expect(ui.byTestId('latest-clue').children).toEqual(['closeclue']);
    expectNoneVisible(ui, [...options, 'farclue']);
    await ui.type('guess-input', 'wrongguess');
    await ui.press('submit-guess');

    // Second guesser's hand-off and guess screen do not show the first guess.
    expect(ui.byTestId('phase-handoff-guesser')).toBeTruthy();
    expect(ui.allText()).toContain('cy');
    expectNoneVisible(ui, [...options, 'wrongguess']);
    await ui.press('reveal');
    expectNoneVisible(ui, [...options, 'wrongguess']);
    await ui.type('guess-input', 'alsowrong');
    await ui.press('submit-guess');

    // Round result is public: all guesses are revealed, the hidden word is not.
    expect(ui.byTestId('phase-round-result')).toBeTruthy();
    expect(ui.allText()).toContain('wrongguess');
    expect(ui.allText()).toContain('alsowrong');
    expect(ui.allText()).toContain('nobody got it');
    expectNoneVisible(ui, options);

    // Second clue round: hand-off back to the giver stays clean, then straight to the clue screen.
    await ui.press('next');
    expect(ui.byTestId('phase-handoff-giver')).toBeTruthy();
    expectNoneVisible(ui, options);
    await ui.press('reveal');
    expect(ui.byTestId('hidden-word').children).toEqual([hidden]);

    // A clue from an earlier round cannot be reused.
    await giveClue(ui, 'closeclue');
    expect(ui.byTestId('clue-feedback').children.join('')).toContain('already tried');
    await giveClue(ui, 'closeagain');

    // Bo is wrong again, Cy gets it (plural accepted).
    await guess(ui, 'nope');
    await ui.press('reveal');
    expect(ui.allText()).toContain('wrongguess'); // earlier, already-public guesses are shown
    expectNoneVisible(ui, ['nope', hidden]);
    await ui.type('guess-input', `  ${hidden.toUpperCase()}  `);
    await ui.press('submit-guess');

    expect(ui.byTestId('phase-round-result')).toBeTruthy();
    expect(ui.allText()).toContain('cy got it');

    // Turn result reveals the word and the points.
    await ui.press('next');
    expect(ui.byTestId('revealed-word').children).toEqual([hidden]);
    expect(ui.allText()).toContain('next turn: pass to bo');

    // Next turn starts with a clean hand-off for the next giver.
    await ui.press('next');
    expect(ui.byTestId('phase-handoff-giver')).toBeTruthy();
    expect(ui.allText()).toContain('bo');
    expect(callbacks.onPhaseChange).toHaveBeenLastCalledWith('handoff-giver');
    await ui.unmount();
  });

  it('offers forfeit only after five rejected clues and reports model errors without counting them', async () => {
    let fail = false;
    const { ui, options } = await renderGame(settings(), NAMES, createTestEmbedder({ failEmbed: () => fail }));
    await ui.press('reveal');
    await ui.press(`option-${options[0]}`);
    await ui.press('confirm-word');

    fail = true;
    await giveClue(ui, 'farzero');
    expect(ui.byTestId('clue-feedback').children.join('')).toContain('could not score');
    expect(ui.queryByTestId('rejected-farzero')).toBeNull();
    fail = false;

    for (const clue of ['farone', 'fartwo', 'farthree', 'farfour']) await giveClue(ui, clue);
    expect(ui.queryByTestId('forfeit')).toBeNull();
    await giveClue(ui, 'farfive');
    expect(ui.byTestId('forfeit')).toBeTruthy();
    await ui.unmount();
  });
});

describe('GameScreen list mode and game over', () => {
  it('shows guessers the five options and ends with a ranked leaderboard', async () => {
    const names = ['Ana', 'Bo'];
    const { ui, callbacks, options } = await renderGame(settings({ guessMode: 'list' }), names);
    const hidden = options[1];

    await ui.press('reveal');
    await ui.press(`option-${hidden}`);
    await ui.press('confirm-word');
    await giveClue(ui, 'closeclue');

    await ui.press('reveal');
    for (const word of options) expect(ui.byTestId(`guess-option-${word}`)).toBeTruthy();
    await ui.press(`guess-option-${hidden}`);
    await ui.press('submit-guess');
    expect(ui.allText()).toContain('bo got it');
    await ui.press('next');
    await ui.press('next');

    // Turn 2: Bo gives, Ana guesses right. 1 point each: a tie.
    await ui.press('reveal');
    const dealt = ui.root.container
      .queryAll((i) => typeof i.props.testID === 'string' && i.props.testID.startsWith('option-'), { matchDeepestOnly: true })
      .map((i) => (i.props.testID as string).slice('option-'.length));
    expect(dealt).toHaveLength(5);
    // Words already offered are not offered again.
    for (const word of dealt) expect(options).not.toContain(word);

    await ui.press(`option-${dealt[0]}`);
    await ui.press('confirm-word');
    await giveClue(ui, 'closeclue');
    await ui.press('reveal');
    await ui.press(`guess-option-${dealt[0]}`);
    await ui.press('submit-guess');
    await ui.press('next');
    expect(ui.allText()).toContain('see the final scores');
    await ui.press('next');

    expect(ui.byTestId('phase-game-over')).toBeTruthy();
    expect(ui.byTestId('winner-headline').children.join('')).toBe("It's a tie all round!");
    expect(ui.allText()).toContain('=1');
    expect(callbacks.onPhaseChange).toHaveBeenLastCalledWith('game-over');

    await ui.press('play-again');
    expect(callbacks.onPlayAgain).toHaveBeenCalledTimes(1);
    await ui.press('home');
    expect(callbacks.onHome).toHaveBeenCalledTimes(1);
    await ui.unmount();
  });
});
