/* eslint-disable @typescript-eslint/no-explicit-any */
import { Buffer } from 'buffer';
import { Platform } from 'react-native';

import {
  createLanAdapter,
  MAX_LINE_BYTES,
  sanitizeServiceName,
  truncateUtf8,
} from '../lanAdapter';
import { LISTENER_CLOSED } from '../transport';
import type { ClientTransportHandlers, HostTransportHandlers, Json } from '../transport';

// ---------------------------------------------------------------- fakes

jest.mock('react-native-tcp-socket', () => {
  const { EventEmitter } = require('events');
  const log: string[] = [];

  class FakeSocket extends EventEmitter {
    pending: boolean;
    destroyed = false;
    remoteAddress: string | undefined;
    written: string[] = [];
    destroyCalls = 0;
    options: any;
    connectCallback: (() => void) | undefined;
    label: string;
    constructor(label: string, pending: boolean) {
      super();
      this.label = label;
      this.pending = pending;
    }
    setNoDelay() {
      return this;
    }
    writeCallbacks: Array<() => void> = [];
    write(data: string, _encoding?: string, cb?: () => void) {
      // Same contract as the real library: the callback runs when the native write is done.
      if (this.pending || this.destroyed) throw new Error('Socket is closed.');
      this.written.push(data);
      if (cb) this.writeCallbacks.push(cb);
      return true;
    }
    /** Test helper: the native side reports every write so far as completed. */
    simulateWritten() {
      for (const cb of this.writeCallbacks.splice(0)) cb();
    }
    destroy() {
      this.destroyCalls++;
      if (this.destroyed) return this;
      if (this.pending) throw new Error('destroy() on a socket that is still connecting');
      this.destroyed = true;
      log.push(`destroy:${this.label}`);
      return this;
    }
    /** Test helper: the native side reports the connection as established. */
    simulateConnect() {
      this.pending = false;
      this.emit('connect');
      this.connectCallback?.();
    }
  }

  class FakeServer extends EventEmitter {
    listenOptions: any;
    closeCalls = 0;
    port = 43210;
    connectionListener: (socket: FakeSocket) => void;
    constructor(connectionListener: (socket: FakeSocket) => void) {
      super();
      this.connectionListener = connectionListener;
    }
    listen(options: any, callback: () => void) {
      this.listenOptions = options;
      if (state.listenError) {
        const error = state.listenError;
        setTimeout(() => this.emit('error', error), 0);
      } else {
        setTimeout(callback, 0);
      }
      return this;
    }
    address() {
      return { address: '0.0.0.0', family: 'IPv4', port: this.port };
    }
    close() {
      this.closeCalls++;
      log.push('server.close');
      return this;
    }
    /** Test helper: a client connected. */
    accept(remoteAddress = '::ffff:192.168.1.20') {
      const socket = new FakeSocket(`peer${state.sockets.length + 1}`, false);
      socket.remoteAddress = remoteAddress;
      state.sockets.push(socket);
      this.connectionListener(socket);
      return socket;
    }
  }

  const state: any = {
    log,
    sockets: [] as FakeSocket[],
    servers: [] as FakeServer[],
    listenError: null,
    reset() {
      log.length = 0;
      state.sockets.length = 0;
      state.servers.length = 0;
      state.listenError = null;
    },
  };

  return {
    __esModule: true,
    __state: state,
    default: {
      createServer(listener: (socket: FakeSocket) => void) {
        const server = new FakeServer(listener);
        state.servers.push(server);
        return server;
      },
      createConnection(options: any, callback: () => void) {
        const socket = new FakeSocket(`client${state.sockets.length + 1}`, true);
        socket.options = options;
        socket.connectCallback = callback;
        state.sockets.push(socket);
        return socket;
      },
    },
  };
});

jest.mock('react-native-zeroconf', () => {
  const { EventEmitter } = require('events');
  const state: any = {
    instances: [] as any[],
    log: [] as string[],
    publishImpl: null as any,
    reset() {
      state.instances.length = 0;
      state.log.length = 0;
      state.publishImpl = null;
    },
  };
  class FakeZeroconf extends EventEmitter {
    published: any[] = [];
    unpublished: string[] = [];
    scans: any[] = [];
    stopCalls = 0;
    removeDeviceListenersCalls = 0;
    constructor() {
      super();
      state.instances.push(this);
    }
    publishService(options: any) {
      this.published.push(options);
      if (state.publishImpl) return state.publishImpl(options);
      return Promise.resolve({ name: options.name, port: options.port });
    }
    unpublishService(name: string) {
      this.unpublished.push(name);
      state.log.push(`unpublish:${name}`);
      return Promise.resolve(null);
    }
    scan(options: any) {
      this.scans.push(options);
    }
    stop() {
      this.stopCalls++;
    }
    removeDeviceListeners() {
      this.removeDeviceListenersCalls++;
    }
  }
  return {
    __esModule: true,
    __state: state,
    default: FakeZeroconf,
    ImplType: { NSD: 'NSD', DNSSD: 'DNSSD' },
  };
});

