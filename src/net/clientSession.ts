/**
 * One player's connection to a host: handshake, heartbeat, automatic
 * reconnection and the latest per-player view. Framework-free; React reads it
 * with useSyncExternalStore(session.subscribe, session.getSnapshot).
 *
 * The same class serves remote players (over a NetworkAdapter) and the host's
 * own player (over the host session's loopback), so every screen works from a
 * projected PlayerView only.
 */
import { PROTOCOL_VERSION, createToken, parseHostMessage } from './protocol';
import type { ClientMessage, ClueResult } from './protocol';
import { defaultTimers } from './timers';
import type { Timers } from './timers';
import type { ClientTransport, ClientTransportHandlers, Json, NetworkAdapter } from './transport';
import type { PlayerView } from './view';

export type ClientStatus =
  /** Created, start() not called yet. */
  | 'idle'
  /** First connection attempt(s); no seat yet. */
  | 'connecting'
  | 'connected'
  /** The connection dropped; retrying with the reconnect token. The last view is kept. */
  | 'reconnecting'
  /** Finished; see closeReason. Only resume() (after a lost connection) or a new session continues. */
  | 'closed';

export type ClientCloseReason =
  /** leave() was called. */
  | 'left'
  /** The host closed the game deliberately. */
  | 'host-left'
  /** The host removed this player from the lobby. */
  | 'removed'
  /** Another connection reclaimed this seat with the same token. */
  | 'replaced'
  /** Protocol versions differ: one of the two apps must be updated. */
  | 'version'
  /** The lobby is full. */
  | 'full'
  /** A game is already running there. */
  | 'in-progress'
  /** Was connected, then lost the host and could not reconnect in time. */
  | 'connection-lost'
  /** Never managed to connect. */
  | 'unreachable';

export interface ClientSnapshot {
  status: ClientStatus;
  closeReason: ClientCloseReason | null;
  /** A sentence for the player when status is 'closed' or 'reconnecting'; null otherwise. */
  message: string | null;
  /** The latest view from the host. Kept while reconnecting and after closing (e.g. for final scores). */
  view: PlayerView | null;
  seat: number | null;
  /** The name the host assigned (may differ from the requested one after a clash). */
  name: string;
  /** True between submitClue() and its result. */
  cluePending: boolean;
  /** Result of the most recent clue submission in the current clue phase; cleared when the phase changes. */
  lastClueResult: ClueResult | null;
  /** While reconnecting: when (timers.now() ms) the session gives up. */
  reconnectDeadline: number | null;
}

export interface ClientSessionOptions {
  /** Opens one connection attempt. For remote play: (h) => adapter.connect(target, h). */
  connect: (handlers: ClientTransportHandlers) => ClientTransport;
  name: string;
  /** Reconnect token; persist it to reclaim a seat after an app restart. Random when omitted. */
  token?: string;
  timers?: Timers;
  /** Send pings and watch for silence (default true; the host's loopback client turns it off). */
  heartbeat?: boolean;
  heartbeatIntervalMs?: number;
  /** Silence after which the host is considered gone. */
  peerTimeoutMs?: number;
  /** How long to keep retrying after a connection that worked was lost. */
  reconnectWindowMs?: number;
  /** How long to keep retrying the very first connection. */
  connectWindowMs?: number;
  retryDelayMs?: number;
  /** One attempt must be welcomed within this time. */
  attemptTimeoutMs?: number;
  /** A clue result must arrive within this time. */
  clueTimeoutMs?: number;
}

export const CLIENT_DEFAULTS = {
  heartbeatIntervalMs: 3000,
  peerTimeoutMs: 10000,
  reconnectWindowMs: 20000,
  connectWindowMs: 12000,
  retryDelayMs: 1000,
  attemptTimeoutMs: 8000,
  clueTimeoutMs: 30000,
} as const;

const MESSAGES: Record<ClientCloseReason, string> = {
  left: 'You left the game.',
  'host-left': 'The host ended the game.',
  removed: 'The host removed you from the lobby.',
  replaced: 'This player joined from another connection.',
  version: 'This game uses a different version of the app. Update the app on both phones and try again.',
  full: 'That lobby is full.',
  'in-progress': 'A game is already in progress there.',
  'connection-lost': 'Connection to the host was lost.',
  unreachable: 'Could not reach the host. Check that both phones are on the same Wi-Fi.',
};

const NOT_CONNECTED: ClueResult = {
  kind: 'error',
  message: 'Not connected to the host. Nothing was counted - try again.',
};

