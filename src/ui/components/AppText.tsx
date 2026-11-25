import type { ReactNode } from 'react';
import { StyleSheet, Text, type StyleProp, type TextProps, type TextStyle } from 'react-native';

import { fontSize, useTheme, type ThemeColors } from '../theme';

export type TextVariant = 'display' | 'heading' | 'title' | 'bodyLarge' | 'body' | 'caption' | 'label';
export type TextColor = 'text' | 'muted' | 'accent' | 'onAccent' | 'onAccentSoft' | 'success' | 'danger' | 'warning';

const COLOR_KEYS: Record<TextColor, keyof ThemeColors> = {
  text: 'text',
  muted: 'textMuted',
  accent: 'accent',
  onAccent: 'onAccent',
  onAccentSoft: 'onAccentSoft',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
};

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  color?: TextColor;
  center?: boolean;
  style?: StyleProp<TextStyle>;
  children?: ReactNode;
}

/** All text in the app goes through here so type sizes and colours stay consistent. Font scaling stays on. */
export function AppText({ variant = 'body', color = 'text', center, style, children, ...rest }: AppTextProps) {
  const { colors } = useTheme();
  const isHeader = variant === 'display' || variant === 'heading' || variant === 'title';
  return (
    <Text
      accessibilityRole={isHeader ? 'header' : undefined}
      // Very large display text stops growing a little earlier so it cannot push controls off screen.
      maxFontSizeMultiplier={variant === 'display' ? 1.5 : undefined}
      {...rest}
      style={[styles[variant], { color: colors[COLOR_KEYS[color]] }, center && styles.center, style]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  display: { fontSize: fontSize.display, lineHeight: 46, fontWeight: '900', letterSpacing: -0.5 },
  heading: { fontSize: fontSize.heading, lineHeight: 34, fontWeight: '800', letterSpacing: -0.3 },
  title: { fontSize: fontSize.title, lineHeight: 28, fontWeight: '800' },
  bodyLarge: { fontSize: fontSize.bodyLarge, lineHeight: 26, fontWeight: '500' },
  body: { fontSize: fontSize.body, lineHeight: 24, fontWeight: '400' },
  caption: { fontSize: fontSize.caption, lineHeight: 18, fontWeight: '500' },
  label: { fontSize: fontSize.caption, lineHeight: 18, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  center: { textAlign: 'center' },
});
