import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { isNoun } from '../../data/nouns';
import {
  FORFEIT_AFTER_REJECTIONS,
  GIVER_REWARDS,
  MAX_CLUE_LENGTH,
  MAX_CLUE_ROUNDS,
  canForfeit,
  currentGiver,
  giverRewardIfRoundFails,
  rejectionsUntilForfeit,
} from '../../game';
import { useSimilarity } from '../../similarity';
import { AppText, Button, Card, TextField } from '../components';
import { formatPoints, formatScore, formatThreshold, pluralize } from '../format';
import { spacing } from '../theme';
import { attemptClue } from './clueAttempt';
import { CluesGivenSoFar, OffLimitsWords, RejectedAttempts, SecretWordCard } from './parts';
import { GameFrame, type PhaseProps } from './shared';

/** Scoring failures in a row after which the model is treated as broken. */
export const SCORE_ERRORS_BEFORE_ESCAPE = 2;
/** How long one scoring call may hang before the way out is offered. */
export const SLOW_SCORING_MS = 15000;

type Feedback = { tone: 'danger' | 'warning'; text: string } | null;

/**
 * Private to the giver: shows the hidden word, earlier accepted clues, this
 * round's rejected attempts with their scores, and the clue input.
 */
export function ClueScreen({ state, dispatch, onQuit, onShowScores, onEndGame }: PhaseProps) {
  const { status, error: modelError, retry, similarity } = useSimilarity();
  const giver = currentGiver(state);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Model failures are not rejections, so they never unlock "forfeit". Count
  // them separately so a broken model still leaves a way out that keeps scores.
  const [scoreErrors, setScoreErrors] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_SCORING_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  // A ref as well as state: two taps in the same frame must not both get through.
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await attemptClue(text, state, { similarity, isNoun });
      if (!mounted.current) return;
      if (result.kind === 'invalid') {
        setFeedback({ tone: 'warning', text: result.message });
      } else if (result.kind === 'error') {
        setScoreErrors((count) => count + 1);
        setFeedback({ tone: 'danger', text: result.message });
      } else {
        setScoreErrors(0);
        if (!result.accepted) {
          // The input stays editable while scoring: only clear it if it was not changed meanwhile.
          setText((current) => (current === text ? '' : current));
          setFeedback({
            tone: 'danger',
            text: `"${result.clue}" scored ${formatScore(result.score)} - not close enough. Try another clue.`,
          });
        }
        dispatch(result.action);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [dispatch, similarity, state, text]);

  const confirmForfeit = useCallback(() => {
    Alert.alert(
      'Forfeit this turn?',
      'The turn ends and the word is revealed. Nobody earns any more points this turn.',
      [
        { text: 'Keep trying', style: 'cancel' },
        { text: 'Forfeit', style: 'destructive', onPress: () => dispatch({ type: 'FORFEIT_TURN' }) },
      ],
    );
  }, [dispatch]);

  const confirmEndGame = useCallback(() => {
    Alert.alert(
      'End the game now?',
      'This turn is abandoned and the final scores are shown. Points already earned are kept.',
      [
        { text: 'Keep trying', style: 'cancel' },
        { text: 'End game', style: 'destructive', onPress: () => onEndGame?.() },
      ],
    );
  }, [onEndGame]);

  if (state.hiddenWord === null) return null;
  const modelStuck = status === 'error' || scoreErrors >= SCORE_ERRORS_BEFORE_ESCAPE || (busy && slow);
  const threshold = state.settings.threshold;
  const remaining = rejectionsUntilForfeit(state);

  return (
    <GameFrame
      testID="phase-clue"
      state={state}
      onQuit={onQuit}
      onShowScores={onShowScores}
      footer={
        <View style={styles.footer}>
          {feedback ? (
            <AppText
              testID="clue-feedback"
              variant="caption"
              color={feedback.tone}
              accessibilityLiveRegion="polite"
              accessibilityRole="alert"
            >
              {feedback.text}
            </AppText>
          ) : null}
          <TextField
            testID="clue-input"
            label={`Clue ${state.clueRound} of ${MAX_CLUE_ROUNDS}`}
            placeholder="One noun"
            value={text}
            onChangeText={(value) => {
              setText(value);
              if (feedback) setFeedback(null);
            }}
            secretWord
            maxLength={MAX_CLUE_LENGTH + 10}
            returnKeyType="send"
            submitBehavior="submit"
            onSubmitEditing={() => void submit()}
          />
          <Button
            testID="submit-clue"
            label={busy ? (status === 'loading' ? 'Loading the word model...' : 'Scoring...') : 'Submit clue'}
            loading={busy}
            disabled={text.trim().length === 0}
            onPress={() => void submit()}
          />
        </View>
      }
    >
      <View style={styles.block}>
        <AppText variant="label" color="accent">
          {`For ${giver.name}'s eyes only`}
        </AppText>
        <SecretWordCard word={state.hiddenWord} />
        <AppText color="muted">
          {`Type a single noun. It is accepted when its similarity score reaches ${formatThreshold(threshold)}. If nobody guesses the word this round, your total for the turn becomes ${formatPoints(giverRewardIfRoundFails(state))} (${GIVER_REWARDS.join(', ')} for rounds 1 to ${MAX_CLUE_ROUNDS}).`}
        </AppText>
      </View>

      {status === 'error' ? (
        <Card tone="danger">
          <AppText color="danger" style={styles.bold}>
            The word model failed to load.
          </AppText>
          {modelError ? <AppText variant="caption">{modelError}</AppText> : null}
          <Button compact variant="secondary" label="Retry loading the model" onPress={retry} />
        </Card>
      ) : null}
      {status === 'loading' ? (
        <Card tone="muted">
          <AppText variant="caption" color="muted">
            The word model is still loading. Your first clue is scored as soon as it is ready.
          </AppText>
        </Card>
      ) : null}

      {modelStuck && onEndGame ? (
        <Card tone="warning" testID="model-stuck">
          <AppText color="warning" style={styles.bold}>
            Clues cannot be scored right now
          </AppText>
          <AppText variant="caption">
            The word model is not working, so no clue can be accepted and forfeiting never unlocks. You can keep
            trying, or end the game here: the final scores are shown with every point earned so far.
          </AppText>
          <Button testID="end-game" variant="secondary" label="End game and show scores" onPress={confirmEndGame} />
        </Card>
      ) : null}

      <OffLimitsWords options={state.options} hiddenWord={state.hiddenWord} />

      <CluesGivenSoFar rounds={state.rounds} />

      <RejectedAttempts rejected={state.rejectedThisRound} threshold={threshold} />

      <View style={styles.block}>
        {canForfeit(state) ? (
          <Card tone="warning">
            <AppText color="warning" style={styles.bold}>
              Stuck?
            </AppText>
            <AppText variant="caption">
              You can keep trying, or forfeit: the turn ends, the word is revealed and nobody earns any more points this
              turn.
            </AppText>
            <Button testID="forfeit" variant="danger" label="Forfeit turn" disabled={busy} onPress={confirmForfeit} />
          </Card>
        ) : (
          <AppText variant="caption" color="muted">
            {`Forfeiting the turn becomes available after ${pluralize(remaining, 'more rejected clue')} (${FORFEIT_AFTER_REJECTIONS} in one round).`}
          </AppText>
        )}
      </View>
    </GameFrame>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  footer: { gap: spacing.sm },
  bold: { fontWeight: '700' },
});
