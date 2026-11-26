import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createGame, gameReducer } from '../../game';
import type { GameAction } from '../../game';
import { createClientSession } from '../clientSession';
import { HostSession } from '../hostSession';
import { MemoryNetwork } from '../memoryAdapter';
import type { FoundHost } from '../transport';
import {
  DECK,
  HOST_ADDRESS,
  SEED,
  badClue,
  defaultScore,
  deferred,
  flush,
  okClue,
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

/** Plays turn 1 (host gives, everyone guesses right) so that client 1 is the giver of turn 2. */
async function toSecondTurn(h: Harness): Promise<void> {
  const { word } = await toGuessPhase(h);
  for (let i = 1; i < h.clients.length; i++) h.clients[i].submitGuess(word);
  h.clients[0].next();
  h.clients[0].next();
  expect(h.giverIndex()).toBe(1);
  expect(h.gameView(1).phase).toBe('choose-word');
}

describe('heartbeat', () => {
  test('pings keep idle connections alive for a long time', async () => {
    const h = await setup({ players: 3 });
    await advance(5 * 60 * 1000);
    for (const c of h.clients) expect(c.getSnapshot().status).toBe('connected');
    expect(h.view(0).players.every((p) => p.connected)).toBe(true);
    const types = h.net.log.map((e) => `${e.dir}:${String(e.msg.t)}`);
    expect(types.filter((t) => t === 'to-client:ping').length).toBeGreaterThan(150);
    expect(types.filter((t) => t === 'to-host:pong').length).toBeGreaterThan(150);
    expect(types.filter((t) => t === 'to-host:ping').length).toBeGreaterThan(150);
    // The host's own player needs no heartbeat and is never timed out.
    expect(h.clients[0].getSnapshot().status).toBe('connected');
  });

  test('a peer that falls silent is marked disconnected for everyone after about 10 seconds', async () => {
    const h = await setup({ players: 3 });
    h.net.setOffline(addr(2));
    await advance(9000);
    expect(h.view(0).players[2].connected).toBe(true);
    await advance(4000);
    expect(h.view(0).players.map((p) => p.connected)).toEqual([true, true, false]);
    expect(h.view(1).players.map((p) => p.connected)).toEqual([true, true, false]);
    // The silent phone noticed as well and is trying to get back.
    expect(h.clients[2].getSnapshot().status).toBe('reconnecting');
    expect(h.clients[2].getSnapshot().view).not.toBeNull();
  });

  test('a client notices a silent host after about 10 seconds and starts reconnecting', async () => {
    const h = await setup({ players: 2 });
    h.net.setOffline(HOST_ADDRESS);
    await advance(9000);
    expect(h.clients[1].getSnapshot().status).toBe('connected');
    await advance(4000);
    expect(h.clients[1].getSnapshot()).toMatchObject({
      status: 'reconnecting',
      message: 'Connection lost. Reconnecting...',
    });
  });

  test('after the host app was suspended, nobody is dropped just because the clock jumped', async () => {
    const h = await setup({ players: 3 });
    await advance(6000);
    jest.setSystemTime(Date.now() + 5 * 60 * 1000); // timers did not run meanwhile
    await advance(9000);
    expect(h.view(0).players.every((p) => p.connected)).toBe(true);
    for (const c of h.clients) expect(c.getSnapshot().status).toBe('connected');
  });
});

describe('reconnecting', () => {
  test('a dropped guesser is shown as disconnected, reconnects by itself and gets the current view', async () => {
    const h = await setup({ players: 3 });
    const seat = h.clients[2].getSnapshot().seat;
    h.net.sever(h.net.linksFrom(addr(2))[0]);
    await flush();
    expect(h.view(0).players[2].connected).toBe(false);
    expect(h.view(1).players[2].connected).toBe(false);
    const lost = h.clients[2].getSnapshot();
    expect(lost.status).toBe('reconnecting');
    expect(lost.reconnectDeadline).toBe(Date.now() + 20000);
    expect(lost.view?.game?.phase).toBe('choose-word');

    // The game moves on while the player is away.
    await toGuessPhase(h);
    expect(h.clients[2].getSnapshot().view?.game?.phase).toBe('choose-word');

    await advance(1000);
    const back = h.clients[2].getSnapshot();
    expect(back).toMatchObject({ status: 'connected', seat, name: 'P3', message: null, reconnectDeadline: null });
    expect(back.view?.game?.phase).toBe('guess');
    expect(back.view?.game?.acceptedClues).toHaveLength(1);
    expect(h.view(0).players.map((p) => p.connected)).toEqual([true, true, true]);
    expect(h.game().players).toHaveLength(3);
    // ... and can simply carry on.
    h.clients[1].submitGuess('one');
    h.clients[2].submitGuess('two');
    expect(h.game().phase).toBe('round-result');
  });

  test('a giver who reconnects gets their private view back (word, options, rejected clues)', async () => {
    const h = await setup({ players: 3 });
    await toSecondTurn(h);
    h.clients[1].chooseWord(h.game().options[1]);
    const rejected = badClue();
    await submitClue(h.clients[1], rejected);
    const word = h.game().hiddenWord as string;

    h.net.sever(h.net.linksFrom(addr(1))[0]);
    await advance(1500);
    const g = h.gameView(1);
    expect(h.clients[1].getSnapshot().status).toBe('connected');
    expect(g.role).toBe('giver');
    expect(g.giver).toMatchObject({ hiddenWord: word, options: h.game().options, rejected: [{ clue: rejected, score: 0.5 }] });
    // Nobody else learned anything from the reconnect.
    expect(JSON.stringify(h.view(0))).not.toContain(word);
    expect(JSON.stringify(h.view(2))).not.toContain(word);
  });

  test('after an app restart, a new session with the saved token reclaims the seat mid-game', async () => {
    const h = await setup({ players: 3 });
    await toGuessPhase(h);
    const token = h.clients[1].token;
    const seat = h.clients[1].getSnapshot().seat;
    h.clients[1].submitGuess('beforecrash');
    // The app dies: the connection breaks and the old session object is gone.
    h.net.pause();
    h.net.sever(h.net.linksFrom(addr(1))[0]);
    h.net.discardWhere((e) => e.kind === 'client-close');
    h.net.resume();
    expect(h.view(0).players[1].connected).toBe(false);

    const reborn = await h.join('A different name', token);
    expect(reborn.getSnapshot()).toMatchObject({ status: 'connected', seat, name: 'P2' });
    expect(reborn.getSnapshot().view?.game).toMatchObject({ phase: 'guess', yourGuess: 'beforecrash' });
    expect(h.view(0).players).toHaveLength(3);
    expect(h.view(0).players[1]).toMatchObject({ name: 'P2', connected: true });
    // Without the token the same phone would have been refused.
    const stranger = await h.join('P2');
    expect(stranger.getSnapshot().closeReason).toBe('in-progress');
  });

  test('a second connection with the same token replaces the first, which is told and stops', async () => {
    const h = await setup({ players: 2 });
    const first = h.clients[1];
    const second = await h.join('P2', first.token);
    expect(second.getSnapshot()).toMatchObject({ status: 'connected', seat: first.getSnapshot().seat });
    expect(first.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'replaced' });
    await advance(30000);
    // No tug of war: the first one does not come back.
    expect(first.getSnapshot().status).toBe('closed');
    expect(second.getSnapshot().status).toBe('connected');
    expect(h.view(0).players[1].connected).toBe(true);
  });

  test('a player who leaves mid-game keeps their seat (shown disconnected) and may rejoin with the token', async () => {
    const h = await setup({ players: 3 });
    h.clients[2].leave();
    await flush();
    expect(h.clients[2].getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'left' });
    expect(h.view(0).players.map((p) => [p.name, p.connected])).toEqual([
      ['Host', true],
      ['P2', true],
      ['P3', false],
    ]);
    const back = await h.join('P3', h.clients[2].token);
    expect(back.getSnapshot().status).toBe('connected');
    expect(h.view(0).players[2].connected).toBe(true);
  });

  test('resume() after backgrounding: a dead connection is found within seconds, not after the full timeout', async () => {
    const h = await setup({ players: 2 });
    h.net.setOffline(addr(1)); // the socket died while the app slept
    h.clients[1].resume();
    await advance(3000);
    expect(h.clients[1].getSnapshot().status).toBe('reconnecting');
    // Back on the Wi-Fi: resume() retries at once.
    h.net.setOffline(addr(1), false);
    h.clients[1].resume();
    await flush();
    expect(h.clients[1].getSnapshot().status).toBe('connected');
    expect(h.view(0).players[1].connected).toBe(true);
  });

  test('resume() on a healthy connection changes nothing', async () => {
    const h = await setup({ players: 2 });
    h.clients[1].resume();
    h.clients[0].resume();
    await advance(10000);
    expect(h.clients[1].getSnapshot().status).toBe('connected');
    expect(h.clients[0].getSnapshot().status).toBe('connected');
  });

  test('a host that cannot be reached at all: the session gives up after the connect window', async () => {
    const net = new MemoryNetwork();
    const client = createClientSession({ adapter: net.createAdapter(), target: { host: '10.9.9.9', port: 5 }, name: 'Lonely' });
    client.start();
    await advance(5000);
    expect(client.getSnapshot().status).toBe('connecting');
    await advance(9000);
    expect(client.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'unreachable', view: null });
    expect(client.getSnapshot().message).toMatch(/same Wi-Fi/);
  });

  test('a host that only comes up a few seconds later is still joined', async () => {
    const net = new MemoryNetwork();
    const hostAdapter = net.createAdapter(HOST_ADDRESS);
    // Port numbers are predictable in the memory network.
    const client = createClientSession({ adapter: net.createAdapter(), target: { host: HOST_ADDRESS, port: 40001 }, name: 'Early' });
    client.start();
    await advance(3000);
    const host = new HostSession({
      adapter: hostAdapter,
      hostName: 'Host',
      score: defaultScore,
      deck: DECK,
      isNoun: () => true,
      settings: settings(),
      seed: SEED,
    });
    await host.start();
    expect(host.getSnapshot().port).toBe(40001);
    await advance(2000);
    expect(client.getSnapshot()).toMatchObject({ status: 'connected', name: 'Early' });
    expect(host.client.getSnapshot().view?.players.map((p) => p.name)).toEqual(['Host', 'Early']);
  });
});

