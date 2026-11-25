/**
 * Everything behind "Play over Wi-Fi": the entry screen, the lobby and the
 * networked game. One host or client session lives here for as long as the
 * player stays in the flow, whichever screen is showing, and is torn down
 * completely (transport stopped, service unpublished, timers cleared) when the
 * player leaves or the flow unmounts.
 *
 * The real network adapter (src/net/lanAdapter) loads native modules, so it is
 * required lazily, the first time something actually browses, hosts or joins.
 * Tests pass an in-memory adapter instead.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, Alert, AppState, Platform, StyleSheet, View } from 'react-native';

import { DECK, isNoun as dictionaryIsNoun } from '../../data/nouns';
import {
  HostSession,
  createClientSession,
  type ClientSession,
  type ClientSessionOptions,
  type ClientSnapshot,
  type HostSessionOptions,
  type HostSnapshot,
  type NetworkAdapter,
} from '../../net';
import { useSimilarity } from '../../similarity';
import { SAVED_SEAT_MAX_AGE_MS, clearSavedSeat, loadSavedSeat, saveSavedSeat, type SavedSeat } from '../../storage';
import { AppText, Button, Card, Screen } from '../components';
import { makeSeed } from '../format';
import { LeaderboardList } from '../game/parts';
import { useSettings } from '../SettingsContext';
import { spacing, useTheme } from '../theme';
import { errorText, looksLikePermissionDenial, permissionHelp } from './joinTarget';
import { LobbyScreen } from './LobbyScreen';
import { NetGameScreen } from './NetGameScreen';
import { publicPlayersOf, type ModelNotice } from './netShared';
import { useClientSnapshot, useHostSnapshot } from './useSession';
import { WifiEntryScreen } from './WifiEntryScreen';

/** Session knobs tests turn down (timeouts, the deck, the seed). Not used by the app itself. */
export interface WifiFlowTuning {
  host?: Partial<Omit<HostSessionOptions, 'adapter' | 'hostName' | 'score' | 'settings'>>;
  client?: Partial<Omit<ClientSessionOptions, 'connect' | 'name'>>;
}

/** Where the seat of the last joined game is remembered. The app uses device storage; tests give each virtual phone its own. */
export interface SeatStore {
  load(): Promise<SavedSeat | null>;
  save(seat: SavedSeat): Promise<unknown>;
  clear(): Promise<unknown>;
}

const DEVICE_SEAT_STORE: SeatStore = { load: loadSavedSeat, save: saveSavedSeat, clear: clearSavedSeat };

/** Ways a session ends that mean the seat is gone (or was never there): the saved token is of no use any more. */
const SEAT_GONE: readonly NonNullable<ClientSnapshot['closeReason']>[] = ['removed', 'host-left', 'replaced', 'version', 'in-progress', 'full'];

export interface WifiFlowProps {
  /** Leave the Wi-Fi flow (back to the home screen). */
  onExit: () => void;
  /** The network to use. Defaults to the real LAN adapter, loaded on first use. */
  adapter?: NetworkAdapter;
  /**
   * The app's hardware-back handler calls `backHandler.current()` while this
   * flow is showing; it returns true when the press was handled here.
   */
  backHandler?: RefObject<(() => boolean) | null>;
  /** Platform.OS, injectable for tests. */
  platform?: string;
  discoveryTimeoutMs?: number;
  tuning?: WifiFlowTuning;
  /** Where the reconnect token of the last joined game is kept. Defaults to device storage. */
  seatStore?: SeatStore;
}

type Active =
  | { kind: 'host'; host: HostSession; client: ClientSession }
  | { kind: 'join'; client: ClientSession; label: string; target: { host: string; port: number } };

function loadLanAdapter(): NetworkAdapter {
  // Required lazily: importing lanAdapter loads the native TCP / zeroconf
  // modules, which pass-and-play and the tests must never need.
  const mod = require('../../net/lanAdapter') as typeof import('../../net/lanAdapter');
  return mod.createLanAdapter();
}

