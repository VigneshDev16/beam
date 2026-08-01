import { NativeEventEmitter, NativeModules } from 'react-native';

const { BeamReceiver } = NativeModules;

export interface ReceivedFile {
  name: string;
  uri: string;
  sender: string;
}

export interface ReceiverInfo {
  port: number;
  name: string;
}

export function startReceiver(): Promise<ReceiverInfo> {
  return BeamReceiver.start();
}

export function stopReceiver(): Promise<void> {
  return BeamReceiver.stop();
}

export function onFileReceived(cb: (f: ReceivedFile) => void): () => void {
  const emitter = new NativeEventEmitter(BeamReceiver);
  const sub = emitter.addListener('beamReceived', cb);
  return () => sub.remove();
}
