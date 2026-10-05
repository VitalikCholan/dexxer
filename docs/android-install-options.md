# Options for installing Dexxer on Android for testing and demos (02.10.2026)

The app is the Expo dev client `com.dexxer.app` with Mobile Wallet Adapter (MWA). MWA is a native Android module,
so **Expo Go does not work** in any way: Connect silently does nothing. You need your own build (dev client
or release APK). iOS builds, but there are no wallets there.

Marks: ✅ measured on this project; 📄 documented by Expo/Solana Mobile, not tried by us.

| # | Option | What for | Cable | Metro | Status |
|---|---------|----------|--------|-------|--------|
| 1 | AVD `local_phone` + fakewallet | daily smoke, agent verification | — | yes | ✅ |
| 2 | AVD `phantom_phone` + Phantom | nonce, DAL, a real wallet without a phone | — | yes | ✅ |
| 3 | Phone/Seeker over USB, `expo run:android` | closest to reality, adb logs | USB | yes | ✅ (Seeker — not tried) |
| 4 | Phone over Wi-Fi (adb wireless) | the same without a cable | — | yes | 📄 |
| 5 | Dev client + `expo start --dev-client` over LAN/tunnel | development without adb | — | yes | 📄 |
| 6 | EAS Build `development` | build in the cloud, no Android SDK | — | yes | 📄 |
| 7 | APK directly (sideload) | a demo on someone else's phone | — | no/LAN | ✅ debug APK, release — no |
| 8 | EAS Build `preview` / release APK | a standalone demo on the live relayer | — | no | 📄 |
| 9 | EAS internal distribution (page/QR) + Expo Orbit | hand out to testers, one-click install | — | depends | 📄 |
| 10 | EAS Update (OTA JS) | update already installed builds without reinstalling | — | no | 📄 |
| 11 | Firebase App Distribution | up to 500 testers, without Play | — | no | 📄 |
| 12 | Google Play internal testing | up to 100 testers through the Play Store | — | no | 📄, needs Play Console |
| 13 | Cloud real devices (Android Device Streaming, BrowserStack App Live) | other phone models without buying them | — | no | 📄, wallet — questionable |
| 14 | Emulator in the browser (Appetize.io) | show in a browser, no install | — | no | 📄, no MWA wallet |
| 15 | Solana dApp Store | real distribution on Seeker | — | no | 📄, not for the MVP |
| 16 | Public APK URL (GitHub Release) | hackathon submissions, judges without Metro | — | no | ⬜ needs a release keystore |

For a demo on the Mac's screen (not installing, but showing): **scrcpy** mirrors and controls a real phone over USB
or Wi-Fi without an app on the phone (`brew install scrcpy`) — unlike an AVD, with a real wallet.

All options talk to the live devnet deployment (program `Fyg2…UfCY`, relayer on Railway — `docs/deployments.md`),
no need to build a backend.

## 0. Prerequisites (once)

```bash
npx solana-mobile@latest doctor          # Android SDK, Java, Node — it will say what is missing
cd app && npm ci
```

Building the dev client: `npm run android` from `app/` (= `expo run:android`). The first one takes minutes (Gradle), then
≈1 min incrementally; `npm run android -- --no-bundler` if Metro is already running. The APK after the build is
`app/android/app/build/outputs/apk/debug/app-debug.apk`.

## 1–2. Emulators (AVD)

Full sequence, logs, shutdown and pitfalls — `docs/emulator-runbook.md` §1–§5; smoke checklist — §6.
The key point: start the emulator with `-http-proxy http://10.0.2.2:8888 -dns-server 8.8.8.8,8.8.4.4` and the proxy
`scripts/emu-proxy.cjs` (otherwise the TEE endpoints do not resolve from the guest), then `settings put global http_proxy`
and `adb reverse tcp:8081 tcp:8081`. The CLI prepares a fresh AVD:

```bash
npx solana-mobile@latest emu start local_phone --tune     # no animations, lock screen, first-run dialogs
npx solana-mobile@latest device install fakewallet        # test MWA wallet
```

Phantom (`phantom_phone`): a Play image with a Google account, Testnet Mode, ≥0.05 SOL for self-funded onboarding.
Chart pitfalls on the AVD (a fast swipe over the timeframes switches the market, a ≥2 s pause after a tap) — CLAUDE.md,
"Week 6 rules: chart".

