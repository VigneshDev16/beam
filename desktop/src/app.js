/**
 * Two-pane UI: devices on the left, an explorer on the right.
 *
 * The right pane renders one of three things depending on what is selected:
 *   mac    — the Beam folder on this Mac (browse + drag out)
 *   usb    — a cabled Android (full explorer: browse, transfer, manage)
 *   wifi   — a phone on the network (send-only; phones expose no browse API)
 *   recent — what has been sent and received, newest first
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
const catBar = $('catbar');
const searchEl = $('search');
const sortKeyEl = $('sort-key');
const sortDirEl = $('sort-dir');

let selection = null; // {kind:'mac'|'usb'|'wifi'|'recent', device?}
let currentPath = null;
let currentEntries = [];
let localRoot = null;
const dirStack = [];
const selected = new Map(); // path -> entry
let clipboard = null; // {items, from}
const dragReady = new Set();

let filterText = '';
let category = 'all';
let sortKey = localStorage.getItem('sortKey') || 'name';
let sortAsc = localStorage.getItem('sortAsc') !== 'false';

let usbDevices = [];
let wifiDevices = [];
let knownDevices = []; // seen before; shown greyed out until they answer

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
  sideMac.appendChild(
    sidebarItem({
      icon: '🕘',
      name: 'Recent',
      sub: 'Sent and received',
      selected: selection?.kind === 'recent',
      onClick: selectRecent,
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
  const liveNames = new Set(wifiDevices.map((d) => d.name.toLowerCase()));
  const offline = knownDevices.filter((d) => !liveNames.has(d.name.toLowerCase()));

  if (!wifiDevices.length && !offline.length) {
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
  // Phones we've used before but that haven't answered yet. Clicking one asks
  // its last address directly, which beats waiting out another sweep.
  for (const d of offline) {
    sideWifi.appendChild(
      sidebarItem({
        icon: '💤',
        name: d.name,
        sub: `Last seen ${ago(d.lastSeen)}`,
        onClick: () => wake(d),
      })
    );
  }
}

/** "3m ago" / "yesterday" — enough to tell stale from current. */
function ago(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

async function wake(device) {
  setStatus(`Looking for ${device.name} at ${device.ip}…`);
  const { device: found } = await wifi.connect(`${device.ip}:${device.port}`);
  if (!found) {
    setStatus(`${device.name} isn't at ${device.ip} any more — rescanning…`);
    await refreshWifi();
    return;
  }
  addWifiDevice(found);
  setStatus(`${found.name} is at ${found.ip}`);
  selectWifi(found);
}

function addWifiDevice(device) {
  if (!wifiDevices.some((d) => d.ip === device.ip && d.port === device.port)) {
    wifiDevices.push(device);
  }
  renderSidebar();
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
  knownDevices = await wifi.known();
  wifiDevices = [];
  renderSidebar();
  sideWifi.insertAdjacentHTML('beforeend', '<div class="side-empty">Scanning…</div>');
  const { devices } = await wifi.scan(); // wifi.onFound fills the list as it goes
  wifiDevices = devices;
  knownDevices = await wifi.known();
  renderSidebar();
}

async function connectByIp() {
  const dialog = $('ip-dialog');
  const input = $('ip-input');
  const errorEl = $('ip-error');
  errorEl.textContent = '';
  input.value = '';
  dialog.showModal();
  input.focus();

  dialog.onclose = async () => {
    if (dialog.returnValue !== 'connect' || !input.value.trim()) return;
    setStatus(`Connecting to ${input.value.trim()}…`);
    const { device, error } = await wifi.connect(input.value.trim());
    if (!device) return setStatus(error);
    addWifiDevice(device);
    knownDevices = await wifi.known();
    selectWifi(device);
    setStatus(`Connected to ${device.name}`);
  };
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

async function selectRecent() {
  selection = { kind: 'recent' };
  dirStack.length = 0;
  selected.clear();
  renderSidebar();
  await renderRecent();
}

async function renderRecent() {
  const entries = await beam.history();
  crumbsEl.textContent = 'Recent transfers';
  updateToolbar();
  if (!entries.length) {
    contentEl.innerHTML =
      '<div class="blank"><div class="big">🕘</div>' +
      '<div class="hint">Nothing yet. Files you send or receive show up here.</div></div>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'recent';
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'row';
    const sent = e.direction === 'sent';
    row.innerHTML = `<span class="dir ${sent ? 'out' : 'in'}">${sent ? '↑' : '↓'}</span>
      <span class="nm"></span><span class="meta"></span>`;
    const nameEl = row.querySelector('.nm');
    nameEl.textContent = e.name;
    // Only received files are still ours to open; sent ones may have moved.
    if (!sent && e.path) {
      nameEl.classList.add('open');
      nameEl.title = e.path;
      nameEl.onclick = () => beam.openFile(e.path);
    }
    row.querySelector('.meta').textContent = [
      sent ? `to ${e.peer}` : `from ${e.peer}`,
      fmtSize(e.size),
      ago(e.at),
    ]
      .filter(Boolean)
      .join(' · ');
    list.appendChild(row);
  }
  contentEl.innerHTML = '';
  contentEl.appendChild(list);
}

// ----------------------------------------------------------------- browsing

async function openDir(dirPath) {
  selected.clear();
  filterText = '';
  category = 'all';
  searchEl.value = '';
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

// Images the renderer can decode straight from disk; everything else goes
// through QuickLook in the main process.
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i;

/**
 * The categories a phone file manager shows, because "where are my videos"
 * is a better question than "which folder did that land in".
 */
const CATEGORIES = [
  { id: 'all', label: 'All', icon: '🗂' },
  {
    id: 'image',
    label: 'Images',
    icon: '🖼',
    re: /\.(jpe?g|png|gif|webp|bmp|svg|avif|heic|heif|tiff?|raw|dng)$/i,
  },
  {
    id: 'video',
    label: 'Videos',
    icon: '🎬',
    re: /\.(mp4|mov|m4v|avi|mkv|webm|3gp|mpe?g|wmv|flv)$/i,
  },
  {
    id: 'audio',
    label: 'Audio',
    icon: '🎵',
    re: /\.(mp3|m4a|aac|wav|flac|ogg|opus|aiff?|wma|amr)$/i,
  },
  {
    id: 'doc',
    label: 'Documents',
    icon: '📄',
    re: /\.(pdf|docx?|xlsx?|pptx?|pages|numbers|key|txt|md|rtf|csv|epub|odt|ods|odp)$/i,
  },
  {
    id: 'archive',
    label: 'Archives',
    icon: '🗜',
    re: /\.(zip|rar|7z|tar|gz|bz2|xz|dmg|iso|apk)$/i,
  },
  { id: 'other', label: 'Other', icon: '📦' },
];

function categoryOf(entry) {
  if (entry.isDir) return 'folder';
  const hit = CATEGORIES.find((c) => c.re && c.re.test(entry.name));
  return hit ? hit.id : 'other';
}

/**
 * Folders always sort first -- a file explorer that mixes them by size is
 * technically consistent and useless in practice.
 */
function visibleEntries() {
  const needle = filterText.trim().toLowerCase();
  let rows = needle
    ? currentEntries.filter((e) => e.name.toLowerCase().includes(needle))
    : currentEntries.slice();

  // Picking a category means you're looking for files of a kind, so the
  // folders in this listing stop being useful and get out of the way.
  if (category !== 'all') {
    rows = rows.filter((e) => !e.isDir && categoryOf(e) === category);
  }

  const dir = sortAsc ? 1 : -1;
  rows.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (sortKey === 'size') return dir * ((a.size || 0) - (b.size || 0));
    // A cabled phone's listing has no timestamps, so date falls back to name.
    if (sortKey === 'date' && a.mtime != null && b.mtime != null) {
      return dir * (a.mtime - b.mtime);
    }
    return dir * a.name.localeCompare(b.name);
  });
  return rows;
}

function renderCategoryBar() {
  catBar.innerHTML = '';
  const files = currentEntries.filter((e) => !e.isDir);
  const counts = new Map();
  for (const f of files) {
    counts.set(categoryOf(f), (counts.get(categoryOf(f)) || 0) + 1);
  }

  for (const cat of CATEGORIES) {
    const count = cat.id === 'all' ? files.length : counts.get(cat.id) || 0;
    // Don't offer a category this folder has nothing in — except the one
    // that's selected, or the list would jump out from under the click.
    if (!count && cat.id !== category) continue;
    const chip = document.createElement('button');
    chip.className = `chip${cat.id === category ? ' sel' : ''}`;
    chip.textContent = `${cat.icon} ${cat.label}`;
    const badge = document.createElement('span');
    badge.className = 'count';
    badge.textContent = count;
    chip.appendChild(badge);
    chip.onclick = () => {
      category = cat.id;
      renderEntries();
    };
    catBar.appendChild(chip);
  }
}

const THUMB_BUDGET = 80;
let thumbsRequested = 0;

function renderEntries() {
  renderCategoryBar();
  thumbsRequested = 0;
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

  const rows = visibleEntries();
  if (!rows.length) {
    const label = CATEGORIES.find((c) => c.id === category)?.label;
    const what = filterText
      ? `“${filterText.replace(/[<&]/g, '')}”`
      : `any ${label?.toLowerCase() ?? 'files'}`;
    contentEl.innerHTML =
      `<div class="blank"><div class="big">🔍</div><div>This folder has no ${
        filterText ? 'match for ' : ''
      }${what}.</div></div>`;
    updateToolbar();
    return;
  }
  for (const entry of rows) contentEl.appendChild(renderEntry(entry));
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

  // Thumbnails only work for files this Mac can actually read; a phone's
  // files would each have to be pulled first, which a listing shouldn't do.
  const local = selection.kind === 'mac' && !entry.isDir;
  const icon = document.createElement('span');
  icon.className = 'ficon';
  icon.textContent = entry.isDir
    ? '📁'
    : CATEGORIES.find((c) => c.id === categoryOf(entry))?.icon ?? '📄';
  row.appendChild(icon);

  if (local && IMAGE_RE.test(entry.name)) {
    // Straight from disk: no round trip, and it's already an image. It has to
    // go into the document now rather than on load -- a lazy image that isn't
    // in the DOM never loads at all.
    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.loading = 'lazy';
    thumb.src = `file://${encodeURI(entry.path)}`;
    thumb.onerror = () => thumb.replaceWith(icon);
    icon.replaceWith(thumb);
  } else if (local) {
    // QuickLook can preview a video frame or a PDF's first page. It costs a
    // process per file, so it's capped to what's plausibly on screen.
    if (thumbsRequested < THUMB_BUDGET) {
      thumbsRequested += 1;
      beam.thumb(entry.path, 128).then((p) => {
        if (!p || !icon.isConnected) return;
        const thumb = document.createElement('img');
        thumb.className = 'thumb';
        thumb.src = `file://${encodeURI(p)}`;
        thumb.onload = () => icon.replaceWith(thumb);
      });
    }
  }

  const nm = document.createElement('span');
  nm.className = `nm ${entry.isDir ? 'dir' : 'file'}`;
  nm.textContent = entry.name;
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
    if (paths.length) await sendOverWifi(selection.device, paths);
  });
  updateToolbar();
}

