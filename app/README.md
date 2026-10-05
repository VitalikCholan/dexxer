# Dexxer — mobile app

The Android client (Expo / React Native) of the Dexxer private perpetual DEX on Solana Seeker:
signing through Mobile Wallet Adapter, private state through MagicBlock PER (TEE), public
data through the relayer (`services/relayer`). Positions are 16 slots of one `Positions` account
(program `dexxer_core`, spec `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.9).

## Running

```bash
. "$HOME/.nvm/nvm.sh" && nvm use   # Node from .nvmrc
npm install
npm run android                    # dev client on an emulator/device
npm run dev                        # Metro only
```

Emulator, proxy, wallets (fakewallet/Phantom) and pitfalls — `docs/emulator-runbook.md`.

## Checks

```bash
npx tsc --noEmit && npm run lint:check && npm test && npm run format:check
```

`npm test` — `node:test` through `tsx` (`test/*.test.ts`), no device needed.

## IDL and decoders

- The IDL is only the canonical `idl/dexxer_core.json` at the repo root, imported directly
  (`src/lib/anchor.ts`); Metro sees it through `watchFolders` in `metro.config.js`.
  There is no copy of the IDL in `app/`, and there must not be one.
- Accounts are decoded only by hand, by offsets (`src/lib/codecs.ts`, `src/lib/positions.ts`):
  Anchor decoding does not work on Hermes, and the Borsh coder does not read the zero-copy `Positions`.
  The `Positions` offsets are pinned by the Rust test `offsets_match_the_off_chain_decoders`.
- Instruction builders are checked against the IDL key by key: `test/ixAccounts.test.ts`.

## Configuration

Addresses are set by `EXPO_PUBLIC_*` variables (`src/lib/config.ts`): relayer —
`EXPO_PUBLIC_RELAYER_URL`, then `EXPO_PUBLIC_BASE_RPC`, `EXPO_PUBLIC_TEE_RPC`,
`EXPO_PUBLIC_IDENTITY_URI` and so on. Metro substitutes them only when
`process.env.EXPO_PUBLIC_*` is read statically.
