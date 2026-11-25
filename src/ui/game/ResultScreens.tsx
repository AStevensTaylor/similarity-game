import { StyleSheet, View } from 'react-native';

import { MAX_CLUE_ROUNDS, currentGiver, type GameState } from '../../game';
import { Button, Screen } from '../components';
import { spacing } from '../theme';
import { GameOverBody, LeaderboardList, RoundResultBody, TurnResultBody } from './parts';
import { GameFrame, publicPlayers, type PhaseProps } from './shared';

/** Ranked list of all players with their scores. Public information only. */
export function Leaderboard({ state }: { state: GameState }) {
  return <LeaderboardList players={publicPlayers(state)} />;
}

/**
 * Public: every guess of the round is revealed. The hidden word is not shown
 * here; it only becomes visible through a correct guess, which ends the turn.
 */
export function RoundResultScreen({ state, dispatch, onQuit, onShowScores }: PhaseProps) {
  const giver = currentGiver(state);
  const round = state.rounds[state.rounds.length - 1];
  if (round === undefined) return null;
  const turnOver = round.anyCorrect || state.clueRound >= MAX_CLUE_ROUNDS;

  return (
    <GameFrame
      testID="phase-round-result"
      state={state}
      onQuit={onQuit}
      onShowScores={onShowScores}
      footer={
        <Button
          testID="next"
          label={turnOver ? 'See the turn result' : `Pass to ${giver.name} for clue ${state.clueRound + 1}`}
          onPress={() => dispatch({ type: 'NEXT' })}
        />
      }
    >
      <RoundResultBody
        round={round}
        giverName={giver.name}
        turnOver={turnOver}
        giverTurnPoints={state.giverTurnPoints}
        players={publicPlayers(state)}
      />
    </GameFrame>
  );
}

/** Public: the turn is over, so the hidden word and the turn's points are revealed. */
export function TurnResultScreen({ state, dispatch, onQuit, onShowScores }: PhaseProps) {
  const summary = state.turnSummary;
  if (summary === null) return null;
  const lastTurn = state.turnIndex + 1 >= state.totalTurns;
  const nextGiver = state.players[(state.giverIndex + 1) % state.players.length];

  return (
    <GameFrame
      testID="phase-turn-result"
      state={state}
      onQuit={onQuit}
      onShowScores={onShowScores}
      footer={
        <Button
          testID="next"
          label={lastTurn ? 'See the final scores' : `Next turn: pass to ${nextGiver.name}`}
          onPress={() => dispatch({ type: 'NEXT' })}
        />
      }
    >
      <TurnResultBody summary={summary} players={publicPlayers(state)} />
    </GameFrame>
  );
}

export interface GameOverScreenProps {
  state: GameState;
  onPlayAgain: () => void;
  onHome: () => void;
}

/** Final ranked leaderboard; ties are shown as ties. */
export function GameOverScreen({ state, onPlayAgain, onHome }: GameOverScreenProps) {
  return (
    <Screen
      testID="phase-game-over"
      title="Final scores"
      footer={
        <View style={styles.block}>
          <Button testID="play-again" label="Play again" accessibilityHint="Same players, new words" onPress={onPlayAgain} />
          <Button testID="home" variant="secondary" label="Home" onPress={onHome} />
        </View>
      }
    >
      <GameOverBody players={publicPlayers(state)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
});
