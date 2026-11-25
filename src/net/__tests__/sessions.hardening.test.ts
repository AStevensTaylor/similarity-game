/**
 * Hardening found in review: what a hostile, broken or merely absent peer can
 * and cannot do to a session, and the bounds between what the host sends and
 * what clients accept.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ClientSession, createClientSession } from '../clientSession';
import { HostSession } from '../hostSession';
import { MemoryNetwork } from '../memoryAdapter';
import { LISTENER_CLOSED } from '../transport';
import type { ClientTransport, HostTransportHandlers, NetworkAdapter } from '../transport';
import {
  DECK,
  HOST_ADDRESS,
  RawClient,
  SEED,
  badClue,
  defaultScore,
  deferred,
  flush,
  rawJoin,
  settings,
  setup,
  submitClue,
  toGuessPhase,
} from './harness';
import type { Harness } from './harness';

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

async function advance(ms: number): Promise<void> {
  // In steps, so replies to pings are processed between ticks.
  for (let left = ms; left > 0; left -= 500) {
    jest.advanceTimersByTime(Math.min(500, left));
    await flush();
  }
}

const addr = (clientIndex: number) => `10.0.0.${clientIndex + 1}`;
const seatOf = (h: Harness, i: number) => h.clients[i].getSnapshot().seat as number;

/** Plays turn 1 (host gives, everyone guesses right) so that client 1 is the giver of turn 2. */
async function toSecondTurn(h: Harness): Promise<void> {
  const { word } = await toGuessPhase(h);
  for (let i = 1; i < h.clients.length; i++) h.clients[i].submitGuess(word);
  h.clients[0].next();
  h.clients[0].next();
  expect(h.giverIndex()).toBe(1);
}

function newHost(adapter: NetworkAdapter): HostSession {
  return new HostSession({
    adapter,
    hostName: 'Host',
    score: defaultScore,
    deck: DECK,
    isNoun: () => true,
    settings: settings(),
    seed: SEED,
  });
}

describe('guesses are validated by the host before they can reach anyone', () => {
  test('a guess that grows when lower-cased is ignored, and nobody is frozen by it', async () => {
    const h = await setup({ players: 3, settings: settings({ guessMode: 'open' }) });
    await toGuessPhase(h);
    const long = '\u0130'.repeat(40); // 40 units on the wire, 80 once lower-cased
    expect(long.toLowerCase()).toHaveLength(80);
    expect(h.clients[1].submitGuess(long)).toBe(true);
    expect(h.host.debugState().pendingGuesses).toEqual({});
    expect(h.gameView(0).guessStatus.map((s) => s.status)).toEqual(['pending', 'pending']);

    // The guesser is still free to guess properly, and the round resolves for everybody.
    h.clients[1].submitGuess('zzwrong');
    h.clients[2].submitGuess('zzother');
    expect(h.game().phase).toBe('round-result');
    for (let i = 0; i < 3; i++) {
      expect(h.clients[i].getSnapshot().status).toBe('connected');
      expect(h.gameView(i).phase).toBe('round-result');
      expect(h.gameView(i).step).toBe(h.host.debugState().step);
      expect(h.gameView(i).rounds[0].guesses.map((g) => g.guess)).toEqual(['zzwrong', 'zzother']);
    }
    h.clients[0].next();
    expect(h.game().phase).toBe('clue');
    expect(h.gameView(2).phase).toBe('clue');
    expect(h.host.getSnapshot().error).toBeNull();
  });

  test.each([
    ['line breaks, a bidi override, markup and a NUL', 'a\n\n\n\u202eb <b>\u0000 x y'],
    ['two words', 'two words'],
    ['a digit', 'abc1'],
    ['an apostrophe', "it's"],
    ['a letter outside a-z', 'caf\u00e9'],
    ['a zero-width space', 'app\u200ble'],
  ])('open mode: a guess with %s is ignored', async (_what, guess) => {
    const h = await setup({ players: 3, settings: settings({ guessMode: 'open' }) });
    await toGuessPhase(h);
    const before = h.host.debugState();
    h.clients[1].submitGuess(guess);
    expect(h.host.debugState()).toBe(before);
    // Capitals and surrounding spaces are fine: the guess is stored normalised.
    h.clients[1].submitGuess('  Apple ');
    expect(h.host.debugState().pendingGuesses).toEqual({ p2: 'apple' });
    h.clients[2].submitGuess('zzwrong');
    for (let i = 0; i < 3; i++) expect(h.gameView(i).rounds[0].guesses.map((g) => g.guess)).toEqual(['apple', 'zzwrong']);
  });

  test('list mode is unchanged: only one of the options counts, in any letter case', async () => {
    const h = await setup({ players: 3, settings: settings({ guessMode: 'list' }) });
    const { word } = await toGuessPhase(h);
    h.clients[1].submitGuess('zznotanoption');
    h.clients[1].submitGuess(`${word} `.repeat(2));
    expect(h.host.debugState().pendingGuesses).toEqual({});
    h.clients[1].submitGuess(` ${word.toUpperCase()} `);
    expect(h.host.debugState().pendingGuesses).toEqual({ p2: word });
  });
});