describe('a guesser drops out: the host skips their guess', () => {
  test.each(['open', 'list'] as const)('%s mode: the skipped guess counts as wrong and the round resolves like the engine says', async (guessMode) => {
    const h = await setup({ players: 4, settings: settings({ guessMode }) });
    const { word, clue } = await toGuessPhase(h);
    const droppedSeat = h.clients[2].getSnapshot().seat as number;
    h.net.setOffline(addr(2));
    h.clients[1].submitGuess(word);
    expect(h.view(0).host?.skippableSeats).toEqual([]); // still believed to be connected
    h.clients[0].skipGuesser(droppedSeat);
    expect(h.gameView(0).guessStatus.map((s) => s.status)).toEqual(['submitted', 'pending', 'pending']);

    await advance(13000);
    expect(h.view(0).players[2].connected).toBe(false);
    expect(h.view(0).host?.skippableSeats).toEqual([droppedSeat]);
    expect(h.view(1).host).toBeNull();

    // Only the host may skip, and only a disconnected guesser who has not guessed.
    h.clients[1].skipGuesser(droppedSeat);
    h.clients[0].skipGuesser(h.clients[3].getSnapshot().seat as number);
    h.clients[0].skipGuesser(h.clients[1].getSnapshot().seat as number);
    h.clients[0].skipGuesser(h.clients[0].getSnapshot().seat as number);
    h.clients[0].skipGuesser(12345);
    expect(h.gameView(0).guessStatus.map((s) => s.status)).toEqual(['submitted', 'pending', 'pending']);

    h.clients[0].skipGuesser(droppedSeat);
    for (const i of [0, 1, 3]) {
      expect(h.gameView(i).phase).toBe('guess');
      expect(h.gameView(i).guessStatus.map((s) => s.status)).toEqual(['submitted', 'skipped', 'pending']);
    }
    expect(h.view(0).host?.skippableSeats).toEqual([]);
    const lastGuess = guessMode === 'open' ? 'nope' : h.game().options.find((o) => o !== word)!;
    h.clients[3].submitGuess(lastGuess);

    // Reference: the pure engine with a SKIP_GUESS in the same position.
    let ref = createGame(['Host', 'P2', 'P3', 'P4'], settings({ guessMode }), DECK, SEED);
    const actions: GameAction[] = [
      { type: 'REVEAL' },
      { type: 'CHOOSE_WORD', word },
      { type: 'CLUE_ACCEPTED', clue, score: 0.97 },
      { type: 'REVEAL' },
      { type: 'SUBMIT_GUESS', guess: word },
      { type: 'REVEAL' },
      { type: 'SKIP_GUESS' },
      { type: 'REVEAL' },
      { type: 'SUBMIT_GUESS', guess: lastGuess },
    ];
    for (const a of actions) ref = gameReducer(ref, a, DECK);
    expect(ref.phase).toBe('round-result');
    expect(h.game()).toEqual(ref);
    expect(h.gameView(1).rounds[0].guesses).toEqual([
      { playerId: 'p2', guess: word, correct: true },
      { playerId: 'p3', guess: '', correct: false, skipped: true },
      { playerId: 'p4', guess: lastGuess, correct: false },
    ]);
    expect(h.view(3).players.map((p) => p.score)).toEqual([0, 1, 0, 0]);

    // The dropped player comes back and sees the result.
    h.net.setOffline(addr(2), false);
    h.clients[2].resume();
    await flush();
    expect(h.clients[2].getSnapshot().status).toBe('connected');
    expect(h.gameView(2).phase).toBe('round-result');
    expect(h.gameView(2).rounds).toEqual(ref.rounds);
  });

  test('every guesser gone: skipping them all pays the giver like a failed round, and the game continues', async () => {
    const h = await setup({ players: 3 });
    await toGuessPhase(h);
    h.net.setOffline(addr(1));
    h.net.setOffline(addr(2));
    await advance(13000);
    const seats = h.view(0).host?.skippableSeats as number[];
    expect(seats).toHaveLength(2);
    h.clients[0].skipGuesser(seats[1]);
    expect(h.gameView(0).phase).toBe('guess');
    h.clients[0].skipGuesser(seats[0]);
    expect(h.gameView(0).phase).toBe('round-result');
    expect(h.gameView(0).rounds[0]).toMatchObject({ anyCorrect: false, giverPointsAwarded: 1 });
    expect(h.view(0).players.map((p) => p.score)).toEqual([1, 0, 0]);
    h.clients[0].next();
    expect(h.gameView(0)).toMatchObject({ phase: 'clue', clueRound: 2 });
  });

  test('a skipped player who reconnects before the round ends cannot guess in that round', async () => {
    const h = await setup({ players: 3 });
    const { word } = await toGuessPhase(h);
    h.net.sever(h.net.linksFrom(addr(1))[0]);
    await flush();
    h.clients[0].skipGuesser(h.clients[1].getSnapshot().seat as number);
    await advance(1500);
    expect(h.clients[1].getSnapshot().status).toBe('connected');
    expect(h.gameView(1).guessStatus.map((s) => s.status)).toEqual(['skipped', 'pending']);
    h.clients[1].submitGuess(word);
    expect(h.gameView(1).yourGuess).toBeNull();
    h.clients[2].submitGuess('nope');
    expect(h.game().rounds[0].guesses[0]).toEqual({ playerId: 'p2', guess: '', correct: false, skipped: true });
    expect(h.game().rounds[0].anyCorrect).toBe(false);
    // Next round they are back in.
    h.clients[0].next();
    await toGuessPhase(h);
    h.clients[1].submitGuess(word);
    expect(h.gameView(1).yourGuess).toBe(word);
  });

  test('a guess that arrived before the drop still counts', async () => {
    const h = await setup({ players: 3 });
    const { word } = await toGuessPhase(h);
    h.clients[1].submitGuess(word);
    h.net.sever(h.net.linksFrom(addr(1))[0]);
    await flush();
    expect(h.view(0).host?.skippableSeats).toEqual([]);
    h.clients[2].submitGuess('nope');
    expect(h.game().rounds[0].correctGuesserIds).toEqual(['p2']);
  });
});

