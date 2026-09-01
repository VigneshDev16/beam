# Privacy Policy — Beam

Last updated: 1 September 2026

Beam is a file transfer app for Android, iOS and macOS, published as open
source at https://github.com/VigneshDev16/beam.

## The short version

Beam has no servers. It collects nothing, sends nothing to us, and there is
nothing to have an account with. Your files go directly from one of your
devices to the other over your own network.

## What Beam does with your data

**Your files.** When you send a file, it travels over your local network
directly to the receiving device, using a plain HTTP request between the two
devices. It is not uploaded anywhere else, and no copy is kept by anyone but
you. Received files are written to your Downloads folder (Android and macOS)
or the app's own documents folder (iOS).

**Files Beam can read.** Beam reads only the files you explicitly pick in the
file picker, or drag onto the desktop app. It does not scan your storage.

**Data kept on your device.** Beam stores, locally and only on your device:

- a random identifier for this installation, so a device you approve can be
  remembered
- the name and last known address of devices you have transferred with
- a list of your recent transfers (file name, size, the other device's name,
  and when)
- devices you ticked "always allow" for

None of this leaves your device. Uninstalling the app deletes all of it, and
the transfer history can be cleared from inside the app at any time.

## What Beam does not do

- No analytics, telemetry, crash reporting or advertising SDKs
- No account, sign-in, or email address
- No cloud storage, and no server operated by the developer
- No selling or sharing of data with anyone, because none is collected

## Permissions

| Permission | Why |
| --- | --- |
| Network / Internet access | To talk to your other device over the local network. Beam does not contact any remote server. |
| Notifications (Android 13+) | To show that Beam is listening, and to tell you when a file arrives. Optional — declining it only removes the notifications. |
| Foreground service (Android) | To keep receiving while the app is in the background. |
| Storage / documents (via the system picker) | To read the files you choose to send, and to save the ones you receive. |

## Security

Transfers happen on your local network and are not currently encrypted in
transit — they are plain HTTP between two devices on the same Wi-Fi. Encryption
is on the roadmap. Nothing is ever accepted without an explicit approval, shown
with a six-digit code that both devices display.

Do not use Beam to send sensitive files over a network you do not trust, such
as public or hotel Wi-Fi.

## Children

Beam is a utility with no accounts, no user content platform and no data
collection, and is not directed at children specifically.

## Changes

Any change to this policy will be committed to the repository, where the full
history is public.

## Contact

Open an issue at https://github.com/VigneshDev16/beam/issues.
