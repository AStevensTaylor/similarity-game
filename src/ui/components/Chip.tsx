import { StyleSheet, View } from 'react-native';

import { radius, spacing, useTheme } from '../theme';
import { AppText } from './AppText';

export type ChipTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning';

export interface ChipProps {
  label: string;
  tone?: ChipTone;
  accessibilityLabel?: string;
}

/** Small, non-interactive pill for statuses and word lists. */
export function Chip({ label, tone = 'neutral', accessibilityLabel }: ChipProps) {
  const { colors } = useTheme();
  const palette = {
    neutral: { bg: colors.surfaceAlt, fg: colors.text },
    accent: { bg: colors.accentSoft, fg: colors.onAccentSoft },
    success: { bg: colors.successSoft, fg: colors.success },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    warning: { bg: colors.warningSoft, fg: colors.warning },
  }[tone];
  return (
    <View style={[styles.chip, { backgroundColor: palette.bg }]}>
      <AppText variant="caption" accessibilityLabel={accessibilityLabel} style={[styles.text, { color: palette.fg }]}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    alignSelf: 'flex-start',
  },
  text: { fontWeight: '700', fontSize: 14, lineHeight: 20 },
});
