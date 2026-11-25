/**
 * The authoritative host of a local-network game.
 *
 * It owns the lobby and drives the pure game engine (one source of truth for
 * the rules): hand-off phases are revealed automatically, simultaneous guesses
 * are buffered and applied in guesserOrder once every guesser has guessed (or
 * was skipped), and clues are validated and scored here so every phone sees
 * the same result.
 *
 * Trust model: every inbound object is validated (protocol.ts). A connection
 * gets a seat only through 'hello'; afterwards the seat is looked up from the
 * connection, never from message contents. Anything invalid, out of phase or
 * not permitted for that seat is ignored; a peer that keeps sending garbage is
 * dropped. Each seat only ever receives projectView(state, seat).
 *
 * The host's own player is `session.client`, an ordinary ClientSession wired
 * through an in-process loopback that uses the same serialise -> validate ->
 * handle path as remote peers.
 *
 * All inbound events, timer callbacks and loopback deliveries run through one
 * FIFO queue, so the session is never re-entered.
 */
import { MAX_PLAYERS, createGame, gameReducer, normalizeWord, sanitizeSettings, validateClue } from '../game';
import type { GameAction, GameSettings, GameState } from '../game';
import { ClientSession } from './clientSession';
import {
  MAX_WORD_INPUT_LENGTH,
  PROTOCOL_VERSION,
  createToken,
  encodeLine,
  isGuessWord,
  parseClientMessage,
  parsePlayerView,
  uniquePlayerName,
} from './protocol';
import type { ByeReason, ClientMessage, ClueResult, HostMessage, RefusedReason } from './protocol';
import { defaultTimers } from './timers';
import type { Timers } from './timers';
import { LISTENER_CLOSED } from './transport';
import type { ClientTransport, ClientTransportHandlers, HostTransport, Json, NetworkAdapter } from './transport';
import { canForfeitGiver, canStartGame, netPhase, projectView, skippableSeats } from './view';
import type { ContinueBy, SessionSeat, SessionState } from './view';

/** Scores a clue against the hidden word; the UI passes useSimilarity().similarity. */
export type ScoreFn = (clue: string, hiddenWord: string) => Promise<{ raw: number; score: number }>;

export interface HostSessionOptions {
  adapter: NetworkAdapter;
  /** The host player's display name (also the advertised service name). */
  hostName: string;
  score: ScoreFn;
  deck: readonly string[];
  isNoun: (word: string) => boolean;
  /** Read (and sanitised) every time a game starts. Pass a function to pick up later settings changes. */
  settings: GameSettings | (() => GameSettings);
  /** Seed for a game. A number is used for the first game and incremented for each "play again". */
  seed: number | (() => number);
  timers?: Timers;
  /** Who may continue from the result screens. Default 'host'. */
  continueBy?: ContinueBy;
  heartbeatIntervalMs?: number;
  /** Silence after which a remote peer is considered gone. */
  peerTimeoutMs?: number;
  /** A new connection must say hello within this time. */
  helloTimeoutMs?: number;
  /** A clue must be scored within this time, or the giver gets a retryable error. */
  scoreTimeoutMs?: number;
  /** Grace between a final message (refused / bye) and closing the connection, so it is not lost. */
  dropDelayMs?: number;
  /**
   * How long the game may wait for a connected player's word, clue or guess
   * before the host is offered to skip / forfeit for them (disconnected players
   * can be skipped at once).
   */
  idleSkipMs?: number;
}

export const HOST_DEFAULTS = {
  heartbeatIntervalMs: 3000,
  peerTimeoutMs: 10000,
  helloTimeoutMs: 5000,
  scoreTimeoutMs: 20000,
  dropDelayMs: 250,
  idleSkipMs: 60000,
} as const;

export type HostStatus = 'idle' | 'starting' | 'open' | 'stopped' | 'failed';

export interface HostSnapshot {
  status: HostStatus;
  /** This device's LAN address for manual joining, when known. */
  address: string | null;
  port: number | null;
  /** The advertised (mDNS) service name. */
  serviceName: string | null;
  /** Why start() failed, or the last transport error. */
  error: string | null;
  stage: 'lobby' | 'game';
  /** Seats in the lobby / game, connected or not. */
  playerCount: number;
}

type PeerKey = number | 'local';

interface Peer {
  key: PeerKey;
  /** Where the connection comes from, when the transport knows. */
  address: string | null;
  seat: number | null;
  /** Token bucket: messages this connection may still send right now. */
  tokens: number;
  lastRefill: number;
  lastSeen: number;
  strikes: number;
  helloTimer: unknown;
  /** A final message was sent; everything else from this peer is ignored until it is dropped. */
  closing: boolean;
  closeTimer: unknown;
}

interface ScoringJob {
  seat: number;
  id: number;
  clue: string;
  timer: unknown;
}

/** Invalid messages tolerated per connection before it is dropped. */
const MAX_STRIKES = 20;
/** Connections that may exist at once (seated or not). */
const MAX_PEERS = 32;
/** Connections without a seat that one address may hold at once; the oldest is dropped for a new one. */
const MAX_UNSEATED_PER_ADDRESS = 3;
/** Lobby seats one address may hold (two, so two phones behind one address still work). */
const MAX_SEATS_PER_ADDRESS = 2;
/** Messages per second a remote connection may send on average, and in one burst. Real traffic is a few per minute. */
const RATE_PER_SEC = 20;
const RATE_BURST = 40;

