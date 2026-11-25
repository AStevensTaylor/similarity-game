import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { currentGiver, currentGuesser, guesserOptions } from '../../game';
import { AppText, Button, TextField } from '../components';
import { spacing } from '../theme';
import { EarlierRounds, LatestClueCard, WordOptions } from './parts';
import { GameFrame, publicPlayers, type PhaseProps } from './shared';

/**
 * Private to one guesser. Shows only public information (the accepted clues
 * and the guesses already revealed in earlier rounds) plus, in 'list' mode,
 * the five options. Never shows this round's other guesses.
 */
export function GuessScreen({ state, dispatch, onQuit, onShowScores }: PhaseProps) {
  const giver = currentGiver(state);
  const guesser = currentGuesser(state);
  const options = guesserOptions(state);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitted = useRef(false);

  if (guesser === null) return null;
  const value = options ? (selected ?? '') : text.trim();

  const submit = () => {
    if (submitted.current) return;
    if (value.length === 0) {
      setError(options ? 'Pick one of the words.' : 'Type your guess first.');
      return;
    }
    submitted.current = true;
    dispatch({ type: 'SUBMIT_GUESS', guess: value });
  };

  const latest = state.acceptedClues[state.acceptedClues.length - 1];

  return (
    <GameFrame
      testID="phase-guess"
      state={state}
      onQuit={onQuit}
      onShowScores={onShowScores}
      footer={
        <View style={styles.footer}>
          {options ? (
            error ? (
              <AppText variant="caption" color="danger" accessibilityRole="alert">
                {error}
              </AppText>
            ) : null
          ) : (
            <TextField
              testID="guess-input"
              label="Your guess"
              placeholder="One word"
              value={text}
              onChangeText={(next) => {
                setText(next);
                if (error) setError(null);
              }}
              error={error}
              secretWord
              maxLength={40}
              returnKeyType="send"
              onSubmitEditing={submit}
            />
          )}
          <Button testID="submit-guess" label="Lock in guess" disabled={value.length === 0} onPress={submit} />
        </View>
      }
    >
      <View style={styles.block}>
        <AppText variant="label" color="accent">
          {`For ${guesser.name}'s eyes only`}
        </AppText>
        <AppText variant="heading">{`What is ${giver.name}'s word?`}</AppText>
      </View>

      {latest ? <LatestClueCard clue={latest.clue} number={state.acceptedClues.length} /> : null}

      <EarlierRounds rounds={state.rounds} players={publicPlayers(state)} />

      {options ? (
        <View style={styles.block}>
          <AppText variant="label" color="muted">
            It is one of these
          </AppText>
          <WordOptions
            options={options}
            selected={selected}
            onSelect={(word) => {
              setSelected(word);
              setError(null);
            }}
            label="Possible words"
            testIDPrefix="guess-option-"
            minHeight={60}
          />
        </View>
      ) : (
        <AppText color="muted">
          Type the word you think it is. Spelling counts, but a plural is fine. Nobody else sees your guess until
          everyone has guessed.
        </AppText>
      )}
    </GameFrame>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  footer: { gap: spacing.sm },
});
