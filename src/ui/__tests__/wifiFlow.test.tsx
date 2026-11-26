/**
 * "Play over Wi-Fi", end to end: several app instances (one per virtual phone)
 * are rendered side by side on one in-memory network. Everything goes through
 * the real sessions, protocol and screens; only the transport is simulated.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, createRef, type RefObject } from 'react';
import { Alert, AppState, BackHandler } from 'react-native';

import App from '../../../App';
import type { GameSettings } from '../../game';
import { MemoryNetwork, PROTOCOL_VERSION, type NetworkAdapter } from '../../net';
import { SimilarityProvider, type Embedder } from '../../similarity';
import { WIFI_KEY, WIFI_SEAT_KEY, type SavedSeat } from '../../storage';
import { isIpv4Address, looksLikePermissionDenial, permissionHelp, validateJoinTarget } from '../net/joinTarget';
import { GUESS_TIMING } from '../net/NetGameScreen';
import { WifiFlow, type SeatStore, type WifiFlowProps, type WifiFlowTuning } from '../net/WifiFlow';
import { SettingsProvider } from '../SettingsContext';
import { createTestEmbedder, flush, render, type Rendered } from './testUtils';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../../similarity/executorchEmbedder', () => ({
  createExecutorchEmbedder: () => (require('./testUtils') as typeof import('./testUtils')).createTestEmbedder(),
}));
// The real adapter needs native modules. Nothing may load it unless a screen
// actually has to use the real network - and then the failure must be shown, not thrown.
jest.mock('../../net/lanAdapter', () => {
  throw new Error('native networking is not available here');
});

const HOST_ADDRESS = '10.0.0.1';

/**
 * 60 made-up words that cannot collide with any text on screen (the real deck
 * contains words such as "phone"), so "this word is not visible" means something.
 */
const TEST_DECK: readonly string[] = Array.from({ length: 60 }, (_, i) => {
  const a = String.fromCharCode(97 + (i % 26));
  const b = String.fromCharCode(97 + Math.floor(i / 26));
  return `zq${b}${a}xk`;
});

/** A fixed deal, and short timeouts so drops and retries play out in milliseconds of real time. */
const TUNING: WifiFlowTuning = {
  host: { dropDelayMs: 0, deck: TEST_DECK, seed: 4242 },
  client: { retryDelayMs: 20, reconnectWindowMs: 3000, connectWindowMs: 200, attemptTimeoutMs: 100 },
};

function settings(overrides: Partial<GameSettings> = {}): GameSettings {
  return { turnsPerPlayer: 1, threshold: 0.95, guessMode: 'open', requireDictionaryNoun: false, useWordLinks: true, ...overrides };
}

/** What one phone remembers about its last seat. The storage mock is shared by all virtual phones, so each gets its own. */
function memorySeatStore(): SeatStore & { seat: SavedSeat | null } {
  const store = {
    seat: null as SavedSeat | null,
    load: async () => store.seat,
    save: async (seat: SavedSeat) => {
      store.seat = seat;
    },
    clear: async () => {
      store.seat = null;
    },
  };
  return store;
}

interface Device {
  ui: Rendered;
  address: string;
  onExit: ReturnType<typeof jest.fn>;
  back: RefObject<(() => boolean) | null>;
}

interface DeviceOptions extends Partial<WifiFlowProps> {
  settings?: GameSettings;
  embedder?: Embedder & { load?: () => Promise<void> };
  address?: string;
}

const devices: Device[] = [];
let nextAddress = 0;

async function device(net: MemoryNetwork, options: DeviceOptions = {}): Promise<Device> {
  const { settings: s = settings(), embedder = createTestEmbedder(), address = `10.0.0.${++nextAddress}`, ...props } = options;
  const onExit = jest.fn();
  const back = createRef<(() => boolean) | null>() as RefObject<(() => boolean) | null>;
  const ui = await render(
    <SimilarityProvider embedder={embedder}>
      <SettingsProvider initialSettings={s}>
        <WifiFlow
          adapter={net.createAdapter(address)}
          platform="android"
          tuning={TUNING}
          backHandler={back}
          onExit={onExit}
          seatStore={memorySeatStore()}
          {...props}
        />
      </SettingsProvider>
    </SimilarityProvider>,
  );
  const d = { ui, address, onExit, back };
  devices.push(d);
  return d;
}

/** Lets real time pass (retry timers, discovery timeout) with React updates applied. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await flush();
}

/** Runs something that changes the network from outside React (a cut cable, a crash). */
async function network(change: () => void): Promise<void> {
  await act(async () => {
    change();
  });
  await flush();
}

async function host(d: Device, name: string): Promise<void> {
  await d.ui.type('wifi-name', name);
  await d.ui.press('wifi-host');
  expect(d.ui.byTestId('screen-lobby')).toBeTruthy();
}

async function join(d: Device, name: string, hostName: string): Promise<void> {
  await d.ui.type('wifi-name', name);
  await flush();
  await d.ui.press(`join-${hostName}`);
  expect(d.ui.byTestId('screen-lobby')).toBeTruthy();
}

/** A lobby with a host ("Hana") and joiners, all rendered. */
async function lobby(
  net: MemoryNetwork,
  joiners: string[],
  hostOptions: DeviceOptions = {},
  joinerOptions: DeviceOptions = {},
): Promise<Device[]> {
  const h = await device(net, { address: HOST_ADDRESS, ...hostOptions });
  await host(h, 'Hana');
  const all = [h];
  for (const name of joiners) {
    const d = await device(net, joinerOptions);
    await join(d, name, 'Hana');
    all.push(d);
  }
  return all;
}

function dealtWords(ui: Rendered): string[] {
  return ui.root.container
    .queryAll((i) => typeof i.props.testID === 'string' && i.props.testID.startsWith('option-'), { matchDeepestOnly: true })
    .map((i) => (i.props.testID as string).slice('option-'.length));
}

function expectNoneVisible(ui: Rendered, words: readonly string[]) {
  const visible = ui.texts().join(' | ').toLowerCase();
  for (const word of words) expect(visible).not.toContain(word.toLowerCase());
}

/** Presses the destructive button of the most recent Alert. */
async function confirmAlert(alert: { mock: { calls: unknown[][] } }): Promise<void> {
  const call = alert.mock.calls[alert.mock.calls.length - 1];
  const buttons = (call?.[2] ?? []) as { style?: string; onPress?: () => void }[];
  const destructive = buttons.find((b) => b.style === 'destructive');
  expect(destructive).toBeTruthy();
  await act(async () => {
    destructive?.onPress?.();
  });
  await flush();
}

beforeEach(async () => {
  await AsyncStorage.clear();
  nextAddress = 1; // 10.0.0.1 is the host; joiners start at 10.0.0.2
});

afterEach(async () => {
  for (const d of devices.splice(0)) await d.ui.unmount();
  await wait(5);
  jest.restoreAllMocks();
});

