import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createClientSession } from '../clientSession';
import { MemoryNetwork } from '../memoryAdapter';
import { PROTOCOL_VERSION } from '../protocol';
import type { Json } from '../transport';
import type { PlayerView } from '../view';
import {
  HOST_ADDRESS,
  RawClient,
  badClue,
  deferred,
  flush,
  okClue,
  rawJoin,
  settings,
  setup,
  submitClue,
  toGuessPhase,
} from './harness';

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

const V = PROTOCOL_VERSION;

/** A scripted "host" for testing the client against hostile or future hosts. */
async function fakeHost(net: MemoryNetwork) {
  const adapter = net.createAdapter('10.0.9.9');
  const peers: number[] = [];
  const got: Json[] = [];
  const transport = await adapter.startHost(
    { name: 'Fake' },
    {
      onPeer: (id) => {
        peers.push(id);
      },
      onMessage: (_id, msg) => {
        got.push(msg);
      },
      onPeerGone: () => undefined,
      onError: () => undefined,
    },
  );
  const client = createClientSession({
    adapter: net.createAdapter(),
    target: { host: '10.0.9.9', port: transport.port },
    name: 'Victim',
  });
  client.start();
  await flush();
  return { transport, peers, got, client };
}

function lobbyView(seat: number): PlayerView {
  return {
    stage: 'lobby',
    you: { seat, name: 'Victim', isHost: false },
    players: [{ seat, id: null, name: 'Victim', score: 0, connected: true, isHost: false }],
    settings: settings(),
    minPlayers: 2,
    maxPlayers: 8,
    continueBy: 'host',
    game: null,
    host: null,
  };
}

