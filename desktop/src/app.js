/**
 * Two-pane UI: devices on the left, an explorer on the right.
 *
 * The right pane renders one of three things depending on what is selected:
 *   mac  — the Beam folder on this Mac (browse + drag out)
 *   usb  — a cabled Android (full explorer: browse, transfer, manage)
 *   wifi — a phone on the network (send-only; phones expose no browse API)
 */

const $ = (id) => document.getElementById(id);

const sideMac = $('side-mac');
const sideUsb = $('side-usb');
const sideWifi = $('side-wifi');
const sideFoot = $('side-foot');
const liveDot = $('live-dot');
const contentEl = $('content');
const crumbsEl = $('crumbs');
const statusEl = $('status');
const barEl = $('bar');

const btnUp = $('nav-up');
const btnNewFolder = $('op-newfolder');
const btnRename = $('op-rename');
const btnCut = $('op-cut');
const btnPaste = $('op-paste');
const btnDelete = $('op-delete');
const btnCopy = $('op-copy');

let selection = null; // {kind:'mac'|'usb'|'wifi', device?}
let currentPath = null;
let currentEntries = [];
let localRoot = null;
const dirStack = [];
const selected = new Map(); // path -> entry
let clipboard = null; // {items, from}
const dragReady = new Set();

let usbDevices = [];
let wifiDevices = [];

const setStatus = (msg) => {
  statusEl.textContent = msg;
};
const setProgress = (pct) => {
  barEl.firstElementChild.style.width = pct == null ? '0%' : `${pct}%`;
};