describe('the giver drops out: the host forfeits their turn', () => {
  test('before choosing a word', async () => {
    const h = await setup({ players: 3 });
    await toSecondTurn(h);
    expect(h.view(0).host?.canForfeitGiver).toBe(false);
    h.clients[0].forfeitGiver(); // connected giver: refused
    expect(h.gameView(0).phase).toBe('choose-word');

    h.net.setOffline(addr(1));
    await advance(13000);
    expect(h.view(0).host?.canForfeitGiver).toBe(true);
    h.clients[2].forfeitGiver(); // not the host
    expect(h.gameView(0).phase).toBe('choose-word');
    h.clients[0].forfeitGiver();
    for (const i of [0, 2]) {
      expect(h.gameView(i).phase).toBe('turn-result');
      expect(h.gameView(i).turnSummary).toEqual({
        giverId: 'p2',
        hiddenWord: '',
        outcome: 'forfeit',
        roundsPlayed: 0,
        giverPoints: 0,
        correctGuesserIds: [],
        clues: [],
      });
    }
    h.clients[0].next();
    expect(h.gameView(0)).toMatchObject({ phase: 'choose-word', turnNumber: 3 });
    expect(h.gameView(2).role).toBe('giver');
    expect(h.view(0).players.map((p) => p.score)).toEqual([0, 1, 1]);
  });

  test('while they were thinking of a clue: the word is revealed, nobody scores', async () => {
    const h = await setup({ players: 3 });
    await toSecondTurn(h);
    h.clients[1].chooseWord(h.game().options[4]);
    const word = h.game().hiddenWord as string;
    await submitClue(h.clients[1], badClue());
    h.net.sever(h.net.linksFrom(addr(1))[0]);
    h.net.setOffline(addr(1));
    await flush();
    expect(h.view(0).host?.canForfeitGiver).toBe(true);
    h.clients[0].forfeitGiver();
    expect(h.gameView(2).turnSummary).toMatchObject({ outcome: 'forfeit', hiddenWord: word, giverPoints: 0 });
    expect(h.view(0).players.map((p) => p.score)).toEqual([0, 1, 1]);
  });

  test('during a guess round nothing is forfeited; afterwards the turn can be, keeping the point already earned', async () => {
    const h = await setup({ players: 3 });
    await toSecondTurn(h);
    await toGuessPhase(h, 2);
    h.net.sever(h.net.linksFrom(addr(1))[0]);
    h.net.setOffline(addr(1));
    await flush();
    expect(h.view(0).players[1].connected).toBe(false);
    expect(h.view(0).host?.canForfeitGiver).toBe(false);
    h.clients[0].forfeitGiver();
    expect(h.gameView(0).phase).toBe('guess');
    // The guessers do not need the giver.
    h.clients[0].submitGuess('nope');
    h.clients[2].submitGuess('nah');
    expect(h.gameView(0).phase).toBe('round-result');
    h.clients[0].next();
    expect(h.gameView(0)).toMatchObject({ phase: 'clue', clueRound: 2 });
    expect(h.view(0).host?.canForfeitGiver).toBe(true);
    h.clients[0].forfeitGiver();
    expect(h.gameView(0).turnSummary).toMatchObject({ outcome: 'forfeit', roundsPlayed: 1, giverPoints: 1 });
    expect(h.view(0).players.map((p) => p.score)).toEqual([0, 2, 1]);
    // The whole game can still be finished without them.
    h.clients[0].next();
    expect(h.gameView(2)).toMatchObject({ phase: 'choose-word', role: 'giver', turnNumber: 3 });
  });
});