function tearDown(active: Active | null): void {
  if (active === null) return;
  try {
    if (active.kind === 'host') void active.host.stop().catch(() => undefined);
    else active.client.leave();
  } catch {
    // Leaving must always succeed from the player's point of view.
  }
}

export function WifiFlow({
  onExit,
  adapter,
  backHandler,
  platform = Platform.OS,
  discoveryTimeoutMs,
  tuning,
  seatStore = DEVICE_SEAT_STORE,
}: WifiFlowProps) {
  const { settings } = useSettings();
  const { similarity } = useSimilarity();
  const [active, setActiveState] = useState<Active | null>(null);
  const [entryError, setEntryError] = useState<string | null>(null);
  const activeRef = useRef<Active | null>(null);
  const leaveDialogOpen = useRef(false);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const similarityRef = useRef(similarity);
  similarityRef.current = similarity;

  const setActive = useCallback((next: Active | null) => {
    activeRef.current = next;
    setActiveState(next);
  }, []);

  const adapterRef = useRef<NetworkAdapter | null>(adapter ?? null);
  const getAdapter = useCallback((): NetworkAdapter => {
    if (adapterRef.current === null) adapterRef.current = loadLanAdapter();
    return adapterRef.current;
  }, []);

  // The seat held in the last game joined from this phone. Joining the same host
  // again presents its token, so a player whose app was closed (or who went back
  // to the list after losing the connection) gets their seat back.
  const seatStoreRef = useRef(seatStore);
  const savedSeat = useRef<SavedSeat | null>(null);
  const seatTouched = useRef(false);
  useEffect(() => {
    let alive = true;
    seatStoreRef.current.load().then(
      (seat) => {
        // Whatever was saved or cleared since this mounted is newer than what was stored.
        if (alive && !seatTouched.current) savedSeat.current = seat;
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  const rememberSeat = useCallback((seat: SavedSeat | null) => {
    seatTouched.current = true;
    savedSeat.current = seat;
    const store = seatStoreRef.current;
    void (seat === null ? store.clear() : store.save(seat)).catch(() => undefined);
  }, []);
  const forgetSeat = useCallback(
    (target: { host: string; port: number }) => {
      const saved = savedSeat.current;
      if (saved !== null && saved.host === target.host && saved.port === target.port) rememberSeat(null);
    },
    [rememberSeat],
  );
  /** A deliberate leave from a live session gives the seat up for good. */
  const forgetSeatIfLive = useCallback(
    (current: Active | null) => {
      if (current === null || current.kind !== 'join') return;
      const status = current.client.getSnapshot().status;
      if (status === 'connected' || status === 'reconnecting') forgetSeat(current.target);
    },
    [forgetSeat],
  );

  useEffect(() => {
    if (active === null || active.kind !== 'join') return;
    const { client, target } = active;
    const check = () => {
      const snapshot = client.getSnapshot();
      if (snapshot.status === 'connected') {
        const saved = savedSeat.current;
        if (saved === null || saved.token !== client.token || saved.host !== target.host || saved.port !== target.port) {
          rememberSeat({ host: target.host, port: target.port, token: client.token, savedAt: Date.now() });
        }
      } else if (snapshot.status === 'closed' && snapshot.closeReason !== null && SEAT_GONE.includes(snapshot.closeReason)) {
        forgetSeat(target);
      }
    };
    check();
    return client.subscribe(check);
  }, [active, forgetSeat, rememberSeat]);

  // Whatever happens to this component, no session outlives it.
  useEffect(
    () => () => {
      tearDown(activeRef.current);
      activeRef.current = null;
    },
    [],
  );

  // Timers do not run while the app is in the background: check the connection as soon as it is back.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') activeRef.current?.client.resume();
    });
    return () => subscription.remove();
  }, []);

  const startHosting = useCallback(
    (name: string) => {
      if (activeRef.current !== null) return;
      setEntryError(null);
      try {
        const host = new HostSession({
          deck: DECK,
          isNoun: dictionaryIsNoun,
          seed: () => makeSeed(),
          ...tuning?.host,
          adapter: getAdapter(),
          hostName: name,
          // Read when each game starts, so "play again" picks up changed settings.
          settings: () => settingsRef.current,
          score: (clue, word) => similarityRef.current(clue, word),
        });
        setActive({ kind: 'host', host, client: host.client });
        // A failure is shown from the host snapshot (status 'failed').
        host.start().catch(() => undefined);
      } catch (e) {
        setEntryError(`Could not start hosting: ${errorText(e)}`);
      }
    },
    [getAdapter, setActive, tuning],
  );

  const startJoining = useCallback(
    (target: { host: string; port: number }, name: string, label: string) => {
      if (activeRef.current !== null) return;
      setEntryError(null);
      try {
        const saved = savedSeat.current;
        const age = saved === null ? 0 : Date.now() - saved.savedAt;
        const token =
          saved !== null && saved.host === target.host && saved.port === target.port && age < SAVED_SEAT_MAX_AGE_MS
            ? saved.token
            : undefined;
        // An unknown token is harmless: the host treats it as a new player.
        const client = createClientSession({ ...tuning?.client, adapter: getAdapter(), target, name, token });
        setActive({ kind: 'join', client, label, target });
        client.start();
      } catch (e) {
        setEntryError(`Could not join: ${errorText(e)}`);
      }
    },
    [getAdapter, setActive, tuning],
  );

  /** Ends the session and returns to the entry screen. */
  const leaveNow = useCallback(() => {
    forgetSeatIfLive(activeRef.current);
    tearDown(activeRef.current);
    setActive(null);
  }, [forgetSeatIfLive, setActive]);

  const exitNow = useCallback(() => {
    forgetSeatIfLive(activeRef.current);
    tearDown(activeRef.current);
    setActive(null);
    onExit();
  }, [forgetSeatIfLive, onExit, setActive]);

  /** Leaves, asking first whenever there is a lobby or a running game to lose. */
  const requestLeave = useCallback(() => {
    const current = activeRef.current;
    if (current === null) return;
    const snapshot = current.client.getSnapshot();
    const view = snapshot.view;
    const failedHost = current.kind === 'host' && current.host.getSnapshot().status !== 'open';
    const nothingToLose =
      failedHost || snapshot.status === 'closed' || view === null || (view.stage === 'game' && view.game?.phase === 'game-over');
    if (nothingToLose) {
      leaveNow();
      return;
    }
    if (leaveDialogOpen.current) return;
    leaveDialogOpen.current = true;
    const close = () => {
      leaveDialogOpen.current = false;
    };
    const inGame = view.stage === 'game';
    const isHost = current.kind === 'host';
    const title = isHost ? (inGame ? 'Close this game?' : 'Close the lobby?') : inGame ? 'Leave this game?' : 'Leave the lobby?';
    const body = isHost
      ? inGame
        ? 'You are the host: the game ends for everyone and its scores are lost.'
        : 'You are the host: everyone in the lobby is disconnected.'
      : inGame
        ? 'The game goes on without you; the host can skip your guesses and turns.'
        : 'You can join again while the lobby is open.';
    Alert.alert(
      title,
      body,
      [
        { text: 'Stay', style: 'cancel', onPress: close },
        {
          text: isHost ? 'Close game' : 'Leave',
          style: 'destructive',
          onPress: () => {
            close();
            leaveNow();
          },
        },
      ],
      { cancelable: true, onDismiss: close },
    );
  }, [leaveNow]);

  // Android hardware back: confirm inside a session, otherwise go home.
  useEffect(() => {
    if (!backHandler) return;
    backHandler.current = () => {
      if (activeRef.current === null) exitNow();
      else requestLeave();
      return true;
    };
    return () => {
      backHandler.current = null;
    };
  }, [backHandler, exitNow, requestLeave]);

  if (active === null) {
    return (
      <WifiEntryScreen
        getAdapter={getAdapter}
        platform={platform}
        discoveryTimeoutMs={discoveryTimeoutMs}
        onBack={exitNow}
        onHost={startHosting}
        onJoin={startJoining}
        error={entryError}
      />
    );
  }
  if (active.kind === 'host') {
    return (
      <HostedSession
        key="host"
        host={active.host}
        client={active.client}
        platform={platform}
        onLeave={requestLeave}
        onLeaveNow={leaveNow}
        onHome={exitNow}
      />
    );
  }
  return (
    <SessionScreens
      key="join"
      client={active.client}
      label={active.label}
      platform={platform}
      onLeave={requestLeave}
      onLeaveNow={leaveNow}
      onHome={exitNow}
    />
  );
}

