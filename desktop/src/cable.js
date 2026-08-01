/**
 * Cable transfer: read files off a USB-connected phone.
 *
 * Two backends, because macOS speaks neither natively:
 *   - "mtp": libmtp CLI tools. Works with any Android in "File transfer" mode,
 *     no setup on the phone. This is what Android File Transfer used to do.
 *   - "adb": Android platform-tools. Needs USB debugging enabled once, but is
 *     faster, gives byte-level progress, and works with emulators.
 *
 * iPhones are deliberately absent: iOS exposes no MTP or filesystem over USB.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAVE_DIR = path.join(os.homedir(), 'Downloads', 'Beam');
const ADB_DEFAULT_PATH = '/sdcard';

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function findAdb() {
  return firstExisting([
    process.env.BEAM_ADB_PATH,
    path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
  ]);
}

function findMtpTool(name) {
  return firstExisting([
    path.join('/opt/homebrew/bin', name),
    path.join('/usr/local/bin', name),
    path.join('/usr/bin', name),
  ]);
}

function mtpTools() {
  const detect = findMtpTool('mtp-detect');
  const files = findMtpTool('mtp-files');
  const getfile = findMtpTool('mtp-getfile');
  return detect && files && getfile ? { detect, files, getfile } : null;
}

function run(cmd, args, { timeout = 30000, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) reject(new Error(stderr || err.message));
        else resolve({ stdout: stdout || '', stderr: stderr || '' });
      }
    );
    if (onStdout) {
      child.stdout?.on('data', (d) => onStdout(String(d)));
      child.stderr?.on('data', (d) => onStdout(String(d)));
    }
  });
}

/** Quote a path for the phone-side shell that `adb shell` pipes into. */
function shQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return candidate;
}

// ---------------------------------------------------------------- adb backend

function parseAdbDevices(stdout) {
  const devices = [];
  for (const line of stdout.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, state, ...rest] = trimmed.split(/\s+/);
    if (!id || !state) continue;
    const props = {};
    for (const token of rest) {
      const [k, v] = token.split(':');
      if (k && v) props[k] = v;
    }
    devices.push({
      backend: 'adb',
      id,
      name: props.model ? props.model.replace(/_/g, ' ') : id,
      state,
      // Anything but "device" means we can see it but can't read it yet.
      note:
        state === 'unauthorized'
          ? 'Unlock the phone and tap "Allow USB debugging"'
          : state === 'offline'
          ? 'Device is offline — reconnect the cable'
          : null,
    });
  }
  return devices;
}

/** Parse one `ls -lA` line from Android's toybox. */
function parseLsLine(line) {
  if (!line.trim() || /^total\s/.test(line)) return null;
  // perms links owner group size date time name
  const m = line.match(
    /^([bcdlps-][rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.*)$/
  );
  if (!m) return null;
  const [, perms, size, rawName] = m;
  // Symlinks render as "name -> target"; keep the name side.
  const name = perms.startsWith('l') ? rawName.split(' -> ')[0] : rawName;
  if (!name || name === '.' || name === '..') return null;
  return {
    name,
    isDir: perms.startsWith('d'),
    size: perms.startsWith('d') ? null : Number(size),
  };
}

async function adbListDir(adb, deviceId, dirPath) {
  const { stdout } = await run(adb, [
    '-s',
    deviceId,
    'shell',
    // -L dereferences symlinks, so linked folders (/sdcard itself) list as dirs
    `ls -lAL ${shQuote(dirPath)} 2>/dev/null`,
  ]);
  const entries = stdout
    .split('\n')
    .map(parseLsLine)
    .filter(Boolean)
    .map((e) => ({ ...e, path: path.posix.join(dirPath, e.name) }));
  entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
  );
  return entries;
}

async function adbPull(adb, deviceId, remotePath, destPath, onProgress) {
  await run(adb, ['-s', deviceId, 'pull', remotePath, destPath], {
    timeout: 30 * 60 * 1000,
    onStdout: (chunk) => {
      const m = chunk.match(/\[\s*(\d+)%\]/);
      if (m) onProgress(Number(m[1]));
    },
  });
}