describe('Play over Wi-Fi: a full turn on three phones (open mode)', () => {
  it('keeps every secret on the phone it belongs to', async () => {
    const net = new MemoryNetwork();
    const h = await device(net, { address: HOST_ADDRESS });
    await host(h, 'Hana');
    // The host shows where to find it for manual joining.
    expect(h.ui.byTestId('host-address').children.join('')).toBe(`${HOST_ADDRESS}:40001`);
    expect(h.ui.byTestId('start-wifi-game').props.accessibilityState).toMatchObject({ disabled: true });
    expect(h.ui.allText()).toContain('waiting for at least 2 players');

    // Bo finds the game through discovery.
    const b = await device(net);
    expect(b.ui.allText()).toContain('hana');
    await join(b, 'Bo', 'Hana');
    // A second "Bo" joins by typing the address; the host makes the name unique.
    const c = await device(net);
    await c.ui.type('wifi-name', ' bo ');
    await c.ui.press('wifi-manual-toggle');
    await c.ui.type('manual-host', HOST_ADDRESS);
    await c.ui.type('manual-port', '40001');
    await c.ui.press('manual-join');
    expect(c.ui.byTestId('screen-lobby')).toBeTruthy();

    for (const d of [h, b, c]) {
      expect(d.ui.byTestId('lobby-player-Hana')).toBeTruthy();
      expect(d.ui.byTestId('lobby-player-Bo')).toBeTruthy();
      expect(d.ui.byTestId('lobby-player-bo 2')).toBeTruthy();
    }
    // Only the host has controls; nobody but the host sees the address card.
    expect(b.ui.queryByTestId('start-wifi-game')).toBeNull();
    expect(b.ui.queryByTestId('host-address')).toBeNull();
    expect(b.ui.queryByTestId('remove-bo 2')).toBeNull();
    expect(b.ui.byTestId('lobby-waiting').children.join('')).toContain('Hana');
    expect(h.ui.byTestId('remove-Bo')).toBeTruthy();

    await h.ui.press('start-wifi-game');

    // The host is the first clue-giver: only that phone shows the five words.
    expect(h.ui.byTestId('phase-choose-word')).toBeTruthy();
    const options = dealtWords(h.ui);
    expect(options).toHaveLength(5);
    const hidden = options[2];
    for (const d of [b, c]) {
      expect(d.ui.byTestId('phase-watch-choose-word')).toBeTruthy();
      expect(d.ui.allText()).toContain('hana is picking a secret word');
      expectNoneVisible(d.ui, options);
    }

    await h.ui.press(`option-${hidden}`);
    await h.ui.press('confirm-word');
    expect(h.ui.byTestId('hidden-word').children).toEqual([hidden]);
    for (const d of [b, c]) {
      expect(d.ui.byTestId('phase-watch-clue')).toBeTruthy();
      expectNoneVisible(d.ui, options);
    }

    // The host validates: a clue that breaks a rule is refused with the reason and not counted.
    await h.ui.type('clue-input', hidden);
    await h.ui.press('submit-clue');
    expect(h.ui.byTestId('clue-feedback').children.join('')).toContain('cannot be one of the five words');
    expect(h.ui.allText()).not.toContain('rejected this round');

    // A clue the host's model scores too low is rejected - on the giver's phone only.
    await h.ui.type('clue-input', 'farclue');
    await h.ui.press('submit-clue');
    expect(h.ui.byTestId('rejected-farclue')).toBeTruthy();
    expect(h.ui.byTestId('clue-feedback').children.join('')).toContain('0.323');
    for (const d of [b, c]) expectNoneVisible(d.ui, [...options, 'farclue', '0.323']);

    // Accepted: both guessers guess at the same time, each on their own phone.
    await h.ui.type('clue-input', 'closeclue');
    await h.ui.press('submit-clue');
    expect(h.ui.byTestId('phase-watch-guess')).toBeTruthy();
    expect(h.ui.byTestId('waiting-for').children.join('')).toBe('Waiting for Bo and bo 2.');
    for (const d of [b, c]) {
      expect(d.ui.byTestId('phase-guess')).toBeTruthy();
      expect(d.ui.byTestId('latest-clue').children).toEqual(['closeclue']);
      expectNoneVisible(d.ui, [...options, 'farclue']);
    }

    // Bo guesses wrong. Everyone sees THAT Bo has guessed; only Bo sees what.
    await b.ui.type('guess-input', 'wrongguess');
    await b.ui.press('submit-guess');
    expect(b.ui.byTestId('phase-watch-guess')).toBeTruthy();
    expect(b.ui.byTestId('your-guess').children).toEqual(['wrongguess']);
    for (const d of [h, b, c]) {
      expect(d.ui.byTestId('waiting-for').children.join('')).toBe('Waiting for bo 2.');
      expect(d.ui.allText()).toContain('locked in');
    }
    expectNoneVisible(h.ui, ['wrongguess']);
    expectNoneVisible(c.ui, ['wrongguess', ...options]);
    expect(c.ui.byTestId('phase-guess')).toBeTruthy();

    // The last guess resolves the round on every phone at once (plural accepted).
    await c.ui.type('guess-input', `${hidden}s`);
    await c.ui.press('submit-guess');
    for (const d of [h, b, c]) {
      expect(d.ui.byTestId('phase-round-result')).toBeTruthy();
      expect(d.ui.allText()).toContain('wrongguess');
      expect(d.ui.allText()).toContain('bo 2 got it!');
    }
    // The host moves the game on; the others wait.
    expect(b.ui.queryByTestId('next')).toBeNull();
    expect(b.ui.byTestId('waiting-continue').children.join('')).toBe('Waiting for Hana to continue.');

    await h.ui.press('next');
    for (const d of [h, b, c]) {
      expect(d.ui.byTestId('phase-turn-result')).toBeTruthy();
      expect(d.ui.byTestId('revealed-word').children).toEqual([hidden]);
      expect(d.ui.allText()).toContain('bo 2 guessed it');
    }

    // The second tap of a double tap lands on the new screen's button and is ignored.
    await h.ui.pressNow('next');
    for (const d of [h, b, c]) expect(d.ui.byTestId('phase-turn-result')).toBeTruthy();

    // A deliberate tap starts the next turn, with Bo as the giver.
    await h.ui.press('next');
    expect(b.ui.byTestId('phase-choose-word')).toBeTruthy();
    const nextOptions = dealtWords(b.ui);
    expect(nextOptions).toHaveLength(5);
    for (const d of [h, c]) {
      expect(d.ui.byTestId('phase-watch-choose-word')).toBeTruthy();
      expectNoneVisible(d.ui, nextOptions);
    }
    expect(h.ui.allText()).toContain('turn 2 of 3');
  });
});

describe('Play over Wi-Fi: list mode, game over and play again', () => {
  it('plays two phones to the final scores and returns everyone to the lobby', async () => {
    const net = new MemoryNetwork();
    const [h, b] = await lobby(net, ['Bo'], { settings: settings({ guessMode: 'list' }) });
    expect(b.ui.allText()).toContain('guessers pick from the five words');
    await h.ui.press('start-wifi-game');

    const phones = [h, b];
    for (let turn = 0; turn < 2; turn++) {
      const giver = phones[turn];
      const guesser = phones[1 - turn];
      const options = dealtWords(giver.ui);
      const hidden = options[0];
      expectNoneVisible(guesser.ui, options);
      await giver.ui.press(`option-${hidden}`);
      await giver.ui.press('confirm-word');
      await giver.ui.type('clue-input', 'closeclue');
      await giver.ui.press('submit-clue');
      // List mode: the guesser gets the five words (shuffled), but nothing marks the right one.
      for (const word of options) expect(guesser.ui.byTestId(`guess-option-${word}`)).toBeTruthy();
      expect(guesser.ui.queryByTestId('hidden-word')).toBeNull();
      await guesser.ui.press(`guess-option-${hidden}`);
      await guesser.ui.press('submit-guess');
      for (const d of phones) expect(d.ui.byTestId('phase-round-result')).toBeTruthy();
      await h.ui.press('next');
      for (const d of phones) expect(d.ui.byTestId('revealed-word').children).toEqual([hidden]);
      await h.ui.press('next');
    }

    for (const d of phones) {
      expect(d.ui.byTestId('phase-game-over')).toBeTruthy();
      expect(d.ui.byTestId('winner-headline').children.join('')).toBe("It's a tie all round!");
    }
    expect(b.ui.queryByTestId('play-again')).toBeNull();
    expect(b.ui.byTestId('waiting-again')).toBeTruthy();

    await h.ui.press('play-again');
    for (const d of phones) {
      expect(d.ui.byTestId('screen-lobby')).toBeTruthy();
      expect(d.ui.byTestId('lobby-player-Bo')).toBeTruthy();
    }
    // And a second game can start straight away.
    await h.ui.press('start-wifi-game');
    expect(h.ui.byTestId('phase-choose-word')).toBeTruthy();
    expect(b.ui.byTestId('phase-watch-choose-word')).toBeTruthy();
  });
});