describe('what the host sends always fits what clients accept', () => {
  test("more rejected clues than a view can carry: the giver's phone keeps up", async () => {
    const h = await setup({ players: 2 });
    h.clients[0].chooseWord(h.game().options[0]);
    let last = '';
    for (let i = 0; i < 262; i++) {
      last = badClue();
      expect((await submitClue(h.clients[0], last)).kind).toBe('rejected');
    }
    expect(h.game().rejectedThisRound).toHaveLength(262);
    const giver = h.gameView(0).giver;
    // Only the latest attempts are sent; the counts that matter come from the real total.
    expect(giver?.rejected).toHaveLength(256);
    expect(giver?.rejected[255].clue).toBe(last);
    expect(giver?.triedClues).toContain(last);
    expect(giver).toMatchObject({ canForfeit: true, rejectionsUntilForfeit: 0 });
    expect(h.gameView(0).step).toBe(h.host.debugState().step);
    expect(h.host.getSnapshot().error).toBeNull();
    // And the turn simply goes on.
    await toGuessPhase(h);
    expect(h.gameView(0).phase).toBe('guess');
    expect(h.gameView(1).phase).toBe('guess');
  });
});

describe('rejected clues stay between the giver and the host', () => {
  test('a guesser sees nothing change (no new view, same step) while clues are rejected', async () => {
    const h = await setup({ players: 3 });
    h.clients[0].chooseWord(h.game().options[0]);
    const viewsSent = (link: number) => h.net.log.filter((e) => e.dir === 'to-client' && e.link === link && e.msg.t === 'view').length;
    const links = [h.net.linksFrom(addr(1))[0], h.net.linksFrom(addr(2))[0]];
    const before = { views: [h.view(1), h.view(2)], sent: links.map(viewsSent), step: h.gameView(1).step };

    for (let i = 0; i < 3; i++) expect((await submitClue(h.clients[0], badClue())).kind).toBe('rejected');

    expect(h.gameView(0).giver?.rejected).toHaveLength(3);
    expect(links.map(viewsSent)).toEqual(before.sent);
    expect(h.view(1)).toBe(before.views[0]);
    expect(h.view(2)).toBe(before.views[1]);
    expect(h.gameView(1).step).toBe(before.step);
    expect(h.host.debugState().step).toBe(before.step);

    // An accepted clue is public and moves everyone on.
    await toGuessPhase(h);
    expect(h.gameView(1).step).toBe(before.step + 1);
    expect(h.gameView(1).phase).toBe('guess');
    // "next" still only counts for the current step.
    h.clients[1].submitGuess('zzwrong');
    h.clients[2].submitGuess('zzwrong');
    h.clients[0].next();
    expect(h.game().phase).toBe('clue');
  });
});