## 3. A real phone or Seeker over USB

macOS needs no drivers. On the phone: Developer options (7 taps on Build number) → USB debugging;
the cable must carry data, not only charge; confirm the Mac's fingerprint on the screen.

```bash
npx solana-mobile@latest device list     # or adb devices — the state must be `device`, not `unauthorized`
cd app && npm run android                # builds and installs the dev client on the phone
npx solana-mobile@latest device open http://localhost:8081   # does adb reverse to Metro by itself
```

The proxy from §1 is not needed — the phone has its own DNS. Logs — as in the runbook §3 (`adb logcat … ReactNativeJS`).
If Connect does nothing — first separate the app from the environment:

```bash
npx solana-mobile@latest playground      # an MWA test page, prints every connect/sign to the terminal
```

If it does not sign either → the wallet/device is at fault, not our code. For a release build Phantom checks
Digital Asset Links: the signing key's fingerprint must be in the relayer's `ASSETLINKS_SHA256_FINGERPRINTS`
(CLAUDE.md, "Week 5 rules", item 1); the dev client's debug keystore is already there.

## 4. Phone over Wi-Fi (adb wireless, Android 11+) 📄

Developer options → Wireless debugging, the phone and the Mac on the same network:

```bash
adb pair <ip>:<pair-port>     # code and port from the "Pair device with pairing code" dialog, once
adb connect <ip>:<port>       # port from the main Wireless debugging screen (different from the pair one)
adb devices
```

Then everything as in §3, including `adb reverse` and logcat. Building/installing over Wi-Fi is slower — it is convenient
to build once over USB, then disconnect the cable.

## 5. Dev client without adb: `expo start --dev-client` 📄

When the dev client is already on the phone (by any of §3/§6/§7):

```bash
cd app && npx expo start --dev-client          # QR in the terminal; phone and Mac on the same Wi-Fi
cd app && npx expo start --dev-client --tunnel # if the network isolates devices (guest/office Wi-Fi)
```

In the dev client — scan the QR or enter `http://<Mac-ip>:8081`. JS logs are visible in the Metro terminal,
native ones (MWA, wallet) — only through adb.

## 6. EAS Build, `development` profile 📄

A build in the Expo cloud, without the Android SDK on the machine. There is no `eas.json` in `app/` yet (`app.json` has an empty
`extra.eas`):

```bash
npm i -g eas-cli && eas login
cd app && eas build:configure
eas build --platform android --profile development
```

The result is a link/QR; the phone downloads and installs the APK directly (allow "unknown sources"). Then §5.
The free tier has a monthly build limit and a queue; a local `expo run:android` on macOS is usually faster.
Note: EAS signs with its own keystore — for Phantom its fingerprint must be added to the relayer's assetlinks.

## 7. APK directly (sideload) ✅ for the debug APK

Transfer `app-debug.apk` from §0 to the phone any way (an AirDrop analogue, a messenger, `adb install`), allow
installs from that source. It is the same dev client: without Metro it does not start — §5 or §4/§3 is needed.
Good for quickly giving a tester a build that your Metro then feeds over `--tunnel`.

## 8. Standalone demo: release APK or EAS `preview` 📄

No Metro, talks to the live relayer. Options: `eas build --profile preview` (after §6) or locally
`cd app/android && ./gradlew assembleRelease` with your own keystore (there is currently no release keystore set up
in the project). Mandatory before handing it out:

- the build's `EXPO_PUBLIC_*` env (relayer, identity URI) — pointing at the live relayer, as in `docs/deployments.md`;
- the release key's fingerprint — in the relayer's `ASSETLINKS_SHA256_FINGERPRINTS`, otherwise Phantom will refuse
  ("DAL verification … false"), fakewallet will not;
- check on Seeker: MWA identity, the Seeker wallet, DAL — none of it has been measured on Seeker yet.

Publishing to the Solana dApp Store is a separate topic (skill `solana-mobile-publishing`), not planned for the MVP.

## 9. EAS internal distribution + Expo Orbit 📄

