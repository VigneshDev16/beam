const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  nativeImage,
  dialog,
} = require('electron');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Busboy = require('busboy');
const cable = require('./cable');
const wifiSend = require('./wifi-send');
const approval = require('./approval');
const known = require('./known');
const { version: APP_VERSION } = require('../package.json');

const PORT = 8790;
const SAVE_DIR = path.join(os.homedir(), 'Downloads', 'Beam');

let win = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function getLocalIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

// Avoid overwriting: photo.jpg -> photo (1).jpg
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

let transferId = 0;

function handleUpload(req, res, sender) {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  const totalBytes = parseInt(req.headers['content-length'] || '0', 10);
  let receivedBytes = 0;
  const id = ++transferId;
  const savedFiles = [];

  req.on('data', (chunk) => {
    receivedBytes += chunk.length;
    send('transfer:progress', { id, receivedBytes, totalBytes });
  });

  const bb = Busboy({ headers: req.headers });

  bb.on('file', (_field, fileStream, info) => {
    const filename = path.basename(info.filename || 'unnamed');
    const dest = uniquePath(SAVE_DIR, filename);
    // Count as we go: at 'close' the file is still being flushed to disk, so
    // stat'ing it there reports zero.
    const entry = { name: path.basename(dest), path: dest, size: 0 };
    savedFiles.push(entry);
    fileStream.on('data', (chunk) => {
      entry.size += chunk.length;
    });
    send('transfer:start', { id, sender, filename: path.basename(dest), totalBytes });
    fileStream.pipe(fs.createWriteStream(dest));
  });

  bb.on('close', () => {
    for (const f of savedFiles) {
      known.record(app.getPath('userData'), {
        direction: 'received',
        name: f.name,
        size: f.size,
        peer: sender,
        path: f.path,
      });
    }
    send('transfer:done', { id, sender, files: savedFiles });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, saved: savedFiles.map((f) => f.name) }));
  });

  bb.on('error', (err) => {
    send('transfer:error', { id, message: String(err) });
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false }));
  });

  req.pipe(bb);
}

/** Step 1: the sender declares who it is and what it wants to send. */
async function handleOffer(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'bad request' }));
  }

  const offer = approval.createOffer(body);
  const reply = (extra) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: offer.id, code: offer.code, ...extra }));
  };

  // A device the user has already trusted skips the prompt entirely.
  if (approval.isTrusted(offer.deviceId)) {
    const accepted = approval.accept(offer.id);
    send('approval:auto', { from: offer.from, files: offer.files.length });
    return reply({ status: 'accepted', token: accepted.token });
  }

  reply({ status: 'pending' });

  // Ask after replying, so the sender can start polling and show the code.
  send('approval:pending', { from: offer.from, code: offer.code, files: offer.files });
  const { accepted, trust } = await askApproval({
    from: offer.from,
    files: offer.files,
    code: offer.code,
    canTrust: !!offer.deviceId,
  });
  if (accepted) {
    approval.accept(offer.id);
    if (trust) approval.trustDevice(offer.deviceId, offer.from);
  } else {
    approval.decline(offer.id);
  }
  send('approval:resolved', { from: offer.from, accepted });
}

/**
 * Step 2: the actual bytes. A token proves the user already said yes.
 * Senders too old to make an offer still get a prompt — the body is left
 * unread until the user decides, so declining costs no bandwidth.
 */
async function handleUploadRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');

  if (token) {
    const offer = approval.redeemToken(token);
    if (!offer) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not approved' }));
    }
    return handleUpload(req, res, offer.from);
  }

  const from = decodeURIComponent(url.searchParams.get('from') || 'Unknown device');
  const totalBytes = parseInt(req.headers['content-length'] || '0', 10);
  const { accepted } = await askApproval({ from, files: [], totalBytes, canTrust: false });
  if (!accepted) {
    send('approval:resolved', { from, accepted: false });
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'declined' }));
  }
  handleUpload(req, res, from);
}

function readJson(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limitBytes) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/**
 * Ask the user to accept an incoming transfer. Returns {accepted, trust}.
 * Cancel is the default so a stray Return keypress never accepts.
 */
