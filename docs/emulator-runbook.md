# Runbook: emulator, Metro, proxy, wallets (24.09.2026)

How to bring up a local environment for a live run of the app on an Android emulator with fakewallet
or Phantom, and how to shut it down cleanly. Everything is measured on macOS + Android SDK
(`~/Library/Android/sdk`), Node 24 via nvm.

All install options (emulator, USB, Wi-Fi, EAS, sideload, release) — `docs/android-install-options.md`.

## 0. What is on the machine

| What | Where | Note |
| --- | --- | --- |
| AVD `local_phone` | google_apis, no root | fakewallet + dev client `com.dexxer.app`; demo wallet `5Ahk…xf2B` |
| AVD `phantom_phone` | Play image, Google account | Phantom (devnet mode, "Testnet Mode") + dev client; wallet `A3xa…Ad97` |
| Metro | `app/`, port 8081 | the dev client gets the bundle through `adb reverse` |
| Proxy | `scripts/emu-proxy.cjs`, port 8888 | DNS is done by the Mac, not the guest |
| Relayer | Railway, `https://relayer-production-1ae7.up.railway.app` | always online, no need to start it |

One emulator at a time. Two at once only raises pointless "why are there two" questions.

## 1. Start (full sequence)

```bash
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$HOME/Library/Android/sdk/platform-tools:$HOME/Library/Android/sdk/emulator:$PATH"

# 1. Proxy on the Mac (log in /tmp/emuproxy.log)
nohup node scripts/emu-proxy.cjs > /tmp/emuproxy.log 2>&1 &

# 2. Metro (log in /tmp/metro.log)
(cd app && nohup npx expo start --dev-client --port 8081 > /tmp/metro.log 2>&1 &)

# 3. Emulator — MUST have the proxy and DNS flags
emulator -avd local_phone -http-proxy http://10.0.2.2:8888 -dns-server 8.8.8.8,8.8.4.4 &
#   (for Phantom: -avd phantom_phone)

# 4. Wait for boot
until adb shell getprop sys.boot_completed 2>/dev/null | grep -q 1; do sleep 3; done

# 5. System proxy in the guest (the -http-proxy flag does NOT set it by itself) + bridge to Metro
adb shell settings put global http_proxy 10.0.2.2:8888
adb reverse tcp:8081 tcp:8081

# 6. Restart the wallet — a process started BEFORE step 5 does not see the proxy
adb shell am force-stop com.solana.mobilewalletadapter.fakewallet   # or app.phantom

# 7. Open Dexxer through the dev client
adb shell am start -a android.intent.action.VIEW -d "app://expo-development-client/?url=http://localhost:8081" com.dexxer.app
```

Checking that everything is alive:

```bash
lsof -nP -i :8081 -i :8888 | grep LISTEN                 # two LISTEN
tail -n 3 /tmp/emuproxy.log                              # CONNECT devnet-tee.magicblock.app:443 …
adb logcat -d | grep ReactNativeJS | grep -E "loaded|UnknownHost" | tail -n 3
```

`UnknownHostException` or `Failed to connect to /10.0.2.2:8888` = step 1 or step 5 did not work.

## 2. Wallets

**fakewallet** (`local_phone`): AUTHORIZE on the signing screen is the top-left button
(`adb shell input tap 206 672` on 1080×2400); on the "AUTHORIZE DAPP" screen (fresh authorize)
the button is lower (`206 1085`). It rotates the auth token on every reauthorize, and on a fresh authorize it creates
a **new account** — this is expected.

**Phantom** (`phantom_phone`): devnet in Settings → Developer → Testnet Mode. SOL is sent to the wallet
by the user from their CLI (`solana transfer <addr> 0.2 -u devnet --allow-unfunded-recipient`);
with SOL ≥ 0.05 onboarding is self-funded (no "Failed to simulate"). A Phantom prompt takes
~35–40 s because of 429s from `api.devnet.solana.com` — which is why all owner L1 txs use a durable nonce
(`app/src/lib/nonce.ts`). In the Phantom logs: `IdentityVerifier: DAL verification … true`.

## 3. What to look at in the logs

