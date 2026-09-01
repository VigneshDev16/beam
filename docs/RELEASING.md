# Releasing Beam

## The macOS app: signed and notarised

The `.dmg` on the releases page today is **unsigned**, which is why first
launch needs right-click → Open. Removing that step needs two things Apple
controls, in this order:

1. **Signing** with a *Developer ID Application* certificate — proves the app
   came from a known developer.
2. **Notarisation** — Apple scans the signed app and issues a ticket, which
   gets *stapled* into the dmg so Gatekeeper is happy offline.

Signing without notarising still shows a warning. You need both.

### One-time setup

**1. Join the Apple Developer Program** — <https://developer.apple.com/programs>,
US$99/year. There is no free path: Developer ID certificates are not issued to
free accounts, and ad-hoc signing (`codesign -s -`) does not satisfy Gatekeeper.

**2. Create the certificate.** In Xcode: *Settings → Accounts → your Apple ID →
Manage Certificates → + → Developer ID Application*. It lands in your login
keychain. Check it:

```bash
security find-identity -v -p codesigning
```

You want a line reading `Developer ID Application: Your Name (TEAMID)`. That
`TEAMID` is your team ID; it's also on the developer portal under Membership.

**3. Make an app-specific password** at <https://appleid.apple.com> → Sign-In
and Security → App-Specific Passwords. Notarisation needs it; your real Apple
ID password will not work and should not be used here.

**4. Store the notarisation credentials in the keychain** so nothing sensitive
ends up in a shell history or a file:

```bash
xcrun notarytool store-credentials beam-notary --apple-id "you@example.com" --team-id "TEAMID"
```

It prompts for the app-specific password.

### Building a release

The build config picks up signing from the environment, so the command is the
same either way:

```bash
cd desktop && APPLE_ID="you@example.com" APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop" APPLE_TEAM_ID="TEAMID" npm run dist
```

With all three set, electron-builder signs with the hardened runtime, uploads
to Apple, waits for the ticket, and staples it. Expect **5–20 minutes** —
almost all of it waiting on Apple. With them unset you get the old unsigned
build and a warning saying so.

Output: `desktop/release/Beam-<version>-arm64.dmg`.

### Checking it actually worked

Do not trust the build log alone:

```bash
# 1. Signed by the right identity, with the hardened runtime
codesign -dv --verbose=4 "desktop/release/mac-arm64/Beam.app" 2>&1 | grep -E "Authority|flags"
# expect: Authority=Developer ID Application: ...   flags=0x10000(runtime)

# 2. The signature is internally consistent
codesign --verify --deep --strict --verbose=2 "desktop/release/mac-arm64/Beam.app"

# 3. Gatekeeper accepts it — this is the test that matters
spctl -a -vvv -t install "desktop/release/Beam-0.3.0-arm64.dmg"
# expect: source=Notarized Developer ID

# 4. The ticket is stapled, so it works offline
xcrun stapler validate "desktop/release/Beam-0.3.0-arm64.dmg"
```

The real check: copy the dmg to another Mac (or `xattr -w com.apple.quarantine`
a copy), and open it. No warning at all means it's done.

### If notarisation is rejected

```bash
xcrun notarytool history --keychain-profile beam-notary
xcrun notarytool log <submission-id> --keychain-profile beam-notary
```

The log names the exact file and reason. The usual causes are a binary that
missed the hardened runtime, or a bundled helper that wasn't signed.

### Once it's signed

- Drop the "right-click → Open" step from the README install section.
- Keep the certificate and its private key backed up next to the Android
  keystore. Losing it means a new certificate, and every existing install sees
  a different developer.

## The Android app

See `docs/store/uptodown-listing.md`. Build with:

```bash
cd mobile/android && ./gradlew assembleRelease
```

Signed with `beam-release.keystore`; bump `versionCode` for every upload.

## Cutting a GitHub release

```bash
gh release create v0.3.0 \
  "desktop/release/Beam-0.3.0-arm64.dmg" \
  "$HOME/Desktop/Beam-0.3.0-android.apk" \
  --title "Beam 0.3.0" --notes-file docs/release-notes-0.3.0.md
```

Put the SHA-256 of each file in the notes, and if you ever replace an asset
with `--clobber`, update the checksum in the same edit — a stale one looks
like tampering to anyone verifying.
