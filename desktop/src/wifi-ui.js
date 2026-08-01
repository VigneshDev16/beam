const wifiDevicesEl = document.getElementById('wifi-devices');
const wifiDropEl = document.getElementById('wifi-drop');
const wifiStatusEl = document.getElementById('wifi-status');
const wifiBar = document.getElementById('wifi-bar');

let wifiTarget = null;

async function scanWifi() {
  wifiDevicesEl.innerHTML = '<div class="empty">Scanning your network…</div>';
  const { devices, error } = await wifi.scan();

  wifiDevicesEl.innerHTML = '';
  if (error === 'not-on-network') {
    wifiDevicesEl.innerHTML = '<div class="err">This Mac is not on a network.</div>';
    return;
  }
  if (!devices.length) {
    wifiDevicesEl.innerHTML =
      '<div class="empty">No phones found. Open Beam on the phone and turn on "Receive files".</div>';
    return;
  }

  for (const d of devices) {
    const el = document.createElement('div');
    el.className = 'device';
    el.innerHTML = `<div class="name">📱 ${d.name}</div>
      <div class="why">${d.ip} · ${d.platform || 'phone'}</div>`;
    el.onclick = () => {
      wifiTarget = d;
      for (const n of wifiDevicesEl.querySelectorAll('.device')) n.classList.remove('sel');
      el.classList.add('sel');
      wifiStatusEl.textContent = `Ready to send to ${d.name}`;
    };
    wifiDevicesEl.appendChild(el);
    if (!wifiTarget) el.onclick();
  }
}

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

// Accepting a drop anywhere in the window would swallow drags meant for the
// cable browser, so each zone opts in explicitly.
function wireDropzone(el, onFiles) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over');
    const paths = pathsFromDrop(e);
    if (paths.length) onFiles(paths);
  });
}

wireDropzone(wifiDropEl, async (paths) => {
  if (!wifiTarget) {
    wifiStatusEl.textContent = 'Pick a phone first, then drop the files again.';
    return;
  }
  wifiBar.style.display = 'block';
  wifiBar.firstElementChild.style.width = '10%';
  const sent = await wifi.send(wifiTarget, paths);
  wifiBar.style.display = 'none';
  wifiBar.firstElementChild.style.width = '0%';
  wifiStatusEl.textContent =
    sent.length === paths.length
      ? `Sent ${sent.length} file${sent.length === 1 ? '' : 's'} to ${wifiTarget.name}`
      : `Sent ${sent.length} of ${paths.length} — see errors above`;
});

wifi.onProgress((ev) => {
  if (ev.type === 'start') {
    wifiStatusEl.textContent = `Sending ${ev.name} (${ev.index + 1} of ${ev.total})…`;
    wifiBar.firstElementChild.style.width = `${
      ((ev.index + 0.5) / ev.total) * 100
    }%`;
  } else if (ev.type === 'error') {
    wifiStatusEl.textContent = `Failed on ${ev.name}: ${ev.message}`;
  }
});

document.getElementById('wifi-rescan').onclick = scanWifi;
scanWifi();