jest.mock('expo-network', () => ({
  getIpAddressAsync: jest.fn(),
  getNetworkStateAsync: jest.fn(),
  NetworkStateType: { NONE: 'NONE', UNKNOWN: 'UNKNOWN', CELLULAR: 'CELLULAR', WIFI: 'WIFI', ETHERNET: 'ETHERNET', VPN: 'VPN' },
}));

const tcp = (jest.requireMock('react-native-tcp-socket') as any).__state;
const zc = (jest.requireMock('react-native-zeroconf') as any).__state;
const network = jest.requireMock('expo-network') as { getIpAddressAsync: jest.Mock; getNetworkStateAsync: jest.Mock };

// ---------------------------------------------------------------- helpers

function hostHandlers() {
  const events: string[] = [];
  const messages: Array<{ peerId: number; msg: Json }> = [];
  const errors: unknown[] = [];
  const handlers: HostTransportHandlers = {
    onPeer: (peerId, remoteAddress) => events.push(`peer:${peerId}:${remoteAddress}`),
    onMessage: (peerId, msg) => {
      messages.push({ peerId, msg });
      events.push(`msg:${peerId}`);
    },
    onPeerGone: (peerId) => events.push(`gone:${peerId}`),
    onError: (e) => errors.push(e),
  };
  return { handlers, events, messages, errors };
}

function clientHandlers() {
  const events: string[] = [];
  const messages: Json[] = [];
  const handlers: ClientTransportHandlers = {
    onOpen: () => events.push('open'),
    onMessage: (msg) => {
      messages.push(msg);
      events.push('msg');
    },
    onClose: (reason) => events.push(`close:${reason}`),
  };
  return { handlers, events, messages };
}

/** Lets pending promise callbacks and zero-delay timers run. */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    jest.advanceTimersByTime(0);
  }
  await Promise.resolve();
}

async function startedHost(name = 'Alice', txt?: Record<string, string>) {
  const h = hostHandlers();
  const promise = createLanAdapter().startHost({ name, txt }, h.handlers);
  await flush();
  const transport = await promise;
  await flush();
  return { ...h, transport, server: tcp.servers[0], zeroconf: zc.instances[0] };
}

const bytes = (text: string) => Buffer.from(text, 'utf8');
const originalOS = Platform.OS;

beforeEach(() => {
  jest.useFakeTimers();
  tcp.reset();
  zc.reset();
  network.getIpAddressAsync.mockReset();
  network.getNetworkStateAsync.mockReset();
  network.getNetworkStateAsync.mockResolvedValue({ type: 'WIFI' });
  Platform.OS = 'ios';
});

afterEach(() => {
  jest.useRealTimers();
  Platform.OS = originalOS;
});

// ---------------------------------------------------------------- tests

describe('service names', () => {
  it('truncates on a UTF-8 character boundary', () => {
    expect(truncateUtf8('abc', 63)).toBe('abc');
    expect(truncateUtf8('a'.repeat(70), 63)).toBe('a'.repeat(63));
    // "é" is 2 bytes: 62 ASCII + é = 64 bytes -> the é must go entirely.
    expect(truncateUtf8('a'.repeat(62) + 'é', 63)).toBe('a'.repeat(62));
    // Emoji are 4 bytes (and a surrogate pair in JS): never cut in half.
    const emoji = truncateUtf8('😀'.repeat(20), 63);
    expect(emoji).toBe('😀'.repeat(15));
    expect(Buffer.byteLength(emoji, 'utf8')).toBe(60);
  });

  it('sanitises names and falls back when empty', () => {
    expect(sanitizeServiceName('  Bob\n ')).toBe('Bob');
    expect(sanitizeServiceName('   ')).toBe('Similarity Game');
    expect(Buffer.byteLength(sanitizeServiceName('日本語'.repeat(20)), 'utf8')).toBeLessThanOrEqual(63);
  });
});

