# Beam

Move files between your phones and laptop — over Wi-Fi, or over a USB cable.
No cloud.

```
beam/
├── desktop/   Electron app: Wi-Fi receiver + USB cable browser
└── mobile/    React Native app for Android + iOS (send and receive)
```

## Cable mode (USB)

The desktop app's **Cable** tab reads files straight off a USB-connected
Android — browse its folders, tick the files you want, copy them to
`~/Downloads/Beam`. Nothing needs to be installed on the phone; this is the job
Google's discontinued Android File Transfer used to do on macOS.

Two backends, picked automatically:

| Backend | Phone setup | Notes |
| --- | --- | --- |
| **adb** | USB debugging enabled once | **the reliable path on macOS**; fast, byte-level progress, works with emulators |
| **MTP** (libmtp) | none — just pick "File transfer" in the USB notification | needs `brew install libmtp`; **usually blocked on macOS**, see below |

### Why MTP usually fails on macOS

Most Android phones expose their MTP endpoint as **USB interface class 6
(Still Image / PTP)**. macOS automatically binds its own Image Capture daemons
(`ptpcamerad`, `mscamerad-xpc`) to any class-6 interface, and libusb cannot
detach a kernel driver on macOS — so `libusb_claim_interface()` returns `-3`
(access denied) and libmtp panics with "Unable to open raw device".

Confirmed on a Samsung Galaxy (`04e8:6860`): the phone enumerates fine and
`mtp-detect` identifies it, but claiming the interface fails. Quitting Google's
Android File Transfer agent does **not** help, and the Apple daemons are
SIP-protected, so they cannot be killed to free the interface.

The app detects this precisely and greys the device out with the reason and the
fix, rather than showing an empty file list. **Enable USB debugging** and the
same phone works over the adb backend.

A phone with USB debugging on shows up under both; the app prefers adb. Phones
that are plugged in but not yet authorised are listed greyed out with the reason
("Unlock the phone and tap Allow USB debugging").

**iPhones cannot do this.** iOS exposes no MTP and no USB filesystem, so
anything involving an iPhone has to go over Wi-Fi. This is an Apple restriction,
not a missing feature.

## How Wi-Fi mode works

Every device runs the same tiny HTTP protocol:

- `GET /info` → `{app: "beam", name, platform}` so others can identify it.
- `POST /upload?from=<sender>` → multipart file upload.

Ports: **8790** for laptops, **8791** for phones. A sender gets its own Wi-Fi IP,
sweeps the /24 subnet probing `/info` on both ports, and lists everything that
answers. No mDNS/Bonjour native modules — a plain HTTP scan behaves identically
on Android, iOS, and every desktop OS.

Received files land in `~/Downloads/Beam` (desktop), `Download/Beam` via
MediaStore (Android), and the app's Documents folder, visible in the Files app
(iOS).

Phones only listen while "Receive files" is on; the server is off by default.

## Install the desktop app

```bash
cd desktop && npm install && npm run dist
```

That produces `desktop/release/Beam-<version>-arm64.dmg` (Apple Silicon). Open
it and drag Beam to Applications like any Mac app.

The build is **not code-signed**, so the first launch needs
right-click → Open (or System Settings → Privacy & Security → Open Anyway).
Signing needs a paid Apple Developer ID.

To run from source instead:

```bash
cd desktop && npm install && npm start
```

## Managing files on the phone

With a USB-debugging phone selected, the Cable tab is a real file manager, not
just a viewer. Tick any files or folders, then:

| Action | What it does |
| --- | --- |
| **New folder** | creates a folder in the folder you're viewing |
| **Rename** | edits the name inline (one item at a time) |
| **Cut** → **Paste here** | moves items: cut, open the destination, paste |
| **Delete** | removes files and folders **permanently** |
| **Copy to Mac** | pulls the selection into `~/Downloads/Beam` |

Guardrails, because a phone has no trash and a bad path is unrecoverable:

- Delete always shows a confirmation naming what will go, with **Cancel** as the
  default button, and says explicitly when folders are included.
