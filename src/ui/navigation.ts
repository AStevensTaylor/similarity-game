/** The app's tiny state-machine navigator: pure route logic, no React. */
import type { Phase } from '../game';

export type Route = 'home' | 'setup' | 'game' | 'wifi' | 'checker' | 'settings' | 'how-to-play';

export type BackResult =
  /** Let the system handle it (leaves the app). */
  | { kind: 'exit' }
  /** A game is in progress: ask before abandoning it. */
  | { kind: 'confirm-quit' }
  /** The Wi-Fi flow decides: it has its own screens and asks before leaving a lobby or game. */
  | { kind: 'delegate' }
  | { kind: 'navigate'; route: Route };

/** What the Android hardware back button should do on a given screen. */
export function resolveBack(route: Route, gamePhase: Phase | null): BackResult {
  switch (route) {
    case 'home':
      return { kind: 'exit' };
    case 'game':
      // A finished game has nothing left to lose.
      return gamePhase === 'game-over' ? { kind: 'navigate', route: 'home' } : { kind: 'confirm-quit' };
    case 'wifi':
      return { kind: 'delegate' };
    default:
      return { kind: 'navigate', route: 'home' };
  }
}

/** Phases in which the shared screen shows only public information. */
export function isPublicPhase(phase: Phase): boolean {
  return (
    phase === 'handoff-giver' ||
    phase === 'handoff-guesser' ||
    phase === 'round-result' ||
    phase === 'turn-result' ||
    phase === 'game-over'
  );
}
