/**
 * In-memory NetworkAdapter for tests: any number of virtual devices on one
 * MemoryNetwork, with controllable delivery and simulated failures.
 *
 *   const net = new MemoryNetwork();
 *   const hostAdapter = net.createAdapter();      // "10.0.0.1"
 *   const phoneAdapter = net.createAdapter();     // "10.0.0.2"
 *
 * Semantics (mirroring lanAdapter):
 *  - Messages are serialised to JSON and parsed again on delivery (no shared
 *    references). A message over 64 KB is never delivered: a host refuses to
 *    send it; from a client it gets that client dropped (onPeerGone on the host,
 *    onClose('error') on the client).
 *  - host: onPeerGone fires only when the REMOTE side goes away; not after
 *    dropPeer() / stop().
 *  - client: one onClose per connect() unless close() was called locally, after
 *    which no handler fires again. onOpen never fires inside connect().
 *
 * Delivery: every event (open, message, close, discovery change) goes through
 * one FIFO queue, so handlers are never re-entered. By default the queue drains
 * automatically - synchronously for sends made outside a handler, and on a
 * microtask for connect() / browse(). Call pause() to hold events and then
 * deliver them by hand (deliverNext / deliverWhere / flush) in any order.
 */
import type {
  ClientTransport,
  ClientTransportHandlers,
  FoundHost,
  HostTransport,
  HostTransportHandlers,
  Json,
  NetworkAdapter,
} from './transport';

const MAX_LINE_BYTES = 64 * 1024;

export interface QueuedEvent {
  kind: 'open' | 'peer' | 'to-host' | 'to-client' | 'client-close' | 'peer-gone' | 'browse';
  /** Connection id (0 for browse events). */
  link: number;
  /** Parsed copy of the message, for 'to-host' / 'to-client'. */
  msg?: Json;
  run(): void;
}

interface HostEntry {
  port: number;
  address: string;
  name: string;
  txt: Record<string, string>;
  handlers: HostTransportHandlers;
  nextPeerId: number;
  links: Map<number, Link>;
  stopped: boolean;
}

interface Link {
  id: number;
  peerId: number;
  host: HostEntry;
  clientAddress: string;
  handlers: ClientTransportHandlers;
  /** Client called close(): no client handler fires again. */
  clientClosed: boolean;
  /** The connection no longer exists. */
  dead: boolean;
  /** Traffic is silently discarded in both directions (a "dead" Wi-Fi link). */
  blackholed: boolean;
}

function encode(msg: unknown): string | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(msg);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  // UTF-16 length is a lower bound of the byte length; good enough for a test double.
  let bytes = 0;
  for (let i = 0; i < text.length; i++) bytes += text.charCodeAt(i) < 0x80 ? 1 : text.charCodeAt(i) < 0x800 ? 2 : 3;
  return bytes > MAX_LINE_BYTES ? null : text;
}

