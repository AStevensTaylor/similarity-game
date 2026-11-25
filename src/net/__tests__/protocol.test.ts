import { describe, expect, test } from '@jest/globals';
import {
  MAX_LINE_BYTES,
  MAX_NAME_LENGTH,
  PROTOCOL_VERSION,
  cleanPlayerName,
  createToken,
  decodeLine,
  encodeLine,
  isGuessWord,
  isValidToken,
  parseClientMessage,
  parseHostMessage,
  parsePlayerView,
  playerNameKey,
  uniquePlayerName,
} from '../protocol';
import type { ClientMessage, HostMessage } from '../protocol';
import type { PlayerView } from '../view';
import { settings } from './harness';

const V = PROTOCOL_VERSION;
const TOKEN = 'abcdefgh-TOKEN_0123';

const VALID_CLIENT: ClientMessage[] = [
  { v: V, t: 'hello', name: 'Ann', token: TOKEN },
  { v: V, t: 'ping', n: 3 },
  { v: V, t: 'pong', n: 3 },
  { v: V, t: 'leave' },
  { v: V, t: 'start' },
  { v: V, t: 'choose', word: 'apple' },
  { v: V, t: 'clue', id: 1, clue: 'fruit' },
  { v: V, t: 'forfeit' },
  { v: V, t: 'guess', guess: 'apple' },
  { v: V, t: 'next', step: 12 },
  { v: V, t: 'skip', seat: 2 },
  { v: V, t: 'forfeitGiver' },
  { v: V, t: 'remove', seat: 2 },
  { v: V, t: 'again' },
];

function lobbyView(): PlayerView {
  return {
    stage: 'lobby',
    you: { seat: 1, name: 'Bob', isHost: false },
    players: [
      { seat: 0, id: null, name: 'Ann', score: 0, connected: true, isHost: true },
      { seat: 1, id: null, name: 'Bob', score: 0, connected: true, isHost: false },
    ],
    settings: settings(),
    minPlayers: 2,
    maxPlayers: 8,
    continueBy: 'host',
    game: null,
    host: null,
  };
}

function gameView(): PlayerView {
  return {
    ...lobbyView(),
    stage: 'game',
    players: [
      { seat: 0, id: 'p1', name: 'Ann', score: 1, connected: true, isHost: true },
      { seat: 1, id: 'p2', name: 'Bob', score: 0, connected: false, isHost: false },
    ],
    game: {
      step: 9,
      phase: 'guess',
      turnNumber: 1,
      totalTurns: 4,
      clueRound: 2,
      giverSeat: 0,
      role: 'guesser',
      acceptedClues: [
        { clue: 'fruit', score: 0.96 },
        { clue: 'tree', score: 0.97 },
      ],
      guessOptions: ['a', 'b', 'c', 'd', 'e'],
      guessStatus: [{ seat: 1, status: 'pending' }],
      yourGuess: null,
      giver: null,
      rounds: [
        {
          round: 1,
          clue: 'fruit',
          score: 0.96,
          guesses: [{ playerId: 'p2', guess: '', correct: false, skipped: true }],
          anyCorrect: false,
          correctGuesserIds: [],
          giverPointsAwarded: 1,
        },
      ],
      giverTurnPoints: 1,
      rewardIfRoundFails: 2,
      turnSummary: null,
      canContinue: false,
    },
  };
}

