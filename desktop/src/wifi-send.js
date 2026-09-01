/**
 * Desktop -> phone over Wi-Fi: find phones running Beam's receiver and upload
 * to them. Mirrors the discovery the mobile app does (a /24 sweep of /info),
 * so no mDNS dependency on any platform.
 */

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

/** Find phones (8791) on every local subnet. Skips this machine's own port. */
async function scanForPhones() {
  const subnets = localSubnets();
  if (!subnets.length) return { devices: [], error: 'not-on-network' };

  const targets = [];
  for (const net of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${net.prefix}.${i}`;
      if (ip === net.ip) continue;
      targets.push({ ip, port: PHONE_PORT });
    }
  }

  const found = [];
  const seen = new Set();
  let next = 0;
  const CONCURRENCY = 64;

  async function worker() {
    while (next < targets.length) {
      const t = targets[next++];
      const device = await probe(t.ip, t.port);
      const key = device && `${device.ip}:${device.port}`;
      if (device && !seen.has(key)) {
        seen.add(key);
        found.push(device);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { devices: found, error: null };
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
async function requestApproval(device, localPaths, userDataDir, onEvent) {
  const files = localPaths.map((p) => {
    let size = null;
    try {
      size = fs.statSync(p).size;
    } catch {
      /* unreadable size is not fatal */
    }
    return { name: path.basename(p), size };
  });

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
async function sendFiles(device, localPaths, onEvent, userDataDir) {
  const sent = [];
  const token = userDataDir
    ? await requestApproval(device, localPaths, userDataDir, onEvent)
    : null;
  const query = token ? `&token=${encodeURIComponent(token)}` : '';
  for (let i = 0; i < localPaths.length; i++) {
    const local = localPaths[i];
    const name = path.basename(local);
    onEvent({ type: 'start', name, index: i, total: localPaths.length });
    try {
      if (fs.statSync(local).isDirectory()) {
        throw new Error('Folders are not supported yet — drop individual files.');
      }
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
      onEvent({ type: 'done', name, index: i });
    } catch (e) {
      onEvent({ type: 'error', name, message: e.message, index: i });
    }
  }
  return sent;
}

module.exports = { scanForPhones, sendFiles, deviceId, LAPTOP_PORT, PHONE_PORT };