describe('Play over Wi-Fi: scoring problems on the host', () => {
  it('reports a model failure to the giver as a retryable error', async () => {
    const net = new MemoryNetwork();
    let failing = true;
    const [h, b] = await lobby(net, ['Bo'], { embedder: createTestEmbedder({ failEmbed: () => failing }) });
    await h.ui.press('start-wifi-game');
    const first = dealtWords(h.ui)[0];
    await h.ui.press(`option-${first}`);
    await h.ui.press('confirm-word');
    await h.ui.type('clue-input', 'closeclue');
    await h.ui.press('submit-clue');
    expect(h.ui.byTestId('clue-feedback').children.join('')).toContain('could not score');
    expect(h.ui.byTestId('phase-clue')).toBeTruthy();
    expect(b.ui.byTestId('phase-watch-clue')).toBeTruthy();

    // Nothing was counted; the same clue goes through once the model works.
    failing = false;
    await h.ui.press('submit-clue');
    expect(h.ui.byTestId('phase-watch-guess')).toBeTruthy();
    expect(b.ui.byTestId('latest-clue').children).toEqual(['closeclue']);
  });
});

describe('Play over Wi-Fi: connection trouble', () => {
  it('marks a dropped guesser, lets the host skip them, and gives them the current view back', async () => {
    const net = new MemoryNetwork();
    const [h, b, c] = await lobby(net, ['Bo', 'Cy']);
    await h.ui.press('start-wifi-game');
    const hidden = dealtWords(h.ui)[1];
    await h.ui.press(`option-${hidden}`);
    await h.ui.press('confirm-word');
    await h.ui.type('clue-input', 'closeclue');
    await h.ui.press('submit-clue');
    await b.ui.type('guess-input', 'wrongguess');
    await b.ui.press('submit-guess');
    expect(h.ui.queryByTestId('skip-Cy')).toBeNull(); // connected players cannot be skipped

    // Cy's phone falls off the network.
    await network(() => {
      net.setOffline(c.address, true);
      for (const id of net.linksFrom(c.address)) net.sever(id);
    });
    expect(c.ui.byTestId('reconnecting-banner')).toBeTruthy();
    expect(c.ui.byTestId('phase-guess')).toBeTruthy(); // the last view stays up
    expect(c.ui.byTestId('submit-guess').props.accessibilityState).toMatchObject({ disabled: true });
    for (const d of [h, b]) {
      expect(d.ui.byTestId('disconnected-banner')).toBeTruthy();
      expect(d.ui.allText()).toContain('cy is disconnected');
    }
    expect(b.ui.queryByTestId('skip-Cy')).toBeNull(); // only the host can skip

    // The game is not stuck: the host skips the missing guess, which counts as wrong.
    await h.ui.press('skip-Cy');
    for (const d of [h, b]) {
      expect(d.ui.byTestId('phase-round-result')).toBeTruthy();
      expect(d.ui.allText()).toContain('did not guess');
      expect(d.ui.allText()).toContain('nobody got it');
    }
    expectNoneVisible(b.ui, [hidden]);

    // Cy comes back, reclaims the seat and sees where the game is now.
    await network(() => net.setOffline(c.address, false));
    await wait(250);
    expect(c.ui.queryByTestId('reconnecting-banner')).toBeNull();
    expect(c.ui.byTestId('phase-round-result')).toBeTruthy();
    expect(c.ui.allText()).toContain('wrongguess');
    expectNoneVisible(c.ui, [hidden]);
    for (const d of [h, b]) expect(d.ui.queryByTestId('disconnected-banner')).toBeNull();
  });

  it('lets the host end the turn of a clue-giver who is gone', async () => {
    const net = new MemoryNetwork();
    const [h, b] = await lobby(net, ['Bo']);
    await h.ui.press('start-wifi-game');
    // Play turn 1 (Hana gives) quickly so that Bo becomes the giver.
    const hidden = dealtWords(h.ui)[0];
    await h.ui.press(`option-${hidden}`);
    await h.ui.press('confirm-word');
    await h.ui.type('clue-input', 'closeclue');
    await h.ui.press('submit-clue');
    await b.ui.type('guess-input', hidden);
    await b.ui.press('submit-guess');
    await h.ui.press('next');
    await h.ui.press('next');
    expect(b.ui.byTestId('phase-choose-word')).toBeTruthy();
    expect(h.ui.queryByTestId('forfeit-giver')).toBeNull();

    await network(() => {
      net.setOffline(b.address, true);
      for (const id of net.linksFrom(b.address)) net.sever(id);
    });
    expect(h.ui.byTestId('giver-gone')).toBeTruthy();
    await h.ui.press('forfeit-giver');
    expect(h.ui.byTestId('phase-turn-result')).toBeTruthy();
    expect(h.ui.byTestId('no-word-chosen')).toBeTruthy();
    expect(h.ui.allText()).toContain('bo forfeited the turn');
  });

  it('tells joiners when the host closes the game, and stops the host transport', async () => {
    const net = new MemoryNetwork();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const [h, b] = await lobby(net, ['Bo']);
    await h.ui.press('start-wifi-game');
    expect(net.hostPorts()).toHaveLength(1);

    // Hardware back on the host asks first and changes nothing by itself.
    let handled = false;
    await act(async () => {
      handled = h.back.current?.() === true;
    });
    expect(handled).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toBe('Close this game?');
    expect(h.ui.byTestId('phase-choose-word')).toBeTruthy();
    expect(b.ui.queryByTestId('screen-wifi-closed')).toBeNull();

    await confirmAlert(alert);
    await wait(20);
    expect(h.ui.byTestId('screen-wifi')).toBeTruthy(); // back on the entry screen
    expect(net.hostPorts()).toHaveLength(0); // listener and advertisement are gone
    expect(net.linkIds()).toHaveLength(0);

    expect(b.ui.byTestId('screen-wifi-closed')).toBeTruthy();
    expect(b.ui.byTestId('closed-title').children.join('')).toBe('The host left');
    expect(b.ui.queryByTestId('closed-retry')).toBeNull(); // nothing to reconnect to
    expect(b.ui.allText()).toContain('scores when it ended');

    await b.ui.press('closed-home');
    expect(b.onExit).toHaveBeenCalledTimes(1);
  });

  it('shows "connection lost" when the host vanishes, after trying to reconnect', async () => {
    const net = new MemoryNetwork();
    const quickToGiveUp = { ...TUNING, client: { ...TUNING.client, reconnectWindowMs: 300 } };
    const [h, b] = await lobby(net, ['Bo'], {}, { tuning: quickToGiveUp });
    await h.ui.press('start-wifi-game');

    await network(() => net.crashHost(net.hostPorts()[0]));
    expect(b.ui.byTestId('reconnecting-banner')).toBeTruthy();
    expect(b.ui.byTestId('phase-watch-choose-word')).toBeTruthy();

    await wait(600); // longer than the (shortened) reconnect window
    expect(b.ui.byTestId('screen-wifi-closed')).toBeTruthy();
    expect(b.ui.byTestId('closed-title').children.join('')).toBe('Connection lost');
    expect(b.ui.byTestId('closed-retry')).toBeTruthy();
    await b.ui.press('closed-back');
    expect(b.ui.byTestId('screen-wifi')).toBeTruthy();
  });

  it('asks before a joiner leaves a lobby, frees the seat, and unmounting tears the session down', async () => {
    const net = new MemoryNetwork();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const [h, b, c] = await lobby(net, ['Bo', 'Cy']);
    await act(async () => {
      b.back.current?.();
    });
    expect(alert.mock.calls[0][0]).toBe('Leave the lobby?');
    expect(b.ui.byTestId('screen-lobby')).toBeTruthy();
    await confirmAlert(alert);
    expect(b.ui.byTestId('screen-wifi')).toBeTruthy();
    expect(h.ui.queryByTestId('lobby-player-Bo')).toBeNull();

    // On the entry screen hardware back leaves the flow without asking.
    await act(async () => {
      b.back.current?.();
    });
    expect(b.onExit).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);

    // The host can remove a player from the lobby.
    await h.ui.press('remove-Cy');
    expect(h.ui.queryByTestId('lobby-player-Cy')).toBeNull();
    expect(c.ui.byTestId('closed-title').children.join('')).toBe('Removed from the lobby');

    // Unmounting the host's flow (e.g. the app navigates away) closes the game for good.
    devices.splice(devices.indexOf(h), 1);
    await h.ui.unmount();
    await wait(20);
    expect(net.hostPorts()).toHaveLength(0);
    expect(net.linkIds()).toHaveLength(0);
  });

  it('explains a version mismatch as "update the app"', async () => {
    const net = new MemoryNetwork();
    // A host speaking a newer protocol: it refuses every hello.
    const other = net.createAdapter(HOST_ADDRESS);
    const transport = await other.startHost(
      { name: 'Newer', txt: { v: String(PROTOCOL_VERSION + 1) } },
      {
        onPeer: () => undefined,
        onMessage: (peerId) =>
          transport.sendTo(peerId, { v: PROTOCOL_VERSION + 1, t: 'refused', reason: 'version', hostVersion: PROTOCOL_VERSION + 1 }),
        onPeerGone: () => undefined,
        onError: () => undefined,
      },
    );
    const b = await device(net);
    await b.ui.type('wifi-name', 'Bo');
    await flush();
    expect(b.ui.allText()).toContain('different app version');
    await b.ui.press('join-Newer');
    expect(b.ui.byTestId('closed-title').children.join('')).toBe('Update needed');
    expect(b.ui.byTestId('closed-message').children.join('')).toContain('Update the app on both phones');
    expect(b.ui.queryByTestId('closed-retry')).toBeNull();
    await transport.stop();
  });
});