describe('parseClientMessage', () => {
  test.each(VALID_CLIENT.map((m) => [m.t, m] as const))('accepts %s and returns a clean copy', (_t, msg) => {
    const withJunk = { ...msg, extra: { nested: [1, 2, 3] }, seat: (msg as { seat?: number }).seat ?? 7, __proto__: null };
    const r = parseClientMessage(JSON.parse(JSON.stringify(withJunk)));
    expect(r).toEqual({ ok: true, msg });
    if (r.ok) expect(Object.keys(r.msg).sort()).toEqual(Object.keys(msg).sort());
  });

  test.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'hello'],
    ['a number', 5],
    ['an array', [{ v: V, t: 'start' }]],
    ['no version', { t: 'start' }],
    ['string version', { v: '1', t: 'start' }],
    ['fractional version', { v: 1.5, t: 'start' }],
    ['no type', { v: V }],
    ['numeric type', { v: V, t: 5 }],
    ['unknown type', { v: V, t: 'selfdestruct' }],
    ['prototype-ish type', { v: V, t: '__proto__' }],
    ['very long type', { v: V, t: 'x'.repeat(100) }],
    ['hello without token', { v: V, t: 'hello', name: 'Ann' }],
    ['hello with short token', { v: V, t: 'hello', name: 'Ann', token: 'short' }],
    ['hello with odd token chars', { v: V, t: 'hello', name: 'Ann', token: 'has spaces in it!!' }],
    ['hello with long token', { v: V, t: 'hello', name: 'Ann', token: 'a'.repeat(65) }],
    ['hello with numeric name', { v: V, t: 'hello', name: 5, token: TOKEN }],
    ['hello with huge name', { v: V, t: 'hello', name: 'n'.repeat(201), token: TOKEN }],
    ['guess too long', { v: V, t: 'guess', guess: 'g'.repeat(41) }],
    ['guess empty', { v: V, t: 'guess', guess: '' }],
    ['guess object', { v: V, t: 'guess', guess: { toString: 'x' } }],
    ['guess array', { v: V, t: 'guess', guess: ['apple'] }],
    ['choose missing word', { v: V, t: 'choose' }],
    ['choose too long', { v: V, t: 'choose', word: 'w'.repeat(41) }],
    ['clue without id', { v: V, t: 'clue', clue: 'fruit' }],
    ['clue with negative id', { v: V, t: 'clue', id: -1, clue: 'fruit' }],
    ['clue too long', { v: V, t: 'clue', id: 1, clue: 'c'.repeat(41) }],
    ['next without step', { v: V, t: 'next' }],
    ['next with NaN-ish step', { v: V, t: 'next', step: null }],
    ['next with huge step', { v: V, t: 'next', step: 1e15 }],
    ['skip with string seat', { v: V, t: 'skip', seat: '1' }],
    ['remove with fractional seat', { v: V, t: 'remove', seat: 1.5 }],
    ['ping without n', { v: V, t: 'ping' }],
  ])('rejects %s', (_label, raw) => {
    expect(parseClientMessage(raw)).toEqual({ ok: false, reason: 'invalid' });
  });

  test('a well-formed envelope of another version is reported as a version mismatch', () => {
    expect(parseClientMessage({ v: V + 1, t: 'hello', name: 'Ann', token: TOKEN })).toEqual({
      ok: false,
      reason: 'version',
      version: V + 1,
    });
    expect(parseClientMessage({ v: 0, t: 'whatever-the-future-brings' })).toEqual({ ok: false, reason: 'version', version: 0 });
  });

  test('host-only message types are not client messages', () => {
    for (const t of ['welcome', 'view', 'refused', 'clueResult', 'bye']) {
      expect(parseClientMessage({ v: V, t, seat: 0, name: 'x', view: lobbyView() })).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('parseHostMessage', () => {
  const VALID_HOST: HostMessage[] = [
    { v: V, t: 'welcome', seat: 3, name: 'Ann 2' },
    { v: V, t: 'refused', reason: 'full', hostVersion: V },
    { v: V, t: 'refused', reason: 'in-progress', hostVersion: V },
    { v: V, t: 'refused', reason: 'removed', hostVersion: V },
    { v: V, t: 'view', view: lobbyView() },
    { v: V, t: 'view', view: gameView() },
    { v: V, t: 'clueResult', id: 2, result: { kind: 'accepted', clue: 'fruit', score: 0.97, raw: 0.71 } },
    { v: V, t: 'clueResult', id: 2, result: { kind: 'rejected', clue: 'fruit', score: 0.4, raw: 0.2 } },
    { v: V, t: 'clueResult', id: 2, result: { kind: 'invalid', reason: 'not-a-noun', message: 'no' } },
    { v: V, t: 'clueResult', id: 2, result: { kind: 'error', message: 'model not ready' } },
    { v: V, t: 'clueResult', id: 2, result: { kind: 'busy' } },
    { v: V, t: 'ping', n: 1 },
    { v: V, t: 'pong', n: 1 },
    { v: V, t: 'bye', reason: 'host-left' },
    { v: V, t: 'bye', reason: 'removed' },
    { v: V, t: 'bye', reason: 'replaced' },
  ];

  test.each(VALID_HOST.map((m, i) => [`${m.t} #${i}`, m] as const))('accepts %s', (_label, msg) => {
    expect(parseHostMessage(JSON.parse(JSON.stringify({ ...msg, junk: true })))).toEqual({ ok: true, msg });
  });

  test('another version is reported as a version mismatch, whatever the type', () => {
    expect(parseHostMessage({ v: V + 1, t: 'refused', reason: 'version', hostVersion: V + 1 })).toEqual({
      ok: false,
      reason: 'version',
      version: V + 1,
    });
  });

  test.each<[string, unknown]>([
    ['unknown type', { v: V, t: 'hello', name: 'x', token: TOKEN }],
    ['welcome without seat', { v: V, t: 'welcome', name: 'x' }],
    ['refused with odd reason', { v: V, t: 'refused', reason: 'because', hostVersion: V }],
    ['bye with odd reason', { v: V, t: 'bye', reason: 'bored' }],
    ['view missing', { v: V, t: 'view' }],
    ['clueResult with unknown kind', { v: V, t: 'clueResult', id: 1, result: { kind: 'maybe' } }],
    ['clueResult with NaN-ish score', { v: V, t: 'clueResult', id: 1, result: { kind: 'accepted', clue: 'x', score: null, raw: 0 } }],
    ['clueResult with unknown reason', { v: V, t: 'clueResult', id: 1, result: { kind: 'invalid', reason: 'x', message: '' } }],
  ])('rejects %s', (_label, raw) => {
    expect(parseHostMessage(raw)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('parsePlayerView', () => {
  test('accepts valid views and drops unknown keys', () => {
    expect(parsePlayerView({ ...lobbyView(), secret: 'x' })).toEqual(lobbyView());
    const g = gameView();
    const dirty = JSON.parse(JSON.stringify(g)) as { game: { hiddenWord?: string } };
    dirty.game.hiddenWord = 'smuggled';
    expect(parsePlayerView(dirty)).toEqual(g);
  });

  const broken: [string, (v: PlayerView) => unknown][] = [
    ['stage', (v) => ({ ...v, stage: 'limbo' })],
    ['you missing', (v) => ({ ...v, you: null })],
    ['you not among the players', (v) => ({ ...v, you: { ...v.you, seat: 42 } })],
    ['players not an array', (v) => ({ ...v, players: { length: 2 } })],
    ['too many players', (v) => ({ ...v, players: Array.from({ length: 9 }, (_, i) => ({ ...v.players[0], seat: i })) })],
    ['player with a huge name', (v) => ({ ...v, players: [{ ...v.players[0], name: 'x'.repeat(500) }, v.players[1]] })],
    ['player with a negative score', (v) => ({ ...v, players: [{ ...v.players[0], score: -1 }, v.players[1]] })],
    ['settings out of range', (v) => ({ ...v, settings: { ...v.settings, threshold: 0.2 } })],
    ['settings with odd guess mode', (v) => ({ ...v, settings: { ...v.settings, guessMode: 'telepathy' } })],
    ['game stage without a game', (v) => ({ ...v, stage: 'game' })],
    ['lobby stage with a game', (v) => ({ ...gameView(), stage: 'lobby', you: v.you })],
    ['unknown phase', () => ({ ...gameView(), game: { ...gameView().game, phase: 'handoff-giver' } })],
    ['giver seat not a player', () => ({ ...gameView(), game: { ...gameView().game, giverSeat: 77 } })],
    ['six options', () => ({ ...gameView(), game: { ...gameView().game, guessOptions: ['a', 'b', 'c', 'd', 'e', 'f'] } })],
    ['option not a string', () => ({ ...gameView(), game: { ...gameView().game, guessOptions: ['a', 2] } })],
    ['oversize clue', () => ({ ...gameView(), game: { ...gameView().game, acceptedClues: [{ clue: 'x'.repeat(100), score: 1 }] } })],
    ['score out of range', () => ({ ...gameView(), game: { ...gameView().game, acceptedClues: [{ clue: 'x', score: 7 }] } })],
    ['bad round guess', () => ({ ...gameView(), game: { ...gameView().game, rounds: [{ ...gameView().game!.rounds[0], guesses: [{ playerId: 'p2' }] }] } })],
    ['bad guess status', () => ({ ...gameView(), game: { ...gameView().game, guessStatus: [{ seat: 1, status: 'thinking' }] } })],
    ['bad giver block', () => ({ ...gameView(), game: { ...gameView().game, giver: { options: 'all of them' } } })],
    ['bad turn summary', () => ({ ...gameView(), game: { ...gameView().game, turnSummary: { outcome: 'draw' } } })],
    ['bad host controls', (v) => ({ ...v, host: { canStart: 'yes' } })],
  ];
  test.each(broken)('rejects a view with a bad %s', (_label, mutate) => {
    expect(parsePlayerView(JSON.parse(JSON.stringify(mutate(lobbyView()))))).toBeNull();
  });

  test('rejects non-objects', () => {
    for (const x of [null, undefined, 3, 'view', [], [lobbyView()]]) expect(parsePlayerView(x)).toBeNull();
  });
});

describe('names and tokens', () => {
  test('cleanPlayerName trims, collapses whitespace, strips control characters and cuts to the limit', () => {
    expect(cleanPlayerName('  Ann   Marie \n')).toBe('Ann Marie');
    expect(cleanPlayerName('A\u0000n\u0007n')).toBe('A n n');
    expect(cleanPlayerName('x'.repeat(50))).toBe('x'.repeat(MAX_NAME_LENGTH));
    expect(cleanPlayerName(' \t​ ')).toBe('');
    expect(Array.from(cleanPlayerName('😀'.repeat(30)))).toHaveLength(MAX_NAME_LENGTH);
  });

  test('uniquePlayerName suffixes clashes (ignoring case) and stays within the limit', () => {
    expect(uniquePlayerName('Ann', [])).toBe('Ann');
    expect(uniquePlayerName('ann', ['Ann'])).toBe('ann 2');
    expect(uniquePlayerName(' ANN ', ['Ann', 'ann 2'])).toBe('ANN 3');
    expect(uniquePlayerName('', [])).toBe('Player');
    expect(uniquePlayerName('   ', ['Player'])).toBe('Player 2');
    const long = 'x'.repeat(MAX_NAME_LENGTH);
    const second = uniquePlayerName(long, [long]);
    expect(second).toBe(`${'x'.repeat(MAX_NAME_LENGTH - 2)} 2`);
    expect(second.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    // The suffixed form can itself be taken.
    expect(uniquePlayerName('Ann', ['Ann', 'Ann 2', 'ann 3'])).toBe('Ann 4');
  });

  // Written as code points: these characters are invisible, which is the whole problem.
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  const INVISIBLE: [string, number][] = [
    ['soft hyphen', 0x00ad],
    ['combining grapheme joiner', 0x034f],
    ['Arabic letter mark', 0x061c],
    ['Hangul choseong filler', 0x115f],
    ['Mongolian vowel separator', 0x180e],
    ['word joiner', 0x2060],
    ['bidi isolate', 0x2066],
    ['blank braille', 0x2800],
    ['Hangul filler', 0x3164],
    ['variation selector', 0xfe0f],
    ['halfwidth Hangul filler', 0xffa0],
    ['tag character', 0xe0041],
  ];

  test.each(INVISIBLE)('an invisible %s cannot make a name look like another one, or blank', (_what, point) => {
    const ch = cp(point);
    expect(cleanPlayerName(`Host${ch}`)).toBe('Host');
    expect(cleanPlayerName(`Ho${ch}st`)).toBe('Host');
    expect(uniquePlayerName(`Host${ch}`, ['Host'])).toBe('Host 2');
    expect(uniquePlayerName(`${ch}Ho${ch}st`, ['Host', 'Host 2'])).toBe('Host 3');
    // On its own it is no name at all.
    expect(cleanPlayerName(ch.repeat(3))).toBe('');
    expect(uniquePlayerName(ch, [])).toBe('Player');
  });

  test('names that read the same count as the same: spacing, width, look-alike letters, lone surrogates', () => {
    expect(uniquePlayerName('Ho st', ['Host'])).toBe('Ho st 2');
    expect(uniquePlayerName(`Ho${cp(0x200b)}st`, ['Host'])).toBe('Ho st 2'); // zero-width space: cleaned to a space
    expect(uniquePlayerName(cp(0xff28, 0xff4f, 0xff53, 0xff54), ['Host'])).toBe(`${cp(0xff28, 0xff4f, 0xff53, 0xff54)} 2`); // fullwidth
    expect(uniquePlayerName(`H${cp(0x043e)}st`, ['Host'])).toBe(`H${cp(0x043e)}st 2`); // Cyrillic o
    expect(uniquePlayerName(`H${cp(0x03bf)}st`, ['host'])).toBe(`H${cp(0x03bf)}st 2`); // Greek omicron
    expect(playerNameKey(`  H${cp(0x043e)} S${cp(0x00ad)}T `)).toBe('host');
    expect(cleanPlayerName(`A${String.fromCharCode(0xd800)}b`)).toBe('Ab');
    // Different names stay different, and ordinary non-Latin names are untouched.
    expect(uniquePlayerName('Hosta', ['Host'])).toBe('Hosta');
    const cyrillic = cp(0x0418, 0x0432, 0x0430, 0x043d); // "Ivan" in Cyrillic
    expect(cleanPlayerName(cyrillic)).toBe(cyrillic);
    expect(uniquePlayerName(cyrillic, ['Host'])).toBe(cyrillic);
    expect(Array.from(cleanPlayerName(cp(0x1f600).repeat(30)))).toHaveLength(MAX_NAME_LENGTH);
  });

  test('isGuessWord: one word of a-z after trimming and lower-casing, within the wire limit', () => {
    for (const ok of ['apple', ' Apple ', 'APPLE', 'a', 'x'.repeat(40)]) expect(isGuessWord(ok)).toBe(true);
    const grows = cp(0x0130).repeat(40); // capital I with dot: two units once lower-cased
    expect(grows).toHaveLength(40);
    expect(grows.toLowerCase().length).toBeGreaterThan(40);
    for (const bad of ['', '   ', 'two words', 'a\nb', 'abc1', "it's", 'x'.repeat(41), grows, cp(0x0130), `a${cp(0x202e)}b`, 'a\u0000b', `caf${cp(0xe9)}`]) {
      expect(isGuessWord(bad)).toBe(false);
    }
  });

  test('tokens', () => {
    const a = createToken();
    const b = createToken();
    expect(isValidToken(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(isValidToken('short')).toBe(false);
    expect(isValidToken(12345678)).toBe(false);
    expect(isValidToken('with space 123')).toBe(false);
  });
});

describe('line framing helpers', () => {
  test('round trip', () => {
    const line = encodeLine({ v: V, t: 'ping', n: 1 });
    expect(line).toBe('{"v":1,"t":"ping","n":1}'.replace('"v":1', `"v":${V}`));
    expect(decodeLine(line as string)).toEqual({ v: V, t: 'ping', n: 1 });
  });

  test('oversize, non-object and broken lines are refused', () => {
    expect(encodeLine({ x: 'a'.repeat(MAX_LINE_BYTES) })).toBeNull();
    // Multi-byte characters count by bytes, not characters.
    expect(encodeLine({ x: 'é'.repeat(MAX_LINE_BYTES / 2) })).toBeNull();
    expect(encodeLine({ x: 'a'.repeat(1000) })).not.toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(encodeLine(circular)).toBeNull();
    expect(decodeLine('{"a":')).toBeNull();
    expect(decodeLine('[1,2]')).toBeNull();
    expect(decodeLine('"text"')).toBeNull();
    expect(decodeLine('null')).toBeNull();
    expect(decodeLine(`{"x":"${'a'.repeat(MAX_LINE_BYTES)}"}`)).toBeNull();
  });
});
