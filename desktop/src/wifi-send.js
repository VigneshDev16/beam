/**
 * Desktop -> phone over Wi-Fi: find phones running Beam's receiver and upload
 * to them. Discovery is a /24 sweep of /info, so there's no mDNS dependency on
 * any platform -- but the sweep is done in two passes so it doesn't feel like
 * one: addresses we already have a reason to care about (a phone we've used
 * before, anything in the ARP table) are probed first and usually answer in
 * well under a second.
 */

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LAPTOP_PORT = 8790;
const PHONE_PORT = 8791;

function localSubnets() {
  const nets = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        nets.push({ ip: iface.address, prefix: iface.address.replace(/\.\d+$/, '') });
      }
    }
  }
  return nets;
}

async function probe(ip, port, timeoutMs = 700) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${port}/info`, { signal: controller.signal });
    const json = await res.json();
    if (json && json.app === 'beam') {
      return {
        ip,
        port,
        name: json.name || ip,
        platform: json.platform || '',
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Addresses this Mac has recently exchanged packets with. On a home network
 * that's a handful of hosts, and the phone is almost always one of them --
 * which is what makes the first pass fast. Absolute path: a bundled app
 * launched from Finder has a minimal PATH.
 */
function arpNeighbours() {
  return new Promise((resolve) => {
    execFile('/usr/sbin/arp', ['-an'], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve([]);
      const ips = new Set();
      for (const m of String(stdout).matchAll(/\((\d+\.\d+\.\d+\.\d+)\)/g)) {
        ips.add(m[1]);
      }
      resolve([...ips]);
    });
  });
}

async function sweep(ips, port, timeoutMs, concurrency, collect) {
  let next = 0;
  async function worker() {
    while (next < ips.length) {
      const device = await probe(ips[next++], port, timeoutMs);
      if (device) collect(device);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, ips.length) || 1 }, worker)
  );
}

/**
 * Find phones (8791) on every local subnet, calling onFound as each one
 * answers so the UI can fill in before the sweep finishes. `hints` are
 * addresses to try first -- typically the last-known IPs of known devices.
 */
async function scanForPhones({ hints = [], onFound = () => {} } = {}) {
  const subnets = localSubnets();
  if (!subnets.length) return { devices: [], error: 'not-on-network' };

  const mine = new Set(subnets.map((n) => n.ip));
  const local = (ip) => subnets.some((n) => ip.startsWith(`${n.prefix}.`));

  const first = [...new Set([...hints, ...(await arpNeighbours())])].filter(
    (ip) => local(ip) && !mine.has(ip)
  );
  const firstSet = new Set(first);
  const rest = [];
  for (const net of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${net.prefix}.${i}`;
      if (!mine.has(ip) && !firstSet.has(ip)) rest.push(ip);
    }
  }

  const found = [];
  const seen = new Set();
  const collect = (device) => {
    const key = `${device.ip}:${device.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(device);
    onFound(device);
  };

  // Known hosts get a generous timeout; the blind sweep gets a short one,
  // because an address that isn't answering isn't going to start.
  await sweep(first, PHONE_PORT, 1200, 32, collect);
  await sweep(rest, PHONE_PORT, 400, 64, collect);
  return { devices: found, error: null };
}

/**
 * Add a device by address, for when discovery can't see it -- guest Wi-Fi with
 * client isolation, a /16, two subnets bridged by a router. Tries the phone
 * port first, then the laptop one.
 */
async function connectTo(address) {
  const [host, explicitPort] = String(address).trim().split(':');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { device: null, error: 'That does not look like an IP address.' };
  }
  const ports = explicitPort ? [Number(explicitPort)] : [PHONE_PORT, LAPTOP_PORT];
  for (const port of ports) {
    const device = await probe(host, port, 2500);
    if (device) return { device, error: null };
  }
  return { device: null, error: `Nothing running Beam answered at ${host}.` };
}

/**
 * A stable id for this machine, so a receiver that trusts us once can keep
 * trusting us. Stored next to the app's other data.
 */
let cachedDeviceId = null;
function deviceId(userDataDir) {
  if (cachedDeviceId) return cachedDeviceId;
  const file = path.join(userDataDir, 'device-id');
  try {
    cachedDeviceId = fs.readFileSync(file, 'utf8').trim();
  } catch {
    cachedDeviceId = crypto.randomUUID();
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(file, cachedDeviceId);
    } catch {
      /* falling back to a per-run id just means we get asked again */
    }
  }
  return cachedDeviceId;
}

/**
 * Ask the receiver for permission before sending anything.
 * Resolves to a token, or null if the receiver is too old to support offers
 * (in which case it will prompt its user when the upload arrives instead).
 */
/**
 * Dropping a folder should send what's in it, so directories are walked into
 * their files. Names keep the relative path ("holiday/day1.jpg") -- receivers
 * flatten it, but it keeps the file list readable in the approval prompt.
 */
function statSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

function expandPaths(localPaths) {
  const files = [];
  const walk = (target, prefix) => {
    let st;
    try {
      st = fs.statSync(target);
    } catch {
      return;
    }
    if (!st.isDirectory()) return files.push({ path: target, name: prefix });
    for (const child of fs.readdirSync(target)) {
      walk(path.join(target, child), `${prefix}/${child}`);
    }
  };
  for (const p of localPaths) walk(p, path.basename(p));
  return files;
}

async function requestApproval(device, entries, userDataDir, onEvent) {
  const files = entries.map((e) => ({ name: e.name, size: e.size }));

  let offer;
  try {
    const res = await fetch(`http://${device.ip}:${device.port}/offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: os.hostname().replace(/\.local$/, ''),
        deviceId: deviceId(userDataDir),
        platform: process.platform,
        files,
      }),
    });
    if (res.status === 404) return null; // older receiver
    if (!res.ok) throw new Error(`offer rejected (${res.status})`);
    offer = await res.json();
  } catch (e) {
    if (e instanceof TypeError) throw e; // network failure, surface it
    return null;
  }

  if (offer.status === 'accepted' && offer.token) return offer.token;

  onEvent({ type: 'awaiting-approval', code: offer.code, device: device.name });

  // Poll until the person on the other end answers.
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`http://${device.ip}:${device.port}/offer/${offer.id}`);
    const state = await res.json();
    if (state.status === 'accepted') return state.token;
    if (state.status === 'declined') throw new Error(`${device.name} declined the transfer`);
    if (state.status === 'expired') break;
  }
  throw new Error(`${device.name} did not respond to the request`);
}