```bash
adb logcat -c                                                  # clear before a run
adb logcat -d -v time | grep ReactNativeJS | grep -E "\[dexxer\]|\[mwa\]"        # the app
adb logcat -d -v time | grep -E "invoke \`|Responding with error|DAL verification"   # MWA + wallet
adb exec-out screencap -p > /tmp/screen.png                    # screenshot
adb shell dumpsys window | grep mCurrentFocus                  # who has focus
```

Fast Refresh does not always deliver new modules (especially non-components) — after edits in
`src/lib/*` do a full reload: `adb shell input text "RR"` with the app open.

## 4. Shutdown

```bash
adb emu kill; sleep 4; pkill -f "qemu-system"       # emulator
pkill -9 -f "expo start"                             # Metro
pkill -9 -f "emu-proxy.cjs"                           # proxy
adb devices; lsof -nP -i :8081 -i :8888 | grep LISTEN   # should be empty
```

## 5. Known pitfalls

- `emulator -http-proxy` does not set `http_proxy` in the guest — `settings put` is needed.
- Processes started before `settings put global http_proxy` do not see the proxy — force-stop them.
- Without the proxy the guest cannot resolve Cloudflare/AAAA hosts (`rpc.magicblock.app`); with Private
  DNS `dns.google` — the opposite, only AAAA. The proxy fixes both.
- `adb -s <serial>` through a variable with a space is not split in zsh — write the serial explicitly.
- An error toast in the app disappears after ~5 s — read `[dexxer] … failed` in logcat, not the screen.
- A blockhash on devnet lives ~25 s (Alpenglow) — any slow wallet prompt on a
  blockhash tx = "confirm timeout". Owner L1 txs must use a nonce.

## 6. Smoke on the slots program (plan 4)

**Not run in plan 3** (01.10.2026: only `tsc`/lint/unit and `expo export`); **plan 4 —
steps 1–7 PASS, 8–9 not done** (1 — by logs and L1, 2–7 — as reported by the owner; results are at the end of the section). A checklist
for the user with a real wallet (fakewallet or Phantom). Prerequisite: the new program is
deployed, `bootstrapDevnet` and `add-market` (BTC etc.) have run, the relayer is on the new address,
the APK is built for the same program. Next to each step — what to look for in logcat (`[dexxer]`).

1. **Onboarding with two accounts.** Fresh wallet → Onboarding → Confirm. Expected: three
   L1 legs (`faucet+init_user`, `delegate_spl`, `delegate_user`) and an ER leg
   (`permissions+session`). `UserAccount` and `Positions` under the Delegation Program, "You're set".
   Record the leg tx sizes if they are visible in the log.
2. **Market selection.** Trade → `MarketPicker` shows SOL and the markets from `GET /markets`. Pick BTC:
   the header becomes `BTC-PERP`, the price and chart are BTC. Restart the app: BTC is still selected
   (`dexxer.market`).
3. **Open on SOL and on BTC.** Open a position on SOL, then on BTC. Both txs land,
   each market's price updates separately.
4. **Position list.** Positions — two cards, `SOL-PERP` and `BTC-PERP`, each with its own mark.
   Actions on the BTC card manage the BTC position, not SOL.
5. **Partial decrease.** Decrease on one position (not fully). History shows a
   `Partial close` record, the position stays open with a smaller size.
6. **Close.** Close with one tap on the other card. The card disappears, `Closed` appears in History.
7. **Archive after restart.** Fully close the app and open it again. History shows the same
   records (archive `dexxer.history.<owner>`), the "seen …" time is the same.
8. **Exit with two markets.** Close everything, withdraw margin to 0 → Account → Exit. In the log /
   in the `undelegate_user` tx, `remaining_accounts` has two markets (SOL and BTC). The tx lands,
   both accounts are undelegated.
9. **Re-onboarding after the janitor.** Right after Exit open Onboarding: the state is
   `Exited` (a waiting message, no steps). Within ≈5 min (the relayer's commit cycle,
   `COMMIT_INTERVAL_MS`) the janitor closes the accounts (`close_exited_user`), and Onboarding
   returns to normal onboarding. Go through it again.

Record any failed step with the logcat line and the tx signature in the plan-4 `week6` results.

### Smoke results (plan 4, Task 6, 01.10.2026)

