/** Shared helpers for the session tests (not a test file itself). */
import { DEFAULT_SETTINGS } from '../../game';
import type { GameSettings, GameState } from '../../game';
import { ClientSession, createClientSession } from '../clientSession';
import { HostSession } from '../hostSession';
import type { HostSessionOptions, ScoreFn } from '../hostSession';
import { MemoryNetwork } from '../memoryAdapter';
import { PROTOCOL_VERSION } from '../protocol';
import type { ClueResult } from '../protocol';
import type { ClientTransport, Json, NetworkAdapter } from '../transport';
import type { GameView, PlayerView } from '../view';

/** 60 distinct words, none a substring of another, none containing a test clue or guess. */
export const DECK: readonly string[] = Array.from({ length: 60 }, (_, i) => {
  const a = String.fromCharCode(97 + (i % 26));
  const b = String.fromCharCode(97 + Math.floor(i / 26));
  return `dk${b}${a}q`;
});

export const SEED = 4242;
export const HOST_ADDRESS = '10.0.0.1';

export function settings(overrides: Partial<GameSettings> = {}): GameSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** Lets promise continuations (scoring, adapter microtasks) run. Works under fake timers. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Clues starting with "ok" score 0.97 (accepted at the default threshold); everything else 0.5. */
export const defaultScore: ScoreFn = async (clue) => ({ raw: clue.startsWith('ok') ? 0.7 : 0.3, score: clue.startsWith('ok') ? 0.97 : 0.5 });

let clueCounter = 0;
function letters(n: number): string {
  return `${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + (Math.floor(n / 26) % 26))}${String.fromCharCode(97 + (Math.floor(n / 676) % 26))}`;
}
/** A fresh clue that will be accepted. */
export function okClue(): string {
  clueCounter += 1;
  return `ok${letters(clueCounter)}v`;
}
/** A fresh clue that will be rejected. */
export function badClue(): string {
  clueCounter += 1;
  return `no${letters(clueCounter)}v`;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface Harness {
  net: MemoryNetwork;
  host: HostSession;
  /** clients[0] is the host's own player. */
  clients: ClientSession[];
  adapters: NetworkAdapter[];
  port: number;
  /** The authoritative engine state (test-only peek). */
  game(): GameState;
  view(i: number): PlayerView;
  gameView(i: number): GameView;
  /** Index into clients of the current giver. */
  giverIndex(): number;
  join(name: string, token?: string): Promise<ClientSession>;
  start(): Promise<void>;
}

export interface SetupOptions extends Partial<Omit<HostSessionOptions, 'adapter'>> {
  /** Total players including the host (default 3). */
  players?: number;
  /** Start the game (default true). */
  startGame?: boolean;
}

export async function setup(options: SetupOptions = {}): Promise<Harness> {
  const { players = 3, startGame = true, ...hostOptions } = options;
  const net = new MemoryNetwork();
  const hostAdapter = net.createAdapter(HOST_ADDRESS);
  const host = new HostSession({
    adapter: hostAdapter,
    hostName: 'Host',
    score: defaultScore,
    deck: DECK,
    isNoun: () => true,
    settings: settings(),
    seed: SEED,
    ...hostOptions,
  });
  await host.start();
  const port = host.getSnapshot().port as number;
  const h: Harness = {
    net,
    host,
    clients: [host.client],
    adapters: [hostAdapter],
    port,
    game: () => {
      const g = host.debugState().game;
      if (!g) throw new Error('no game');
      return g;
    },
    view: (i) => {
      const v = h.clients[i].getSnapshot().view;
      if (!v) throw new Error(`client ${i} has no view`);
      return v;
    },
    gameView: (i) => {
      const g = h.view(i).game;
      if (!g) throw new Error(`client ${i} has no game view`);
      return g;
    },
    giverIndex: () => {
      const seat = h.gameView(0).giverSeat;
      return h.clients.findIndex((c) => c.getSnapshot().seat === seat);
    },
    join: async (name, token) => {
      const adapter = net.createAdapter();
      const client = createClientSession({ adapter, target: { host: HOST_ADDRESS, port }, name, token });
      client.start();
      await flush();
      h.clients.push(client);
      h.adapters.push(adapter);
      return client;
    },
    start: async () => {
      host.client.startGame();
      await flush();
    },
  };
  for (let i = 1; i < players; i++) await h.join(`P${i + 1}`);
  if (startGame) await h.start();
  return h;
}

export async function submitClue(client: ClientSession, clue: string): Promise<ClueResult> {
  const p = client.submitClue(clue);
  await flush();
  return p;
}

/** A guess that is wrong and valid in the game's mode. */
export function wrongGuess(h: Harness): string {
  const g = h.game();
  if (g.settings.guessMode === 'open') return 'zzwrong';
  return g.options.find((o) => o !== g.hiddenWord) as string;
}

/** From a fresh turn: the giver chooses options[pick] and gets a clue accepted. Ends in the guess phase. */
export async function toGuessPhase(h: Harness, pick = 0): Promise<{ giver: number; word: string; clue: string }> {
  const giver = h.giverIndex();
  if (h.gameView(giver).phase === 'choose-word') {
    h.clients[giver].chooseWord(h.game().options[pick]);
  }
  const clue = okClue();
  const result = await submitClue(h.clients[giver], clue);
  if (result.kind !== 'accepted') throw new Error(`clue not accepted: ${JSON.stringify(result)}`);
  return { giver, word: h.game().hiddenWord as string, clue };
}

/** A hand-driven connection speaking the wire protocol directly (for hostile / odd peers). */
export class RawClient {
  readonly received: Json[] = [];
  closed: 'closed' | 'error' | 'timeout' | null = null;
  opened = false;
  private readonly transport: ClientTransport;

  constructor(adapter: NetworkAdapter, port: number, host = HOST_ADDRESS) {
    this.transport = adapter.connect(
      { host, port },
      {
        onOpen: () => {
          this.opened = true;
        },
        onMessage: (msg) => {
          this.received.push(msg);
        },
        onClose: (reason) => {
          this.closed = reason;
        },
      },
    );
  }

  /** Sends anything, exactly as given. */
  sendRaw(msg: unknown): boolean {
    return this.transport.send(msg as Json);
  }

  /** Sends a well-formed envelope of the current protocol version. */
  send(t: string, fields: Record<string, unknown> = {}): boolean {
    return this.sendRaw({ v: PROTOCOL_VERSION, t, ...fields });
  }

  hello(name: string, token = `rawtoken-${name}-0000`): boolean {
    return this.send('hello', { name, token });
  }

  close(): void {
    this.transport.close();
  }

  ofType(t: string): Json[] {
    return this.received.filter((m) => m.t === t);
  }

  /** The most recent view received. */
  view(): PlayerView {
    const views = this.ofType('view');
    if (views.length === 0) throw new Error('no view received');
    return views[views.length - 1].view as PlayerView;
  }

  gameView(): GameView {
    const g = this.view().game;
    if (!g) throw new Error('no game view');
    return g;
  }
}

export async function rawJoin(h: Harness, name: string, token?: string): Promise<RawClient> {
  const raw = new RawClient(h.net.createAdapter(), h.port);
  await flush();
  raw.hello(name, token);
  await flush();
  return raw;
}
