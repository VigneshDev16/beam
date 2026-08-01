const devicesEl = document.getElementById('cable-devices');
const toolsEl = document.getElementById('cable-tools');
const browserEl = document.getElementById('cable-browser');
const pathEl = document.getElementById('cable-path');
const listingEl = document.getElementById('cable-listing');
const statusEl = document.getElementById('cable-status');
const copyBtn = document.getElementById('cable-copy');
const upBtn = document.getElementById('cable-up');
const cableBar = document.getElementById('cable-bar');

const btnNewFolder = document.getElementById('op-newfolder');
const btnRename = document.getElementById('op-rename');
const btnCut = document.getElementById('op-cut');
const btnPaste = document.getElementById('op-paste');
const btnDelete = document.getElementById('op-delete');

let selectedDevice = null;
let currentPath = null;
let currentEntries = [];
const selected = new Map(); // path -> {name, path, isDir}
const dirStack = [];
let clipboard = null; // {items:[...], from: path}

// Tabs
for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
    for (const p of document.querySelectorAll('.panel')) p.classList.remove('active');
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'cable' && !selectedDevice) refreshDevices();
  };
}

function fmtSize(n) {
  if (n == null) return '';
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function refreshDevices() {
  devicesEl.innerHTML = '<div class="empty">Looking for devices…</div>';
  const { devices, errors, tools } = await cable.listDevices();

  toolsEl.textContent = tools.mtp
    ? 'Tip: macOS often refuses to hand a phone to MTP (Image Capture grabs it first). USB debugging is the reliable cable path; Wi-Fi always works. iPhones cannot transfer over USB at all.'
    : tools.hint ?? '';

  devicesEl.innerHTML = '';
  if (!devices.length) {
    devicesEl.innerHTML =
      '<div class="empty">No phone detected. Connect one by USB, unlock it, and pick "File transfer" in the USB notification.</div>';
  }

  for (const d of devices) {
    const el = document.createElement('div');
    el.className = 'device';
    const usable = d.state === 'device';
    const how =
      d.backend === 'adb' ? 'USB debugging' : d.backend === 'mtp' ? 'MTP' : 'USB';
    el.innerHTML = `<div class="name">📱 ${d.name}</div>
      <div class="why">${how}${d.note ? ` — ${d.note}` : ''}</div>`;
    if (usable) {
      el.onclick = () => selectDevice(d, el);
    } else {
      el.style.opacity = '0.55';
      el.style.cursor = 'default';
    }
    devicesEl.appendChild(el);
  }

  for (const err of errors) {
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = err;
    devicesEl.appendChild(e);
  }
}

async function selectDevice(device, el) {
  selectedDevice = device;
  for (const d of document.querySelectorAll('.device')) d.classList.remove('sel');
  el.classList.add('sel');
  dirStack.length = 0;
  selected.clear();
  clipboard = null;
  browserEl.style.display = 'block';
  await openDir(null);
}

async function openDir(dirPath) {
  listingEl.innerHTML = '<div class="empty">Loading…</div>';
  selected.clear();
  try {
    const { path: p, entries } = await cable.listDir(selectedDevice, dirPath);
    currentPath = p;
    currentEntries = entries;
    renderListing();
  } catch (e) {
    listingEl.innerHTML = `<div class="err">${e.message}</div>`;
    updateSelection();
  }
}

function renderListing() {
  pathEl.textContent =
    selectedDevice.backend === 'adb' ? currentPath : `Folder ${currentPath}`;
  listingEl.innerHTML = '';

  if (!currentEntries.length) {
    listingEl.innerHTML = '<div class="empty">This folder is empty.</div>';
  }

  for (const entry of currentEntries) {
    listingEl.appendChild(renderEntry(entry));
  }
  updateSelection();
}

function renderEntry(entry) {
  const row = document.createElement('div');
  row.className = 'entry';
  if (clipboard?.items.some((i) => i.path === entry.path)) row.classList.add('cut');

  // Folders are selectable too, so they can be renamed, moved or deleted.
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = selected.has(entry.path);
  box.onchange = () => {
    if (box.checked) selected.set(entry.path, entry);
    else selected.delete(entry.path);
    updateSelection();
  };
  row.appendChild(box);

  const nm = document.createElement('span');
  nm.className = 'nm';
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
    // Drag out to Finder. The file lives on the phone, so the first drag
    // fetches a local copy and the drag proper starts once it is ready.
    nm.draggable = true;
    nm.addEventListener('dragstart', (e) => {
      e.preventDefault();
      startDragOut(entry, nm);
    });
  }
  row.appendChild(nm);

  const sz = document.createElement('span');
  sz.className = 'sz';
  sz.textContent = fmtSize(entry.size);
  row.appendChild(sz);

  row.dataset.path = entry.path;
  return row;
}

