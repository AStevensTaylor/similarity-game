/**
 * Real local-network transport: TCP sockets (react-native-tcp-socket) plus mDNS/Bonjour
 * discovery (react-native-zeroconf).
 *
 * This is the ONLY file allowed to import react-native-zeroconf, react-native-tcp-socket,
 * buffer and expo-network. react-native-tcp-socket creates a NativeEventEmitter at import
 * time and throws when its native module is missing, so this module must never be
 * re-exported from src/net/index.ts: the UI imports it lazily, tests mock both libraries.
 *
 * Wire format: newline-delimited JSON objects, UTF-8. A line (and therefore a message) is
 * limited to 64 KB; a peer that exceeds it is dropped.
 *
 * Callback semantics (kept deliberately strict so sessions can rely on them):
 *  - host: onPeer(id) is followed by at most one onPeerGone(id). onPeerGone fires when the
 *    REMOTE side goes away or misbehaves (close, error, oversize line). It does NOT fire for
 *    peers removed locally with dropPeer() or stop(); nothing fires after stop().
 *  - client: exactly one onClose(reason) per connect() unless close() was called locally,
 *    after which no handler is invoked again. onOpen fires at most once, before any onMessage.
 */
import { Platform } from 'react-native';
import TcpSocket from 'react-native-tcp-socket';
import Zeroconf, { ImplType, type Service } from 'react-native-zeroconf';
import { Buffer } from 'buffer';
import * as Network from 'expo-network';

import { LISTENER_CLOSED } from './transport';
import type {
  ClientTransport,
  ClientTransportHandlers,
  FoundHost,
  HostTransport,
  HostTransportHandlers,
  Json,
  NetworkAdapter,
} from './transport';

/** Must match ios.infoPlist.NSBonjourServices ("_simgame._tcp") in app.json. */
export const SERVICE_TYPE = 'simgame';
/** Maximum size of one line / one message, in bytes (excluding the newline). */
export const MAX_LINE_BYTES = 64 * 1024;
/** DNS-SD instance names are limited to 63 bytes of UTF-8. */
export const MAX_SERVICE_NAME_BYTES = 63;
/**
 * Native connect timeout in ms. iOS integer-divides this by 1000, so it must be a whole
 * number of seconds >= 1000 (anything below 1000 would become "no timeout").
 */
export const CONNECT_TIMEOUT_MS = 5000;
/** Our own connect watchdog; slightly longer so the native timeout normally wins. */
const CONNECT_WATCHDOG_MS = CONNECT_TIMEOUT_MS + 1500;
const PUBLISH_TIMEOUT_MS = 10000;
const UNPUBLISH_TIMEOUT_MS = 2000;
/** How long a deliberate close() waits for lines already handed to the socket (e.g. "leave") to be written. */
const CLOSE_FLUSH_MS = 250;
/** After reporting a dead listener the host transport stops itself, unless the session already did. */
const LISTENER_FAIL_STOP_MS = 1000;
const FALLBACK_SERVICE_NAME = 'Similarity Game';

type Socket = ReturnType<typeof TcpSocket.createConnection>;
type Server = ReturnType<typeof TcpSocket.createServer>;

// ---------------------------------------------------------------- helpers

/** Truncates to at most `maxBytes` of UTF-8 without cutting a character in half. */
export function truncateUtf8(text: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  // for..of iterates code points, so surrogate pairs are never split.
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/** A name that is safe to publish: no control characters, 1..63 bytes, trimmed. */
export function sanitizeServiceName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const cut = truncateUtf8(cleaned, MAX_SERVICE_NAME_BYTES).trim();
  return cut || FALLBACK_SERVICE_NAME;
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIPv4(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  const parts = text.split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}

/** "::ffff:192.168.1.5" -> "192.168.1.5"; drops a "%scope" suffix. */
function cleanRemoteAddress(address: unknown): string | undefined {
  if (typeof address !== 'string' || !address) return undefined;
  const noScope = address.split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(noScope);
  return mapped ? mapped[1] : noScope;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* teardown and reporting must never throw */
  }
}