describe('startHost', () => {
  it('listens on an OS-assigned port on all interfaces and publishes the service', async () => {
    const { transport, server, zeroconf } = await startedHost('Alice', { v: '1', n: 'Alice' });
    expect(server.listenOptions).toMatchObject({ port: 0, host: '0.0.0.0' });
    expect(zeroconf.published).toEqual([
      { type: 'simgame', protocol: 'tcp', name: 'Alice', port: 43210, txt: { v: '1', n: 'Alice' } },
    ]);
    expect(transport.port).toBe(43210);
    expect(transport.serviceName).toBe('Alice');
  });

  it('publishes a truncated name and returns the name mDNS actually assigned', async () => {
    zc.publishImpl = (options: any) => Promise.resolve({ name: `${options.name} (2)` });
    const long = 'é'.repeat(40); // 80 bytes
    const { transport, zeroconf } = await startedHost(long);
    const requested = zeroconf.published[0].name as string;
    expect(requested).toBe('é'.repeat(31)); // 62 bytes: the 32nd é would not fit in 63
    expect(transport.serviceName).toBe(`${requested} (2)`);
  });

  it('rejects and cleans up when listening fails', async () => {
    tcp.listenError = new Error('EADDRINUSE');
    const h = hostHandlers();
    const promise = createLanAdapter().startHost({ name: 'Alice' }, h.handlers);
    const outcome = promise.then(
      () => 'resolved',
      (e) => e,
    );
    await flush();
    expect(await outcome).toBe(tcp.listenError);
    expect(zc.instances).toHaveLength(0);
    // The library closes the server itself on 'error': we must not close it again.
    expect(tcp.servers[0].closeCalls).toBe(0);
  });

  it('opens the lobby anyway when publishing fails: it can still be joined by address', async () => {
    zc.publishImpl = () => Promise.reject(new Error('NSD failure'));
    const h = hostHandlers();
    const promise = createLanAdapter().startHost({ name: '  Alice\n' }, h.handlers);
    await flush();
    const transport = await promise;
    await flush();
    expect(transport.serviceName).toBe('Alice'); // the name that was asked for
    expect(transport.port).toBe(43210);
    expect(tcp.servers[0].closeCalls).toBe(0);
    // The host is told why nobody will find the lobby by itself.
    expect(h.errors).toHaveLength(1);
    expect(String((h.errors[0] as Error).message)).toMatch(/cannot find this lobby automatically \(NSD failure\)/);
    // Phones that connect by address are served as usual.
    const socket = tcp.servers[0].accept();
    socket.emit('data', bytes('{"t":"hi"}\n'));
    expect(h.events).toEqual(['peer:1:192.168.1.20', 'msg:1']);
    // Stopping still tries to withdraw the name and closes the server.
    await transport.stop();
    expect(zc.instances[0].unpublished).toEqual(['Alice']);
    expect(tcp.servers[0].closeCalls).toBe(1);
  });

  it('opens the lobby when publishing throws synchronously or never completes', async () => {
    zc.publishImpl = () => {
      throw new Error('no NSD here');
    };
    const a = hostHandlers();
    const first = createLanAdapter().startHost({ name: 'Alice' }, a.handlers);
    await flush();
    const t1 = await first;
    await flush();
    expect(t1.serviceName).toBe('Alice');
    jest.advanceTimersByTime(1); // a timer set inside a fake-timer tick is due 1 ms later
    expect(a.errors).toHaveLength(1);
    await t1.stop();

    zc.publishImpl = () => new Promise(() => undefined); // registration hangs
    const b = hostHandlers();
    let resolved = false;
    const second = createLanAdapter()
      .startHost({ name: 'Bob' }, b.handlers)
      .then((t) => {
        resolved = true;
        return t;
      });
    await flush();
    jest.advanceTimersByTime(9999);
    await flush();
    expect(resolved).toBe(false);
    jest.advanceTimersByTime(1);
    await flush();
    const t2 = await second;
    await flush();
    expect(t2.serviceName).toBe('Bob');
    expect(tcp.servers[1].closeCalls).toBe(0);
    expect(String((b.errors[0] as Error).message)).toMatch(/publish timed out/);
    await t2.stop();
  });

  it('still fails to host when local-network access is refused', async () => {
    const failure = Object.assign(new Error('NSNetServicesErrorCode -72008: policy denied'), { code: -72008 });
    zc.publishImpl = () => Promise.reject(failure);
    const h = hostHandlers();
    const outcome = createLanAdapter()
      .startHost({ name: 'Alice' }, h.handlers)
      .then(
        () => 'resolved',
        (e) => e,
      );
    await flush();
    expect(await outcome).toBe(failure);
    expect(tcp.servers[0].closeCalls).toBe(1);
    expect(zc.instances[0].removeDeviceListenersCalls).toBe(1);
    expect(h.errors).toEqual([]);
  });

  it('withdraws a registration that completes after the publish timeout or after stop()', async () => {
    // Late, on a lobby that opened without it: the real (renamed) name is remembered for stop().
    let finish: (value: any) => void = () => undefined;
    zc.publishImpl = () => new Promise((resolve) => (finish = resolve));
    const h = hostHandlers();
    const promise = createLanAdapter().startHost({ name: 'Alice' }, h.handlers);
    await flush();
    jest.advanceTimersByTime(10000);
    await flush();
    const transport = await promise;
    finish({ name: 'Alice (2)' });
    await flush();
    expect(zc.instances[0].unpublished).toEqual([]); // now advertised after all: keep it
    await transport.stop();
    expect(zc.instances[0].unpublished).toEqual(['Alice (2)']);

    // Late, after the transport was stopped while the registration was still pending.
    let finishLate: (value: any) => void = () => undefined;
    zc.publishImpl = () => new Promise((resolve) => (finishLate = resolve));
    const second = createLanAdapter().startHost({ name: 'Bob' }, hostHandlers().handlers);
    await flush();
    jest.advanceTimersByTime(10000);
    await flush();
    const t2 = await second;
    await t2.stop();
    await flush();
    expect(zc.instances[1].unpublished).toEqual(['Bob']); // natively a no-op: nothing is published yet
    finishLate({ name: 'Bob (2)' });
    await flush();
    expect(zc.instances[1].unpublished).toEqual(['Bob', 'Bob (2)']); // no orphan advertisement
    expect(tcp.servers[1].closeCalls).toBe(1);
  });

  it('reports peers with a cleaned IPv4 address and frames their messages', async () => {
    const { server, events, messages } = await startedHost();
    const socket = server.accept('::ffff:192.168.1.20');
    expect(events).toEqual(['peer:1:192.168.1.20']);

    // Several messages in one chunk.
    socket.emit('data', bytes('{"t":"a"}\n{"t":"b"}\n{"t":"c"}\n'));
    expect(messages.map((m) => m.msg.t)).toEqual(['a', 'b', 'c']);
    expect(messages.every((m) => m.peerId === 1)).toBe(true);
  });

  it('reassembles multi-byte characters split across chunks', async () => {
    const { server, messages } = await startedHost();
    const socket = server.accept();
    const payload = bytes(JSON.stringify({ t: 'clue', text: 'naïve 😀 日本' }) + '\n');
    // One byte at a time: every multi-byte character is split.
    for (let i = 0; i < payload.length; i++) socket.emit('data', payload.slice(i, i + 1));
    expect(messages).toEqual([{ peerId: 1, msg: { t: 'clue', text: 'naïve 😀 日本' } }]);

    // A message split in the middle of a character, followed by the start of the next one.
    const two = bytes('{"t":"é"}\n{"t":"z"}\n');
    const cut = two.indexOf(0xc3) + 1; // between the two bytes of "é"
    socket.emit('data', two.slice(0, cut));
    socket.emit('data', two.slice(cut));
    expect(messages.slice(1).map((m) => m.msg.t)).toEqual(['é', 'z']);
  });

  it('accepts string chunks and ignores lines that are not JSON objects', async () => {
    const { server, messages, errors, events } = await startedHost();
    const socket = server.accept();
    socket.emit('data', 'not json\n[1,2]\n"str"\nnull\n42\n\n{"ok":true}\n');
    expect(messages).toEqual([{ peerId: 1, msg: { ok: true } }]);
    expect(errors).toEqual([]);
    expect(events).not.toContain('gone:1');
  });

  it('drops a peer whose pending line exceeds 64 KB', async () => {
    const { server, events, messages } = await startedHost();
    const socket = server.accept();
    const chunk = bytes('x'.repeat(16 * 1024));
    for (let i = 0; i < 4; i++) socket.emit('data', chunk);
    expect(socket.destroyed).toBe(false); // exactly 64 KB is still allowed to grow no further
    socket.emit('data', bytes('x'));
    expect(socket.destroyed).toBe(true);
    expect(events).toEqual(['peer:1:192.168.1.20', 'gone:1']);

    // Anything it sends afterwards is ignored, and the later close is not reported twice.
    socket.emit('data', bytes('\n{"t":"late"}\n'));
    socket.emit('close', false);
    expect(messages).toEqual([]);
    expect(events).toEqual(['peer:1:192.168.1.20', 'gone:1']);
  });

  it('drops a peer that sends an oversize complete line in a single chunk', async () => {
    const { server, events, messages } = await startedHost();
    const socket = server.accept();
    socket.emit('data', bytes(`{"t":"${'x'.repeat(MAX_LINE_BYTES)}"}\n{"t":"after"}\n`));
    expect(socket.destroyed).toBe(true);
    expect(messages).toEqual([]);
    expect(events).toContain('gone:1');
  });

  it('sends to one peer or all, and never throws after a peer has closed', async () => {
    const { server, transport, events } = await startedHost();
    const a = server.accept();
    const b = server.accept();
    transport.sendTo(1, { t: 'hello', text: 'é' });
    transport.broadcast({ t: 'all' });
    expect(a.written).toEqual(['{"t":"hello","text":"é"}\n', '{"t":"all"}\n']);
    expect(b.written).toEqual(['{"t":"all"}\n']);

    // Remote close: the library does NOT mark the socket destroyed.
    a.emit('close', false);
    expect(events).toContain('gone:1');
    expect(() => transport.sendTo(1, { t: 'x' })).not.toThrow();
    expect(() => transport.broadcast({ t: 'y' })).not.toThrow();
    expect(a.written).toHaveLength(2);
    expect(b.written).toEqual(['{"t":"all"}\n', '{"t":"y"}\n']);

    // A socket whose write throws (destroyed underneath us) is survived too.
    b.destroyed = true;
    expect(() => transport.broadcast({ t: 'z' })).not.toThrow();
    expect(() => transport.sendTo(99, { t: 'nobody' })).not.toThrow();
  });

  it('refuses to send a message larger than the line limit or one that cannot be serialised', async () => {
    const { server, transport } = await startedHost();
    const a = server.accept();
    transport.sendTo(1, { big: 'x'.repeat(MAX_LINE_BYTES) });
    const cyclic: Json = {};
    cyclic.self = cyclic;
    expect(() => transport.broadcast(cyclic)).not.toThrow();
    expect(a.written).toEqual([]);
  });

  it('reports a peer gone exactly once on error followed by close', async () => {
    const { server, events } = await startedHost();
    const socket = server.accept();
    socket.emit('error', 'ECONNRESET');
    socket.emit('close', true);
    expect(events.filter((e) => e === 'gone:1')).toHaveLength(1);
  });

  it('dropPeer destroys the socket without reporting the peer gone', async () => {
    const { server, transport, events, messages } = await startedHost();
    const socket = server.accept();
    transport.dropPeer(1);
    expect(socket.destroyed).toBe(true);
    socket.emit('data', bytes('{"t":"late"}\n'));
    socket.emit('close', false);
    expect(messages).toEqual([]);
    expect(events).toEqual(['peer:1:192.168.1.20']);
    expect(() => transport.dropPeer(1)).not.toThrow();
    expect(() => transport.dropPeer(42)).not.toThrow();
  });

  it('stop destroys every socket before closing the server exactly once, and unpublishes', async () => {
    const { server, transport, zeroconf, events } = await startedHost();
    const a = server.accept();
    const b = server.accept();
    tcp.log.length = 0;

    const first = transport.stop();
    const second = transport.stop();
    await flush();
    await Promise.all([first, second]);

    expect(tcp.log).toEqual(['destroy:peer1', 'destroy:peer2', 'server.close']);
    expect(server.closeCalls).toBe(1);
    expect(zeroconf.unpublished).toEqual(['Alice']);
    expect(zeroconf.removeDeviceListenersCalls).toBe(1);
    expect(zeroconf.listenerCount('error')).toBe(0);

    // Late socket events and late calls are harmless and silent.
    a.emit('close', false);
    b.emit('error', 'boom');
    expect(events.filter((e) => e.startsWith('gone'))).toEqual([]);
    expect(() => transport.broadcast({ t: 'x' })).not.toThrow();
    expect(() => transport.sendTo(1, { t: 'x' })).not.toThrow();
    await transport.stop();
    expect(server.closeCalls).toBe(1);
    expect(a.written).toEqual([]);
  });

  it('forwards zeroconf errors; a server error after opening is reported as a dead listener and stops the transport', async () => {
    const { server, zeroconf, errors } = await startedHost();
    const peer = server.accept();
    zeroconf.emit('error', new Error('mdns'));
    expect(errors).toHaveLength(1);
    expect((errors[0] as { code?: unknown }).code).toBeUndefined();

    server.emit('error', new Error('accept failed: EMFILE'));
    expect(errors).toHaveLength(2);
    expect(errors[1]).toMatchObject({ code: LISTENER_CLOSED });
    expect(String((errors[1] as Error).message)).toContain('EMFILE');
    // Connected peers are not cut off at once (the session gets to say goodbye first)...
    expect(peer.destroyed).toBe(false);
    expect(zeroconf.unpublished).toEqual([]);
    // ...but the dead port never stays advertised.
    jest.advanceTimersByTime(1000);
    await flush();
    expect(zeroconf.unpublished).toEqual(['Alice']);
    expect(peer.destroyed).toBe(true);
    expect(server.closeCalls).toBe(0); // the library closed it itself
  });

  it('replays a peer that connects before the transport is handed to the caller', async () => {
    let resolvePublish: (value: any) => void = () => undefined;
    zc.publishImpl = () => new Promise((resolve) => (resolvePublish = resolve));
    const h = hostHandlers();
    const promise = createLanAdapter().startHost({ name: 'Alice' }, h.handlers);
    await flush();
    const socket = tcp.servers[0].accept();
    socket.emit('data', bytes('{"t":"early"}\n'));
    expect(h.events).toEqual([]);
    resolvePublish({ name: 'Alice' });
    const transport = await promise;
    await flush();
    expect(h.events).toEqual(['peer:1:192.168.1.20', 'msg:1']);
    await transport.stop();
  });
});

