/**
 * Desktop -> phone over Wi-Fi: find phones running Beam's receiver and upload
 * to them. Mirrors the discovery the mobile app does (a /24 sweep of /info),
 * so no mDNS dependency on any platform.
 */

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
async function sendFiles(device, localPaths, onEvent) {
  const sent = [];
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
        )}`,
        { method: 'POST', body: form }
      );
      if (!res.ok) throw new Error(`Phone returned ${res.status}`);
      sent.push(name);
      onEvent({ type: 'done', name, index: i });
    } catch (e) {
      onEvent({ type: 'error', name, message: e.message, index: i });
    }
  }
  return sent;
}

module.exports = { scanForPhones, sendFiles, LAPTOP_PORT, PHONE_PORT };
