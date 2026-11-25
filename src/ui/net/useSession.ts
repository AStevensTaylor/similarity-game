import { useSyncExternalStore } from 'react';

import type { ClientSession, ClientSnapshot, HostSession, HostSnapshot } from '../../net';

/** The client session's latest snapshot; re-renders on every change. */
export function useClientSnapshot(client: ClientSession): ClientSnapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}

export function useHostSnapshot(host: HostSession): HostSnapshot {
  return useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
}
