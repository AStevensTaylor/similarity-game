import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { radius, spacing, useTheme } from '../theme';

export type CardTone = 'surface' | 'accent' | 'success' | 'danger' | 'warning' | 'muted';

export interface CardProps extends ViewProps {
  tone?: CardTone;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export function Card({ tone = 'surface', style, children, ...rest }: CardProps) {
  const { colors } = useTheme();
  const bg = {
    surface: colors.surface,
    accent: colors.accentSoft,
    success: colors.successSoft,
    danger: colors.dangerSoft,
    warning: colors.warningSoft,
    muted: colors.surfaceAlt,
  }[tone];
  return (
    <View
      {...rest}
      style={[
        styles.card,
        { backgroundColor: bg, borderColor: tone === 'surface' ? colors.border : 'transparent' },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.lg, gap: spacing.sm },
});