async function adbPush(adb, deviceId, localPath, remotePath, onProgress) {
  const { stdout, stderr } = await run(
    adb,
    ['-s', deviceId, 'push', localPath, remotePath],
    {
      timeout: 30 * 60 * 1000,
      onStdout: (chunk) => {
        const m = chunk.match(/\[\s*(\d+)%\]/);
        if (m) onProgress(Number(m[1]));
      },
    }
  );
  // adb push reports permission problems on stdout and still exits 0.
  const text = `${stdout}\n${stderr}`;
  if (/failed to copy|Permission denied|Read-only file system/i.test(text)) {
    throw new Error(
      /Permission denied|Read-only/i.test(text)
        ? 'The phone would not accept a file in this folder. Try /sdcard/Download.'
        : text.trim().split('\n')[0]
    );
  }
}

// ---------------------------------------------------------------- MTP backend

/**
 * libmtp's `mtp-files` prints a record per object. Folders come through with a
 * "Folder" filetype, so one listing gives us the whole tree.
 */
function parseMtpFiles(stdout) {
  const objects = [];
  let cur = null;
  const push = () => {
    if (cur && cur.id != null && cur.name) objects.push(cur);
    cur = null;
  };
  for (const line of stdout.split('\n')) {
    const idMatch = line.match(/^File ID:\s*(\d+)/i);
    if (idMatch) {
      push();
      cur = { id: Number(idMatch[1]), parentId: 0, size: null, isDir: false };
      continue;
    }
    if (!cur) continue;
    const name = line.match(/^\s*Filename:\s*(.+?)\s*$/i);
    if (name) cur.name = name[1];
    const size = line.match(/^\s*File size\s+(\d+)/i);
    if (size) cur.size = Number(size[1]);
    const parent = line.match(/^\s*Parent ID:\s*(\d+)/i);
    if (parent) cur.parentId = Number(parent[1]);
    const type = line.match(/^\s*Filetype:\s*(.+?)\s*$/i);
    if (type && /folder/i.test(type[1])) cur.isDir = true;
  }
  push();
  return objects;
}

/**
 * libmtp can see a device but still fail to open it. On macOS that is the norm
 * rather than the exception: phones whose MTP interface is USB class 6
 * (Still Image / PTP) get claimed by Apple's ImageCapture daemons, and libusb
 * cannot detach a kernel driver on macOS, so claiming returns ACCESS (-3).
 */
function mtpBlockedReason(text) {
  if (/LIBMTP PANIC|Unable to open raw device/i.test(text)) {
    if (/claim_interface\(\)\s*=\s*-3|LIBUSB_ERROR_ACCESS/i.test(text)) {
      return 'macOS is holding this phone (Image Capture claims its MTP port). Enable USB debugging on the phone to use it over cable, or send over Wi-Fi.';
    }
    return 'libmtp found this phone but could not open it. Unplug and replug, unlock the phone, and re-pick "File transfer".';
  }
  return null;
}

// One listing serves the whole browsing session; re-fetched on refresh.
let mtpCache = null;

async function mtpLoadTree(tools, { force = false } = {}) {
  if (mtpCache && !force) return mtpCache;
  const { stdout, stderr } = await run(tools.files, [], { timeout: 120000 });
  const objects = parseMtpFiles(stdout);
  if (!objects.length) {
    // An empty listing and a failed one look identical unless we check.
    const blocked = mtpBlockedReason(`${stdout}\n${stderr}`);
    if (blocked) throw new Error(blocked);
  }
  mtpCache = objects;
  return mtpCache;
}

async function mtpListDir(tools, dirId) {
  const objects = await mtpLoadTree(tools);
  const parent = Number(dirId || 0);
  const entries = objects
    .filter((o) => o.parentId === parent)
    .map((o) => ({
      name: o.name,
      path: String(o.id),
      isDir: o.isDir,
      size: o.isDir ? null : o.size,
    }));
  entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
  );
  return entries;
}

async function mtpDetectDevices(tools) {
  const { stdout, stderr } = await run(tools.detect, [], { timeout: 60000 });
  const text = `${stdout}\n${stderr}`;
  const blocked = mtpBlockedReason(text);
  const devices = [];
  // e.g. "Device 0 (VID=18d1 and PID=4ee1) is a Google Inc Nexus/Pixel (MTP)."
  const re = /Device\s+(\d+)\s+\(VID=[^)]*\)\s+is a\s+(.+?)\.?$/gim;
  let m;
  while ((m = re.exec(text))) {
    devices.push({
      backend: 'mtp',
      id: `mtp:${m[1]}`,
      name: m[2].trim(),
      // Seeing a device is not the same as being able to read it.
      state: blocked ? 'blocked' : 'device',
      note: blocked,
    });
  }
  if (!devices.length && /No raw devices found/i.test(text)) return [];
  return devices;
}

