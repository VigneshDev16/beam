import { Platform } from 'react-native';
import { BeamDevice } from './discovery';
import { getDeviceId } from './receiver';

export interface PickedFile {
  uri: string;
  name: string;
  type: string;
  size: number | null;
}

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
}

const SENDER_NAME = Platform.OS === 'android' ? 'Android Phone' : 'iPhone';

/**
 * Ask the receiver for permission before sending anything.
 * Resolves to a token, or null if the receiver is too old to support offers —
 * in which case it will prompt its own user when the upload arrives.
 */
export async function requestApproval(
  target: BeamDevice,
  files: PickedFile[],
  onCode: (code: string) => void,
): Promise<string | null> {
  let deviceId: string | null = null;
  try {
    deviceId = await getDeviceId();
  } catch {
    // Older native module: we can still ask, just never get remembered.
  }

  let offer: any;
  try {
    const res = await fetch(`http://${target.ip}:${target.port}/offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: SENDER_NAME,
        deviceId,
        platform: Platform.OS,
        files: files.map((f) => ({ name: f.name, size: f.size ?? 0 })),
      }),
    });
    if (res.status === 404) return null; // receiver predates approval
    offer = await res.json();
  } catch {
    return null;
  }

  if (offer?.status === 'accepted' && offer.token) return offer.token;
  if (!offer?.id) return null;

  onCode(offer.code);

  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 1000));
    const res = await fetch(`http://${target.ip}:${target.port}/offer/${offer.id}`);
    const state = await res.json();
    if (state.status === 'accepted') return state.token;
    if (state.status === 'declined') {
      throw new Error(`${target.name} declined the transfer`);
    }
    if (state.status === 'expired') break;
  }
  throw new Error(`${target.name} did not respond`);
}

export function uploadFiles(
  target: BeamDevice,
  files: PickedFile[],
  onProgress: (p: UploadProgress) => void,
  token?: string | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    // Unique field name per file — NanoHTTPD on Android receivers needs
    // distinct keys to keep every file.
    files.forEach((f, i) => {
      form.append(`file${i}`, {
        uri: f.uri,
        name: f.name,
        type: f.type || 'application/octet-stream',
      } as any);
    });

    const query = token ? `&token=${encodeURIComponent(token)}` : '';
    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `http://${target.ip}:${target.port}/upload?from=${encodeURIComponent(
        SENDER_NAME,
      )}${query}`,
    );
    xhr.timeout = 10 * 60 * 1000;

    xhr.upload.onprogress = (e) => {
      onProgress({ sentBytes: e.loaded, totalBytes: e.total });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else if (xhr.status === 403) reject(new Error('The other device declined'));
      else reject(new Error(`Receiver returned ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));

    xhr.send(form);
  });
}
