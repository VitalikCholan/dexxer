# Checks 8 / 10 / 11 — mobile (Android emulator)

Status: **ALL PASS** — run 19.09.2026 14:22–14:42 (Europe/Kiev) by the human on the emulator.
Screens: `app/src/spikes/Check8.tsx`, `Check10.tsx`, `Check11.tsx`, tab `app/app/(tabs)/spikes.tsx`.

## Environment

- Emulator: `local_phone` (Pixel 7 profile, `system-images/android-36.1/google_apis_playstore/arm64-v8a`, created via `npx solana-mobile@latest emu create local_phone --device pixel_7 --start --tune`)
- Mock wallet: `fakewallet` via `npx solana-mobile@latest device install fakewallet`
- Dev client: `npx expo run:android` from `app/` (Gradle 8 m 47 s, Metro bundle 2623 modules); Hermes (default, no `jsEngine` set), React Compiler on
- Wallet: `DR16D5BEAn49deCA6RXYjbqpJZAX2rxtfxEcksnVXA1A` (fakewallet), funded 0.5 SOL from `payer`

## Check 8 — MWA signs a transaction whose blockhash comes from the TEE

Step 0 was replaced by an in-app **Onboard** button (no key export): `initialize` + `delegate` (L1, wallet-submitted via `signAndSendTransaction`), then `init_permission` + `set_privacy(true)` as ONE transaction with an **ER blockhash**, signed via MWA `signTransactions`, sent by the app to `devnet-tee.magicblock.app` with the wallet's own TEE token.

- counter PDA `6S5yRVbL8gPRDNQR6QE3KZwbV5vcNuAd1ommoKwQJJ4R`, router `delegated=true fqdn=https://devnet-tee.magicblock.app/`
- onboarding ER tx `2HCu8KYybUKaGLUJCARMJWnz4NMCVdKbtvuoCuWgk1ZdH2Bo7oKh8JEBG3Pygf9StUqKisjXJpa2TUHcL8kKSuRX` — blockhash→signed **4629 ms**, total 7312 ms
- `increment` ER tx `s7UfiXSCd7AS5Li9m53k2acEXXrjWaJHjtKqyXcQKqVhTVofxgX67GtmmRpH2krb7nW6MrESJbeXnvwXx3fev2q` — blockhash→signed **1598 ms**, total **3112 ms**

Result: **PASS**. MWA-signed transactions with an ER blockhash are accepted by the TEE; an MWA round-trip of 1.6–4.6 s fits inside the ER blockhash lifetime.

### Runtime findings (not in the brief)
1. `useMobileWallet().account.address` is a **base58 string at runtime** although the `.d.ts` says `PublicKey` → `.toBuffer()` threw `undefined is not a function`. Normalised in `app/src/spikes/mwa.ts::toPublicKey`.
2. MWA `signMessages` (fakewallet) returns **169 bytes = message(105) ‖ signature(64)**, not the detached signature; `getAuthToken` needs the last 64 bytes. Normalised in `mwa.ts::pickSignature` (picks the 64-byte slice that verifies).
3. L1 legs failed with `Blockhash not found` when the app fetched the blockhash, waited for the MWA prompt (+ human Back-navigation) and sent itself — the round-trip exceeded the L1 blockhash lifetime. Fixed by `signAndSendTransaction` (wallet submits immediately). ER legs keep sign-then-send because the app must target the TEE endpoint.
4. Metro hot-reload during an MWA session kills it (`SolanaMobileWalletAdapterProtocolError: -1/authorization request failed`) — do not push code while a wallet flow is in progress.

## Check 10 — `onAccountChange` over the token-authenticated TEE WS fires

Result: **PASS** — `subscribed to 6S5yRVbL8g…QJJ4R`, `update after 38382 ms, 48 bytes`. The 38 s is the time the human spent in the two MWA prompts of the Check 8 increment; the WS delivered the change immediately after the ER tx confirmed. `wss://devnet-tee.magicblock.app?token=…` works from React Native (`rpc-websockets` resolved via Metro file fallback — warning only).

## Check 11 — `verifyTeeRpcIntegrity` under Hermes

Result: **PASS in 3246 ms** on Hermes, no JSC toggle needed. The expected `WebAssembly is not defined` failure did not occur; whether `@phala/dcap-qvl` ran its WASM or a JS path was not inspected — the observable is that the SDK call resolves. Reminder from spec §0.4: this proves a genuine TDX quote, not an MRTD/RTMR allowlist.

## Decisions

- Risk #7 (MWA + ER-blockhash signing): **closed** — works; budget ≈1.6–4.6 s per prompt. `set_session` via MWA on the ER is viable; trades stay on the session key (spec §5.4).
- §5.5 WS vs poll: **WS** `accountSubscribe` with token is the primary path; 1 s poll only as reconnect fallback.
- Risk #6 (attestation under Hermes): **closed** — `verifyTeeRpcIntegrity` runs on Hermes; no shim. Keep the MRTD allowlist as v1.

## How to run

From `/Users/vitalikcholan/Projects/mobile_perp_dex`:

**0. (Superseded)** The in-app **Onboard** button in Check 8 now creates/delegates the counter for the connected wallet; no key export is needed. Kept below for history.
Check 8 and Check 10 must operate on the **same** counter PDA the app derives from the
connected Mock Wallet's pubkey. The spike script derives its PDA from `spikes/keys/user.json`,
so those two identities have to be the same key:

- export the Mock Wallet (fakewallet) keypair from the emulator and write it to
  `spikes/keys/user.json`, then run `npx tsx spikes/01-private-counter-tee/check.ts` once —
  it will `initialize`/`delegate`/`initPermission`/`setPrivacy` **that** counter, and every
  later `check.ts` run increments the same PDA;
- alternative, if the Mock Wallet key cannot be exported: add the emulator wallet's pubkey as
  an `EphemeralPermission` member on an existing counter, and make the app derive that
  counter's PDA instead.

Record which of the two was used in the Check 8 section above.

1. Create and boot an AVD (Pixel 7, arm64 on Apple Silicon, API 34):
   ```
   npx solana-mobile@latest emu create local_phone --device pixel_7 --start --tune
   ```
2. Install the Mock Wallet (fakewallet) APK on the running emulator:
   ```
   npx solana-mobile@latest device install fakewallet
   ```
3. Build and launch the dev client:
   ```
   cd app
   npx expo run:android
   ```
4. In the app, connect the wallet (Account tab → Connect, authorize in the Mock
   Wallet), then open the **Spikes** tab ("Week-0 mobile checks").
5. Tap **Run Check 8**, **Run Check 10**, **Run Check 11** in turn (Check 10 needs a
   trigger from outside the app while it's listening — from the repo root:
   `npx tsx spikes/01-private-counter-tee/check.ts`, which increments the counter
   set up in **step 0**; if step 0 was skipped, the script increments a different PDA
   than the one the app is watching and Check 10 will time out for the wrong reason).
6. Copy each screen's `selectable` output text (long-press to select/copy on
   Android) into the corresponding section above, along with the emulator/wallet
   versions.
7. Commit this file with the filled-in results.