describe('Play over Wi-Fi: finding a game', () => {
  it('validates manual join and offers it when discovery finds nothing', async () => {
    const net = new MemoryNetwork();
    const [h] = await lobby(net, []);
    net.discoveryEnabled = false;
    await AsyncStorage.clear(); // a different phone: no remembered name
    const b = await device(net, { discoveryTimeoutMs: 40 });

    // Searching first; the empty state appears only after the timeout.
    expect(b.ui.byTestId('wifi-searching')).toBeTruthy();
    expect(b.ui.queryByTestId('wifi-empty')).toBeNull();
    await wait(80);
    expect(b.ui.queryByTestId('wifi-searching')).toBeNull();
    expect(b.ui.byTestId('wifi-empty')).toBeTruthy();
    expect(b.ui.allText()).toContain('same wi-fi network');
    expect(b.ui.byTestId('wifi-alt-discovery')).toBeTruthy(); // Android only
    expect(b.ui.byTestId('wifi-manual')).toBeTruthy();

    // Nothing typed: both fields are flagged, nothing is attempted.
    await b.ui.press('manual-join');
    expect(b.ui.allText()).toContain("enter the host's ip address");
    expect(b.ui.allText()).toContain('enter the port shown on the host');
    // Malformed values.
    await b.ui.type('manual-host', '192.168.1.300');
    await b.ui.type('manual-port', '70000');
    await b.ui.press('manual-join');
    expect(b.ui.allText()).toContain('four numbers from 0 to 255');
    expect(b.ui.allText()).toContain('number from 1 to 65535');
    expect(b.ui.byTestId('screen-wifi')).toBeTruthy();
    // A valid address still needs a name.
    await b.ui.type('manual-host', HOST_ADDRESS);
    await b.ui.type('manual-port', '40001');
    expect(b.ui.queryByTestId('manual-name-error')).toBeNull();
    await b.ui.press('manual-join');
    expect(b.ui.allText()).toContain('enter your name first');
    // The name field is far up the page: the reminder is repeated right under the button that was pressed.
    expect(b.ui.byTestId('manual-name-error').children.join('')).toContain('Enter your name');
    expect(b.ui.queryByTestId('list-name-error')).toBeNull();
    expect(b.ui.byTestId('screen-wifi')).toBeTruthy();
    expect(h.ui.queryByTestId('lobby-player-Bo')).toBeNull();
    // The name is remembered by the storage layer.
    await b.ui.type('wifi-name', 'Bo');
    await flush();
    expect(b.ui.queryByTestId('manual-name-error')).toBeNull();
    expect(JSON.parse((await AsyncStorage.getItem(WIFI_KEY)) ?? '{}')).toMatchObject({ name: 'Bo' });
    await b.ui.press('manual-join');
    expect(b.ui.byTestId('screen-lobby')).toBeTruthy();
    expect(h.ui.byTestId('lobby-player-Bo')).toBeTruthy();
  });

  it('reports an unreachable address instead of hanging', async () => {
    const net = new MemoryNetwork();
    const b = await device(net);
    await b.ui.type('wifi-name', 'Bo');
    await b.ui.press('wifi-manual-toggle');
    await b.ui.type('manual-host', '10.0.0.77:41234'); // address and port pasted together
    await b.ui.press('manual-join');
    expect(b.ui.byTestId('screen-wifi-connecting')).toBeTruthy();
    await wait(400);
    expect(b.ui.byTestId('closed-title').children.join('')).toBe('Host not reachable');
    expect(b.ui.byTestId('closed-retry')).toBeTruthy();
  });

  it('switches discovery method on Android and restarts the search', async () => {
    const net = new MemoryNetwork();
    net.discoveryEnabled = false;
    const real = net.createAdapter('10.0.0.9');
    const calls: (boolean | undefined)[] = [];
    let stops = 0;
    const adapter: NetworkAdapter = {
      ...real,
      browse: (handlers, opts) => {
        calls.push(opts?.useEmbeddedMdns);
        const stop = real.browse(handlers, opts);
        return () => {
          stops += 1;
          stop();
        };
      },
    };
    const b = await device(net, { adapter, discoveryTimeoutMs: 20 });
    await wait(50);
    await b.ui.press('wifi-alt-discovery');
    expect(calls).toEqual([false, true]);
    expect(stops).toBe(1);
    expect(b.ui.byTestId('wifi-searching')).toBeTruthy(); // a fresh search with its own timeout
    await b.ui.unmount();
    devices.splice(devices.indexOf(b), 1);
    expect(stops).toBe(2); // leaving the screen stops discovery
  });

  it('on iOS explains the local-network prompt before anything touches the network', async () => {
    const net = new MemoryNetwork();
    const real = net.createAdapter('10.0.0.9');
    const browse = jest.fn(real.browse);
    const b = await device(net, { adapter: { ...real, browse }, platform: 'ios' });
    expect(b.ui.byTestId('screen-wifi-permission')).toBeTruthy();
    expect(b.ui.allText()).toContain('local network');
    expect(b.ui.queryByTestId('wifi-host')).toBeNull();
    expect(browse).not.toHaveBeenCalled();

    await b.ui.press('wifi-permission-continue');
    expect(b.ui.byTestId('screen-wifi')).toBeTruthy();
    expect(browse).toHaveBeenCalledTimes(1);
    expect(b.ui.queryByTestId('wifi-alt-discovery')).toBeNull();
    // Explained once: the next visit goes straight in.
    const again = await device(net, { platform: 'ios' });
    expect(again.ui.byTestId('screen-wifi')).toBeTruthy();
  });

  it('points at the permission setting when discovery or hosting is denied', async () => {
    const net = new MemoryNetwork();
    const real = net.createAdapter('10.0.0.9');
    await AsyncStorage.setItem(WIFI_KEY, JSON.stringify({ name: 'Ana', permissionExplained: true }));
    const adapter: NetworkAdapter = {
      ...real,
      browse: (handlers) => {
        setTimeout(() => handlers.onError({ code: -72008 }), 0);
        return () => undefined;
      },
      startHost: () => Promise.reject(new Error('NSNetServicesErrorCode -72008: policy denied')),
    };
    const b = await device(net, { adapter, platform: 'ios' });
    await wait(10);
    expect(b.ui.byTestId('wifi-browse-error')).toBeTruthy();
    expect(b.ui.byTestId('wifi-permission-help').children.length).toBeGreaterThan(0);
    expect(b.ui.allText()).toContain('settings > privacy & security > local network');
    expect(b.ui.byTestId('wifi-manual')).toBeTruthy(); // manual join stays possible

    expect(b.ui.byTestId('wifi-name').props.value).toBe('Ana'); // remembered name
    await b.ui.press('wifi-host');
    expect(b.ui.byTestId('screen-wifi-host-failed')).toBeTruthy();
    expect(b.ui.allText()).toContain('policy denied');
    expect(b.ui.allText()).toContain('settings > privacy & security > local network');
    await b.ui.press('host-failed-back');
    expect(b.ui.byTestId('screen-wifi')).toBeTruthy();
  });
});