- Names are validated — empty, `/`, `.` and `..` are rejected, so a rename can
  never escape the current folder.
- Creating or moving onto an existing name is refused rather than overwriting.
- Moving a folder into itself is refused.
- Every path is shell-quoted before it reaches `adb shell`, so spaces and quotes
  in filenames are safe.

These operations need **adb** (USB debugging). MTP is read-only here.

## Drag and drop

The desktop app behaves like a file explorer in both directions:

- **Drag files out** of the phone's file list, or out of "Received files",
  straight into Finder. Phone files aren't on disk yet, so the first drag
  fetches a copy and says when it's ready — drag again and it drops instantly.
- **Drag files in** from Finder onto the phone's file list to copy them into the
  folder you're viewing (cable, needs USB debugging), or onto the Wi-Fi tab's
  drop zone to send them to a phone over the network.

## Run the mobile app

```bash
cd mobile && npm install
npx react-native start
```

Then, in a second terminal:

```bash
npx react-native run-android
```

For iOS, install pods first (needs a UTF-8 locale or CocoaPods crashes):

```bash
cd mobile/ios && LANG=en_US.UTF-8 pod install && cd .. && npx react-native run-ios
```

## Verified end to end

- Mac → Android (3 MB and 1 MB files, checksums matched)
- Android → Mac (2 MB file, checksum matched)
- Android → iPhone (1 MB file, checksum matched after two hops)
- Cable/adb: device detection, folder browsing, and a 2.5 MB copy (checksum
  matched), including filenames containing spaces
- Cable/adb on a **physical Galaxy S23 (SM-S918B)**: push a 1.5 MB file to the
  phone and pull it back, checksum matched both ways
- Packaged `.app` launches and serves `/info` (the bundle finds `adb`, `ioreg`
  and the libmtp tools by absolute path, so it does not depend on shell PATH)
- File operations on the physical Galaxy, run inside a throwaway folder: create
  nested folders, rename, move, recursive delete, plus the refusals (duplicate
  name, folder into itself) — all confirmed, then the scratch folder removed

Wi-Fi results are on emulator/simulator, where both phones reach the Mac at
`10.0.2.2`.

The **MTP backend has never successfully transferred a file** — on a real
Samsung Galaxy it is blocked by macOS (see above). It is kept because the same
code path is expected to work on Linux/Windows and on phones that expose MTP
outside USB class 6, but treat it as unproven.

## Environment notes (this Mac)

- `android/gradle.properties` pins Gradle to Android Studio's JDK 21 via
  `org.gradle.java.home` — the system default JDK 25 fails the CMake step.
- `reactNativeArchitectures=arm64-v8a` keeps dev APKs small; restore all four
  ABIs before building a release APK for other phones.
- `ios/.xcode.env.local` sets `NODE_PATH` so React Native's codegen script can
  resolve modules when Xcode runs it from outside the project tree.
- Cleartext HTTP is enabled on both platforms — LAN transfers are plain HTTP by
  design.

## Known gaps

- Transfers are unauthenticated and unencrypted: anything on your Wi-Fi that
  finds the port can send you a file, and receivers accept silently. Receiver
  approval + a pairing code are the next thing to build.
- Discovery is a 254-host sweep; on a large or slow network it takes a few
  seconds and may miss devices behind AP client isolation.
- Verified only on emulators so far, not on physical hardware.
- iOS keeps the server alive only while the app is foregrounded.

## Roadmap

- [x] Phase 1: Android → laptop
- [x] Phase 2: iOS app; phones can receive; Android ↔ iPhone
- [x] Phase 3: USB cable mode on the desktop (MTP + adb, Android only)
- [x] Phase 4: installable `.dmg`, drag-in/drag-out, laptop → phone over Wi-Fi
- [x] Phase 5: file management on the phone (new folder, rename, move, delete)
- [ ] Copy/duplicate on the phone, and multi-level undo
- [ ] Drag whole folders from Finder (only individual files work today)
- [ ] Code-sign and notarise the Mac build
- [ ] Receiver approval prompt, pairing code, transfer history
- [ ] TLS for transfers