function isJsonObject(x: unknown): x is Json {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export class MemoryNetwork {
  private readonly hosts = new Map<number, HostEntry>();
  private readonly links = new Map<number, Link>();
  private readonly browsers = new Set<{ onChange(hosts: FoundHost[]): void }>();
  private readonly queue: QueuedEvent[] = [];
  private paused = false;
  private draining = false;
  private kickScheduled = false;
  private nextPort = 40001;
  private nextLinkId = 1;
  private nextAddress = 1;
  private readonly addresses = new Set<string>();
  private readonly offline = new Set<string>();
  /** When false, browse() never reports hosts (discovery "finds nothing"). */
  discoveryEnabled = true;
  /** Every message handed to the network, in send order (after serialisation). */
  readonly log: { dir: 'to-host' | 'to-client'; link: number; msg: Json }[] = [];

  /** A new virtual device. */
  createAdapter(address?: string): NetworkAdapter {
    let addr = address;
    if (addr === undefined) {
      do {
        addr = `10.0.0.${this.nextAddress++}`;
      } while (this.addresses.has(addr));
    }
    this.addresses.add(addr);
    return {
      startHost: (opts, handlers) => this.startHost(addr, opts, handlers),
      connect: (target, handlers) => this.connect(addr, target, handlers),
      browse: (handlers) => this.browse(handlers),
      getLocalAddress: () => Promise.resolve(addr),
    };
  }

  // ---------------------------------------------------------------- control

  /** Hold all events until resume() / manual delivery. */
  pause(): void {
    this.paused = true;
  }

  /** Deliver everything held and return to automatic delivery. */
  resume(): void {
    this.paused = false;
    this.drain();
  }

  /** Events currently held (oldest first). */
  get pending(): readonly QueuedEvent[] {
    return this.queue;
  }

  /** Delivers the oldest held event. Returns false when there was none. */
  deliverNext(): boolean {
    const ev = this.queue.shift();
    if (!ev) return false;
    ev.run();
    return true;
  }

  /** Delivers (in queue order) the held events matching the predicate; returns how many. */
  deliverWhere(predicate: (ev: QueuedEvent) => boolean): number {
    const picked = this.queue.filter(predicate);
    for (const ev of picked) {
      const i = this.queue.indexOf(ev);
      if (i >= 0) {
        this.queue.splice(i, 1);
        ev.run();
      }
    }
    return picked.length;
  }

  /** Discards the held events matching the predicate (simulated loss); returns how many. */
  discardWhere(predicate: (ev: QueuedEvent) => boolean): number {
    let n = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (predicate(this.queue[i])) {
        this.queue.splice(i, 1);
        n++;
      }
    }
    return n;
  }

  /** Delivers everything, including events produced while delivering, without leaving pause mode. */
  flush(): void {
    this.drain(true);
  }

  /** Ids of the live connections, oldest first. */
  linkIds(): number[] {
    return [...this.links.values()].filter((l) => !l.dead).map((l) => l.id);
  }

  /** Live connection ids opened from the device with this address. */
  linksFrom(address: string): number[] {
    return [...this.links.values()].filter((l) => !l.dead && l.clientAddress === address).map((l) => l.id);
  }

  /** Cuts one connection: the client sees onClose(reason), the host sees onPeerGone. */
  sever(linkId: number, reason: 'closed' | 'error' | 'timeout' = 'error'): void {
    const link = this.links.get(linkId);
    if (!link || link.dead) return;
    this.kill(link, { client: reason, host: true });
    this.kick();
  }

  /** Cuts every connection (e.g. the Wi-Fi went away) without telling the sessions why. */
  severAll(reason: 'closed' | 'error' | 'timeout' = 'error'): void {
    for (const id of this.linkIds()) this.sever(id, reason);
  }

  /** Silently discards all traffic on a connection (true) or restores it (false). Nobody is notified. */
  blackhole(linkId: number, on = true): void {
    const link = this.links.get(linkId);
    if (link) link.blackholed = on;
  }

  /**
   * Takes a device off the network (true) or brings it back (false). While offline its
   * existing connections are black holes (nobody is notified) and new connections fail.
   */
  setOffline(address: string, offline = true): void {
    if (offline) this.offline.add(address);
    else this.offline.delete(address);
    for (const link of this.links.values()) {
      if (link.clientAddress === address || link.host.address === address) link.blackholed = offline;
    }
  }

  /** The host device vanishes without a goodbye: clients see onClose('error'); the host hears nothing more. */
  crashHost(port: number): void {
    const host = this.hosts.get(port);
    if (!host) return;
    host.stopped = true;
    this.hosts.delete(port);
    for (const link of [...host.links.values()]) this.kill(link, { client: 'error', host: false });
    this.announce();
    this.kick();
  }

  /** Ports of the hosts currently listening. */
  hostPorts(): number[] {
    return [...this.hosts.keys()];
  }

  // ---------------------------------------------------------------- queue

  private enqueue(ev: QueuedEvent): void {
    this.queue.push(ev);
  }

  /** Drain now unless paused or already draining (then the running drain picks the new events up). */
  private kick(): void {
    if (!this.paused) this.drain();
  }

  /** Drain on a microtask, so handlers never fire inside connect() / browse(). */
  private kickLater(): void {
    if (this.kickScheduled) return;
    this.kickScheduled = true;
    void Promise.resolve().then(() => {
      this.kickScheduled = false;
      this.kick();
    });
  }

  private drain(force = false): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && (force || !this.paused)) {
        const ev = this.queue.shift() as QueuedEvent;
        ev.run();
      }
    } finally {
      this.draining = false;
    }
  }

  // ---------------------------------------------------------------- host

  private startHost(
    address: string,
    opts: { name: string; txt?: Record<string, string> },
    handlers: HostTransportHandlers,
  ): Promise<HostTransport> {
    const host: HostEntry = {
      port: this.nextPort++,
      address,
      name: opts.name,
      txt: { ...(opts.txt ?? {}) },
      handlers,
      nextPeerId: 1,
      links: new Map(),
      stopped: false,
    };
    this.hosts.set(host.port, host);
    this.announce();
    this.kickLater();

    const sendToLink = (link: Link, msg: Json): void => {
      if (host.stopped || link.dead) return;
      const text = encode(msg);
      if (text === null) return; // a host refuses to send an oversize line
      this.pushMessage('to-client', link, text);
    };

    const transport: HostTransport = {
      port: host.port,
      serviceName: host.name,
      broadcast: (msg) => {
        for (const link of [...host.links.values()]) sendToLink(link, msg);
        this.kick();
      },
      sendTo: (peerId, msg) => {
        const link = host.links.get(peerId);
        if (link) sendToLink(link, msg);
        this.kick();
      },
      dropPeer: (peerId) => {
        const link = host.links.get(peerId);
        if (!link || host.stopped) return;
        // Removed locally: the host is NOT told (lanAdapter semantics); the client sees a close.
        this.kill(link, { client: 'closed', host: false });
        this.kick();
      },
      stop: () => {
        if (!host.stopped) {
          host.stopped = true;
          this.hosts.delete(host.port);
          for (const link of [...host.links.values()]) this.kill(link, { client: 'closed', host: false });
          this.announce();
          this.kick();
        }
        return Promise.resolve();
      },
    };
    return Promise.resolve(transport);
  }

  // ---------------------------------------------------------------- client

  private connect(
    address: string,
    target: { host: string; port: number },
    handlers: ClientTransportHandlers,
  ): ClientTransport {
    const host = this.hosts.get(target.port);
    const reachable =
      host !== undefined &&
      !host.stopped &&
      host.address === target.host &&
      !this.offline.has(address) &&
      !this.offline.has(host.address);

    if (!reachable) {
      let closed = false;
      this.enqueue({
        kind: 'client-close',
        link: 0,
        run: () => {
          if (!closed) handlers.onClose('error');
        },
      });
      this.kickLater();
      return {
        send: () => false,
        close: () => {
          closed = true;
        },
      };
    }

    const link: Link = {
      id: this.nextLinkId++,
      peerId: host.nextPeerId++,
      host,
      clientAddress: address,
      handlers,
      clientClosed: false,
      dead: false,
      blackholed: false,
    };
    this.links.set(link.id, link);
    host.links.set(link.peerId, link);

    let open = false;
    this.enqueue({
      kind: 'peer',
      link: link.id,
      run: () => {
        if (!link.dead && !host.stopped) host.handlers.onPeer(link.peerId, address);
      },
    });
    this.enqueue({
      kind: 'open',
      link: link.id,
      run: () => {
        if (link.dead || link.clientClosed) return;
        open = true;
        handlers.onOpen();
      },
    });
    this.kickLater();

    return {
      send: (msg) => {
        if (link.dead || link.clientClosed || !open) return false;
        const text = encode(msg);
        if (text === null) {
          // An oversize line gets the peer dropped by the receiver.
          this.kill(link, { client: 'error', host: true });
          this.kick();
          return false;
        }
        this.pushMessage('to-host', link, text);
        this.kick();
        return true;
      },
      close: () => {
        if (link.clientClosed) return;
        link.clientClosed = true;
        if (!link.dead) this.kill(link, { client: null, host: true });
        this.kick();
      },
    };
  }

  private pushMessage(dir: 'to-host' | 'to-client', link: Link, text: string): void {
    const parsed: unknown = JSON.parse(text);
    this.log.push({ dir, link: link.id, msg: parsed as Json });
    this.enqueue({
      kind: dir,
      link: link.id,
      msg: parsed as Json,
      run: () => {
        if (link.dead || link.blackholed) return;
        // A real adapter only ever hands JSON objects to the session.
        const copy: unknown = JSON.parse(text);
        if (!isJsonObject(copy)) return;
        if (dir === 'to-host') {
          if (!link.host.stopped) link.host.handlers.onMessage(link.peerId, copy);
        } else if (!link.clientClosed) {
          link.handlers.onMessage(copy);
        }
      },
    });
  }

  /** Ends a connection, queueing the notifications each side is entitled to. */
  private kill(link: Link, notify: { client: 'closed' | 'error' | 'timeout' | null; host: boolean }): void {
    if (link.dead) return;
    link.dead = true;
    link.host.links.delete(link.peerId);
    this.links.delete(link.id);
    const host = link.host;
    if (notify.host) {
      this.enqueue({
        kind: 'peer-gone',
        link: link.id,
        run: () => {
          if (!host.stopped) host.handlers.onPeerGone(link.peerId);
        },
      });
    }
    const reason = notify.client;
    if (reason !== null) {
      this.enqueue({
        kind: 'client-close',
        link: link.id,
        run: () => {
          if (!link.clientClosed) link.handlers.onClose(reason);
        },
      });
    }
  }

  // ---------------------------------------------------------------- discovery

  private foundHosts(): FoundHost[] {
    if (!this.discoveryEnabled) return [];
    return [...this.hosts.values()].map((h) => ({ name: h.name, host: h.address, port: h.port, txt: { ...h.txt } }));
  }

  private announce(): void {
    for (const b of this.browsers) {
      this.enqueue({
        kind: 'browse',
        link: 0,
        run: () => {
          if (this.browsers.has(b)) b.onChange(this.foundHosts());
        },
      });
    }
  }

  /** Re-announces the host list to every browser (after toggling discoveryEnabled). */
  refreshDiscovery(): void {
    this.announce();
    this.kick();
  }

  private browse(handlers: { onChange(hosts: FoundHost[]): void; onError(e: unknown): void }): () => void {
    const entry = { onChange: handlers.onChange };
    this.browsers.add(entry);
    this.enqueue({
      kind: 'browse',
      link: 0,
      run: () => {
        if (this.browsers.has(entry)) entry.onChange(this.foundHosts());
      },
    });
    this.kickLater();
    return () => {
      this.browsers.delete(entry);
    };
  }
}

/** A network with a single adapter, for tests that need only one device. */
export function createMemoryAdapter(network: MemoryNetwork = new MemoryNetwork()): NetworkAdapter {
  return network.createAdapter();
}
