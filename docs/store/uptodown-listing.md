# Uptodown listing — Beam

Everything needed to submit the Android app to Uptodown, in the order their
form asks for it. Copy the text straight across.

> **You have to do the submission yourself** — it needs a developer account and
> a login, which is not something to hand to a tool. Everything below is ready
> to paste, and the APK is built and signed.

---

## 1. Before you start

| Item | Value |
| --- | --- |
| APK | ready to upload at `~/Desktop/Beam-0.3.0-android.apk` (built from `mobile/android/app/build/outputs/apk/release/app-release.apk`) |
| SHA-256 | `675e48e2ec3e1d6768f442df9f77a768921d1d50bde5b59c2150d9aef2f00d90` |
| Size | 51 MB |
| Version | 0.3.0 (versionCode 2) |
| Package name | `com.beammobile` |
| Min Android | 7.0 (API 24) |
| ABIs | armeabi-v7a, arm64-v8a, x86, x86_64 |
| Signing | `beam-release.keystore` — **the same keystore must sign every future update** |
| Licence | MIT |
| Source | https://github.com/VigneshDev16/beam |

## 2. Submit

1. Go to **https://developers.uptodown.com** and sign in (create the developer
   account there if you don't have one).
2. **Upload app** → drop in the APK. Uptodown reads the package name, version
   and icon from it, then asks for the rest.
3. Fill in the fields below.
4. Submit for review. Uptodown moderates manually; expect a few days, and an
   email if they want anything changed.

## 3. Fields

**App name**

```
Beam — File Transfer
```

**Category**

```
Tools  →  File transfer / File management
```

**Short description** (under 80 characters)

```
Send files between your phone and your laptop over Wi-Fi. No cloud, no account.
```

**Long description**

```
Beam moves files between your phone and your computer over your own Wi-Fi.
Nothing is uploaded to a server, nothing needs an account, and there is no
size limit beyond the space on your devices.

Open Beam on both devices and they find each other on the network. Pick the
files, send them, done — at local network speed rather than upload-then-
download speed.

WHAT IT DOES

• Send files from your phone to your laptop, and from your laptop to your phone
• Devices discover each other automatically on the same Wi-Fi
• Connect by IP address when a network blocks device discovery
• Remembers the devices you use, so they're one tap away next time
• A history of what you've sent and received
• Retry just the files that failed, instead of the whole batch
• Received files go to your Downloads folder, where every other app can see them

PRIVACY

Beam has no servers. Your files travel directly from one device to the other
over your local network. There is no account, no telemetry, and no analytics.
The app asks for network access and, on Android 13 and later, permission to
show a notification while it is listening.

NOTHING ARRIVES WITHOUT PERMISSION

When another device wants to send you something, Beam shows you what it is,
who it's from, and a six-digit code that the sending device shows too. Nothing
is written to your phone until you accept. You can tick "always allow this
device" for your own laptop.

THE DESKTOP APP

The companion app for macOS is a free download from the project page on GitHub.
It also browses an Android phone over a USB cable — create folders, rename,
move and delete files on the phone from your laptop, and drag files straight
into Finder.

Free and open source under the MIT licence.
```

**Tags / keywords**

```
file transfer, wifi transfer, send files, phone to pc, share files,
android file transfer, local network, no cloud, offline transfer
```

**What's new in this version**

```
0.3.0
• Devices you've used before appear straight away and reconnect in about a second
• Connect by IP address for networks where discovery is blocked
• A record of what you've sent and received
• Failed files can be retried on their own
• Per-file progress while sending
• Keeps receiving while the app is in the background, with a notification when a file lands
```

**Website**

```
https://github.com/VigneshDev16/beam
```

**Privacy policy** — Uptodown asks for a URL:

```
https://github.com/VigneshDev16/beam/blob/main/PRIVACY.md
```

**Developer**

```
Vigneshwaran M — https://github.com/VigneshDev16
```

## 4. Graphics

| Asset | File |
| --- | --- |
| Icon | taken from the APK automatically (512×512 also at `mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png`) |
| Screenshot 1 | `docs/screenshots/android.png` |
| Screenshot 2 | `docs/screenshots/ios.png` |
| Screenshot 3 | `docs/screenshots/explorer.png` (desktop companion) |
| Feature graphic | `docs/social/slide-1.png` |

Uptodown wants phone screenshots at the device's own resolution — the two
phone shots already are.

## 5. After it's live

- Put the Uptodown URL in the README next to the GitHub release link.
- Every future update must be signed with the same keystore, or Uptodown will
  reject it as a different app.
- Bump `versionCode` for each upload — Uptodown refuses a duplicate.

## 6. Paste helpers

One file per field in `docs/store/fields/`, so filling the form is a copy
command and a Cmd+V rather than a hunt through this document:

```bash
pbcopy < docs/store/fields/full-description.txt
```

`name`, `short-description`, `full-description`, `whats-new`, `tags`,
`website`, `privacy-url`. Keep them and this document in step if the copy
changes.
