import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, StyleSheet, View } from 'react-native';

import { MAX_PLAYERS, MIN_PLAYERS } from '../../game';
import { PROTOCOL_VERSION, cleanPlayerName, type FoundHost, type NetworkAdapter } from '../../net';
import { DEFAULT_WIFI_PREFS, loadWifiPrefs, saveWifiPrefs, type WifiPrefs } from '../../storage';
import { AppText, Button, Card, Chip, Screen, TextField } from '../components';
import type { TextFieldHandle } from '../components/TextField';
import { MAX_NAME_LENGTH } from '../players';
import { ModelStatus } from '../screens/HomeScreen';
import { spacing, useTheme } from '../theme';
import { errorText, looksLikePermissionDenial, permissionHelp, validateJoinTarget } from './joinTarget';

/** How long discovery may find nothing before the "nothing found" help is shown. */
export const DISCOVERY_EMPTY_AFTER_MS = 8000;

export interface WifiEntryScreenProps {
  /** Returns the network adapter; called only when browsing (or hosting) really starts. May throw. */
  getAdapter: () => NetworkAdapter;
  /** Platform.OS, injectable for tests. */
  platform: string;
  discoveryTimeoutMs?: number;
  onBack: () => void;
  onHost: (name: string) => void;
  onJoin: (target: { host: string; port: number }, name: string, label: string) => void;
  /** A problem from the last attempt to host or join (e.g. networking unavailable). */
  error?: string | null;
}

/** One line under a discovered game: its address (a host advertises nothing else but its protocol version). */
function describeHost(host: FoundHost): string {
  return `${host.host}:${host.port}`;
}

const NAME_NEEDED = 'Enter your name first.';

/**
 * "Play over Wi-Fi" entry: your name, host a game, or join one that discovery
 * found (or by typing the host's address).
 */