async function askApproval({ from, files, code, totalBytes, canTrust }) {
  const list = (files || []).slice(0, 6).map((f) => `  ${f.name}${f.size ? `  (${fmtBytes(f.size)})` : ''}`);
  const more = files && files.length > 6 ? `\n  …and ${files.length - 6} more` : '';
  const summary = list.length
    ? `${list.join('\n')}${more}`
    : totalBytes
    ? `${fmtBytes(totalBytes)} of data`
    : 'unknown contents';

  const opts = {
    type: 'question',
    buttons: ['Decline', 'Accept'],
    defaultId: 0,
    cancelId: 0,
    message: `${from} wants to send you ${files && files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'files'}`,
    detail: `${summary}\n\n${code ? `Verification code: ${code}\nThe sending device should be showing the same code.` : 'This sender is using an older version of Beam, so it cannot show a verification code.'}`,
  };
  if (canTrust) opts.checkboxLabel = 'Always allow this device';

  if (win && !win.isDestroyed()) win.show();
  const { response, checkboxChecked } = await dialog.showMessageBox(win ?? undefined, opts);
  return { accepted: response === 1, trust: !!checkboxChecked };
}

function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'GET' && req.url.startsWith('/info')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          app: 'beam',
          name: os.hostname().replace(/\.local$/, ''),
          platform: process.platform,
          version: APP_VERSION,
          features: ['offer'],
        })
      );
    } else if (req.method === 'POST' && req.url.startsWith('/offer')) {
      handleOffer(req, res);
    } else if (req.method === 'GET' && req.url.startsWith('/offer/')) {
      const id = req.url.split('/')[2]?.split('?')[0];
      const offer = approval.getOffer(id);
      res.writeHead(offer ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          offer
            ? { status: offer.status, token: offer.status === 'accepted' ? offer.token : null }
            : { status: 'expired' }
        )
      );
    } else if (req.method === 'POST' && req.url.startsWith('/upload')) {
      handleUploadRequest(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(PORT, '0.0.0.0');
  server.on('error', (err) => send('server:error', { message: String(err) }));
  return server;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'Beam',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('beam:getState', () => ({
  name: os.hostname().replace(/\.local$/, ''),
  ips: getLocalIPs(),
  port: PORT,
  saveDir: SAVE_DIR,
}));

ipcMain.on('beam:openFile', (_e, filePath) => {
  if (typeof filePath === 'string' && filePath.startsWith(SAVE_DIR)) {
    shell.showItemInFolder(filePath);
  }
});

ipcMain.on('beam:openFolder', () => {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  shell.openPath(SAVE_DIR);
});

/**
 * Browse the Mac side of the two-pane view. Confined to SAVE_DIR: the renderer
 * should never be able to walk the whole filesystem.
 */
ipcMain.handle('local:listDir', async (_e, dirPath) => {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  const target = path.resolve(dirPath || SAVE_DIR);
  if (target !== SAVE_DIR && !target.startsWith(`${SAVE_DIR}${path.sep}`)) {
    throw new Error('Outside the Beam folder.');
  }
  const entries = fs.readdirSync(target, { withFileTypes: true }).map((d) => {
    const full = path.join(target, d.name);
    let size = null;
    let mtime = null;
    try {
      const st = fs.statSync(full);
      size = d.isDirectory() ? null : st.size;
      mtime = st.mtimeMs;
    } catch {
      /* unreadable entry: show it with no size */
    }
    return { name: d.name, path: full, isDir: d.isDirectory(), size, mtime };
  });
  entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
  );
  return { path: target, entries, root: SAVE_DIR };
});

ipcMain.handle('cable:listDevices', async () => {
  try {
    return await cable.listDevices();
  } catch (e) {
    return { devices: [], errors: [String(e.message)], tools: cable.toolStatus() };
  }
});

ipcMain.handle('cable:listDir', async (_e, device, dirPath) => {
  return cable.listDir(device, dirPath);
});

ipcMain.handle('cable:copy', async (_e, device, items) => {
  cable.refreshMtpCache();
  return cable.copyFiles(device, items, (ev) => send('cable:progress', ev));
});

ipcMain.handle('cable:push', async (_e, device, localPaths, remoteDir) => {
  const pushed = await cable.pushFiles(device, localPaths, remoteDir, (ev) =>
    send('cable:progress', ev)
  );
  cable.refreshMtpCache();
  return pushed;
});

/**
 * Drag-out. Finder needs a real path, so a phone file is pulled to a temp copy
 * first; the renderer asks for this before it begins the drag.
 */
ipcMain.handle('cable:prepareDrag', async (_e, device, item) => {
  return cable.ensureLocalCopy(device, item, (pct) =>
    send('cable:progress', { type: 'progress', name: item.name, pct, index: 0 })
  );
});

function dragIcon() {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromNamedImage('NSImageNameMultipleDocuments', [
      0, 0, 0, 1,
    ]);
    if (!img.isEmpty()) return img;
  }
  // startDrag rejects an empty icon, so fall back to a 1px placeholder.
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  );
}