describe('connections that never become players', () => {
  test('silent connections cannot crowd out joining or reconnecting players', async () => {
    const h = await setup({ players: 3, startGame: false });
    // 40 devices connect and say nothing.
    const silent = Array.from({ length: 40 }, () => new RawClient(h.net.createAdapter(), h.port));
    await flush();
    // 32 connections at most: the oldest silent ones made room for the newer ones.
    expect(silent.filter((s) => s.closed === null)).toHaveLength(29);
    expect(silent.slice(0, 11).every((s) => s.closed === 'closed')).toBe(true);
    for (const c of h.clients) expect(c.getSnapshot().status).toBe('connected');

    // A new player still gets in...
    const fresh = await h.join('Fresh');
    expect(fresh.getSnapshot()).toMatchObject({ status: 'connected', name: 'Fresh' });
    expect(silent.filter((s) => s.closed === null)).toHaveLength(28);

    // ...and so does a player who dropped and comes back with their token.
    const seat = seatOf(h, 1);
    h.net.sever(h.net.linksFrom(addr(1))[0]);
    await flush();
    expect(h.view(0).players[1].connected).toBe(false);
    await advance(1500);
    expect(h.clients[1].getSnapshot()).toMatchObject({ status: 'connected', seat });
    expect(h.view(0).players.map((p) => p.connected)).toEqual([true, true, true, true]);
  });

  test('one address holds at most three seatless connections; seated players are never evicted', async () => {
    const h = await setup({ players: 8, startGame: false });
    const flooder = h.net.createAdapter();
    const raws = Array.from({ length: 60 }, () => new RawClient(flooder, h.port));
    await flush();
    expect(raws.filter((r) => r.closed === null)).toHaveLength(3);
    expect(raws.slice(-3).every((r) => r.closed === null)).toBe(true);
    // Many devices at once: still nobody with a seat is touched.
    const crowd = Array.from({ length: 60 }, () => new RawClient(h.net.createAdapter(), h.port));
    await flush();
    expect(crowd.filter((r) => r.closed === null).length).toBeLessThanOrEqual(24);
    for (const c of h.clients) expect(c.getSnapshot().status).toBe('connected');
    expect(h.view(0).players.every((p) => p.connected)).toBe(true);
  });

  test('a flood of well-formed messages gets the sender dropped, seated or not', async () => {
    const h = await setup({ players: 2, startGame: false });
    const stranger = new RawClient(h.net.createAdapter(), h.port);
    await flush();
    for (let i = 0; i < 1000; i++) stranger.send('ping', { n: i });
    await flush();
    expect(stranger.closed).toBe('closed');
    expect(stranger.received).toEqual([]); // not even a pong before hello

    const raw = await rawJoin(h, 'Flood');
    await h.start();
    for (let i = 0; i < 1000; i++) raw.send('clue', { id: i, clue: 'x' });
    await flush();
    expect(raw.closed).toBe('closed');
    expect(raw.ofType('clueResult').length).toBeLessThanOrEqual(40);
    expect(h.view(0).players[2]).toMatchObject({ name: 'Flood', connected: false });
    expect(h.host.getSnapshot().status).toBe('open');
    // The seat is still theirs: a normal reconnect works.
    const again = await rawJoin(h, 'Flood', 'rawtoken-Flood-0000');
    expect(again.ofType('welcome')).toHaveLength(1);
    expect(h.view(0).players[2].connected).toBe(true);
    // A steady trickle well above real traffic is fine.
    for (let i = 0; i < 200; i++) {
      again.send('ping', { n: i });
      jest.advanceTimersByTime(100);
    }
    await flush();
    expect(again.closed).toBeNull();
  });
});

