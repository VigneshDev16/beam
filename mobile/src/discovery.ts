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

/**
 * Scan the /24 subnet for Beam receivers: laptops on 8790, phones on 8791.
 * Calls onFound as devices appear; resolves when the sweep completes.
 */
export async function scanForDevices(
  onFound: (d: BeamDevice) => void,
): Promise<BeamDevice[]> {
  const myIp = await getWifiIp();
  if (!myIp) throw new Error('not-on-wifi');

  const prefix = myIp.substring(0, myIp.lastIndexOf('.'));
  const targets: Array<{ ip: string; port: number }> = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${prefix}.${i}`;
    if (ip === myIp) continue;
    targets.push({ ip, port: LAPTOP_PORT });
    targets.push({ ip, port: PHONE_PORT });
  }

  const found: BeamDevice[] = [];
  const CONCURRENCY = 48;
  let next = 0;

  async function worker() {
    while (next < targets.length) {
      const t = targets[next++];
      const device = await probe(t.ip, t.port, 900);
      if (device) {
        found.push(device);
        onFound(device);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return found;
}
