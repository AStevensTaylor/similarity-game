/**
 * Design tokens for the app: colours (light + dark), spacing, radii and type
 * sizes. Components read them through useTheme(), which follows the system
 * colour scheme.
 */
import { useColorScheme } from 'react-native';

export interface ThemeColors {
  bg: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentPressed: string;
  /** Darker edge under primary buttons (gives them a chunky, game-like depth). */
  accentEdge: string;
  onAccent: string;
  accentSoft: string;
  onAccentSoft: string;
  success: string;
  successSoft: string;
  danger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  overlay: string;
}

export interface Theme {
  dark: boolean;
  colors: ThemeColors;
}

export const lightColors: ThemeColors = {
  bg: '#F6F3FF',
  surface: '#FFFFFF',
  surfaceAlt: '#EEE8FF',
  text: '#1B1533',
  textMuted: '#5E5780',
  border: '#DDD5F5',
  accent: '#6C3BF5',
  accentPressed: '#5527D9',
  accentEdge: '#4A1FC2',
  onAccent: '#FFFFFF',
  accentSoft: '#E7DEFF',
  onAccentSoft: '#4319B8',
  success: '#0E6B4C',
  successSoft: '#D9F5EA',
  danger: '#B3263F',
  dangerSoft: '#FBE1E6',
  warning: '#8A5800',
  warningSoft: '#FFF0CF',
  overlay: 'rgba(20, 12, 50, 0.55)',
};

export const darkColors: ThemeColors = {
  bg: '#120E24',
  surface: '#1D1736',
  surfaceAlt: '#2A2250',
  text: '#F3F0FF',
  textMuted: '#B1A8D6',
  border: '#3A3166',
  accent: '#A586FF',
  accentPressed: '#8E6BF5',
  accentEdge: '#6C4BD6',
  onAccent: '#160B3A',
  accentSoft: '#34286B',
  onAccentSoft: '#D9CCFF',
  success: '#5FD9A8',
  successSoft: '#113B2D',
  danger: '#FF8296',
  dangerSoft: '#4A1722',
  warning: '#FFC65C',
  warningSoft: '#43310A',
  overlay: 'rgba(0, 0, 0, 0.65)',
};

export const lightTheme: Theme = { dark: false, colors: lightColors };
export const darkTheme: Theme = { dark: true, colors: darkColors };

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { sm: 10, md: 16, lg: 24, pill: 999 } as const;
export const fontSize = { caption: 13, body: 16, bodyLarge: 18, title: 22, heading: 28, display: 40 } as const;

/** Minimum touch target edge, in dp. */
export const TAP_TARGET = 48;
/** Content never grows wider than this (tablets, landscape). */
export const MAX_CONTENT_WIDTH = 560;

/** Avatar colours, one per seat. All carry white text at >= 4.5:1. */
export const PLAYER_COLORS: readonly string[] = [
  '#6C3BF5',
  '#C2306B',
  '#0B7A7A',
  '#B45309',
  '#1D64C8',
  '#2E7D32',
  '#9B2FB0',
  '#6D5600',
];

export function playerColor(index: number): string {
  const n = PLAYER_COLORS.length;
  return PLAYER_COLORS[((index % n) + n) % n];
}

export function themeFor(scheme: string | null | undefined): Theme {
  return scheme === 'dark' ? darkTheme : lightTheme;
}

export function useTheme(): Theme {
  return themeFor(useColorScheme());
}
