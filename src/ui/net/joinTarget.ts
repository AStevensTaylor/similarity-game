/** Pure helpers for the Wi-Fi screens: manual-join validation and error wording. No React. */

export interface JoinTargetValidation {
  ok: boolean;
  hostError: string | null;
  portError: string | null;
  /** Only meaningful when ok. */
  target: { host: string; port: number };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** A dotted IPv4 address with every part in 0-255 (the host listens on IPv4 only). */
export function isIpv4Address(text: string): boolean {
  const match = IPV4.exec(text);
  return match !== null && match.slice(1).every((part) => Number(part) <= 255);
}

/**
 * Validates the manual-join fields. The address must be an IPv4 address and
 * the port a whole number from 1 to 65535. "192.168.1.20:40123" pasted into
 * the address field is accepted when the port field is empty.
 */
export function validateJoinTarget(hostInput: string, portInput: string): JoinTargetValidation {
  let host = hostInput.trim();
  let portText = portInput.trim();
  const combined = /^([^:\s]+):(\d+)$/.exec(host);
  if (combined && portText.length === 0) {
    host = combined[1];
    portText = combined[2];
  }

  let hostError: string | null = null;
  if (host.length === 0) hostError = "Enter the host's IP address.";
  else if (!isIpv4Address(host)) hostError = 'Use an address like 192.168.1.20 (four numbers from 0 to 255).';

  let portError: string | null = null;
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (portText.length === 0) portError = 'Enter the port shown on the host.';
  else if (!Number.isInteger(port) || port < 1 || port > 65535) portError = 'The port is a number from 1 to 65535.';

  const ok = hostError === null && portError === null;
  return { ok, hostError, portError, target: { host, port: ok ? port : 0 } };
}

export function errorText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  if (typeof e === 'object' && e !== null) {
    try {
      const text = JSON.stringify(e);
      if (text && text !== '{}') return text.slice(0, 200);
    } catch {
      // fall through
    }
  }
  return 'unknown error';
}

/**
 * True when an error from discovery, hosting or connecting reads like the
 * system refusing local-network access: the iOS Bonjour "policy denied" /
 * "missing configuration" codes, or wording to that effect.
 */
export function looksLikePermissionDenial(text: string | null | undefined): boolean {
  if (!text) return false;
  return /-72008|-65555|-65570|polic|denied|permission|not authori[sz]ed|unauthori[sz]ed|prohibited|not permitted|no route to host|EPERM|EACCES/i.test(
    text,
  );
}

/** What to tell the player to do when local-network access seems to be blocked. */
export function permissionHelp(platform: string): string {
  if (platform === 'ios') {
    return 'It looks like this iPhone is blocking local network access for the app. Open Settings > Privacy & Security > Local Network, turn on Similarity Game, then come back and try again.';
  }
  if (platform === 'android') {
    return 'It looks like Android is blocking network access for the app. Check that Wi-Fi is on, that the app may use the network, and that no VPN or "private DNS" app is intercepting local traffic, then try again.';
  }
  return 'It looks like this device is blocking local network access for the app. Allow it in the system settings and try again.';
}