Run by the owner on AVD `local_phone` (fakewallet); the agent did not press wallet buttons. Environment: dev
client `com.dexxer.app`, `npm run android -- --no-bundler` (incremental build, 55 s), APK
`app/android/app/build/outputs/apk/debug/app-debug.apk` 110 870 032 B, sha256
`4178ed2223f56777a6766f8cdf60a558eb35d3cc7890a98840fd4c464137e531`; signing certificate SHA-256
`FA:C6:17:45:DC:09:…:03:3B:9C` == default in `services/relayer/src/assetlinks.ts` == live
`/.well-known/assetlinks.json`. Metro bundle: program id `Fyg2…UfCY` ×7, `G2ok…` ×0. Relayer —
`https://relayer-production-1ae7.up.railway.app` (deployment `8b33d95d`, `COMMIT_INTERVAL_MS=300000`).
Owner (fresh fakewallet account): `2TQerBRHvjxR3hGbSqGaSKZWBhbiB7mRfEWCeVeEFgWi`.

| Step | Result | What was observed |
|---|---|---|
| 1 | PASS | `[dexxer] selfFund: owner has 0 lamports, min 50000000 → sponsored`; `leg faucet+init_user: 3 ixs (+advance+2 CB), 795 bytes`, `leg delegate_spl: … 812 bytes`, `leg delegate_user: 1 ixs (+advance+2 CB), 765 bytes`, `leg permissions+session: 2 ixs (+blockhash), 506 bytes`; `feePayer` of the three L1 legs — `fee_payer` `3HgD…3Chnt`, of the ER leg — owner. On L1 (public RPC): `NtRjGqL7…` 20:35:10, `3cCf6rVL…` 20:35:11, `36BWmyeX…` 20:35:12 (Kyiv time, UTC+3; same below), no errors. Then the deposit: `selfFund … min 1000000 → sponsored`, `signOwnerL1: durable nonce slot 0 8HijrvhF…`, the wallet returned `ixs=[111111,Comput,Comput,Fyg2yJ]` (advance first, own CBs), `sendL1Sponsored: sent 2YRYNrwZ…` (20:35:26 on L1) |
| 2 | PASS | BTC selection, persisted after restart (as reported by the owner) |
| 3 | PASS (after the fix for defect #1) | open on SOL and BTC — toasts (ER actions do not write signatures to logcat) |
| 4 | PASS | two cards, `/positions` in the route logs |
| 5 | PASS | `Partial close` in History |
| 6 | PASS | the card disappeared, `Closed` in History |
| 7 | PASS | History archive after an app restart |
| 8 | **not done 01.10.2026** | the owner postponed it |
| 9 | **not done 01.10.2026** | the owner postponed it |

Steps 2–7 are PASS as reported by the owner; the logs show only routes (`Track /trade`, `/positions`,
`/history`, `/account`), because ER actions do not log signatures.

**Defect #1 — fixed in `c0d39db`.** Open silently did nothing on any market. In Hermes
`Buffer.subarray().toString()` returns `"83,79,76,0,0,0,0,0"`, not `"SOL"`, so `decodeMarket.symbol`
never equalled the selected symbol: market/accounts were `null`, `handleOpen` silently returned. Found
with a temporary DEBUG log (`[dexxer] DEBUG open gate … marketSymbol: '83,79,76,0,0,0,0,0'`; reverted,
not committed). The fix — byte-by-byte decoding of the symbol (`pdas.ts`, `codecs.ts`) + a regression test.
Applied by a JS reload at 20:46; steps 3–7 passed on that bundle, no new APK was built.

**Defect #2 — fixed in `b276769`.** HYPE, Open Short 7× → toast `insufficient margin (6010)`:
`LeverageSlider` had a hard-coded 1–10× and did not know the market's `max_lev_bps` (HYPE/ZEC — 5×). The program behaved
correctly. The fix — the slider and MAX are capped by `maxLeverage(market)`. JS reloaded at 20:58, **not
re-checked on the device**.

Limits of the evidence: ER actions (open/increase/decrease/close/add margin/exit) do not write a signature to logcat,
failures in Trade/Positions show only as a toast; Exit's `remaining_accounts` (step 8) cannot be checked from the logs — only
by the L1 state at the owner's address.