interface Attempt {
  transport: ClientTransport | null;
  open: boolean;
  helloSent: boolean;
  over: boolean;
}

export class ClientSession {
  readonly token: string;

  private readonly opts: Required<Omit<ClientSessionOptions, 'connect' | 'name' | 'token' | 'timers'>>;
  private readonly connectFn: ClientSessionOptions['connect'];
  private readonly timers: Timers;
  private readonly requestedName: string;
  private readonly listeners = new Set<() => void>();

  private snapshot: ClientSnapshot;
  private attempt: Attempt | null = null;
  private welcomed = false;
  private everWelcomed = false;
  private windowEnd = 0;
  private lastSeen = 0;
  private lastTick = 0;
  private pingCounter = 0;
  private heardSinceProbe = true;
  private attemptTimer: unknown = null;
  private retryTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private probeTimer: unknown = null;

  private clueCounter = 0;
  private pendingClue: { id: number; resolve: (r: ClueResult) => void; timer: unknown } | null = null;
  /** The guess last handed to a connection and not yet confirmed by a view, with the round it belongs to. */
  private unconfirmedGuess: { guess: string; turnNumber: number; clueRound: number } | null = null;
  /** Set by a re-welcome: the next view decides whether the unconfirmed guess has to be sent again. */
  private recheckGuess = false;

  constructor(options: ClientSessionOptions) {
    this.connectFn = options.connect;
    this.timers = options.timers ?? defaultTimers;
    this.requestedName = options.name;
    this.token = options.token ?? createToken();
    this.opts = {
      heartbeat: options.heartbeat ?? true,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? CLIENT_DEFAULTS.heartbeatIntervalMs,
      peerTimeoutMs: options.peerTimeoutMs ?? CLIENT_DEFAULTS.peerTimeoutMs,
      reconnectWindowMs: options.reconnectWindowMs ?? CLIENT_DEFAULTS.reconnectWindowMs,
      connectWindowMs: options.connectWindowMs ?? CLIENT_DEFAULTS.connectWindowMs,
      retryDelayMs: options.retryDelayMs ?? CLIENT_DEFAULTS.retryDelayMs,
      attemptTimeoutMs: options.attemptTimeoutMs ?? CLIENT_DEFAULTS.attemptTimeoutMs,
      clueTimeoutMs: options.clueTimeoutMs ?? CLIENT_DEFAULTS.clueTimeoutMs,
    };
    this.snapshot = {
      status: 'idle',
      closeReason: null,
      message: null,
      view: null,
      seat: null,
      name: options.name,
      cluePending: false,
      lastClueResult: null,
      reconnectDeadline: null,
    };
  }

  // ---------------------------------------------------------------- store

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ClientSnapshot => this.snapshot;

  private update(patch: Partial<ClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // A broken listener must not break the session.
      }
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Starts connecting. No-op unless the session is idle. */
  start(): void {
    if (this.snapshot.status !== 'idle') return;
    this.windowEnd = this.timers.now() + this.opts.connectWindowMs;
    this.update({ status: 'connecting' });
    this.openAttempt();
  }

  /** Leaves deliberately: tells the host, closes, and ends the session with reason 'left'. */
  leave(): void {
    if (this.snapshot.status === 'closed') {
      // Given up after a lost connection: make that final, so resume() does not revive it.
      const reason = this.snapshot.closeReason;
      if (reason === 'connection-lost' || reason === 'unreachable') {
        this.update({ closeReason: 'left', message: MESSAGES.left });
      }
      return;
    }
    if (this.welcomed) this.send({ v: PROTOCOL_VERSION, t: 'leave' });
    this.finish('left');
  }

  /**
   * Call when the app returns to the foreground. Timers do not run in the
   * background, so this checks the connection right away: a live connection is
   * probed, a retry in progress is restarted without delay, and a session that
   * gave up ('connection-lost' / 'unreachable') gets a fresh reconnect window.
   */
  resume(): void {
    const { status, closeReason } = this.snapshot;
    const now = this.timers.now();
    if (status === 'connected') {
      this.lastTick = now;
      this.send({ v: PROTOCOL_VERSION, t: 'ping', n: this.nextPing() });
      if (this.opts.heartbeat && this.probeTimer === null) {
        this.heardSinceProbe = false;
        this.probeTimer = this.timers.setTimeout(() => {
          this.probeTimer = null;
          if (this.snapshot.status === 'connected' && !this.heardSinceProbe) this.connectionLost();
        }, this.opts.heartbeatIntervalMs);
      }
      return;
    }
    if (status === 'connecting' || status === 'reconnecting') {
      this.windowEnd = now + (this.everWelcomed ? this.opts.reconnectWindowMs : this.opts.connectWindowMs);
      if (status === 'reconnecting') this.update({ reconnectDeadline: this.windowEnd });
      if (this.retryTimer !== null) {
        this.timers.clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.openAttempt();
      }
      return;
    }
    if (status === 'closed' && (closeReason === 'connection-lost' || closeReason === 'unreachable')) {
      this.windowEnd = now + (this.everWelcomed ? this.opts.reconnectWindowMs : this.opts.connectWindowMs);
      this.update({
        status: this.everWelcomed ? 'reconnecting' : 'connecting',
        closeReason: null,
        message: this.everWelcomed ? 'Connection lost. Reconnecting...' : null,
        reconnectDeadline: this.everWelcomed ? this.windowEnd : null,
      });
      this.openAttempt();
    }
  }

