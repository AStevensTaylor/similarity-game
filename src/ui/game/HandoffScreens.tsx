import { MAX_CLUE_ROUNDS, currentGiver, currentGuesser } from '../../game';
import { AppText, Button, Card } from '../components';
import { GameFrame, PassTo, type PhaseProps } from './shared';

/**
 * Public screen shown while the phone travels to the giver. It names who
 * should take the phone and reveals nothing else.
 */
export function HandoffGiverScreen({ state, dispatch, onQuit, onShowScores }: PhaseProps) {
  const giver = currentGiver(state);
  const firstRound = state.hiddenWord === null;
  return (
    <GameFrame
      testID="phase-handoff-giver"
      state={state}
      onQuit={onQuit}
      onShowScores={onShowScores}
      centered
      footer={
        <Button
          testID="reveal"
          label={firstRound ? `I'm ${giver.name} - show my words` : `I'm ${giver.name} - continue`}
          onPress={() => dispatch({ type: 'REVEAL' })}
        />
      }
    >
      <PassTo state={state} player={giver} lead="Pass the phone to" />
      <Card tone="accent">
        <AppText variant="bodyLarge" color="onAccentSoft" center>
          {firstRound
            ? `${giver.name} is the clue-giver this turn.`
            : `Nobody guessed the word. ${giver.name} gives clue ${state.clueRound} of ${MAX_CLUE_ROUNDS}.`}
        </AppText>
        <AppText color="onAccentSoft" center>
          Everyone else: look away until the phone comes back to you.
        </AppText>
      </Card>
    </GameFrame>
  );
}

/** Public screen shown while the phone travels to the next guesser. Shows no clue and no guess. */
export function HandoffGuesserScreen({ state, dispatch, onQuit, onShowScores }: PhaseProps) {
  const giver = currentGiver(state);
  const guesser = currentGuesser(state);
  if (guesser === null) return null;
  const first = state.guesserPos === 0;
  return (
    <GameFrame
      testID="phase-handoff-guesser"
      state={state}
      onQuit={onQuit}
      onShowScores={onShowScores}
      centered
      footer={
        <Button
          testID="reveal"
          label={`I'm ${guesser.name} - show the clue`}
          onPress={() => dispatch({ type: 'REVEAL' })}
        />
      }
    >
      <PassTo state={state} player={guesser} lead="Pass the phone to" />
      <Card tone="accent">
        <AppText variant="bodyLarge" color="onAccentSoft" center>
          {first ? `${giver.name}'s clue was accepted.` : 'Guess locked in.'}
        </AppText>
        <AppText color="onAccentSoft" center>
          {`Guesser ${state.guesserPos + 1} of ${state.guesserOrder.length} - clue ${state.clueRound} of ${MAX_CLUE_ROUNDS}. Keep your guess to yourself.`}
        </AppText>
      </Card>
    </GameFrame>
  );
}
