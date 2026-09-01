import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
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
  probeAddress,
  scanForDevices,
} from './src/discovery';
import {
  HistoryEntry,
  KnownDevice,
  clearHistory,
  history,
  knownDevices,
  recordTransfer,
  rememberDevice,
} from './src/store';
import {
  ApprovalRequest,
  ReceivedFile,
  onApprovalRequest,
  onFileReceived,
  respondToOffer,
  startReceiver,
  stopReceiver,
} from './src/receiver';
import { PickedFile, requestApproval, uploadFiles } from './src/upload';

type Failure = { file: PickedFile; message: string };

type SendState =
  | { phase: 'idle' }
  | { phase: 'waiting'; code: string }
  | { phase: 'sending'; pct: number; name: string; index: number; total: number }
  | { phase: 'done'; count: number }
  | { phase: 'partial'; sent: number; failed: Failure[] }
  | { phase: 'error'; message: string };

function fmtBytes(n: number | null): string {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** "3m ago" / "yesterday" — enough to tell stale from current. */
function ago(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
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
  const [incoming, setIncoming] = useState<ApprovalRequest | null>(null);
  const [trustSender, setTrustSender] = useState(false);
  const [remembered, setRemembered] = useState<KnownDevice[]>([]);
  const [ipPrompt, setIpPrompt] = useState(false);
  const [ipInput, setIpInput] = useState('');
  const [ipError, setIpError] = useState<string | null>(null);
  const [recent, setRecent] = useState<HistoryEntry[] | null>(null);
  const scanRunning = useRef(false);

  const runScan = useCallback(async () => {
    if (scanRunning.current) return;
    scanRunning.current = true;
    setScanning(true);
    setScanError(null);
    setDevices([]);
    try {
      const known = await knownDevices();
      setRemembered(known);
      await scanForDevices((d) => {
        setDevices((prev) =>
          prev.some((p) => deviceKey(p) === deviceKey(d)) ? prev : [...prev, d],
        );
        setSelectedKey((cur) => cur ?? deviceKey(d));
        rememberDevice(d);
      }, known.map((k) => k.ip));
      setRemembered(await knownDevices());
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

  /** Ask one address directly, and select it if something answers. */
  const addByAddress = useCallback(async (address: string) => {
    const { device, error } = await probeAddress(address);
    if (!device) return error;
    await rememberDevice(device);
    setDevices((prev) =>
      prev.some((p) => deviceKey(p) === deviceKey(device)) ? prev : [...prev, device],
    );
    setSelectedKey(deviceKey(device));
    setRemembered(await knownDevices());
    return null;
  }, []);

  const openRecent = useCallback(async () => setRecent(await history()), []);

  useEffect(() => {
    if (!receiving) return;
    const unsubscribe = onFileReceived((f) => {
      setReceived((prev) => [f, ...prev]);
      recordTransfer({
        direction: 'received',
        name: f.name,
        size: null,
        peer: f.sender,
      });
    });
    return unsubscribe;
  }, [receiving]);

  // Someone wants to send us something. Queue depth of one is fine here:
  // a second request while a prompt is open simply waits its turn.
  useEffect(() => {
    if (!receiving) return;
    const unsubscribe = onApprovalRequest((req) => {
      setTrustSender(false);
      setIncoming(req);
    });
    return unsubscribe;
  }, [receiving]);

  const answerIncoming = useCallback(
    async (accepted: boolean) => {
      const req = incoming;
      setIncoming(null);
      if (!req) return;
      try {
        await respondToOffer(req.id, accepted, accepted && trustSender);
      } catch (e: any) {
        console.warn('respondToOffer failed', e?.message);
      }
    },
    [incoming, trustSender],
  );

  const toggleReceive = useCallback(async (on: boolean) => {
    try {
      if (on) {
        // Android 13+ won't show the "ready to receive" notification, or tell
        // you a file arrived, without this. Declining is not fatal.
        if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
          await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
          );
        }
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

  const sendList = useCallback(
    async (list: PickedFile[]) => {
      const target = devices.find((d) => deviceKey(d) === selectedKey);
      if (!target || list.length === 0) return;
      setSend({ phase: 'sending', pct: 0, name: list[0].name, index: 0, total: list.length });
      try {
        const token = await requestApproval(target, list, (code) =>
          setSend({ phase: 'waiting', code }),
        );
        const { sent, failed } = await uploadFiles(
          target,
          list,
          (p) =>
            setSend({
              phase: 'sending',
              pct: p.pct,
              name: p.name,
              index: p.index,
              total: list.length,
            }),
          token,
        );
        for (const f of sent) {
          await recordTransfer({
            direction: 'sent',
            name: f.name,
            size: f.size,
            peer: target.name,
          });
        }
        if (failed.length) {
          // Keep the failures selected so Retry has something to send.
          setFiles(failed.map((f) => f.file));
          setSend({ phase: 'partial', sent: sent.length, failed });
        } else {
          setFiles([]);
          setSend({ phase: 'done', count: sent.length });
        }
      } catch (e: any) {
        setSend({ phase: 'error', message: e?.message ?? 'Upload failed' });
      }
    },
    [devices, selectedKey],
  );

  const doSend = useCallback(() => sendList(files), [sendList, files]);

  const sending = send.phase === 'sending' || send.phase === 'waiting';
  const canSend = !!selectedKey && files.length > 0 && !sending;

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#111318" />
      <Text style={s.title}>Beam</Text>
      <Text style={s.subtitle}>Share files over Wi-Fi — no cloud, no cables</Text>

      <View style={s.card}>
        <View style={s.rowBetween}>
          <Text style={s.label}>SEND TO</Text>
          <View style={s.headerActions}>
            <Pressable
              onPress={() => {
                setIpError(null);
                setIpInput('');
                setIpPrompt(true);
              }}
              disabled={sending}
            >
              <Text style={s.linkBtn}>By IP</Text>
            </Pressable>
            {scanning ? (
              <ActivityIndicator size="small" color="#6d93ff" />
            ) : (
              <Pressable onPress={runScan} disabled={sending}>
                <Text style={s.linkBtn}>Rescan</Text>
              </Pressable>
            )}
          </View>
        </View>
        {scanError ? <Text style={s.error}>{scanError}</Text> : null}
        {!scanError && devices.length === 0 ? (
          <Text style={s.muted}>
            {scanning
              ? 'Scanning your network…'
              : remembered.length
              ? 'Nothing answered. Tap a device below to try its last address.'
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
        {/* Devices we've used before that haven't answered yet. Tapping one
            asks its last address directly, which beats another full sweep. */}
        {remembered
          .filter(
            (k) =>
              !devices.some((d) => d.name.toLowerCase() === k.name.toLowerCase()),
          )
          .map((k) => (
            <Pressable
              key={k.key}
              style={[s.device, s.deviceAsleep]}
              onPress={async () => {
                const error = await addByAddress(`${k.ip}:${k.port}`);
                if (error) runScan();
              }}
              disabled={sending}
            >
              <Text style={s.deviceName}>💤 {k.name}</Text>
              <Text style={s.deviceIp}>Last seen {ago(k.lastSeen)}</Text>
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
            <View style={s.rowStart}>
              <Text style={s.label}>RECEIVE FILES</Text>
              <Pressable onPress={openRecent}>
                <Text style={s.linkBtnSmall}>Recent</Text>
              </Pressable>
            </View>
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

      {send.phase === 'waiting' && (
        <Text style={s.waiting}>
          Waiting for the other device to accept — code {send.code}
        </Text>
      )}
      {send.phase === 'sending' && (
        <>
          <Text style={s.muted} numberOfLines={1}>
            {send.name} — {send.index + 1} of {send.total}
          </Text>
          <View style={s.progressWrap}>
            <View style={[s.progressBar, { width: `${send.pct}%` }]} />
          </View>
        </>
      )}
      {send.phase === 'partial' && (
        <View style={s.partial}>
          <Text style={s.error} numberOfLines={2}>
            Sent {send.sent}, {send.failed.length} failed —{' '}
            {send.failed[0].message}
          </Text>
          <Pressable onPress={() => sendList(send.failed.map((f) => f.file))}>
            <Text style={s.linkBtn}>Retry {send.failed.length}</Text>
          </Pressable>
        </View>
      )}
      {send.phase === 'done' && (
        <Text style={s.success}>
          ✓ Sent {send.count} file{send.count === 1 ? '' : 's'}
        </Text>
      )}
      {send.phase === 'error' && <Text style={s.error}>{send.message}</Text>}

      <Modal
        visible={ipPrompt}
        transparent
        animationType="fade"
        onRequestClose={() => setIpPrompt(false)}
      >
        <View style={s.backdrop}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>Connect by IP</Text>
            <Text style={s.codeHint}>
              For when the scan can't see the other device — guest Wi-Fi, or a
              network that blocks device-to-device traffic. The address is on
              the other device's Beam window.
            </Text>
            <TextInput
              style={s.input}
              value={ipInput}
              onChangeText={setIpInput}
              placeholder="192.168.0.9"
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
            />
            {ipError ? <Text style={s.error}>{ipError}</Text> : null}
            <View style={s.sheetBtns}>
              <Pressable
                style={[s.sheetBtn, s.declineBtn]}
                onPress={() => setIpPrompt(false)}
              >
                <Text style={s.declineText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[s.sheetBtn, s.acceptBtn]}
                onPress={async () => {
                  const error = await addByAddress(ipInput);
                  if (error) setIpError(error);
                  else setIpPrompt(false);
                }}
              >
                <Text style={s.acceptText}>Connect</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={recent !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRecent(null)}
      >
        <View style={s.backdrop}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>Recent transfers</Text>
            {recent && recent.length === 0 ? (
              <Text style={s.codeHint}>
                Nothing yet. Files you send or receive show up here.
              </Text>
            ) : null}
            <FlatList
              style={s.recentList}
              data={recent ?? []}
              keyExtractor={(item, i) => `${item.at}-${i}`}
              renderItem={({ item }) => (
                <View style={s.recentRow}>
                  <Text
                    style={item.direction === 'sent' ? s.arrowOut : s.arrowIn}
                  >
                    {item.direction === 'sent' ? '↑' : '↓'}
                  </Text>
                  <Text style={s.recentName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={s.recentMeta}>
                    {item.direction === 'sent' ? 'to' : 'from'} {item.peer} ·{' '}
                    {ago(item.at)}
                  </Text>
                </View>
              )}
            />
            <View style={s.sheetBtns}>
              <Pressable
                style={[s.sheetBtn, s.declineBtn]}
                onPress={async () => {
                  await clearHistory();
                  setRecent([]);
                }}
              >
                <Text style={s.declineText}>Clear</Text>
              </Pressable>
              <Pressable
                style={[s.sheetBtn, s.acceptBtn]}
                onPress={() => setRecent(null)}
              >
                <Text style={s.acceptText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!incoming}
        transparent
        animationType="fade"
        onRequestClose={() => answerIncoming(false)}
      >
        <View style={s.backdrop}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>
              {incoming?.from} wants to send you
              {incoming?.files.length
                ? ` ${incoming.files.length} file${incoming.files.length === 1 ? '' : 's'}`
                : ' files'}
            </Text>

            {incoming?.files.length ? (
              <View style={s.sheetFiles}>
                {incoming.files.slice(0, 5).map((f, i) => (
                  <Text key={`${f.name}-${i}`} style={s.sheetFile} numberOfLines={1}>
                    {f.name}
                    {f.size ? `  ·  ${fmtBytes(f.size)}` : ''}
                  </Text>
                ))}
                {incoming.files.length > 5 ? (
                  <Text style={s.sheetFile}>…and {incoming.files.length - 5} more</Text>
                ) : null}
              </View>
            ) : (
              <Text style={s.sheetFile}>
                This sender is using an older version of Beam, so it cannot list the
                files first.
              </Text>
            )}

            {incoming?.code ? (
              <>
                <Text style={s.codeLabel}>Verification code</Text>
                <Text style={s.code}>{incoming.code}</Text>
                <Text style={s.codeHint}>
                  The sending device should be showing the same code.
                </Text>
              </>
            ) : null}

            {incoming?.canTrust ? (
              // The whole row toggles: tapping only the switch is a fiddly
              // target, and people reach for the label first.
              <Pressable style={s.trustRow} onPress={() => setTrustSender((v) => !v)}>
                <Text style={s.trustLabel}>Always allow this device</Text>
                <Switch
                  value={trustSender}
                  onValueChange={setTrustSender}
                  trackColor={{ true: '#4f7cff', false: '#2c313a' }}
                />
              </Pressable>
            ) : null}

            <View style={s.sheetBtns}>
              <Pressable style={[s.sheetBtn, s.declineBtn]} onPress={() => answerIncoming(false)}>
                <Text style={s.declineText}>Decline</Text>
              </Pressable>
              <Pressable style={[s.sheetBtn, s.acceptBtn]} onPress={() => answerIncoming(true)}>
                <Text style={s.acceptText}>Accept</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Pressable
        style={[s.sendBtn, !canSend && s.sendBtnDisabled]}
        onPress={doSend}
        disabled={!canSend}
      >
        <Text style={s.sendBtnText}>
          {send.phase === 'waiting'
            ? 'Waiting for approval…'
            : sending
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
  rowStart: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  label: { color: '#9aa3af', fontSize: 11, letterSpacing: 1, marginBottom: 4 },
  linkBtn: { color: '#6d93ff', fontSize: 13, fontWeight: '600' },
  linkBtnSmall: { color: '#6d93ff', fontSize: 12, fontWeight: '600', marginBottom: 4 },
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
  deviceAsleep: { borderStyle: 'dashed', opacity: 0.65 },
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
  partial: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 8,
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
  waiting: {
    color: '#e8b339',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 8,
  },

  // incoming-transfer prompt
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: { backgroundColor: '#1b1f27', borderRadius: 18, padding: 22 },
  sheetTitle: { color: '#eceff3', fontSize: 18, fontWeight: '700', lineHeight: 24 },
  sheetFiles: { marginTop: 14, gap: 4 },
  sheetFile: { color: '#9aa3af', fontSize: 13.5, marginTop: 12 },
  codeLabel: {
    color: '#788088',
    fontSize: 11,
    letterSpacing: 1,
    marginTop: 20,
    textTransform: 'uppercase',
  },
  code: {
    color: '#6d93ff',
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 6,
    marginTop: 4,
  },
  codeHint: { color: '#788088', fontSize: 12, marginTop: 6 },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
  },
  trustLabel: { color: '#dde2e8', fontSize: 14 },
  input: {
    borderWidth: 1,
    borderColor: '#2c313a',
    borderRadius: 10,
    color: '#eceff3',
    backgroundColor: '#111318',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginTop: 12,
  },
  recentList: { maxHeight: 280, marginTop: 6 },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2c313a',
    gap: 8,
  },
  arrowIn: { color: '#4cc27a', fontSize: 14, width: 14 },
  arrowOut: { color: '#6d93ff', fontSize: 14, width: 14 },
  recentName: { color: '#dde2e8', fontSize: 14, flex: 1 },
  recentMeta: { color: '#788088', fontSize: 11.5 },
  sheetBtns: { flexDirection: 'row', gap: 12, marginTop: 24 },
  sheetBtn: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  declineBtn: { borderWidth: 1, borderColor: '#2c313a' },
  declineText: { color: '#dde2e8', fontSize: 15, fontWeight: '600' },
  acceptBtn: { backgroundColor: '#4f7cff' },
  acceptText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
