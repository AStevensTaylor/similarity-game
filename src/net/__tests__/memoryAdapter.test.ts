import { describe, expect, test } from '@jest/globals';
import { MemoryNetwork } from '../memoryAdapter';
import type { FoundHost, Json } from '../transport';
import { flush } from './harness';

async function pair() {
  const net = new MemoryNetwork();
  const hostAdapter = net.createAdapter();
  const clientAdapter = net.createAdapter();
  const events: string[] = [];
  const toHost: Json[] = [];
  const toClient: Json[] = [];
  const host = await hostAdapter.startHost(
    { name: 'Lobby', txt: { v: '1' } },
    {
      onPeer: (id, address) => events.push(`peer ${id} ${address}`),
      onMessage: (id, msg) => {
        events.push(`host-msg ${id}`);
        toHost.push(msg);
      },
      onPeerGone: (id) => events.push(`gone ${id}`),
      onError: () => events.push('error'),
    },
  );
  const client = clientAdapter.connect(
    { host: '10.0.0.1', port: host.port },
    {
      onOpen: () => events.push('open'),
      onMessage: (msg) => {
        events.push('client-msg');
        toClient.push(msg);
      },
      onClose: (reason) => events.push(`close ${reason}`),
    },
  );
  // Captured synchronously, before any handler could have run.
  const atConnect = { events: events.slice(), earlySend: client.send({ early: true }) };
  return { net, host, client, events, toHost, toClient, hostAdapter, clientAdapter, atConnect };
}