describe('a client can only act for its own seat and role', () => {
  test('a guesser cannot choose the word, give clues, forfeit or use host controls', async () => {
    const h = await setup({ players: 3 });
    const before = h.host.debugState();
    expect(h.giverIndex()).toBe(0);

    const guesser = h.clients[1];
    guesser.chooseWord(before.game!.options[0]);
    guesser.forfeit();
    guesser.startGame();
    guesser.skipGuesser(h.view(2).you.seat);
    guesser.forfeitGiver();
    guesser.removePlayer(h.view(0).you.seat);
    guesser.removePlayer(h.view(2).you.seat);
    guesser.playAgain();
    guesser.next();
    guesser.submitGuess('early');
    expect(await submitClue(guesser, okClue())).toEqual({ kind: 'error', message: 'It is not time to give a clue.' });

    // Not one of those changed anything on the host.
    expect(h.host.debugState()).toBe(before);
    expect(h.gameView(0).phase).toBe('choose-word');
    expect(guesser.getSnapshot().status).toBe('connected');
  });

  test('once a word is chosen a guesser still cannot give the clue, and never learns the word from trying', async () => {
    const h = await setup({ players: 3 });
    h.clients[0].chooseWord(h.game().options[3]);
    const word = h.game().hiddenWord as string;
    const before = h.host.debugState();
    const result = await submitClue(h.clients[2], okClue());
    expect(result.kind).toBe('error');
    expect(JSON.stringify(result)).not.toContain(word);
    expect(h.host.debugState()).toBe(before);
    expect(JSON.stringify(h.clients[2].getSnapshot())).not.toContain(word);
  });

  test('the giver cannot guess their own word', async () => {
    const h = await setup({ players: 3 });
    const { word } = await toGuessPhase(h);
    const before = h.host.debugState();
    h.clients[0].submitGuess(word);
    expect(h.host.debugState()).toBe(before);
    expect(h.gameView(0).yourGuess).toBeNull();
  });

  test('identity fields inside a message are ignored: the seat comes from the connection', async () => {
    const h = await setup({ players: 2, startGame: false });
    const mallory = await rawJoin(h, 'Mallory');
    await h.start();
    const hostSeat = h.view(0).you.seat;
    const p2Seat = h.view(1).you.seat;
    const mallorySeat = mallory.view().you.seat;
    expect(new Set([hostSeat, p2Seat, mallorySeat]).size).toBe(3);

    // Pretending to be the host / the giver.
    const before = h.host.debugState();
    mallory.send('choose', { word: h.game().options[0], seat: hostSeat, playerId: 'p1', isHost: true });
    mallory.send('start', { seat: hostSeat });
    mallory.send('forfeitGiver', { seat: hostSeat, isHost: true });
    mallory.send('skip', { seat: p2Seat, from: hostSeat });
    mallory.send('next', { step: before.step, seat: hostSeat });
    expect(h.host.debugState()).toBe(before);

    // Pretending to guess for somebody else: it counts as Mallory's own guess.
    await toGuessPhase(h);
    mallory.send('guess', { guess: 'forged', seat: p2Seat, playerId: 'p2', you: { seat: p2Seat } });
    expect(h.host.debugState().pendingGuesses).toEqual({ p3: 'forged' });
    expect(h.gameView(1).yourGuess).toBeNull();
    expect(h.gameView(1).guessStatus).toEqual([
      { seat: p2Seat, status: 'pending' },
      { seat: mallorySeat, status: 'submitted' },
    ]);
    expect(mallory.gameView().yourGuess).toBe('forged');
    // ... and Mallory was never sent anything private.
    const word = h.game().hiddenWord as string;
    expect(JSON.stringify(mallory.received)).not.toContain(word);
  });

  test('a remote peer cannot take the host seat, even with the host token', async () => {
    const h = await setup({ players: 2 });
    const thief = new RawClient(h.net.createAdapter(), h.port);
    await flush();
    thief.hello('Host', h.host.client.token);
    await flush();
    expect(thief.ofType('welcome')).toEqual([]);
    expect(thief.ofType('refused')).toHaveLength(1);
    expect(thief.ofType('view')).toEqual([]);
    expect(h.host.client.getSnapshot().status).toBe('connected');
    expect(h.view(0).you.isHost).toBe(true);
    jest.advanceTimersByTime(1000);
    await flush();
    expect(thief.closed).toBe('closed');
  });

  test('messages before hello are ignored and give nothing away', async () => {
    const h = await setup({ players: 2 });
    const before = h.host.debugState();
    const stranger = new RawClient(h.net.createAdapter(), h.port);
    await flush();
    stranger.send('start');
    stranger.send('choose', { word: h.game().options[0] });
    stranger.send('guess', { guess: 'x' });
    stranger.send('next', { step: before.step });
    stranger.send('skip', { seat: 1 });
    stranger.send('forfeitGiver');
    expect(h.host.debugState()).toBe(before);
    expect(stranger.received).toEqual([]);
    // Not even a ping is answered before hello: a stranger cannot keep the host busy.
    stranger.send('ping', { n: 5 });
    expect(stranger.received).toEqual([]);
  });

  test('a connection that never says hello is dropped after 5 seconds', async () => {
    const h = await setup({ players: 2 });
    const idle = new RawClient(h.net.createAdapter(), h.port);
    await flush();
    jest.advanceTimersByTime(4900);
    await flush();
    expect(idle.closed).toBeNull();
    jest.advanceTimersByTime(200);
    await flush();
    expect(idle.closed).toBe('closed');
    expect(h.view(0).players).toHaveLength(2);
  });

  test('a second hello on a seated connection is ignored', async () => {
    const h = await setup({ players: 2, startGame: false });
    const raw = await rawJoin(h, 'Twice');
    raw.hello('Other', 'another-token-12345');
    raw.hello('Twice');
    expect(h.view(0).players.map((p) => p.name)).toEqual(['Host', 'P2', 'Twice']);
    expect(raw.ofType('welcome')).toHaveLength(1);
  });
});

