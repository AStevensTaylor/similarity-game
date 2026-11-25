import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEFAULT_SETTINGS, type GameSettings } from '../../game';
import {
  DEFAULT_WIFI_PREFS,
  PLAYERS_KEY,
  SAVED_SEAT_MAX_AGE_MS,
  SETTINGS_KEY,
  WIFI_KEY,
  WIFI_SEAT_KEY,
  clearSavedSeat,
  loadSavedSeat,
  parseSavedSeat,
  saveSavedSeat,
  serializeSavedSeat,
  loadPlayers,
  loadSettings,
  loadWifiPrefs,
  parsePlayers,
  parseSettings,
  parseWifiPrefs,
  savePlayers,
  saveSettings,
  saveWifiPrefs,
  serializePlayers,
  serializeSettings,
  serializeWifiPrefs,
} from '../storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const CUSTOM: GameSettings = { turnsPerPlayer: 4, threshold: 0.88, guessMode: 'list', requireDictionaryNoun: false };

describe('settings serialisation', () => {
  it('round-trips', () => {
    expect(parseSettings(serializeSettings(CUSTOM))).toEqual(CUSTOM);
    expect(parseSettings(serializeSettings(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to defaults for missing or unreadable data', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '42', 'null', '"x"']) {
      expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
    expect(parseSettings(null)).not.toBe(DEFAULT_SETTINGS);
  });

  it('keeps valid fields, defaults bad ones and clamps out-of-range numbers', () => {
    expect(parseSettings(JSON.stringify({ threshold: 0.9, guessMode: 'banana', turnsPerPlayer: '3' }))).toEqual({
      ...DEFAULT_SETTINGS,
      threshold: 0.9,
    });
    expect(parseSettings(JSON.stringify({ threshold: 0.2, turnsPerPlayer: 99 }))).toEqual({
      ...DEFAULT_SETTINGS,
      threshold: 0.8,
      turnsPerPlayer: 5,
    });
    expect(parseSettings(JSON.stringify({ threshold: 0.951234, turnsPerPlayer: 2.4 })).threshold).toBe(0.95);
    expect(parseSettings(JSON.stringify({ requireDictionaryNoun: 'no' })).requireDictionaryNoun).toBe(true);
  });

  it('serialises only the known fields, sanitised', () => {
    const noisy = { ...CUSTOM, threshold: 5, extra: 'x' } as unknown as GameSettings;
    expect(JSON.parse(serializeSettings(noisy))).toEqual({ ...CUSTOM, threshold: 0.99 });
  });
});

describe('player serialisation', () => {
  it('round-trips cleaned names', () => {
    expect(parsePlayers(serializePlayers([' Ana ', 'Bo  B', 'Cy']))).toEqual(['Ana', 'Bo B', 'Cy']);
  });

  it('falls back to two default players for missing or unusable data', () => {
    for (const raw of [null, undefined, '', '{', '{}', '"Ana"', '["Ana"]', '[1, 2, 3]']) {
      expect(parsePlayers(raw)).toEqual(['Player 1', 'Player 2']);
    }
  });

  it('drops non-strings, caps the count at 8 and the length at 16', () => {
    const many = Array.from({ length: 12 }, (_, i) => `P${i}`);
    expect(parsePlayers(JSON.stringify(many))).toHaveLength(8);
    expect(parsePlayers(JSON.stringify(['Ana', 5, null, 'Bo']))).toEqual(['Ana', 'Bo']);
    expect(parsePlayers(JSON.stringify(['x'.repeat(40), 'Bo']))[0]).toHaveLength(16);
    expect(JSON.parse(serializePlayers(many))).toHaveLength(8);
  });
});

describe('Wi-Fi preferences', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('round-trips a cleaned, length-limited name and the explained flag', () => {
    expect(parseWifiPrefs(serializeWifiPrefs({ name: '  Ana   B ', permissionExplained: true }))).toEqual({
      name: 'Ana B',
      permissionExplained: true,
    });
    expect(parseWifiPrefs(serializeWifiPrefs({ name: 'x'.repeat(40), permissionExplained: false })).name).toHaveLength(16);
  });

  it('falls back to defaults for missing or unusable data', () => {
    for (const raw of [null, undefined, '', '{', '[]', '"Ana"', '42']) {
      expect(parseWifiPrefs(raw)).toEqual(DEFAULT_WIFI_PREFS);
    }
    expect(parseWifiPrefs(JSON.stringify({ name: 7, permissionExplained: 'yes' }))).toEqual(DEFAULT_WIFI_PREFS);
    expect(parseWifiPrefs(null)).not.toBe(DEFAULT_WIFI_PREFS);
  });

  it('saves and loads under its own versioned key and survives storage failures', async () => {
    expect(await loadWifiPrefs()).toEqual(DEFAULT_WIFI_PREFS);
    expect(await saveWifiPrefs({ name: 'Bo', permissionExplained: true })).toBe(true);
    expect(await AsyncStorage.getItem(WIFI_KEY)).toBe('{"name":"Bo","permissionExplained":true}');
    expect(await loadWifiPrefs()).toEqual({ name: 'Bo', permissionExplained: true });
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    expect(await loadWifiPrefs()).toEqual(DEFAULT_WIFI_PREFS);
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('full'));
    expect(await saveWifiPrefs({ name: 'Bo', permissionExplained: true })).toBe(false);
  });
});

describe('the saved Wi-Fi seat', () => {
  const NOW = 1_800_000_000_000;
  const SEAT = { host: '192.168.1.20', port: 40123, token: 'abcDEF123_-xyz', savedAt: NOW - 1000 };

  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('round-trips and expires', () => {
    expect(parseSavedSeat(serializeSavedSeat(SEAT), NOW)).toEqual(SEAT);
    expect(parseSavedSeat(serializeSavedSeat(SEAT), NOW + SAVED_SEAT_MAX_AGE_MS - 2000)).toEqual(SEAT);
    expect(parseSavedSeat(serializeSavedSeat(SEAT), NOW + SAVED_SEAT_MAX_AGE_MS)).toBeNull();
    // Saved "in the future" by more than a clock adjustment: not trusted.
    expect(parseSavedSeat(serializeSavedSeat({ ...SEAT, savedAt: NOW + 3_600_000 }), NOW)).toBeNull();
  });

  it('drops anything missing or malformed', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '42', 'null', '{}']) expect(parseSavedSeat(raw, NOW)).toBeNull();
    const broken: Record<string, unknown>[] = [
      { ...SEAT, host: '' },
      { ...SEAT, host: 'x'.repeat(65) },
      { ...SEAT, host: 5 },
      { ...SEAT, port: 0 },
      { ...SEAT, port: 70000 },
      { ...SEAT, port: 80.5 },
      { ...SEAT, port: '40123' },
      { ...SEAT, token: 'short' },
      { ...SEAT, token: 'has space in it' },
      { ...SEAT, token: 'x'.repeat(65) },
      { ...SEAT, token: null },
      { ...SEAT, savedAt: 'yesterday' },
      { ...SEAT, savedAt: null },
    ];
    for (const value of broken) expect(parseSavedSeat(JSON.stringify(value), NOW)).toBeNull();
    // Unknown keys are not carried along.
    expect(parseSavedSeat(JSON.stringify({ ...SEAT, extra: 'x' }), NOW)).toEqual(SEAT);
  });

  it('saves, loads and clears under its own key, apart from the preferences, and survives storage failures', async () => {
    const seat = { ...SEAT, savedAt: Date.now() };
    expect(await loadSavedSeat()).toBeNull();
    expect(await saveSavedSeat(seat)).toBe(true);
    expect(await AsyncStorage.getItem(WIFI_SEAT_KEY)).toBe(serializeSavedSeat(seat));
    expect(await loadSavedSeat()).toEqual(seat);
    // Rewriting the preferences (the entry screen does on every keystroke) leaves it alone.
    await saveWifiPrefs({ name: 'Ana', permissionExplained: true });
    expect(await loadSavedSeat()).toEqual(seat);
    expect(await clearSavedSeat()).toBe(true);
    expect(await loadSavedSeat()).toBeNull();
    expect(await loadWifiPrefs()).toEqual({ name: 'Ana', permissionExplained: true });

    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    expect(await loadSavedSeat()).toBeNull();
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('full'));
    expect(await saveSavedSeat(seat)).toBe(false);
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('disk'));
    expect(await clearSavedSeat()).toBe(false);
  });
});

describe('AsyncStorage round trip', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('returns defaults when nothing is stored', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await loadPlayers()).toEqual(['Player 1', 'Player 2']);
  });

  it('saves and loads settings and players under versioned keys', async () => {
    expect(await saveSettings(CUSTOM)).toBe(true);
    expect(await savePlayers(['Ana', 'Bo', 'Cy'])).toBe(true);
    expect(await AsyncStorage.getItem(SETTINGS_KEY)).toBe(serializeSettings(CUSTOM));
    expect(await AsyncStorage.getItem(PLAYERS_KEY)).toBe('["Ana","Bo","Cy"]');
    expect(await loadSettings()).toEqual(CUSTOM);
    expect(await loadPlayers()).toEqual(['Ana', 'Bo', 'Cy']);
  });

  it('survives storage failures', async () => {
    const getItem = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    getItem.mockRejectedValueOnce(new Error('disk'));
    expect(await loadPlayers()).toEqual(['Player 1', 'Player 2']);
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('full'));
    expect(await saveSettings(CUSTOM)).toBe(false);
    getItem.mockRestore();
  });
});