  // ---------------------------------------------------------------- actions

  /** Host only: start the game from the lobby. */
  startGame(): boolean {
    return this.send({ v: PROTOCOL_VERSION, t: 'start' });
  }

  /** Giver: pick the hidden word from view.game.giver.options. */
  chooseWord(word: string): boolean {
    return this.send({ v: PROTOCOL_VERSION, t: 'choose', word });
  }

  /**
   * Giver: submit a clue. Always resolves (never rejects) with the outcome; the
   * same outcome is mirrored in snapshot.lastClueResult. Only one submission can
   * be in flight; a second one resolves immediately with { kind: 'busy' }.
   */
  submitClue(clue: string): Promise<ClueResult> {
    if (this.pendingClue) return Promise.resolve<ClueResult>({ kind: 'busy' });
    if (!this.welcomed || this.snapshot.status !== 'connected') return Promise.resolve(NOT_CONNECTED);
    const id = ++this.clueCounter;
    return new Promise<ClueResult>((resolve) => {
      const timer = this.timers.setTimeout(() => {
        if (this.pendingClue?.id === id) {
          this.settleClue({
            kind: 'error',
            message: 'The host did not answer in time. Nothing was counted - try again.',
          });
        }
      }, this.opts.clueTimeoutMs);
      // Registered before sending: the answer can arrive synchronously (loopback, tests).
      this.pendingClue = { id, resolve, timer };
      this.update({ cluePending: true });
      const sent = this.send({ v: PROTOCOL_VERSION, t: 'clue', id, clue: clue.slice(0, 40) });
      if (!sent && this.pendingClue?.id === id) this.settleClue(NOT_CONNECTED);
    });
  }

  /** Giver: forfeit the turn (allowed when view.game.giver.canForfeit). */
  forfeit(): boolean {
    return this.send({ v: PROTOCOL_VERSION, t: 'forfeit' });
  }

  /**
   * Guesser: submit this round's guess (first one counts). True means it was
   * handed to the connection; the host confirms it through the next view
   * (game.yourGuess). If the connection drops before that, the guess is sent
   * again automatically once the seat is reclaimed and the round is still open.
   */
  submitGuess(guess: string): boolean {
    const sent = this.send({ v: PROTOCOL_VERSION, t: 'guess', guess });
    const game = this.snapshot.view?.game;
    if (sent && game) this.unconfirmedGuess = { guess, turnNumber: game.turnNumber, clueRound: game.clueRound };
    return sent;
  }

  /** Continue from round-result / turn-result (allowed when view.game.canContinue). */
  next(): boolean {
    const game = this.snapshot.view?.game;
    if (!game) return false;
    return this.send({ v: PROTOCOL_VERSION, t: 'next', step: game.step });
  }

  /** Host only: record a blank (wrong) guess for a disconnected guesser. */
  skipGuesser(seat: number): boolean {
    return this.send({ v: PROTOCOL_VERSION, t: 'skip', seat });
  }

  /** Host only: forfeit the turn of a disconnected giver. */
  forfeitGiver(): boolean {
    return this.send({ v: PROTOCOL_VERSION, t: 'forfeitGiver' });
  }

  /** Host only, lobby: remove a player. */
  removePlayer(seat: number): boolean {
    return this.send({ v: PROTOCOL_VERSION, t: 'remove', seat });
  }

  /** Host only, game over: return everyone to the lobby. */
  playAgain(): boolean {
    return this.send({ v: PROTOCOL_VERSION, t: 'again' });
  }

  // ---------------------------------------------------------------- connection

