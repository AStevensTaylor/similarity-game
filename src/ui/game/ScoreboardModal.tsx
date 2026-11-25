import { MAX_CLUE_ROUNDS, currentGiver, turnNumber, type GameState } from '../../game';
import { ScoreboardSheet } from './parts';
import { publicPlayers } from './shared';

export interface ScoreboardModalProps {
  state: GameState;
  visible: boolean;
  onClose: () => void;
}

/** Scores and turn progress. Deliberately contains public information only. */
export function ScoreboardModal({ state, visible, onClose }: ScoreboardModalProps) {
  return (
    <ScoreboardSheet
      visible={visible}
      onClose={onClose}
      subtitle={`Turn ${turnNumber(state)} of ${state.totalTurns} - ${currentGiver(state).name} is the clue-giver - clue round ${Math.min(state.clueRound, MAX_CLUE_ROUNDS)} of ${MAX_CLUE_ROUNDS}`}
      players={publicPlayers(state)}
    />
  );
}