interface SessionProps {
  client: ClientSession;
  platform: string;
  onLeave: () => void;
  onLeaveNow: () => void;
  onHome: () => void;
}

/** The host's phone: waits for the lobby to open, then shows the same screens as everyone else. */
function HostedSession({ host, ...rest }: SessionProps & { host: HostSession }) {
  const hostSnapshot = useHostSnapshot(host);
  const { status, error, retry } = useSimilarity();

  if (hostSnapshot.status === 'starting' || hostSnapshot.status === 'idle') {
    return <Busy testID="screen-wifi-opening" title="Opening your lobby..." onCancel={rest.onLeaveNow} />;
  }
  if (hostSnapshot.status === 'failed') {
    const permission = looksLikePermissionDenial(hostSnapshot.error);
    return (
      <Screen
        testID="screen-wifi-host-failed"
        title="Play over Wi-Fi"
        onBack={rest.onLeaveNow}
        footer={<Button testID="host-failed-back" label="Back" onPress={rest.onLeaveNow} />}
      >
        <AppText variant="heading">
          {hostSnapshot.port === null ? 'The lobby could not be opened' : 'The game had to be closed'}
        </AppText>
        <Card tone="danger">
          <AppText color="danger" style={styles.bold} accessibilityRole="alert">
            {hostSnapshot.error ?? 'Unknown error.'}
          </AppText>
          <AppText variant="caption">
            {permission
              ? permissionHelp(rest.platform)
              : hostSnapshot.port !== null
                ? 'The other phones were disconnected. Check that Wi-Fi is on and connected, then host a new game.'
                : 'Check that Wi-Fi is on and connected, then try again. Hosting needs a Wi-Fi network; mobile data alone is not enough.'}
          </AppText>
        </Card>
      </Screen>
    );
  }
  const modelNotice: ModelNotice | null =
    status === 'error' ? { status: 'error', detail: error, retry } : status === 'loading' ? { status: 'loading', retry } : null;
  return <SessionScreens {...rest} hostSnapshot={hostSnapshot} modelNotice={modelNotice} />;
}