describe('the host goes away', () => {
  test('leaving deliberately tells every client; they do not try to reconnect', async () => {
    const h = await setup({ players: 3 });
    const found: FoundHost[][] = [];
    const stopBrowsing = h.adapters[1].browse({ onChange: (hosts) => found.push(hosts), onError: () => undefined });
    await flush();
    expect(found[found.length - 1]).toEqual([{ name: 'Host', host: HOST_ADDRESS, port: h.port, txt: { v: '2' } }]);

    const stopped = h.host.stop();
    await advance(1000);
    await stopped;
    for (const c of h.clients.slice(1)) {
      expect(c.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'host-left', message: 'The host ended the game.' });
      // The last view is kept so the scores can still be shown.
      expect(c.getSnapshot().view?.stage).toBe('game');
    }
    expect(h.host.getSnapshot().status).toBe('stopped');
    expect(h.host.client.getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'left' });
    expect(found[found.length - 1]).toEqual([]);
    expect(h.net.hostPorts()).toEqual([]);
    await advance(30000);
    for (const c of h.clients.slice(1)) expect(c.getSnapshot().closeReason).toBe('host-left');
    stopBrowsing();
    // stop() twice is fine.
    await h.host.stop();
  });

  test('the host crashes: clients show "connection lost", retry for 20 seconds, then give up', async () => {
    const h = await setup({ players: 3 });
    await toGuessPhase(h);
    h.net.crashHost(h.port);
    await flush();
    for (const c of h.clients.slice(1)) {
      expect(c.getSnapshot()).toMatchObject({ status: 'reconnecting', message: 'Connection lost. Reconnecting...' });
      expect(c.getSnapshot().view?.game?.phase).toBe('guess');
    }
    await advance(19000);
    for (const c of h.clients.slice(1)) expect(c.getSnapshot().status).toBe('reconnecting');
    await advance(2000);
    for (const c of h.clients.slice(1)) {
      expect(c.getSnapshot()).toMatchObject({
        status: 'closed',
        closeReason: 'connection-lost',
        message: 'Connection to the host was lost.',
        reconnectDeadline: null,
      });
    }
    // Coming back to the app later gives it one more window, then it closes again.
    h.clients[1].resume();
    expect(h.clients[1].getSnapshot().status).toBe('reconnecting');
    await advance(21000);
    expect(h.clients[1].getSnapshot()).toMatchObject({ status: 'closed', closeReason: 'connection-lost' });
    // A deliberately closed session is not revived by resume().
    h.clients[2].leave();
    h.clients[2].resume();
    expect(h.clients[2].getSnapshot().status).toBe('closed');
  });

  test('the host drops off the Wi-Fi and returns within the window: everyone is reseated and the game goes on', async () => {
    const h = await setup({ players: 3 });
    const { word } = await toGuessPhase(h);
    h.clients[1].submitGuess('early');
    h.net.setOffline(HOST_ADDRESS);
    await advance(13000);
    expect(h.clients[1].getSnapshot().status).toBe('reconnecting');
    expect(h.clients[2].getSnapshot().status).toBe('reconnecting');
    expect(h.view(0).players.map((p) => p.connected)).toEqual([true, false, false]);
    h.net.setOffline(HOST_ADDRESS, false);
    await advance(2000);
    expect(h.clients[1].getSnapshot().status).toBe('connected');
    expect(h.clients[2].getSnapshot().status).toBe('connected');
    expect(h.view(0).players.map((p) => p.connected)).toEqual([true, true, true]);
    expect(h.gameView(1).yourGuess).toBe('early');
    h.clients[2].submitGuess(word);
    expect(h.gameView(1).phase).toBe('round-result');
    expect(h.view(1).players.map((p) => p.score)).toEqual([0, 0, 1]);
  });

  test('start() failing is reported, not thrown into the void', async () => {
    const net = new MemoryNetwork();
    const adapter = net.createAdapter();
    const host = new HostSession({
      adapter: { ...adapter, startHost: () => Promise.reject(new Error('port in use')) },
      hostName: 'Host',
      score: defaultScore,
      deck: DECK,
      isNoun: () => true,
      settings: settings(),
      seed: 1,
    });
    await expect(host.start()).rejects.toThrow('port in use');
    expect(host.getSnapshot()).toMatchObject({ status: 'failed', error: 'port in use', port: null });
    expect(host.client.getSnapshot().status).toBe('idle');
    await host.stop();
  });
});

