import { describe, expect, it } from '@jest/globals';

import { MAX_THRESHOLD, MIN_THRESHOLD } from '../../game';
import {
  formatGain,
  formatPoints,
  formatRaw,
  formatScore,
  formatThreshold,
  initial,
  joinNames,
  makeSeed,
  pluralize,
  rankLabel,
  rankSpoken,
  stepThreshold,
} from '../format';
import { isPublicPhase, resolveBack } from '../navigation';
import { MAX_NAME_LENGTH, cleanName, nextDefaultName, validatePlayerNames } from '../players';
import { addCheck, MAX_CHECK_HISTORY, type CheckEntry } from '../checkHistory';
import { PLAYER_COLORS, darkColors, lightColors, playerColor, themeFor } from '../theme';

describe('format', () => {
  it('truncates scores to 3 decimals so a near miss never looks like a pass', () => {
    expect(formatScore(0.9499999)).toBe('0.949');
    expect(formatScore(0.95)).toBe('0.950');
    expect(formatScore(0.57)).toBe('0.570');
    expect(formatScore(0.9996)).toBe('0.999');
    expect(formatScore(1)).toBe('1.000');
    expect(formatScore(0)).toBe('0.000');
    expect(formatScore(-0.2)).toBe('0.000');
    expect(formatScore(1.2)).toBe('1.000');
    expect(formatScore(Number.NaN)).toBe('-');
  });

  it('formats every 0.01 threshold step exactly under formatScore', () => {
    for (let h = 80; h <= 99; h++) expect(formatScore(h / 100)).toBe((h / 100).toFixed(3));
  });

  it('formats raw cosines, including negatives', () => {
    expect(formatRaw(0.80404)).toBe('0.804');
    expect(formatRaw(-0.1236)).toBe('-0.124');
    expect(formatRaw(-0.0001)).toBe('0.000');
    expect(formatRaw(Number.POSITIVE_INFINITY)).toBe('-');
  });

  it('formats thresholds, points and gains', () => {
    expect(formatThreshold(0.9)).toBe('0.90');
    expect(pluralize(1, 'turn')).toBe('1 turn');
    expect(pluralize(2, 'turn')).toBe('2 turns');
    expect(pluralize(0, 'reply', 'replies')).toBe('0 replies');
    expect(formatPoints(1)).toBe('1 point');
    expect(formatPoints(6)).toBe('6 points');
    expect(formatGain(4)).toBe('+4 points');
    expect(formatGain(1)).toBe('+1 point');
    expect(formatGain(0)).toBe('0 points');
  });

  it('joins names and labels ranks', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Ana'])).toBe('Ana');
    expect(joinNames(['Ana', 'Bo'])).toBe('Ana and Bo');
    expect(joinNames(['Ana', 'Bo', 'Cy'])).toBe('Ana, Bo and Cy');
    expect(rankLabel(1, false)).toBe('1');
    expect(rankLabel(1, true)).toBe('=1');
    expect(rankSpoken(3, false)).toBe('place 3');
    expect(rankSpoken(1, true)).toBe('tied for place 1');
    expect(initial('  zoe')).toBe('Z');
    expect(initial('   ')).toBe('?');
  });

  it('steps the threshold in exact hundredths and clamps', () => {
    let t = MIN_THRESHOLD;
    const seen = [t];
    for (let i = 0; i < 30; i++) {
      t = stepThreshold(t, 1, MIN_THRESHOLD, MAX_THRESHOLD);
      seen.push(t);
    }
    expect(seen[1]).toBe(0.81);
    expect(seen[15]).toBe(0.95);
    expect(seen[19]).toBe(0.99);
    expect(seen[30]).toBe(0.99);
    expect(stepThreshold(0.8, -1, MIN_THRESHOLD, MAX_THRESHOLD)).toBe(0.8);
    expect(stepThreshold(0.95, -1, MIN_THRESHOLD, MAX_THRESHOLD)).toBe(0.94);
  });

  it('makes uint32 seeds', () => {
    for (const [now, random] of [
      [0, 0],
      [1795000000000, 0.999999999],
      [1795000000000, 0.5],
    ]) {
      const seed = makeSeed(now, random);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
    expect(makeSeed(1000, 0.25)).not.toBe(makeSeed(1000, 0.75));
  });
});

