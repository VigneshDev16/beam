import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import { pick } from '@react-native-documents/picker';
import {
  BeamDevice,
  deviceKey,
  getWifiIp,
  isPhone,
  scanForDevices,
} from './src/discovery';
import {
  ReceivedFile,
  onFileReceived,
  startReceiver,
  stopReceiver,
} from './src/receiver';
import { PickedFile, uploadFiles } from './src/upload';

type SendState =
  | { phase: 'idle' }
  | { phase: 'sending'; pct: number }
  | { phase: 'done'; count: number }
  | { phase: 'error'; message: string };

function fmtBytes(n: number | null): string {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function BeamApp() {
  const [devices, setDevices] = useState<BeamDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [send, setSend] = useState<SendState>({ phase: 'idle' });
  const [receiving, setReceiving] = useState(false);
  const [receiverLabel, setReceiverLabel] = useState<string | null>(null);
  const [received, setReceived] = useState<ReceivedFile[]>([]);
  const scanRunning = useRef(false);

  const runScan = useCallback(async () => {
    if (scanRunning.current) return;
    scanRunning.current = true;
    setScanning(true);
    setScanError(null);
    setDevices([]);
    try {
      await scanForDevices((d) => {
        setDevices((prev) =>
          prev.some((p) => deviceKey(p) === deviceKey(d)) ? prev : [...prev, d],
        );
        setSelectedKey((cur) => cur ?? deviceKey(d));
      });
    } catch (e: any) {
      setScanError(
        e?.message === 'not-on-wifi'
          ? 'Connect this phone to the same Wi-Fi as your other device.'
          : `Scan failed: ${e?.message}`,
      );
    } finally {
      setScanning(false);
      scanRunning.current = false;
    }
  }, []);

  useEffect(() => {
    runScan();
  }, [runScan]);

  useEffect(() => {
    if (!receiving) return;
    const unsubscribe = onFileReceived((f) => {
      setReceived((prev) => [f, ...prev]);
    });
    return unsubscribe;
  }, [receiving]);

  const toggleReceive = useCallback(async (on: boolean) => {
    try {
      if (on) {
        const info = await startReceiver();
        const ip = await getWifiIp();
        setReceiverLabel(`Visible as “${info.name}” (${ip ?? '?'})`);
        setReceiving(true);
      } else {
        await stopReceiver();
        setReceiving(false);
        setReceiverLabel(null);
      }
    } catch (e: any) {
      console.warn('receiver toggle failed', e?.code, e?.message);
      setReceiverLabel(`Could not start: ${e?.message}`);
      setReceiving(false);
    }
  }, []);

  const pickFiles = useCallback(async () => {
    try {
      const results = await pick({ allowMultiSelection: true });
      const picked: PickedFile[] = results.map((r: any) => ({
        uri: r.uri,
        name: r.name ?? 'file',
        type: r.type ?? 'application/octet-stream',
        size: r.size ?? null,
      }));
      setFiles((prev) => {
        const known = new Set(prev.map((f) => f.uri));
        return [...prev, ...picked.filter((f) => !known.has(f.uri))];
      });
      setSend({ phase: 'idle' });
    } catch (e: any) {
      // user cancelling is normal; anything else we want to know about
      if (e?.code !== 'OPERATION_CANCELED') {
        console.warn('picker error', e?.code, e?.message);
      }
    }
  }, []);

  const doSend = useCallback(async () => {
    const target = devices.find((d) => deviceKey(d) === selectedKey);
    if (!target || files.length === 0) return;
    setSend({ phase: 'sending', pct: 0 });
    try {
      await uploadFiles(target, files, (p) => {
        const pct = p.totalBytes > 0 ? (p.sentBytes / p.totalBytes) * 100 : 0;
        setSend({ phase: 'sending', pct });
      });
      setSend({ phase: 'done', count: files.length });
      setFiles([]);
    } catch (e: any) {
      setSend({ phase: 'error', message: e?.message ?? 'Upload failed' });
    }
  }, [devices, selectedKey, files]);

  const sending = send.phase === 'sending';
  const canSend = !!selectedKey && files.length > 0 && !sending;

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#111318" />
      <Text style={s.title}>Beam</Text>
      <Text style={s.subtitle}>Share files over Wi-Fi — no cloud, no cables</Text>

      <View style={s.card}>
        <View style={s.rowBetween}>
          <Text style={s.label}>SEND TO</Text>
          {scanning ? (
            <ActivityIndicator size="small" color="#6d93ff" />
          ) : (
            <Pressable onPress={runScan} disabled={sending}>
              <Text style={s.linkBtn}>Rescan</Text>
            </Pressable>
          )}
        </View>
        {scanError ? <Text style={s.error}>{scanError}</Text> : null}
        {!scanError && devices.length === 0 ? (
          <Text style={s.muted}>
            {scanning
              ? 'Scanning your network…'
              : 'No devices found. Open Beam on the other device.'}
          </Text>
        ) : null}
        {devices.map((d) => (
          <Pressable
            key={deviceKey(d)}
            style={[s.device, selectedKey === deviceKey(d) && s.deviceSelected]}
            onPress={() => setSelectedKey(deviceKey(d))}
            disabled={sending}
          >
            <Text style={s.deviceName}>
              {isPhone(d) ? '📱' : '💻'} {d.name}
            </Text>
            <Text style={s.deviceIp}>{d.ip}</Text>
          </Pressable>
        ))}
      </View>

      <View style={[s.card, s.grow]}>
        <View style={s.rowBetween}>
          <Text style={s.label}>FILES TO SEND</Text>
          <Pressable onPress={pickFiles} disabled={sending}>
            <Text style={s.linkBtn}>+ Add files</Text>
          </Pressable>
        </View>
        {files.length === 0 ? (
          <Text style={s.muted}>Nothing selected yet.</Text>
        ) : (
          <FlatList
            data={files}
            keyExtractor={(f) => f.uri}
            renderItem={({ item }) => (
              <View style={s.fileRow}>
                <Text style={s.fileName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={s.fileSize}>{fmtBytes(item.size)}</Text>
                {!sending && (
                  <Pressable
                    onPress={() =>
                      setFiles((prev) => prev.filter((f) => f.uri !== item.uri))
                    }
                  >
                    <Text style={s.remove}>✕</Text>
                  </Pressable>
                )}
              </View>
            )}
          />
        )}
      </View>

      <View style={s.card}>
        <View style={s.rowBetween}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>RECEIVE FILES</Text>
            <Text
              style={receiving || !receiverLabel ? s.muted : s.error}
              numberOfLines={2}
            >
              {receiverLabel ?? 'Let other devices send to this phone'}
            </Text>
          </View>
          <Pressable
            style={[s.receiveBtn, receiving && s.receiveBtnOn]}
            onPress={() => toggleReceive(!receiving)}
          >
            <Text style={s.receiveBtnText}>{receiving ? 'On' : 'Turn on'}</Text>
          </Pressable>
        </View>
        {received.slice(0, 3).map((f, i) => (
          <Text key={`${f.uri}-${i}`} style={s.receivedRow} numberOfLines={1}>
            ↓ {f.name} — from {f.sender}
          </Text>
        ))}
      </View>

      {send.phase === 'sending' && (
        <View style={s.progressWrap}>
          <View style={[s.progressBar, { width: `${send.pct}%` }]} />
        </View>
      )}
      {send.phase === 'done' && (
        <Text style={s.success}>
          ✓ Sent {send.count} file{send.count === 1 ? '' : 's'}
        </Text>
      )}
      {send.phase === 'error' && <Text style={s.error}>{send.message}</Text>}

      <Pressable
        style={[s.sendBtn, !canSend && s.sendBtnDisabled]}
        onPress={doSend}
        disabled={!canSend}
      >
        <Text style={s.sendBtnText}>
          {sending
            ? `Sending… ${Math.round(send.phase === 'sending' ? send.pct : 0)}%`
            : 'Send'}
        </Text>
      </Pressable>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <BeamApp />
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111318', padding: 20 },
  title: { color: '#eceff3', fontSize: 26, fontWeight: '700', marginTop: 8 },
  subtitle: { color: '#9aa3af', fontSize: 13, marginBottom: 16 },
  card: {
    backgroundColor: '#1b1f27',
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
  },
  grow: { flex: 1 },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
    gap: 10,
  },
  label: { color: '#9aa3af', fontSize: 11, letterSpacing: 1, marginBottom: 4 },
  linkBtn: { color: '#6d93ff', fontSize: 13, fontWeight: '600' },
  muted: { color: '#788088', fontSize: 13, paddingVertical: 2 },
  error: { color: '#ff7a7f', fontSize: 13, paddingVertical: 6 },
  success: {
    color: '#4cc27a',
    fontSize: 14,
    paddingVertical: 6,
    textAlign: 'center',
  },
  device: {
    borderWidth: 1,
    borderColor: '#2c313a',
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
  },
  deviceSelected: { borderColor: '#6d93ff', backgroundColor: '#20283c' },
  deviceName: { color: '#eceff3', fontSize: 15, fontWeight: '600' },
  deviceIp: { color: '#788088', fontSize: 12, marginTop: 2 },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2c313a',
    gap: 10,
  },
  fileName: { color: '#dde2e8', fontSize: 14, flex: 1 },
  fileSize: { color: '#788088', fontSize: 12 },
  remove: { color: '#788088', fontSize: 15, paddingHorizontal: 4 },
  receiveBtn: {
    borderWidth: 1,
    borderColor: '#4f7cff',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  receiveBtnOn: { backgroundColor: '#4f7cff', borderColor: '#4f7cff' },
  receiveBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  receivedRow: {
    color: '#4cc27a',
    fontSize: 13,
    paddingTop: 6,
  },
  progressWrap: {
    height: 6,
    backgroundColor: '#2c313a',
    borderRadius: 3,
    marginBottom: 12,
    overflow: 'hidden',
  },
  progressBar: { height: '100%', backgroundColor: '#6d93ff' },
  sendBtn: {
    backgroundColor: '#4f7cff',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#2c3646' },
  sendBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
