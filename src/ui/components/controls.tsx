/** Small form controls used by the settings and setup screens. */
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { TAP_TARGET, radius, spacing, useTheme } from '../theme';
import { AppText } from './AppText';

export interface StepperProps {
  /** What is being adjusted, e.g. "Threshold" (used for accessibility). */
  label: string;
  /** The current value as shown, e.g. "0.95". */
  valueText: string;
  onDecrement: () => void;
  onIncrement: () => void;
  canDecrement: boolean;
  canIncrement: boolean;
  /** The two buttons get `${testID}-dec` and `${testID}-inc`. */
  testID?: string;
}

export function Stepper({ label, valueText, onDecrement, onIncrement, canDecrement, canIncrement, testID }: StepperProps) {
  const { colors } = useTheme();
  const button = (symbol: string, a11y: string, onPress: () => void, enabled: boolean, id?: string) => (
    <Pressable
      testID={id}
      onPress={enabled ? onPress : undefined}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={`${a11y} ${label}`}
      accessibilityState={{ disabled: !enabled }}
      style={({ pressed }) => [
        styles.stepButton,
        { backgroundColor: pressed ? colors.surfaceAlt : colors.accentSoft, opacity: enabled ? 1 : 0.4 },
      ]}
    >
      <AppText style={[styles.stepSymbol, { color: colors.onAccentSoft }]}>{symbol}</AppText>
    </Pressable>
  );
  return (
    <View style={styles.stepper}>
      {button('−', 'Decrease', onDecrement, canDecrement, testID && `${testID}-dec`)}
      <AppText
        variant="title"
        center
        style={styles.stepValue}
        accessibilityLabel={`${label}: ${valueText}`}
        accessibilityLiveRegion="polite"
        accessibilityRole="text"
      >
        {valueText}
      </AppText>
      {button('+', 'Increase', onIncrement, canIncrement, testID && `${testID}-inc`)}
    </View>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function Segmented<T extends string>({ label, options, value, onChange }: SegmentedProps<T>) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[styles.segmented, { backgroundColor: colors.surfaceAlt }]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={option.label}
            style={[styles.segment, selected && { backgroundColor: colors.accent }]}
          >
            <AppText center style={[styles.segmentText, { color: selected ? colors.onAccent : colors.text }]}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface ToggleRowProps {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}

export function ToggleRow({ label, description, value, onValueChange }: ToggleRowProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleText}>
        <AppText variant="bodyLarge" style={styles.bold}>
          {label}
        </AppText>
        {description ? (
          <AppText variant="caption" color="muted">
            {description}
          </AppText>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        accessibilityLabel={label}
        accessibilityHint={description}
        trackColor={{ false: colors.border, true: colors.accent }}
        style={styles.switch}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepButton: {
    width: TAP_TARGET + 4,
    minHeight: TAP_TARGET + 4,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepSymbol: { fontSize: 26, lineHeight: 30, fontWeight: '800' },
  stepValue: { flex: 1 },
  segmented: { flexDirection: 'row', borderRadius: radius.md, padding: spacing.xs, gap: spacing.xs },
  segment: {
    flex: 1,
    minHeight: TAP_TARGET,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  segmentText: { fontWeight: '800' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: TAP_TARGET },
  toggleText: { flex: 1, gap: 2 },
  bold: { fontWeight: '700' },
  switch: { minHeight: TAP_TARGET },
});