const QUICK_TO_GIVE_UP: WifiFlowTuning = { ...TUNING, client: { ...TUNING.client, reconnectWindowMs: 300 } };

/** Takes a phone off the network, the way walking out of Wi-Fi range does. */
async function goDark(net: MemoryNetwork, d: Device): Promise<void> {
  await network(() => {
    net.setOffline(d.address, true);
    for (const id of net.linksFrom(d.address)) net.sever(id);
  });
}

const isDisabled = (ui: Rendered, id: string): boolean =>
  (ui.byTestId(id).props.accessibilityState as { disabled?: boolean } | undefined)?.disabled === true;
const labelOf = (ui: Rendered, id: string): unknown => ui.byTestId(id).props.accessibilityLabel;

/** Hana (host) picks her first word and gets a clue accepted: every joiner is now guessing. */
async function hostGivesClue(h: Device): Promise<string> {
  const hidden = dealtWords(h.ui)[0];
  await h.ui.press(`option-${hidden}`);
  await h.ui.press('confirm-word');
  await h.ui.type('clue-input', 'closeclue');
  await h.ui.press('submit-clue');
  return hidden;
}

/** Hana gives, Bo guesses right, and the host continues twice: the next turn (or the final scores) is showing. */
async function playHostTurn(h: Device, b: Device): Promise<void> {
  const hidden = await hostGivesClue(h);
  await b.ui.type('guess-input', hidden);
  await b.ui.press('submit-guess');
  await h.ui.press('next');
  await h.ui.press('next');
}

describe('Play over Wi-Fi: a guess that was lost on the way', () => {
  async function boGuessing(net: MemoryNetwork, guessMode: 'open' | 'list') {
    const [h, b] = await lobby(net, ['Bo'], { settings: settings({ guessMode }) });
    await h.ui.press('start-wifi-game');
    const hidden = await hostGivesClue(h);
    expect(b.ui.byTestId('phase-guess')).toBeTruthy();
    const enter = async () => {
      if (guessMode === 'list') await b.ui.press(`guess-option-${hidden}`);
      else await b.ui.type('guess-input', hidden);
    };
    return { h, b, enter };
  }

  it.each(['open', 'list'] as const)('%s mode: it is sent again after the phone reconnects, and the round resolves', async (guessMode) => {
    const net = new MemoryNetwork();
    const { h, b, enter } = await boGuessing(net, guessMode);
    const link = net.linksFrom(b.address)[0];
    await network(() => net.blackhole(link)); // the Wi-Fi link is dead, but nobody knows yet
    await enter();
    await b.ui.press('submit-guess');
    expect(labelOf(b.ui, 'submit-guess')).toBe('Sending...');
    expect(h.ui.byTestId('waiting-for').children.join('')).toBe('Waiting for Bo.');

    await network(() => net.sever(link));
    await wait(250);
    expect(b.ui.queryByTestId('reconnecting-banner')).toBeNull();
    for (const d of [h, b]) expect(d.ui.byTestId('phase-round-result')).toBeTruthy();
    expect(h.ui.allText()).toContain('bo got it!');
  });

  it.each(['open', 'list'] as const)('%s mode: the button does not stay on "Sending..." while the connection is down', async (guessMode) => {
    const net = new MemoryNetwork();
    const { h, b, enter } = await boGuessing(net, guessMode);
    const link = net.linksFrom(b.address)[0];
    await network(() => net.blackhole(link));
    await enter();
    await b.ui.press('submit-guess');
    expect(labelOf(b.ui, 'submit-guess')).toBe('Sending...');
    expect(isDisabled(b.ui, 'submit-guess')).toBe(true);

    await goDark(net, b);
    expect(b.ui.byTestId('reconnecting-banner')).toBeTruthy();
    expect(labelOf(b.ui, 'submit-guess')).toBe('Lock in guess');
    expect(isDisabled(b.ui, 'submit-guess')).toBe(true); // offline: nothing can be sent
    expect(h.ui.byTestId('skip-Bo')).toBeTruthy(); // and the host can move on meanwhile
  });

  it.each(['open', 'list'] as const)('%s mode: a guess that is never confirmed can be sent again after a moment', async (guessMode) => {
    jest.replaceProperty(GUESS_TIMING, 'unconfirmedMs', 60);
    const net = new MemoryNetwork();
    const { h, b, enter } = await boGuessing(net, guessMode);
    if (guessMode === 'open') {
      // What the host would ignore is refused on the spot, with the reason.
      await b.ui.type('guess-input', 'two words');
      await b.ui.press('submit-guess');
      expect(b.ui.allText()).toContain('use one word, letters a to z only');
      expect(labelOf(b.ui, 'submit-guess')).toBe('Lock in guess');
      expect(h.ui.byTestId('waiting-for').children.join('')).toBe('Waiting for Bo.');
    }
    const link = net.linksFrom(b.address)[0];
    await network(() => net.blackhole(link));
    await enter();
    await b.ui.press('submit-guess');
    expect(labelOf(b.ui, 'submit-guess')).toBe('Sending...');
    // The loss never shows up as a disconnect on this phone.
    await wait(150);
    expect(b.ui.queryByTestId('reconnecting-banner')).toBeNull();
    expect(b.ui.byTestId('phase-guess')).toBeTruthy();
    expect(labelOf(b.ui, 'submit-guess')).toBe('Lock in guess');
    expect(isDisabled(b.ui, 'submit-guess')).toBe(false);

    await network(() => net.blackhole(link, false));
    await b.ui.press('submit-guess');
    for (const d of [h, b]) expect(d.ui.byTestId('phase-round-result')).toBeTruthy();
  });
});