describe('MemoryNetwork', () => {
  test('connect is asynchronous; messages are copied in both directions', async () => {
    const p = await pair();
    expect(p.atConnect).toEqual({ events: [], earlySend: false });
    await flush();
    expect(p.events).toEqual(['peer 1 10.0.0.2', 'open']);
    const msg = { a: { b: [1, 2] } };
    expect(p.client.send(msg)).toBe(true);
    p.host.sendTo(1, msg);
    p.host.broadcast({ all: true });
    p.host.sendTo(99, { nobody: true });
    expect(p.toHost).toEqual([msg]);
    expect(p.toHost[0]).not.toBe(msg);
    expect(p.toHost[0].a).not.toBe(msg.a);
    expect(p.toClient).toEqual([msg, { all: true }]);
    expect(await p.hostAdapter.getLocalAddress()).toBe('10.0.0.1');
  });

  test('handlers are never re-entered: a reply sent inside a handler is delivered afterwards', async () => {
    const net = new MemoryNetwork();
    const order: string[] = [];
    let depth = 0;
    const host = await net.createAdapter().startHost(
      { name: 'H' },
      {
        onPeer: () => undefined,
        onMessage: (id, msg) => {
          depth++;
          order.push(`host got ${String(msg.n)} at depth ${depth}`);
          if (msg.n === 1) host.sendTo(id, { n: 2 });
          depth--;
        },
        onPeerGone: () => undefined,
        onError: () => undefined,
      },
    );
    const client = net.createAdapter().connect(
      { host: '10.0.0.1', port: host.port },
      {
        onOpen: () => undefined,
        onMessage: (msg) => {
          depth++;
          order.push(`client got ${String(msg.n)} at depth ${depth}`);
          client.send({ n: 3 });
          depth--;
        },
        onClose: () => undefined,
      },
    );
    await flush();
    client.send({ n: 1 });
    expect(order).toEqual(['host got 1 at depth 1', 'client got 2 at depth 1', 'host got 3 at depth 1']);
  });

  test('close semantics match the LAN adapter', async () => {
    // dropPeer: the client sees a close, the host is not told.
    let p = await pair();
    await flush();
    p.host.dropPeer(1);
    expect(p.events.slice(2)).toEqual(['close closed']);
    expect(p.client.send({ x: 1 })).toBe(false);

    // client.close(): the host sees the peer go, the client hears nothing more.
    p = await pair();
    await flush();
    p.client.close();
    p.host.sendTo(1, { late: true });
    expect(p.events.slice(2)).toEqual(['gone 1']);

    // stop(): clients are closed, nothing fires on the host, the port is gone.
    p = await pair();
    await flush();
    await p.host.stop();
    expect(p.events.slice(2)).toEqual(['close closed']);
    let failed: string | null = null;
    p.clientAdapter.connect({ host: '10.0.0.1', port: p.host.port }, { onOpen: () => undefined, onMessage: () => undefined, onClose: (r) => (failed = r) });
    expect(failed).toBeNull();
    await flush();
    expect(failed).toBe('error');

    // sever / crashHost.
    p = await pair();
    await flush();
    p.net.sever(p.net.linkIds()[0], 'timeout');
    expect(p.events.slice(2)).toEqual(['gone 1', 'close timeout']);
    p = await pair();
    await flush();
    p.net.crashHost(p.host.port);
    expect(p.events.slice(2)).toEqual(['close error']);
  });

  test('oversize messages: a host does not send them; a client that does is dropped', async () => {
    const p = await pair();
    await flush();
    const big = { x: 'x'.repeat(65 * 1024) };
    p.host.sendTo(1, big);
    expect(p.toClient).toEqual([]);
    expect(p.client.send({ x: 'x'.repeat(63 * 1024) })).toBe(true);
    expect(p.client.send(big)).toBe(false);
    expect(p.toHost).toHaveLength(1);
    expect(p.events.slice(-2)).toEqual(['gone 1', 'close error']);
  });

  test('pause, selective delivery, discard and resume', async () => {
    const p = await pair();
    await flush();
    p.net.pause();
    p.client.send({ n: 1 });
    p.client.send({ n: 2 });
    p.host.sendTo(1, { n: 3 });
    expect(p.toHost).toEqual([]);
    expect(p.net.pending.map((e) => [e.kind, e.msg?.n])).toEqual([
      ['to-host', 1],
      ['to-host', 2],
      ['to-client', 3],
    ]);
    expect(p.net.deliverWhere((e) => e.msg?.n === 2)).toBe(1);
    expect(p.toHost).toEqual([{ n: 2 }]);
    expect(p.net.discardWhere((e) => e.kind === 'to-client')).toBe(1);
    expect(p.net.deliverNext()).toBe(true);
    expect(p.net.deliverNext()).toBe(false);
    expect(p.toHost).toEqual([{ n: 2 }, { n: 1 }]);
    p.client.send({ n: 4 });
    p.net.resume();
    expect(p.toHost).toEqual([{ n: 2 }, { n: 1 }, { n: 4 }]);
    expect(p.toClient).toEqual([]);
    expect(p.net.log).toHaveLength(4);
  });

  test('blackhole and offline devices lose traffic silently', async () => {
    const p = await pair();
    await flush();
    p.net.blackhole(p.net.linkIds()[0]);
    expect(p.client.send({ n: 1 })).toBe(true);
    p.host.sendTo(1, { n: 2 });
    expect([p.toHost, p.toClient]).toEqual([[], []]);
    p.net.blackhole(p.net.linkIds()[0], false);
    p.client.send({ n: 3 });
    expect(p.toHost).toEqual([{ n: 3 }]);
    p.net.setOffline('10.0.0.2');
    p.client.send({ n: 4 });
    expect(p.toHost).toEqual([{ n: 3 }]);
    expect(p.events).toEqual(['peer 1 10.0.0.2', 'open', 'host-msg 1']);
    let reason: string | null = null;
    p.clientAdapter.connect({ host: '10.0.0.1', port: p.host.port }, { onOpen: () => undefined, onMessage: () => undefined, onClose: (r) => (reason = r) });
    await flush();
    expect(reason).toBe('error');
  });

  test('discovery lists hosts as they come and go, and can be made to find nothing', async () => {
    const net = new MemoryNetwork();
    const seen: FoundHost[][] = [];
    const stop = net.createAdapter().browse({ onChange: (hosts) => seen.push(hosts), onError: () => undefined });
    expect(seen).toEqual([]);
    await flush();
    expect(seen).toEqual([[]]);
    const handlers = { onPeer: () => undefined, onMessage: () => undefined, onPeerGone: () => undefined, onError: () => undefined };
    const a = await net.createAdapter().startHost({ name: 'A', txt: { v: '1' } }, handlers);
    const b = await net.createAdapter().startHost({ name: 'B' }, handlers);
    await flush();
    expect(seen[seen.length - 1]).toEqual([
      { name: 'A', host: '10.0.0.2', port: a.port, txt: { v: '1' } },
      { name: 'B', host: '10.0.0.3', port: b.port, txt: {} },
    ]);
    await a.stop();
    expect(seen[seen.length - 1].map((h) => h.name)).toEqual(['B']);
    net.discoveryEnabled = false;
    net.refreshDiscovery();
    expect(seen[seen.length - 1]).toEqual([]);
    stop();
    const count = seen.length;
    await b.stop();
    expect(seen).toHaveLength(count);
  });
});