ipcMain.handle('cable:mkdir', async (_e, device, parentPath, name) => {
  return cable.makeFolder(device, parentPath, name);
});

ipcMain.handle('cable:rename', async (_e, device, item, newName) => {
  return cable.renameEntry(device, item, newName);
});

ipcMain.handle('cable:move', async (_e, device, items, destDir) => {
  return cable.moveEntries(device, items, destDir, (ev) =>
    send('cable:progress', ev)
  );
});

/**
 * Deleting is permanent — Android has no trash — so it always goes through a
 * confirmation naming what will be removed, with Cancel as the default button.
 */
ipcMain.handle('cable:delete', async (_e, device, items) => {
  const names = items.map((i) => i.name);
  const preview = names.slice(0, 5).join('\n');
  const more = names.length > 5 ? `\n…and ${names.length - 5} more` : '';
  const hasFolder = items.some((i) => i.isDir);

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
    message: `Delete ${items.length} item${items.length === 1 ? '' : 's'} from the phone?`,
    detail: `${preview}${more}\n\nThis cannot be undone${
      hasFolder ? ' and folders are deleted with everything inside them' : ''
    }.`,
  });
  if (response !== 1) return { cancelled: true, deleted: [] };

  const deleted = await cable.deleteEntries(device, items, (ev) =>
    send('cable:progress', ev)
  );
  return { cancelled: false, deleted };
});

ipcMain.handle('wifi:scan', async () => {
  const dir = app.getPath('userData');
  try {
    return await wifiSend.scanForPhones({
      hints: known.known(dir).map((d) => d.ip),
      // Stream them: the first pass usually answers long before the sweep ends.
      onFound: (device) => {
        known.remember(dir, device);
        send('wifi:found', device);
      },
    });
  } catch (e) {
    return { devices: [], error: e.message };
  }
});

ipcMain.handle('wifi:connect', async (_e, address) => {
  const dir = app.getPath('userData');
  try {
    const result = await wifiSend.connectTo(address);
    if (result.device) known.remember(dir, result.device);
    return result;
  } catch (e) {
    return { device: null, error: e.message };
  }
});

ipcMain.handle('wifi:known', () => known.known(app.getPath('userData')));

ipcMain.handle('wifi:forget', (_e, key) => {
  known.forget(app.getPath('userData'), key);
  return known.known(app.getPath('userData'));
});

ipcMain.handle('history:list', () => known.history(app.getPath('userData')));

ipcMain.handle('history:clear', () => {
  known.clearHistory(app.getPath('userData'));
  return [];
});

ipcMain.handle('wifi:send', async (_e, device, localPaths) => {
  const dir = app.getPath('userData');
  return wifiSend.sendFiles(
    device,
    localPaths,
    (ev) => {
      if (ev.type === 'done') {
        known.record(dir, {
          direction: 'sent',
          name: ev.name,
          size: ev.size ?? null,
          peer: device.name,
        });
      }
      send('wifi:progress', ev);
    },
    dir
  );
});

// Must be a plain 'on' (not handle): startDrag has to run during the drag event.
ipcMain.on('drag:start', (event, filePaths) => {
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(
    (p) => typeof p === 'string' && fs.existsSync(p)
  );
  if (!files.length) return;
  event.sender.startDrag({ files, file: files[0], icon: dragIcon() });
});

app.whenReady().then(() => {
  approval.init(app.getPath('userData'));
  startServer();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
