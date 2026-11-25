import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, BackHandler } from 'react-native';

import App from '../../../App';
import { PLAYERS_KEY, SETTINGS_KEY } from '../../storage';
import { flush, render } from './testUtils';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
// The real embedder needs the native ExecuTorch module; the app is otherwise unchanged.
const mockEmbedderOptions: { failLoad: boolean } = { failLoad: false };
jest.mock('../../similarity/executorchEmbedder', () => ({
  createExecutorchEmbedder: () => {
    const { createTestEmbedder: create } = require('./testUtils') as typeof import('./testUtils');
    const inner = create();
    return {
      embed: inner.embed,
      load: async () => {
        if (mockEmbedderOptions.failLoad) throw new Error('model file missing');
      },
    };
  },
}));

type BackListener = () => boolean | null | undefined;
let backListener: BackListener | null = null;
const pressBack = async (): Promise<boolean> => {
  if (backListener === null) throw new Error('no hardware back listener registered');
  const handled = backListener() === true;
  await flush();
  return handled;
};

beforeEach(async () => {
  await AsyncStorage.clear();
  mockEmbedderOptions.failLoad = false;
  backListener = null;
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, listener) => {
    backListener = listener as BackListener;
    return { remove: () => undefined };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('App', () => {
  it('shows home with the model status and reaches every screen', async () => {
    const ui = await render(<App />);
    expect(ui.byTestId('screen-home')).toBeTruthy();
    expect(ui.byTestId('model-status-ready')).toBeTruthy();
    expect(await pressBack()).toBe(false); // home: the system leaves the app

    await ui.press('home-how');
    expect(ui.byTestId('screen-how-to-play')).toBeTruthy();
    expect(ui.allText()).toContain('all-minilm-l6-v2');
    expect(ui.allText()).toContain('apache-2.0');
    expect(ui.allText()).toContain('wordnet 3.1');
    expect(ui.allText()).toContain('calibrated');
    expect(await pressBack()).toBe(true);
    expect(ui.byTestId('screen-home')).toBeTruthy();

    await ui.press('home-settings');
    expect(ui.byTestId('screen-settings')).toBeTruthy();
    expect(await pressBack()).toBe(true);

    await ui.press('home-checker');
    expect(ui.byTestId('screen-checker')).toBeTruthy();
    await ui.type('checker-a', ' Ocean ');
    await ui.type('checker-b', 'farsea');
    await ui.press('check');
    expect(ui.byTestId('checker-score').children).toEqual(['0.323']);
    expect(ui.byTestId('checker-raw').children).toEqual(['0.174']);
    expect(ui.allText()).toContain('would not pass as a clue at 0.95');
    expect(ui.allText()).toContain('ocean / farsea');
    await ui.type('checker-b', 'sea');
    await ui.press('check');
    expect(ui.byTestId('checker-score').children).toEqual(['1.000']);
    expect(ui.allText()).toContain('would pass as a clue at 0.95');
    expect(ui.allText()).toContain('recent checks');
    await pressBack();

    // The checker history lasts for the session.
    await ui.press('home-checker');
    expect(ui.allText()).toContain('ocean / farsea');
    await ui.unmount();
  });

  it('reports a model load failure on home', async () => {
    mockEmbedderOptions.failLoad = true;
    const ui = await render(<App />);
    expect(ui.byTestId('model-status-error')).toBeTruthy();
    expect(ui.allText()).toContain('model file missing');
    await ui.unmount();
  });

  it('persists settings changes and uses them in the checker', async () => {
    const ui = await render(<App />);
    await ui.press('home-settings');
    expect(ui.allText()).toContain('0.95');
    await ui.press('threshold-dec');
    await ui.press('turns-inc');
    expect(ui.byTestId('threshold-raw').children.join('')).toContain('raw cosine of 0.505');
    expect(JSON.parse((await AsyncStorage.getItem(SETTINGS_KEY)) ?? '{}')).toEqual({
      turnsPerPlayer: 3,
      threshold: 0.94,
      guessMode: 'open',
      requireDictionaryNoun: true,
    });
    await ui.press('run-self-check');
    expect(ui.byTestId('self-check-report')).toBeTruthy();
    await ui.unmount();

    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ threshold: 0.8, turnsPerPlayer: 1, guessMode: 'list' }));
    const second = await render(<App />);
    await second.press('home-settings');
    expect(second.allText()).toContain('0.80');
    await second.unmount();
  });

  it('play again starts a fresh game with the same players', async () => {
    await AsyncStorage.setItem(PLAYERS_KEY, JSON.stringify(['Ana', 'Bo']));
    await AsyncStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ turnsPerPlayer: 1, threshold: 0.95, guessMode: 'list', requireDictionaryNoun: false }),
    );
    const ui = await render(<App />);
    await ui.press('home-play');
    await ui.press('start-game');

    // The seed is random, so read what was dealt from the screen.
    const dealtWords = () =>
      ui.root.container
        .queryAll((i) => typeof i.props.testID === 'string' && i.props.testID.startsWith('option-'), {
          matchDeepestOnly: true,
        })
        .map((i) => (i.props.testID as string).slice('option-'.length));
    for (let turn = 0; turn < 2; turn++) {
      await ui.press('reveal');
      const word = dealtWords()[0];
      await ui.press(`option-${word}`);
      await ui.press('confirm-word');
      await ui.type('clue-input', 'closeclue');
      await ui.press('submit-clue');
      await ui.press('reveal');
      await ui.press(`guess-option-${word}`);
      await ui.press('submit-guess');
      await ui.press('next');
      await ui.press('next');
    }
    expect(ui.byTestId('phase-game-over')).toBeTruthy();
    expect(ui.allText()).toContain('1 point');

    await ui.press('play-again');
    expect(ui.queryByTestId('phase-game-over')).toBeNull();
    expect(ui.byTestId('phase-handoff-giver')).toBeTruthy();
    expect(ui.allText()).toContain('turn 1 of 2');
    expect(ui.allText()).toContain('ana');
    // A fresh game: the first giver is offered five words again.
    await ui.press('reveal');
    expect(dealtWords()).toHaveLength(5);
    await ui.unmount();
  });

  it('remembers players, starts a game and confirms before abandoning it', async () => {
    await AsyncStorage.setItem(PLAYERS_KEY, JSON.stringify(['Ana', 'Bo']));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const ui = await render(<App />);
    await ui.press('home-play');
    expect(ui.byTestId('screen-setup')).toBeTruthy();
    expect(ui.byTestId('player-name-0').props.value).toBe('Ana');
    expect(ui.byTestId('player-name-1').props.value).toBe('Bo');

    await ui.press('add-player');
    expect(ui.byTestId('player-name-2').props.value).toBe('Player 3');
    await ui.type('player-name-2', 'ana');
    await ui.press('start-game');
    expect(ui.byTestId('screen-setup')).toBeTruthy(); // duplicate name: not started
    expect(ui.allText()).toContain('names must be different');
    await ui.type('player-name-2', 'Cy');
    await flush();
    expect(JSON.parse((await AsyncStorage.getItem(PLAYERS_KEY)) ?? '[]')).toEqual(['Ana', 'Bo', 'Cy']);

    await ui.press('start-game');
    expect(ui.byTestId('phase-handoff-giver')).toBeTruthy();

    // Hardware back asks first and does not leave the game by itself.
    expect(await pressBack()).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(ui.byTestId('phase-handoff-giver')).toBeTruthy();

    // Confirming the dialog goes home.
    const buttons = alert.mock.calls[0][2] ?? [];
    const quit = buttons.find((b) => b.style === 'destructive');
    expect(quit).toBeTruthy();
    quit?.onPress?.();
    await flush();
    expect(ui.byTestId('screen-home')).toBeTruthy();
    await ui.unmount();
  });
});
