import type { ComponentProps, ComponentRef, Ref } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { TAP_TARGET, fontSize, radius, spacing, useTheme } from '../theme';
import { AppText } from './AppText';

/** The instance type a ref to the underlying input receives. */
export type TextFieldHandle = ComponentRef<typeof TextInput>;

export interface TextFieldProps extends Omit<ComponentProps<typeof TextInput>, 'style' | 'ref'> {
  /** Ref to the underlying TextInput (e.g. to move focus). */
  inputRef?: Ref<TextFieldHandle>;
  label: string;
  /** Hide the visible label (it is still the accessibility label). */
  hideLabel?: boolean;
  error?: string | null;
  /**
   * For secret words typed on a shared phone: turns off autocorrect,
   * suggestions and autofill so the keyboard cannot show another player what
   * was typed before.
   */
  secretWord?: boolean;
}

export function TextField({ label, hideLabel, error, secretWord, editable = true, inputRef, ...rest }: TextFieldProps) {
  const { colors, dark } = useTheme();
  const secretProps: TextInputProps = secretWord
    ? {
        autoCapitalize: 'none',
        autoCorrect: false,
        spellCheck: false,
        autoComplete: 'off',
        importantForAutofill: 'no',
        textContentType: 'none',
        // On Android this is the keyboard type that reliably has no suggestion strip.
        keyboardType: Platform.OS === 'android' ? 'visible-password' : 'default',
      }
    : {};
  return (
    <View style={styles.wrap}>
      {hideLabel ? null : (
        <AppText variant="label" color="muted">
          {label}
        </AppText>
      )}
      <TextInput
        ref={inputRef}
        accessibilityLabel={label}
        accessibilityHint={error ?? undefined}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.accent}
        keyboardAppearance={dark ? 'dark' : 'light'}
        editable={editable}
        {...secretProps}
        {...rest}
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.surface,
            borderColor: error ? colors.danger : colors.border,
            opacity: editable ? 1 : 0.6,
          },
        ]}
      />
      {error ? (
        <AppText variant="caption" color="danger" accessibilityLiveRegion="polite" accessibilityRole="alert">
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs, alignSelf: 'stretch' },
  input: {
    minHeight: TAP_TARGET + 4,
    borderWidth: 2,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: fontSize.bodyLarge,
    fontWeight: '600',
  },
});
