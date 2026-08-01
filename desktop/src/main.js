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

function handleUpload(req, res) {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  const sender = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('from') || 'Phone');
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
    savedFiles.push({ name: path.basename(dest), path: dest });
    send('transfer:start', { id, sender, filename: path.basename(dest), totalBytes });
    fileStream.pipe(fs.createWriteStream(dest));
  });

  bb.on('close', () => {
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
          version: '0.1.0',
        })
      );
    } else if (req.method === 'POST' && req.url.startsWith('/upload')) {
      handleUpload(req, res);
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
    try {
      const st = fs.statSync(full);
      size = d.isDirectory() ? null : st.size;
    } catch {
      /* unreadable entry: show it with no size */
    }
    return { name: d.name, path: full, isDir: d.isDirectory(), size };
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
  try {
    return await wifiSend.scanForPhones();
  } catch (e) {
    return { devices: [], error: e.message };
  }
});

ipcMain.handle('wifi:send', async (_e, device, localPaths) => {
  return wifiSend.sendFiles(device, localPaths, (ev) => send('wifi:progress', ev));
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
  startServer();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