describe('clue scoring failures', () => {
  test('a scoring error is reported to the giver as retryable; nothing is counted; the retry works', async () => {
    let fail = true;
    const score = jest.fn(async (clue: string) => {
      if (fail) throw new Error('model is still loading');
      return defaultScore(clue, '');
    });
    const h = await setup({ players: 2, score });
    h.clients[0].chooseWord(h.game().options[0]);
    const before = h.host.debugState().game;
    const clue = okClue();
    const result = await submitClue(h.clients[0], clue);
    expect(result).toEqual({
      kind: 'error',
      message: 'The word model could not score that clue (model is still loading). Nothing was counted - try again.',
    });
    expect(h.host.debugState().game).toBe(before);
    expect(h.gameView(0).giver).toMatchObject({ scoring: false, rejected: [], triedClues: [] });
    expect(h.clients[0].getSnapshot()).toMatchObject({ cluePending: false, lastClueResult: result });
    expect(h.gameView(1).phase).toBe('clue');
    expect(h.host.getSnapshot().status).toBe('open');

    fail = false;
    expect(await submitClue(h.clients[0], clue)).toEqual({ kind: 'accepted', clue, score: 0.97, raw: 0.7 });
    expect(h.gameView(1).phase).toBe('guess');
    expect(score).toHaveBeenCalledTimes(2);
    // The stale result is cleared once the clue phase is over.
    expect(h.clients[0].getSnapshot().lastClueResult).toBeNull();
  });

  test.each<[string, () => unknown]>([
    ['throws synchronously', () => { throw new Error('native module missing'); }],
    ['returns NaN', () => Promise.resolve({ raw: NaN, score: NaN })],
    ['returns nonsense', () => Promise.resolve({ similarity: 1 })],
    ['returns nothing', () => undefined],
    ['rejects with a non-error', () => Promise.reject('boom')],
  ])('a scorer that %s gives a retryable error, never a crash', async (_label, impl) => {
    const h = await setup({ players: 2, score: impl as never });
    h.clients[0].chooseWord(h.game().options[0]);
    const before = h.host.debugState().game;
    const result = await submitClue(h.clients[0], okClue());
    expect(result.kind).toBe('error');
    expect(h.host.debugState().game).toBe(before);
    expect(h.gameView(0).giver?.scoring).toBe(false);
    expect(h.host.getSnapshot().status).toBe('open');
    expect(h.clients[0].getSnapshot().status).toBe('connected');
  });

  test('a scorer that never answers: the giver gets an error after the timeout and a late answer is ignored', async () => {
    const d = deferred<{ raw: number; score: number }>();
    let calls = 0;
    const score = (clue: string) => (calls++ === 0 ? d.promise : defaultScore(clue, ''));
    const h = await setup({ players: 2, score });
    h.clients[0].chooseWord(h.game().options[0]);
    const stuck = okClue();
    const pending = h.clients[0].submitClue(stuck);
    await flush();
    expect(h.gameView(0).giver?.scoring).toBe(true);
    expect(h.clients[0].getSnapshot().cluePending).toBe(true);
    // The other phone sees nothing of this.
    expect(JSON.stringify(h.view(1))).not.toContain(stuck);
    await advance(19000);
    expect(h.clients[0].getSnapshot().cluePending).toBe(true);
    await advance(1500);
    const result = await pending;
    expect(result.kind).toBe('error');
    expect(h.gameView(0).giver?.scoring).toBe(false);

    // The giver moves on with another clue ...
    const next = okClue();
    expect((await submitClue(h.clients[0], next)).kind).toBe('accepted');
    const settled = h.host.debugState();
    // ... and then the first answer finally arrives.
    d.resolve({ raw: 0.9, score: 0.99 });
    await flush();
    expect(h.host.debugState()).toBe(settled);
    expect(h.game().acceptedClues).toEqual([{ clue: next, score: 0.97 }]);
  });

  test('scores are clamped into range before they reach the engine or the wire', async () => {
    const h = await setup({ players: 2, score: async () => ({ raw: 1.0000001, score: 1.0000001 }) });
    h.clients[0].chooseWord(h.game().options[0]);
    const clue = okClue();
    expect(await submitClue(h.clients[0], clue)).toEqual({ kind: 'accepted', clue, score: 1, raw: 1 });
    // The view with that clue still validates on the other phone.
    expect(h.gameView(1).acceptedClues).toEqual([{ clue, score: 1 }]);
  });
});

