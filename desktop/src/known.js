/**
 * Two small on-disk lists in userData:
 *
 *   known-devices.json — phones we've seen before, so the sidebar can show them
 *                        the moment the app opens and the scan can probe their
 *                        last address first instead of sweeping the subnet.
 *   history.json       — what was sent and received, newest first.
 *
 * Both are best-effort: a corrupt or missing file just means an empty list.
 */

const fs = require('fs');
const path = require('path');

const MAX_DEVICES = 16;
const MAX_HISTORY = 300;

function read(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function write(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch {
    /* losing the list is not worth failing a transfer over */
  }
}

const devicesFile = (dir) => path.join(dir, 'known-devices.json');
const historyFile = (dir) => path.join(dir, 'history.json');

/** Phones move between addresses, so identity is the name, not the IP. */
function keyFor(device) {
  return `${String(device.name || '').toLowerCase()}|${device.platform || ''}`;
}

/** Newest first. */
function known(dir) {
  return read(devicesFile(dir), []).sort((a, b) => b.lastSeen - a.lastSeen);
}

function remember(dir, device) {
  if (!device || !device.ip) return;
  const key = keyFor(device);
  const list = read(devicesFile(dir), []).filter((d) => d.key !== key);
  list.unshift({
    key,
    name: device.name || device.ip,
    platform: device.platform || '',
    ip: device.ip,
    port: device.port,
    lastSeen: Date.now(),
  });
  write(devicesFile(dir), list.slice(0, MAX_DEVICES));
}

function forget(dir, key) {
  write(
    devicesFile(dir),
    read(devicesFile(dir), []).filter((d) => d.key !== key)
  );
}

function history(dir) {
  return read(historyFile(dir), []);
}

/** entry: { direction: 'sent'|'received', name, size, peer, path? } */
function record(dir, entry) {
  if (!entry || !entry.name) return;
  const list = read(historyFile(dir), []);
  list.unshift({ at: Date.now(), ...entry });
  write(historyFile(dir), list.slice(0, MAX_HISTORY));
}

function clearHistory(dir) {
  write(historyFile(dir), []);
}

module.exports = { known, remember, forget, history, record, clearHistory };