/**
 * Newline-delimited JSON reader over a byte stream. Splits on byte 0x0A BEFORE utf-8
 * decoding, so multi-byte characters split across chunks are reassembled correctly.
 * Lines that are not a JSON object are ignored. Returns `feed`; calls `onOversize` once
 * (and then ignores all further input) when a line exceeds MAX_LINE_BYTES.
 */
function createLineReader(
  onMessage: (msg: Json) => void,
  onOversize: () => void,
): (chunk: unknown) => void {
  let pending: Buffer = Buffer.alloc(0);
  /** Bytes at the start of `pending` already known to contain no newline. */
  let scanned = 0;
  let dead = false;
  return (chunk) => {
    if (dead) return;
    let bytes: Buffer;
    if (typeof chunk === 'string') bytes = Buffer.from(chunk, 'utf8');
    else if (Buffer.isBuffer(chunk)) bytes = chunk as Buffer;
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk);
    else return;
    pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
    for (;;) {
      const nl = pending.indexOf(0x0a, scanned);
      if (nl < 0) {
        scanned = pending.length;
        break;
      }
      scanned = 0;
      if (nl > MAX_LINE_BYTES) {
        dead = true;
        pending = Buffer.alloc(0);
        onOversize();
        return;
      }
      const line = pending.slice(0, nl).toString('utf8');
      pending = pending.slice(nl + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // not JSON: ignore the line
      }
      if (!isPlainObject(parsed)) continue;
      onMessage(parsed);
      if (dead) return;
    }
    if (pending.length > MAX_LINE_BYTES) {
      dead = true;
      pending = Buffer.alloc(0);
      onOversize(); // peer is not speaking our protocol
    }
  };
}

/** Serialises a message to one line, or null when it cannot be sent. */
function encode(msg: Json): string | null {
  let text: string;
  try {
    text = JSON.stringify(msg);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  // The receiver would drop us for an oversize line: refuse to send it instead.
  if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) return null;
  return text + '\n';
}