/** Shared by the drop target and the retry button. */
async function sendOverWifi(device, paths) {
  const target = device;
  setStatus(`Sending to ${target.name}…`);
  const { sent, failed } = await wifi.send(target, paths);
  setProgress(null);
  if (!failed.length) {
    setStatus(`Sent ${sent.length} file${sent.length === 1 ? '' : 's'} to ${target.name}`);
    renderRetry(null);
    return;
  }
  setStatus(
    `Sent ${sent.length}, ${failed.length} failed — ${failed[0].message}`
  );
  renderRetry({ device: target, failed });
}

/**
 * A failed file is usually one glitch away from working, so offer exactly the
 * files that failed rather than making the whole batch happen again.
 */
function renderRetry(state) {
  const existing = $('retry-bar');
  if (existing) existing.remove();
  if (!state) return;

  const bar = document.createElement('div');
  bar.id = 'retry-bar';
  bar.className = 'retry';
  bar.innerHTML = `<span class="txt"></span>
    <button class="tool" id="retry-dismiss">Dismiss</button>
    <button class="tool primary" id="retry-go">Retry ${state.failed.length}</button>`;
  bar.querySelector('.txt').textContent = state.failed
    .map((f) => f.name)
    .join(', ');
  contentEl.parentElement.insertBefore(bar, contentEl.nextSibling);
  $('retry-dismiss').onclick = () => renderRetry(null);
  $('retry-go').onclick = () => {
    renderRetry(null);
    sendOverWifi(state.device, state.failed.map((f) => f.path));
  };
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
  for (const el of [searchEl, sortKeyEl, sortDirEl]) {
    el.style.display = browsing ? '' : 'none';
  }
  catBar.style.display = browsing ? '' : 'none';

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
  if (ev.type === 'awaiting-approval') {
    setStatus(`Waiting for ${ev.device} to accept — code ${ev.code}`);
  } else if (ev.type === 'start') {
    setStatus(`Sending ${ev.name} (${ev.index + 1} of ${ev.total})…`);
  } else if (ev.type === 'done' && ev.pct != null) {
    setProgress(ev.pct);
  } else if (ev.type === 'error') {
    setStatus(`Failed on ${ev.name}: ${ev.message}`);
  }
});

