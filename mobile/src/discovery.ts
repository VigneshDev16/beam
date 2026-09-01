import NetInfo from '@react-native-community/netinfo';

export const LAPTOP_PORT = 8790;
export const PHONE_PORT = 8791;

export interface BeamDevice {
  ip: string;
  port: number;
  name: string;
  platform: string;
}

export function deviceKey(d: BeamDevice): string {
  return `${d.ip}:${d.port}`;
}

export function isPhone(d: BeamDevice): boolean {
  return d.platform === 'ios' || d.platform === 'android';
}

async function probe(
  ip: string,
  port: number,
  timeoutMs: number,
): Promise<BeamDevice | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${port}/info`, {
      signal: controller.signal,
    });
    const json = await res.json();
    if (json && json.app === 'beam') {
      return { ip, port, name: json.name || ip, platform: json.platform || '' };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getWifiIp(): Promise<string | null> {
  const state = await NetInfo.fetch();
  const details: any = state.details;
  const ip: string | undefined = details?.ipAddress;
  if (state.type === 'wifi' && ip && ip.includes('.')) return ip;
  return null;
}

/** Ask one address directly — used for manual "connect by IP" and wake-ups. */
export async function probeAddress(
  address: string,
): Promise<{ device: BeamDevice | null; error: string | null }> {
  const [host, explicitPort] = address.trim().split(':');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { device: null, error: 'That does not look like an IP address.' };
  }
  const ports = explicitPort
    ? [Number(explicitPort)]
    : [LAPTOP_PORT, PHONE_PORT];
  for (const port of ports) {
    const device = await probe(host, port, 2500);
    if (device) return { device, error: null };
  }
  return { device: null, error: `Nothing running Beam answered at ${host}.` };
}

async function sweep(
  targets: Array<{ ip: string; port: number }>,
  timeoutMs: number,
  concurrency: number,
  collect: (d: BeamDevice) => void,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const t = targets[next++];
      const device = await probe(t.ip, t.port, timeoutMs);
      if (device) collect(device);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) || 1 }, worker),
  );
}

/**
 * Scan the /24 subnet for Beam receivers: laptops on 8790, phones on 8791.
 * Addresses in `hints` (typically the last-known address of a device we've
 * used before) go first with a generous timeout, so the common case answers
 * in well under a second; the blind sweep that follows uses a short one,
 * because an address that isn't answering isn't about to start.
 *
 * Calls onFound as devices appear; resolves when the sweep completes.
 */
export async function scanForDevices(
  onFound: (d: BeamDevice) => void,
  hints: string[] = [],
): Promise<BeamDevice[]> {
  const myIp = await getWifiIp();
  if (!myIp) throw new Error('not-on-wifi');

  const prefix = myIp.substring(0, myIp.lastIndexOf('.'));
  const inSubnet = (ip: string) => ip.startsWith(`${prefix}.`) && ip !== myIp;

  const first: Array<{ ip: string; port: number }> = [];
  for (const ip of [...new Set(hints)].filter(inSubnet)) {
    first.push({ ip, port: LAPTOP_PORT }, { ip, port: PHONE_PORT });
  }
  const hinted = new Set(first.map((t) => t.ip));

  const rest: Array<{ ip: string; port: number }> = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${prefix}.${i}`;
    if (ip === myIp || hinted.has(ip)) continue;
    rest.push({ ip, port: LAPTOP_PORT }, { ip, port: PHONE_PORT });
  }

  const found: BeamDevice[] = [];
  const seen = new Set<string>();
  const collect = (device: BeamDevice) => {
    const key = deviceKey(device);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(device);
    onFound(device);
  };

  await sweep(first, 1500, 16, collect);
  await sweep(rest, 700, 48, collect);
  return found;
}