describe('connect', () => {
  it('uses a 5000 ms connect timeout and opens, receives and sends', () => {
    const c = clientHandlers();
    const transport = createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const socket = tcp.sockets[0];
    expect(socket.options).toEqual({ host: '192.168.1.5', port: 4000, connectTimeout: 5000 });

    // Not open yet: send is refused rather than throwing.
    expect(transport.send({ t: 'early' })).toBe(false);

    socket.simulateConnect();
    expect(c.events).toEqual(['open']);
    expect(transport.send({ t: 'hello', name: 'Zoë' })).toBe(true);
    expect(socket.written).toEqual(['{"t":"hello","name":"Zoë"}\n']);

    const payload = bytes('{"t":"view","w":"日本"}\n{"t":"ping"}\n');
    socket.emit('data', payload.slice(0, 17));
    socket.emit('data', payload.slice(17));
    expect(c.messages).toEqual([{ t: 'view', w: '日本' }, { t: 'ping' }]);
  });

  it('reports a remote close once and makes later sends safe', () => {
    const c = clientHandlers();
    const transport = createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const socket = tcp.sockets[0];
    socket.simulateConnect();
    socket.emit('close', false);
    socket.emit('close', false);
    expect(c.events).toEqual(['open', 'close:closed']);
    // The library does not flag the socket destroyed on remote close.
    expect(transport.send({ t: 'x' })).toBe(false);
    expect(socket.written).toEqual([]);
    expect(() => transport.close()).not.toThrow();
  });

  it('reports an error after open as "error", once', () => {
    const c = clientHandlers();
    createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const socket = tcp.sockets[0];
    socket.simulateConnect();
    socket.destroyed = true; // what the library does before emitting 'error'
    socket.emit('error', 'ECONNRESET');
    socket.emit('close', true);
    expect(c.events).toEqual(['open', 'close:error']);
  });

  it('survives a write that throws', () => {
    const c = clientHandlers();
    const transport = createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const socket = tcp.sockets[0];
    socket.simulateConnect();
    socket.write = () => {
      throw new Error('Socket is closed.');
    };
    expect(transport.send({ t: 'x' })).toBe(false);
  });

  it('closes with "error" when the host sends an oversize line', () => {
    const c = clientHandlers();
    createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const socket = tcp.sockets[0];
    socket.simulateConnect();
    socket.emit('data', bytes('x'.repeat(MAX_LINE_BYTES + 1)));
    expect(socket.destroyed).toBe(true);
    expect(c.events).toEqual(['open', 'close:error']);
  });

  it('implements the connect timeout itself and never destroys a pending socket', () => {
    const c = clientHandlers();
    createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const socket = tcp.sockets[0];
    jest.advanceTimersByTime(4999);
    expect(c.events).toEqual([]);
    jest.advanceTimersByTime(5000);
    expect(c.events).toEqual(['close:timeout']);
    expect(socket.destroyCalls).toBe(0);

    // If the abandoned socket connects after all, it is destroyed and stays silent.
    socket.simulateConnect();
    expect(socket.destroyed).toBe(true);
    socket.emit('data', bytes('{"t":"late"}\n'));
    socket.emit('close', false);
    expect(c.events).toEqual(['close:timeout']);
    expect(tcp.sockets).toHaveLength(1); // no wifi retry off Android
  });

  it('maps a native connect timeout error to "timeout" and a refusal to "error"', () => {
    const a = clientHandlers();
    createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, a.handlers);
    tcp.sockets[0].emit('error', 'connect timed out');
    tcp.sockets[0].emit('close', true);
    expect(a.events).toEqual(['close:timeout']);

    const b = clientHandlers();
    createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, b.handlers);
    tcp.sockets[1].emit('error', 'ECONNREFUSED');
    expect(b.events).toEqual(['close:error']);
    jest.advanceTimersByTime(60000);
    expect(b.events).toEqual(['close:error']);
  });

  it("recognises Android's wording of a connect timeout", () => {
    for (const text of [
      'failed to connect to /192.168.1.5 (port 4000) from /192.168.1.7 (port 40000) after 5000ms',
      'failed to connect to /192.168.1.5 (port 4000): connect failed: ETIMEDOUT (Connection timed out)',
      'SocketTimeoutException: timeout',
    ]) {
      const c = clientHandlers();
      createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
      tcp.sockets[tcp.sockets.length - 1].emit('error', new Error(text));
      expect(c.events).toEqual(['close:timeout']);
    }
    // After the connection was open, the same words are an ordinary error.
    const c = clientHandlers();
    createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const socket = tcp.sockets[tcp.sockets.length - 1];
    socket.simulateConnect();
    socket.emit('error', new Error('read timed out after 5000ms'));
    expect(c.events).toEqual(['open', 'close:error']);
  });

  it('on Android retries a failed connect once, bound to Wi-Fi', () => {
    Platform.OS = 'android';
    const c = clientHandlers();
    const transport = createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const first = tcp.sockets[0];
    expect(first.options.interface).toBeUndefined();
    first.emit('error', 'ENETUNREACH');
    first.emit('close', true);

    expect(c.events).toEqual([]);
    expect(tcp.sockets).toHaveLength(2);
    const second = tcp.sockets[1];
    expect(second.options).toEqual({
      host: '192.168.1.5',
      port: 4000,
      connectTimeout: 5000,
      interface: 'wifi',
    });
    second.simulateConnect();
    expect(c.events).toEqual(['open']);
    expect(transport.send({ t: 'hi' })).toBe(true);
    expect(second.written).toEqual(['{"t":"hi"}\n']);
    expect(first.written).toEqual([]);
  });

  it('on Android gives up after the Wi-Fi retry fails too', () => {
    Platform.OS = 'android';
    const c = clientHandlers();
    createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    jest.advanceTimersByTime(7000); // first attempt times out
    expect(c.events).toEqual([]);
    expect(tcp.sockets).toHaveLength(2);
    tcp.sockets[1].emit('error', 'ECONNREFUSED');
    expect(c.events).toEqual(['close:error']);
    expect(tcp.sockets).toHaveLength(2);
  });

  it('does not retry via Wi-Fi once the connection has been open', () => {
    Platform.OS = 'android';
    const c = clientHandlers();
    createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    tcp.sockets[0].simulateConnect();
    tcp.sockets[0].emit('close', false);
    expect(c.events).toEqual(['open', 'close:closed']);
    expect(tcp.sockets).toHaveLength(1);
  });

  it('close() while connecting defers the destroy and silences every handler', () => {
    Platform.OS = 'android';
    const c = clientHandlers();
    const transport = createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const socket = tcp.sockets[0];
    transport.close();
    expect(socket.destroyCalls).toBe(0); // still pending: must not be destroyed yet
    socket.simulateConnect();
    expect(socket.destroyed).toBe(true);
    socket.emit('close', false);
    jest.advanceTimersByTime(60000);
    expect(c.events).toEqual([]);
    expect(tcp.sockets).toHaveLength(1);
    expect(transport.send({ t: 'x' })).toBe(false);
  });

  it('close() on an open connection destroys it and silences every handler', () => {
    const c = clientHandlers();
    const transport = createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const socket = tcp.sockets[0];
    socket.simulateConnect();
    transport.close();
    transport.close();
    expect(socket.destroyCalls).toBe(1);
    socket.emit('data', bytes('{"t":"late"}\n'));
    socket.emit('close', false);
    expect(c.events).toEqual(['open']);
    expect(transport.send({ t: 'x' })).toBe(false);
  });

  it('close() right after a send lets the line be written before destroying the socket', () => {
    const c = clientHandlers();
    const transport = createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const socket = tcp.sockets[0];
    socket.simulateConnect();
    expect(transport.send({ t: 'leave' })).toBe(true);
    transport.close();
    // Closed from the caller's point of view at once...
    expect(transport.send({ t: 'x' })).toBe(false);
    socket.emit('data', bytes('{"t":"late"}\n'));
    expect(c.events).toEqual(['open']);
    // ...but the socket lives until the native write has completed.
    expect(socket.destroyCalls).toBe(0);
    socket.simulateWritten();
    expect(socket.destroyCalls).toBe(1);
    expect(socket.written).toEqual(['{"t":"leave"}\n']);
    jest.advanceTimersByTime(1000);
    expect(socket.destroyCalls).toBe(1);
    socket.emit('close', false);
    expect(c.events).toEqual(['open']);
  });

  it('close() does not wait for ever on a write that is never confirmed', () => {
    const c = clientHandlers();
    const transport = createLanAdapter().connect({ host: '192.168.1.5', port: 4000 }, c.handlers);
    const socket = tcp.sockets[0];
    socket.simulateConnect();
    transport.send({ t: 'a' });
    socket.simulateWritten();
    transport.send({ t: 'leave' });
    transport.close();
    expect(socket.destroyCalls).toBe(0);
    jest.advanceTimersByTime(249);
    expect(socket.destroyCalls).toBe(0);
    jest.advanceTimersByTime(1);
    expect(socket.destroyCalls).toBe(1);
    socket.simulateWritten(); // a late confirmation changes nothing
    expect(socket.destroyCalls).toBe(1);
  });
});