`"distribution": "internal"` in an `eas.json` profile → EAS serves the APK and an install page with a QR/link;
the tester needs neither Play nor an Expo account (link access can be restricted in Project Settings —
then only project collaborators). **Expo Orbit** (a macOS menu-bar app) installs a build from EAS on a connected
phone or emulator with one "Open with Expo Orbit" click from the dashboard and can launch an EAS Update into a compatible build.
The Android artifact must be an `.apk`, not an `.aab` (the default for Play) — otherwise it will not install on a device.

## 10. EAS Update (OTA) 📄

Updates only JS/styles/assets in already installed builds: `eas update --branch preview --message "…"`. A build
is subscribed to a **channel** (baked in at build time), a publication goes to a **branch** — the channel↔branch mapping can be changed
at any time. It does not change native code, modules or `AndroidManifest`, so changes to MWA/the `app/patches/` patches need
a new build. Convenient for us: hand out one `preview` APK (§8) and then push chart/UI changes without reinstalling.

## 11. Firebase App Distribution 📄

Free, without Play: up to 500 testers per project, 200 per distribution; a signed APK is uploaded to the Firebase
console, testers install "App Tester" and receive builds with notifications. An alternative to §9 if the team
already lives in Firebase; otherwise EAS internal is simpler (no extra app for the tester).

## 12. Google Play internal testing 📄

Up to 100 testers, the build appears within minutes without a full review, updates come through the Play Store.
Needs a Play Console account and an app entry in Play — for us that means setting up a listing earlier than planned.
The Play signature (App Signing) is a different key from the dApp Store one, and its fingerprint must also be in the relayer's assetlinks.

## 13. Cloud real devices 📄

**Android Device Streaming** (Android Studio Jellyfish+, Firebase): real Pixel/Samsung/Xiaomi in Google data centers,
adb over SSL — all adb commands work, so in theory fakewallet can be installed too. **BrowserStack
App Live**: an APK/AAB on a real device in the browser. Both are useful for checking other models/Android versions,
but a wallet on such a device is a separate quest (fakewallet through adb — yes; Phantom with login — no), and there is no Seeker
there.

## 14. Emulator in the browser (Appetize.io) 📄

Upload an APK and run it in the browser, with logs and network; it has an Expo integration. For us — only showing the UI without
a wallet: there is no MWA wallet on such an emulator, Connect will not work. Suitable for a demo of the chart/markets from the relayer's public
data, not for trading.

## 15. Solana dApp Store 📄

Preinstalled on every Seeker, no platform fees. It requires a **release APK signed with a separate key**
(not the one for Play), debug builds are not accepted; publishing through the `dapp-store` CLI with publisher/app NFTs
(skill `solana-mobile-publishing`). Testing works on a regular Android/emulator, a Seeker is not required.
Not planned for the MVP, but it is the only "real" path onto Seeker without sideloading.

## 16. Public APK URL for hackathon submissions

Hackathon forms ask for an "Android APK URL" — a direct link from which a judge downloads and installs the app **without Metro,
without adb and without your involvement**. So it is always §8 (a standalone release/preview build), never the dev client:
`app-debug.apk` (110 MB) does not start without Metro.

What has to be done once (the owner — the key and the relayer deploy; the agent can prepare everything else):

1. **Release keystore.** `keytool -genkeypair -v -keystore keys/android/dexxer-release.keystore -alias dexxer
   -keyalg RSA -keysize 2048 -validity 10000`; keep it only under `keys/` (gitignored, like the program keypairs) and in
   a password manager. Fingerprint: `keytool -list -v -keystore … | grep SHA256`. Losing the key = a different package
   for Phantom/DAL and no way to update already installed copies.
2. **Fingerprint in the relayer.** Add the SHA-256 to `ASSETLINKS_SHA256_FINGERPRINTS` (comma-separated after the
   debug keystore fingerprint) and redeploy (`railway up --service relayer --ci`); check
   `GET /.well-known/assetlinks.json` — otherwise Phantom will refuse to verify the identity.
