import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { DECK } from '../../data/nouns';
import { createGame, gameReducer, type GameAction, type GameSettings, type GameState, type Phase } from '../../game';
import { isPublicPhase } from '../navigation';
import { ChooseWordScreen } from './ChooseWordScreen';
import { ClueScreen } from './ClueScreen';
import { GuessScreen } from './GuessScreen';
import { HandoffGiverScreen, HandoffGuesserScreen } from './HandoffScreens';
import { GameOverScreen, RoundResultScreen, TurnResultScreen } from './ResultScreens';
import { ScoreboardModal } from './ScoreboardModal';
import type { PhaseProps } from './shared';

/**
 * After every step change, taps are ignored for this long. Every phase puts its
 * main button in the same footer slot, so without this the second tap of an
 * accidental double tap would press the NEXT screen's button: skipping a
 * public result, or revealing a private screen while everyone is looking.
 */
export const PHASE_TAP_GUARD_MS = 600;

export interface GameScreenProps {
  playerNames: string[];
  settings: GameSettings;
  seed: number;
  /** Ask to abandon the game; the caller shows the confirmation. */
  onRequestQuit: () => void;
  onHome: () => void;
  /** Start over with the same players; the caller remounts this screen with a new seed. */
  onPlayAgain: () => void;
  /** Reports the engine phase so the app can decide what hardware-back does. */
  onPhaseChange?: (phase: Phase) => void;
  deck?: readonly string[];
}

/**
 * One game, driven by the pure engine reducer. Settings are captured when the
 * game is created, so changing them later never affects a game in progress.
 */
export function GameScreen({
  playerNames,
  settings,
  seed,
  onRequestQuit,
  onHome,
  onPlayAgain,
  onPhaseChange,
  deck = DECK,
}: GameScreenProps) {
  const [state, dispatch] = useReducer(
    (current: GameState, action: GameAction) => gameReducer(current, action, deck),
    undefined,
    () => createGame(playerNames, settings, deck, seed),
  );
  const [scoresOpen, setScoresOpen] = useState(false);
  // Set when the players end the game from the clue screen because the word
  // model cannot score. The engine state is left as it is (scores are already
  // credited as they are earned) and the final leaderboard is shown over it.
  const [endedEarly, setEndedEarly] = useState(false);
  const phase: Phase = endedEarly ? 'game-over' : state.phase;

  useEffect(() => {
    onPhaseChange?.(phase);
  }, [onPhaseChange, phase]);

  // The scoreboard must never sit on top of a private screen.
  const scoresVisible = scoresOpen && isPublicPhase(phase);
  useEffect(() => {
    if (!isPublicPhase(phase)) setScoresOpen(false);
  }, [phase]);

  // Remount per step so typed text and selections never carry over to the next player.
  const key = endedEarly ? 'ended-early' : `${state.turnIndex}:${state.clueRound}:${state.guesserPos}:${state.phase}`;

  // Stamped during render, not in an effect, so the guard is already running
  // when the new step's buttons can first be touched.
  const lastKey = useRef<string | null>(null);
  const stepStartedAt = useRef(0);
  if (lastKey.current !== key) {
    lastKey.current = key;
    stepStartedAt.current = Date.now();
  }
  const tooSoon = useCallback(() => Date.now() - stepStartedAt.current < PHASE_TAP_GUARD_MS, []);
  const guardedDispatch = useCallback(
    (action: GameAction) => {
      // Only the one-tap "advance" actions are guarded: they are what the footer button of a
      // freshly shown screen sends. Everything else needs input first (a selection, typed text,
      // a scored clue, a confirmed dialog) and must never be dropped, or a screen that marks
      // itself as submitted could get stuck.
      const advances = action.type === 'REVEAL' || action.type === 'NEXT';
      if (!advances || !tooSoon()) dispatch(action);
    },
    [tooSoon],
  );

  const props: PhaseProps = {
    state,
    dispatch: guardedDispatch,
    onQuit: onRequestQuit,
    onShowScores: () => setScoresOpen(true),
    onEndGame: () => setEndedEarly(true),
  };

  let screen;
  switch (phase) {
    case 'handoff-giver':
      screen = <HandoffGiverScreen key={key} {...props} />;
      break;
    case 'choose-word':
      screen = <ChooseWordScreen key={key} {...props} />;
      break;
    case 'clue':
      screen = <ClueScreen key={key} {...props} />;
      break;
    case 'handoff-guesser':
      screen = <HandoffGuesserScreen key={key} {...props} />;
      break;
    case 'guess':
      screen = <GuessScreen key={key} {...props} />;
      break;
    case 'round-result':
      screen = <RoundResultScreen key={key} {...props} />;
      break;
    case 'turn-result':
      screen = <TurnResultScreen key={key} {...props} />;
      break;
    case 'game-over':
      // These bypass the reducer, so they need the same guard: "Home" sits where the previous
      // screen's "See the final scores" button was.
      screen = (
        <GameOverScreen
          key={key}
          state={state}
          onPlayAgain={() => {
            if (!tooSoon()) onPlayAgain();
          }}
          onHome={() => {
            if (!tooSoon()) onHome();
          }}
        />
      );
      break;
  }

  return (
    <>
      {screen}
      <ScoreboardModal state={state} visible={scoresVisible} onClose={() => setScoresOpen(false)} />
    </>
  );
}