function updateSelection() {
  const n = selected.size;
  const items = [...selected.values()];
  statusEl.textContent = n
    ? `${n} item${n === 1 ? '' : 's'} selected`
    : clipboard
    ? `${clipboard.items.length} item${
        clipboard.items.length === 1 ? '' : 's'
      } ready to move — open a folder and press "Paste here"`
    : 'Nothing selected';

  const canEdit = selectedDevice?.backend === 'adb';
  copyBtn.disabled = n === 0;
  btnRename.disabled = !canEdit || n !== 1;
  btnCut.disabled = !canEdit || n === 0;
  btnDelete.disabled = !canEdit || n === 0;
  btnPaste.disabled = !canEdit || !clipboard || clipboard.from === currentPath;
  btnNewFolder.disabled = !canEdit;
  copyBtn.textContent = items.some((i) => i.isDir) ? 'Copy to Mac' : 'Copy to Mac';
}

upBtn.onclick = () => {
  if (dirStack.length) openDir(dirStack.pop());
};

document.getElementById('cable-refresh').onclick = refreshDevices;

// ------------------------------------------------------------- file ops

/** Inline text input used by both "New folder" and "Rename". */
function promptInline(row, initial, onCommit) {
  const original = row.innerHTML;
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
    const value = input.value;
    if (!commit) {
      row.innerHTML = original;
      renderListing();
      return;
    }
    try {
      await onCommit(value);
    } catch (e) {
      statusEl.textContent = e.message;
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
  listingEl.prepend(row);
  promptInline(row, 'New folder', (name) =>
    cable.mkdir(selectedDevice, currentPath, name)
  );
};

btnRename.onclick = () => {
  const item = [...selected.values()][0];
  if (!item) return;
  const row = listingEl.querySelector(`[data-path="${CSS.escape(item.path)}"]`);
  if (!row) return;
  promptInline(row, item.name, (name) =>
    cable.rename(selectedDevice, item, name)
  );
};

btnCut.onclick = () => {
  clipboard = { items: [...selected.values()], from: currentPath };
  selected.clear();
  renderListing();
};

btnPaste.onclick = async () => {
  if (!clipboard) return;
  const items = clipboard.items;
  statusEl.textContent = `Moving ${items.length} item${items.length === 1 ? '' : 's'}…`;
  const moved = await cable.move(selectedDevice, items, currentPath);
  clipboard = null;
  await openDir(currentPath);
  statusEl.textContent =
    moved.length === items.length
      ? `Moved ${moved.length} item${moved.length === 1 ? '' : 's'} here`
      : `Moved ${moved.length} of ${items.length} — see message above`;
};

btnDelete.onclick = async () => {
  const items = [...selected.values()];
  if (!items.length) return;
  const { cancelled, deleted } = await cable.remove(selectedDevice, items);
  if (cancelled) {
    statusEl.textContent = 'Delete cancelled';
    return;
  }
  await openDir(currentPath);
  statusEl.textContent = `Deleted ${deleted.length} item${
    deleted.length === 1 ? '' : 's'
  }`;
};

copyBtn.onclick = async () => {
  const items = [...selected.values()];
  copyBtn.disabled = true;
  cableBar.style.display = 'block';
  const saved = await cable.copy(selectedDevice, items);
  cableBar.style.display = 'none';
  cableBar.firstElementChild.style.width = '0%';
  selected.clear();
  renderListing();
  statusEl.textContent = `Copied ${saved.length} of ${items.length} item${
    items.length === 1 ? '' : 's'
  }`;
  addReceivedFiles(saved);
};

// ------------------------------------------------------------ drag & drop

const dragReady = new Set(); // remote paths already copied locally

async function startDragOut(entry, el) {
  if (dragReady.has(entry.path)) {
    beam.startDrag(await cable.prepareDrag(selectedDevice, entry));
    return;
  }
  const label = el.textContent;
  el.textContent = `⏳ ${entry.name} — copying…`;
  try {
    const localPath = await cable.prepareDrag(selectedDevice, entry);
    dragReady.add(entry.path);
    el.textContent = label;
    statusEl.textContent = `${entry.name} is ready — drag it again to drop it in Finder`;
    beam.startDrag(localPath);
  } catch (e) {
    el.textContent = label;
    statusEl.textContent = `Could not prepare ${entry.name}: ${e.message}`;
  }
}

listingEl.addEventListener('dragover', (e) => {
  if (!selectedDevice) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  listingEl.classList.add('over');
});
listingEl.addEventListener('dragleave', () => listingEl.classList.remove('over'));
listingEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  listingEl.classList.remove('over');
  if (!selectedDevice) return;

  const paths = [...(e.dataTransfer?.files ?? [])]
    .map((f) => {
      try {
        return beam.pathForFile(f);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!paths.length) return;

  cableBar.style.display = 'block';
  try {
    const pushed = await cable.push(selectedDevice, paths, currentPath);
    statusEl.textContent = `Copied ${pushed.length} of ${paths.length} file${
      paths.length === 1 ? '' : 's'
    } to the phone`;
    await openDir(currentPath);
  } catch (err) {
    statusEl.textContent = err.message;
  } finally {
    cableBar.style.display = 'none';
    cableBar.firstElementChild.style.width = '0%';
  }
});

cable.onProgress((ev) => {
  if (ev.type === 'start') {
    statusEl.textContent = `${ev.name} (${ev.index + 1} of ${ev.total})…`;
  } else if (ev.type === 'progress') {
    cableBar.firstElementChild.style.width = `${ev.pct}%`;
  } else if (ev.type === 'error') {
    statusEl.textContent = `Failed on ${ev.name}: ${ev.message}`;
  }
});