  private send(msg: ClientMessage): boolean {
    const attempt = this.attempt;
    if (!attempt || attempt.over || !attempt.transport || !attempt.open) return false;
    if (msg.t !== 'hello' && !this.welcomed) return false;
    try {
      return attempt.transport.send(msg as unknown as Json);
    } catch {
      return false;
    }
  }

  private nextPing(): number {
    this.pingCounter = (this.pingCounter + 1) % 1_000_000;
    return this.pingCounter;
  }

  private openAttempt(): void {
    this.endAttempt();
    const attempt: Attempt = { transport: null, open: false, helloSent: false, over: false };
    this.attempt = attempt;
    this.welcomed = false;

    const hello = (): void => {
      if (attempt.over || attempt.helloSent || !attempt.transport) return;
      attempt.helloSent = true;
      this.send({ v: PROTOCOL_VERSION, t: 'hello', name: this.requestedName.slice(0, 200), token: this.token });
    };

    // Never past the end of the window: a connect that hangs must not stretch "about 20 s" to 27.
    const remaining = Math.max(0, this.windowEnd - this.timers.now());
    this.attemptTimer = this.timers.setTimeout(
      () => {
        this.attemptTimer = null;
        if (this.attempt === attempt && !this.welcomed) this.connectionLost();
      },
      Math.min(this.opts.attemptTimeoutMs, remaining),
    );

    let transport: ClientTransport;
    try {
      transport = this.connectFn({
        onOpen: () => {
          if (this.attempt !== attempt || attempt.over) return;
          attempt.open = true;
          hello();
        },
        onMessage: (msg) => {
          if (this.attempt !== attempt || attempt.over) return;
          this.handleMessage(msg);
        },
        onClose: () => {
          if (this.attempt !== attempt || attempt.over) return;
          this.connectionLost();
        },
      });
    } catch {
      if (this.attempt === attempt && !attempt.over) this.connectionLost();
      return;
    }
    attempt.transport = transport;
    if (attempt.over) {
      // The attempt ended while connect() was still running.
      try {
        transport.close();
      } catch {
        // ignore
      }
      return;
    }
    // onOpen may have fired before connect() returned.
    if (attempt.open) hello();
  }

  /** Closes the current attempt (if any) and stops everything tied to it. */
  private endAttempt(): void {
    const attempt = this.attempt;
    this.attempt = null;
    this.welcomed = false;
    for (const key of ['attemptTimer', 'retryTimer', 'heartbeatTimer', 'probeTimer'] as const) {
      if (this[key] !== null) {
        this.timers.clearTimeout(this[key]);
        this[key] = null;
      }
    }
    if (attempt && !attempt.over) {
      attempt.over = true;
      try {
        attempt.transport?.close();
      } catch {
        // ignore
      }
    }
  }

