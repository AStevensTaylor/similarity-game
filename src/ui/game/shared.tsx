import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { turnNumber, type GameAction, type GameState, type Player } from '../../game';
import { AppText, Avatar, Button, Screen } from '../components';
import { isPublicPhase } from '../navigation';
import { spacing } from '../theme';
import { PlayerRowView, type PublicPlayer } from './parts';

export interface PhaseProps {
  state: GameState;
  dispatch: (action: GameAction) => void;
  /** Ask to abandon the game (the caller confirms). */
  onQuit: () => void;
  onShowScores: () => void;
  /**
   * End the game now and show the final leaderboard with the scores so far.
   * Offered on the clue screen when the word model cannot score clues.
   */
  onEndGame?: () => void;
}

export interface GameFrameProps extends Pick<PhaseProps, 'state' | 'onQuit' | 'onShowScores'> {
  footer?: ReactNode;
  centered?: boolean;
  children?: ReactNode;
  testID?: string;
}

/** Screen scaffold for every game phase: turn counter, Quit, and Scores on public phases only. */
export function GameFrame({ state, onQuit, onShowScores, footer, centered, children, testID }: GameFrameProps) {
  return (
    <Screen
      testID={testID}
      title={`Turn ${turnNumber(state)} of ${state.totalTurns}`}
      onBack={onQuit}
      backLabel="Quit"
      headerRight={
        isPublicPhase(state.phase) ? (
          <Button compact variant="ghost" label="Scores" onPress={onShowScores} accessibilityHint="Shows the scoreboard" />
        ) : undefined
      }
      footer={footer}
      centered={centered}
    >
      {children}
    </Screen>
  );
}

export function seatOf(state: GameState, playerId: string): number {
  return Math.max(0, state.players.findIndex((p) => p.id === playerId));
}

/** The engine's players as the shared presentational components take them. */
export function publicPlayers(state: GameState): PublicPlayer[] {
  return state.players.map((p, index) => ({ id: p.id, name: p.name, score: p.score, colorIndex: index }));
}

export interface PlayerRowProps {
  state: GameState;
  player: Player;
  right?: ReactNode;
  subtitle?: string;
}

export function PlayerRow({ state, player, right, subtitle }: PlayerRowProps) {
  return <PlayerRowView name={player.name} colorIndex={seatOf(state, player.id)} right={right} subtitle={subtitle} />;
}

/** The big "pass the phone to ..." block used by both hand-off screens. */
export function PassTo({ state, player, lead }: { state: GameState; player: Player; lead: string }) {
  return (
    <View style={styles.passTo}>
      <AppText variant="label" color="muted" center>
        {lead}
      </AppText>
      <Avatar name={player.name} index={seatOf(state, player.id)} size={96} />
      <AppText variant="display" center>
        {player.name}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  passTo: { alignItems: 'center', gap: spacing.md },
});