// -------------------------------------------------- USB presence (macOS only)

const ANDROID_USB_VENDORS = new Set([
  0x04e8, // Samsung
  0x18d1, // Google
  0x2717, // Xiaomi
  0x2a70, // OnePlus
  0x22d9, // Oppo / Realme
  0x2d95, // vivo
  0x22b8, // Motorola
  0x12d1, // Huawei
  0x1004, // LG
  0x0fce, // Sony
  0x0bb4, // HTC
  0x0b05, // Asus
  0x19d2, // ZTE
  0x0e8d, // MediaTek
  0x17ef, // Lenovo
]);
const APPLE_USB_VENDOR = 0x05ac;

/**
 * What the Mac can see on USB, regardless of whether any backend can open it.
 * Lets us tell "no phone plugged in" apart from "plugged in but unreachable".
 */
async function usbPhones() {
  if (process.platform !== 'darwin') return [];
  let stdout = '';
  try {
    ({ stdout } = await run('/usr/sbin/ioreg', ['-r', '-c', 'IOUSBHostDevice', '-l', '-w0'], {
      timeout: 15000,
    }));
  } catch {
    return [];
  }

  const phones = [];
  for (const block of stdout.split(/^\+-o /m).slice(1)) {
    const vendorId = Number(block.match(/"idVendor"\s*=\s*(\d+)/)?.[1] ?? NaN);
    const product = block.match(/"USB Product Name"\s*=\s*"([^"]*)"/)?.[1];
    const vendor = block.match(/"USB Vendor Name"\s*=\s*"([^"]*)"/)?.[1];
    if (!Number.isFinite(vendorId)) continue;

    const isApple = vendorId === APPLE_USB_VENDOR;
    const isAndroid =
      ANDROID_USB_VENDORS.has(vendorId) || /android/i.test(product ?? '');
    if (!isAndroid && !(isApple && /iphone|ipad/i.test(product ?? ''))) continue;

    phones.push({
      vendorId,
      isApple,
      name: [vendor, product].filter(Boolean).join(' ').replace(/_/g, ' ') ||
        'USB device',
    });
  }
  return phones;
}

async function mtpGetFile(tools, fileId, destPath, onProgress) {
  await run(tools.getfile, [String(fileId), destPath], {
    timeout: 30 * 60 * 1000,
    onStdout: (chunk) => {
      const m = chunk.match(/(\d+)%/);
      if (m) onProgress(Number(m[1]));
    },
  });
}

// ------------------------------------------------------------------ public API

function toolStatus() {
  const adb = findAdb();
  const mtp = mtpTools();
  return {
    adb: !!adb,
    mtp: !!mtp,
    hint: !adb && !mtp ? 'Install libmtp (brew install libmtp) to read phones over USB.' : null,
  };
}

async function listDevices() {
  const found = [];
  const errors = [];

  const adb = findAdb();
  if (adb) {
    try {
      const { stdout } = await run(adb, ['devices', '-l'], { timeout: 10000 });
      found.push(...parseAdbDevices(stdout));
    } catch (e) {
      errors.push(`adb: ${e.message}`);
    }
  }

  const tools = mtpTools();
  if (tools) {
    try {
      found.push(...(await mtpDetectDevices(tools)));
    } catch (e) {
      errors.push(`mtp: ${e.message}`);
    }
  }

  // A real phone reachable over adb (an emulator doesn't count as plugged in).
  const haveUsablePhone = found.some(
    (d) => d.state === 'device' && !(d.backend === 'adb' && /^emulator-/.test(d.id))
  );

  // Nothing usable? Say what the Mac can actually see, so "no devices" never
  // means "your cable is fine but we're not telling you anything".
  if (!haveUsablePhone) {
    for (const phone of await usbPhones()) {
      const alreadyNamed = found.some((d) =>
        phone.name.toLowerCase().includes(d.name.split(' ')[0].toLowerCase())
      );
      if (phone.isApple) {
        found.push({
          backend: 'none',
          id: `usb:${phone.vendorId}`,
          name: phone.name,
          state: 'unsupported',
          note: 'iPhones cannot transfer files over USB — use the Wi-Fi tab.',
        });
      } else if (!alreadyNamed) {
        found.push({
          backend: 'none',
          id: `usb:${phone.vendorId}`,
          name: phone.name,
          state: 'blocked',
          note: tools
            ? 'Plugged in, but not readable. Unlock the phone and choose "File transfer" in its USB notification, or enable USB debugging.'
            : 'Plugged in. Install libmtp (brew install libmtp) or enable USB debugging to read it.',
        });
      }
    }
  }

  return { devices: found, errors, tools: toolStatus() };
}