describe('lobby seats cannot be squatted', () => {
  test('one device joining and vanishing again and again leaves a single stale seat', async () => {
    const h = await setup({ players: 1, startGame: false });
    const attacker = h.net.createAdapter();
    for (let i = 0; i < 7; i++) {
      const raw = new RawClient(attacker, h.port);
      await flush();
      raw.hello(`Squat${i}`, `squattoken-${i}-0000`);
      await flush();
      expect(raw.ofType('welcome')).toHaveLength(1);
      raw.close();
      await flush();
    }
    expect(h.view(0).players.map((p) => [p.name, p.connected])).toEqual([
      ['Host', true],
      ['Squat6', false],
    ]);
    const real = await h.join('Real');
    expect(real.getSnapshot().status).toBe('connected');
    expect(h.view(0).host?.canStart).toBe(true);
  });

  test('one address holds at most two seats, however many tokens it uses', async () => {
    const h = await setup({ players: 1, startGame: false });
    const device = h.net.createAdapter();
    const raws: RawClient[] = [];
    for (let i = 0; i < 4; i++) {
      const raw = new RawClient(device, h.port);
      await flush();
      raw.hello(`Twin${i}`, `twintoken-${i}-00000`);
      await flush();
      raws.push(raw);
    }
    expect(raws.map((r) => r.ofType('welcome').length)).toEqual([1, 1, 0, 0]);
    expect(raws[2].ofType('refused')[0]).toMatchObject({ reason: 'full' });
    expect(h.view(0).players.map((p) => p.name)).toEqual(['Host', 'Twin0', 'Twin1']);
  });

  test('a full lobby makes room by letting go of a player who is gone; eight present players are still "full"', async () => {
    const h = await setup({ players: 8, startGame: false });
    const refused = await h.join('Nine');
    expect(refused.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'full' });

    h.net.setOffline(addr(3)); // P4's phone goes dark
    await advance(12500);
    expect(h.view(0).players[3]).toMatchObject({ name: 'P4', connected: false });
    const ten = await h.join('Ten');
    expect(ten.getSnapshot()).toMatchObject({ status: 'connected', name: 'Ten' });
    expect(h.view(0).players.map((p) => p.name)).toEqual(['Host', 'P2', 'P3', 'P5', 'P6', 'P7', 'P8', 'Ten']);
  });

  test('a player the host removed stays out, with the same token or a new one; a player who was merely gone may return', async () => {
    const h = await setup({ players: 4, startGame: false });
    const target = { host: HOST_ADDRESS, port: h.port };
    h.clients[0].removePlayer(seatOf(h, 1)); // P2 is here: this is a kick
    await flush();
    expect(h.clients[1].getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'removed' });

    for (const token of [h.clients[1].token, undefined]) {
      const back = createClientSession({ adapter: h.adapters[1], target, name: 'P2', token });
      back.start();
      await flush();
      expect(back.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'removed', view: null });
      await advance(30000);
      expect(back.getSnapshot().status).toBe('closed'); // no retrying
    }
    expect(h.view(0).players.map((p) => p.name)).toEqual(['Host', 'P3', 'P4']);
    // Other phones are not affected.
    expect((await h.join('Other')).getSnapshot().status).toBe('connected');

    // P3 drops out and the host tidies the stale seat away: that is not a ban.
    h.net.setOffline(addr(2));
    await advance(12500);
    expect(h.view(0).players[1]).toMatchObject({ name: 'P3', connected: false });
    h.clients[0].removePlayer(h.view(0).players[1].seat);
    expect(h.view(0).players.map((p) => p.name)).toEqual(['Host', 'P4', 'Other']);
    h.net.setOffline(addr(2), false);
    await advance(2000);
    expect(h.clients[2].getSnapshot().status).toBe('connected');
    expect(h.view(0).players.map((p) => p.name)).toEqual(['Host', 'P4', 'Other', 'P3']);
  });

  test('a seat is still reclaimed with its token, in the lobby and during a game', async () => {
    const h = await setup({ players: 3, startGame: false });
    const seat = seatOf(h, 1);
    h.net.sever(h.net.linksFrom(addr(1))[0]);
    await advance(1500);
    expect(h.clients[1].getSnapshot()).toMatchObject({ status: 'connected', seat });
    await h.start();
    h.net.sever(h.net.linksFrom(addr(1))[0]);
    await advance(1500);
    expect(h.clients[1].getSnapshot()).toMatchObject({ status: 'connected', seat });
    expect(h.gameView(1).phase).toBe('choose-word');
    expect(h.view(0).players).toHaveLength(3);
  });
});

