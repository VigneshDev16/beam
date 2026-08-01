const transfersEl = document.getElementById('transfers');
const filesEl = document.getElementById('files');
const active = new Map(); // id -> {itemEl, barEl, metaEl}

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function clearEmpty(el) {
  const empty = el.querySelector('.empty');
  if (empty) empty.remove();
}

beam.getState().then((s) => {
  document.getElementById('device-name').textContent =
    `"${s.name}" — saving to ${s.saveDir}`;
  document.getElementById('addr').textContent = s.ips.length
    ? s.ips.map((ip) => `${ip}:${s.port}`).join('   ')
    : 'No Wi-Fi connection found';
});

beam.onTransferStart((d) => {
  clearEmpty(transfersEl);
  let t = active.get(d.id);
  if (!t) {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `
      <div class="name"></div>
      <div class="bar"><div></div></div>
      <div class="meta"></div>`;
    transfersEl.prepend(item);
    t = { itemEl: item, barEl: item.querySelector('.bar > div'), metaEl: item.querySelector('.meta') };
    active.set(d.id, t);
  }
  t.itemEl.querySelector('.name').textContent = `${d.filename} — from ${d.sender}`;
});

beam.onTransferProgress((d) => {
  const t = active.get(d.id);
  if (!t) return;
  if (d.totalBytes > 0) {
    const pct = Math.min(100, (d.receivedBytes / d.totalBytes) * 100);
    t.barEl.style.width = `${pct}%`;
    t.metaEl.textContent = `${fmtBytes(d.receivedBytes)} of ${fmtBytes(d.totalBytes)}`;
  } else {
    t.metaEl.textContent = fmtBytes(d.receivedBytes);
  }
});

// Shared by the Wi-Fi receiver and the cable copier (see cable-ui.js).
function addReceivedFiles(files) {
  if (!files.length) return;
  clearEmpty(filesEl);
  for (const f of files) {
    const item = document.createElement('div');
    item.className = 'item file-link';
    item.textContent = `✓ ${f.name}`;
    item.title = 'Click to show in Finder, or drag it anywhere';
    item.onclick = () => beam.openFile(f.path);
    // Already on disk, so this drags straight out with no copy step.
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.preventDefault();
      beam.startDrag(f.path);
    });
    filesEl.prepend(item);
  }
}

beam.onTransferDone((d) => {
  const t = active.get(d.id);
  if (t) {
    t.itemEl.remove();
    active.delete(d.id);
  }
  if (transfersEl.children.length === 0) {
    transfersEl.innerHTML = '<div class="empty">Nothing incoming yet.</div>';
  }
  addReceivedFiles(d.files);
});

beam.onTransferError((d) => {
  const t = active.get(d.id);
  if (t) {
    t.metaEl.textContent = `Failed: ${d.message}`;
    t.barEl.style.background = '#e5484d';
  }
});