/** socket.write() throws synchronously once the socket is destroyed; never let that escape. */
function writeLine(socket: Socket, line: string): boolean {
  if (socket.destroyed || socket.pending) return false;
  try {
    socket.write(line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function messageOf(e: unknown): string {
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : String(e);
}

/**
 * True when publishing failed because the system refuses local-network access
 * (iOS "policy denied"). Then nothing on the LAN works for the app, so hosting
 * must fail with that reason instead of opening a lobby nobody can reach.
 */
function isLocalNetworkDenied(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return /-72008|-65570|-65555|policy\s*denied|policydenied|prohibited/i.test(`${String(code ?? '')} ${messageOf(e)}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------- HOST

interface Peer {
  socket: Socket;
  /** The library does not mark a socket destroyed on remote close: track it ourselves. */
  open: boolean;
}

function startHost(
  opts: { name: string; txt?: Record<string, string> },
  handlers: HostTransportHandlers,
): Promise<HostTransport> {
  return new Promise<HostTransport>((resolve, reject) => {
    const peers = new Map<number, Peer>();
    let nextPeerId = 1;
    let zeroconf: Zeroconf | null = null;
    let publishedName: string | null = null;
    let stopped = false;
    let settled = false;
    let serverClosed = false;
    let stopPromise: Promise<void> | null = null;
    /** Events that arrive before the caller holds the HostTransport are replayed after. */
    let ready = false;
    const beforeReady: Array<() => void> = [];

    const deliver = (fn: () => void) => {
      if (stopped) return;
      if (!ready) {
        beforeReady.push(fn);
        return;
      }
      try {
        fn();
      } catch (e) {
        safely(() => handlers.onError(e));
      }
    };

    const reportError = (e: unknown) => deliver(() => handlers.onError(e));

    /** Removes a peer and destroys its socket. Returns false when it was already gone. */
    const removePeer = (peerId: number): boolean => {
      const peer = peers.get(peerId);
      if (!peer) return false;
      peers.delete(peerId);
      peer.open = false;
      safely(() => peer.socket.destroy()); // accepted sockets are always registered natively
      return true;
    };

    const peerGone = (peerId: number) => {
      if (removePeer(peerId)) deliver(() => handlers.onPeerGone(peerId));
    };

    const closeServerOnce = () => {
      if (serverClosed) return;
      serverClosed = true;
      safely(() => server.close());
    };

    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopped = true;
      beforeReady.length = 0;
      const zc = zeroconf;
      const name = publishedName;
      // Start un-advertising straight away so no new client finds us while we tear down.
      const unpublished: Promise<unknown> =
        zc && name
          ? withTimeout(
              Promise.resolve().then(() => zc.unpublishService(name)),
              UNPUBLISH_TIMEOUT_MS,
              'unpublish',
            ).catch(() => undefined) // NOT_PUBLISHED etc.
          : Promise.resolve();
      // server.close() does NOT drop existing connections: destroy every socket first.
      for (const peerId of [...peers.keys()]) removePeer(peerId);
      closeServerOnce();
      stopPromise = unpublished.then(() => {
        if (zc) {
          safely(() => zc.removeDeviceListeners());
          safely(() => zc.removeAllListeners());
        }
      });
      return stopPromise;
    };

    const fail = (e: unknown) => {
      if (settled) {
        reportError(e);
        return;
      }
      settled = true;
      void stop().then(
        () => reject(e),
        () => reject(e),
      );
    };

    let server: Server;
    try {
      server = TcpSocket.createServer((socket) => {
        if (stopped) {
          safely(() => socket.destroy());
          return;
        }
        const peerId = nextPeerId++;
        const peer: Peer = { socket, open: true };
        peers.set(peerId, peer);
        safely(() => socket.setNoDelay(true));
        const feed = createLineReader(
          (msg) => {
            if (peers.get(peerId) === peer) deliver(() => handlers.onMessage(peerId, msg));
          },
          () => peerGone(peerId),
        );
        socket.on('data', (chunk) => {
          if (peers.get(peerId) === peer) feed(chunk);
        });
        // The library destroys the socket itself on 'error'; 'close' normally follows, but
        // do not depend on it.
        socket.on('error', () => peerGone(peerId));
        socket.on('close', () => peerGone(peerId));
        const address = cleanRemoteAddress(socket.remoteAddress);
        deliver(() => handlers.onPeer(peerId, address));
      });
    } catch (e) {
      settled = true;
      reject(e);
      return;
    }

    server.on('error', (e) => {
      // The library has already called server.close() itself before emitting 'error'.
      serverClosed = true;
      if (settled && !stopped) {
        // The lobby was open and its listener is gone for good: nobody can join or
        // reconnect any more. Say so unmistakably, so the session ends the game
        // (telling the connected players) instead of living on as a zombie.
        reportError(
          Object.assign(new Error(`the listening socket failed: ${messageOf(e)}`), { code: LISTENER_CLOSED, cause: e }),
        );
        // Whatever the session does with that, never keep advertising a closed port.
        setTimeout(() => void stop(), LISTENER_FAIL_STOP_MS);
        return;
      }
      fail(e);
    });

    const onListening = () => {
      if (stopped || settled) return;
      const port = server.address()?.port;
      if (!port) {
        fail(new Error('listen: no port assigned'));
        return;
      }
      const requestedName = sanitizeServiceName(opts.name);

      /** Hands the transport to the caller: from here on the lobby is open. */
      const open = (serviceName: string) => {
        if (stopped || settled) return;
        settled = true;
        const transport: HostTransport = {
          port,
          serviceName,
          broadcast: (msg) => {
            if (stopped) return;
            const line = encode(msg);
            if (line === null) return;
            peers.forEach((p) => {
              if (p.open) writeLine(p.socket, line);
            });
          },
          sendTo: (peerId, msg) => {
            if (stopped) return;
            const p = peers.get(peerId);
            if (!p || !p.open) return;
            const line = encode(msg);
            if (line !== null) writeLine(p.socket, line);
          },
          dropPeer: (peerId) => {
            removePeer(peerId);
          },
          stop,
        };
        resolve(transport);
        // Replay anything that happened before the caller could hold the transport,
        // after the caller's `await` continuation has had a chance to run.
        setTimeout(() => {
          ready = true;
          const queued = beforeReady.splice(0);
          for (const fn of queued) deliver(fn);
        }, 0);
      };

      /**
       * The server is listening, so the game can be joined by address even when it
       * cannot be advertised: open the lobby anyway and tell the host why nobody
       * will find it automatically. Only a refused local-network permission is fatal.
       */
      const publishFailed = (e: unknown) => {
        if (stopped || settled) return;
        if (isLocalNetworkDenied(e)) {
          fail(e);
          return;
        }
        open(requestedName);
        reportError(
          new Error(
            `Other phones cannot find this lobby automatically (${messageOf(e)}). They can still join with the address shown here`,
          ),
        );
      };

      let raw: Promise<{ name: string }>;
      let zc: Zeroconf;
      try {
        // Publishing and scanning use separate Zeroconf instances (see browse()).
        zc = new Zeroconf();
        zeroconf = zc;
        zc.on('error', reportError);
        raw = Promise.resolve(
          zc.publishService({
            type: SERVICE_TYPE,
            protocol: 'tcp',
            name: requestedName,
            port,
            txt: { ...(opts.txt ?? {}) },
          }),
        );
      } catch (e) {
        publishFailed(e);
        return;
      }
      // Requested but not confirmed yet: stop() tries to withdraw this name meanwhile.
      publishedName = requestedName;
      const assignedName = (published: { name?: unknown } | null | undefined): string =>
        published && typeof published.name === 'string' && published.name ? published.name : requestedName;

      // Watch the registration itself, not only the timeout race below: it may complete
      // after we gave up waiting, or after stop(). A registration that is still pending
      // cannot be withdrawn natively, so it has to be withdrawn when it completes -
      // otherwise the service stays advertised, pointing at a closed port.
      raw.then(
        (published) => {
          // mDNS may rename the service on conflict ("Name (2)").
          const name = assignedName(published);
          publishedName = name;
          if (stopped) {
            Promise.resolve()
              .then(() => zc.unpublishService(name))
              .catch(() => undefined);
          }
        },
        () => undefined,
      );

      withTimeout(raw, PUBLISH_TIMEOUT_MS, 'publish').then((published) => open(assignedName(published)), publishFailed);
    };

    try {
      // port 0 = OS-assigned; 0.0.0.0 = all IPv4 interfaces (iOS maps it to "any interface").
      server.listen({ port: 0, host: '0.0.0.0', reuseAddress: true }, onListening);
    } catch (e) {
      fail(e);
    }
  });
}

// ---------------------------------------------------------------- CLIENT: connect

function connect(
  target: { host: string; port: number },
  handlers: ClientTransportHandlers,
): ClientTransport {
  type Reason = 'closed' | 'error' | 'timeout';
  /** Set by close(): from then on no handler is invoked. */
  let cancelled = false;
  /** Set once onClose has been delivered. */
  let finished = false;
  let opened = false;
  let current: Socket | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  /** Lines handed to the current socket whose native write has not completed yet. */
  let unwritten = 0;
  /** Set by close() while it waits for those lines: destroys the socket once they are out. */
  let whenWritten: (() => void) | null = null;

  const clearWatchdog = () => {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  const finish = (reason: Reason) => {
    if (finished || cancelled) return;
    finished = true;
    clearWatchdog();
    const socket = current;
    current = null;
    // Never destroy() a socket whose connect has not been registered natively yet.
    if (socket && !socket.pending) safely(() => socket.destroy());
    safely(() => handlers.onClose(reason));
  };

  const attempt = (viaWifi: boolean) => {
    let abandoned = false; // this attempt lost (timed out / superseded)
    let socket: Socket;
    const failAttempt = (reason: Reason) => {
      if (abandoned || cancelled || finished) return;
      if (opened) {
        finish(reason);
        return;
      }
      // Connect failed. Android phones on Wi-Fi without internet may route via mobile
      // data: retry once, with only this socket bound to the Wi-Fi network.
      abandoned = true;
      clearWatchdog();
      if (!viaWifi && Platform.OS === 'android') {
        current = null;
        attempt(true);
      } else {
        current = null;
        finished = true;
        safely(() => handlers.onClose(reason === 'closed' ? 'error' : reason));
      }
    };

    try {
      socket = TcpSocket.createConnection(
        {
          host: target.host,
          port: target.port,
          connectTimeout: CONNECT_TIMEOUT_MS,
          ...(viaWifi ? { interface: 'wifi' as const } : null),
        },
        () => {
          if (abandoned || cancelled || finished) {
            // close() or the watchdog fired while connecting: now it is safe to destroy.
            safely(() => socket.destroy());
            return;
          }
          clearWatchdog();
          safely(() => socket.setNoDelay(true));
          opened = true;
          safely(() => handlers.onOpen());
        },
      );
    } catch {
      // Synchronous failure (bad options / native module problem).
      setTimeout(() => failAttempt('error'), 0);
      return;
    }
    current = socket;

    const feed = createLineReader(
      (msg) => {
        if (abandoned || cancelled || finished || !opened) return;
        safely(() => handlers.onMessage(msg));
      },
      () => failAttempt('error'),
    );
    socket.on('data', (chunk) => {
      if (abandoned || cancelled || finished) return;
      feed(chunk);
    });
    socket.on('error', (e) => {
      // iOS: "Attempt to connect to host timed out". Android: "failed to connect to /a.b.c.d
      // (port N) from /w.x.y.z (port M) after 5000ms", or "... ETIMEDOUT (Connection timed out)".
      const text = String((e as { message?: unknown } | null)?.message ?? e).toLowerCase();
      const timedOut = /timed out|timeout|etimedout|after \d+\s*ms/.test(text);
      failAttempt(!opened && timedOut ? 'timeout' : 'error');
    });
    socket.on('close', (hadError) => failAttempt(hadError ? 'error' : 'closed'));

    watchdog = setTimeout(() => {
      watchdog = null;
      if (!opened) failAttempt('timeout');
    }, CONNECT_WATCHDOG_MS);
  };

  attempt(false);

  return {
    send: (msg) => {
      const socket = current;
      if (cancelled || finished || !opened || !socket) return false;
      const line = encode(msg);
      if (line === null || socket.destroyed || socket.pending) return false;
      unwritten += 1;
      try {
        // The callback runs once the native write has completed (or failed).
        socket.write(line, 'utf8', () => {
          if (current !== socket && !cancelled) return; // a socket from an earlier attempt
          unwritten = Math.max(0, unwritten - 1);
          if (unwritten === 0) whenWritten?.();
        });
        return true;
      } catch {
        // socket.write() throws synchronously once the socket is destroyed.
        unwritten = Math.max(0, unwritten - 1);
        return false;
      }
    },
    close: () => {
      if (cancelled) return;
      cancelled = true;
      clearWatchdog();
      const socket = current;
      current = null;
      // A still-connecting socket is destroyed by its connect callback (or by the
      // library's own 'error' path) instead.
      if (!socket || socket.pending) return;
      if (unwritten === 0) {
        safely(() => socket.destroy());
        return;
      }
      // Natively, write and destroy run on different threads: destroying now could
      // overtake a line that was just sent (the "leave" of a deliberate exit). Let
      // the writes finish first, but never wait long.
      let done = false;
      const destroyNow = () => {
        if (done) return;
        done = true;
        whenWritten = null;
        clearTimeout(timer);
        safely(() => socket.destroy());
      };
      const timer = setTimeout(destroyNow, CLOSE_FLUSH_MS);
      whenWritten = destroyNow;
    },
  };
}

// ---------------------------------------------------------------- CLIENT: browse

function browse(
  handlers: { onChange(hosts: FoundHost[]): void; onError(e: unknown): void },
  opts?: { useEmbeddedMdns?: boolean },
): () => void {
  let active = true;
  const hosts = new Map<string, FoundHost>();
  const emit = () => {
    if (active) safely(() => handlers.onChange([...hosts.values()]));
  };
  const reportError = (e: unknown) => {
    if (active) safely(() => handlers.onError(e));
  };

  let zeroconf: Zeroconf;
  try {
    zeroconf = new Zeroconf();
  } catch (e) {
    setTimeout(() => reportError(e), 0);
    return () => {
      active = false;
    };
  }

  zeroconf.on('error', (e: unknown) => {
    const err = e as { serviceName?: unknown; code?: unknown } | null;
    const name = typeof err?.serviceName === 'string' && err.serviceName ? err.serviceName : null;
    if (name !== null || err?.code === 'TIMEOUT') {
      // One advertisement could not be resolved (a stale cache entry, a host out of
      // range). The scan itself is still running, so this is not a browse failure.
      if (name !== null && hosts.delete(name)) emit();
      return;
    }
    reportError(e);
  });
  zeroconf.on('resolved', (service: Service) => {
    if (!active || !service || typeof service.name !== 'string') return;
    // The host listens on IPv4 only.
    const host = (Array.isArray(service.ipv4) ? service.ipv4 : []).find(isIPv4);
    const port = Number(service.port);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return;
    const txt: Record<string, string> = {};
    if (service.txt && typeof service.txt === 'object') {
      for (const [key, value] of Object.entries(service.txt)) {
        if (typeof value === 'string') txt[key] = value;
        else if (typeof value === 'number' || typeof value === 'boolean') txt[key] = String(value);
      }
    }
    hosts.set(service.name, { name: service.name, host, port, txt });
    emit();
  });
  zeroconf.on('remove', (name: string) => {
    if (hosts.delete(name)) emit();
  });

  // The embedded mDNSResponder backend exists on Android only.
  const embedded = opts?.useEmbeddedMdns === true && Platform.OS === 'android';
  try {
    zeroconf.scan({
      type: SERVICE_TYPE,
      protocol: 'tcp',
      resolveTimeout: 10,
      implType: embedded ? ImplType.DNSSD : ImplType.NSD,
    });
  } catch (e) {
    setTimeout(() => reportError(e), 0);
  }

  return () => {
    if (!active) return;
    active = false;
    hosts.clear();
    safely(() => zeroconf.stop());
    safely(() => zeroconf.removeDeviceListeners());
    safely(() => zeroconf.removeAllListeners());
  };
}

// ---------------------------------------------------------------- local address

async function getLocalAddress(): Promise<string | null> {
  try {
    if (Platform.OS === 'android') {
      // Android reports the address of the DEFAULT network. On a Wi-Fi without internet
      // (or when this phone is the hotspot) that is the mobile-data address, which no
      // other phone can reach: better to show no address than a wrong one.
      const state = await Network.getNetworkStateAsync();
      const type = state?.type;
      if (type !== Network.NetworkStateType.WIFI && type !== Network.NetworkStateType.ETHERNET) return null;
    }
    const ip = await Network.getIpAddressAsync();
    // expo-network reports "0.0.0.0" when there is no usable address.
    return isIPv4(ip) && ip !== '0.0.0.0' ? ip : null;
  } catch {
    return null;
  }
}

export function createLanAdapter(): NetworkAdapter {
  return { startHost, connect, browse, getLocalAddress };
}
