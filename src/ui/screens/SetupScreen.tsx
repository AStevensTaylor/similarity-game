import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { MAX_PLAYERS, MIN_PLAYERS } from '../../game';
import { loadPlayers, savePlayers } from '../../storage';
import { AppText, Avatar, Button, Card, Screen, TextField } from '../components';
import { formatThreshold, pluralize } from '../format';
import { MAX_NAME_LENGTH, nextDefaultName, validatePlayerNames } from '../players';
import { useSettings } from '../SettingsContext';
import { spacing, useTheme } from '../theme';

export interface SetupScreenProps {
  onBack: () => void;
  onStart: (playerNames: string[]) => void;
  /** Skips storage and starts from these names (tests). */
  initialNames?: string[];
}

interface Row {
  /** Stable key so removing a row never moves focus or text to another row. */
  key: number;
  name: string;
}

export function SetupScreen({ onBack, onStart, initialNames }: SetupScreenProps) {
  const { colors } = useTheme();
  const { settings } = useSettings();
  const nextKey = useRef(0);
  const toRows = (names: readonly string[]): Row[] => names.map((name) => ({ key: nextKey.current++, name }));
  const [rows, setRows] = useState<Row[] | null>(() => (initialNames ? toRows(initialNames) : null));
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (initialNames) return;
    let alive = true;
    loadPlayers().then((names) => {
      if (alive) setRows((current) => current ?? toRows(names));
    });
    return () => {
      alive = false;
    };
    // Runs once: the stored names are only the starting point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (rows === null) {
    return (
      <Screen title="Players" onBack={onBack} backLabel="Home" centered>
        <ActivityIndicator color={colors.accent} accessibilityLabel="Loading players" />
      </Screen>
    );
  }

  const names = rows.map((row) => row.name);
  const validation = validatePlayerNames(names);

  const change = (next: Row[]) => {
    setRows(next);
    // Remember the list as it is edited, so it survives leaving the screen.
    void savePlayers(next.map((row) => row.name));
  };

  const start = () => {
    if (!validation.ok) {
      setShowErrors(true);
      return;
    }
    void savePlayers(validation.names);
    onStart(validation.names);
  };

  return (
    <Screen
      testID="screen-setup"
      title="Players"
      onBack={onBack}
      backLabel="Home"
      footer={
        <View style={styles.footer}>
          {showErrors && !validation.ok ? (
            <AppText variant="caption" color="danger" accessibilityRole="alert">
              {validation.listError ?? 'Fix the highlighted names to start.'}
            </AppText>
          ) : null}
          <Button testID="start-game" label={`Start game with ${pluralize(rows.length, 'player')}`} onPress={start} />
        </View>
      }
    >
      <View style={styles.block}>
        <AppText variant="heading">Who is playing?</AppText>
        <AppText color="muted">
          {`${MIN_PLAYERS} to ${MAX_PLAYERS} players. The phone is passed around in this order.`}
        </AppText>
      </View>

      <View style={styles.block}>
        {rows.map((row, index) => {
          const error = validation.errors[index];
          // An empty name is only flagged after a start attempt; duplicates are flagged right away.
          const visibleError = error !== null && (showErrors || row.name.trim().length > 0) ? error : null;
          return (
            <View key={row.key} style={styles.row}>
              <View style={styles.avatar}>
                <Avatar name={row.name} index={index} size={44} />
              </View>
              <View style={styles.flex}>
                <TextField
                  testID={`player-name-${index}`}
                  label={`Player ${index + 1} name`}
                  hideLabel
                  placeholder={`Player ${index + 1}`}
                  value={row.name}
                  onChangeText={(name) => change(rows.map((r) => (r.key === row.key ? { ...r, name } : r)))}
                  error={visibleError}
                  maxLength={MAX_NAME_LENGTH}
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="done"
                  selectTextOnFocus
                />
              </View>
              <Button
                compact
                variant="ghost"
                label="Remove"
                accessibilityLabel={`Remove ${row.name.trim() || `player ${index + 1}`}`}
                disabled={rows.length <= MIN_PLAYERS}
                onPress={() => change(rows.filter((r) => r.key !== row.key))}
                style={styles.remove}
              />
            </View>
          );
        })}
        <Button
          testID="add-player"
          variant="secondary"
          label={rows.length >= MAX_PLAYERS ? `Maximum of ${MAX_PLAYERS} players` : 'Add player'}
          disabled={rows.length >= MAX_PLAYERS}
          onPress={() => change([...rows, { key: nextKey.current++, name: nextDefaultName(names) }])}
        />
      </View>

      <Card tone="muted">
        <AppText variant="label" color="muted">
          This game
        </AppText>
        <AppText variant="caption">
          {`${pluralize(settings.turnsPerPlayer, 'turn')} as clue-giver each (${pluralize(
            rows.length * settings.turnsPerPlayer,
            'turn',
          )} in total) - clue threshold ${formatThreshold(settings.threshold)} - ${
            settings.guessMode === 'list' ? 'guessers pick from the five words' : 'guessers type any word'
          }. Change these in Settings.`}
        </AppText>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.md },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  avatar: { paddingTop: 4 },
  remove: { marginTop: 2 },
  footer: { gap: spacing.sm },
  flex: { flex: 1 },
});
