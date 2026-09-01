---
title: "I got tired of emailing myself photos, so I built a file transfer app"
published: false
description: "Android File Transfer is dead, AirDrop ignores Android, and the cloud is a slow workaround. Here's what it actually took to make a phone and a laptop talk to each other directly."
tags: reactnative, electron, android, opensource
cover_image: https://raw.githubusercontent.com/VigneshDev16/beam/main/docs/screenshots/explorer.png
canonical_url:
---

Getting a photo off my phone and onto my laptop is a solved problem, in the
same way that assembling flat-pack furniture is a solved problem. Technically
yes. Pleasantly, no.

Google **discontinued Android File Transfer**. AirDrop behaves as though
Android doesn't exist. So what's left is the cloud shuffle: upload a 40 MB
video to somebody else's server, wait, then download the same 40 MB back onto a
machine sitting three feet from the phone that already has it.

The two devices are on the same Wi-Fi. They can already reach each other. So I
built **Beam**, which just does that.

- Repo: <https://github.com/VigneshDev16/beam> (MIT)
- macOS app and signed Android APK on the releases page

This post is about what turned out to be hard, because the "send bytes over a
socket" part was the easy half.

---

## The shape of the thing

Every device runs a tiny HTTP server and a tiny HTTP client. That's the whole
protocol.

```
GET  /info              → who I am
POST /offer             → I'd like to send you these files
GET  /offer/:id         → have you decided yet?
POST /upload?token=...  → here are the bytes
```

Laptops listen on **8790**, phones on **8791**. The desktop app is Electron,
the mobile app is React Native with a small native module on each platform —
NanoHTTPD on Android, GCDWebServer on iOS. No server anywhere. No account.
Nothing to sign into.

## Hard part 1: finding the other device

The textbook answer is mDNS/Bonjour. I didn't use it, and the reason is boring
but decisive: **mDNS needs native browse code on every platform**, and it is
exactly the thing that quietly fails on the networks people actually use —
guest Wi-Fi, mesh routers that don't forward multicast, corporate APs with
client isolation.

So discovery is a plain subnet sweep. Ask `/info` on every address in the /24
and see who answers. It's crude and it always works.

Crude, though, was also slow — a couple of seconds of nothing while 254
addresses time out. So the sweep now runs in two passes:

```js
// Addresses we already have a reason to care about go first: a device we've
// used before, plus everything in the ARP table (i.e. hosts this machine has
// actually exchanged packets with).
const first = [...new Set([...hints, ...(await arpNeighbours())])];

await sweep(first, PHONE_PORT, 1200, 32, collect);  // generous timeout
await sweep(rest,  PHONE_PORT,  400, 64, collect);  // short one
```

The ARP table is the trick worth stealing. On a home network it's a handful of
hosts, and the phone is nearly always one of them. Devices now appear while the
sweep is still running, because each hit is streamed to the UI rather than
returned at the end.

And for the networks where none of this can work, there's a **Connect by IP**
box. Not glamorous. Turns "this app doesn't work here" into "type eleven
characters".

## Hard part 2: macOS really does not want you touching a phone over USB

I wanted cable transfer too — plug the phone in, browse it like a drive. On
Android that means MTP, and libmtp is right there.

It fails. Every time:

```
LIBMTP PANIC: Unable to initialize device
libusb_claim_interface() = -3   (LIBUSB_ERROR_ACCESS)
```

The cause isn't permissions in the usual sense. macOS's own
`ptpcamerad`/`mscamerad-xpc` claim the phone's USB interface (class 6, still
image capture) the instant it's plugged in, so nothing else can. Those daemons
are SIP-protected: you cannot unload them, and the workarounds you'll find on
the internet stopped working several macOS versions ago.

So cable mode uses **adb** instead, which talks to a different USB interface
and works fine. And when adb isn't available, the app doesn't pretend:

> **Samsung SM-S918B — blocked**
> macOS is holding this phone's USB interface. Enable USB debugging, or use
> Wi-Fi.

Two real bugs came out of this. The first: a device whose listing failed showed
an *empty folder* rather than an error, so a blocked phone looked like a phone
with no files. The second: the failure was swallowed entirely. Both were the
same mistake — treating "I couldn't ask" as "the answer is nothing".

That's the bit I'd tell anyone building against flaky hardware: **make the
unhappy path say what happened.** An empty list is a lie.

## Hard part 3: an open port on your laptop is somebody else's upload button

The first version accepted whatever arrived. On a home network that's mostly
fine, and "mostly fine" is not a security model — anyone on the same Wi-Fi
could write files to your Downloads folder.

So now nothing is written without a person saying yes:

1. The sender POSTs an **offer** — who it is, what it wants to send.
2. The receiver shows the file list and a **six-digit code**, which the sender
   displays too, so you can tell *your* laptop from the other one in the café.
3. Accepting mints a **single-use token**, bounded by the number of files the
   offer declared:

```js
offer.token = crypto.randomBytes(24).toString('hex');
offer.usesLeft = Math.max(1, offer.files.length);
```

I found that last line by getting it wrong first. My first version let one
approval be redeemed forever — one "yes" and the sender could upload all night.

The interesting case is an **older sender that doesn't know about offers**. You
can't ask it to make one, so the receiver prompts when the upload arrives — and
on the desktop and on Android it deliberately **leaves the request body unread
until you decide**, so declining costs no bandwidth and writes nothing.

iOS couldn't do that, and I think it's worth being honest about why: GCDWebServer
hands the handler an already-parsed body, so by the time the prompt appears the
bytes have arrived. They're just never saved, and the temp files are deleted on
decline. Same outcome, different guarantee, and the README says so.

## The stupid bug that shipped

The app icon was black. Not a rendering glitch — genuinely a black square.

ImageMagick on my machine has no librsvg. Given an SVG with a gradient, it
doesn't fail: it silently drops what it can't render and writes a solid black
PNG. The build "succeeded" every time.

The fix was to render icon SVGs through **Chromium** (Electron is right there)
and then `iconutil -c icns`. If your build pipeline turns a vector into a
raster, check the raster with your eyes at least once.

## The one I only found by testing on a real device

Transfer history lived in a small JSON blob. Three files arrive at once, three
handlers do read-modify-write, two of them read the same list, last write wins
— and one file silently disappears from the history while sitting perfectly
well in the Downloads folder.

I only caught it because I sent a *folder* of three files and counted the rows.
The fix is a one-promise queue:

```ts
let tail: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => undefined);
  return next;
}
```

Not clever. Just needed.

## What it does now

- Wi-Fi transfer both ways between Android, iPhone and Mac
- USB mode: browse a cabled Android, create folders, rename, move, delete, drag
  files straight into Finder
- Approval prompt with a verification code before anything is written
- Devices you've used before come back in about a second
- Transfer history, and retry for just the files that failed
- Keeps receiving on Android while the app is in the background

Next up is TLS, which is the honest gap: transfers are plain HTTP on your local
network today. Approval stops drive-by writes; it doesn't stop someone already
on your Wi-Fi from reading the wire.

Code, APK and Mac build: <https://github.com/VigneshDev16/beam>

If you've fought with macOS and MTP and found something I missed, I'd genuinely
like to hear it.
