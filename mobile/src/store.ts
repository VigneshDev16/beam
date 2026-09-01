/**
 * Two small lists kept in the native key/value store:
 *
 *   devices — phones and laptops we've seen, so they can be offered straight
 *             away and their last address probed before the subnet sweep
 *   history — what was sent and received, newest first
 *
 * Best-effort throughout: a missing or unreadable value is an empty list.
 */

import { NativeModules } from 'react-native';
import { BeamDevice } from './discovery';

const { BeamReceiver } = NativeModules;

const MAX_DEVICES = 16;
const MAX_HISTORY = 300;

export interface KnownDevice {
  key: string;
  name: string;
  platform: string;
  ip: string;
  port: number;
  lastSeen: number;
}

export interface HistoryEntry {
  at: number;
  direction: 'sent' | 'received';
  name: string;
  size: number | null;
  peer: string;
}

/**
 * Every write is read-modify-write, and three files arriving at once really
 * does interleave: two reads see the same list and the last write wins, so an
 * entry vanishes. Everything that mutates goes through this queue.
 */
let tail: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => undefined);
  return next;
}

async function read<T>(key: string): Promise<T[]> {
  try {
    const raw = await BeamReceiver.getStore(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function write<T>(key: string, value: T[]): Promise<void> {
  try {
    await BeamReceiver.setStore(key, JSON.stringify(value));
  } catch {
    /* losing the list is not worth failing a transfer over */
  }
}

/** Devices move between addresses, so identity is the name, not the IP. */
const keyFor = (d: { name: string; platform: string }) =>
  `${(d.name || '').toLowerCase()}|${d.platform || ''}`;

export async function knownDevices(): Promise<KnownDevice[]> {
  const list = await read<KnownDevice>('devices');
  return list.sort((a, b) => b.lastSeen - a.lastSeen);
}

export async function rememberDevice(device: BeamDevice): Promise<void> {
  if (!device?.ip) return;
  return serial(async () => {
    const key = keyFor(device);
    const list = (await read<KnownDevice>('devices')).filter(
      (d) => d.key !== key,
    );
    list.unshift({
      key,
      name: device.name || device.ip,
      platform: device.platform || '',
      ip: device.ip,
      port: device.port,
      lastSeen: Date.now(),
    });
    await write('devices', list.slice(0, MAX_DEVICES));
  });
}

export async function forgetDevice(key: string): Promise<void> {
  return serial(async () => {
    const list = await read<KnownDevice>('devices');
    await write(
      'devices',
      list.filter((d) => d.key !== key),
    );
  });
}

export async function history(): Promise<HistoryEntry[]> {
  return read<HistoryEntry>('history');
}

export async function recordTransfer(
  entry: Omit<HistoryEntry, 'at'>,
): Promise<void> {
  if (!entry?.name) return;
  return serial(async () => {
    const list = await read<HistoryEntry>('history');
    list.unshift({ at: Date.now(), ...entry });
    await write('history', list.slice(0, MAX_HISTORY));
  });
}

export async function clearHistory(): Promise<void> {
  return serial(() => write('history', []));
}