describe('players', () => {
  it('cleans names', () => {
    expect(cleanName('  Mary   Ann ')).toBe('Mary Ann');
  });

  it('accepts unique non-empty names and returns them cleaned', () => {
    const v = validatePlayerNames([' Ana ', 'Bo']);
    expect(v.ok).toBe(true);
    expect(v.names).toEqual(['Ana', 'Bo']);
    expect(v.errors).toEqual([null, null]);
    expect(v.listError).toBeNull();
  });

  it('flags empty, duplicate (ignoring case) and too-long names', () => {
    const v = validatePlayerNames(['Ana', ' ', 'ana', 'x'.repeat(MAX_NAME_LENGTH + 1)]);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toBe('Names must be different.');
    expect(v.errors[1]).toBe('Enter a name.');
    expect(v.errors[2]).toBe('Names must be different.');
    expect(v.errors[3]).toContain('at most');
  });

  it('enforces 2 to 8 players', () => {
    expect(validatePlayerNames(['Ana']).listError).toContain('at least 2');
    expect(validatePlayerNames(['Ana']).ok).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => `P${i}`);
    expect(validatePlayerNames(nine).listError).toContain('At most 8');
    expect(validatePlayerNames(nine.slice(0, 8)).ok).toBe(true);
  });

  it('suggests a default name that is not taken', () => {
    expect(nextDefaultName(['Ana', 'Bo'])).toBe('Player 3');
    expect(nextDefaultName(['player 3', 'Bo'])).toBe('Player 4');
    expect(nextDefaultName([])).toBe('Player 1');
  });
});

describe('navigation', () => {
  it('leaves the app from home and returns home from the side screens', () => {
    expect(resolveBack('home', null)).toEqual({ kind: 'exit' });
    for (const route of ['setup', 'checker', 'settings', 'how-to-play'] as const) {
      expect(resolveBack(route, null)).toEqual({ kind: 'navigate', route: 'home' });
    }
  });

  it('leaves hardware back inside the Wi-Fi flow to that flow', () => {
    expect(resolveBack('wifi', null)).toEqual({ kind: 'delegate' });
  });

  it('asks before abandoning a game, but not once it is over', () => {
    expect(resolveBack('game', 'clue')).toEqual({ kind: 'confirm-quit' });
    expect(resolveBack('game', 'handoff-giver')).toEqual({ kind: 'confirm-quit' });
    expect(resolveBack('game', null)).toEqual({ kind: 'confirm-quit' });
    expect(resolveBack('game', 'game-over')).toEqual({ kind: 'navigate', route: 'home' });
  });

  it('treats only the giver and guesser screens as private', () => {
    expect(['choose-word', 'clue', 'guess'].map((p) => isPublicPhase(p as never))).toEqual([false, false, false]);
    expect(
      ['handoff-giver', 'handoff-guesser', 'round-result', 'turn-result', 'game-over'].map((p) => isPublicPhase(p as never)),
    ).toEqual([true, true, true, true, true]);
  });
});

describe('checker history', () => {
  const entry = (id: number, a: string, b: string): CheckEntry => ({ id, a, b, raw: 0.5, score: 0.9 });

  it('puts the newest first, de-duplicates pairs in either order and caps the length', () => {
    let history: CheckEntry[] = [];
    history = addCheck(history, entry(1, 'cat', 'dog'));
    history = addCheck(history, entry(2, 'sea', 'ocean'));
    history = addCheck(history, entry(3, 'dog', 'cat'));
    expect(history.map((e) => e.id)).toEqual([3, 2]);
    for (let i = 10; i < 30; i++) history = addCheck(history, entry(i, `a${i}`, `b${i}`));
    expect(history).toHaveLength(MAX_CHECK_HISTORY);
    expect(history[0].id).toBe(29);
  });
});

describe('theme', () => {
  it('follows the colour scheme and defines the same tokens in both', () => {
    expect(themeFor('dark').dark).toBe(true);
    expect(themeFor('light').dark).toBe(false);
    expect(themeFor(null).dark).toBe(false);
    expect(themeFor('unspecified').dark).toBe(false);
    expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
  });

  it('keeps status text at WCAG AA contrast (4.5:1) on every background it is used on', () => {
    const channel = (hex: string, at: number) => {
      const c = parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    for (const [name, colors] of [['light', lightColors], ['dark', darkColors]] as const) {
      const pairs = [
        ['success', colors.success, colors.successSoft],
        ['danger', colors.danger, colors.dangerSoft],
        ['warning', colors.warning, colors.warningSoft],
        ['success', colors.success, colors.bg],
        ['danger', colors.danger, colors.bg],
        ['warning', colors.warning, colors.bg],
        ['success', colors.success, colors.surface],
        ['danger', colors.danger, colors.surface],
        ['warning', colors.warning, colors.surface],
      ] as const;
      for (const [token, fg, bg] of pairs) {
        expect([name, token, bg, contrast(fg, bg) >= 4.5]).toEqual([name, token, bg, true]);
      }
    }
  });

  it('cycles player colours', () => {
    expect(playerColor(0)).toBe(PLAYER_COLORS[0]);
    expect(playerColor(PLAYER_COLORS.length)).toBe(PLAYER_COLORS[0]);
    expect(playerColor(-1)).toBe(PLAYER_COLORS[PLAYER_COLORS.length - 1]);
  });
});