3. **Build.** Either locally: `signingConfigs.release` in `app/android/app/build.gradle` with passwords from env (not in git),
   `cd app/android && ./gradlew assembleRelease` → `app/android/app/build/outputs/apk/release/app-release.apk`;
   or EAS: a `preview` profile with `"android": {"buildType": "apk"}` and your own credentials (`eas credentials`),
   `eas build -p android --profile preview`. `EXPO_PUBLIC_*` (relayer, identity URI) are baked in at build time —
   point them at the live relayer **before** the build.
4. **Hosting with a permanent URL.** The `VitalikCholan/dexxer` repo is public, so the simplest is a **GitHub Release**:
   `gh release create v0.6.0 app-release.apk#dexxer-v0.6.0.apk --title "Dexxer v0.6.0 (devnet)" --notes "…"`.
   URL for the form: `https://github.com/VitalikCholan/dexxer/releases/download/v0.6.0/dexxer-v0.6.0.apk`;
   a stable "always latest" one —
   `https://github.com/VitalikCholan/dexxer/releases/latest/download/dexxer.apk` (then name the file the same
   `dexxer.apk` in every release). The limit is 2 GB per file, links do not expire. Fallbacks: an
   EAS internal distribution page (§9; access without login must be enabled, artifact retention on
   the free tier is limited — check before the deadline), Cloudflare R2/S3 with a public object. Do not use the relayer
   on Railway for a 100-MB file.
5. **Check as a judge.** A clean AVD (`emu create … --start --tune`), **without** Metro and the proxy, with fakewallet
   or Phantom: `curl -L -o dexxer.apk <URL> && adb install dexxer.apk`, onboarding → deposit from the faucet → trade →
   chart. The same on a real phone with Phantom. Make sure `adb logcat` shows no requests to
   `localhost:8081`.
6. **In the submission**, next to the URL: that it is devnet, that dUSDC comes from the faucet in the app, that an MWA wallet is needed
   (Phantom in Testnet Mode, Solflare or Seeker), the minimum Android version (from `app.json`/`build.gradle`),
   the file's SHA-256 (`shasum -a 256 dexxer.apk`) and the release number. A QR for the URL is handy for a booth.

Repeat submissions: new tag → new release → the same `latest` URL. The key, the fingerprint and the env do not change.

## What to choose

- **Quickly check a change:** §1 (AVD + fakewallet) — fully automated, the agent can do it alone.
- **Check wallet scenarios (nonce, DAL, ~35 s prompt):** §2 or §3 with Phantom.
- **Show someone on their phone:** §7 + §5 `--tunnel` (today) or §8 (after setting up a keystore).
- **Seeker:** §3 over USB, then §4 — the only place where Seeker specifics are visible.
- **Hand out to 5–20 testers:** §9 EAS internal (QR), then §10 OTA for UI fixes.
- **Show on a big screen with a real wallet:** scrcpy from a real phone.
- **"Android APK URL" for a hackathon:** §16 — a release APK in a GitHub Release of the public repo, the `latest` link.

## Sources (02.10.2026)

- Expo: [Android development build](https://docs.expo.dev/tutorial/eas/android-development-build/),
  [Build APKs](https://docs.expo.dev/build-reference/apk/), [Expo Orbit](https://github.com/expo/orbit),
  [EAS Updates with Orbit](https://expo.dev/blog/launching-eas-updates-with-orbit),
  [Internal distribution](https://expo-expo.mintlify.app/deployment/internal-distribution),
  [Share previews](https://docs.expo.dev/tutorial/eas/team-development/)
- Google: [Firebase App Distribution](https://firebase.google.com/docs/app-distribution),
  [Android Device Streaming](https://developer.android.com/studio/run/android-device-streaming),
  [Firebase vs Internal Test Track](https://glovorytech.medium.com/firebase-app-distribution-vs-internal-test-track-7f91680467bb)
- Solana Mobile: [dApp Store](https://docs.solanamobile.com/solana-mobile-stack/dapp-store),
  [Publishing checklist](https://docs.solanamobile.com/dapp-publishing/prepare),
  [Helius: Publishing Solana Mobile Apps](https://www.helius.dev/blog/publishing-solana-mobile-apps)
- Other: [scrcpy](https://scrcpy.dev/), [Appetize uploading apps](https://docs.appetize.io/platform/app-management/uploading-apps),
  [BrowserStack App Live](https://www.browserstack.com/docs/app-live/get-started)
