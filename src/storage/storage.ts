/**
 * Persistence of settings and the remembered player names.
 *
 * Parsing is defensive: anything unreadable, of the wrong shape or out of
 * range falls back to defaults, so a corrupt entry can never break the app.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEFAULT_SETTINGS, MAX_PLAYERS, MIN_PLAYERS, sanitizeSettings, type GameSettings } from '../game';
import { DEFAULT_PLAYER_NAMES, MAX_NAME_LENGTH, cleanName } from '../ui/players';

export const SETTINGS_KEY = '@similarity-game/settings/v1';
export const PLAYERS_KEY = '@similarity-game/players/v1';

function parseJson(raw: string | null | undefined): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function serializeSettings(settings: GameSettings): string {
  const s = sanitizeSettings(settings);
  return JSON.stringify({
    turnsPerPlayer: s.turnsPerPlayer,
    threshold: s.threshold,
    guessMode: s.guessMode,
    requireDictionaryNoun: s.requireDictionaryNoun,
    useWordLinks: s.useWordLinks,
  });
}

export function parseSettings(raw: string | null | undefined): GameSettings {
  const value = parseJson(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_SETTINGS };
  const v = value as Record<string, unknown>;
  return sanitizeSettings({
    turnsPerPlayer: typeof v.turnsPerPlayer === 'number' ? v.turnsPerPlayer : DEFAULT_SETTINGS.turnsPerPlayer,
    threshold: typeof v.threshold === 'number' ? v.threshold : DEFAULT_SETTINGS.threshold,
    guessMode: v.guessMode === 'list' || v.guessMode === 'open' ? v.guessMode : DEFAULT_SETTINGS.guessMode,
    requireDictionaryNoun:
      typeof v.requireDictionaryNoun === 'boolean' ? v.requireDictionaryNoun : DEFAULT_SETTINGS.requireDictionaryNoun,
    useWordLinks: typeof v.useWordLinks === 'boolean' ? v.useWordLinks : DEFAULT_SETTINGS.useWordLinks,
  });
}

export function serializePlayers(names: readonly string[]): string {
  return JSON.stringify(names.slice(0, MAX_PLAYERS).map(cleanName));
}

/** Stored names, cleaned; the two default players if the entry is missing or unusable. */
export function parsePlayers(raw: string | null | undefined): string[] {
  const value = parseJson(raw);
  if (!Array.isArray(value)) return [...DEFAULT_PLAYER_NAMES];
  const names = value
    .filter((n): n is string => typeof n === 'string')
    .map((n) => Array.from(cleanName(n)).slice(0, MAX_NAME_LENGTH).join(''))
    .slice(0, MAX_PLAYERS);
  return names.length >= MIN_PLAYERS ? names : [...DEFAULT_PLAYER_NAMES];
}

export async function loadSettings(): Promise<GameSettings> {
  try {
    return parseSettings(await AsyncStorage.getItem(SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Resolves to false (instead of throwing) when the write fails. */
export async function saveSettings(settings: GameSettings): Promise<boolean> {
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, serializeSettings(settings));
    return true;
  } catch {
    return false;
  }
}

export async function loadPlayers(): Promise<string[]> {
  try {
    return parsePlayers(await AsyncStorage.getItem(PLAYERS_KEY));
  } catch {
    return [...DEFAULT_PLAYER_NAMES];
  }
}

export async function savePlayers(names: readonly string[]): Promise<boolean> {
  try {
    await AsyncStorage.setItem(PLAYERS_KEY, serializePlayers(names));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// "Play over Wi-Fi" preferences
// ---------------------------------------------------------------------------

export const WIFI_KEY = '@similarity-game/wifi/v1';

export interface WifiPrefs {
  /** The display name last used for a Wi-Fi game; '' when never set. */
  name: string;
  /** True once the player has read the "allow local network access" explanation (iOS). */
  permissionExplained: boolean;
}

export const DEFAULT_WIFI_PREFS: WifiPrefs = { name: '', permissionExplained: false };

export function serializeWifiPrefs(prefs: WifiPrefs): string {
  return JSON.stringify({
    name: Array.from(cleanName(prefs.name)).slice(0, MAX_NAME_LENGTH).join(''),
    permissionExplained: prefs.permissionExplained === true,
  });
}

export function parseWifiPrefs(raw: string | null | undefined): WifiPrefs {
  const value = parseJson(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_WIFI_PREFS };
  const v = value as Record<string, unknown>;
  return {
    name: typeof v.name === 'string' ? Array.from(cleanName(v.name)).slice(0, MAX_NAME_LENGTH).join('') : '',
    permissionExplained: v.permissionExplained === true,
  };
}

export async function loadWifiPrefs(): Promise<WifiPrefs> {
  try {
    return parseWifiPrefs(await AsyncStorage.getItem(WIFI_KEY));
  } catch {
    return { ...DEFAULT_WIFI_PREFS };
  }
}

/** Resolves to false (instead of throwing) when the write fails. */
export async function saveWifiPrefs(prefs: WifiPrefs): Promise<boolean> {
  try {
    await AsyncStorage.setItem(WIFI_KEY, serializeWifiPrefs(prefs));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The seat held in the last Wi-Fi game that was joined
// ---------------------------------------------------------------------------

/**
 * Kept under its own key (not inside WifiPrefs) because it is written by the
 * session flow while the entry screen owns and rewrites the preferences.
 */
export const WIFI_SEAT_KEY = '@similarity-game/wifi-seat/v1';
/** After this long the saved seat is ignored: no game lasts that long. */
export const SAVED_SEAT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Where this phone last held a seat, and the reconnect token that reclaims it. */
export interface SavedSeat {
  host: string;
  port: number;
  token: string;
  /** Date.now() when it was saved. */
  savedAt: number;
}

export function serializeSavedSeat(seat: SavedSeat): string {
  return JSON.stringify({ host: seat.host, port: seat.port, token: seat.token, savedAt: seat.savedAt });
}

/** The stored seat, or null when it is missing, malformed or too old. */
export function parseSavedSeat(raw: string | null | undefined, now: number = Date.now()): SavedSeat | null {
  const value = parseJson(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.host !== 'string' || v.host.length < 1 || v.host.length > 64) return null;
  if (typeof v.port !== 'number' || !Number.isInteger(v.port) || v.port < 1 || v.port > 65535) return null;
  if (typeof v.token !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(v.token)) return null;
  if (typeof v.savedAt !== 'number' || !Number.isFinite(v.savedAt)) return null;
  const age = now - v.savedAt;
  // A clock that went backwards makes the age negative: allow a little, not a lot.
  if (age > SAVED_SEAT_MAX_AGE_MS || age < -60_000) return null;
  return { host: v.host, port: v.port, token: v.token, savedAt: v.savedAt };
}

export async function loadSavedSeat(): Promise<SavedSeat | null> {
  try {
    return parseSavedSeat(await AsyncStorage.getItem(WIFI_SEAT_KEY));
  } catch {
    return null;
  }
}

/** Resolves to false (instead of throwing) when the write fails. */
export async function saveSavedSeat(seat: SavedSeat): Promise<boolean> {
  try {
    await AsyncStorage.setItem(WIFI_SEAT_KEY, serializeSavedSeat(seat));
    return true;
  } catch {
    return false;
  }
}

export async function clearSavedSeat(): Promise<boolean> {
  try {
    await AsyncStorage.removeItem(WIFI_SEAT_KEY);
    return true;
  } catch {
    return false;
  }
}