describe('browse', () => {
  const service = (name: string, ipv4: string[], port = 4000, txt: any = { v: '1' }) => ({
    name,
    fullName: `${name}._simgame._tcp.local.`,
    host: `${name}.local.`,
    port,
    addresses: ipv4,
    ipv4,
    ipv6: [],
    txt,
  });

  it('scans for _simgame._tcp and reports hosts as they are resolved and removed', () => {
    const changes: any[] = [];
    const errors: unknown[] = [];
    const stop = createLanAdapter().browse({
      onChange: (hosts) => changes.push(hosts),
      onError: (e) => errors.push(e),
    });
    const zeroconf = zc.instances[0];
    expect(zeroconf.scans).toEqual([
      { type: 'simgame', protocol: 'tcp', resolveTimeout: 10, implType: 'NSD' },
    ]);

    zeroconf.emit('resolved', service('Alice', ['192.168.1.5']));
    zeroconf.emit('resolved', service('NoIPv4', []));
    zeroconf.emit('resolved', service('Bob', ['fe80::1', '192.168.1.6'], 4001, { v: '1', n: 3 }));
    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual([
      { name: 'Alice', host: '192.168.1.5', port: 4000, txt: { v: '1' } },
      { name: 'Bob', host: '192.168.1.6', port: 4001, txt: { v: '1', n: '3' } },
    ]);

    // A re-resolve updates in place.
    zeroconf.emit('resolved', service('Alice', ['192.168.1.9'], 4002));
    expect(changes[2][0]).toEqual({ name: 'Alice', host: '192.168.1.9', port: 4002, txt: { v: '1' } });

    zeroconf.emit('remove', 'Alice');
    expect(changes[3].map((h: any) => h.name)).toEqual(['Bob']);
    zeroconf.emit('remove', 'Unknown');
    expect(changes).toHaveLength(4);

    zeroconf.emit('error', new Error('nsd'));
    expect(errors).toHaveLength(1);

    // One advertisement that cannot be resolved is not a failed search: the stale
    // entry goes, the scan and the other hosts stay, and nothing is reported.
    zeroconf.emit('resolved', service('Stale', ['192.168.1.8']));
    expect(changes).toHaveLength(5);
    zeroconf.emit('error', Object.assign(new Error('Resolving service Stale failed: timed out'), { code: 'TIMEOUT', serviceName: 'Stale' }));
    zeroconf.emit('error', Object.assign(new Error('Resolving service Ghost failed: 3'), { serviceName: 'Ghost' }));
    zeroconf.emit('error', Object.assign(new Error('timed out'), { code: 'TIMEOUT' }));
    expect(errors).toHaveLength(1);
    expect(changes).toHaveLength(6);
    expect(changes[5].map((h: any) => h.name)).toEqual(['Bob']);
    changes.length = 4;

    stop();
    stop();
    expect(zeroconf.stopCalls).toBe(1);
    expect(zeroconf.removeDeviceListenersCalls).toBe(1);
    expect(zeroconf.listenerCount('resolved')).toBe(0);
    expect(zeroconf.listenerCount('remove')).toBe(0);
    expect(zeroconf.listenerCount('error')).toBe(0);
    expect(changes).toHaveLength(4);
  });

  it('uses the embedded mDNS backend only on Android when asked', () => {
    const handlers = { onChange: () => undefined, onError: () => undefined };
    createLanAdapter().browse(handlers, { useEmbeddedMdns: true })();
    expect(zc.instances[0].scans[0].implType).toBe('NSD');

    Platform.OS = 'android';
    createLanAdapter().browse(handlers, { useEmbeddedMdns: true })();
    expect(zc.instances[1].scans[0].implType).toBe('DNSSD');
    createLanAdapter().browse(handlers)();
    expect(zc.instances[2].scans[0].implType).toBe('NSD');
  });

  it('uses a different Zeroconf instance from the one that publishes', async () => {
    const { transport } = await startedHost();
    const stop = createLanAdapter().browse({ onChange: () => undefined, onError: () => undefined });
    expect(zc.instances).toHaveLength(2);
    expect(zc.instances[0].scans).toEqual([]);
    expect(zc.instances[1].published).toEqual([]);
    stop();
    // Stopping the scan does not touch the publisher.
    expect(zc.instances[0].removeDeviceListenersCalls).toBe(0);
    await transport.stop();
  });
});