async function listDir(device, dirPath) {
  if (device.backend === 'adb') {
    const adb = findAdb();
    if (!adb) throw new Error('adb not found');
    const target = dirPath || ADB_DEFAULT_PATH;
    return { path: target, entries: await adbListDir(adb, device.id, target) };
  }
  const tools = mtpTools();
  if (!tools) throw new Error('libmtp tools not found');
  const target = dirPath || '0';
  return { path: target, entries: await mtpListDir(tools, target) };
}

/**
 * Copy the given files to ~/Downloads/Beam.
 * onEvent gets {type:'start'|'progress'|'done'|'error', ...} per file.
 */
async function copyFiles(device, items, onEvent) {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  const adb = findAdb();
  const tools = mtpTools();
  const saved = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const dest = uniquePath(SAVE_DIR, path.basename(item.name));
    onEvent({ type: 'start', name: item.name, index: i, total: items.length });
    try {
      if (device.backend === 'adb') {
        await adbPull(adb, device.id, item.path, dest, (pct) =>
          onEvent({ type: 'progress', name: item.name, pct, index: i })
        );
      } else {
        await mtpGetFile(tools, item.path, dest, (pct) =>
          onEvent({ type: 'progress', name: item.name, pct, index: i })
        );
      }
      saved.push({ name: path.basename(dest), path: dest });
      onEvent({ type: 'done', name: path.basename(dest), path: dest, index: i });
    } catch (e) {
      onEvent({ type: 'error', name: item.name, message: e.message, index: i });
    }
  }
  return saved;
}

/**
 * Write files from the Mac onto the phone (drag-in).
 * MTP is not supported here — on macOS it cannot even read (see mtpBlockedReason).
 */
async function pushFiles(device, localPaths, remoteDir, onEvent) {
  if (device.backend !== 'adb') {
    throw new Error(
      'Copying to the phone needs USB debugging. Enable it on the phone, or drop the files on the Wi-Fi tab instead.'
    );
  }
  const adb = findAdb();
  if (!adb) throw new Error('adb not found');

  const pushed = [];
  for (let i = 0; i < localPaths.length; i++) {
    const local = localPaths[i];
    const name = path.basename(local);
    onEvent({ type: 'start', name, index: i, total: localPaths.length });
    try {
      if (fs.statSync(local).isDirectory()) {
        throw new Error('Folders are not supported yet — drop individual files.');
      }
      const remote = path.posix.join(remoteDir, name);
      await adbPush(adb, device.id, local, remote, (pct) =>
        onEvent({ type: 'progress', name, pct, index: i })
      );
      pushed.push(name);
      onEvent({ type: 'done', name, index: i });
    } catch (e) {
      onEvent({ type: 'error', name, message: e.message, index: i });
    }
  }
  return pushed;
}

/**
 * Materialise a phone file on disk so the OS can drag it.
 * Dragging out has to hand Finder a real path, and the file lives on the phone.
 */
const dragCache = new Map(); // remote path -> local temp path

async function ensureLocalCopy(device, item, onProgress = () => {}) {
  const cached = dragCache.get(item.path);
  if (cached && fs.existsSync(cached)) return cached;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-drag-'));
  const dest = path.join(dir, path.basename(item.name));
  if (device.backend === 'adb') {
    const adb = findAdb();
    if (!adb) throw new Error('adb not found');
    await adbPull(adb, device.id, item.path, dest, onProgress);
  } else {
    const tools = mtpTools();
    if (!tools) throw new Error('libmtp tools not found');
    await mtpGetFile(tools, item.path, dest, onProgress);
  }
  dragCache.set(item.path, dest);
  return dest;
}

// --------------------------------------------------------- file operations

/** Only adb can modify the phone; MTP here is read-only (and blocked on macOS). */
function requireAdb(device, what) {
  if (device.backend !== 'adb') {
    throw new Error(`${what} needs USB debugging. Enable it on the phone and reconnect.`);
  }
  const adb = findAdb();
  if (!adb) throw new Error('adb not found');
  return adb;
}

