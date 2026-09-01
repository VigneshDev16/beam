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
  deviceId: string;
}

/** An incoming transfer waiting for the user to accept or decline. */
export interface ApprovalRequest {
  id: string;
  from: string;
  code: string;
  canTrust: boolean;
  files: { name: string; size: number }[];
}

export function startReceiver(): Promise<ReceiverInfo> {
  return BeamReceiver.start();
}

export function stopReceiver(): Promise<void> {
  return BeamReceiver.stop();
}

/** This install's stable id, sent with offers so receivers can remember us. */
export function getDeviceId(): Promise<string> {
  return BeamReceiver.getDeviceId();
}

export function respondToOffer(
  id: string,
  accepted: boolean,
  trust: boolean,
): Promise<boolean> {
  return BeamReceiver.respondToOffer(id, accepted, trust);
}

function subscribe<T>(event: string, cb: (v: T) => void): () => void {
  const emitter = new NativeEventEmitter(BeamReceiver);
  const sub = emitter.addListener(event, cb);
  return () => sub.remove();
}

export const onFileReceived = (cb: (f: ReceivedFile) => void) =>
  subscribe<ReceivedFile>('beamReceived', cb);

export const onApprovalRequest = (cb: (r: ApprovalRequest) => void) =>
  subscribe<ApprovalRequest>('beamApprovalRequest', cb);
