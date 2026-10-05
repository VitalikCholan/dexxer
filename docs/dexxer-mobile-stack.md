# Dexxer — mobile stack (React Native)

The frontend stack for a private perp DEX on Solana Seeker. Current as of September 2026.

---

## 1. Foundation

| Layer | Choice | Why |
|---|---|---|
| Framework | **Expo + custom dev client** (`expo-dev-client`) | MWA uses Kotlin modules — Expo Go does not work. A requirement, not an option |
| Navigation | **Expo Router** | File-based routing, built in, minimal code |
| Language | **TypeScript** (strict) | — |
| Styles | **NativeWind** | Tailwind syntax in RN; faster than StyleSheet, lighter than Tamagui |
| Scaffold | **`create-solana-dapp`** (Expo template) | Polyfills, MWA and the provider are already wired together |

---

## 2. Solana layer

### Week-0 decision: `@solana/kit` or `@solana/web3.js`

The Solana Mobile docs recommend `@solana/kit` for new apps. But the choice is dictated by the libraries the project depends on:

- `@coral-xyz/anchor` (the client for the perp-core fork)
- `@magicblock-labs/ephemeral-rollups-sdk`

**Check the `package.json` of both SDKs before the first component.** If they are on web3.js v1 — take `@wallet-ui/react-native-web3js`, otherwise you will have to convert `PublicKey ↔ Address` at every boundary. Forecast: web3.js.

### Mandatory polyfills

```
react-native-quick-crypto
react-native-nitro-modules
```

`polyfill.js` is imported on the **first line** of `index.js`, before any Solana code.

---

## 3. Wallet and sessions

| Component | Package / source | Role |
|---|---|---|
| MWA | `@wallet-ui/react-native-web3js` (or `-kit`) | `MobileWalletProvider` + `useMobileWallet`. One authorization |
| Session Keys | MagicBlock SDK; reference — the `flash-trade/session-keys` fork (MIT) | MWA signs the session key creation once → after that trading actions are signed by the ephemeral key without a bottom sheet. This is the "one tap" |
| Key storage | `expo-secure-store` | The private key — not in AsyncStorage |
| PER access | SIWS (`signIn`) | The token for the ER's token-gated TEE endpoint is issued for a signed challenge; SIWS covers this with one prompt |

---

## 4. Data and state

| Task | Tool |
|---|---|
| RPC reads | **TanStack Query** — `staleTime`, refetch on focus |
| UI state | **Zustand** — selected market, order draft |
| Real time | **WebSocket `accountSubscribe`** on the ER's private RPC (the user's position). Reference — `flash-trade/magicblock-grpc-example` |
| Cache | **`react-native-mmkv`** — instead of AsyncStorage |

---

## 5. Charts

**`react-native-wagmi-charts`** — candles and lines on Reanimated + Skia, gestures out of the box. Victory Native is overkill for one market.

---

## 6. Push when approaching liquidation

> ⚠️ Privacy trap: a backend that watches positions becomes one more party that sees them.

| Stage | Scheme | Trade-off |
|---|---|---|
| **MVP** | The app itself reads its position through the token-gated ER endpoint and schedules a **local** notification (`expo-notifications`) when a margin threshold is reached | Zero servers, zero leak. Does not work if the system has killed the app |
| **v1** | A notifier inside the ER/TEE as a permissioned viewer → Expo Push | Consistent with the trust model — the TEE sees everything anyway |

For the deck: competitors put in a backend without thinking.

---

## 7. Seeker specifics

- **Detecting Seeker Users** (a recipe from the docs) — Seed Vault-specific UX only on the device.
- **Digital Asset Links** — the wallet checks `identity.uri` against `/.well-known/assetlinks.json` on the domain. Without this, MWA authorization may be rejected. **`dexxer.xyz` is needed for MWA, not only for the landing page.** Do it in week 1.
- `identity.icon` — a **relative path** from `uri`, not an absolute URL. The Kotlin client is strict.
- `identity.uri` — absolute, mandatory.

---

## 8. Build and tests

| Task | Tool |
|---|---|
| Build | **EAS Build** → APK (check the current dApp Store requirements at submission) |
| Development wallet | **Mock MWA Wallet** on the emulator |
| E2E | **Maestro** — YAML scenarios, simpler than Detox |
| Unit / components | **Jest + React Native Testing Library** |

---

## 9. What not to use

- **Redux** — overkill for this amount of state
- **Expo Go** — will not work with MWA
- **Tamagui** — a week of setup
- **A separate NestJS backend in the MVP** — everything is read from the ER directly; having no backend is a plus for privacy

---

## 10. Week-0 order of actions

1. Check the web3.js versions in Anchor and the MagicBlock SDK → choose `-web3js` or `-kit`
2. `create-solana-dapp` → Expo template
3. The `react-native-quick-crypto` polyfill on the first line
4. MWA `connect` on the emulator with the Mock Wallet
5. Then — positions

---

## Sources

- Solana Mobile docs — React Native: Installation, Setup, Quickstart, MWA TypeScript Reference
- MagicBlock docs — Private Ephemeral Rollups, Session Keys
- `flash-trade/session-keys`, `flash-trade/magicblock-grpc-example`