/** A name, not a path: rejects separators and the traversal shorthands. */
function validateName(name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('Name cannot be empty.');
  if (clean.includes('/')) throw new Error('Name cannot contain "/".');
  if (clean === '.' || clean === '..') throw new Error('That name is not allowed.');
  if (clean.length > 255) throw new Error('That name is too long.');
  return clean;
}

/** adb shell swallows failures into stdout, so inspect the text every time. */
async function adbShell(adb, deviceId, command) {
  const { stdout, stderr } = await run(adb, ['-s', deviceId, 'shell', command]);
  const text = `${stdout}\n${stderr}`.trim();
  if (
    /No such file or directory|Permission denied|Read-only file system|not empty|cannot|failed|invalid/i.test(
      text
    )
  ) {
    throw new Error(text.split('\n')[0]);
  }
  return text;
}

async function exists(adb, deviceId, remotePath) {
  const { stdout } = await run(adb, [
    '-s',
    deviceId,
    'shell',
    `[ -e ${shQuote(remotePath)} ] && echo YES || echo NO`,
  ]);
  return /YES/.test(stdout);
}

async function makeFolder(device, parentPath, name) {
  const adb = requireAdb(device, 'Creating folders');
  const clean = validateName(name);
  const target = path.posix.join(parentPath, clean);
  if (await exists(adb, device.id, target)) {
    throw new Error(`"${clean}" already exists here.`);
  }
  await adbShell(adb, device.id, `mkdir ${shQuote(target)}`);
  return target;
}

async function renameEntry(device, item, newName) {
  const adb = requireAdb(device, 'Renaming');
  const clean = validateName(newName);
  const parent = path.posix.dirname(item.path);
  const target = path.posix.join(parent, clean);
  if (target === item.path) return target;
  if (await exists(adb, device.id, target)) {
    throw new Error(`"${clean}" already exists here.`);
  }
  await adbShell(adb, device.id, `mv ${shQuote(item.path)} ${shQuote(target)}`);
  return target;
}

/** Move items into destDir. Refuses to move a folder inside itself. */
async function moveEntries(device, items, destDir, onEvent = () => {}) {
  const adb = requireAdb(device, 'Moving files');
  const moved = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const target = path.posix.join(destDir, path.posix.basename(item.name));
    onEvent({ type: 'start', name: item.name, index: i, total: items.length });
    try {
      if (path.posix.dirname(item.path) === destDir) {
        throw new Error('already in this folder');
      }
      if (item.isDir && (destDir === item.path || destDir.startsWith(`${item.path}/`))) {
        throw new Error('cannot move a folder into itself');
      }
      if (await exists(adb, device.id, target)) {
        throw new Error(`"${item.name}" already exists here`);
      }
      await adbShell(adb, device.id, `mv ${shQuote(item.path)} ${shQuote(target)}`);
      moved.push(item.name);
      onEvent({ type: 'done', name: item.name, index: i });
    } catch (e) {
      onEvent({ type: 'error', name: item.name, message: e.message, index: i });
    }
  }
  return moved;
}

/** Permanent — the phone has no trash. The caller must confirm first. */
async function deleteEntries(device, items, onEvent = () => {}) {
  const adb = requireAdb(device, 'Deleting');
  const deleted = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    onEvent({ type: 'start', name: item.name, index: i, total: items.length });
    try {
      await adbShell(
        adb,
        device.id,
        item.isDir ? `rm -rf ${shQuote(item.path)}` : `rm -f ${shQuote(item.path)}`
      );
      deleted.push(item.name);
      onEvent({ type: 'done', name: item.name, index: i });
    } catch (e) {
      onEvent({ type: 'error', name: item.name, message: e.message, index: i });
    }
  }
  return deleted;
}

function refreshMtpCache() {
  mtpCache = null;
  dragCache.clear();
}

module.exports = {
  SAVE_DIR,
  ADB_DEFAULT_PATH,
  toolStatus,
  listDevices,
  listDir,
  copyFiles,
  pushFiles,
  ensureLocalCopy,
  makeFolder,
  renameEntry,
  moveEntries,
  deleteEntries,
  refreshMtpCache,
  // exported for tests
  validateName,
  // exported for tests
  parseLsLine,
  parseAdbDevices,
  parseMtpFiles,
};
