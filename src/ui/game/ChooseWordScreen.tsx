import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { currentGiver } from '../../game';
import { AppText, Button } from '../components';
import { spacing } from '../theme';
import { WordOptions } from './parts';
import { GameFrame, type PhaseProps } from './shared';

/** Private to the giver: pick the hidden word from the five options. */
export function ChooseWordScreen({ state, dispatch, onQuit, onShowScores }: PhaseProps) {
  const giver = currentGiver(state);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <GameFrame
      testID="phase-choose-word"
      state={state}
      onQuit={onQuit}
      onShowScores={onShowScores}
      footer={
        <Button
          testID="confirm-word"
          label={selected ? `Lock in "${selected}"` : 'Pick a word'}
          disabled={selected === null}
          onPress={() => {
            if (selected !== null) dispatch({ type: 'CHOOSE_WORD', word: selected });
          }}
        />
      }
    >
      <View style={styles.intro}>
        <AppText variant="label" color="accent">
          {`For ${giver.name}'s eyes only`}
        </AppText>
        <AppText variant="heading">Pick your secret word</AppText>
        <AppText color="muted">
          You will give one-word clues for it. Your clues may not contain, or be a form of, any of these five words.
        </AppText>
      </View>
      <WordOptions
        options={state.options}
        selected={selected}
        onSelect={setSelected}
        label="Secret word options"
        testIDPrefix="option-"
      />
    </GameFrame>
  );
}

const styles = StyleSheet.create({
  intro: { gap: spacing.sm },
});