/**
 * Addresses that many devices share from the host's point of view (loopback, and the
 * gateway through which Android emulators reach each other). They are treated as
 * "address unknown", so the per-address limits never lump such players together.
 */
const SHARED_ADDRESSES: readonly string[] = ['127.0.0.1', '::1', 'localhost', '10.0.2.2'];

function errorText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return typeof e === 'string' && e ? e : 'unknown error';
}

function scoringError(detail: string): ClueResult {
  const text = detail.slice(0, 120);
  return {
    kind: 'error',
    message: text
      ? `The word model could not score that clue (${text}). Nothing was counted - try again.`
      : 'The word model could not score that clue. Nothing was counted - try again.',
  };
}

export class HostSession {
  /** The host's own player. Use it exactly like a remote player's session. */
  readonly client: ClientSession;

  private readonly o: Required<Omit<HostSessionOptions, 'timers'>>;
  private readonly timers: Timers;
  private readonly listeners = new Set<() => void>();
  private snapshot: HostSnapshot;

  private transport: HostTransport | null = null;
  private stopPromise: Promise<void> | null = null;

  private state: SessionState;
  private dirty = false;
  private nextSeat = 0;
  private gamesStarted = 0;
  private readonly tokens = new Map<number, string>();
  /** The address each remote seat was created from. Never part of the state or any view. */
  private readonly seatAddress = new Map<number, string>();
  /** Addresses whose player the host removed from the current lobby. */
  private readonly removedAddresses = new Set<string>();
  private idleKey = '';
  /** Bumped whenever the awaited giver does something that is not otherwise visible in the state. */
  private idleEpoch = 0;
  private idleTimer: unknown = null;
  private readonly seatPeer = new Map<number, PeerKey>();
  private readonly peers = new Map<PeerKey, Peer>();
  private readonly lastSent = new Map<number, string>();
  private scoringJob: ScoringJob | null = null;

  private localHandlers: ClientTransportHandlers | null = null;
  private readonly queue: (() => void)[] = [];
  private running = false;

  private heartbeatTimer: unknown = null;
  private lastTick = 0;
  private pingCounter = 0;

  constructor(options: HostSessionOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.o = {
      adapter: options.adapter,
      hostName: options.hostName,
      score: options.score,
      deck: options.deck,
      isNoun: options.isNoun,
      settings: options.settings,
      seed: options.seed,
      continueBy: options.continueBy ?? 'host',
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? HOST_DEFAULTS.heartbeatIntervalMs,
      peerTimeoutMs: options.peerTimeoutMs ?? HOST_DEFAULTS.peerTimeoutMs,
      helloTimeoutMs: options.helloTimeoutMs ?? HOST_DEFAULTS.helloTimeoutMs,
      scoreTimeoutMs: options.scoreTimeoutMs ?? HOST_DEFAULTS.scoreTimeoutMs,
      dropDelayMs: options.dropDelayMs ?? HOST_DEFAULTS.dropDelayMs,
      idleSkipMs: options.idleSkipMs ?? HOST_DEFAULTS.idleSkipMs,
    };
    this.state = {
      stage: 'lobby',
      seats: [],
      settings: this.readSettings(),
      game: null,
      step: 0,
      pendingGuesses: {},
      scoring: false,
      continueBy: this.o.continueBy,
    };
    this.snapshot = {
      status: 'idle',
      address: null,
      port: null,
      serviceName: null,
      error: null,
      stage: 'lobby',
      playerCount: 0,
    };
    this.client = new ClientSession({
      connect: (handlers) => this.connectLocal(handlers),
      name: options.hostName,
      token: createToken(),
      timers: this.timers,
      heartbeat: false,
    });
  }