describe('getLocalAddress', () => {
  it('returns the IPv4 address, or null when there is none', async () => {
    const adapter = createLanAdapter();
    network.getIpAddressAsync.mockResolvedValueOnce('192.168.1.7');
    expect(await adapter.getLocalAddress()).toBe('192.168.1.7');
    network.getIpAddressAsync.mockResolvedValueOnce('0.0.0.0');
    expect(await adapter.getLocalAddress()).toBeNull();
    network.getIpAddressAsync.mockResolvedValueOnce('fe80::1');
    expect(await adapter.getLocalAddress()).toBeNull();
    network.getIpAddressAsync.mockRejectedValueOnce(new Error('no module'));
    expect(await adapter.getLocalAddress()).toBeNull();
    expect(network.getNetworkStateAsync).not.toHaveBeenCalled(); // iOS reads the Wi-Fi interface itself
  });

  it('on Android only trusts the address when the default network is Wi-Fi or Ethernet', async () => {
    Platform.OS = 'android';
    const adapter = createLanAdapter();
    network.getIpAddressAsync.mockResolvedValue('192.168.1.7');
    expect(await adapter.getLocalAddress()).toBe('192.168.1.7');
    network.getNetworkStateAsync.mockResolvedValueOnce({ type: 'ETHERNET' });
    expect(await adapter.getLocalAddress()).toBe('192.168.1.7');
    // Wi-Fi without internet, or this phone is the hotspot: the default network is mobile data.
    network.getIpAddressAsync.mockResolvedValue('10.64.3.9');
    for (const type of ['CELLULAR', 'VPN', 'NONE', 'UNKNOWN', undefined]) {
      network.getNetworkStateAsync.mockResolvedValueOnce({ type });
      expect(await adapter.getLocalAddress()).toBeNull();
    }
    network.getNetworkStateAsync.mockRejectedValueOnce(new Error('no module'));
    expect(await adapter.getLocalAddress()).toBeNull();
  });
});