function fmtSize(n) {
  if (n == null) return '';
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

const isUsb = () => selection?.kind === 'usb';

// ------------------------------------------------------------------ sidebar

function sidebarItem({ icon, name, sub, selected: sel, disabled, onClick }) {
  const el = document.createElement('div');
  el.className = `item${sel ? ' sel' : ''}${disabled ? ' disabled' : ''}`;
  el.innerHTML = `<span class="ico">${icon}</span>
    <span class="txt"><div class="nm"></div>${sub ? '<div class="sub"></div>' : ''}</span>`;
  el.querySelector('.nm').textContent = name;
  if (sub) el.querySelector('.sub').textContent = sub;
  if (!disabled && onClick) el.onclick = onClick;
  return el;
}

function renderSidebar() {
  sideMac.innerHTML = '';
  sideMac.appendChild(
    sidebarItem({
      icon: '💻',
      name: 'Beam folder',
      sub: 'Received files',
      selected: selection?.kind === 'mac',
      onClick: selectMac,
    })
  );

  sideUsb.innerHTML = '';
  const usable = usbDevices.filter((d) => d.state === 'device');
  const blocked = usbDevices.filter((d) => d.state !== 'device');
  if (!usbDevices.length) {
    sideUsb.innerHTML = '<div class="side-empty">No phone connected</div>';
  }
  for (const d of usable) {
    sideUsb.appendChild(
      sidebarItem({
        icon: '📱',
        name: d.name,
        sub: d.backend === 'adb' ? 'USB debugging' : 'MTP',
        selected: isUsb() && selection.device.id === d.id,
        onClick: () => selectUsb(d),
      })
    );
  }
  for (const d of blocked) {
    sideUsb.appendChild(
      sidebarItem({ icon: '📵', name: d.name, sub: d.note, disabled: true })
    );
  }

  sideWifi.innerHTML = '';
  if (!wifiDevices.length) {
    sideWifi.innerHTML =
      '<div class="side-empty">No phones. Turn on "Receive files" in the phone app.</div>';
  }
  for (const d of wifiDevices) {
    sideWifi.appendChild(
      sidebarItem({
        icon: d.platform === 'ios' ? '' : '📲',
        name: d.name,
        sub: d.ip,
        selected: selection?.kind === 'wifi' && selection.device.ip === d.ip,
        onClick: () => selectWifi(d),
      })
    );
  }
}

async function refreshUsb() {
  sideUsb.innerHTML = '<div class="side-empty">Looking…</div>';
  const { devices } = await cable.listDevices();
  usbDevices = devices;
  // Drop the pane if the device we were browsing went away.
  if (isUsb() && !devices.some((d) => d.id === selection.device.id)) {
    selection = null;
    selectMac();
  }
  renderSidebar();
}

async function refreshWifi() {
  sideWifi.innerHTML = '<div class="side-empty">Scanning…</div>';
  const { devices } = await wifi.scan();
  wifiDevices = devices;
  renderSidebar();
}

// ---------------------------------------------------------------- selection

async function selectMac() {
  selection = { kind: 'mac' };
  dirStack.length = 0;
  selected.clear();
  renderSidebar();
  await openDir(null);
}

async function selectUsb(device) {
  selection = { kind: 'usb', device };
  dirStack.length = 0;
  selected.clear();
  clipboard = null;
  renderSidebar();
  await openDir(null);
}

function selectWifi(device) {
  selection = { kind: 'wifi', device };
  dirStack.length = 0;
  selected.clear();
  renderSidebar();
  renderSendView();
}

// ----------------------------------------------------------------- browsing

async function openDir(dirPath) {
  selected.clear();
  contentEl.innerHTML = '<div class="blank">Loading…</div>';
  try {
    if (selection.kind === 'mac') {
      const { path: p, entries, root } = await beam.listLocal(dirPath);
      localRoot = root;
      currentPath = p;
      currentEntries = entries;
    } else {
      const { path: p, entries } = await cable.listDir(selection.device, dirPath);
      currentPath = p;
      currentEntries = entries;
    }
    renderEntries();
  } catch (e) {
    contentEl.innerHTML = `<div class="blank"><div class="err">${e.message}</div></div>`;
    updateToolbar();
  }
}

function renderEntries() {
  crumbsEl.textContent = currentPath ?? '';
  contentEl.innerHTML = '';

  if (!currentEntries.length) {
    const blank = document.createElement('div');
    blank.className = 'blank';
    blank.innerHTML = `<div class="big">📂</div><div>This folder is empty.</div>${
      isUsb()
        ? '<div class="hint">Drop files here to copy them onto the phone.</div>'
        : ''
    }`;
    contentEl.appendChild(blank);
    updateToolbar();
    return;
  }

  for (const entry of currentEntries) contentEl.appendChild(renderEntry(entry));
  updateToolbar();
}

function renderEntry(entry) {
  const row = document.createElement('div');
  row.className = 'entry';
  if (clipboard?.items.some((i) => i.path === entry.path)) row.classList.add('cut');
  row.dataset.path = entry.path;

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = selected.has(entry.path);
  box.onchange = () => {
    if (box.checked) selected.set(entry.path, entry);
    else selected.delete(entry.path);
    updateToolbar();
  };
  row.appendChild(box);

  const nm = document.createElement('span');
  nm.className = `nm ${entry.isDir ? 'dir' : 'file'}`;
  nm.textContent = `${entry.isDir ? '📁' : '📄'} ${entry.name}`;
  nm.onclick = () => {
    if (entry.isDir) {
      dirStack.push(currentPath);
      openDir(entry.path);
    } else {
      box.checked = !box.checked;
      box.onchange();
    }
  };
  if (!entry.isDir) {
    nm.draggable = true;
    nm.addEventListener('dragstart', (e) => {
      e.preventDefault();
      startDragOut(entry, nm);
    });
    if (selection.kind === 'mac') {
      nm.ondblclick = () => beam.openFile(entry.path);
    }
  }
  row.appendChild(nm);

  const sz = document.createElement('span');
  sz.className = 'sz';
  sz.textContent = fmtSize(entry.size);
  row.appendChild(sz);
  return row;
}

function renderSendView() {
  crumbsEl.textContent = `${selection.device.name} · ${selection.device.ip}`;
  contentEl.innerHTML = '';
  const blank = document.createElement('div');
  blank.className = 'blank';
  blank.innerHTML = `<div class="big">📲</div>
    <div class="dropbox" id="wifi-dropbox">Drop files here to send them to ${selection.device.name}</div>
    <div class="hint">Phones can receive over Wi-Fi but cannot be browsed — open the phone app to see what arrived.</div>`;
  contentEl.appendChild(blank);

  const box = $('wifi-dropbox');
  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    box.classList.add('over');
  });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', async (e) => {
    e.preventDefault();
    box.classList.remove('over');
    const paths = pathsFromDrop(e);
    if (!paths.length) return;
    setStatus(`Sending ${paths.length} file${paths.length === 1 ? '' : 's'}…`);
    const sent = await wifi.send(selection.device, paths);
    setProgress(null);
    setStatus(
      sent.length === paths.length
        ? `Sent ${sent.length} file${sent.length === 1 ? '' : 's'} to ${selection.device.name}`
        : `Sent ${sent.length} of ${paths.length} — check the phone`
    );
  });
  updateToolbar();
}