describe('Play over Wi-Fi: getting a seat back', () => {
  it('reclaims the seat after "Find another game" and after the app was closed; leaving on purpose gives it up', async () => {
    const net = new MemoryNetwork();
    const store = memorySeatStore();
    const [h, b] = await lobby(net, ['Bo'], {}, { tuning: QUICK_TO_GIVE_UP, seatStore: store });
    expect(store.seat).toMatchObject({ host: HOST_ADDRESS, port: 40001 });
    const token = store.seat?.token;
    await h.ui.press('start-wifi-game');

    // The connection is lost for good; Bo goes back to the list of games.
    await goDark(net, b);
    await wait(600);
    expect(b.ui.byTestId('closed-title').children.join('')).toBe('Connection lost');
    await b.ui.press('closed-back');
    expect(b.ui.byTestId('screen-wifi')).toBeTruthy();
    expect(store.seat?.token).toBe(token); // not a deliberate leave: the seat is still Bo's
    await network(() => net.setOffline(b.address, false));
    await b.ui.press('join-Hana');
    expect(b.ui.byTestId('phase-watch-choose-word')).toBeTruthy(); // straight back into the running game
    expect(h.ui.queryByTestId('disconnected-banner')).toBeNull();
    expect(store.seat?.token).toBe(token);

    // The app is closed without a goodbye (the system killed it) and opened again.
    await network(() => net.setOffline(b.address, true));
    devices.splice(devices.indexOf(b), 1);
    await b.ui.unmount();
    await network(() => net.setOffline(b.address, false));
    expect(h.ui.byTestId('disconnected-banner')).toBeTruthy();
    const again = await device(net, { address: b.address, tuning: QUICK_TO_GIVE_UP, seatStore: store });
    await again.ui.type('wifi-name', 'Bo');
    await flush();
    await again.ui.press('join-Hana');
    expect(again.ui.byTestId('phase-watch-choose-word')).toBeTruthy();
    expect(h.ui.queryByTestId('disconnected-banner')).toBeNull();
    expect(h.ui.allText()).not.toContain('bo 2');

    // Leaving on purpose gives the seat up: the token is forgotten, and coming back is a new join.
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await act(async () => {
      again.back.current?.();
    });
    expect(alert.mock.calls[0][0]).toBe('Leave this game?');
    await confirmAlert(alert);
    expect(again.ui.byTestId('screen-wifi')).toBeTruthy();
    expect(store.seat).toBeNull();
    expect(h.ui.allText()).toContain('unless they left the game');
    await again.ui.press('join-Hana');
    expect(again.ui.byTestId('closed-title').children.join('')).toBe('Game already started');
  });

  it('forgets the seat when the host removes the player, and that phone stays out of the lobby', async () => {
    const net = new MemoryNetwork();
    const store = memorySeatStore();
    const [h, b] = await lobby(net, ['Bo'], {}, { seatStore: store });
    expect(store.seat).not.toBeNull();
    await h.ui.press('remove-Bo');
    expect(b.ui.byTestId('closed-title').children.join('')).toBe('Removed from the lobby');
    expect(store.seat).toBeNull();
    await b.ui.press('closed-back');
    await b.ui.press('join-Hana');
    expect(b.ui.byTestId('closed-title').children.join('')).toBe('Removed from the lobby');
    expect(h.ui.queryByTestId('lobby-player-Bo')).toBeNull();
    // The real storage key is only touched through the store the app passes in.
    expect(await AsyncStorage.getItem(WIFI_SEAT_KEY)).toBeNull();
  });

  it('keeps the seat in device storage by default', async () => {
    const net = new MemoryNetwork();
    const [, b] = await lobby(net, ['Bo'], {}, { seatStore: undefined });
    await flush();
    const stored = JSON.parse((await AsyncStorage.getItem(WIFI_SEAT_KEY)) ?? 'null') as SavedSeat | null;
    expect(stored).toMatchObject({ host: HOST_ADDRESS, port: 40001 });
    expect(typeof stored?.token).toBe('string');
    // A deliberate leave removes it again.
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await act(async () => {
      b.back.current?.();
    });
    await confirmAlert(alert);
    expect(await AsyncStorage.getItem(WIFI_SEAT_KEY)).toBeNull();
  });
});

