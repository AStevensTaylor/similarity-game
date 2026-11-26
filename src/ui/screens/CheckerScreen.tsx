import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { cluePasses } from '../../game';
import { useSimilarity } from '../../similarity';
import { addCheck, type CheckEntry } from '../checkHistory';
import { AppText, Button, Card, Chip, ScoreMeter, Screen, TextField, type TextFieldHandle } from '../components';
import { describeLink, formatLinkSources, formatRaw, formatScore, formatThreshold } from '../format';
import { useSettings } from '../SettingsContext';
import { spacing } from '../theme';
import { ModelStatus } from './HomeScreen';

export interface CheckerScreenProps {
  onBack: () => void;
  /** Kept by the app so the history survives leaving and re-entering the screen. */
  history: readonly CheckEntry[];
  onHistoryChange: (history: CheckEntry[]) => void;
}

/** Outside of a game: compare any two words and see exactly what the model says. */
export function CheckerScreen({ onBack, history, onHistoryChange }: CheckerScreenProps) {
  const { similarity, status } = useSimilarity();
  const { settings } = useSettings();
  const threshold = settings.threshold;
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckEntry | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const secondInput = useRef<TextFieldHandle>(null);
  const historyRef = useRef(history);
  historyRef.current = history;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const wordA = a.trim().toLowerCase();
  const wordB = b.trim().toLowerCase();
  const canCheck = wordA.length > 0 && wordB.length > 0;

  const check = async () => {
    if (busyRef.current || !canCheck) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const { raw, score, link } = await similarity(wordA, wordB);
      if (!Number.isFinite(raw) || !Number.isFinite(score)) throw new Error('the model returned an invalid score');
      const entry: CheckEntry = link
        ? { id: Date.now(), a: wordA, b: wordB, raw, score, link }
        : { id: Date.now(), a: wordA, b: wordB, raw, score };
      onHistoryChange(addCheck(historyRef.current, entry));
      if (mounted.current) setResult(entry);
    } catch (e) {
      if (mounted.current) {
        const detail = e instanceof Error && e.message ? ` (${e.message})` : '';
        setError(`The word model could not compare those words${detail}.`);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const wouldPass = (e: CheckEntry) => cluePasses(settings, e.score, e.link);
  const passes = result !== null && wouldPass(result);
  /** True when only the word link (not the score) makes the pair pass. */
  const passesByLink = result !== null && passes && result.score < threshold;

  return (
    <Screen
      testID="screen-checker"
      title="Similarity checker"
      onBack={onBack}
      backLabel="Home"
      footer={
        <View style={styles.block}>
          {error ? (
            <AppText variant="caption" color="danger" accessibilityRole="alert">
              {error}
            </AppText>
          ) : null}
          <Button
            testID="check"
            label={busy ? (status === 'loading' ? 'Loading the word model...' : 'Comparing...') : 'Compare'}
            loading={busy}
            disabled={!canCheck}
            onPress={() => void check()}
          />
        </View>
      }
    >
      <ModelStatus />
      <View style={styles.block}>
        <TextField
          testID="checker-a"
          label="First word"
          placeholder="e.g. ocean"
          value={a}
          onChangeText={setA}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={40}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => secondInput.current?.focus()}
        />
        <TextField
          inputRef={secondInput}
          testID="checker-b"
          label="Second word"
          placeholder="e.g. sea"
          value={b}
          onChangeText={setB}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={40}
          returnKeyType="go"
          submitBehavior="submit"
          onSubmitEditing={() => void check()}
        />
      </View>

      {result ? (
        <Card testID="checker-result" accessibilityLiveRegion="polite">
          <AppText variant="label" color="muted">
            {`${result.a} / ${result.b}`}
          </AppText>
          <View style={styles.resultRow}>
            <View style={styles.flex}>
              <AppText testID="checker-score" variant="display" accessibilityLabel={`Calibrated score ${formatScore(result.score)}`}>
                {formatScore(result.score)}
              </AppText>
              <AppText variant="caption" color="muted">
                calibrated score
              </AppText>
            </View>
            <View style={styles.rawBox}>
              <AppText testID="checker-raw" variant="title" accessibilityLabel={`Raw cosine ${formatRaw(result.raw)}`}>
                {formatRaw(result.raw)}
              </AppText>
              <AppText variant="caption" color="muted">
                raw cosine
              </AppText>
            </View>
          </View>
          <ScoreMeter score={result.score} threshold={threshold} />
          <Chip
            tone={passes ? 'success' : 'danger'}
            label={
              passesByLink
                ? 'Would pass as a clue: the words are linked'
                : passes
                  ? `Would pass as a clue at ${formatThreshold(threshold)}`
                  : `Would not pass as a clue at ${formatThreshold(threshold)}`
            }
          />
          {result.link ? (
            <AppText testID="checker-link" variant="caption">
              {`Word link: ${describeLink(result.link)} (${formatLinkSources(result.link)}).${
                settings.useWordLinks ? '' : ' Word links are turned off in Settings, so it does not count.'
              }`}
            </AppText>
          ) : null}
          <AppText variant="caption" color="muted">
            The calibrated score is a fixed rescaling of the raw BERT cosine. A clue below the threshold also passes when a
            dictionary links the two words (word links, in Settings). In a game a clue must also follow the word rules
            (single dictionary noun, not a form of the five offered words), which this checker does not apply.
          </AppText>
        </Card>
      ) : (
        <AppText color="muted">
          Compare any two words to see the score the game would give them. Threshold right now:{' '}
          {formatThreshold(threshold)}.
        </AppText>
      )}

      {history.length > 0 ? (
        <View style={styles.block}>
          <AppText variant="label" color="muted">
            Recent checks
          </AppText>
          {history.map((entry) => (
            <Card
              key={entry.id}
              accessible
              accessibilityLabel={`${entry.a} and ${entry.b}: score ${formatScore(entry.score)}, raw cosine ${formatRaw(entry.raw)}, ${
                wouldPass(entry) ? 'would pass' : 'would not pass'
              }`}
              style={styles.historyRow}
            >
              <View style={styles.flex}>
                <AppText style={styles.bold}>{`${entry.a} / ${entry.b}`}</AppText>
                <AppText variant="caption" color="muted">{`raw cosine ${formatRaw(entry.raw)}${
                  entry.link ? ` - linked: ${entry.link.relation}` : ''
                }`}</AppText>
              </View>
              <AppText variant="title" color={wouldPass(entry) ? 'success' : 'text'}>
                {formatScore(entry.score)}
              </AppText>
            </Card>
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.md },
  resultRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.lg },
  rawBox: { alignItems: 'flex-end' },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  bold: { fontWeight: '700' },
  flex: { flex: 1 },
});