describe('a connected player who does not play cannot hold the game up for ever', () => {
  test('a connected, silent guesser can be skipped by the host after the idle limit - not before', async () => {
    const h = await setup({ players: 3 });
    await toGuessPhase(h);
    const silent = seatOf(h, 2);
    h.clients[1].submitGuess('zzwrong');
    await advance(59000);
    expect(h.view(0).host?.skippableSeats).toEqual([]);
    h.clients[0].skipGuesser(silent);
    expect(h.game().phase).toBe('handoff-guesser');

    await advance(2000);
    expect(h.view(0).players.every((p) => p.connected)).toBe(true);
    expect(h.view(0).host?.skippableSeats).toEqual([silent]);
    expect(h.view(1).host).toBeNull();
    h.clients[1].skipGuesser(silent); // not the host
    h.clients[0].skipGuesser(seatOf(h, 1)); // has guessed already
    expect(h.game().phase).toBe('handoff-guesser');

    h.clients[0].skipGuesser(silent);
    expect(h.game().phase).toBe('round-result');
    expect(h.game().rounds[0].guesses[1]).toEqual({ playerId: 'p3', guess: '', correct: false, skipped: true });
    expect(h.gameView(2).phase).toBe('round-result');
    // Every wait starts its own clock.
    h.clients[0].next();
    expect(h.host.debugState().idleExpired).toBe(false);
  });

  test('the host is never offered to skip or forfeit for itself by idling', async () => {
    const h = await setup({ players: 3 });
    await advance(120000);
    expect(h.gameView(0).phase).toBe('choose-word');
    expect(h.view(0).host?.canForfeitGiver).toBe(false);
    await toSecondTurn(h);
    h.clients[1].chooseWord(h.game().options[0]);
    await submitClue(h.clients[1], 'okhostidle');
    await advance(120000);
    expect(h.view(0).host?.skippableSeats).toEqual([seatOf(h, 2)]); // the other guesser, not the host
  });

  test('a connected, silent giver can be forfeited after the idle limit, but never while a clue is being scored', async () => {
    const scoring = deferred<{ raw: number; score: number }>();
    let hold = false;
    const h = await setup({
      players: 3,
      scoreTimeoutMs: 10 * 60 * 1000,
      score: (clue, word) => (hold ? scoring.promise : defaultScore(clue, word)),
    });
    await toSecondTurn(h);
    expect(h.gameView(1).phase).toBe('choose-word');
    await advance(59000);
    expect(h.view(0).host?.canForfeitGiver).toBe(false);
    h.clients[0].forfeitGiver();
    expect(h.game().phase).toBe('choose-word');
    await advance(2000);
    expect(h.view(0).host?.canForfeitGiver).toBe(true);
    h.clients[2].forfeitGiver(); // not the host
    expect(h.game().phase).toBe('choose-word');

    // The giver wakes up: the wait for the clue gets a clock of its own.
    h.clients[1].chooseWord(h.game().options[0]);
    expect(h.view(0).host?.canForfeitGiver).toBe(false);
    await advance(50000);
    // A rejected clue shows the giver is trying.
    expect((await submitClue(h.clients[1], badClue())).kind).toBe('rejected');
    await advance(50000);
    expect(h.view(0).host?.canForfeitGiver).toBe(false);
    await advance(11000);
    expect(h.view(0).host?.canForfeitGiver).toBe(true);

    // While the host's model is scoring, the giver is waiting for the host, not the other way round.
    hold = true;
    const pending = h.clients[1].submitClue('okslowclue');
    await flush();
    expect(h.gameView(1).giver?.scoring).toBe(true);
    expect(h.view(0).host?.canForfeitGiver).toBe(false);
    await advance(25000); // the clue is still in flight (the client stops waiting at 30 s)
    expect(h.view(0).host?.canForfeitGiver).toBe(false);
    h.clients[0].forfeitGiver();
    expect(h.game().phase).toBe('clue');
    scoring.resolve({ raw: 0.1, score: 0.2 });
    await flush();
    expect((await pending).kind).toBe('rejected');
    await advance(59000);
    expect(h.view(0).host?.canForfeitGiver).toBe(false);
    await advance(2000);
    expect(h.view(0).host?.canForfeitGiver).toBe(true);
    h.clients[0].forfeitGiver();
    expect(h.game().phase).toBe('turn-result');
    expect(h.gameView(1).turnSummary?.outcome).toBe('forfeit');
  });
});