  // ---------------------------------------------------------------- store

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): HostSnapshot => this.snapshot;

  private update(patch: Partial<HostSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    const keys = Object.keys(next) as (keyof HostSnapshot)[];
    if (keys.every((k) => next[k] === this.snapshot[k])) return;
    this.snapshot = next;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // A broken listener must not break the session.
      }
    }
  }

  /**
   * The authoritative state (lobby + engine GameState), for tests and debugging
   * only. It contains every secret: never render it and never send it anywhere.
   */
  debugState(): SessionState {
    return this.state;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Opens the lobby: starts listening/advertising and seats the host player.
   * Resolves once the lobby is open; on failure the snapshot status is 'failed'
   * (with `error`) and the promise rejects.
   */
  async start(): Promise<void> {
    if (this.snapshot.status !== 'idle') return;
    this.update({ status: 'starting' });
    try {
      const transport = await this.o.adapter.startHost(
        { name: this.o.hostName, txt: { v: String(PROTOCOL_VERSION) } },
        {
          onPeer: (peerId, remoteAddress) => this.run(() => this.onPeer(peerId, remoteAddress)),
          onMessage: (peerId, msg) => this.run(() => this.handleMessage(peerId, msg)),
          onPeerGone: (peerId) => this.run(() => this.removePeer(peerId, false)),
          onError: (e) => this.onTransportError(e),
        },
      );
      if (this.status() !== 'starting') {
        // stop() was called while starting.
        await transport.stop().catch(() => undefined);
        return;
      }
      this.transport = transport;
      // Seat the host player first, so the host is always the first player.
      this.client.start();
      let address: string | null = null;
      try {
        address = await this.o.adapter.getLocalAddress();
      } catch {
        address = null;
      }
      if (this.status() !== 'starting') {
        // stop() was called while the address was being read (stopping twice is harmless).
        await transport.stop().catch(() => undefined);
        return;
      }
      this.update({ status: 'open', port: transport.port, serviceName: transport.serviceName, address });
      this.lastTick = this.timers.now();
      this.scheduleHeartbeat();
    } catch (e) {
      if (this.status() === 'starting') this.update({ status: 'failed', error: errorText(e) });
      throw e;
    }
  }

  /**
   * Closes the game deliberately: every client is told the host left, then the
   * transport is stopped. Safe to call more than once.
   */
  stop(): Promise<void> {
    return this.shutdown('stopped', null);
  }

  /**
   * The transport reported a problem. Most are informational (shown in the
   * lobby); a dead listener ends the session, because nobody could join or
   * reconnect any more.
   */
  private onTransportError(e: unknown): void {
    const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
    if (code === LISTENER_CLOSED && this.snapshot.status === 'open') {
      void this.shutdown('failed', `This phone stopped accepting connections (${errorText(e)}). The game was closed.`);
      return;
    }
    this.update({ error: errorText(e) });
  }

  private shutdown(status: 'stopped' | 'failed', error: string | null): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const wasOpen = this.snapshot.status === 'open';
    this.update(error === null ? { status } : { status, error });
    this.cancelScoring();
    if (this.idleTimer !== null) {
      this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.removedAddresses.clear();
    if (this.heartbeatTimer !== null) {
      this.timers.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const peer of this.peers.values()) this.clearPeerTimers(peer);
    const transport = this.transport;
    this.transport = null;
    this.client.leave();
    if (!transport) {
      this.stopPromise = Promise.resolve();
      return this.stopPromise;
    }
    if (!wasOpen) {
      // Stopped while the lobby was still opening: nobody to tell, but the listener must go.
      this.peers.clear();
      this.seatPeer.clear();
      this.stopPromise = transport.stop().then(
        () => undefined,
        () => undefined,
      );
      return this.stopPromise;
    }
    try {
      transport.broadcast(this.wire({ v: PROTOCOL_VERSION, t: 'bye', reason: 'host-left' }));
    } catch {
      // ignore
    }
    this.peers.clear();
    this.seatPeer.clear();
    this.stopPromise = new Promise<void>((resolve) => {
      // Give the goodbye a moment to leave before the sockets are destroyed.
      this.timers.setTimeout(() => {
        transport.stop().then(
          () => resolve(),
          () => resolve(),
        );
      }, this.o.dropDelayMs);
    });
    return this.stopPromise;
  }

  /** Re-reads the settings option while in the lobby, so the lobby shows the host's current settings. */
  refreshSettings(): void {
    this.run(() => {
      if (this.state.stage !== 'lobby') return;
      this.state = { ...this.state, settings: this.readSettings() };
      this.dirty = true;
    });
  }

  // ---------------------------------------------------------------- queue

  private status(): HostStatus {
    return this.snapshot.status;
  }

  private get stopped(): boolean {
    return this.snapshot.status === 'stopped' || this.snapshot.status === 'failed';
  }

  private run(task: () => void): void {
    this.queue.push(task);
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift() as () => void;
        try {
          next();
        } catch (e) {
          // Never let one bad event take the host down.
          this.update({ error: errorText(e) });
        }
        try {
          this.syncIdle();
        } catch (e) {
          this.update({ error: errorText(e) });
        }
        if (this.dirty) {
          try {
            this.flushViews();
          } catch (e) {
            this.update({ error: errorText(e) });
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  // ---------------------------------------------------------------- sending

  private wire(msg: HostMessage): Json {
    return msg as unknown as Json;
  }

  private send(key: PeerKey, msg: HostMessage): void {
    if (key === 'local') {
      const line = encodeLine(msg);
      if (line === null) return;
      const target = this.localHandlers;
      this.run(() => {
        if (target && this.localHandlers === target) target.onMessage(JSON.parse(line) as Json);
      });
      return;
    }
    try {
      this.transport?.sendTo(key, this.wire(msg));
    } catch {
      // A failed send shows up as a dead peer through the heartbeat.
    }
  }

  private sendToSeat(seat: number, msg: HostMessage): void {
    const key = this.seatPeer.get(seat);
    if (key !== undefined) this.send(key, msg);
  }

  private flushViews(): void {
    this.dirty = false;
    this.update({ stage: this.state.stage, playerCount: this.state.seats.length });
    for (const seat of this.state.seats) {
      const key = this.seatPeer.get(seat.seat);
      if (key === undefined) continue;
      const view = projectView(this.state, seat.seat);
      const body = JSON.stringify(view);
      if (this.lastSent.get(seat.seat) === body) continue;
      this.lastSent.set(seat.seat, body);
      // Invariant: the host never produces a view the clients' validator rejects.
      // A client would silently drop it and fall behind, so make a breach visible.
      if (parsePlayerView(JSON.parse(body)) === null) {
        this.update({ error: `Internal error: the game view for ${seat.name} is not valid and will be ignored by their phone.` });
      }
      this.send(key, { v: PROTOCOL_VERSION, t: 'view', view });
    }
  }

  // ---------------------------------------------------------------- loopback

  private connectLocal(handlers: ClientTransportHandlers): ClientTransport {
    let closed = false;
    this.run(() => {
      if (closed || this.stopped) return;
      // Only one local connection exists at a time.
      if (this.peers.has('local')) this.removePeer('local', false);
      this.localHandlers = handlers;
      this.peers.set('local', this.newPeer('local'));
      this.run(() => {
        if (!closed) handlers.onOpen();
      });
    });
    return {
      send: (msg) => {
        if (closed || this.localHandlers !== handlers) return false;
        const line = encodeLine(msg);
        if (line === null) return false;
        this.run(() => {
          if (this.localHandlers === handlers) this.handleMessage('local', JSON.parse(line) as unknown);
        });
        return true;
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.run(() => {
          if (this.localHandlers === handlers) {
            this.localHandlers = null;
            this.removePeer('local', false);
          }
        });
      },
    };
  }

  // ---------------------------------------------------------------- peers

  private newPeer(key: PeerKey, address: string | null = null): Peer {
    const now = this.timers.now();
    const peer: Peer = {
      key,
      address,
      seat: null,
      tokens: RATE_BURST,
      lastRefill: now,
      lastSeen: now,
      strikes: 0,
      helloTimer: null,
      closing: false,
      closeTimer: null,
    };
    if (key !== 'local') {
      peer.helloTimer = this.timers.setTimeout(() => {
        peer.helloTimer = null;
        this.run(() => {
          if (this.peers.get(key) === peer && peer.seat === null) this.removePeer(key, true);
        });
      }, this.o.helloTimeoutMs);
    }
    return peer;
  }

  private onPeer(peerId: number, remoteAddress?: string): void {
    if (this.stopped) {
      this.dropTransportPeer(peerId);
      return;
    }
    if (this.peers.has(peerId)) this.removePeer(peerId, false);
    const address =
      typeof remoteAddress === 'string' && remoteAddress && !SHARED_ADDRESSES.includes(remoteAddress) ? remoteAddress : null;
    // Map order is insertion order, so the first match is the oldest connection.
    const unseated = [...this.peers.values()].filter((p) => p.key !== 'local' && p.seat === null && !p.closing);
    if (address !== null) {
      // One device cannot hold more than a few seatless connections: the oldest makes room.
      const sameAddress = unseated.filter((p) => p.address === address);
      if (sameAddress.length >= MAX_UNSEATED_PER_ADDRESS) this.removePeer(sameAddress[0].key, true);
    }
    if (this.peers.size >= MAX_PEERS) {
      // Full: a connection that never said hello gives way; seated players never do.
      const victim = unseated.find((p) => this.peers.get(p.key) === p);
      if (!victim) {
        this.dropTransportPeer(peerId);
        return;
      }
      this.removePeer(victim.key, true);
    }
    this.peers.set(peerId, this.newPeer(peerId, address));
  }

  private clearPeerTimers(peer: Peer): void {
    if (peer.helloTimer !== null) this.timers.clearTimeout(peer.helloTimer);
    if (peer.closeTimer !== null) this.timers.clearTimeout(peer.closeTimer);
    peer.helloTimer = null;
    peer.closeTimer = null;
  }

  private dropTransportPeer(key: PeerKey): void {
    if (key === 'local') return;
    try {
      this.transport?.dropPeer(key);
    } catch {
      // ignore
    }
  }

  /**
   * Forgets a connection (and closes it when `drop`). Its seat, if any, stays
   * in the game as disconnected so the player can reclaim it with their token.
   */
  private removePeer(key: PeerKey, drop: boolean): void {
    const peer = this.peers.get(key);
    if (drop) this.dropTransportPeer(key);
    if (!peer) return;
    this.peers.delete(key);
    this.clearPeerTimers(peer);
    if (peer.seat !== null && this.seatPeer.get(peer.seat) === key) {
      this.seatPeer.delete(peer.seat);
      this.lastSent.delete(peer.seat);
      this.setConnected(peer.seat, false);
    }
  }

  /** Sends a final message, then closes the connection after a short grace period. */
  private sendAndClose(peer: Peer, msg: HostMessage): void {
    peer.closing = true;
    this.send(peer.key, msg);
    if (peer.closeTimer !== null) return;
    peer.closeTimer = this.timers.setTimeout(() => {
      peer.closeTimer = null;
      this.run(() => {
        if (this.peers.get(peer.key) === peer) this.removePeer(peer.key, true);
      });
    }, this.o.dropDelayMs);
  }

  private refuse(peer: Peer, reason: RefusedReason): void {
    this.sendAndClose(peer, { v: PROTOCOL_VERSION, t: 'refused', reason, hostVersion: PROTOCOL_VERSION });
  }

  private bye(peer: Peer, reason: ByeReason): void {
    this.sendAndClose(peer, { v: PROTOCOL_VERSION, t: 'bye', reason });
  }

  private setConnected(seat: number, connected: boolean): void {
    const current = this.state.seats.find((s) => s.seat === seat);
    if (!current || current.connected === connected) return;
    this.state = {
      ...this.state,
      seats: this.state.seats.map((s) => (s.seat === seat ? { ...s, connected } : s)),
    };
    this.dirty = true;
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = this.timers.setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.snapshot.status !== 'open') return;
      this.run(() => this.heartbeat());
      this.scheduleHeartbeat();
    }, this.o.heartbeatIntervalMs);
  }

  private heartbeat(): void {
    const now = this.timers.now();
    // After the app was suspended every peer looks silent; give them a fresh start instead.
    const jumped = now - this.lastTick > this.o.heartbeatIntervalMs * 2;
    this.lastTick = now;
    this.pingCounter = (this.pingCounter + 1) % 1_000_000;
    for (const peer of [...this.peers.values()]) {
      if (peer.key === 'local' || peer.closing) continue;
      if (jumped) peer.lastSeen = now;
      if (now - peer.lastSeen >= this.o.peerTimeoutMs) {
        this.removePeer(peer.key, true);
        continue;
      }
      this.send(peer.key, { v: PROTOCOL_VERSION, t: 'ping', n: this.pingCounter });
    }
  }

  // ---------------------------------------------------------------- inbound

  private handleMessage(key: PeerKey, raw: unknown): void {
    if (this.stopped) return;
    const peer = this.peers.get(key);
    if (!peer || peer.closing) return;
    const now = this.timers.now();
    if (key !== 'local') {
      // Rate limit: a connection that floods the host (even with valid messages) is dropped.
      const elapsed = Math.max(0, now - peer.lastRefill);
      peer.tokens = Math.min(RATE_BURST, peer.tokens + (elapsed / 1000) * RATE_PER_SEC);
      peer.lastRefill = now;
      if (peer.tokens < 1) {
        this.removePeer(key, true);
        return;
      }
      peer.tokens -= 1;
    }
    peer.lastSeen = now;

    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      if (parsed.reason === 'version' && peer.seat === null) {
        this.refuse(peer, 'version');
        return;
      }
      this.strike(peer);
      return;
    }
    const msg = parsed.msg;

    if (msg.t === 'ping') {
      // Only players get an answer; a connection that has not said hello is not kept busy.
      if (peer.seat !== null) this.send(key, { v: PROTOCOL_VERSION, t: 'pong', n: msg.n });
      return;
    }
    if (msg.t === 'pong') return;

    if (msg.t === 'hello') {
      if (peer.seat === null) this.handleHello(peer, msg);
      // A second hello on a seated connection is ignored.
      return;
    }

    // Everything else needs a seat, and the seat comes from the connection.
    if (peer.seat === null) {
      this.strike(peer);
      return;
    }
    const index = this.state.seats.findIndex((s) => s.seat === peer.seat);
    if (index < 0) return;
    this.handleSeatMessage(peer, this.state.seats[index], index, msg);
  }

  private strike(peer: Peer): void {
    peer.strikes += 1;
    if (peer.strikes > MAX_STRIKES) this.removePeer(peer.key, true);
  }

  private handleHello(peer: Peer, msg: Extract<ClientMessage, { t: 'hello' }>): void {
    // Reconnect: the token identifies an existing seat.
    let seat: SessionSeat | undefined;
    for (const s of this.state.seats) {
      if (this.tokens.get(s.seat) === msg.token) seat = s;
    }
    if (seat) {
      // The host's seat can only ever be held by the loopback connection.
      if (seat.isHost !== (peer.key === 'local')) {
        this.refuse(peer, this.state.stage === 'lobby' ? 'full' : 'in-progress');
        return;
      }
      const oldKey = this.seatPeer.get(seat.seat);
      if (oldKey !== undefined && oldKey !== peer.key) {
        const old = this.peers.get(oldKey);
        this.seatPeer.delete(seat.seat);
        if (old) {
          old.seat = null;
          this.bye(old, 'replaced');
        }
      }
      this.bind(peer, seat.seat, seat.name);
      return;
    }

    if (peer.key === 'local') {
      if (this.state.seats.some((s) => s.isHost)) return;
    } else if (this.state.stage !== 'lobby') {
      this.refuse(peer, 'in-progress');
      return;
    } else {
      const address = peer.address;
      if (address !== null) {
        if (this.removedAddresses.has(address)) {
          this.refuse(peer, 'removed');
          return;
        }
        // A device that comes back without its token replaces its own stale seats instead of adding to them.
        for (const s of this.state.seats.filter((x) => !x.connected && !x.isHost && this.seatAddress.get(x.seat) === address)) {
          this.removeSeat(s.seat);
        }
        const held = this.state.seats.filter((x) => this.seatAddress.get(x.seat) === address).length;
        if (held >= MAX_SEATS_PER_ADDRESS) {
          this.refuse(peer, 'full');
          return;
        }
      }
      if (this.state.seats.length >= MAX_PLAYERS) {
        // A full lobby makes room by letting go of a player who is gone (the earliest to have joined).
        const gone = this.state.seats.find((x) => !x.connected && !x.isHost);
        if (!gone) {
          this.refuse(peer, 'full');
          return;
        }
        this.removeSeat(gone.seat);
      }
    }

    const name = uniquePlayerName(
      msg.name,
      this.state.seats.map((s) => s.name),
    );
    const id = this.nextSeat++;
    const created: SessionSeat = { seat: id, name, connected: false, isHost: peer.key === 'local' };
    this.tokens.set(id, msg.token);
    if (peer.key !== 'local' && peer.address !== null) this.seatAddress.set(id, peer.address);
    this.state = { ...this.state, seats: [...this.state.seats, created] };
    this.bind(peer, id, name);
  }

  private bind(peer: Peer, seat: number, name: string): void {
    peer.seat = seat;
    if (peer.helloTimer !== null) {
      this.timers.clearTimeout(peer.helloTimer);
      peer.helloTimer = null;
    }
    this.seatPeer.set(seat, peer.key);
    this.lastSent.delete(seat);
    this.send(peer.key, { v: PROTOCOL_VERSION, t: 'welcome', seat, name });
    this.setConnected(seat, true);
    this.dirty = true; // the newcomer needs a view even if nothing else changed
  }

  private handleSeatMessage(peer: Peer, seat: SessionSeat, index: number, msg: ClientMessage): void {
    const game = this.state.stage === 'game' ? this.state.game : null;
    const isGiver = game !== null && game.giverIndex === index;

    switch (msg.t) {
      case 'leave':
        if (seat.isHost) return; // the host leaves with stop()
        if (this.state.stage === 'lobby') {
          this.removeSeat(seat.seat);
          this.removePeer(peer.key, true);
        } else {
          this.removePeer(peer.key, true);
        }
        return;

      case 'start':
        if (seat.isHost) this.startGame();
        return;

      case 'remove': {
        if (!seat.isHost || this.state.stage !== 'lobby') return;
        const target = this.state.seats.find((s) => s.seat === msg.seat);
        if (!target || target.isHost) return;
        const targetKey = this.seatPeer.get(target.seat);
        const targetPeer = targetKey !== undefined ? this.peers.get(targetKey) : undefined;
        // Removing a player who is here is a kick: that device stays out of this lobby.
        // (A player who is merely gone is only tidied away and may come back.)
        const targetAddress = this.seatAddress.get(target.seat);
        if (target.connected && targetAddress !== undefined) this.removedAddresses.add(targetAddress);
        this.seatPeer.delete(target.seat);
        this.removeSeat(target.seat);
        if (targetPeer) {
          targetPeer.seat = null;
          this.bye(targetPeer, 'removed');
        }
        return;
      }

      case 'again':
        if (!seat.isHost || !game || game.phase !== 'game-over') return;
        this.cancelScoring();
        this.removedAddresses.clear();
        this.state = {
          ...this.state,
          stage: 'lobby',
          game: null,
          step: this.state.step + 1,
          pendingGuesses: {},
          settings: this.readSettings(),
        };
        this.dirty = true;
        return;

      case 'choose':
        if (!game || !isGiver) return;
        this.dispatch({ type: 'CHOOSE_WORD', word: msg.word });
        return;

      case 'clue':
        this.handleClue(seat, isGiver, msg);
        return;

      case 'forfeit':
        if (!game || !isGiver) return;
        if (this.dispatch({ type: 'FORFEIT_TURN' })) this.cancelScoring();
        return;

      case 'forfeitGiver':
        if (!seat.isHost || !canForfeitGiver(this.state)) return;
        if (this.dispatch({ type: 'ABANDON_TURN' })) this.cancelScoring();
        return;

      case 'guess':
        if (!game || isGiver) return;
        this.handleGuess(game, index, msg.guess);
        return;

      case 'skip': {
        if (!seat.isHost || !game) return;
        if (!skippableSeats(this.state).includes(msg.seat)) return;
        const targetIndex = this.state.seats.findIndex((s) => s.seat === msg.seat);
        const id = game.players[targetIndex].id;
        this.state = { ...this.state, pendingGuesses: { ...this.state.pendingGuesses, [id]: null } };
        this.dirty = true;
        this.resolveRoundIfComplete();
        return;
      }

      case 'next':
        if (!game || (game.phase !== 'round-result' && game.phase !== 'turn-result')) return;
        if (msg.step !== this.state.step) return; // stale or duplicate continue
        if (!seat.isHost && this.state.continueBy !== 'anyone') return;
        if (this.dispatch({ type: 'NEXT' })) this.autoReveal();
        return;

      default:
        return;
    }
  }

  // ---------------------------------------------------------------- lobby

  private readSettings(): GameSettings {
    const s = typeof this.o.settings === 'function' ? this.o.settings() : this.o.settings;
    return sanitizeSettings(s);
  }

  private removeSeat(seat: number): void {
    if (!this.state.seats.some((s) => s.seat === seat)) return;
    this.tokens.delete(seat);
    this.seatAddress.delete(seat);
    this.lastSent.delete(seat);
    const key = this.seatPeer.get(seat);
    if (key !== undefined) {
      // A connection still bound to the seat (rare) loses it and is closed.
      this.seatPeer.delete(seat);
      const peer = this.peers.get(key);
      if (peer && peer.seat === seat) {
        peer.seat = null;
        if (key !== 'local') this.removePeer(key, true);
      }
    }
    this.state = { ...this.state, seats: this.state.seats.filter((s) => s.seat !== seat) };
    this.dirty = true;
  }

  private startGame(): void {
    if (!canStartGame(this.state)) return;
    // Players who are not here do not get a seat in the game.
    for (const s of this.state.seats.filter((x) => !x.connected)) this.removeSeat(s.seat);
    const settings = this.readSettings();
    const seed = typeof this.o.seed === 'function' ? this.o.seed() : this.o.seed + this.gamesStarted;
    let game: GameState;
    try {
      game = createGame(
        this.state.seats.map((s) => s.name),
        settings,
        this.o.deck,
        seed,
      );
    } catch (e) {
      this.update({ error: errorText(e) });
      return;
    }
    this.gamesStarted += 1;
    this.cancelScoring();
    this.state = {
      ...this.state,
      stage: 'game',
      settings,
      game,
      step: this.state.step + 1,
      pendingGuesses: {},
      scoring: false,
    };
    this.dirty = true;
    this.autoReveal();
  }

  // ---------------------------------------------------------------- game

  /** Applies an engine action; false (and no change) when the engine rejects it. */
  private dispatch(action: GameAction): boolean {
    const game = this.state.game;
    if (this.state.stage !== 'game' || !game) return false;
    const next = gameReducer(game, action, this.o.deck);
    if (next === game) return false;
    // A rejected clue changes only what the giver sees. The public step stays, so the
    // guessers' views do not change and nothing tells them a clue was rejected.
    const step = action.type === 'CLUE_REJECTED' ? this.state.step : this.state.step + 1;
    this.state = { ...this.state, game: next, step };
    this.dirty = true;
    return true;
  }

  /** There is no device to hand over: the giver's hand-off phase is passed straight through. */
  private autoReveal(): void {
    if (this.state.game?.phase === 'handoff-giver') this.dispatch({ type: 'REVEAL' });
  }

  private handleGuess(game: GameState, index: number, raw: string): void {
    // The engine rests in 'handoff-guesser' (position 0) while guesses are buffered.
    if (game.phase !== 'handoff-guesser' || !game.guesserOrder.includes(index)) return;
    const id = game.players[index].id;
    if (id in this.state.pendingGuesses) return; // first guess counts
    // One word of letters, within the length every client accepts in a view. The guess is
    // shown on every phone, so nothing else (line breaks, control or bidi characters) gets in.
    if (!isGuessWord(raw)) return;
    const guess = normalizeWord(raw);
    // Let the engine itself decide whether the guess is acceptable (dry run).
    const probe = gameReducer(game, { type: 'REVEAL' }, this.o.deck);
    if (gameReducer(probe, { type: 'SUBMIT_GUESS', guess }, this.o.deck) === probe) return;
    this.state = { ...this.state, pendingGuesses: { ...this.state.pendingGuesses, [id]: guess } };
    this.dirty = true;
    this.resolveRoundIfComplete();
  }

  /** When every guesser has guessed or been skipped, feeds the buffered guesses to the engine in guesserOrder. */
  private resolveRoundIfComplete(): void {
    const game = this.state.game;
    if (!game || game.phase !== 'handoff-guesser') return;
    const pending = this.state.pendingGuesses;
    const ids = game.guesserOrder.map((i) => game.players[i].id);
    if (!ids.every((id) => id in pending)) return;

    let g = game;
    for (const id of ids) {
      g = gameReducer(g, { type: 'REVEAL' }, this.o.deck);
      const guess = pending[id];
      // Defence in depth: nothing longer than a client accepts can reach the public round record.
      const usable = guess !== null && guess.length <= MAX_WORD_INPUT_LENGTH;
      let next = usable ? gameReducer(g, { type: 'SUBMIT_GUESS', guess }, this.o.deck) : g;
      // A skipped guess - or, defensively, one the engine refuses after all - counts as blank and wrong.
      if (next === g) next = gameReducer(g, { type: 'SKIP_GUESS' }, this.o.deck);
      g = next;
    }
    this.state = { ...this.state, game: g, step: this.state.step + 1, pendingGuesses: {} };
    this.dirty = true;
  }

  // ---------------------------------------------------------------- idle players

  /**
   * Tracks how long the game has been waiting for the same thing (a word, a
   * clue, the guesses). After idleSkipMs the state is marked idle-expired, which
   * lets the host skip or forfeit for players who are connected but not
   * playing. Runs after every event; anything that shows the awaited player is
   * active (a new phase, a rejected clue, scoring in flight) restarts the clock.
   */
  private syncIdle(): void {
    const game = this.state.stage === 'game' ? this.state.game : null;
    let key = '';
    if (game && !this.stopped && !this.state.scoring) {
      const phase = netPhase(game);
      if (phase === 'choose-word' || phase === 'clue' || phase === 'guess') {
        key = `${this.state.step}:${phase}:${game.rejectedThisRound.length}:${this.idleEpoch}`;
      }
    }
    if (key === this.idleKey) return;
    this.idleKey = key;
    if (this.idleTimer !== null) {
      this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.state.idleExpired) {
      this.state = { ...this.state, idleExpired: false };
      this.dirty = true;
    }
    if (key === '') return;
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      this.run(() => {
        if (this.idleKey !== key || this.state.idleExpired) return;
        this.state = { ...this.state, idleExpired: true };
        this.dirty = true;
      });
    }, this.o.idleSkipMs);
  }

  // ---------------------------------------------------------------- clue scoring

  private replyClue(seat: number, id: number, result: ClueResult): void {
    this.sendToSeat(seat, { v: PROTOCOL_VERSION, t: 'clueResult', id, result });
  }

  private cancelScoring(): void {
    const job = this.scoringJob;
    this.scoringJob = null;
    if (job) {
      this.timers.clearTimeout(job.timer);
      // The giver's client is still waiting for an answer to this submission.
      this.replyClue(job.seat, job.id, {
        kind: 'error',
        message: 'The turn ended before that clue was scored.',
      });
    }
    if (this.state.scoring) {
      this.state = { ...this.state, scoring: false };
      this.dirty = true;
    }
  }

  private handleClue(seat: SessionSeat, isGiver: boolean, msg: Extract<ClientMessage, { t: 'clue' }>): void {
    const game = this.state.stage === 'game' ? this.state.game : null;
    if (!game || !isGiver || game.phase !== 'clue' || game.hiddenWord === null) {
      this.replyClue(seat.seat, msg.id, { kind: 'error', message: 'It is not time to give a clue.' });
      return;
    }
    if (this.scoringJob) {
      this.replyClue(seat.seat, msg.id, { kind: 'busy' });
      return;
    }
    this.idleEpoch += 1; // the giver is trying: not idle
    const validation = validateClue(msg.clue, {
      options: game.options,
      tried: game.triedClues,
      requireDictionaryNoun: game.settings.requireDictionaryNoun,
      isNoun: this.o.isNoun,
    });
    if (!validation.ok) {
      this.replyClue(seat.seat, msg.id, { kind: 'invalid', reason: validation.reason, message: validation.message });
      return;
    }

    const job: ScoringJob = { seat: seat.seat, id: msg.id, clue: validation.clue, timer: null };
    this.scoringJob = job;
    this.state = { ...this.state, scoring: true };
    this.dirty = true;
    job.timer = this.timers.setTimeout(() => {
      this.run(() => this.finishScoring(job, scoringError('it took too long')));
    }, this.o.scoreTimeoutMs);

    let scored: Promise<{ raw: number; score: number }>;
    try {
      scored = Promise.resolve(this.o.score(validation.clue, game.hiddenWord));
    } catch (e) {
      scored = Promise.reject(e);
    }
    scored.then(
      (result) => this.run(() => this.onScored(job, result)),
      (e) => this.run(() => this.finishScoring(job, scoringError(errorText(e)))),
    );
  }

  private onScored(job: ScoringJob, result: unknown): void {
    // The turn moved on (forfeit, abandoned, new game, stop) or the job timed out: ignore.
    if (this.scoringJob !== job) return;
    const game = this.state.game;
    const r = result as { raw?: unknown; score?: unknown } | null;
    if (
      !game ||
      typeof r !== 'object' ||
      r === null ||
      typeof r.score !== 'number' ||
      typeof r.raw !== 'number' ||
      !Number.isFinite(r.score) ||
      !Number.isFinite(r.raw)
    ) {
      this.finishScoring(job, scoringError('the model returned an invalid score'));
      return;
    }
    const score = Math.min(1, Math.max(0, r.score));
    const raw = Math.min(1, Math.max(-1, r.raw));
    // Same comparison the engine makes, so the dispatched action is always valid.
    const accepted = score >= game.settings.threshold;
    const applied = this.dispatch({ type: accepted ? 'CLUE_ACCEPTED' : 'CLUE_REJECTED', clue: job.clue, score });
    if (!applied) {
      this.finishScoring(job, { kind: 'error', message: 'That clue could not be counted. Try again.' });
      return;
    }
    if (accepted) this.state = { ...this.state, pendingGuesses: {} };
    this.finishScoring(job, { kind: accepted ? 'accepted' : 'rejected', clue: job.clue, score, raw });
  }

  private finishScoring(job: ScoringJob, result: ClueResult): void {
    if (this.scoringJob !== job) return;
    this.scoringJob = null;
    this.timers.clearTimeout(job.timer);
    this.state = { ...this.state, scoring: false };
    this.dirty = true;
    this.replyClue(job.seat, job.id, result);
  }
}