describe('Play over Wi-Fi: coming back to the app, and trying again by hand', () => {
  async function lostForGood(net: MemoryNetwork) {
    const [h, b] = await lobby(net, ['Bo'], {}, { tuning: QUICK_TO_GIVE_UP });
    await h.ui.press('start-wifi-game');
    await goDark(net, b);
    await wait(600);
    expect(b.ui.byTestId('closed-title').children.join('')).toBe('Connection lost');
    expect(h.ui.byTestId('disconnected-banner')).toBeTruthy();
    await network(() => net.setOffline(b.address, false));
    return { h, b };
  }

  it('checks the connection when the app returns to the foreground', async () => {
    const listeners: ((state: string) => void)[] = [];
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      listeners.push(listener as (state: string) => void);
      return { remove } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    const net = new MemoryNetwork();
    const { h, b } = await lostForGood(net);
    expect(listeners).toHaveLength(2); // one per phone: the host's, then Bo's

    // Going to the background does nothing; coming back reconnects without anyone tapping.
    await act(async () => listeners[1]('background'));
    await wait(50);
    expect(b.ui.byTestId('screen-wifi-closed')).toBeTruthy();
    await act(async () => listeners[1]('active'));
    await wait(100);
    expect(b.ui.queryByTestId('screen-wifi-closed')).toBeNull();
    expect(b.ui.byTestId('phase-watch-choose-word')).toBeTruthy();
    expect(h.ui.queryByTestId('disconnected-banner')).toBeNull();

    expect(remove).not.toHaveBeenCalled();
    devices.splice(devices.indexOf(b), 1);
    await b.ui.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('"Try to reconnect" takes the seat back once the host can be reached again', async () => {
    const net = new MemoryNetwork();
    const { h, b } = await lostForGood(net);
    await b.ui.press('closed-retry');
    await wait(100);
    expect(b.ui.queryByTestId('screen-wifi-closed')).toBeNull();
    expect(b.ui.byTestId('phase-watch-choose-word')).toBeTruthy();
    expect(h.ui.queryByTestId('disconnected-banner')).toBeNull();
    expect(h.ui.allText()).not.toContain('bo 2');
  });
});

describe("Play over Wi-Fi: the host's word model", () => {
  it('tells the host (and only the host) when the model failed to load, with a retry', async () => {
    const net = new MemoryNetwork();
    let failing = true;
    const embedder = {
      ...createTestEmbedder(),
      load: async () => {
        if (failing) throw new Error('model file missing');
      },
    };
    const [h, b] = await lobby(net, ['Bo'], { embedder }, { embedder: createTestEmbedder({ failLoad: true }) });
    expect(h.ui.byTestId('host-model-error')).toBeTruthy();
    expect(h.ui.allText()).toContain('model file missing');
    expect(h.ui.allText()).toContain("scores everyone's clues");
    // A joiner's own model does not matter: the host scores.
    expect(b.ui.queryByTestId('host-model-error')).toBeNull();

    // It is shown during the game as well, where it matters most.
    await h.ui.press('start-wifi-game');
    expect(h.ui.byTestId('host-model-error')).toBeTruthy();
    expect(b.ui.queryByTestId('host-model-error')).toBeNull();

    failing = false;
    await h.ui.press('host-model-retry');
    await flush();
    expect(h.ui.queryByTestId('host-model-error')).toBeNull();
    expect(h.ui.queryByTestId('host-model-loading')).toBeNull();
  });

  it('says so while the model is still loading', async () => {
    const net = new MemoryNetwork();
    let loaded: () => void = () => undefined;
    const embedder = { ...createTestEmbedder(), load: () => new Promise<void>((resolve) => (loaded = resolve)) };
    const h = await device(net, { address: HOST_ADDRESS, embedder });
    await host(h, 'Hana');
    expect(h.ui.byTestId('host-model-loading')).toBeTruthy();
    expect(h.ui.queryByTestId('host-model-error')).toBeNull();
    await act(async () => loaded());
    await flush();
    expect(h.ui.queryByTestId('host-model-loading')).toBeNull();
  });
});

describe('Play over Wi-Fi: the giver on their own phone', () => {
  it('clears a rejected clue, keeps one that broke a rule, and can forfeit after five rejections', async () => {
    const net = new MemoryNetwork();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const [h, b] = await lobby(net, ['Bo']);
    await h.ui.press('start-wifi-game');
    const hidden = dealtWords(h.ui)[0];
    await h.ui.press(`option-${hidden}`);
    await h.ui.press('confirm-word');

    // Broke a rule: nothing was scored, so the text stays for fixing.
    await h.ui.type('clue-input', hidden);
    await h.ui.press('submit-clue');
    expect(h.ui.byTestId('clue-input').props.value).toBe(hidden);
    expect(h.ui.queryByTestId('forfeit')).toBeNull();

    for (const clue of ['farca', 'farcb', 'farcc', 'farcd', 'farce']) {
      expect(h.ui.queryByTestId('forfeit')).toBeNull();
      await h.ui.type('clue-input', clue);
      await h.ui.press('submit-clue');
      expect(h.ui.byTestId(`rejected-${clue}`)).toBeTruthy();
      expect(h.ui.byTestId('clue-input').props.value).toBe(''); // ready for the next try
    }
    expect(b.ui.byTestId('phase-watch-clue')).toBeTruthy();
    expectNoneVisible(b.ui, ['farca', 'farce']);

    // Forfeiting asks first; only the confirmation ends the turn - on every phone.
    await h.ui.press('forfeit');
    expect(alert.mock.calls[0][0]).toBe('Forfeit this turn?');
    expect(h.ui.byTestId('phase-clue')).toBeTruthy();
    await confirmAlert(alert);
    for (const d of [h, b]) {
      expect(d.ui.byTestId('phase-turn-result')).toBeTruthy();
      expect(d.ui.byTestId('revealed-word').children).toEqual([hidden]);
      expect(d.ui.allText()).toContain('hana forfeited the turn');
    }
  });

  it('cannot lock in a word or submit a clue while the connection is down', async () => {
    const net = new MemoryNetwork();
    const [h, b] = await lobby(net, ['Bo']);
    await h.ui.press('start-wifi-game');
    await playHostTurn(h, b);
    expect(b.ui.byTestId('phase-choose-word')).toBeTruthy(); // Bo gives now

    const word = dealtWords(b.ui)[0];
    await b.ui.press(`option-${word}`);
    expect(isDisabled(b.ui, 'confirm-word')).toBe(false);
    await goDark(net, b);
    expect(b.ui.byTestId('reconnecting-banner')).toBeTruthy();
    expect(isDisabled(b.ui, 'confirm-word')).toBe(true);

    await network(() => net.setOffline(b.address, false));
    await wait(250);
    expect(isDisabled(b.ui, 'confirm-word')).toBe(false);
    await b.ui.press('confirm-word');
    await b.ui.type('clue-input', 'closeclue');
    expect(isDisabled(b.ui, 'submit-clue')).toBe(false);
    await goDark(net, b);
    expect(isDisabled(b.ui, 'submit-clue')).toBe(true);
    expect(h.ui.byTestId('giver-gone')).toBeTruthy();
    expect(h.ui.allText()).toContain('bo is disconnected');
  });
});

describe('Play over Wi-Fi: a connected player who does not play', () => {
  it('after the idle limit the host may skip their guess or end their turn - after confirming', async () => {
    const net = new MemoryNetwork();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const impatient: WifiFlowTuning = { ...TUNING, host: { ...TUNING.host, idleSkipMs: 150 } };
    const [h, b, c] = await lobby(net, ['Bo', 'Cy'], { tuning: impatient });
    await h.ui.press('start-wifi-game');
    const hidden = await hostGivesClue(h);
    await b.ui.type('guess-input', hidden);
    await b.ui.press('submit-guess');
    expect(h.ui.queryByTestId('skip-Cy')).toBeNull(); // Cy is connected and has only just been asked

    await wait(300);
    expect(h.ui.queryByTestId('disconnected-banner')).toBeNull();
    expect(h.ui.byTestId('skip-Cy')).toBeTruthy();
    expect(b.ui.queryByTestId('skip-Cy')).toBeNull();
    await h.ui.press('skip-Cy');
    expect(alert.mock.calls[0][0]).toBe("Skip Cy's guess?");
    expect(c.ui.byTestId('phase-guess')).toBeTruthy(); // nothing happened yet
    await confirmAlert(alert);
    for (const d of [h, b, c]) expect(d.ui.byTestId('phase-round-result')).toBeTruthy();
    expect(c.ui.allText()).toContain('did not guess');

    // Bo gives next and never picks a word.
    await h.ui.press('next');
    await h.ui.press('next');
    expect(b.ui.byTestId('phase-choose-word')).toBeTruthy();
    expect(h.ui.queryByTestId('giver-gone')).toBeNull();
    await wait(300);
    expect(h.ui.byTestId('giver-gone')).toBeTruthy();
    expect(h.ui.allText()).toContain('bo is not responding');
    expect(c.ui.queryByTestId('giver-gone')).toBeNull();
    await h.ui.press('forfeit-giver');
    expect(alert.mock.calls[1][0]).toBe("End Bo's turn?");
    expect(b.ui.byTestId('phase-choose-word')).toBeTruthy();
    await confirmAlert(alert);
    for (const d of [h, b, c]) expect(d.ui.byTestId('phase-turn-result')).toBeTruthy();
    expect(h.ui.allText()).toContain('bo forfeited the turn');
  });
});

describe('Play over Wi-Fi: leaving when there is nothing to lose, and stray taps at the end', () => {
  it('hardware back leaves without asking while connecting, after the session closed, and when hosting failed', async () => {
    const net = new MemoryNetwork();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const back = async (d: Device) => {
      await act(async () => {
        d.back.current?.();
      });
      await flush();
    };

    const b = await device(net);
    await b.ui.type('wifi-name', 'Bo');
    await b.ui.press('wifi-manual-toggle');
    await b.ui.type('manual-host', '10.0.0.77:41234');
    await b.ui.press('manual-join');
    expect(b.ui.byTestId('screen-wifi-connecting')).toBeTruthy();
    await back(b);
    expect(b.ui.byTestId('screen-wifi')).toBeTruthy();

    await b.ui.press('wifi-manual-toggle');
    await b.ui.type('manual-host', '10.0.0.77:41234');
    await b.ui.press('manual-join');
    await wait(400);
    expect(b.ui.byTestId('screen-wifi-closed')).toBeTruthy();
    await back(b);
    expect(b.ui.byTestId('screen-wifi')).toBeTruthy();

    const real = net.createAdapter('10.0.0.9');
    const failing: NetworkAdapter = { ...real, startHost: () => Promise.reject(new Error('address already in use')) };
    const h = await device(net, { adapter: failing });
    await h.ui.type('wifi-name', 'Hana');
    await h.ui.press('wifi-host');
    expect(h.ui.byTestId('screen-wifi-host-failed')).toBeTruthy();
    expect(h.ui.allText()).toContain('the lobby could not be opened');
    await back(h);
    expect(h.ui.byTestId('screen-wifi')).toBeTruthy();

    expect(alert).not.toHaveBeenCalled();
    expect(b.onExit).not.toHaveBeenCalled();
  });

  it('ignores a stray tap on the final-score buttons, and leaves a finished game without asking', async () => {
    const net = new MemoryNetwork();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const [h, b] = await lobby(net, ['Bo']);
    await h.ui.press('start-wifi-game');
    await playHostTurn(h, b);
    // Turn 2: Bo gives, Hana guesses; the last "next" lands on the final scores.
    const word = dealtWords(b.ui)[0];
    await b.ui.press(`option-${word}`);
    await b.ui.press('confirm-word');
    await b.ui.type('clue-input', 'closeclue');
    await b.ui.press('submit-clue');
    await h.ui.type('guess-input', word);
    await h.ui.press('submit-guess');
    await h.ui.press('next');
    await h.ui.press('next');
    for (const d of [h, b]) expect(d.ui.byTestId('phase-game-over')).toBeTruthy();

    // The second tap of a double tap lands where "Play again" / "Leave" just appeared.
    await h.ui.pressNow('play-again');
    await b.ui.pressNow('leave-game');
    for (const d of [h, b]) expect(d.ui.byTestId('phase-game-over')).toBeTruthy();

    // Deliberate taps work, and nobody is asked "are you sure" once the game is over.
    await b.ui.press('leave-game');
    expect(b.ui.byTestId('screen-wifi')).toBeTruthy();
    await h.ui.press('play-again');
    expect(h.ui.byTestId('screen-lobby')).toBeTruthy();
    expect(alert).not.toHaveBeenCalled();
  });

  it('hardware back on the final scores leaves without asking', async () => {
    const net = new MemoryNetwork();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const [h, b] = await lobby(net, ['Bo'], { settings: settings({ guessMode: 'list' }) });
    await h.ui.press('start-wifi-game');
    for (const [giver, guesser] of [
      [h, b],
      [b, h],
    ]) {
      const word = dealtWords(giver.ui)[0];
      await giver.ui.press(`option-${word}`);
      await giver.ui.press('confirm-word');
      await giver.ui.type('clue-input', 'closeclue');
      await giver.ui.press('submit-clue');
      await guesser.ui.press(`guess-option-${word}`);
      await guesser.ui.press('submit-guess');
      await h.ui.press('next');
      await h.ui.press('next');
    }
    expect(b.ui.byTestId('phase-game-over')).toBeTruthy();
    await act(async () => {
      b.back.current?.();
    });
    await flush();
    expect(alert).not.toHaveBeenCalled();
    expect(b.ui.byTestId('screen-wifi')).toBeTruthy();
  });
});

describe('Play over Wi-Fi inside the app', () => {
  type BackListener = () => boolean | null | undefined;

  it('is reached from home, loads the real adapter only on demand and survives it failing', async () => {
    let backListener: BackListener | null = null;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, listener) => {
      backListener = listener as BackListener;
      return { remove: () => undefined };
    });
    // No adapter injected: home and pass-and-play never touch native networking...
    const ui = await render(<App wifi={{ platform: 'android' }} />);
    expect(ui.byTestId('screen-home')).toBeTruthy();
    expect(ui.allText()).toContain('play on this phone');
    await ui.press('home-play');
    expect(ui.byTestId('screen-setup')).toBeTruthy();
    await act(async () => {
      (backListener as BackListener | null)?.();
    });
    // ...and the Wi-Fi screen reports the missing native module instead of crashing.
    await ui.press('home-wifi');
    expect(ui.byTestId('screen-wifi')).toBeTruthy();
    expect(ui.byTestId('wifi-browse-error')).toBeTruthy();
    expect(ui.allText()).toContain('native networking is not available here');
    await ui.type('wifi-name', 'Ana');
    await ui.press('wifi-host');
    expect(ui.byTestId('wifi-error').children.length).toBeGreaterThan(0);
    expect(ui.byTestId('screen-wifi')).toBeTruthy();
    await ui.unmount();
  });

  it('hosts from the app with an injected adapter; hardware back confirms, then returns home', async () => {
    let backListener: BackListener | null = null;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, listener) => {
      backListener = listener as BackListener;
      return { remove: () => undefined };
    });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const net = new MemoryNetwork();
    const ui = await render(<App netAdapter={net.createAdapter(HOST_ADDRESS)} wifi={{ platform: 'android', tuning: TUNING }} />);
    const pressBack = async (): Promise<boolean> => {
      let handled = false;
      await act(async () => {
        handled = (backListener as BackListener | null)?.() === true;
      });
      await flush();
      return handled;
    };

    await ui.press('home-wifi');
    await ui.type('wifi-name', 'Ana');
    await ui.press('wifi-host');
    expect(ui.byTestId('screen-lobby')).toBeTruthy();
    expect(net.hostPorts()).toHaveLength(1);

    expect(await pressBack()).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(ui.byTestId('screen-lobby')).toBeTruthy();
    await confirmAlert(alert);
    await wait(20);
    expect(ui.byTestId('screen-wifi')).toBeTruthy();
    expect(net.hostPorts()).toHaveLength(0);

    expect(await pressBack()).toBe(true);
    expect(ui.byTestId('screen-home')).toBeTruthy();
    expect(await pressBack()).toBe(false); // home: the system leaves the app
    await ui.unmount();
  });
});

