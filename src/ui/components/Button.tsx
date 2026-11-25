import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { TAP_TARGET, fontSize, radius, spacing, useTheme } from '../theme';
import { AppText } from './AppText';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Shows a spinner, blocks presses and announces "busy". */
  loading?: boolean;
  /** Smaller, content-width button for headers and inline actions. */
  compact?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  compact = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: ButtonProps) {
  const { colors } = useTheme();
  const blocked = disabled || loading;

  const palette = {
    primary: { bg: colors.accent, pressed: colors.accentPressed, edge: colors.accentEdge, fg: colors.onAccent },
    secondary: { bg: colors.accentSoft, pressed: colors.surfaceAlt, edge: colors.border, fg: colors.onAccentSoft },
    ghost: { bg: 'transparent', pressed: colors.surfaceAlt, edge: 'transparent', fg: colors.accent },
    danger: { bg: colors.dangerSoft, pressed: colors.surfaceAlt, edge: colors.border, fg: colors.danger },
  }[variant];

  return (
    <Pressable
      testID={testID}
      onPress={blocked ? undefined : onPress}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: blocked, busy: loading }}
      hitSlop={compact ? 6 : undefined}
      style={({ pressed }) => [
        styles.base,
        compact ? styles.compact : styles.full,
        {
          backgroundColor: pressed ? palette.pressed : palette.bg,
          borderBottomColor: palette.edge,
          borderBottomWidth: variant === 'ghost' || compact ? 0 : pressed ? 2 : 4,
          marginTop: variant === 'ghost' || compact ? 0 : pressed ? 2 : 0,
          opacity: blocked && !loading ? 0.45 : 1,
        },
        style,
      ]}
    >
      <View style={styles.content}>
        {loading ? <ActivityIndicator color={palette.fg} style={styles.spinner} /> : null}
        <AppText style={[styles.label, compact && styles.compactLabel, { color: palette.fg }]}>{label}</AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: TAP_TARGET,
    borderRadius: radius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  full: { minHeight: 56, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, alignSelf: 'stretch' },
  compact: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minWidth: TAP_TARGET },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  spinner: { marginRight: spacing.sm },
  label: { fontSize: fontSize.bodyLarge, lineHeight: 24, fontWeight: '800', textAlign: 'center', flexShrink: 1 },
  compactLabel: { fontSize: fontSize.body },
});
