import { StyleSheet, View } from 'react-native';

import { formatScore, formatThreshold } from '../format';
import { radius, useTheme } from '../theme';

export interface ScoreMeterProps {
  /** Calibrated score in [0, 1]. */
  score: number;
  /** Threshold in [0, 1]; drawn as a tick on the track. */
  threshold: number;
}

/** A bar showing how close a calibrated score is to the acceptance threshold. */
export function ScoreMeter({ score, threshold }: ScoreMeterProps) {
  const { colors } = useTheme();
  const clamped = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
  const passes = clamped >= threshold;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Similarity score ${formatScore(clamped)}, ${
        passes ? 'reaches' : 'below'
      } the threshold of ${formatThreshold(threshold)}`}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={styles.wrap}
    >
      <View style={[styles.track, { backgroundColor: colors.surfaceAlt }]}>
        <View
          style={[
            styles.fill,
            { width: `${clamped * 100}%`, backgroundColor: passes ? colors.success : colors.accent },
          ]}
        />
      </View>
      <View style={[styles.tick, { left: `${threshold * 100}%`, backgroundColor: colors.text }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 20, justifyContent: 'center', alignSelf: 'stretch' },
  track: { height: 10, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { height: 10, borderRadius: radius.pill },
  tick: { position: 'absolute', top: 0, width: 3, height: 20, marginLeft: -1.5, borderRadius: 2 },
});