describe('a scoring answer that arrives after the turn was forfeited is ignored', () => {
  test('giver dropped while scoring, host forfeited the turn', async () => {
    const d = deferred<{ raw: number; score: number }>();
    const score = jest.fn((clue: string, _word: string) => (clue.startsWith('ok') ? d.promise : defaultScore(clue, '')));
    const h = await setup({ players: 3, score });
    // Turn 1 (host gives) uses a clue the scorer answers immediately.
    h.clients[0].chooseWord(h.game().options[0]);
    await submitClue(h.clients[0], badClue());
    // Make client 1 the giver: forfeit is not available, so play it out with rejected clues only.
    for (let i = 0; i < 4; i++) await submitClue(h.clients[0], badClue());
    h.clients[0].forfeit();
    h.clients[0].next();
    expect(h.giverIndex()).toBe(1);

    h.clients[1].chooseWord(h.game().options[0]);
    const clue = okClue();
    const pending = h.clients[1].submitClue(clue);
    await flush();
    expect(score).toHaveBeenLastCalledWith(clue, h.game().hiddenWord as string);
    expect(h.host.debugState().scoring).toBe(true);

    h.net.sever(h.net.linksFrom(addr(1))[0]);
    h.net.setOffline(addr(1));
    await flush();
    expect((await pending).kind).toBe('error');
    h.clients[0].forfeitGiver();
    expect(h.gameView(0).phase).toBe('turn-result');
    expect(h.host.debugState().scoring).toBe(false);
    h.clients[0].next();
    expect(h.gameView(2)).toMatchObject({ phase: 'choose-word', role: 'giver' });
    h.clients[2].chooseWord(h.game().options[0]);

    const settled = h.host.debugState();
    d.resolve({ raw: 0.9, score: 0.99 });
    await flush();
    // Not applied to the new turn, not applied to the old one.
    expect(h.host.debugState()).toBe(settled);
    expect(h.game().acceptedClues).toEqual([]);
    expect(h.game().triedClues).toEqual([]);
    expect(h.gameView(0).phase).toBe('clue');
    expect(h.gameView(2).giver?.scoring).toBe(false);
  });

  test('giver forfeits with a sixth clue still being scored', async () => {
    const d = deferred<{ raw: number; score: number }>();
    const score = (clue: string) => (clue.startsWith('ok') ? d.promise : defaultScore(clue, ''));
    const h = await setup({ players: 2, score });
    h.clients[0].chooseWord(h.game().options[0]);
    for (let i = 0; i < 5; i++) await submitClue(h.clients[0], badClue());
    const pending = h.clients[0].submitClue(okClue());
    await flush();
    expect(h.gameView(0).giver).toMatchObject({ scoring: true, canForfeit: true });
    h.clients[0].forfeit();
    expect(await pending).toEqual({ kind: 'error', message: 'The turn ended before that clue was scored.' });
    expect(h.gameView(1).phase).toBe('turn-result');
    const settled = h.host.debugState();
    d.resolve({ raw: 0.9, score: 0.99 });
    await flush();
    expect(h.host.debugState()).toBe(settled);
    expect(h.gameView(1).turnSummary).toMatchObject({ outcome: 'forfeit', clues: [] });
  });

  test('a scoring answer after the host stopped is harmless', async () => {
    const d = deferred<{ raw: number; score: number }>();
    const h = await setup({ players: 2, score: () => d.promise });
    h.clients[0].chooseWord(h.game().options[0]);
    void h.clients[0].submitClue(okClue());
    await flush();
    const stopped = h.host.stop();
    await advance(1000);
    await stopped;
    d.resolve({ raw: 0.9, score: 0.99 });
    await flush();
    expect(h.host.getSnapshot()).toMatchObject({ status: 'stopped', error: null });
  });
});