describe('malformed and hostile input', () => {
  const garbage: unknown[] = [
    {},
    { v: V },
    { t: 'guess', guess: 'no version' },
    { v: V, t: 'selfdestruct' },
    { v: V, t: 'guess' },
    { v: V, t: 'guess', guess: 42 },
    { v: V, t: 'guess', guess: ['a'] },
    { v: V, t: 'guess', guess: { length: 3 } },
    { v: V, t: 'guess', guess: 'x'.repeat(41) },
    { v: V, t: 'guess', guess: 'y'.repeat(5000) },
    { v: V, t: 'choose', word: null },
    { v: V, t: 'choose', word: 'z'.repeat(1000) },
    { v: V, t: 'clue', id: 'one', clue: 'word' },
    { v: V, t: 'clue', id: 1, clue: { evil: true } },
    { v: V, t: 'clue', id: 1, clue: 'c'.repeat(41) },
    { v: V, t: 'next', step: 'now' },
    { v: V, t: 'next', step: -1 },
    { v: V, t: 'next', step: 1e300 },
    { v: V, t: 'skip', seat: null },
    { v: V, t: 'remove', seat: [0] },
    { v: V, t: 'view', view: {} },
    { v: V, t: 'welcome', seat: 0, name: 'Host' },
    { v: V, t: ['guess'] },
    { v: V, t: 'toString' },
    { v: V, t: 'constructor' },
    { v: '1', t: 'guess', guess: 'x' },
    { v: V, t: 'guess', guess: 'ok', nested: { a: { b: { c: [1, [2, [3]]] } } } },
  ];

  test('garbage from a seated player changes nothing and crashes nothing', async () => {
    const h = await setup({ players: 1, startGame: false });
    // Two hostile players, so neither reaches the limit of invalid messages.
    const raw = await rawJoin(h, 'Fuzz');
    const raw2 = await rawJoin(h, 'Fuzzier');
    await h.start();
    await toGuessPhase(h);
    const before = h.host.debugState();
    // The one valid-looking entry at the end is a real guess; everything before it is ignored.
    const bad = garbage.slice(0, -1);
    expect(bad.length).toBeGreaterThan(20);
    bad.forEach((msg, i) => (i % 2 === 0 ? raw : raw2).sendRaw(msg));
    expect(h.host.debugState()).toBe(before);
    expect(h.host.getSnapshot().status).toBe('open');
    expect(h.host.getSnapshot().error).toBeNull();
    expect(raw.closed).toBeNull();
    raw.sendRaw(garbage[garbage.length - 1]);
    expect(h.host.debugState().pendingGuesses).toEqual({ p2: 'ok' });
    // The game still works.
    raw2.send('guess', { guess: 'fine' });
    expect(h.game().phase).toBe('round-result');
    expect(h.game().rounds[0].guesses.map((g) => g.guess)).toEqual(['ok', 'fine']);
  });

  test('non-objects are never delivered as messages', async () => {
    const h = await setup({ players: 2 });
    const before = h.host.debugState();
    const raw = await rawJoin(h, 'Odd');
    for (const x of [null, 5, 'start', [1, 2, 3], [{ v: V, t: 'start' }], true]) raw.sendRaw(x);
    expect(h.host.debugState()).toBe(before);
  });

  test('a peer that keeps sending invalid messages is dropped; its seat shows as disconnected', async () => {
    const h = await setup({ players: 2, startGame: false });
    const raw = await rawJoin(h, 'Flood');
    await h.start();
    for (let i = 0; i < 20; i++) raw.send('nonsense', { i });
    await flush();
    expect(raw.closed).toBeNull();
    expect(h.view(0).players[2].connected).toBe(true);
    raw.send('nonsense');
    await flush();
    expect(raw.closed).toBe('closed');
    expect(h.view(0).players[2]).toMatchObject({ name: 'Flood', connected: false });
    expect(h.view(1).players[2].connected).toBe(false);
  });

  test('a message over 64 KB gets the sender dropped, never reaches the session, and the game goes on', async () => {
    const h = await setup({ players: 2, startGame: false });
    const raw = await rawJoin(h, 'Big');
    await h.start();
    const before = h.host.debugState().game;
    expect(raw.send('guess', { guess: 'x', padding: 'p'.repeat(70 * 1024) })).toBe(false);
    await flush();
    expect(raw.closed).toBe('error');
    expect(h.host.debugState().game).toBe(before);
    expect(h.view(0).players[2].connected).toBe(false);
    // Just under the limit is delivered (and the oversize string field is then rejected by validation).
    const raw2 = await rawJoin(h, 'Big', 'rawtoken-Big-0000');
    expect(raw2.ofType('welcome')).toHaveLength(1);
    expect(raw2.send('guess', { guess: 'g'.repeat(60 * 1024) })).toBe(true);
    expect(h.host.debugState().game).toBe(before);
    expect(h.view(0).players[2].connected).toBe(true);
  });

  test('odd names are cleaned, cut and made unique; a blank name gets a default', async () => {
    const h = await setup({ players: 1, startGame: false });
    await rawJoin(h, '  host  ', 'token-aaaaaaaa');
    await rawJoin(h, 'HOST', 'token-bbbbbbbb');
    await rawJoin(h, '', 'token-cccccccc');
    await rawJoin(h, '   ', 'token-dddddddd');
    await rawJoin(h, 'a'.repeat(150), 'token-eeeeeeee');
    await rawJoin(h, `line\nbreak\ttab`, 'token-ffffffff');
    expect(h.view(0).players.map((p) => p.name)).toEqual([
      'Host',
      'host 2',
      'HOST 3',
      'Player',
      'Player 2',
      'a'.repeat(16),
      'line break tab',
    ]);
    const tooLong = new RawClient(h.net.createAdapter(), h.port);
    await flush();
    tooLong.hello('n'.repeat(201), 'token-gggggggg');
    expect(tooLong.ofType('welcome')).toEqual([]);
    expect(h.view(0).players).toHaveLength(7);
  });

  test('a clue that breaks the rules is reported as invalid, costs nothing and is never scored', async () => {
    const score = jest.fn(async () => ({ raw: 0.7, score: 0.97 }));
    const h = await setup({ players: 2, score, isNoun: (w) => w !== 'notanoun' });
    h.clients[0].chooseWord(h.game().options[0]);
    const option = h.game().options[1];
    const before = h.host.debugState();
    const cases: [string, string][] = [
      ['', 'empty'],
      ['two words', 'not-single-word'],
      ['dig1t', 'invalid-characters'],
      ['x', 'too-short'],
      ['abcdefghijklmnopqrstuvwxyz', 'too-long'],
      [option, 'matches-option'],
      [`${option}zz`, 'contains-option'],
      ['notanoun', 'not-a-noun'],
    ];
    for (const [clue, reason] of cases) {
      const result = await submitClue(h.clients[0], clue);
      expect(result).toMatchObject({ kind: 'invalid', reason });
    }
    expect(score).not.toHaveBeenCalled();
    expect(h.host.debugState()).toBe(before);
    expect(h.gameView(0).giver?.rejected).toEqual([]);
  });
});

