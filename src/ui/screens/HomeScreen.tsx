import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useSimilarity } from '../../similarity';
import { AppText, Button, Card, Screen } from '../components';
import { radius, spacing, useTheme } from '../theme';

export interface HomeScreenProps {
  onPlay: () => void;
  onWifi: () => void;
  onChecker: () => void;
  onHowToPlay: () => void;
  onSettings: () => void;
}

/** Shows whether the on-device model is loading, ready or failed (with retry). */
export function ModelStatus() {
  const { colors } = useTheme();
  const { status, error, retry } = useSimilarity();
  if (status === 'error') {
    return (
      <Card tone="danger" testID="model-status-error">
        <AppText color="danger" style={styles.bold} accessibilityRole="alert">
          The word model failed to load
        </AppText>
        <AppText variant="caption">
          {error ?? 'Unknown error.'} Clues and the similarity checker cannot be scored until it loads.
        </AppText>
        <Button compact variant="secondary" label="Try again" onPress={retry} />
      </Card>
    );
  }
  const ready = status === 'ready';
  return (
    <View
      testID={ready ? 'model-status-ready' : 'model-status-loading'}
      accessible
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={ready ? 'Word model ready' : 'Loading the word model'}
      style={[styles.statusPill, { backgroundColor: ready ? colors.successSoft : colors.surfaceAlt }]}
    >
      {ready ? (
        <View style={[styles.dot, { backgroundColor: colors.success }]} />
      ) : (
        <ActivityIndicator size="small" color={colors.accent} />
      )}
      <AppText variant="caption" style={{ color: ready ? colors.success : colors.textMuted }}>
        {ready ? 'Word model ready' : 'Loading the word model...'}
      </AppText>
    </View>
  );
}

export function HomeScreen({ onPlay, onWifi, onChecker, onHowToPlay, onSettings }: HomeScreenProps) {
  const { colors } = useTheme();
  return (
    <Screen testID="screen-home" centered>
      <View style={styles.hero}>
        <View style={styles.logo} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={[styles.bubble, styles.bubbleLeft, { backgroundColor: colors.accent }]} />
          <View style={[styles.bubble, styles.bubbleRight, { backgroundColor: colors.accentSoft, borderColor: colors.accent }]} />
        </View>
        <AppText variant="display" center>
          Similarity Game
        </AppText>
        <AppText variant="bodyLarge" color="muted" center>
          Pick a secret word. Give a clue that is close enough - but not so close that everyone gets it.
        </AppText>
        <View style={styles.statusWrap}>
          <ModelStatus />
        </View>
      </View>
      <View style={styles.menu}>
        <Button
          testID="home-play"
          label="Play on this phone"
          onPress={onPlay}
          accessibilityHint="Pass-and-play: set up players and share one phone"
        />
        <Button
          testID="home-wifi"
          label="Play over Wi-Fi"
          onPress={onWifi}
          accessibilityHint="Everyone plays on their own phone, on the same Wi-Fi network"
        />
        <Button testID="home-checker" variant="secondary" label="Similarity checker" onPress={onChecker} />
        <Button testID="home-how" variant="secondary" label="How to play" onPress={onHowToPlay} />
        <Button testID="home-settings" variant="secondary" label="Settings" onPress={onSettings} />
      </View>
      <AppText variant="caption" color="muted" center>
        For 2 to 8 players: pass one phone around, or everyone on their own phone over Wi-Fi. Works without internet.
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.xl },
  logo: { width: 132, height: 88, marginBottom: spacing.sm },
  bubble: { position: 'absolute', width: 84, height: 84, borderRadius: 42 },
  bubbleLeft: { left: 0, top: 0 },
  bubbleRight: { right: 0, top: 4, borderWidth: 4, opacity: 0.9 },
  statusWrap: { alignSelf: 'stretch', alignItems: 'center', marginTop: spacing.sm },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  menu: { gap: spacing.md, marginTop: spacing.lg },
  bold: { fontWeight: '700' },
});
