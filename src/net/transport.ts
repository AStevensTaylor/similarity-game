/**
 * The transport contract between the session layer (hostSession / clientSession)
 * and a concrete network (lanAdapter on devices, memoryAdapter in tests).
 *
 * Transports deal in already-parsed JSON objects. Framing (newline-delimited
 * JSON, 64 KB line limit) is the adapter's job; the sessions validate every
 * object they receive (see protocol.ts) and never trust its contents.
 */

export type Json = Record<string, unknown>;

export interface HostTransport {
  readonly port: number;
  readonly serviceName: string;
  broadcast(msg: Json): void;
  sendTo(peerId: number, msg: Json): void;
  dropPeer(peerId: number): void;
  stop(): Promise<void>;
}

/**
 * `code` of the error a host transport passes to onError when its listener has
 * died for good: connected peers may still work, but nobody can connect or
 * reconnect any more. Every other onError is informational.
 */
export const LISTENER_CLOSED = 'LISTENER_CLOSED';

export interface HostTransportHandlers {
  onPeer(peerId: number, remoteAddress?: string): void;
  onMessage(peerId: number, msg: Json): void;
  onPeerGone(peerId: number): void;
  onError(e: unknown): void;
}

export interface ClientTransport {
  send(msg: Json): boolean;
  close(): void;
}

export interface ClientTransportHandlers {
  onOpen(): void;
  onMessage(msg: Json): void;
  onClose(reason: 'closed' | 'error' | 'timeout'): void;
}

export interface FoundHost {
  name: string;
  host: string;
  port: number;
  txt: Record<string, string>;
}

export interface NetworkAdapter {
  startHost(opts: { name: string; txt?: Record<string, string> }, handlers: HostTransportHandlers): Promise<HostTransport>;
  connect(target: { host: string; port: number }, handlers: ClientTransportHandlers): ClientTransport;
  browse(
    handlers: { onChange(hosts: FoundHost[]): void; onError(e: unknown): void },
    opts?: { useEmbeddedMdns?: boolean },
  ): () => void;
  getLocalAddress(): Promise<string | null>;
}