describe("the host's own player uses the same projected view as everybody else", () => {
  test('when a remote player gives, the host phone never receives the word, options or rejected clues', async () => {
    const h = await setup({ players: 3 });
    const seen: string[] = [];
    h.host.client.subscribe(() => seen.push(JSON.stringify(h.host.client.getSnapshot())));
    await toSecondTurn(h);
    const options = h.game().options.slice();
    h.clients[1].chooseWord(options[2]);
    const rejected = badClue();
    await submitClue(h.clients[1], rejected);
    await toGuessPhase(h);
    h.clients[2].submitGuess('theirguess');
    const since = seen.length;
    expect(since).toBeGreaterThan(3);
    const secretPhase = seen.filter((s) => s.includes('"turnNumber":2'));
    expect(secretPhase.length).toBeGreaterThan(2);
    for (const s of secretPhase) {
      for (const option of options) expect(s).not.toContain(option);
      expect(s).not.toContain(rejected);
      expect(s).not.toContain('theirguess');
    }
    expect(h.gameView(0).giver).toBeNull();
    expect(h.gameView(0).role).toBe('guesser');
    // The host guesses like anyone else.
    h.clients[0].submitGuess(options[2]);
    expect(h.gameView(0).rounds[0].correctGuesserIds).toEqual(['p1']);
  });

  test('the host snapshot exposes connection details only', async () => {
    const h = await setup({ players: 2 });
    h.clients[0].chooseWord(h.game().options[0]);
    expect(h.host.getSnapshot()).toEqual({
      status: 'open',
      address: HOST_ADDRESS,
      port: h.port,
      serviceName: 'Host',
      error: null,
      stage: 'game',
      playerCount: 2,
    });
  });

  test('snapshots are stable between changes (useSyncExternalStore contract) and listeners can unsubscribe', async () => {
    const h = await setup({ players: 2 });
    const c = h.clients[1];
    expect(c.getSnapshot()).toBe(c.getSnapshot());
    expect(h.host.getSnapshot()).toBe(h.host.getSnapshot());
    let calls = 0;
    const off = c.subscribe(() => calls++);
    const before = c.getSnapshot();
    h.clients[0].chooseWord(h.game().options[0]);
    expect(calls).toBe(1);
    expect(c.getSnapshot()).not.toBe(before);
    off();
    await toGuessPhase(h);
    expect(calls).toBe(1);
    // Heartbeats do not produce new snapshots.
    const idle = c.getSnapshot();
    await advance(30000);
    expect(c.getSnapshot()).toBe(idle);
  });

  test('a raw player joining through the lobby sees exactly one welcome followed by views', async () => {
    const h = await setup({ players: 1, startGame: false });
    const raw = await rawJoin(h, 'Wire');
    expect(raw.received.map((m) => m.t)).toEqual(['welcome', 'view']);
    expect(raw.received[0]).toEqual({ v: 2, t: 'welcome', seat: 1, name: 'Wire' });
    await h.start();
    expect(raw.gameView()).toMatchObject({ phase: 'choose-word', role: 'guesser', giver: null, guessOptions: null });
  });
});