describe('a guess that was lost with its connection', () => {
  test('is sent again by the client once it has its seat back', async () => {
    const h = await setup({ players: 3 });
    await toGuessPhase(h);
    const link = h.net.linksFrom(addr(1))[0];
    h.net.blackhole(link); // the Wi-Fi link is dead, but nobody knows yet
    expect(h.clients[1].submitGuess('lostguess')).toBe(true);
    expect(h.host.debugState().pendingGuesses).toEqual({});
    h.net.sever(link);
    await advance(1500);
    expect(h.clients[1].getSnapshot().status).toBe('connected');
    expect(h.host.debugState().pendingGuesses).toEqual({ p2: 'lostguess' });
    expect(h.gameView(1).yourGuess).toBe('lostguess');
    expect(h.gameView(0).guessStatus.map((s) => s.status)).toEqual(['submitted', 'pending']);
    // It was sent once more, not on every later view.
    const guesses = () => h.net.log.filter((e) => e.dir === 'to-host' && e.msg.t === 'guess').length;
    const sent = guesses();
    h.clients[2].submitGuess('zzwrong');
    h.clients[0].next();
    expect(guesses()).toBe(sent + 1);
  });

  test('is not sent again when the host had it already, or when its round is over', async () => {
    const h = await setup({ players: 3 });
    await toGuessPhase(h);
    // Arrived before the drop: nothing to repeat.
    h.clients[1].submitGuess('arrived');
    h.net.sever(h.net.linksFrom(addr(1))[0]);
    await advance(1500);
    const guessesFrom = () => h.net.log.filter((e) => e.dir === 'to-host' && e.msg.t === 'guess').length;
    expect(guessesFrom()).toBe(1);
    h.clients[2].submitGuess('zzwrong');
    h.clients[0].next();
    await toGuessPhase(h); // clue round 2

    // Lost, and the round is over by the time the player is back.
    const link = h.net.linksFrom(addr(1))[0];
    h.net.blackhole(link);
    h.clients[1].submitGuess('toolate');
    h.net.setOffline(addr(1));
    h.net.sever(link);
    await flush();
    h.clients[0].skipGuesser(seatOf(h, 1));
    h.clients[2].submitGuess('zzwrong');
    h.clients[0].next();
    await toGuessPhase(h); // clue round 3
    const before = guessesFrom();
    h.net.setOffline(addr(1), false);
    await advance(1500);
    expect(h.clients[1].getSnapshot().status).toBe('connected');
    expect(h.gameView(1)).toMatchObject({ phase: 'guess', clueRound: 3, yourGuess: null });
    expect(guessesFrom()).toBe(before);
    expect(h.host.debugState().pendingGuesses).toEqual({});
  });
});