export function WifiEntryScreen({
  getAdapter,
  platform,
  discoveryTimeoutMs = DISCOVERY_EMPTY_AFTER_MS,
  onBack,
  onHost,
  onJoin,
  error,
}: WifiEntryScreenProps) {
  const { colors } = useTheme();
  const [prefs, setPrefs] = useState<WifiPrefs | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  /** Which button asked for the name: the reminder is repeated right there, where the player is looking. */
  const [nameErrorAt, setNameErrorAt] = useState<'host' | 'list' | 'manual' | null>(null);
  const nameRef = useRef<TextFieldHandle>(null);

  const [hosts, setHosts] = useState<FoundHost[]>([]);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [embedded, setEmbedded] = useState(false);
  const [searchRound, setSearchRound] = useState(0);

  const [manualOpen, setManualOpen] = useState(false);
  const [manualHost, setManualHost] = useState('');
  const [manualPort, setManualPort] = useState('');
  const [manualTried, setManualTried] = useState(false);

  useEffect(() => {
    let alive = true;
    loadWifiPrefs().then((stored) => {
      if (alive) setPrefs((current) => current ?? stored);
    });
    return () => {
      alive = false;
    };
  }, []);

  const change = (patch: Partial<WifiPrefs>) => {
    const next = { ...(prefs ?? DEFAULT_WIFI_PREFS), ...patch };
    setPrefs(next);
    void saveWifiPrefs(next);
  };

  // On iOS the first browse (or hosting) makes the system ask for local-network
  // access, so nothing touches the network before the player has read why.
  const needsExplanation = prefs !== null && platform === 'ios' && !prefs.permissionExplained;
  const browsing = prefs !== null && !needsExplanation;

  const getAdapterRef = useRef(getAdapter);
  getAdapterRef.current = getAdapter;

  useEffect(() => {
    if (!browsing) return;
    let active = true;
    setHosts([]);
    setBrowseError(null);
    setTimedOut(false);
    let stop: (() => void) | null = null;
    try {
      stop = getAdapterRef.current().browse(
        {
          onChange: (found) => {
            if (active) setHosts(found.slice());
          },
          onError: (e) => {
            if (active) setBrowseError(errorText(e));
          },
        },
        { useEmbeddedMdns: embedded },
      );
    } catch (e) {
      setBrowseError(errorText(e));
    }
    const timer = setTimeout(() => {
      if (active) setTimedOut(true);
    }, discoveryTimeoutMs);
    return () => {
      active = false;
      clearTimeout(timer);
      try {
        stop?.();
      } catch {
        // Stopping discovery must never break leaving the screen.
      }
    };
  }, [browsing, embedded, searchRound, discoveryTimeoutMs]);

  if (prefs === null) {
    return (
      <Screen title="Play over Wi-Fi" onBack={onBack} backLabel="Home" centered>
        <ActivityIndicator color={colors.accent} accessibilityLabel="Loading" />
      </Screen>
    );
  }

  if (needsExplanation) {
    return (
      <Screen
        testID="screen-wifi-permission"
        title="Play over Wi-Fi"
        onBack={onBack}
        backLabel="Home"
        footer={
          <Button testID="wifi-permission-continue" label="Continue" onPress={() => change({ permissionExplained: true })} />
        }
      >
        <View style={styles.block}>
          <AppText variant="heading">Before you start</AppText>
          <AppText>
            To find games and let other phones join yours, the app talks to the other phones on this Wi-Fi network. Your
            iPhone will ask whether Similarity Game may find and connect to devices on your local network.
          </AppText>
        </View>
        <Card tone="accent">
          <AppText color="onAccentSoft" style={styles.bold}>
            Tap "Allow" when iOS asks.
          </AppText>
          <AppText color="onAccentSoft">
            Nothing leaves your Wi-Fi network: the phones talk to each other directly and the game needs no internet. If
            you choose "Don't Allow", no games will be found; you can change it later in Settings &gt; Privacy &amp;
            Security &gt; Local Network.
          </AppText>
        </Card>
      </Screen>
    );
  }

  const cleanedName = cleanPlayerName(prefs.name);
  const requireName = (where: 'host' | 'list' | 'manual'): string | null => {
    if (cleanedName.length === 0) {
      setNameError(NAME_NEEDED);
      setNameErrorAt(where);
      // The name field is at the top and may be scrolled out of view: bring the player to it.
      try {
        nameRef.current?.focus?.();
        AccessibilityInfo.announceForAccessibility?.(NAME_NEEDED);
      } catch {
        // Focus and announcements are conveniences; the messages on screen are what counts.
      }
      return null;
    }
    return cleanedName;
  };
  const nameReminder = (where: 'list' | 'manual') =>
    nameErrorAt === where && nameError !== null ? (
      <AppText testID={`${where}-name-error`} variant="caption" color="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
        Enter your name in the field at the top first.
      </AppText>
    ) : null;

  const manual = validateJoinTarget(manualHost, manualPort);
  const empty = hosts.length === 0;
  const showManual = manualOpen || (empty && timedOut) || browseError !== null;
  const permissionProblem = looksLikePermissionDenial(browseError) || looksLikePermissionDenial(error);

  return (
    <Screen testID="screen-wifi" title="Play over Wi-Fi" onBack={onBack} backLabel="Home">
      <View style={styles.block}>
        <AppText variant="heading">Everyone on their own phone</AppText>
        <AppText color="muted">
          {`${MIN_PLAYERS} to ${MAX_PLAYERS} players on the same Wi-Fi network. One phone hosts the game; the others join it. No internet needed.`}
        </AppText>
      </View>

      <TextField
        testID="wifi-name"
        inputRef={nameRef}
        label="Your name"
        placeholder="Name shown to the other players"
        value={prefs.name}
        onChangeText={(name) => {
          change({ name });
          if (nameError) setNameError(null);
          if (nameErrorAt) setNameErrorAt(null);
        }}
        error={nameError}
        maxLength={MAX_NAME_LENGTH}
        autoCapitalize="words"
        autoCorrect={false}
        returnKeyType="done"
      />

      {error ? (
        <Card tone="danger" testID="wifi-error">
          <AppText color="danger" style={styles.bold} accessibilityRole="alert">
            That did not work
          </AppText>
          <AppText variant="caption">{error}</AppText>
        </Card>
      ) : null}

      <Card>
        <AppText variant="title">Host a game</AppText>
        <AppText color="muted">
          Your phone runs the game and scores every clue with its word model. Your game settings are used.
        </AppText>
        <View style={styles.status}>
          <ModelStatus />
        </View>
        <Button
          testID="wifi-host"
          label="Host a game"
          onPress={() => {
            const name = requireName('host');
            if (name !== null) onHost(name);
          }}
        />
      </Card>

      <Card>
        <AppText variant="title">Join a game</AppText>
        {hosts.map((host) => {
          const otherVersion = host.txt.v !== undefined && host.txt.v !== String(PROTOCOL_VERSION);
          return (
            <View key={`${host.name}|${host.host}|${host.port}`} style={[styles.hostRow, { borderColor: colors.border }]}>
              <View style={styles.flex}>
                <AppText variant="bodyLarge" style={styles.bold}>
                  {host.name}
                </AppText>
                <AppText variant="caption" color="muted">
                  {describeHost(host)}
                </AppText>
                {otherVersion ? <Chip tone="warning" label="Different app version" /> : null}
              </View>
              <Button
                compact
                testID={`join-${host.name}`}
                label="Join"
                accessibilityLabel={`Join ${host.name}`}
                onPress={() => {
                  const name = requireName('list');
                  if (name !== null) onJoin({ host: host.host, port: host.port }, name, host.name);
                }}
              />
            </View>
          );
        })}

        {nameReminder('list')}

        {empty && !timedOut && browseError === null ? (
          <View testID="wifi-searching" style={styles.searching} accessible accessibilityLiveRegion="polite">
            <ActivityIndicator size="small" color={colors.accent} />
            <AppText color="muted" style={styles.flex}>
              Looking for games on this Wi-Fi...
            </AppText>
          </View>
        ) : null}

        {empty && timedOut && browseError === null ? (
          <View testID="wifi-empty" style={styles.block}>
            <AppText style={styles.bold} accessibilityRole="alert">
              No games found yet
            </AppText>
            <AppText variant="caption" color="muted">
              Both phones must be on the same Wi-Fi network (not mobile data), and the host must have its lobby open.
              Some guest and public networks stop phones from seeing each other. The search keeps running - or type in
              the address shown on the host's lobby screen below.
            </AppText>
          </View>
        ) : null}

        {browseError !== null ? (
          <View testID="wifi-browse-error" style={styles.block}>
            <AppText color="danger" style={styles.bold} accessibilityRole="alert">
              Searching for games failed
            </AppText>
            <AppText variant="caption" color="muted">
              {`${browseError}. You can still join with the address shown on the host's lobby screen.`}
            </AppText>
          </View>
        ) : null}

        {permissionProblem ? (
          <Card tone="warning" testID="wifi-permission-help">
            <AppText variant="caption">{permissionHelp(platform)}</AppText>
          </Card>
        ) : null}

        {(empty && timedOut) || browseError !== null ? (
          <View style={styles.block}>
            <Button
              compact
              variant="secondary"
              testID="wifi-search-again"
              label="Search again"
              onPress={() => setSearchRound((n) => n + 1)}
            />
            {platform === 'android' ? (
              <Button
                compact
                variant="secondary"
                testID="wifi-alt-discovery"
                label={embedded ? 'Use standard discovery' : 'Try alternative discovery'}
                accessibilityHint="Searches with a different discovery method, which works better on some phones"
                onPress={() => setEmbedded((on) => !on)}
              />
            ) : null}
          </View>
        ) : null}

        {showManual ? (
          <View testID="wifi-manual" style={styles.block}>
            <AppText variant="label" color="muted">
              Join by address
            </AppText>
            <TextField
              testID="manual-host"
              label="Host IP address"
              placeholder="192.168.1.20"
              value={manualHost}
              onChangeText={setManualHost}
              error={manualTried ? manual.hostError : null}
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={24}
            />
            <TextField
              testID="manual-port"
              label="Port"
              placeholder="e.g. 40123"
              value={manualPort}
              onChangeText={setManualPort}
              error={manualTried ? manual.portError : null}
              keyboardType="number-pad"
              maxLength={5}
            />
            <Button
              testID="manual-join"
              variant="secondary"
              label="Join by address"
              onPress={() => {
                setManualTried(true);
                if (!manual.ok) return;
                const name = requireName('manual');
                if (name !== null) onJoin(manual.target, name, `${manual.target.host}:${manual.target.port}`);
              }}
            />
            {nameReminder('manual')}
          </View>
        ) : (
          <Button
            compact
            variant="ghost"
            testID="wifi-manual-toggle"
            label="Enter the host's address instead"
            onPress={() => setManualOpen(true)}
          />
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  status: { alignItems: 'flex-start' },
  hostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searching: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48 },
  bold: { fontWeight: '700' },
  flex: { flex: 1 },
});
