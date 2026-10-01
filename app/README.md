# Dexxer — мобільний застосунок

Android-клієнт (Expo / React Native) приватного perpetual DEX Dexxer на Solana Seeker:
підпис через Mobile Wallet Adapter, приватний стан — через MagicBlock PER (TEE), публічні
дані — через relayer (`services/relayer`). Позиції — 16 слотів одного акаунта `Positions`
(програма `dexxer_core`, spec `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.9).

## Запуск

```bash
. "$HOME/.nvm/nvm.sh" && nvm use   # Node з .nvmrc
npm install
npm run android                    # dev-client на емуляторі/пристрої
npm run dev                        # лише Metro
```

Емулятор, проксі, гаманці (fakewallet/Phantom) і пастки — `docs/emulator-runbook.md`.

## Перевірка

```bash
npx tsc --noEmit && npm run lint:check && npm test && npm run format:check
```

`npm test` — `node:test` через `tsx` (`test/*.test.ts`), без пристрою.

## IDL і декодери

- IDL — лише канонічний `idl/dexxer_core.json` у корені репо, імпортується напряму
  (`src/lib/anchor.ts`); Metro бачить його через `watchFolders` у `metro.config.js`.
  Копії IDL в `app/` немає й не має бути.
- Акаунти декодуються лише вручну за зміщеннями (`src/lib/codecs.ts`, `src/lib/positions.ts`):
  Anchor-декодування на Hermes не працює, а zero-copy `Positions` Borsh-кодер не читає.
  Зміщення `Positions` запінені Rust-тестом `offsets_match_the_off_chain_decoders`.
- Білдери інструкцій звіряються з IDL поключно: `test/ixAccounts.test.ts`.

## Конфігурація

Адреси задаються змінними `EXPO_PUBLIC_*` (`src/lib/config.ts`): relayer —
`EXPO_PUBLIC_RELAYER_URL`, далі `EXPO_PUBLIC_BASE_RPC`, `EXPO_PUBLIC_TEE_RPC`,
`EXPO_PUBLIC_IDENTITY_URI` тощо. Metro підставляє їх лише за статичного читання
`process.env.EXPO_PUBLIC_*`.