// ------------------------------------------------------------------ toolbar

function updateToolbar() {
  const n = selected.size;
  const usb = isUsb();
  const browsing = selection?.kind === 'mac' || usb;

  btnUp.disabled = !browsing || !dirStack.length;
  btnNewFolder.disabled = !usb;
  btnRename.disabled = !usb || n !== 1;
  btnCut.disabled = !usb || n === 0;
  btnPaste.disabled = !usb || !clipboard || clipboard.from === currentPath;
  btnDelete.disabled = !usb || n === 0;
  btnCopy.disabled = !usb || n === 0;

  for (const b of [btnNewFolder, btnRename, btnCut, btnPaste, btnDelete, btnCopy]) {
    b.style.display = usb ? '' : 'none';
  }

  if (n) setStatus(`${n} item${n === 1 ? '' : 's'} selected`);
  else if (clipboard)
    setStatus(
      `${clipboard.items.length} item${
        clipboard.items.length === 1 ? '' : 's'
      } cut — open a folder and press Paste`
    );
}

btnUp.onclick = () => {
  if (dirStack.length) openDir(dirStack.pop());
};

function promptInline(row, initial, onCommit) {
  row.innerHTML = '';
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = initial;
  row.appendChild(input);
  input.focus();
  const dot = initial.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : initial.length);

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    if (!commit) return renderEntries();
    try {
      await onCommit(input.value);
    } catch (e) {
      setStatus(e.message);
    }
    await openDir(currentPath);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(false);
}

btnNewFolder.onclick = () => {
  const row = document.createElement('div');
  row.className = 'entry';
  contentEl.prepend(row);
  promptInline(row, 'New folder', (name) =>
    cable.mkdir(selection.device, currentPath, name)
  );
};

btnRename.onclick = () => {
  const item = [...selected.values()][0];
  if (!item) return;
  const row = contentEl.querySelector(`[data-path="${CSS.escape(item.path)}"]`);
  if (row) promptInline(row, item.name, (name) => cable.rename(selection.device, item, name));
};

btnCut.onclick = () => {
  clipboard = { items: [...selected.values()], from: currentPath };
  selected.clear();
  renderEntries();
};

btnPaste.onclick = async () => {
  if (!clipboard) return;
  const items = clipboard.items;
  const moved = await cable.move(selection.device, items, currentPath);
  clipboard = null;
  await openDir(currentPath);
  setStatus(
    moved.length === items.length
      ? `Moved ${moved.length} item${moved.length === 1 ? '' : 's'} here`
      : `Moved ${moved.length} of ${items.length}`
  );
};