describe('protocol version', () => {
  test('the host refuses a hello from another version with a clear reason, then closes', async () => {
    const h = await setup({ players: 2, startGame: false });
    const old = new RawClient(h.net.createAdapter(), h.port);
    await flush();
    old.sendRaw({ v: V + 1, t: 'hello', name: 'Future', token: 'token-future-000' });
    await flush();
    expect(old.received).toEqual([{ v: V, t: 'refused', reason: 'version', hostVersion: V }]);
    expect(h.view(0).players).toHaveLength(2);
    jest.advanceTimersByTime(500);
    await flush();
    expect(old.closed).toBe('closed');
  });

  test('a client told "refused: version" shows the update message and does not retry', async () => {
    const net = new MemoryNetwork();
    const f = await fakeHost(net);
    expect(f.got).toEqual([{ v: V, t: 'hello', name: 'Victim', token: f.client.token }]);
    f.transport.sendTo(f.peers[0], { v: V, t: 'refused', reason: 'version', hostVersion: V + 3 });
    await flush();
    const snap = f.client.getSnapshot();
    expect(snap.status).toBe('closed');
    expect(snap.closeReason).toBe('version');
    expect(snap.message).toMatch(/update the app/i);
    jest.advanceTimersByTime(60000);
    await flush();
    expect(f.peers).toHaveLength(1);
  });

  test('a host speaking a newer protocol is detected from any message, even one the client cannot parse', async () => {
    const net = new MemoryNetwork();
    const f = await fakeHost(net);
    f.transport.sendTo(f.peers[0], { v: V + 1, t: 'welcome2', seat: { id: 1 }, extras: [1, 2] });
    await flush();
    expect(f.client.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'version', view: null });
  });
});