describe('host lifecycle', () => {
  test('stop() while the lobby is still opening closes the listener and the advertisement', async () => {
    const net = new MemoryNetwork();
    const real = net.createAdapter(HOST_ADDRESS);
    const address = deferred<string | null>();
    const host = newHost({ ...real, getLocalAddress: () => address.promise });
    const starting = host.start();
    await flush();
    expect(host.getSnapshot().status).toBe('starting');
    expect(net.hostPorts()).toHaveLength(1);
    const port = net.hostPorts()[0];

    await host.stop();
    expect(net.hostPorts()).toEqual([]);
    address.resolve(HOST_ADDRESS);
    await starting;
    await flush();
    expect(host.getSnapshot()).toMatchObject({ status: 'stopped', port: null });
    expect(net.hostPorts()).toEqual([]);

    // Nobody can find or reach a dead lobby.
    const late = createClientSession({ adapter: net.createAdapter(), target: { host: HOST_ADDRESS, port }, name: 'Late' });
    late.start();
    await advance(13000);
    expect(late.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'unreachable' });
  });

  test('a dead listener ends the session for everyone; other transport errors are only shown', async () => {
    const net = new MemoryNetwork();
    const real = net.createAdapter(HOST_ADDRESS);
    let handlers: HostTransportHandlers | null = null;
    const host = newHost({
      ...real,
      startHost: (opts, h) => {
        handlers = h;
        return real.startHost(opts, h);
      },
    });
    await host.start();
    const port = host.getSnapshot().port as number;
    const joiner = createClientSession({ adapter: net.createAdapter(), target: { host: HOST_ADDRESS, port }, name: 'Bea' });
    joiner.start();
    await flush();
    expect(joiner.getSnapshot().status).toBe('connected');
    const transportHandlers = handlers as HostTransportHandlers | null;
    if (!transportHandlers) throw new Error('no handlers');

    transportHandlers.onError(new Error('mdns hiccup'));
    expect(host.getSnapshot()).toMatchObject({ status: 'open', error: 'mdns hiccup' });
    expect(joiner.getSnapshot().status).toBe('connected');

    transportHandlers.onError(Object.assign(new Error('the listening socket failed: EMFILE'), { code: LISTENER_CLOSED }));
    await advance(1000);
    expect(host.getSnapshot().status).toBe('failed');
    expect(host.getSnapshot().error).toMatch(/stopped accepting connections.*EMFILE/);
    expect(joiner.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'host-left' });
    expect(net.hostPorts()).toEqual([]);
    expect(host.client.getSnapshot().status).toBe('closed');
  });
});

describe('the client gives up when its window ends, even if connecting hangs', () => {
  const hanging = (): ClientTransport => ({ send: () => false, close: () => undefined });

  test('first connection: "unreachable" after 12 s, not 17', async () => {
    const client = new ClientSession({ connect: hanging, name: 'Ann' });
    client.start();
    await advance(11500);
    expect(client.getSnapshot().status).toBe('connecting');
    await advance(500);
    expect(client.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'unreachable' });
  });

  test.each([
    ['never completes', (): ClientTransport => hanging()],
    ['opens but is never welcomed', undefined],
  ])('reconnecting, when the connection %s: "connection lost" after 20 s, not 27', async (_what, fixed) => {
    const h = await setup({ players: 1, startGame: false });
    const adapter = h.net.createAdapter();
    let attempts = 0;
    const client = new ClientSession({
      name: 'Ann',
      connect: (handlers) => {
        attempts += 1;
        if (attempts === 1) return adapter.connect({ host: HOST_ADDRESS, port: h.port }, handlers);
        if (fixed) return fixed();
        void Promise.resolve().then(() => handlers.onOpen());
        return { send: () => true, close: () => undefined };
      },
    });
    client.start();
    await flush();
    expect(client.getSnapshot().status).toBe('connected');
    h.net.sever(h.net.linkIds()[0]);
    await flush();
    const lost = client.getSnapshot();
    expect(lost.status).toBe('reconnecting');
    expect(lost.reconnectDeadline).toBe(Date.now() + 20000);

    await advance(19500);
    expect(client.getSnapshot().status).toBe('reconnecting');
    expect(Date.now()).toBeLessThan(client.getSnapshot().reconnectDeadline as number);
    await advance(500);
    expect(client.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'connection-lost', reconnectDeadline: null });
    expect(attempts).toBe(4); // the first connection, then tries at 1 s, 10 s and 19 s
  });
});
