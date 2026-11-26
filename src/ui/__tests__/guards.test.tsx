import { afterEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act } from 'react';
import { Alert } from 'react-native';

import { DECK } from '../../data/nouns';
import { DEFAULT_SETTINGS, createGame, gameReducer, type GameAction, type GameSettings, type GameState } from '../../game';
import { SimilarityProvider, type Embedder } from '../../similarity';
import { SETTINGS_KEY } from '../../storage';
import { ClueScreen } from '../game/ClueScreen';
import { GameScreen } from '../game/GameScreen';
import { GuessScreen } from '../game/GuessScreen';
import { CheckerScreen } from '../screens/CheckerScreen';
import { SettingsProvider, useSettings, type SettingsContextValue } from '../SettingsContext';
import { createTestEmbedder, flush, render, type Rendered } from './testUtils';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const SEED = 1234;

function settings(overrides: Partial<GameSettings> = {}): GameSettings {
  return { turnsPerPlayer: 1, threshold: 0.95, guessMode: 'open', requireDictionaryNoun: false, useWordLinks: true, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** An embedder whose embed() calls stay pending until release() is called. */
function createHeldEmbedder() {
  const inner = createTestEmbedder();
  const gate = deferred<void>();
  const calls: string[] = [];
  const embedder: Embedder & { load(): Promise<void> } = {
    load: inner.load,
    async embed(text) {
      calls.push(text);
      await gate.promise;
      return inner.embed(text);
    },
  };
  return { embedder, calls, release: () => gate.resolve() };
}

function play(state: GameState, ...actions: GameAction[]): GameState {
  return actions.reduce((s, a) => gameReducer(s, a, DECK), state);
}

async function renderGame(s: GameSettings, names: string[], embedder = createTestEmbedder()) {
  const callbacks = { onRequestQuit: jest.fn(), onHome: jest.fn(), onPlayAgain: jest.fn(), onPhaseChange: jest.fn() };
  const ui = await render(
    <SimilarityProvider embedder={embedder}>
      <GameScreen playerNames={names} settings={s} seed={SEED} {...callbacks} />
    </SimilarityProvider>,
  );
  return { ui, callbacks, options: createGame(names, s, DECK, SEED).options };
}

async function giveClue(ui: Rendered, clue: string) {
  await ui.type('clue-input', clue);
  await ui.press('submit-clue');
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('double-tap guard between game steps', () => {
  it('ignores the second tap of a double tap on every phase-advancing button', async () => {
    const { ui, callbacks, options } = await renderGame(settings({ guessMode: 'list' }), ['Ana', 'Bo']);
    const hidden = options[0];
    const wrong = options[1];

    await ui.press('reveal');
    await ui.press(`option-${hidden}`);
    await ui.press('confirm-word');
    await giveClue(ui, 'closeclue');

    // Accepted clue -> guesser hand-off: an immediate tap must not reveal the guess screen.
    expect(ui.byTestId('phase-handoff-guesser')).toBeTruthy();
    await ui.pressNow('reveal');
    expect(ui.byTestId('phase-handoff-guesser')).toBeTruthy();
    await ui.press('reveal');
    await ui.press(`guess-option-${wrong}`);
    await ui.press('submit-guess');

    // Failed round (public screen): a double tap on "next" must stop at the giver hand-off
    // and never reach the clue screen, which shows the hidden word.
    expect(ui.byTestId('phase-round-result')).toBeTruthy();
    await ui.press('next');
    await ui.pressNow('reveal');
    expect(ui.byTestId('phase-handoff-giver')).toBeTruthy();
    expect(ui.queryByTestId('hidden-word')).toBeNull();
    expect(ui.allText()).not.toContain(hidden);

    // After a pause the same button works.
    await ui.press('reveal');
    expect(ui.byTestId('hidden-word').children).toEqual([hidden]);
    await giveClue(ui, 'closeagain');
    await ui.press('reveal');
    await ui.press(`guess-option-${hidden}`);
    await ui.press('submit-guess');

    // Last guess -> round result: an immediate "next" must not skip the revealed guesses.
    expect(ui.byTestId('phase-round-result')).toBeTruthy();
    await ui.pressNow('next');
    expect(ui.byTestId('phase-round-result')).toBeTruthy();

    // Round result -> turn result: two immediate presses of "next" stay on the turn result.
    await ui.press('next');
    await ui.pressNow('next');
    expect(ui.byTestId('phase-turn-result')).toBeTruthy();
    expect(ui.byTestId('revealed-word').children).toEqual([hidden]);

    // Turn result -> next giver's hand-off: an immediate tap must not show the next giver's words.
    await ui.press('next');
    await ui.pressNow('reveal');
    expect(ui.byTestId('phase-handoff-giver')).toBeTruthy();
    expect(ui.queryByTestId('phase-choose-word')).toBeNull();

    // Second (last) turn, straight through.
    await ui.press('reveal');
    const dealt = ui.root.container
      .queryAll((i) => typeof i.props.testID === 'string' && i.props.testID.startsWith('option-'), { matchDeepestOnly: true })
      .map((i) => (i.props.testID as string).slice('option-'.length));
    await ui.press(`option-${dealt[0]}`);
    await ui.press('confirm-word');
    await giveClue(ui, 'closeclue');
    await ui.press('reveal');
    await ui.press(`guess-option-${dealt[0]}`);
    await ui.press('submit-guess');
    await ui.press('next');

    // "See the final scores" -> game over: "Home" and "Play again" sit under the same thumb.
    await ui.press('next');
    expect(ui.byTestId('phase-game-over')).toBeTruthy();
    await ui.pressNow('home');
    await ui.pressNow('play-again');
    expect(callbacks.onHome).not.toHaveBeenCalled();
    expect(callbacks.onPlayAgain).not.toHaveBeenCalled();
    await ui.press('home');
    expect(callbacks.onHome).toHaveBeenCalledTimes(1);
    await ui.unmount();
  });

  it('also guards the very first hand-off after the game starts', async () => {
    const { ui } = await renderGame(settings(), ['Ana', 'Bo']);
    await ui.pressNow('reveal');
    expect(ui.byTestId('phase-handoff-giver')).toBeTruthy();
    await ui.press('reveal');
    expect(ui.byTestId('phase-choose-word')).toBeTruthy();
    await ui.unmount();
  });
});

describe('a word model that cannot score', () => {
  it('lets the players end the game and keeps the scores earned so far', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    let fail = false;
    const { ui, callbacks, options } = await renderGame(
      settings({ guessMode: 'list' }),
      ['Ana', 'Bo', 'Cy'],
      createTestEmbedder({ failEmbed: () => fail }),
    );

    // Turn 1 works: Bo guesses Ana's word and scores a point.
    await ui.press('reveal');
    await ui.press(`option-${options[0]}`);
    await ui.press('confirm-word');
    expect(ui.queryByTestId('end-game')).toBeNull();
    await giveClue(ui, 'closeclue');
    await ui.press('reveal');
    await ui.press(`guess-option-${options[0]}`);
    await ui.press('submit-guess');
    await ui.press('reveal');
    await ui.press(`guess-option-${options[1]}`);
    await ui.press('submit-guess');
    await ui.press('next');
    await ui.press('next');

    // Turn 2: the model starts failing. Errors are not rejections, so forfeit never unlocks.
    await ui.press('reveal');
    const dealt = ui.root.container
      .queryAll((i) => typeof i.props.testID === 'string' && i.props.testID.startsWith('option-'), { matchDeepestOnly: true })
      .map((i) => (i.props.testID as string).slice('option-'.length));
    await ui.press(`option-${dealt[0]}`);
    await ui.press('confirm-word');
    fail = true;
    await giveClue(ui, 'cluea');
    expect(ui.queryByTestId('end-game')).toBeNull(); // one failure could be a blip
    await giveClue(ui, 'clueb');
    expect(ui.queryByTestId('forfeit')).toBeNull();
    expect(ui.byTestId('model-stuck')).toBeTruthy();

    // Ending the game asks first.
    await ui.press('end-game');
    expect(ui.byTestId('phase-clue')).toBeTruthy();
    expect(alert).toHaveBeenCalledTimes(1);
    const confirm = (alert.mock.calls[0][2] ?? []).find((b) => b.style === 'destructive');
    await act(async () => {
      confirm?.onPress?.();
    });

    expect(ui.byTestId('phase-game-over')).toBeTruthy();
    expect(ui.queryByTestId('phase-clue')).toBeNull();
    expect(ui.queryByTestId('hidden-word')).toBeNull();
    expect(ui.byTestId('winner-headline').children.join('')).toBe('Bo wins!');
    expect(callbacks.onPhaseChange).toHaveBeenLastCalledWith('game-over');
    await ui.press('play-again');
    expect(callbacks.onPlayAgain).toHaveBeenCalledTimes(1);
    await ui.unmount();
  });

  it('offers the way out as soon as the model has failed to load, and after a recovery hides it again', async () => {
    let failEmbed = false;
    let scoreErrors = 0;
    const { ui, options } = await renderGame(
      settings(),
      ['Ana', 'Bo'],
      createTestEmbedder({
        failEmbed: () => {
          if (failEmbed) scoreErrors++;
          return failEmbed;
        },
      }),
    );
    await ui.press('reveal');
    await ui.press(`option-${options[0]}`);
    await ui.press('confirm-word');
    failEmbed = true;
    await giveClue(ui, 'cluea');
    await giveClue(ui, 'clueb');
    expect(scoreErrors).toBeGreaterThanOrEqual(2);
    expect(ui.byTestId('end-game')).toBeTruthy();
    failEmbed = false;
    await giveClue(ui, 'farclue');
    expect(ui.byTestId('rejected-farclue')).toBeTruthy();
    expect(ui.queryByTestId('end-game')).toBeNull();
    await ui.unmount();

    const broken = await renderGame(settings(), ['Ana', 'Bo'], createTestEmbedder({ failLoad: true }));
    await broken.ui.press('reveal');
    await broken.ui.press(`option-${broken.options[0]}`);
    await broken.ui.press('confirm-word');
    expect(broken.ui.byTestId('end-game')).toBeTruthy();
    await broken.ui.unmount();
  });
});

describe('ClueScreen', () => {
  function clueState(): GameState {
    const initial = createGame(['Ana', 'Bo'], settings(), DECK, SEED);
    return play(initial, { type: 'REVEAL' }, { type: 'CHOOSE_WORD', word: initial.options[0] });
  }

  it('scores and records a double-submitted clue once, and keeps the input editable while scoring', async () => {
    const held = createHeldEmbedder();
    const ui = await render(
      <SimilarityProvider embedder={held.embedder}>
        <GameScreen playerNames={['Ana', 'Bo']} settings={settings()} seed={SEED} onRequestQuit={jest.fn()} onHome={jest.fn()} onPlayAgain={jest.fn()} />
      </SimilarityProvider>,
    );
    const options = createGame(['Ana', 'Bo'], settings(), DECK, SEED).options;
    await ui.press('reveal');
    await ui.press(`option-${options[0]}`);
    await ui.press('confirm-word');
    await ui.type('clue-input', 'farclue');

    // Two taps in the same frame: both reach the same handler before any re-render.
    const submit = ui.handler('submit-clue', 'onPress');
    await act(async () => {
      submit();
      submit();
    });
    await flush();

    // Still scoring: the field must not be disabled (that would close the Android keyboard).
    expect(ui.allText()).toContain('scoring...');
    expect(ui.byTestId('clue-input').props.editable).not.toBe(false);

    held.release();
    await flush(20);
    expect(held.calls.filter((word) => word === 'farclue')).toHaveLength(1);
    expect(ui.byTestId('rejected-farclue')).toBeTruthy();
    expect(ui.allText()).toContain('rejected this round (1)');
    expect(ui.byTestId('clue-input').props.value).toBe('');
    await ui.unmount();
  });

  it('sends a double-submitted clue once and does not wipe what was typed while it was being scored', async () => {
    const held = createHeldEmbedder();
    const dispatch = jest.fn();
    const ui = await render(
      <SimilarityProvider embedder={held.embedder}>
        <ClueScreen state={clueState()} dispatch={dispatch} onQuit={jest.fn()} onShowScores={jest.fn()} />
      </SimilarityProvider>,
    );
    await ui.type('clue-input', 'farclue');
    // A double tap in one frame: the engine would ignore the repeat, but it must not even be sent.
    const submit = ui.handler('submit-clue', 'onPress');
    await act(async () => {
      submit();
      submit();
    });
    await ui.type('clue-input', 'nextidea');
    held.release();
    await flush(20);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'CLUE_REJECTED', clue: 'farclue' }));
    expect(ui.byTestId('clue-input').props.value).toBe('nextidea');
    await ui.unmount();
  });

  it('dispatches nothing when the screen is gone before the score arrives', async () => {
    const held = createHeldEmbedder();
    const dispatch = jest.fn();
    const ui = await render(
      <SimilarityProvider embedder={held.embedder}>
        <ClueScreen state={clueState()} dispatch={dispatch} onQuit={jest.fn()} onShowScores={jest.fn()} />
      </SimilarityProvider>,
    );
    await ui.type('clue-input', 'closeclue');
    await ui.pressNow('submit-clue');
    await ui.unmount();
    held.release();
    await flush(20);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('GuessScreen', () => {
  it('submits a double-tapped guess once', async () => {
    const initial = createGame(['Ana', 'Bo', 'Cy'], settings(), DECK, SEED);
    const state = play(
      initial,
      { type: 'REVEAL' },
      { type: 'CHOOSE_WORD', word: initial.options[0] },
      { type: 'CLUE_ACCEPTED', clue: 'closeclue', score: 1 },
      { type: 'REVEAL' },
    );
    expect(state.phase).toBe('guess');
    const dispatch = jest.fn();
    const ui = await render(<GuessScreen state={state} dispatch={dispatch} onQuit={jest.fn()} onShowScores={jest.fn()} />);
    await ui.type('guess-input', 'something');
    const submit = ui.handler('submit-guess', 'onPress');
    await act(async () => {
      submit();
      submit();
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'SUBMIT_GUESS', guess: 'something' });
    await ui.unmount();
  });
});

describe('SettingsProvider', () => {
  let latest: SettingsContextValue | null = null;
  function Probe() {
    latest = useSettings();
    return null;
  }
  const stored = { threshold: 0.85, guessMode: 'list', turnsPerPlayer: 4, requireDictionaryNoun: false, useWordLinks: false };

  it('re-applies a change made before the stored settings arrive, without losing the other stored values', async () => {
    await AsyncStorage.clear();
    const read = deferred<string | null>();
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation(() => read.promise);
    const setItem = jest.spyOn(AsyncStorage, 'setItem');

    const ui = await render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );
    expect(latest?.loaded).toBe(false);
    await act(async () => {
      latest?.update({ turnsPerPlayer: 3 });
    });
    await flush();
    // Shown at once, but nothing is written while the stored values are unknown.
    expect(latest?.settings.turnsPerPlayer).toBe(3);
    expect(setItem).not.toHaveBeenCalled();

    await act(async () => {
      read.resolve(JSON.stringify(stored));
    });
    await flush();
    const expected = { ...stored, turnsPerPlayer: 3 };
    expect(latest?.loaded).toBe(true);
    expect(latest?.settings).toEqual(expected);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem.mock.calls[0][0]).toBe(SETTINGS_KEY);
    expect(JSON.parse(setItem.mock.calls[0][1])).toEqual(expected);

    // Once loaded, a change is saved straight away, exactly once.
    await act(async () => {
      latest?.update({ threshold: 0.9 });
    });
    await flush();
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(setItem.mock.calls[1][1])).toEqual({ ...expected, threshold: 0.9 });
    await ui.unmount();
  });

  it('a reset before the stored settings arrive still wins over every stored value', async () => {
    const read = deferred<string | null>();
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation(() => read.promise);
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    const ui = await render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );
    await act(async () => {
      latest?.reset();
    });
    await act(async () => {
      read.resolve(JSON.stringify(stored));
    });
    await flush();
    expect(latest?.settings).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(setItem.mock.calls[setItem.mock.calls.length - 1][1])).toEqual(DEFAULT_SETTINGS);
    await ui.unmount();
  });
});

describe('CheckerScreen', () => {
  async function check(threshold: number) {
    const ui = await render(
      <SimilarityProvider embedder={createTestEmbedder()}>
        <SettingsProvider initialSettings={{ ...DEFAULT_SETTINGS, threshold }}>
          <CheckerScreen onBack={jest.fn()} history={[]} onHistoryChange={jest.fn()} />
        </SettingsProvider>
      </SimilarityProvider>,
    );
    await ui.type('checker-a', 'ocean');
    await ui.type('checker-b', 'midsea');
    await ui.press('check');
    expect(ui.byTestId('checker-score').children).toEqual(['0.900']);
    const text = ui.allText();
    await ui.unmount();
    return text;
  }

  it('judges pass / fail against the current threshold setting, not the default', async () => {
    expect(await check(0.8)).toContain('would pass as a clue at 0.80');
    expect(await check(0.95)).toContain('would not pass as a clue at 0.95');
  });
});