describe('a client does not trust the host blindly either', () => {
  test('malformed host messages are ignored and the last good view is kept', async () => {
    const net = new MemoryNetwork();
    const f = await fakeHost(net);
    const peer = f.peers[0];
    // A view before the welcome is not accepted.
    f.transport.sendTo(peer, { v: V, t: 'view', view: lobbyView(4) as unknown as Json });
    expect(f.client.getSnapshot().view).toBeNull();
    f.transport.sendTo(peer, { v: V, t: 'welcome', seat: 4, name: 'Victim' });
    f.transport.sendTo(peer, { v: V, t: 'view', view: lobbyView(4) as unknown as Json });
    const good = f.client.getSnapshot();
    expect(good.status).toBe('connected');
    expect(good.view).toEqual(lobbyView(4));

    const bad: Json[] = [
      { v: V, t: 'view' },
      { v: V, t: 'view', view: null },
      { v: V, t: 'view', view: { ...lobbyView(4), players: 'everyone' } },
      { v: V, t: 'view', view: { ...lobbyView(4), stage: 'game' } },
      { v: V, t: 'view', view: { ...lobbyView(4), you: { seat: 99, name: 'x', isHost: true } } },
      { v: V, t: 'view', view: { ...lobbyView(4), settings: { threshold: 'high' } } },
      { v: V, t: 'clueResult', id: 1, result: { kind: 'accepted' } },
      { v: V, t: 'bye', reason: 42 },
      { v: V, t: 'refused', reason: 'full', hostVersion: V },
      { v: V, t: 'explode' },
      { t: 'view', view: lobbyView(4) as unknown as Json },
    ];
    for (const msg of bad) f.transport.sendTo(peer, msg);
    await flush();
    expect(f.client.getSnapshot()).toBe(good);
  });

  test('a clue result with an id nobody asked for is ignored', async () => {
    const net = new MemoryNetwork();
    const f = await fakeHost(net);
    const peer = f.peers[0];
    f.transport.sendTo(peer, { v: V, t: 'welcome', seat: 4, name: 'Victim' });
    const pending = f.client.submitClue('word');
    expect(f.client.getSnapshot().cluePending).toBe(true);
    f.transport.sendTo(peer, { v: V, t: 'clueResult', id: 999, result: { kind: 'busy' } });
    expect(f.client.getSnapshot().cluePending).toBe(true);
    // A second submission while one is pending is answered locally.
    expect(await f.client.submitClue('other')).toEqual({ kind: 'busy' });
    expect(f.got.filter((m) => m.t === 'clue')).toHaveLength(1);
    f.transport.sendTo(peer, {
      v: V,
      t: 'clueResult',
      id: f.got.filter((m) => m.t === 'clue')[0].id as number,
      result: { kind: 'rejected', clue: 'word', score: 0.3, raw: 0.2 },
    });
    expect(await pending).toEqual({ kind: 'rejected', clue: 'word', score: 0.3, raw: 0.2 });
    expect(f.client.getSnapshot()).toMatchObject({ cluePending: false, lastClueResult: { kind: 'rejected' } });
  });

  test('a host that never answers a clue: the submission resolves with a retryable error', async () => {
    const net = new MemoryNetwork();
    const f = await fakeHost(net);
    f.transport.sendTo(f.peers[0], { v: V, t: 'welcome', seat: 4, name: 'Victim' });
    const pending = f.client.submitClue('word');
    // Keep the connection alive while waiting.
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(3000);
      f.transport.sendTo(f.peers[0], { v: V, t: 'pong', n: i });
    }
    const result = await pending;
    expect(result.kind).toBe('error');
    expect(f.client.getSnapshot().cluePending).toBe(false);
    expect(f.client.getSnapshot().status).toBe('connected');
  });
});