// Incoming requests: the prompt itself is a native dialog, but the status bar
// echoes it so the code is visible without hunting for the window.
beam.onApprovalPending((d) =>
  setStatus(`${d.from} is asking to send ${d.files.length} file${
    d.files.length === 1 ? '' : 's'
  } — code ${d.code}`)
);
beam.onApprovalResolved((d) =>
  setStatus(d.accepted ? `Accepted transfer from ${d.from}` : `Declined transfer from ${d.from}`)
);
beam.onApprovalAuto((d) => setStatus(`Accepting ${d.files} file(s) from ${d.from} (trusted device)`));

beam.onTransferStart((d) => setStatus(`Receiving ${d.filename} from ${d.sender}…`));
beam.onTransferProgress((d) => {
  if (d.totalBytes) setProgress((d.receivedBytes / d.totalBytes) * 100);
});
beam.onTransferDone((d) => {
  setProgress(null);
  setStatus(`Received ${d.files.map((f) => f.name).join(', ')} from ${d.sender}`);
  if (selection?.kind === 'mac') openDir(currentPath);
  if (selection?.kind === 'recent') renderRecent();
});
beam.onTransferError((d) => setStatus(`Transfer failed: ${d.message}`));

wifi.onFound(addWifiDevice);

searchEl.oninput = () => {
  filterText = searchEl.value;
  if (selection?.kind === 'mac' || isUsb()) renderEntries();
};

sortKeyEl.value = sortKey;
sortDirEl.textContent = sortAsc ? '↑' : '↓';
sortKeyEl.onchange = () => {
  sortKey = sortKeyEl.value;
  localStorage.setItem('sortKey', sortKey);
  if (selection?.kind === 'mac' || isUsb()) renderEntries();
};
sortDirEl.onclick = () => {
  sortAsc = !sortAsc;
  localStorage.setItem('sortAsc', String(sortAsc));
  sortDirEl.textContent = sortAsc ? '↑' : '↓';
  if (selection?.kind === 'mac' || isUsb()) renderEntries();
};

$('refresh-usb').onclick = refreshUsb;
$('refresh-wifi').onclick = refreshWifi;
$('add-wifi').onclick = connectByIp;

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
