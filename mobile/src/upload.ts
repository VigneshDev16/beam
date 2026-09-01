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
  /** Which file in the batch, and how far the batch as a whole has got. */
  index: number;
  name: string;
  sentBytes: number;
  totalBytes: number;
  pct: number;
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

export interface UploadResult {
  sent: PickedFile[];
  failed: { file: PickedFile; message: string }[];
}

function uploadOne(
  target: BeamDevice,
  file: PickedFile,
  field: string,
  token: string | null | undefined,
  onBytes: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    // Unique field name per file — NanoHTTPD on Android receivers needs
    // distinct keys to keep every file.
    form.append(field, {
      uri: file.uri,
      name: file.name,
      type: file.type || 'application/octet-stream',
    } as any);

    const query = token ? `&token=${encodeURIComponent(token)}` : '';
    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `http://${target.ip}:${target.port}/upload?from=${encodeURIComponent(
        SENDER_NAME,
      )}${query}`,
    );
    xhr.timeout = 10 * 60 * 1000;

    xhr.upload.onprogress = (e) => onBytes(e.loaded, e.total);
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

/**
 * One request per file. A batch used to be a single upload, which meant one
 * dropped connection lost all of it and there was no way to retry just the
 * part that failed. The approval token is good for as many uploads as the
 * offer declared files, so this stays within what the receiver granted.
 */
export async function uploadFiles(
  target: BeamDevice,
  files: PickedFile[],
  onProgress: (p: UploadProgress) => void,
  token?: string | null,
): Promise<UploadResult> {
  const sent: PickedFile[] = [];
  const failed: UploadResult['failed'] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      await uploadOne(target, file, `file${i}`, token, (loaded, total) => {
        const share = total > 0 ? loaded / total : 0;
        onProgress({
          index: i,
          name: file.name,
          sentBytes: loaded,
          totalBytes: total,
          pct: ((i + share) / files.length) * 100,
        });
      });
      sent.push(file);
      onProgress({
        index: i,
        name: file.name,
        sentBytes: file.size ?? 0,
        totalBytes: file.size ?? 0,
        pct: ((i + 1) / files.length) * 100,
      });
    } catch (e: any) {
      failed.push({ file, message: e?.message ?? 'Upload failed' });
    }
  }
  return { sent, failed };
}