describe('duplicate, late and out-of-phase messages', () => {
  test('choosing twice keeps the first word', async () => {
    const h = await setup({ players: 2 });
    const [first, second] = h.game().options;
    h.clients[0].chooseWord(first);
    h.clients[0].chooseWord(second);
    expect(h.game().hiddenWord).toBe(first);
    expect(h.gameView(0).phase).toBe('clue');
  });

  test('choosing a word that is not on offer is ignored', async () => {
    const h = await setup({ players: 2 });
    h.clients[0].chooseWord('zebra');
    expect(h.gameView(0).phase).toBe('choose-word');
  });

  test('a second guess from the same player is ignored: the first one counts', async () => {
    const h = await setup({ players: 3 });
    const { word } = await toGuessPhase(h);
    h.clients[1].submitGuess('firstguess');
    h.clients[1].submitGuess(word);
    h.clients[1].submitGuess(word);
    expect(h.gameView(1).yourGuess).toBe('firstguess');
    h.clients[2].submitGuess('other');
    expect(h.game().rounds[0].guesses[0]).toEqual({ playerId: 'p2', guess: 'firstguess', correct: false });
    expect(h.game().rounds[0].anyCorrect).toBe(false);
  });

  test('guesses outside the guess phase, and after the round resolved, are ignored', async () => {
    const h = await setup({ players: 2 });
    h.clients[1].submitGuess('tooearly');
    h.clients[0].chooseWord(h.game().options[0]);
    h.clients[1].submitGuess('stilltooearly');
    expect(h.host.debugState().pendingGuesses).toEqual({});
    await toGuessPhase(h);
    h.clients[1].submitGuess('ontime');
    const resolved = h.host.debugState();
    expect(resolved.game?.phase).toBe('round-result');
    h.clients[1].submitGuess('toolate');
    expect(h.host.debugState()).toBe(resolved);
    // A late guess must not leak into the next round either.
    h.clients[0].next();
    await toGuessPhase(h);
    expect(h.host.debugState().pendingGuesses).toEqual({});
    expect(h.gameView(1).guessStatus.map((s) => s.status)).toEqual(['pending']);
  });

  test('a duplicated or stale continue advances only once', async () => {
    const h = await setup({ players: 2, startGame: false });
    const raw = await rawJoin(h, 'Raw');
    await h.start();
    const { word } = await toGuessPhase(h);
    h.clients[1].submitGuess(word);
    raw.send('guess', { guess: 'nope' });
    expect(h.game().phase).toBe('round-result');
    const step = h.gameView(0).step;
    // The same continue delivered three times (e.g. a double tap plus a retransmission).
    h.net.pause();
    h.clients[0].next();
    h.clients[0].next();
    h.clients[0].next();
    h.net.resume();
    // The loopback is synchronous, so the host's own client always sends the fresh step; replay the old one too.
    expect(h.game().phase).not.toBe('round-result');
    const after = h.host.debugState();
    const hostRaw = h.clients[0];
    expect(hostRaw.getSnapshot().view?.game?.step).toBeGreaterThan(step);
    raw.send('next', { step });
    expect(h.host.debugState()).toBe(after);
  });

  test('stale continues with an old step are ignored even from the host seat', async () => {
    const h = await setup({ players: 2, continueBy: 'anyone' });
    const { word } = await toGuessPhase(h);
    h.clients[1].submitGuess(word);
    const raw = await rawJoin(h, 'P2', h.clients[1].token); // take over P2's seat with its token
    const step = raw.gameView().step;
    raw.send('next', { step });
    expect(h.game().phase).toBe('turn-result');
    raw.send('next', { step });
    raw.send('next', { step: step - 1 });
    raw.send('next', { step: step + 5 });
    expect(h.game().phase).toBe('turn-result');
    raw.send('next', { step: raw.gameView().step });
    expect(h.game().phase).toBe('choose-word');
  });

  test('starting twice, or starting during a game, does nothing', async () => {
    const h = await setup({ players: 2 });
    const before = h.host.debugState();
    h.clients[0].startGame();
    h.clients[0].startGame();
    expect(h.host.debugState()).toBe(before);
  });

  test('forfeit is refused until five clues were rejected in the round', async () => {
    const h = await setup({ players: 2 });
    h.clients[0].chooseWord(h.game().options[0]);
    for (let i = 0; i < 4; i++) {
      expect((await submitClue(h.clients[0], badClue())).kind).toBe('rejected');
      h.clients[0].forfeit();
      expect(h.gameView(0).phase).toBe('clue');
    }
    expect(h.gameView(0).giver).toMatchObject({ canForfeit: false, rejectionsUntilForfeit: 1 });
    await submitClue(h.clients[0], badClue());
    expect(h.gameView(0).giver).toMatchObject({ canForfeit: true, rejectionsUntilForfeit: 0 });
    // The rejected attempts and their scores are the giver's alone.
    expect(h.gameView(0).giver?.rejected).toHaveLength(5);
    expect(JSON.stringify(h.view(1))).not.toMatch(/"score":0\.5/);
    h.clients[0].forfeit();
    for (let i = 0; i < 2; i++) {
      expect(h.gameView(i).phase).toBe('turn-result');
      expect(h.gameView(i).turnSummary).toMatchObject({ outcome: 'forfeit', giverPoints: 0, roundsPlayed: 0 });
    }
  });

  test('a clue already tried this turn is refused without scoring it again', async () => {
    const score = jest.fn(async () => ({ raw: 0.2, score: 0.4 }));
    const h = await setup({ players: 2, score });
    h.clients[0].chooseWord(h.game().options[0]);
    const clue = badClue();
    expect((await submitClue(h.clients[0], clue)).kind).toBe('rejected');
    expect(await submitClue(h.clients[0], clue.toUpperCase())).toMatchObject({ kind: 'invalid', reason: 'already-tried' });
    expect(score).toHaveBeenCalledTimes(1);
  });
});

