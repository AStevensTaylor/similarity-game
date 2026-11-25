import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { Phase } from './src/game';
import type { NetworkAdapter } from './src/net';
import { SimilarityProvider } from './src/similarity';
import { makeSeed } from './src/ui/format';
import { GameScreen } from './src/ui/game/GameScreen';
import { resolveBack, type Route } from './src/ui/navigation';
import { WifiFlow, type WifiFlowProps } from './src/ui/net/WifiFlow';
import type { CheckEntry } from './src/ui/checkHistory';
import { CheckerScreen } from './src/ui/screens/CheckerScreen';
import { HomeScreen } from './src/ui/screens/HomeScreen';
import { HowToPlayScreen } from './src/ui/screens/HowToPlayScreen';
import { SettingsScreen } from './src/ui/screens/SettingsScreen';
import { SetupScreen } from './src/ui/screens/SetupScreen';
import { SettingsProvider, useSettings } from './src/ui/SettingsContext';

interface ActiveGame {
  playerNames: string[];
  seed: number;
}

export interface AppProps {
  /** Replaces the real LAN adapter for "Play over Wi-Fi" (tests). The real one is loaded lazily on first use. */
  netAdapter?: NetworkAdapter;
  /** Extra props for the Wi-Fi flow (tests). */
  wifi?: Partial<Omit<WifiFlowProps, 'onExit' | 'adapter' | 'backHandler'>>;
}

/** A plain state-machine navigator: one route at a time, home is the hub. */
export function AppNavigator({ netAdapter, wifi }: AppProps) {
  const { settings } = useSettings();
  const [route, setRoute] = useState<Route>('home');
  const [game, setGame] = useState<ActiveGame | null>(null);
  const [checkHistory, setCheckHistory] = useState<CheckEntry[]>([]);
  const gamePhase = useRef<Phase | null>(null);
  const quitDialogOpen = useRef(false);
  // Set by the Wi-Fi flow while it is showing; it owns hardware-back there.
  const wifiBack = useRef<(() => boolean) | null>(null);

  const goHome = useCallback(() => {
    gamePhase.current = null;
    setGame(null);
    setRoute('home');
  }, []);

  const confirmQuit = useCallback(() => {
    if (quitDialogOpen.current) return;
    quitDialogOpen.current = true;
    const close = () => {
      quitDialogOpen.current = false;
    };
    Alert.alert(
      'Quit this game?',
      'The game in progress and its scores will be lost.',
      [
        { text: 'Keep playing', style: 'cancel', onPress: close },
        {
          text: 'Quit game',
          style: 'destructive',
          onPress: () => {
            close();
            goHome();
          },
        },
      ],
      { cancelable: true, onDismiss: close },
    );
  }, [goHome]);

  // Android hardware back. Returning false on home lets the system leave the app.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const result = resolveBack(route, gamePhase.current);
      if (result.kind === 'exit') return false;
      if (result.kind === 'delegate') {
        if (wifiBack.current?.() !== true) goHome();
        return true;
      }
      if (result.kind === 'confirm-quit') confirmQuit();
      else if (result.route === 'home') goHome();
      else setRoute(result.route);
      return true;
    });
    return () => subscription.remove();
  }, [route, confirmQuit, goHome]);

  const onPhaseChange = useCallback((phase: Phase) => {
    gamePhase.current = phase;
  }, []);

  switch (route) {
    case 'setup':
      return (
        <SetupScreen
          onBack={goHome}
          onStart={(playerNames) => {
            setGame({ playerNames, seed: makeSeed() });
            setRoute('game');
          }}
        />
      );
    case 'game':
      if (game === null) return <HomeScreenRoute setRoute={setRoute} />;
      return (
        <GameScreen
          // A new seed is a new game: remount so the reducer starts fresh.
          key={game.seed}
          playerNames={game.playerNames}
          settings={settings}
          seed={game.seed}
          onRequestQuit={confirmQuit}
          onHome={goHome}
          onPlayAgain={() =>
            setGame((current) => {
              if (current === null) return current;
              let seed = makeSeed();
              if (seed === current.seed) seed = (seed + 1) >>> 0;
              return { playerNames: current.playerNames, seed };
            })
          }
          onPhaseChange={onPhaseChange}
        />
      );
    case 'wifi':
      return <WifiFlow {...wifi} adapter={netAdapter} backHandler={wifiBack} onExit={goHome} />;
    case 'checker':
      return <CheckerScreen onBack={goHome} history={checkHistory} onHistoryChange={setCheckHistory} />;
    case 'settings':
      return <SettingsScreen onBack={goHome} />;
    case 'how-to-play':
      return <HowToPlayScreen onBack={goHome} />;
    case 'home':
    default:
      return <HomeScreenRoute setRoute={setRoute} />;
  }
}

function HomeScreenRoute({ setRoute }: { setRoute: (route: Route) => void }) {
  return (
    <HomeScreen
      onPlay={() => setRoute('setup')}
      onWifi={() => setRoute('wifi')}
      onChecker={() => setRoute('checker')}
      onHowToPlay={() => setRoute('how-to-play')}
      onSettings={() => setRoute('settings')}
    />
  );
}

export default function App({ netAdapter, wifi }: AppProps) {
  return (
    <SafeAreaProvider>
      <SimilarityProvider>
        <SettingsProvider>
          <AppNavigator netAdapter={netAdapter} wifi={wifi} />
          <StatusBar style="auto" />
        </SettingsProvider>
      </SimilarityProvider>
    </SafeAreaProvider>
  );
}
