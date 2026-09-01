# The file is already on the same Wi-Fi. Why am I uploading it to Oregon?

*First in a series about building small solutions to problems I actually have.*

---

Here is the ritual. I take a photo on my phone. I want it on my laptop, which is
on the same desk, connected to the same router, three feet away.

So I open a chat app and send the photo to myself. It goes to a data centre
somewhere in Oregon. It comes back down. Two trips across a continent, for a
journey of one metre.

The alternatives are worse than they used to be. Google **discontinued Android
File Transfer**, the small Mac utility that used to do this over a cable.
AirDrop is Apple-only by design. Everything else wants an account, an upload,
and — depending on the day — a subscription.

I got annoyed enough to build the obvious thing instead. It's called **Beam**,
it's free, and the code is public.

---

## What it is

Open Beam on your laptop and on your phone. They find each other on the Wi-Fi.
Drag the file over. It arrives.

That's the whole product. A local network transfer runs at the speed of your
router, not the speed of your upload — which is usually the difference between
"done" and "still going".

There's no account. There's no server in the middle; the file goes from your
phone to your laptop and nowhere else. There's no size limit beyond the space
on your own devices.

If the phone is plugged in with a cable, the Mac app can also browse it like a
drive — create folders, rename things, delete things, drag files straight into
Finder. That part is Android-only, because iOS doesn't give anyone file access
over USB.

---

## Three things I learned building it

### 1. The failure message is the product

The first version of cable mode had a bug that taught me more than the feature
did. Plug in a phone macOS won't let the app talk to, and the app showed an
**empty folder**.

Not an error. Not a warning. A phone with no files on it — which is a lie, and
a confusing one, because there's nothing to act on. You just conclude the app
is broken.

The real story was that macOS grabs a phone's USB connection for itself the
moment you plug it in, and won't share. That's not something I can fix. But I
can *say* it:

> **Samsung SM-S918B — blocked.** macOS is holding this phone's USB interface.
> Turn on USB debugging, or send over Wi-Fi instead.

Same limitation. Completely different experience. When software can't do
something, saying so plainly is not an admission of defeat — it's most of the
help you can offer.

### 2. Convenience and consent are the same feature

Beam works by having your laptop listen for incoming files. Which is fine,
until you notice what it means: anyone else on that Wi-Fi could push files onto
your laptop. In a flat, a café, an office — that's a real thing, not a
hypothetical.

So now nothing lands without a person saying yes. When a device wants to send
you something, you see what it is, who it says it's from, and a six-digit code
that the *sending* device is showing at the same time. If the codes don't
match, it isn't the device you think it is.

The part I'm happiest with is the escape hatch: tick **"always allow this
device"** for your own laptop and you never see the prompt again for that one
device. Security that you have to re-perform forty times a day gets switched
off. Asking once, and remembering the answer, is what makes it survivable.

### 3. Fast enough is a feature you have to build twice

The first version found devices by asking every address on your network, in
order, whether it was running Beam. It worked. It took a couple of seconds of
staring at nothing, which in phone-app time is a long while.

The fix wasn't a cleverer protocol. It was asking the *right addresses first* —
the device you used yesterday, and the handful of machines your laptop has
recently exchanged traffic with. Those answer almost immediately. The
exhaustive sweep still runs behind them, for the case where you're somewhere
new.

And for networks that block this kind of thing entirely — some guest Wi-Fi does
— there's a box where you type the other device's address. Unglamorous, and it
turns "doesn't work here" into eleven characters of typing.

---

## Where it is now

Beam moves files between Android, iPhone and Mac over Wi-Fi, browses a cabled
Android phone from the Mac, asks before it accepts anything, remembers the
devices you use, keeps a history of what moved, and can retry just the files
that failed.

What it doesn't do yet: encrypt transfers. Today they're plain traffic on your
local network — nothing leaves it, but someone already on your Wi-Fi could read
it. That's next, and I'd rather write that sentence than leave it out.

It's free, open source under the MIT licence, and I built it because the
alternative was continuing to email myself photographs like it's 2009.

**Code, Android app and Mac app:** <https://github.com/VigneshDev16/beam>

---

*If you build things for yourself and ship them anyway, I'd like to hear about
it. That's the series.*