interface SessionScreensProps extends SessionProps {
  /** What was joined (for the connecting screen). */
  label?: string;
  hostSnapshot?: HostSnapshot | null;
  modelNotice?: ModelNotice | null;
}

/** Picks the screen for the session's current state. Everything shown comes from the client snapshot. */
function SessionScreens({ client, label, platform, hostSnapshot, modelNotice, onLeave, onLeaveNow, onHome }: SessionScreensProps) {
  const snapshot = useClientSnapshot(client);
  const view = snapshot.view;

  if (snapshot.status === 'closed') {
    return <ClosedScreen snapshot={snapshot} client={client} platform={platform} onLeaveNow={onLeaveNow} onHome={onHome} />;
  }
  if (view === null) {
    return (
      <Busy
        testID="screen-wifi-connecting"
        title={label ? `Connecting to ${label}...` : 'Connecting...'}
        detail="Both phones must be on the same Wi-Fi network."
        onCancel={onLeaveNow}
      />
    );
  }
  if (view.stage === 'game' && view.game !== null) {
    return (
      <NetGameScreen
        snapshot={snapshot}
        view={view}
        game={view.game}
        client={client}
        modelNotice={modelNotice}
        onLeave={onLeave}
        onLeaveNow={onLeaveNow}
      />
    );
  }
  return (
    <LobbyScreen snapshot={snapshot} view={view} client={client} hostSnapshot={hostSnapshot} modelNotice={modelNotice} onLeave={onLeave} />
  );
}