describe('manual join helpers', () => {
  it('accepts only IPv4 addresses and ports from 1 to 65535', () => {
    expect(isIpv4Address('192.168.1.20')).toBe(true);
    expect(isIpv4Address('0.0.0.0')).toBe(true);
    for (const bad of ['', '192.168.1', '192.168.1.256', '1.2.3.4.5', 'a.b.c.d', '192.168.1.20 ', 'fe80::1', '1..2.3']) {
      expect(isIpv4Address(bad)).toBe(false);
    }
    expect(validateJoinTarget(' 192.168.1.20 ', ' 40123 ')).toEqual({
      ok: true,
      hostError: null,
      portError: null,
      target: { host: '192.168.1.20', port: 40123 },
    });
    expect(validateJoinTarget('192.168.1.20:40123', '').target).toEqual({ host: '192.168.1.20', port: 40123 });
    for (const port of ['', '0', '65536', '-1', '80.5', 'http', '1e3', '123456']) {
      const result = validateJoinTarget('192.168.1.20', port);
      expect(result.ok).toBe(false);
      expect(result.portError).not.toBeNull();
      expect(result.hostError).toBeNull();
    }
    for (const hostText of ['', 'my-phone.local', '999.1.1.1', '192.168.1.20:']) {
      const result = validateJoinTarget(hostText, '40123');
      expect(result.ok).toBe(false);
      expect(result.hostError).not.toBeNull();
    }
    expect(validateJoinTarget('192.168.1.20', '65535').ok).toBe(true);
    expect(validateJoinTarget('192.168.1.20', '1').ok).toBe(true);
  });

  it('recognises errors that read like a refused local-network permission', () => {
    for (const text of ['NSNetServicesErrorCode = -72008', 'kDNSServiceErr_PolicyDenied', 'Local network prohibited', 'connect EHOSTUNREACH: No route to host', 'Permission denied']) {
      expect(looksLikePermissionDenial(text)).toBe(true);
    }
    for (const text of [null, undefined, '', 'Connection refused', 'timed out', 'address already in use']) {
      expect(looksLikePermissionDenial(text)).toBe(false);
    }
    expect(permissionHelp('ios')).toContain('Local Network');
    expect(permissionHelp('android')).toContain('Wi-Fi');
  });
});