  /** The current attempt failed or the live connection dropped: retry until the window closes. */
  private connectionLost(): void {
    if (this.snapshot.status === 'closed' || this.snapshot.status === 'idle') return;
    this.endAttempt();
    if (this.pendingClue) {
      this.settleClue({
        kind: 'error',
        message: 'Connection to the host was lost. Check the result when you are back - or try again.',
      });
    }
    const now = this.timers.now();
    if (this.snapshot.status === 'connected') {
      this.windowEnd = now + this.opts.reconnectWindowMs;
      this.update({
        status: 'reconnecting',
        message: 'Connection lost. Reconnecting...',
        reconnectDeadline: this.windowEnd,
      });
    }
    if (now >= this.windowEnd) {
      this.finish(this.everWelcomed ? 'connection-lost' : 'unreachable');
      return;
    }
    const delay = Math.max(0, Math.min(this.opts.retryDelayMs, this.windowEnd - now));
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.snapshot.status !== 'connecting' && this.snapshot.status !== 'reconnecting') return;
      if (this.timers.now() >= this.windowEnd) {
        this.finish(this.everWelcomed ? 'connection-lost' : 'unreachable');
        return;
      }
      this.openAttempt();
    }, delay);
  }

  private finish(reason: ClientCloseReason): void {
    if (this.snapshot.status === 'closed') return;
    this.endAttempt();
    if (this.pendingClue) this.settleClue(NOT_CONNECTED);
    this.unconfirmedGuess = null;
    this.recheckGuess = false;
    this.update({
      status: 'closed',
      closeReason: reason,
      message: MESSAGES[reason],
      cluePending: false,
      reconnectDeadline: null,
    });
  }

  private settleClue(result: ClueResult): void {
    const pending = this.pendingClue;
    if (!pending) return;
    this.pendingClue = null;
    this.timers.clearTimeout(pending.timer);
    this.update({ cluePending: false, lastClueResult: result });
    pending.resolve(result);
  }

  // ---------------------------------------------------------------- inbound

  private handleMessage(raw: unknown): void {
    const parsed = parseHostMessage(raw);
    this.lastSeen = this.timers.now();
    this.heardSinceProbe = true;
    if (!parsed.ok) {
      // A different protocol version: nothing else from this host can be trusted.
      if (parsed.reason === 'version') this.finish('version');
      return; // malformed messages are ignored
    }
    const msg = parsed.msg;
    switch (msg.t) {
      case 'ping':
        this.send({ v: PROTOCOL_VERSION, t: 'pong', n: msg.n });
        return;
      case 'pong':
        return;
      case 'refused':
        if (!this.welcomed) this.finish(msg.reason);
        return;
      case 'bye':
        this.finish(msg.reason);
        return;
      case 'welcome':
        if (this.welcomed) return;
        this.welcomed = true;
        // Back on a new connection: whatever was in flight on the old one may be lost.
        this.recheckGuess = this.everWelcomed && this.unconfirmedGuess !== null;
        this.everWelcomed = true;
        if (this.attemptTimer !== null) {
          this.timers.clearTimeout(this.attemptTimer);
          this.attemptTimer = null;
        }
        this.update({
          status: 'connected',
          closeReason: null,
          message: null,
          seat: msg.seat,
          name: msg.name,
          reconnectDeadline: null,
        });
        this.startHeartbeat();
        return;
      case 'view': {
        if (!this.welcomed) return;
        const before = this.snapshot.view?.game;
        const after = msg.view.game;
        // A clue result belongs to one clue phase of one turn.
        const sameCluePhase =
          before != null &&
          after != null &&
          after.phase === 'clue' &&
          before.phase === 'clue' &&
          before.turnNumber === after.turnNumber &&
          before.clueRound === after.clueRound;
        this.update({
          view: msg.view,
          seat: msg.view.you.seat,
          name: msg.view.you.name,
          lastClueResult: sameCluePhase ? this.snapshot.lastClueResult : null,
        });
        this.reconcileGuess(msg.view);
        return;
      }
      case 'clueResult':
        if (this.pendingClue && this.pendingClue.id === msg.id) this.settleClue(msg.result);
        return;
    }
  }

  /**
   * Drops the unconfirmed guess once the host has it or its round is over. On
   * the first view after a reconnect, a guess the host still has not got is
   * sent again (the host keeps only the first guess of a seat, so a duplicate
   * is harmless).
   */
  private reconcileGuess(view: PlayerView): void {
    const recheck = this.recheckGuess;
    this.recheckGuess = false;
    const pending = this.unconfirmedGuess;
    if (!pending) return;
    const game = view.game;
    const stillOpen =
      game !== null &&
      game.phase === 'guess' &&
      game.turnNumber === pending.turnNumber &&
      game.clueRound === pending.clueRound &&
      game.yourGuess === null &&
      game.guessStatus.some((s) => s.seat === view.you.seat && s.status === 'pending');
    if (!stillOpen) {
      this.unconfirmedGuess = null;
      return;
    }
    if (recheck) this.send({ v: PROTOCOL_VERSION, t: 'guess', guess: pending.guess });
  }

  private startHeartbeat(): void {
    if (!this.opts.heartbeat) return;
    const now = this.timers.now();
    this.lastSeen = now;
    this.lastTick = now;
    const tick = (): void => {
      this.heartbeatTimer = null;
      if (this.snapshot.status !== 'connected') return;
      const t = this.timers.now();
      if (t - this.lastTick > this.opts.heartbeatIntervalMs * 2) {
        // The app was suspended: silence so far proves nothing. Probe instead of giving up.
        this.lastSeen = t;
      } else if (t - this.lastSeen >= this.opts.peerTimeoutMs) {
        this.connectionLost();
        return;
      }
      this.lastTick = t;
      this.send({ v: PROTOCOL_VERSION, t: 'ping', n: this.nextPing() });
      this.heartbeatTimer = this.timers.setTimeout(tick, this.opts.heartbeatIntervalMs);
    };
    this.heartbeatTimer = this.timers.setTimeout(tick, this.opts.heartbeatIntervalMs);
  }
}

/** A client session for a remote host reached through a NetworkAdapter. */
export function createClientSession(
  options: Omit<ClientSessionOptions, 'connect'> & { adapter: NetworkAdapter; target: { host: string; port: number } },
): ClientSession {
  const { adapter, target, ...rest } = options;
  return new ClientSession({ ...rest, connect: (handlers) => adapter.connect(target, handlers) });
}
