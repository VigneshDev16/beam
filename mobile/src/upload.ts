import { Platform } from 'react-native';
import { BeamDevice } from './discovery';

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

export function uploadFiles(
  target: BeamDevice,
  files: PickedFile[],
  onProgress: (p: UploadProgress) => void,
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

    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `http://${target.ip}:${target.port}/upload?from=${encodeURIComponent(SENDER_NAME)}`,
    );
    xhr.timeout = 10 * 60 * 1000;

    xhr.upload.onprogress = (e) => {
      onProgress({ sentBytes: e.loaded, totalBytes: e.total });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Receiver returned ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));

    xhr.send(form);
  });
}