function Busy({ title, detail, onCancel, testID }: { title: string; detail?: string; onCancel: () => void; testID: string }) {
  const { colors } = useTheme();
  return (
    <Screen testID={testID} title="Play over Wi-Fi" onBack={onCancel} backLabel="Cancel" centered>
      <View style={styles.busy} accessible accessibilityLiveRegion="polite">
        <ActivityIndicator color={colors.accent} />
        <AppText variant="title" center>
          {title}
        </AppText>
        {detail ? (
          <AppText color="muted" center>
            {detail}
          </AppText>
        ) : null}
      </View>
    </Screen>
  );
}

const CLOSED_TITLES: Record<NonNullable<ClientSnapshot['closeReason']>, string> = {
  left: 'You left the game',
  'host-left': 'The host left',
  removed: 'Removed from the lobby',
  replaced: 'Joined from somewhere else',
  version: 'Update needed',
  full: 'Lobby full',
  'in-progress': 'Game already started',
  'connection-lost': 'Connection lost',
  unreachable: 'Host not reachable',
};

/** Terminal state of a session: why it ended, the last known scores, and the ways on. */
function ClosedScreen({
  snapshot,
  client,
  platform,
  onLeaveNow,
  onHome,
}: {
  snapshot: ClientSnapshot;
  client: ClientSession;
  platform: string;
  onLeaveNow: () => void;
  onHome: () => void;
}) {
  const reason = snapshot.closeReason ?? 'connection-lost';
  const retryable = reason === 'connection-lost' || reason === 'unreachable';
  const view = snapshot.view;
  const hadGame = view !== null && view.stage === 'game' && view.game !== null;
  let detail = snapshot.message ?? 'The session ended.';
  if (reason === 'host-left') detail = 'The host closed the game, so it cannot continue.';
  if (reason === 'connection-lost') {
    detail =
      'The host could not be reached any more. It may have closed the app, locked the phone or left the Wi-Fi network. If the host is still there, you can try to reconnect and take your seat back.';
  }
  return (
    <Screen
      testID="screen-wifi-closed"
      title="Play over Wi-Fi"
      footer={
        <View style={styles.block}>
          {retryable ? <Button testID="closed-retry" label="Try to reconnect" onPress={() => client.resume()} /> : null}
          <Button testID="closed-back" variant={retryable ? 'secondary' : 'primary'} label="Find another game" onPress={onLeaveNow} />
          <Button testID="closed-home" variant="secondary" label="Home" onPress={onHome} />
        </View>
      }
    >
      <View style={styles.block}>
        <AppText testID="closed-title" variant="heading" accessibilityRole="alert">
          {CLOSED_TITLES[reason]}
        </AppText>
        <AppText testID="closed-message">{detail}</AppText>
      </View>
      {reason === 'unreachable' ? (
        <Card tone="warning">
          <AppText variant="caption">
            {platform === 'ios'
              ? 'Check that both phones are on the same Wi-Fi and that the address and port match the host\'s lobby screen. On iPhone, also check Settings > Privacy & Security > Local Network: Similarity Game must be turned on.'
              : "Check that both phones are on the same Wi-Fi and that the address and port match the host's lobby screen. Some guest networks stop phones from talking to each other."}
          </AppText>
        </Card>
      ) : null}
      {hadGame && view ? (
        <View style={styles.block}>
          <AppText variant="label" color="muted">
            Scores when it ended
          </AppText>
          <LeaderboardList players={publicPlayersOf(view)} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  busy: { alignItems: 'center', gap: spacing.md },
  bold: { fontWeight: '700' },
});
