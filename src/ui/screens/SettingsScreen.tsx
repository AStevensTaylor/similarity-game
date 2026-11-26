import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  DEFAULT_SETTINGS,
  MAX_THRESHOLD,
  MAX_TURNS_PER_PLAYER,
  MIN_THRESHOLD,
  MIN_TURNS_PER_PLAYER,
  type GuessMode,
} from '../../game';
import {
  CALIBRATION_INFO,
  LINK_RAW_FLOOR,
  RAW_GATE,
  rawForScore,
  runSelfCheck,
  useSimilarity,
  type SelfCheckReport,
} from '../../similarity';
import { AppText, Button, Card, Chip, Screen, Segmented, Stepper, ToggleRow } from '../components';
import { formatRaw, formatScore, formatThreshold, pluralize, stepThreshold } from '../format';
import { useSettings } from '../SettingsContext';
import { spacing } from '../theme';

const GUESS_MODES: readonly { value: GuessMode; label: string }[] = [
  { value: 'open', label: 'Type any word' },
  { value: 'list', label: 'Pick from the five' },
];

function signed(delta: number): string {
  const text = formatRaw(Math.abs(delta));
  return delta < 0 ? `-${text}` : `+${text}`;
}

/** Developer aid: compares the on-device model with the reference numbers used for calibration. */
function SelfCheckSection() {
  const { similarity, status } = useSimilarity();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SelfCheckReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await runSelfCheck({ similarity });
      if (mounted.current) setReport(next);
    } catch (e) {
      if (mounted.current) {
        setReport(null);
        setError(e instanceof Error && e.message ? e.message : 'The self-check could not run.');
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <Card>
      <AppText variant="title">Model self-check</AppText>
      <AppText variant="caption" color="muted">
        {`For developers. Scores a fixed set of word pairs with the model on this device and compares each raw cosine with the reference measured when the score was calibrated (raw gate ${formatRaw(RAW_GATE)}, ${CALIBRATION_INFO.generatedAt}). The app ships a quantised copy of the model, so small differences are expected.`}
      </AppText>
      <Button
        testID="run-self-check"
        variant="secondary"
        label={busy ? 'Running...' : status === 'error' ? 'Run self-check (model not loaded)' : 'Run self-check'}
        loading={busy}
        onPress={() => void run()}
      />
      {error ? (
        <AppText variant="caption" color="danger" accessibilityRole="alert">
          {`Self-check failed: ${error}`}
        </AppText>
      ) : null}
      {report ? (
        <View testID="self-check-report" style={styles.block} accessibilityLiveRegion="polite">
          <Chip
            tone={report.gateFlips === 0 ? 'success' : 'danger'}
            label={
              report.gateFlips === 0
                ? 'No pair changed sides of the gate'
                : `${pluralize(report.gateFlips, 'pair')} changed sides of the gate`
            }
          />
          <AppText variant="caption">
            {`Mean drift ${formatRaw(report.meanAbsDelta)}, largest drift ${formatRaw(report.maxAbsDelta)} (raw cosine, absolute).`}
          </AppText>
          {report.pairs.map((pair) => (
            <View
              key={`${pair.a}/${pair.b}`}
              accessible
              accessibilityLabel={`${pair.a} and ${pair.b}: raw ${formatRaw(pair.raw)}, reference ${formatRaw(pair.expectedRaw)}, drift ${signed(pair.delta)}${pair.gateFlipped ? ', changed sides of the gate' : ''}`}
              style={styles.pairRow}
            >
              <View style={styles.flex}>
                <AppText style={styles.bold}>{`${pair.a} / ${pair.b}`}</AppText>
                <AppText variant="caption" color="muted">
                  {`raw ${formatRaw(pair.raw)} - reference ${formatRaw(pair.expectedRaw)} - score ${formatScore(pair.score)}`}
                </AppText>
              </View>
              <AppText color={pair.gateFlipped ? 'danger' : 'muted'} style={styles.bold}>
                {signed(pair.delta)}
              </AppText>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

export interface SettingsScreenProps {
  onBack: () => void;
}

export function SettingsScreen({ onBack }: SettingsScreenProps) {
  const { settings, update, reset } = useSettings();
  const isDefault =
    settings.threshold === DEFAULT_SETTINGS.threshold &&
    settings.turnsPerPlayer === DEFAULT_SETTINGS.turnsPerPlayer &&
    settings.guessMode === DEFAULT_SETTINGS.guessMode &&
    settings.requireDictionaryNoun === DEFAULT_SETTINGS.requireDictionaryNoun &&
    settings.useWordLinks === DEFAULT_SETTINGS.useWordLinks;

  return (
    <Screen testID="screen-settings" title="Settings" onBack={onBack} backLabel="Home">
      <AppText variant="caption" color="muted">
        Changes are saved automatically and apply to the next game you start.
      </AppText>

      <Card>
        <AppText variant="title">Clue threshold</AppText>
        <AppText variant="caption" color="muted">
          The calibrated similarity score a clue must reach to be accepted. Higher means clues must be closer to the
          secret word.
        </AppText>
        <Stepper
          testID="threshold"
          label="Clue threshold"
          valueText={formatThreshold(settings.threshold)}
          canDecrement={settings.threshold > MIN_THRESHOLD}
          canIncrement={settings.threshold < MAX_THRESHOLD}
          onDecrement={() => update({ threshold: stepThreshold(settings.threshold, -1, MIN_THRESHOLD, MAX_THRESHOLD) })}
          onIncrement={() => update({ threshold: stepThreshold(settings.threshold, 1, MIN_THRESHOLD, MAX_THRESHOLD) })}
        />
        <AppText testID="threshold-raw" variant="caption" color="muted">
          {`Equals a raw cosine of ${formatRaw(rawForScore(settings.threshold))} or more. Range ${formatThreshold(MIN_THRESHOLD)} to ${formatThreshold(MAX_THRESHOLD)}; the default is ${formatThreshold(DEFAULT_SETTINGS.threshold)}.`}
        </AppText>
      </Card>

      <Card>
        <AppText variant="title">Guessing</AppText>
        <Segmented
          label="Guess mode"
          options={GUESS_MODES}
          value={settings.guessMode}
          onChange={(guessMode) => update({ guessMode })}
        />
        <AppText variant="caption" color="muted">
          {settings.guessMode === 'open'
            ? 'Guessers type any word and never see the five options. Harder.'
            : 'Guessers see the five options the clue-giver chose from and tap one. Easier.'}
        </AppText>
      </Card>

      <Card>
        <AppText variant="title">Turns per player</AppText>
        <AppText variant="caption" color="muted">
          How many times each player is the clue-giver before the game ends.
        </AppText>
        <Stepper
          testID="turns"
          label="Turns per player"
          valueText={`${settings.turnsPerPlayer}`}
          canDecrement={settings.turnsPerPlayer > MIN_TURNS_PER_PLAYER}
          canIncrement={settings.turnsPerPlayer < MAX_TURNS_PER_PLAYER}
          onDecrement={() => update({ turnsPerPlayer: settings.turnsPerPlayer - 1 })}
          onIncrement={() => update({ turnsPerPlayer: settings.turnsPerPlayer + 1 })}
        />
      </Card>

      <Card>
        <ToggleRow
          label="Clues must be dictionary nouns"
          description="Only accept clues found in the built-in list of about 32,000 nouns. Turn off to allow any single word."
          value={settings.requireDictionaryNoun}
          onValueChange={(requireDictionaryNoun) => update({ requireDictionaryNoun })}
        />
      </Card>

      <Card>
        <ToggleRow
          label="Accept linked words"
          description={`Also accept a clue below the threshold when a dictionary (WordNet or ConceptNet) links it to the secret word, such as "root" (part of a tree) or "lock" (goes with key). The model still has to see some connection: a raw cosine of at least ${formatRaw(LINK_RAW_FLOOR)}.`}
          value={settings.useWordLinks}
          onValueChange={(useWordLinks) => update({ useWordLinks })}
        />
      </Card>

      <Button variant="ghost" label="Reset to defaults" disabled={isDefault} onPress={reset} />

      <SelfCheckSection />
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  pairRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  bold: { fontWeight: '700' },
  flex: { flex: 1 },
});