async function fileBlob(filePath) {
  // Streams from disk when available so big files don't sit in memory.
  if (typeof fs.openAsBlob === 'function') {
    try {
      return await fs.openAsBlob(filePath);
    } catch {
      /* fall through */
    }
  }
  return new Blob([fs.readFileSync(filePath)]);
}

/**
 * Upload local files to a phone's Beam receiver.
 * onEvent gets {type:'start'|'done'|'error', name, index, total}.
 */
/**
 * Send files (and the contents of any dropped folders) to one device.
 * Returns what made it and what didn't, so the UI can offer a retry of just
 * the failures instead of the whole batch.
 */
async function sendFiles(device, localPaths, onEvent, userDataDir) {
  const entries = expandPaths(localPaths).map((e) => ({
    ...e,
    size: statSize(e.path),
  }));
  const totalBytes = entries.reduce((sum, e) => sum + (e.size || 0), 0);

  const sent = [];
  const failed = [];
  const token = userDataDir
    ? await requestApproval(device, entries, userDataDir, onEvent)
    : null;
  const query = token ? `&token=${encodeURIComponent(token)}` : '';
  let doneBytes = 0;

  for (let i = 0; i < entries.length; i++) {
    const { path: local, name, size } = entries[i];
    onEvent({ type: 'start', name, index: i, total: entries.length });
    try {
      const form = new FormData();
      form.append(`file${i}`, await fileBlob(local), name);

      const res = await fetch(
        `http://${device.ip}:${device.port}/upload?from=${encodeURIComponent(
          os.hostname().replace(/\.local$/, '')
        )}${query}`,
        { method: 'POST', body: form }
      );
      if (res.status === 403) throw new Error('The other device declined the transfer');
      if (!res.ok) throw new Error(`Phone returned ${res.status}`);
      sent.push(name);
      doneBytes += size || 0;
      onEvent({
        type: 'done',
        name,
        index: i,
        size,
        pct: totalBytes ? (doneBytes / totalBytes) * 100 : null,
      });
    } catch (e) {
      failed.push({ path: local, name, message: e.message });
      onEvent({ type: 'error', name, message: e.message, index: i });
    }
  }
  return { sent, failed };
}

module.exports = {
  scanForPhones,
  connectTo,
  sendFiles,
  deviceId,
  LAPTOP_PORT,
  PHONE_PORT,
};
