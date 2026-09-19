# Checks 8 / 10 / 11 — mobile (Android emulator)

Status: PENDING — run on emulator. Code (three spike screens + Spikes tab route) is
committed and typechecks clean; nobody has run the app on an emulator yet. This file
is the skeleton to fill in after that run — see "How to run" below.

## Environment (fill in)

- Emulator: PENDING — run on emulator (expect: Pixel 7 profile, arm64 system image
  on Apple Silicon, API 34, created via `npx solana-mobile@latest emu create local_phone
  --device pixel_7 --start --tune`)
- Mock wallet (fakewallet): PENDING — run on emulator (version installed via
  `npx solana-mobile@latest device install fakewallet`)
- Dev client build: PENDING — run on emulator (`npx expo run:android` from `app/`)

## Check 8 — MWA signs a transaction whose blockhash comes from the TEE

Precondition used (record which): PENDING — run on emulator
  - [ ] ran `spikes/01-private-counter-tee/check.ts` once with the emulator wallet's
        exported pubkey as the `user` keypair, or
  - [ ] added the emulator wallet's pubkey as an `EphemeralPermission` member on an
        existing counter

Result: PENDING — run on emulator
  - PASS — signature: `<…>`
  - FAIL — raw error: `<…>` (a program/permission error still answers the question:
    does MWA sign an ER-blockhash tx and does the TEE accept the signature — record
    it verbatim either way)

## Check 10 — `onAccountChange` over the token-authenticated TEE WS fires

Result: PENDING — run on emulator
  - PASS — first update latency: `<…> ms`
  - FAIL — no update within 60s; fallback: 1s poll (spec §5.5)
  - raw error (if the WS never connects): `<…>`

## Check 11 — `verifyTeeRpcIntegrity` under Hermes

Result: PENDING — run on emulator
  - PASS — `<…> ms`
  - FAIL — raw error text verbatim: `<…>` (expected: `WebAssembly` missing under
    Hermes — that is itself a valid result)
  - JSC engine toggle attempt (`"jsEngine": "jsc"` in `app.json`), tried only if
    Check 11 fails under Hermes: PENDING — run on emulator (result: `<…>`)

## Decisions (fill in after the run)

- Risk #7 (MWA + ER-blockhash tx signing on real mobile stack): `<…>`
- §5.5 WS vs. poll for account updates on mobile: `<…>`
- Risk #6 (TDX attestation library under Hermes — shim vs. v1 with honest note): `<…>`

## How to run

From `/Users/vitalikcholan/Projects/mobile_perp_dex`:

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
   `npx tsx spikes/01-private-counter-tee/check.ts`, which increments the connected
   wallet's counter).
6. Copy each screen's `selectable` output text (long-press to select/copy on
   Android) into the corresponding section above, along with the emulator/wallet
   versions.
7. Commit this file with the filled-in results.