describe('two clue submissions racing', () => {
  test('only the first is scored; the second is answered "busy" and changes nothing', async () => {
    const jobs: ReturnType<typeof deferred<{ raw: number; score: number }>>[] = [];
    const score = jest.fn((_clue: string, _word: string) => {
      const d = deferred<{ raw: number; score: number }>();
      jobs.push(d);
      return d.promise;
    });
    // Seat 2 is a hand-driven connection so both clues really reach the host.
    const h = await setup({ players: 1, startGame: false, score, settings: settings({ turnsPerPlayer: 1 }) });
    const raw = await rawJoin(h, 'Racer');
    await h.start();
    // Turn 1: the host gives; get it over with.
    h.clients[0].chooseWord(h.game().options[0]);
    const first = h.clients[0].submitClue(okClue());
    await flush();
    jobs[0].resolve({ raw: 0.7, score: 0.97 });
    await flush();
    expect((await first).kind).toBe('accepted');
    raw.send('guess', { guess: h.game().hiddenWord });
    h.clients[0].next();
    h.clients[0].next();
    expect(raw.gameView()).toMatchObject({ phase: 'choose-word', role: 'giver' });

    // Turn 2: the raw player gives and fires two clues back to back.
    raw.send('choose', { word: raw.gameView().giver?.options[2] });
    const word = h.game().hiddenWord as string;
    const [clueA, clueB] = [okClue(), okClue()];
    h.net.pause();
    raw.send('clue', { id: 1, clue: clueA });
    raw.send('clue', { id: 2, clue: clueB });
    h.net.resume();
    await flush();
    expect(score).toHaveBeenCalledTimes(2); // one in turn 1, one now
    expect(score).toHaveBeenLastCalledWith(clueA, word);
    expect(raw.ofType('clueResult')).toEqual([{ v: V, t: 'clueResult', id: 2, result: { kind: 'busy' } }]);
    expect(raw.gameView().giver?.scoring).toBe(true);
    expect(h.game().phase).toBe('clue');

    jobs[1].resolve({ raw: 0.71, score: 0.96 });
    await flush();
    expect(raw.ofType('clueResult')[1]).toEqual({
      v: V,
      t: 'clueResult',
      id: 1,
      result: { kind: 'accepted', clue: clueA, score: 0.96, raw: 0.71 },
    });
    expect(h.game().acceptedClues).toEqual([{ clue: clueA, score: 0.96 }]);
    expect(h.game().triedClues).toEqual([clueA]);
    expect(h.gameView(0).phase).toBe('guess');
    // The losing clue was not recorded and can be used in a later round.
    expect(h.game().triedClues).not.toContain(clueB);
  });

  test("through ClientSession the second submission never leaves the phone", async () => {
    const d = deferred<{ raw: number; score: number }>();
    const score = jest.fn(() => d.promise);
    const h = await setup({ players: 2, score });
    h.clients[0].chooseWord(h.game().options[0]);
    const a = h.clients[0].submitClue(okClue());
    const b = h.clients[0].submitClue(okClue());
    await flush();
    expect(await b).toEqual({ kind: 'busy' });
    expect(h.clients[0].getSnapshot().cluePending).toBe(true);
    expect(score).toHaveBeenCalledTimes(1);
    d.resolve({ raw: 0.2, score: 0.3 });
    await flush();
    expect((await a).kind).toBe('rejected');
    expect(h.clients[0].getSnapshot().cluePending).toBe(false);
  });
});