btnDelete.onclick = async () => {
  const items = [...selected.values()];
  if (!items.length) return;
  const { cancelled, deleted } = await cable.remove(selection.device, items);
  if (cancelled) return setStatus('Delete cancelled');
  await openDir(currentPath);
  setStatus(`Deleted ${deleted.length} item${deleted.length === 1 ? '' : 's'}`);
};

btnCopy.onclick = async () => {
  const items = [...selected.values()];
  const saved = await cable.copy(selection.device, items);
  setProgress(null);
  selected.clear();
  renderEntries();
  setStatus(`Copied ${saved.length} of ${items.length} to the Beam folder`);
};

// --------------------------------------------------------------- drag & drop

function pathsFromDrop(e) {
  return [...(e.dataTransfer?.files ?? [])]
    .map((f) => {
      try {
        return beam.pathForFile(f);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function startDragOut(entry, el) {
  // Local files are already on disk; phone files need fetching first.
  if (selection.kind === 'mac') return beam.startDrag(entry.path);

  if (dragReady.has(entry.path)) {
    beam.startDrag(await cable.prepareDrag(selection.device, entry));
    return;
  }
  const label = el.textContent;
  el.textContent = `⏳ ${entry.name} — copying…`;
  try {
    const local = await cable.prepareDrag(selection.device, entry);
    dragReady.add(entry.path);
    el.textContent = label;
    setStatus(`${entry.name} is ready — drag it again to drop it in Finder`);
    beam.startDrag(local);
  } catch (e) {
    el.textContent = label;
    setStatus(`Could not prepare ${entry.name}: ${e.message}`);
  }
}

contentEl.addEventListener('dragover', (e) => {
  if (!isUsb()) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  contentEl.classList.add('over');
});
contentEl.addEventListener('dragleave', () => contentEl.classList.remove('over'));
contentEl.addEventListener('drop', async (e) => {
  if (!isUsb()) return;
  e.preventDefault();
  contentEl.classList.remove('over');
  const paths = pathsFromDrop(e);
  if (!paths.length) return;
  try {
    const pushed = await cable.push(selection.device, paths, currentPath);
    setStatus(`Copied ${pushed.length} of ${paths.length} to the phone`);
    await openDir(currentPath);
  } catch (err) {
    setStatus(err.message);
  } finally {
    setProgress(null);
  }
});

// ------------------------------------------------------------------- events

cable.onProgress((ev) => {
  if (ev.type === 'start') setStatus(`${ev.name} (${ev.index + 1} of ${ev.total})…`);
  else if (ev.type === 'progress') setProgress(ev.pct);
  else if (ev.type === 'error') setStatus(`Failed on ${ev.name}: ${ev.message}`);
});

wifi.onProgress((ev) => {
  if (ev.type === 'start') setStatus(`Sending ${ev.name} (${ev.index + 1} of ${ev.total})…`);
  else if (ev.type === 'error') setStatus(`Failed on ${ev.name}: ${ev.message}`);
});

beam.onTransferStart((d) => setStatus(`Receiving ${d.filename} from ${d.sender}…`));
beam.onTransferProgress((d) => {
  if (d.totalBytes) setProgress((d.receivedBytes / d.totalBytes) * 100);
});
beam.onTransferDone((d) => {
  setProgress(null);
  setStatus(`Received ${d.files.map((f) => f.name).join(', ')} from ${d.sender}`);
  if (selection?.kind === 'mac') openDir(currentPath);
});
beam.onTransferError((d) => setStatus(`Transfer failed: ${d.message}`));

$('refresh-usb').onclick = refreshUsb;
$('refresh-wifi').onclick = refreshWifi;

(async function init() {
  const state = await beam.getState();
  sideFoot.textContent = state.ips.length
    ? `${state.name} · ${state.ips[0]}:${state.port}`
    : `${state.name} · offline`;
  liveDot.classList.toggle('off', !state.ips.length);
  await selectMac();
  refreshUsb();
  refreshWifi();
})();
