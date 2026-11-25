import type { ReactNode } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MAX_CONTENT_WIDTH, spacing, useTheme } from '../theme';
import { AppText } from './AppText';
import { Button } from './Button';

export interface ScreenProps {
  /** Shown in the header bar. */
  title?: string;
  /** Adds a header button on the left. */
  onBack?: () => void;
  backLabel?: string;
  /** Header content on the right (e.g. a "Scores" button). */
  headerRight?: ReactNode;
  /**
   * Pinned below the scrolling content and lifted above the keyboard. Put the
   * input and its submit button here so the keyboard can never cover them.
   */
  footer?: ReactNode;
  /** Vertically centre the content when it is shorter than the screen. */
  centered?: boolean;
  children?: ReactNode;
  testID?: string;
}

/**
 * Page scaffold: safe-area padding, optional header, scrolling body and a
 * footer that stays above the keyboard on both platforms.
 *
 * KeyboardAvoidingView with behavior="padding" measures its own overlap with
 * the keyboard, so it stays correct whether or not the Android window is also
 * resized by the system.
 */
export function Screen({ title, onBack, backLabel = 'Back', headerRight, footer, centered, children, testID }: ScreenProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const hasHeader = title !== undefined || onBack !== undefined || headerRight !== undefined;

  return (
    <View
      testID={testID}
      style={[
        styles.root,
        { backgroundColor: colors.bg, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right },
      ]}
    >
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        {hasHeader ? (
          <View style={styles.header}>
            <View style={styles.headerSide}>
              {onBack ? <Button compact variant="ghost" label={backLabel} onPress={onBack} /> : null}
            </View>
            <View style={styles.headerTitle}>
              {title !== undefined ? (
                <AppText variant="bodyLarge" center numberOfLines={2} style={styles.headerTitleText}>
                  {title}
                </AppText>
              ) : null}
            </View>
            <View style={[styles.headerSide, styles.headerRight]}>{headerRight}</View>
          </View>
        ) : null}
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.content, centered && styles.centered, !footer && { paddingBottom: spacing.xl + insets.bottom }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.column}>{children}</View>
        </ScrollView>
        {footer ? (
          <View
            style={[
              styles.footer,
              {
                backgroundColor: colors.bg,
                borderTopColor: colors.border,
                paddingBottom: Math.max(insets.bottom, spacing.lg),
              },
            ]}
          >
            <View style={styles.column}>{footer}</View>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: spacing.sm,
  },
  headerSide: { minWidth: 88, alignItems: 'flex-start' },
  headerRight: { alignItems: 'flex-end' },
  headerTitle: { flex: 1, paddingHorizontal: spacing.xs },
  headerTitleText: { fontWeight: '800' },
  content: { flexGrow: 1, padding: spacing.lg, paddingBottom: spacing.xl },
  centered: { justifyContent: 'center' },
  column: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center', gap: spacing.lg },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
});