describe('lobby rules', () => {
  test('joiners appear on every phone; clashing names are suffixed by the host', async () => {
    const h = await setup({ players: 1, startGame: false, hostName: 'Sam' });
    const a = await h.join('sam');
    const b = await h.join('Sam');
    const c = await h.join('  Alex ');
    expect(a.getSnapshot().name).toBe('sam 2');
    expect(b.getSnapshot().name).toBe('Sam 3');
    expect(c.getSnapshot().name).toBe('Alex');
    for (let i = 0; i < 4; i++) {
      expect(h.view(i).players.map((p) => [p.name, p.connected, p.isHost])).toEqual([
        ['Sam', true, true],
        ['sam 2', true, false],
        ['Sam 3', true, false],
        ['Alex', true, false],
      ]);
      expect(h.view(i).stage).toBe('lobby');
      expect(h.view(i).host === null).toBe(i !== 0);
    }
    expect(h.host.getSnapshot()).toMatchObject({
      status: 'open',
      address: HOST_ADDRESS,
      port: h.port,
      serviceName: 'Sam',
      stage: 'lobby',
      playerCount: 4,
    });
  });

  test('the host cannot start alone, and can with two players', async () => {
    const h = await setup({ players: 1, startGame: false });
    expect(h.view(0).host?.canStart).toBe(false);
    await h.start();
    expect(h.view(0).stage).toBe('lobby');
    await h.join('Bea');
    expect(h.view(0).host?.canStart).toBe(true);
    await h.start();
    expect(h.view(0).stage).toBe('game');
    expect(h.view(1).stage).toBe('game');
    expect(h.host.getSnapshot().stage).toBe('game');
  });

  test('the ninth player is refused: the lobby is full', async () => {
    const h = await setup({ players: 8, startGame: false });
    const ninth = await h.join('Nine');
    expect(ninth.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'full', view: null });
    expect(h.view(0).players).toHaveLength(8);
    jest.advanceTimersByTime(60000);
    await flush();
    expect(ninth.getSnapshot().status).toBe('closed');
  });

  test('joining while a game is in progress is refused', async () => {
    const h = await setup({ players: 2 });
    const late = await h.join('Late');
    expect(late.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'in-progress', view: null });
    expect(late.getSnapshot().message).toMatch(/in progress/i);
    expect(h.view(0).players).toHaveLength(2);
    expect(h.game().players).toHaveLength(2);
    // The refused phone was told nothing about the game.
    const raw = new RawClient(h.net.createAdapter(), h.port);
    await flush();
    raw.hello('Nosy');
    await flush();
    expect(raw.received).toEqual([{ v: V, t: 'refused', reason: 'in-progress', hostVersion: V }]);
  });

  test('the host can remove a player in the lobby; the removed phone is told and does not come back', async () => {
    const h = await setup({ players: 3, startGame: false });
    const removedSeat = h.view(1).you.seat;
    expect(h.view(0).host?.removableSeats).toEqual([removedSeat, h.view(2).you.seat]);
    h.clients[2].removePlayer(removedSeat); // not the host
    h.clients[0].removePlayer(h.view(0).you.seat); // cannot remove yourself
    expect(h.view(0).players).toHaveLength(3);
    h.clients[0].removePlayer(removedSeat);
    await flush();
    expect(h.clients[1].getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'removed' });
    expect(h.view(0).players.map((p) => p.name)).toEqual(['Host', 'P3']);
    expect(h.view(2).players.map((p) => p.name)).toEqual(['Host', 'P3']);
    jest.advanceTimersByTime(30000);
    await flush();
    expect(h.clients[1].getSnapshot().status).toBe('closed');
    // Its token no longer opens a seat. From another phone it would only make a brand-new player
    // (the removed phone itself stays out: see sessions.hardening.test.ts).
    const again = await h.join('P2', h.clients[1].token);
    expect(again.getSnapshot().seat).not.toBe(removedSeat);
    expect(h.view(0).players.map((p) => p.name)).toEqual(['Host', 'P3', 'P2']);
  });

  test('leaving the lobby frees the seat; a player who is merely disconnected stays listed and can be removed', async () => {
    const h = await setup({ players: 4, startGame: false });
    h.clients[1].leave();
    await flush();
    expect(h.clients[1].getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'left' });
    expect(h.view(0).players.map((p) => p.name)).toEqual(['Host', 'P3', 'P4']);

    h.net.setOffline('10.0.0.3'); // P3's phone goes dark
    jest.advanceTimersByTime(12500);
    await flush();
    expect(h.view(0).players.map((p) => [p.name, p.connected])).toEqual([
      ['Host', true],
      ['P3', false],
      ['P4', true],
    ]);
    expect(h.view(3).players[1].connected).toBe(false);
    h.clients[0].removePlayer(h.view(0).players[1].seat);
    expect(h.view(3).players.map((p) => p.name)).toEqual(['Host', 'P4']);
  });

  test('players who are disconnected when the game starts are left out', async () => {
    const h = await setup({ players: 3, startGame: false });
    h.net.pause(); // P2 vanishes without a word
    h.net.sever(h.net.linksFrom('10.0.0.2')[0]);
    h.net.discardWhere((e) => e.kind === 'client-close');
    h.net.resume();
    expect(h.view(0).players.map((p) => p.connected)).toEqual([true, false, true]);
    expect(h.view(0).host?.canStart).toBe(true);
    await h.start();
    expect(h.game().players.map((p) => p.name)).toEqual(['Host', 'P3']);
    expect(h.view(2).players.map((p) => [p.name, p.id])).toEqual([
      ['Host', 'p1'],
      ['P3', 'p2'],
    ]);
  });
});
