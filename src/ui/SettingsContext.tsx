import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { DEFAULT_SETTINGS, sanitizeSettings, type GameSettings } from '../game';
import { loadSettings, saveSettings } from '../storage';

export interface SettingsContextValue {
  settings: GameSettings;
  /** False until the stored settings have been read. */
  loaded: boolean;
  /** Merges the patch, clamps the result and persists it. */
  update(patch: Partial<GameSettings>): void;
  reset(): void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export interface SettingsProviderProps {
  children: ReactNode;
  /** Skips storage and starts from these (tests). */
  initialSettings?: GameSettings;
}

export function SettingsProvider({ children, initialSettings }: SettingsProviderProps) {
  const [settings, setSettings] = useState<GameSettings>(() => sanitizeSettings(initialSettings ?? DEFAULT_SETTINGS));
  const [loaded, setLoaded] = useState(initialSettings !== undefined);
  // Mirrors of the latest values, so update() can compute and persist the next
  // settings without a side effect inside a state updater.
  const settingsRef = useRef(settings);
  const loadedRef = useRef(initialSettings !== undefined);
  // Changes made before the stored settings arrived. They are shown at once but
  // only saved after being re-applied on top of what was stored, so an early
  // change to one setting cannot replace the other saved settings with defaults.
  const pending = useRef<Partial<GameSettings> | null>(null);

  const commit = useCallback((next: GameSettings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  useEffect(() => {
    if (initialSettings !== undefined) return;
    let alive = true;
    loadSettings().then((stored) => {
      if (!alive) return;
      loadedRef.current = true;
      if (pending.current !== null) {
        const merged = sanitizeSettings({ ...stored, ...pending.current });
        pending.current = null;
        commit(merged);
        void saveSettings(merged);
      } else {
        commit(stored);
      }
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [initialSettings, commit]);

  const update = useCallback(
    (patch: Partial<GameSettings>) => {
      const next = sanitizeSettings({ ...settingsRef.current, ...patch });
      commit(next);
      if (loadedRef.current) void saveSettings(next);
      else pending.current = { ...pending.current, ...patch };
    },
    [commit],
  );

  const reset = useCallback(() => update(DEFAULT_SETTINGS), [update]);

  const value = useMemo(() => ({ settings, loaded, update, reset }), [settings, loaded, update, reset]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) throw new Error('useSettings must be used inside <SettingsProvider>.');
  return value;
}
