# Позиції-слоти, план 3 з 4: app

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** мобільна апка працює з програмою планів 1–2 (слоти `Positions`, без розкриття, кілька ринків): онбординг на два акаунти, торгівля на обраному ринку, список позицій, History з кільця історії плюс локальний архів, вихід; Ledger і commit-reveal прибрано, Receipt лишається; апка споживає канонічний IDL і новий API relayer-а.

**Architecture:** спершу IDL і кодеки (один декодер `Positions` за зміщеннями, запіненими Rust-тестом; `UserAccount`/`Market`/`Config` під новий лейаут), потім PDA/акаунти онбордингу й виходу, потім ринок як параметр торгівлі (`useMarkets()` з `GET /markets`, вибір ринку в `TradeScreen`, `TradeAccounts` з ринком), список позицій зі слотів, History з кільця + архів на пристрої, і наприкінці видалення Ledger/commit-reveal і документи. Усі екрани лишаються render-only над хуками; жоден декодер не використовує Borsh-кодер Anchor під час виконання (він зламаний у Hermes — `codecs.ts`, шапка файла).

**Tech Stack:** Expo / React Native (Hermes), `@solana/web3.js` v1, `@coral-xyz/anchor` 0.32.1 (лише побудова інструкцій), `@tanstack/react-query`, `expo-secure-store`, `@noble/hashes`; тести — `node --import tsx --test test/*.test.ts` (`node:test`), `expo lint`, `tsc`.

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.9 — 2.9.1 (лейаут `Positions`), 2.9.2 (інструкції), 2.9.4 (App), «Відкрите для плану 3 (app)». Relayer API — `services/relayer/README.md` (REST/WS), `services/relayer/src/indexer/http.ts`.

**План 4 (чистий деплой, devnet-виміри, APK)** — окремо. Цей план нічого не запускає на devnet; емулятор/живий гаманець — за бажанням виконавця лише для smoke, обов'язкові критерії — `tsc`, `expo lint`, `npm test`.

## Global Constraints

- Гілка `positions-slots` (голова плану 2 — `b831466`, PR #11 відкрито). Нічого не пушити й не змінювати PR без прохання; коміт після кожної задачі, `git add <paths>` поштучно; повідомлення комітів англійською з трейлером сесії.
- Змінюється лише `app/` (і `.github/workflows/ci.yml` у Task 1). Програма, relayer, `tests/er`, `idl/` — НЕ чіпати. Канонічний IDL — `idl/dexxer_core.json` (40 інструкцій; CI порівнює з `anchor build`).
- Node — з `.nvmrc` (24.18.0): `. "$HOME/.nvm/nvm.sh" && nvm use`. Перевірка апки: `cd app && npx tsc --noEmit && npm run lint:check && npm test` (базова лінія: 103 тести).
- **Декодери — лише ручні, за зміщеннями** (`Program.account.<x>.fetch()` падає в Hermes — `codecs.ts`). Зміщення `Positions`/`PositionSlot`/`HistoryRecord` — рівно ті, що пінить Rust-тест `offsets_match_the_off_chain_decoders` (`programs/dexxer_core/src/state/positions.rs`) і `tests/er/lib/positions.ts`: `Positions` = disc 8 | owner 32 | slots 16×96 | history 16×96 | history_head u8 | history_len u8 | version u8 | bump u8 | _pad 4 | _reserved 64 (3184 B); `PositionSlot` 96 B: market 32 | size | entry | margin | liq_price | opened_slot | oi_notional | last_liq_sample (u64 ×7) | state u8 (0 Empty, 1 Open) | side u8 (0 Long, 1 Short) | liq_ticks u8 | _pad 5; `HistoryRecord` 96 B: market 32 | size | entry | exit u64 | pnl i64 | fees | opened_slot | closed_slot u64 | side u8 | reason u8 (0 user, 1 liquidated, 2 partial decrease) | _pad 6. Кожен тест кодека кодує акаунт байтами за цією самою таблицею (не Borsh-кодером — `Positions` zero-copy).
- Нові лейаути Borsh-акаунтів (поля в порядку IDL `idl/dexxer_core.json`): `UserAccount`: version u8 | owner | session_key | session_expiry i64 | actions_left u32 | free_margin | locked_margin | last_withdraw_slot u64 | exit_salt [32] | bump u8 | exited bool | rent_payer Pubkey | _reserved [32] (без `nonce`); `Market`: … | mark u64 | mark_slot u64 | **last_print u64 | sample_seq u64** | ema_alpha_bps u16 | liq_hysteresis_ticks u8 | max_stale_ticks u16 | paused_open bool | stale_ticks u16 | bump; `Config`: version | admin | crank | paused | oracle_program | tee_validator | dusdc_mint | scheduler_signer | fee_payer | magic_fee_vault | crank_task_id i64 | bump (без `disclosure_delay_slots`).
- Акаунти інструкцій (IDL, camelCase в anchor-ts): `init_user(exit_salt)`: owner, payer, config, userAccount, positions, systemProgram; `delegate_user`: owner, payer, config, bufferUserAccount, delegationRecordUserAccount, delegationMetadataUserAccount, userAccount, bufferPositions, delegationRecordPositions, delegationMetadataPositions, positions, ownerProgram, delegationProgram, systemProgram; `init_permissions`/`set_session`: owner, config, userAccount, positions, userPermission, positionsPermission, permissionProgram, ephemeralVault, magicProgram; `undelegate_user`: owner, config, userAccount, positions, userPermission, positionsPermission, ephemeralVault, permissionProgram, feeEscrow, magicFeeVault, magicContext, magicProgram + `remaining_accounts` = ринки (read-only, ≤16); торгові (`open/close/increase/decrease_position`, `add_margin`): signer, config, market, marketRisk, poolLive, userAccount, positions, feed, feeEscrow, taskContext (= positions), magicProgram, liqCrankSigner. `close_exited_user` апка не викликає (janitor relayer-а).
- Relayer API: `GET /markets` → `[{ symbol, market, feed, params: { maxLevBps, imrBps, mmrBps, openFeeBps, closeFeeBps, liqFeeBps, oiCap, maxPosition, minSize, maxStalenessSecs, pausedOpen } }]` (u64 — десяткові рядки); `GET /mark?market=SYM`, `GET /prices?tf=&limit=&market=SYM`; `/ws?markets=SOL,BTC` або `*` (без параметра — лише кадри `mark` для SOL; кадр `mark` несе `market`); `/disclosures`, `/stats`, WS-кадр `disclosure` — більше не існують (404).
- Приватність і безпека без змін: приватні акаунти читаються лише через owner-/session-TEE (`useLiveAccount`); підписи — MWA для власника, сесійний ключ для торгівлі; жоден ключ не логується.
- UI — лише токени з `app/src/theme/tokens.ts` (`docs/design/tokens.json`), жодного hex у компонентах. Розмір файлів — орієнтир ≈200 рядків; екрани render-only, логіка в хуках/чистих модулях.
- Нічого не стверджувати як перевірене на devnet/емуляторі, якщо не запускалось; у звітах і документах — лише факти з прогонів.

## Review Focus

1. **Сміття чи інший лейаут у `Positions`.** Акаунт хибної довжини або з чужим дискримінатором → `decodePositions` кидає, `useLiveAccount` показує `error`, екрани не падають і не показують порожню «немає позицій» як правду — Task 1.
2. **Ринок без слота.** Обраний ринок, на якому в трейдера немає позиції: Trade показує «відкрити», Close-таб недоступний, Positions-список цей ринок не показує; перемикання ринку не змішує слоти — Task 4, Task 5.
3. **17-й ринок і ліквідовне збільшення.** `NoFreeSlot` (6049) і `PositionLiquidatable` (6050) мають людські повідомлення; Trade блокує відкриття при 16 відкритих слотах ще до відправки — Task 1 (мапа), Task 4 (гейт).
4. **History не втрачає записів.** 17-те закриття перезаписує найстаріший запис у кільці, але архів на пристрої зберігає всі побачені; часткове зменшення показується як окремий запис з позначкою; порядок — за `closed_slot` спадно, без дублікатів між кільцем і архівом — Task 6.
5. **Вихід при позиції на іншому ринку.** Чекліст Exit дивиться на всі слоти (`open_count == 0`), а не на SOL; `undelegate_user` передає ринки з історії + відкриті — Task 3.
6. **Мовчазні зайві ключі.** anchor-ts ігнорує невідомі ключі в `.accounts({...})`, тож застарілий будівник не падає на тестах — кожна інструкція, яку апка будує (`init_user`, `delegate_user`, `init_permissions`, `set_session`, `undelegate_user`, п'ять торгових, `faucet_init`, `faucet_mint`, `credit_deposit`, `withdraw`), звіряється з IDL за ТОЧНИМ набором назв ключів — Task 2 (онбординг/акаунт), Task 4 (торгові).

---

### Task 1: канонічний IDL, кодеки нового лейауту, мапа помилок

**Files:**
- Delete: `app/src/idl/dexxer_core.json`
- Create: `app/src/lib/positions.ts`
- Modify: `app/src/lib/anchor.ts`, `app/src/lib/codecs.ts`, `app/src/lib/errors.ts`, `app/src/lib/hashes.ts`, `app/src/lib/status.ts`, `app/tsconfig.json` (якщо `rootDir`/`include` не покривають `../idl`), `app/metro.config.js` (watchFolders для `../idl`), `.github/workflows/ci.yml` (коментар про копію IDL апки — прибрати)
- Test: `app/test/positions.test.ts` (новий), `app/test/codecs.test.ts`, `app/test/errors.test.ts`, `app/test/marketLimits.test.ts`, `app/test/selfchecks.test.ts`

**Interfaces:**
- Produces:

```ts
// app/src/lib/anchor.ts
import idlJson from '../../../idl/dexxer_core.json'   // the canonical IDL; the app copy is gone
export const DEXXER_CORE_IDL: Idl; export const DEXXER_CORE_PROGRAM_ID: PublicKey

// app/src/lib/positions.ts
export const MAX_SLOTS = 16; export const HISTORY_LEN = 16; export const POSITIONS_SIZE = 3184
export const POSITIONS_DISC: Uint8Array                       // Buffer.from([197,153,71,203,133,176,119,182]) — pinned by a test against the IDL
export type SideName = 'Long' | 'Short'
export type HistoryReason = 'User' | 'Liquidated' | 'Decrease'
export interface PositionSlot { index: number; market: PublicKey; size: bigint; entry: bigint; margin: bigint; liqPrice: bigint; openedSlot: bigint; oiNotional: bigint; lastLiqSample: bigint; side: SideName; liqTicks: number }
export interface HistoryRecord { market: PublicKey; size: bigint; entry: bigint; exit: bigint; pnl: bigint; fees: bigint; openedSlot: bigint; closedSlot: bigint; side: SideName; reason: HistoryReason }
export interface DecodedPositions { owner: PublicKey; slots: PositionSlot[]; history: HistoryRecord[]; version: number; bump: number }   // slots = OPEN only, by index; history oldest first
export function decodePositions(data: Buffer): DecodedPositions   // throws on wrong length/discriminator
export function slotFor(p: DecodedPositions | null, market: PublicKey): PositionSlot | null
export function historyKey(r: HistoryRecord): string              // `${market}:${openedSlot}:${closedSlot}:${size}:${reason}` — stable identity of a record across reads

// app/src/lib/codecs.ts — removed: decodePosition/readPosition/DecodedPosition/POSITION_STATES, decodeDisclosureQueue/readDisclosureQueue/DecodedClosedRecord/DecodedDisclosureQueue, decodeDisclosure/readAllDisclosures/DISCLOSURE_DISC/CLOSE_REASONS, DQ_CAPACITY; SIDES/SideName re-exported from './positions'
export interface DecodedUserAccount { sessionKey; sessionExpiry; actionsLeft; freeMargin; lockedMargin; exitSalt; exited; rentPayer: PublicKey }
export interface DecodedMarket { mark; maxLevBps; imrBps; mmrBps; openFeeBps; closeFeeBps; symbol: string }  // symbol trimmed of NULs
// Config offsets: fee_payer = dusdc_mint + 32 (no disclosure_delay_slots)
```

- `app/src/lib/errors.ts`: `ERROR_MESSAGE_OVERRIDES` + `6049: 'All 16 position slots are in use — close a position first'`, `6050: 'Position is at its liquidation price — add margin before increasing it'`, `6046: 'This account has exited — set it up again from the Onboarding screen'`.
- `hashes.ts`: видалити `commitmentHash`, `CommitmentArgs`, `assertCommitmentGolden`, `i64leBytes` (якщо лишається без ужитку); `leafHex`/`assertLeafGolden` без змін. `status.ts`: видалити `DisclosureStatus`, `disclosureStatus`, `DisclosureStatusRecord`, `formatSlotsAsTime`, `assertDisclosureStatusSelfCheck` (їх споживачі зникають у Task 6); `formatUsd2`, `formatSessionLeft`, `DEVNET_SLOT_MS` лишаються.

- [ ] **Step 1: падаючі тести кодеків.** `app/test/positions.test.ts`:

```ts
// test/positions.test.ts — the hand-written `Positions` decoder against bytes
// laid out by the SAME offset table the Rust test
// `offsets_match_the_off_chain_decoders` pins. zero-copy: Anchor's coder
// cannot encode it, so the fixture writes bytes directly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { DEXXER_CORE_IDL } from '../src/lib/anchor'
import {
  HISTORY_LEN,
  MAX_SLOTS,
  POSITIONS_DISC,
  POSITIONS_SIZE,
  decodePositions,
  historyKey,
  slotFor,
} from '../src/lib/positions'

const SLOTS = 8 + 32
const HISTORY = 8 + 1568
const HEAD = 8 + 3104

function blank(owner: PublicKey): Buffer {
  const b = Buffer.alloc(POSITIONS_SIZE)
  Buffer.from(POSITIONS_DISC).copy(b, 0)
  owner.toBuffer().copy(b, 8)
  b.writeUInt8(1, 8 + 3106)
  b.writeUInt8(254, 8 + 3107)
  return b
}
function putSlot(b: Buffer, i: number, market: PublicKey, o: { size: bigint; margin: bigint; side: 0 | 1; state?: number; liqTicks?: number }) {
  const at = SLOTS + i * 96
  market.toBuffer().copy(b, at)
  b.writeBigUInt64LE(o.size, at + 32)
  b.writeBigUInt64LE(150_000_000n, at + 40)
  b.writeBigUInt64LE(o.margin, at + 48)
  b.writeBigUInt64LE(140_000_000n, at + 56)
  b.writeBigUInt64LE(77n, at + 64)
  b.writeBigUInt64LE(1_500_000_000n, at + 72)
  b.writeBigUInt64LE(5n, at + 80)
  b.writeUInt8(o.state ?? 1, at + 88)
  b.writeUInt8(o.side, at + 89)
  b.writeUInt8(o.liqTicks ?? 0, at + 90)
}
function putHistory(b: Buffer, i: number, market: PublicKey, closedSlot: bigint, pnl: bigint, reason: number) {
  const at = HISTORY + i * 96
  market.toBuffer().copy(b, at)
  b.writeBigUInt64LE(10n, at + 32)
  b.writeBigUInt64LE(150_000_000n, at + 40)
  b.writeBigUInt64LE(160_000_000n, at + 48)
  b.writeBigInt64LE(pnl, at + 56)
  b.writeBigUInt64LE(3n, at + 64)
  b.writeBigUInt64LE(closedSlot - 5n, at + 72)
  b.writeBigUInt64LE(closedSlot, at + 80)
  b.writeUInt8(1, at + 88)
  b.writeUInt8(reason, at + 89)
}

test('POSITIONS_DISC is the IDL discriminator of Positions', () => {
  const acc = (DEXXER_CORE_IDL as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts.find(
    (a) => a.name === 'Positions',
  )
  assert.deepEqual(Array.from(POSITIONS_DISC), acc?.discriminator)
})

test('decodePositions returns only OPEN slots with their index; empty slots with residue are ignored', () => {
  const owner = Keypair.generate().publicKey
  const sol = Keypair.generate().publicKey
  const btc = Keypair.generate().publicKey
  const b = blank(owner)
  putSlot(b, 0, sol, { size: 10n, margin: 150n, side: 0 })
  putSlot(b, 3, btc, { size: 7n, margin: 80n, side: 1, liqTicks: 1 })
  putSlot(b, 5, Keypair.generate().publicKey, { size: 1n, margin: 1n, side: 0, state: 0 })
  const p = decodePositions(b)
  assert.equal(p.owner.toBase58(), owner.toBase58())
  assert.deepEqual(p.slots.map((s) => s.index), [0, 3])
  assert.equal(p.slots[1].side, 'Short')
  assert.equal(p.slots[1].liqTicks, 1)
  assert.equal(p.slots[0].entry, 150_000_000n)
  assert.equal(p.slots[0].liqPrice, 140_000_000n)
  assert.equal(slotFor(p, btc)?.index, 3)
  assert.equal(slotFor(p, Keypair.generate().publicKey), null)
  assert.equal(slotFor(null, sol), null)
  assert.equal(p.version, 1)
  assert.equal(p.bump, 254)
})

test('history is oldest-first, signed pnl and all three reasons decode, and the ring wrap is handled', () => {
  const m = Keypair.generate().publicKey
  const b = blank(Keypair.generate().publicKey)
  putHistory(b, 0, m, 100n, -5n, 0)
  putHistory(b, 1, m, 101n, 7n, 1)
  putHistory(b, 2, m, 102n, 0n, 2)
  b.writeUInt8(3, HEAD)
  b.writeUInt8(3, HEAD + 1)
  const p = decodePositions(b)
  assert.deepEqual(p.history.map((h) => h.closedSlot), [100n, 101n, 102n])
  assert.deepEqual(p.history.map((h) => h.reason), ['User', 'Liquidated', 'Decrease'])
  assert.equal(p.history[0].pnl, -5n)
  assert.equal(p.history[0].side, 'Short')
  assert.notEqual(historyKey(p.history[0]), historyKey(p.history[1]))

  const w = blank(Keypair.generate().publicKey)
  for (let i = 0; i < HISTORY_LEN; i++) putHistory(w, i, m, BigInt(200 + i), 0n, 0)
  putHistory(w, 0, m, 300n, 0n, 0)
  w.writeUInt8(1, HEAD)
  w.writeUInt8(HISTORY_LEN, HEAD + 1)
  const q = decodePositions(w)
  assert.equal(q.history.length, HISTORY_LEN)
  assert.equal(q.history[0].closedSlot, 201n)
  assert.equal(q.history[HISTORY_LEN - 1].closedSlot, 300n)
})

test('decodePositions refuses a wrong length and a foreign discriminator; MAX_SLOTS is 16', () => {
  const b = blank(Keypair.generate().publicKey)
  assert.throws(() => decodePositions(b.subarray(0, POSITIONS_SIZE - 1)), /length/)
  const foreign = Buffer.from(b)
  foreign.writeUInt8(foreign[0] ^ 0xff, 0)
  assert.throws(() => decodePositions(foreign), /discriminator/)
  assert.equal(MAX_SLOTS, 16)
})
```

  `app/test/codecs.test.ts`: фікстура `UserAccount` без `nonce`, з `rent_payer: PublicKey.unique()` і `_reserved: Array(32).fill(0)`, `version: 3`; додати асерт `d.rentPayer` і `d.exited`. Додати тест `Config`: закодувати `Config` коде ром IDL (усі поля; `crank_task_id: new BN(-1)`) і перевірити `readConfigDusdcMint`, `readConfigOracleProgram`, `readConfigFeePayer`. `app/test/marketLimits.test.ts`: у фікстуру `Market` додати `last_print: new BN(9)`, `sample_seq: new BN(4)`; асерти ті самі (зміщення після `mark_slot` зсуваються на 16). `app/test/errors.test.ts`: додати `test('the slot-ceiling and liquidatable-increase codes have human messages', …)` — `DEXXER_ERROR_MESSAGES[6049]` і `[6050]` містять `slot`/`liquidation` відповідно. `app/test/selfchecks.test.ts`: прибрати `assertCommitmentGolden`, `assertDisclosureStatusSelfCheck`, `assertHistoryMergeSelfCheck` (їх модулі зникають; `historyRows` — у Task 6).

- [ ] **Step 2: FAIL** — `cd app && npm test` (компіляція `positions.test.ts` падає; `codecs.test.ts` падає на `nonce`/`rent_payer`).

- [ ] **Step 3: реалізація.**
  1. `git rm app/src/idl/dexxer_core.json`; `anchor.ts`: `import idlJson from '../../../idl/dexxer_core.json'`; переконатися, що `tsconfig.json` (`resolveJsonModule`, `include`) і Metro (`metro.config.js`: `config.watchFolders = [path.resolve(__dirname, '../idl')]`, якщо файл поза `projectRoot` інакше не резолвиться) бачать файл; `app/test/errors.test.ts` імпортує IDL через `../src/lib/anchor` (не через `../src/idl/…`). Якщо Metro/Expo не резолвить JSON поза `projectRoot` навіть із `watchFolders` — запасний варіант: `app/scripts/sync-idl.ts` (копіює `../idl/dexxer_core.json` в `app/src/idl/`, викликається з `postinstall` і `test`) плюс крок CI `cmp idl/dexxer_core.json app/src/idl/dexxer_core.json`; обрати один варіант, записати у звіт.
  2. `app/src/lib/positions.ts` — порт `tests/er/lib/positions.ts` на RN-сумісні примітиви (той самий код декодера; `Buffer` з `getAccountInfo` там є; без імпортів з `tests/er`):

```ts
// app/src/lib/positions.ts
//
// Manual decoder of the zero-copy `Positions` account (spec §2.9.1): a trader's
// positions on every market (16 slots, the market is a FIELD of the slot) and
// the private 16-record history ring. Offsets are the ones
// `offsets_match_the_off_chain_decoders` (programs/dexxer_core/src/state/
// positions.rs) and tests/er/lib/positions.ts pin; Anchor's coder cannot read a
// bytemuck account, and on Hermes it is broken anyway (codecs.ts header).
import { PublicKey } from '@solana/web3.js'

export const MAX_SLOTS = 16
export const HISTORY_LEN = 16
const DISC = 8
const RECORD = 96
const SLOTS_AT = DISC + 32
const HISTORY_AT = DISC + 1568
const HEAD_AT = DISC + 3104
export const POSITIONS_SIZE = DISC + 3176
/** `Positions`' Anchor discriminator — pinned against the IDL by test/positions.test.ts. */
export const POSITIONS_DISC = Uint8Array.from([197, 153, 71, 203, 133, 176, 119, 182])

export const SIDES = ['Long', 'Short'] as const
export type SideName = (typeof SIDES)[number]
export const HISTORY_REASONS = ['User', 'Liquidated', 'Decrease'] as const
export type HistoryReason = (typeof HISTORY_REASONS)[number]

export interface PositionSlot {
  index: number
  market: PublicKey
  size: bigint
  entry: bigint
  margin: bigint
  liqPrice: bigint
  openedSlot: bigint
  oiNotional: bigint
  lastLiqSample: bigint
  side: SideName
  liqTicks: number
}
export interface HistoryRecord {
  market: PublicKey
  size: bigint
  entry: bigint
  exit: bigint
  pnl: bigint
  fees: bigint
  openedSlot: bigint
  closedSlot: bigint
  side: SideName
  reason: HistoryReason
}
export interface DecodedPositions {
  owner: PublicKey
  /** Open slots only, in slot-index order. */
  slots: PositionSlot[]
  /** Oldest record first. */
  history: HistoryRecord[]
  version: number
  bump: number
}

const side = (b: number): SideName => (b === 1 ? 'Short' : 'Long')
const key = (data: Buffer, at: number) => new PublicKey(data.subarray(at, at + 32))

export function decodePositions(data: Buffer): DecodedPositions {
  if (data.length !== POSITIONS_SIZE) throw new Error(`Positions: length ${data.length}, expected ${POSITIONS_SIZE}`)
  for (let i = 0; i < DISC; i++) if (data[i] !== POSITIONS_DISC[i]) throw new Error('Positions: discriminator mismatch')

  const slots: PositionSlot[] = []
  for (let i = 0; i < MAX_SLOTS; i++) {
    const at = SLOTS_AT + i * RECORD
    if (data.readUInt8(at + 88) !== 1) continue
    slots.push({
      index: i,
      market: key(data, at),
      size: data.readBigUInt64LE(at + 32),
      entry: data.readBigUInt64LE(at + 40),
      margin: data.readBigUInt64LE(at + 48),
      liqPrice: data.readBigUInt64LE(at + 56),
      openedSlot: data.readBigUInt64LE(at + 64),
      oiNotional: data.readBigUInt64LE(at + 72),
      lastLiqSample: data.readBigUInt64LE(at + 80),
      side: side(data.readUInt8(at + 89)),
      liqTicks: data.readUInt8(at + 90),
    })
  }

  const head = data.readUInt8(HEAD_AT) % HISTORY_LEN
  const len = Math.min(data.readUInt8(HEAD_AT + 1), HISTORY_LEN)
  const history: HistoryRecord[] = []
  for (let k = 0; k < len; k++) {
    const at = HISTORY_AT + ((head - len + k + HISTORY_LEN) % HISTORY_LEN) * RECORD
    history.push({
      market: key(data, at),
      size: data.readBigUInt64LE(at + 32),
      entry: data.readBigUInt64LE(at + 40),
      exit: data.readBigUInt64LE(at + 48),
      pnl: data.readBigInt64LE(at + 56),
      fees: data.readBigUInt64LE(at + 64),
      openedSlot: data.readBigUInt64LE(at + 72),
      closedSlot: data.readBigUInt64LE(at + 80),
      side: side(data.readUInt8(at + 88)),
      reason: HISTORY_REASONS[data.readUInt8(at + 89)] ?? 'User',
    })
  }
  return { owner: key(data, DISC), slots, history, version: data.readUInt8(DISC + 3106), bump: data.readUInt8(DISC + 3107) }
}

export function slotFor(p: DecodedPositions | null, market: PublicKey): PositionSlot | null {
  return p?.slots.find((s) => s.market.equals(market)) ?? null
}

/** Identity of one closed trade across reads and devices — the ring has no ids; these fields never repeat for one owner. */
export function historyKey(r: HistoryRecord): string {
  return `${r.market.toBase58()}:${r.openedSlot}:${r.closedSlot}:${r.size}:${r.reason}`
}
```

  3. `codecs.ts`: видалити блоки `Position`, `ClosedRecord`, `DisclosureQueue`, `Disclosure` (+ `DISCLOSURE_DISC`, `readAllDisclosures`) і пов'язані імпорти (`BorshAccountsCoder`, `DEXXER_CORE_PROGRAM_ID`, якщо більше не потрібні); `SIDES`/`SideName` — `export { SIDES, type SideName } from './positions'`. `UserAccount`: прибрати `nonce` зі зміщень (`EXIT_SALT = FREE_MARGIN + 8 + 8 + 8`), додати `USER_ACCOUNT_RENT_PAYER_OFFSET = EXITED + 1`, `readUserAccountRentPayer`, поле `rentPayer` у `DecodedUserAccount`; `readUserAccountExited` — без перевірки довжини (лейаут фіксований). `Config`: `CONFIG_FEE_PAYER_OFFSET = CONFIG_DUSDC_MINT_OFFSET + 32 + 32` = 202 (було 210 з `disclosure_delay_slots`; стара адреса читала б `magic_fee_vault` замість `fee_payer` без жодної помилки — тому тест `Config` у `codecs.test.ts` обов'язковий); `UserAccount`: `exit_salt` 117 → 109, `exited` 150 → 142, `rent_payer` 143; оновити коментарі. `Market`: `decodeMarket` додатково повертає `symbol` (8 байт після `version`, обрізати `\0`); у `marketLimits.ts` зміщення після `mark_slot` зсунути на 16 (`EMA_ALPHA_BPS_OFFSET = MAX_DEVIATION_BPS_OFFSET + 2 + 8 + 8 + 8 + 8`) і оновити коментар-карту. Шапку файла оновити (джерела: `state/positions.rs`, `state/user.rs`, `state/market.rs`, `state/config.rs`, перевірено 01.10.2026).
  4. `errors.ts` — три нові override-и (Interfaces). `hashes.ts`, `status.ts` — видалення за Interfaces (їхні споживачі: `useHistoryRows.ts`, `historyRows.ts`, `AccountScreen.tsx`, `HistoryScreen.tsx`, `features.ts` — компіляція відновиться в Task 6; у цій задачі допустимо, щоб `tsc` ще падав у `features/history/*` і `features/account/*` — записати у звіт перелік).
  5. `.github/workflows/ci.yml`: коментар біля кроку `cmp` про «копію апки не порівнюємо» — прибрати (копії більше нема).

- [ ] **Step 4: PASS** — `cd app && npm test` зелений для `positions`, `codecs`, `errors`, `marketLimits`, `selfchecks`; `npx tsc --noEmit` — записати список файлів, що ще червоні (очікувано: history/account/onboard/trade/positions — наступні задачі). Усі тести, що імпортують лише ці модулі, зелені.

- [ ] **Step 5: commit**

```bash
git add idl/dexxer_core.json app/src/lib/anchor.ts app/src/lib/positions.ts app/src/lib/codecs.ts app/src/lib/errors.ts app/src/lib/hashes.ts app/src/lib/status.ts app/test/positions.test.ts app/test/codecs.test.ts app/test/errors.test.ts app/test/marketLimits.test.ts app/test/selfchecks.test.ts .github/workflows/ci.yml
git rm -q app/src/idl/dexxer_core.json
git add app/metro.config.js app/tsconfig.json   # only if changed
git commit -m "feat(app): canonical IDL, Positions decoder, new UserAccount/Market/Config layouts"
```

(`idl/dexxer_core.json` у `git add` — лише щоб не загубити, якщо CI-коментар посилається; файл не змінюється.)

---

### Task 2: PDA, онбординг на два акаунти

**Files:**
- Modify: `app/src/lib/pdas.ts`, `app/src/features/onboard/{onboardTypes,onboardLegs,onboardState,useOnboarding,batchOnboarding}.ts`
- Test: `app/test/onboarding.test.ts`, `app/test/onboardState.test.ts`

**Interfaces:**
- Consumes: Task 1 (`readUserAccountExited`, новий `UserAccount`).
- Produces: `pdas.positions(owner)` (сіди `[b"positions", owner]`), `pdas.marketFor(symbol: string)` (сіди `[b"market", symbolBytes(symbol)]`), `symbolBytes(symbol): Buffer` (1–8 байт `A-Z0-9`, доповнення нулями, інакше кидає), `symbolString(bytes)`; **видалені**: `pdas.position`, `pdas.disclosureQueue`, `pdas.commitment`, `pdas.disclosure`, `hashSeed`. `OnboardCtx`: `positions: PublicKey` замість `position`/`disclosureQueue`; `market` лишається (SOL) лише для `L1Keys`-сумісності — НЕ входить до акаунтів `init_user`/`delegate_user`/`init_permissions`. `needsReuseQueue` → видалено; новий `isExitedOnL1(snap): boolean` (той самий предикат) і новий стан у `l1ProgressFrom`: `'Exited'` коли `UserAccount` під програмою з `exited` (онбординг показує «Акаунт закривається після виходу — зачекайте, поки relayer закриє його (до 5 хв), і спробуйте знову»; `init_user` не відправляється). `OnboardState` отримує варіант `'Exited'`.

- [ ] **Step 1: падаючі тести.** `onboarding.test.ts`: `makeCtx()` — `positions: pdas.positions(owner)` замість `position`/`disclosureQueue`; `userAccountData` — без `nonce`, з `rent_payer`, `_reserved`, `version: 3`; тест «returning owner after exit: init_user_reuse_queue…» замінити на:

```ts
test('returning owner after exit: no L1 leg is built until the janitor closed the accounts', async () => {
  const ctx = makeCtx()
  const ua = await userAccountData({ owner: ctx.owner, exited: true })
  installBase(
    new Map([
      [ctx.config.toBase58(), info(DEXXER_CORE_PROGRAM_ID, await configData())],
      [ctx.userAccount.toBase58(), info(DEXXER_CORE_PROGRAM_ID, ua)],
      [pdas.faucet(ctx.owner).toBase58(), info(DEXXER_CORE_PROGRAM_ID)],
    ]),
  )
  const snap = await readL1Snapshot(baseConn, l1KeysFor(ctx.owner, MINT))
  assert.equal(l1ProgressFrom(snap), 'Exited')
  const legs = await collectBatchLegs(ctx, mwaStub, FEE_PAYER, () => {}, [null, null, null], snap)
  assert.deepEqual(legs.map((l) => l.label), [])
})
```

  (імена хелперів `configData`/`mwaStub` — як у файлі; якщо їх нема, взяти наявні еквіваленти). Новий `app/test/ixAccounts.test.ts` — єдине місце, яке ловить зайві/відсутні ключі (Review Focus 6):

```ts
// test/ixAccounts.test.ts — every instruction the app builds names EXACTLY the
// accounts the IDL declares. anchor-ts silently ignores unknown keys and
// resolves nothing for an untyped Program, so a stale account object only
// fails on a live network otherwise. Extended by Task 4 (trade instructions).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { DEXXER_CORE_IDL } from '../src/lib/anchor'

const idl = DEXXER_CORE_IDL as unknown as { instructions: { name: string; accounts: { name: string }[] }[] }
const coder = new BorshInstructionCoder(DEXXER_CORE_IDL)
export function idlAccountCount(ix: string): number {
  const def = idl.instructions.find((i) => i.name === ix)
  assert.ok(def, `IDL has ${ix}`)
  return def!.accounts.length
}
/** For each instruction of `tx`: its IDL name and the number of keys it carries — a stale builder shows up as a count mismatch. */
export function ixSummary(tx: Transaction): { name: string; keys: number }[] {
  return tx.instructions
    .filter((ix) => ix.programId.equals(new PublicKey((DEXXER_CORE_IDL as unknown as { address: string }).address)))
    .map((ix) => ({ name: coder.decode(ix.data)?.name ?? '?', keys: ix.keys.length }))
}
export function assertIxKeysMatchIdl(tx: Transaction): void {
  for (const s of ixSummary(tx)) assert.equal(s.keys, idlAccountCount(s.name), `${s.name}: keys vs IDL accounts`)
}
```

  і в `onboarding.test.ts` для КОЖНОГО лега кожного сценарію з транзакцією: `assertIxKeysMatchIdl(tx)` (anchor-ts кладе в `keys` рівно ті акаунти, які зміг зіставити з IDL; зайвий ключ у `.accounts({})` він викидає, а відсутній — кидає `Reached maximum depth for account resolution`; тому число ключів = число акаунтів IDL і є перевіркою «ні зайвого, ні відсутнього»). У тесті «fresh owner: four legs…» додати асерти на акаунти: інструкція `init_user` першого лега має ключі `[owner, payer, config, userAccount, positions, systemProgram]` у цьому порядку (`tx.instructions[k].keys.map(k => k.pubkey.toBase58())` проти очікуваних PDA), `delegate_user` — 14 ключів, другий — `payer`, 11-й — `positions`; ER-лег — `init_permissions` має 9 ключів. `onboardState.test.ts`: `needsReuseQueue` → `isExitedOnL1`; додати `l1ProgressFrom: exited UserAccount under the program -> 'Exited'`; у фікстурі `userAccount(owner, exited)` — новий лейаут.

- [ ] **Step 2: FAIL** — `npm test` (`pdas.positions` нема; фікстура з `rent_payer` не кодується старим кодом).

- [ ] **Step 3: реалізація.**
  `pdas.ts`: `const POSITIONS_SEED = Buffer.from('positions')`; видалити `POSITION_SEED`, `DQ_SEED`, `COMMIT_SEED`, `DISCLOSURE_SEED`, `hashSeed`, `pdas.position/disclosureQueue/commitment/disclosure`; додати

```ts
/** `symbol: [u8; 8]` of `init_market` — 1–8 bytes `A-Z0-9`, NUL-padded (program's `validate_symbol`). */
export function symbolBytes(symbol: string): Buffer {
  if (!/^[A-Z0-9]{1,8}$/.test(symbol)) throw new Error(`bad market symbol: ${symbol}`)
  const b = Buffer.alloc(8)
  b.write(symbol, 'ascii')
  return b
}
export function symbolString(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('ascii').replace(/\0+$/, '')
}
// in `pdas`:
  positions: (owner: PublicKey) => pda([POSITIONS_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  marketFor: (symbol: string) => pda([MARKET_SEED, symbolBytes(symbol)], DEXXER_CORE_PROGRAM_ID),
```

  (`pdas.market()` = `marketFor('SOL')` лишається.) `onboardTypes.ts`: `OnboardCtx.positions`, без `position`/`disclosureQueue`; `OnboardState` + `'Exited'`. `onboardState.ts`: `isExitedOnL1`, `l1ProgressFrom` повертає `'Exited'` перед `'Initialized'`. `useOnboarding.buildCtx`: `positions: pdas.positions(o)`. `onboardLegs.ts`: `legFaucetInitUser` — `initAccounts = { owner, payer: feePayer, config, userAccount, positions, systemProgram }`; гілка `init_user_reuse_queue` → якщо `isExitedOnL1(snap)`: `appendLog('init_user: account exited, waiting for the janitor to close it')` і лег не будується; `legDelegateUser` — `ut = delegationTriple(userAccount)`, `pt = delegationTriple(positions)`, акаунти за Interfaces (без `market`, без `*DisclosureQueue`); `legPermissionsSession` — `permAccounts = { owner, config, userAccount, positions, userPermission, positionsPermission: permissionPdaFromAccount(positions), permissionProgram, ephemeralVault, magicProgram }`. `batchOnboarding.ts`: `waitDelegated` для `userAccount` і `positions`. Шапки файлів: замінити абзаци про `init_user_reuse_queue`/`DisclosureQueue` на два речення про два акаунти й стан `Exited`. `OnboardScreen`/`StepsList`: якщо `state === 'Exited'` — показати текст із Interfaces замість кроків (одна гілка; екран render-only).

- [ ] **Step 4: PASS** — `npm test`: `onboarding`, `onboardState` зелені; `npx tsc --noEmit` — у `features/onboard` чисто.
- [ ] **Step 5: commit**

```bash
git add app/src/lib/pdas.ts app/src/features/onboard app/test/onboarding.test.ts app/test/onboardState.test.ts
git commit -m "feat(app): onboarding on UserAccount + Positions; market PDAs by symbol"
```

---

### Task 3: акаунт і вихід

**Files:**
- Modify: `app/src/features/account/{accountTx,AccountScreen.tsx,ExitSheet.tsx}`, `app/src/features/receipt/ReceiptSection.tsx` (лише якщо компіляція вимагає)
- Test: `app/test/accountTx.test.ts` (новий)

**Interfaces:**
- Consumes: Task 1 (`decodePositions`, `useLiveAccount`), Task 2 (`pdas.positions`).
- Produces: `exitTx(p: AccountPdas, mwa, positions: PublicKey, markets: PublicKey[]): Promise<string>` — `undelegate_user` з акаунтами за Global Constraints і `remainingAccounts(markets.map(m => ({ pubkey: m, isWritable: false, isSigner: false })))`, `markets` — ≤16 унікальних; чистий `export function exitMarkets(p: DecodedPositions | null, sol: PublicKey): PublicKey[]` = унікальні `market` з `history` ∪ `slots` ∪ `{sol}`, обрізано до 16. `ExitChecklist { noOpenPosition; balanceWithdrawn }` без `pendingDisclosures`.

- [ ] **Step 1: падаючий тест** `app/test/accountTx.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { exitMarkets } from '../src/features/account/accountTx'
import type { DecodedPositions, HistoryRecord, PositionSlot } from '../src/lib/positions'

const k = () => Keypair.generate().publicKey
const rec = (market: PublicKey): HistoryRecord =>
  ({ market, size: 1n, entry: 1n, exit: 1n, pnl: 0n, fees: 0n, openedSlot: 1n, closedSlot: 2n, side: 'Long', reason: 'User' })
const slot = (market: PublicKey): PositionSlot =>
  ({ index: 0, market, size: 1n, entry: 1n, margin: 1n, liqPrice: 1n, openedSlot: 1n, oiNotional: 1n, lastLiqSample: 0n, side: 'Long', liqTicks: 0 })

test('exitMarkets: SOL always, history and open-slot markets once each, at most 16', () => {
  const sol = k()
  const btc = k()
  const eth = k()
  const p: DecodedPositions = { owner: k(), slots: [slot(eth)], history: [rec(btc), rec(btc), rec(sol)], version: 1, bump: 1 }
  const out = exitMarkets(p, sol).map((m) => m.toBase58())
  assert.deepEqual(new Set(out), new Set([sol, btc, eth].map((m) => m.toBase58())))
  assert.equal(out.length, 3)
  assert.deepEqual(exitMarkets(null, sol).map((m) => m.toBase58()), [sol.toBase58()])
  const many: DecodedPositions = { owner: k(), slots: [], history: Array.from({ length: 16 }, () => rec(k())), version: 1, bump: 1 }
  assert.equal(exitMarkets(many, sol).length, 16)
  assert.equal(exitMarkets(many, sol)[0].toBase58(), sol.toBase58(), 'SOL is never the one dropped')
})
```

- [ ] **Step 2: FAIL** — `exitMarkets` не існує.
- [ ] **Step 3: реалізація.** `accountTx.ts`: `exitMarkets` (SOL першим, далі `slots`, далі `history` від найновішого, дедуплікація за base58, `slice(0, 16)`); `exitTx` за Interfaces (акаунти: `owner, config, userAccount, positions, userPermission: permissionPdaFromAccount(userAccount), positionsPermission: permissionPdaFromAccount(positions), ephemeralVault, permissionProgram, feeEscrow, magicFeeVault, magicContext, magicProgram`). Коментар до `exitTx`: гейти програми — `open_count == 0` і нульова маржа; `remaining_accounts` — ринки, чиї задачі ліквідації скасувати. `AccountScreen.tsx`: `positionsLive = useLiveAccount(conn, accounts?.positions ?? null, decodePositions)`; `checklist.noOpenPosition = positionsLive.value === null || positionsLive.value.slots.length === 0`; `handleExit` → `exitTx(await buildAccountPdas(owner), mwa, accounts.positions, exitMarkets(positionsLive.value, pdas.market()))`; видалити `dq`/`pendingDisclosures`; у помилках — `positionsLive.error`. `ExitSheet.tsx`: прибрати `pendingDisclosures` і його рядок; текст «Your accounts return to L1 with private fields erased» лишається. (`TradeAccounts.positions` з'являється в Task 4 — у цій задачі `accounts.positions` може ще не існувати: тоді брати `pdas.positions(owner)` напряму й замінити в Task 4; записати у звіт.)
- [ ] **Step 4: PASS** — `npm test` (`accountTx`), `tsc` у `features/account` чисто.
- [ ] **Step 5: commit**

```bash
git add app/src/features/account app/test/accountTx.test.ts
git commit -m "feat(app): exit on two accounts; cancel liquidation tasks for history and open markets"
```

---

### Task 4: ринки й торгівля на обраному ринку

**Files:**
- Create: `app/src/lib/markets.ts`, `app/src/features/trade/MarketPicker.tsx`
- Modify: `app/src/lib/indexer.ts`, `app/src/lib/indexerCodec.ts`, `app/src/lib/trade.ts`, `app/src/features/trade/{useTradeSession,TradeScreen.tsx,TradeHeader.tsx,MarketInfoCard.tsx,TradeTicket.tsx,TradeActivity.tsx,PositionScreen.tsx,ChartSection.tsx}`, `app/src/features/chart/TradingChart.tsx`, `app/src/features/positions/{IncreaseSheet,DecreaseSheet,AddMarginSheet,PositionCard}.tsx` (тип позиції → `PositionSlot`), `app/app/(tabs)/position.tsx` (видалити маршрут, якщо `PositionScreen` зникає — див. нижче)
- Test: `app/test/markets.test.ts` (новий), `app/test/indexerCodec.test.ts`, `app/test/indexerWs.test.ts`, `app/test/trade.test.ts`, `app/test/tradingRules.test.ts`

**Interfaces:**
- Consumes: Task 1 (`decodePositions`, `slotFor`, `PositionSlot`, `decodeMarket.symbol`), Task 2 (`pdas.marketFor`, `pdas.positions`).
- Produces:

```ts
// app/src/lib/markets.ts
export interface MarketInfo { symbol: string; market: PublicKey; feed: PublicKey; params: { maxLevBps: number; imrBps: number; mmrBps: number; openFeeBps: number; closeFeeBps: number; liqFeeBps: number; oiCap: bigint; maxPosition: bigint; minSize: bigint; maxStalenessSecs: bigint; pausedOpen: boolean } }
export function parseMarkets(v: unknown): MarketInfo[]            // GET /markets; throws IndexerShapeError on shape mismatch
export function useMarkets(): UseQueryResult<MarketInfo[]>       // staleTime 60 s; SOL first
export const SOL_FALLBACK: Pick<MarketInfo, 'symbol' | 'market'>  // { symbol: 'SOL', market: pdas.market() } — used until /markets answers
export function useSelectedMarket(): { symbol: string; setSymbol: (s: string) => void }   // zustand or React context; default 'SOL'; persisted in AsyncStorage under 'dexxer.market'
// app/src/lib/indexer.ts
export function useMark(symbol: string): UseQueryResult<Mark>    // GET /mark?market=SYM; WS frames carry `market`, only the matching one patches this cache
export function useCandles(symbol: string, tf, limit): …          // GET /prices?tf=&limit=&market=SYM
// IndexerWs: url `${RELAYER_URL}/ws?markets=*`; `mark` frame handler reads `frame.market` (string) and patches QK.mark(symbol)
export const QK = { mark: (symbol: string) => […], candles: (symbol: string, tf: string) => […], poolHistory, rootLatest }   // `disclosures` removed; `useDisclosures` removed
// app/src/lib/indexerCodec.ts
export interface Mark { price: bigint | null; slot: number | null; ts: number | null; stale: boolean; market: string }   // `market` = symbol
export type WsFrame = { type: 'mark'; market: string; price; ts; stale } | ({ type: 'pool' } & PoolSnapshot)             // `disclosure` removed; parseDisclosure/Disclosure removed
// app/src/lib/trade.ts
export interface TradeAccounts { config; market; marketRisk; poolLive; userAccount; positions; feed; feeEscrow; taskContext; magicProgram; liqCrankSigner }   // 11 + signer = 12
export function tradeAccountsFor(base: Omit<TradeAccounts, 'market' | 'marketRisk' | 'feed' | 'taskContext'>, m: Pick<MarketInfo, 'market' | 'feed'>): TradeAccounts
// app/src/features/trade/useTradeSession.ts
export interface TradeSession { owner; session; conn; base: BaseTradeAccounts | null; loading; error }   // base = config, poolLive, userAccount, positions, feeEscrow, magicProgram, liqCrankSigner (market-independent, derived once)
```

- [ ] **Step 1: падаючі тести.** `app/test/markets.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { parseMarkets } from '../src/lib/markets'
import { IndexerShapeError } from '../src/lib/indexerCodec'

const row = (symbol: string) => ({
  symbol,
  market: PublicKey.unique().toBase58(),
  feed: PublicKey.unique().toBase58(),
  params: {
    maxLevBps: 100_000, imrBps: 1_000, mmrBps: 500, openFeeBps: 6, closeFeeBps: 6, liqFeeBps: 100,
    oiCap: '0', maxPosition: '100000000000', minSize: '10000000', maxStalenessSecs: '15', pausedOpen: false,
  },
})

test('parseMarkets: u64 strings become bigint, pubkeys parse, SOL is sorted first', () => {
  const out = parseMarkets([row('BTC'), row('SOL')])
  assert.deepEqual(out.map((m) => m.symbol), ['SOL', 'BTC'])
  assert.equal(out[1].params.minSize, 10_000_000n)
  assert.equal(out[1].params.oiCap, 0n)
  assert.ok(out[0].market instanceof PublicKey)
})

test('parseMarkets rejects a missing params field by name and a non-array body', () => {
  const bad = row('ETH') as { params: Record<string, unknown> }
  delete bad.params.minSize
  assert.throws(() => parseMarkets([bad]), (e: unknown) => e instanceof IndexerShapeError && /minSize/.test(e.message))
  assert.throws(() => parseMarkets({}), IndexerShapeError)
})
```

  `indexerCodec.test.ts`: `parseMark` вимагає `market` (рядок) — тест «parseMark: decimal-string price…» додає `market: 'SOL'` і асерт; видалити тест `parseDisclosure`; `parseWsFrame`: кадр `mark` з `market: 'BTC'` → `{ type: 'mark', market: 'BTC', … }`, кадр `disclosure` → `null` (невідомий тип ігнорується). `indexerWs.test.ts`: тест патчу кешу `mark` — кадр для `BTC` патчить лише `QK.mark('BTC')`, кеш `QK.mark('SOL')` не чіпається; URL сокета закінчується на `/ws?markets=*`. `trade.test.ts`: `accounts` без `position`/`disclosureQueue`, з `positions`; для кожної з п'яти інструкцій — `assertIxKeysMatchIdl(tx)` з `test/ixAccounts.test.ts` (12 ключів), `positions` стоїть 7-м (індекс 6), `taskContext` (індекс 9) дорівнює `positions`. У `test/accountTx.test.ts` (Task 3) додати побудову `exitTx`-інструкції через фейковий `getConnection` і `assertIxKeysMatchIdl` (12 ключів + N remaining — порівнювати `keys.length - markets.length`). `tradingRules.test.ts`: фікстура `TicketMarket` отримує `symbol: 'SOL'` і `liqHysteresisTicks: 2`; очікувані рядки — за фактичним виходом `tradingRules` (значення не змінюються, крім гістерезису, якщо вона відображається).

- [ ] **Step 2: FAIL** — модуля `markets.ts` нема; `parseMark` не має `market`; `TradeAccounts.position` не існує.

- [ ] **Step 3: реалізація — бібліотека.** `indexerCodec.ts`: `Mark.market` (`str(o,'market','mark')`; якщо relayer-кадр старого формату без `market` — трактувати як `'SOL'`? НІ: relayer плану 2 завжди шле `market`; відсутність — помилка форми); видалити `Disclosure`, `parseDisclosure`, кадр `disclosure`. `indexer.ts`: `QK.mark(symbol)`, `QK.candles(symbol, tf)`; `useMark(symbol)`, `useCandles(symbol, tf, limit)` з `?market=`; видалити `useDisclosures`, `Disclosure`; `WS_URL = …/ws?markets=*`; у `IndexerWs` обробник `mark` патчить `QK.mark(frame.market)`. `markets.ts` — `parseMarkets` (через хелпери `indexerCodec` `obj/num/big/bool/str`; `sortMarkets`: SOL першим, решта за символом), `useMarkets` (`getJson('/markets', parseMarkets)`, `staleTime: 60_000`), `useSelectedMarket` (zustand `create` — у `package.json` zustand є? якщо ні — React context у `app/src/shell`; збереження в AsyncStorage `dexxer.market`, невідомий символ після завантаження `/markets` → `'SOL'`). `trade.ts`: `TradeAccounts` за Interfaces, `tradeAccountsFor(base, m)` = `{ ...base, market: m.market, marketRisk: pdas.marketRisk(m.market), feed: m.feed, taskContext: base.positions }`; функції `openPosition/closePosition/increasePosition/decreasePosition/addMargin` без змін сигнатур (приймають `TradeAccounts`). `useTradeSession`: повертає `base` (без ринку): `{ config, poolLive, userAccount: pdas.userAccount(owner), positions: pdas.positions(owner), feeEscrow, magicProgram, liqCrankSigner }` — `oracleProgram`/`feed` більше не читається з `Config` (feed береться з `MarketInfo.feed`).

- [ ] **Step 4: реалізація — екрани.**
  - `MarketPicker.tsx` (новий, ≤80 рядків): `Segment` з символами з `useMarkets()` (fallback `['SOL']`), `value = useSelectedMarket().symbol`; показує `pausedOpen` бейджем.
  - `TradeScreen.tsx`: `const { symbol } = useSelectedMarket(); const markets = useMarkets(); const m = markets.data?.find(x => x.symbol === symbol) ?? (symbol === 'SOL' ? SOL_FALLBACK_WITH_FEED : null)` — для SOL без `/markets` feed береться з `decodeMarket`? НІ — простіше: `feed` читається з живого `Market` акаунта (`marketLive.value.feed` — додати `feed` у `decodeMarket`: зміщення `MARKET_FEED_OFFSET`, вже є). Тож `accounts = base && marketPda ? tradeAccountsFor(base, { market: marketPda, feed: marketLive.value.feed }) : null`, де `marketPda = pdas.marketFor(symbol)`. `positionsLive = useLiveAccount(conn, base?.positions ?? null, decodePositions)`; `slot = slotFor(positionsLive.value, marketPda)`; `openSlots = positionsLive.value?.slots.length ?? 0`; `useMark(symbol)`, `useCandles(symbol, '15m', 96)`; `TradeHeader` отримує `symbol`; `MarketInfoCard` — `symbol`; `TradeTicket` — `position: slot`, `disabledOpen = openSlots >= MAX_SLOTS && !slot` з текстом «All 16 position slots are in use» (Review Focus 3); `TradeActivity` — `slot`. Помилка декодування `positionsLive.error` показується як і `marketLive.error` (Review Focus 1).
  - `TradeHeader.tsx`/`MarketInfoCard.tsx`: `SOL-PERP` → `` `${symbol}-PERP` ``, «SOL price» → `` `${symbol} price` ``; `MarketPicker` рендериться над заголовком.
  - `TradeTicket.tsx`/`CloseTab.tsx`/`TradeActivity.tsx`/`ChartSection.tsx`/`TradingChart.tsx`: тип `DecodedPosition` → `PositionSlot | null` (поля ті самі: `side`, `size`, `entry`, `margin`, `liqPrice`); `hasOpenPosition = position !== null`; суфікс `SOL` у розмірі → `symbol` (пропс `symbol`); `TradingChart` → `useCandles(symbol, tf)`.
  - `PositionScreen.tsx` + маршрут `app/app/(tabs)/position.tsx`: видалити (дублює Positions; `href: null` маршрут більше не потрібен) — перевірити `router.push('/position')` по коду й замінити на `/positions`.
  - `IncreaseSheet`/`DecreaseSheet`/`AddMarginSheet`/`PositionCard`: `position: PositionSlot`, плюс `symbol: string` для підписів; `PositionCard` без перевірки `state`.

- [ ] **Step 5: PASS** — `npm test`; `tsc` чисто в `lib` і `features/trade`; `features/positions` може лишатись червоним до Task 5 — записати.
- [ ] **Step 6: commit**

```bash
git add app/src/lib/markets.ts app/src/lib/indexer.ts app/src/lib/indexerCodec.ts app/src/lib/trade.ts app/src/lib/codecs.ts app/src/features/trade app/src/features/chart/TradingChart.tsx app/src/features/positions app/test/markets.test.ts app/test/indexerCodec.test.ts app/test/indexerWs.test.ts app/test/trade.test.ts app/test/tradingRules.test.ts
git rm -q app/app/\(tabs\)/position.tsx app/src/features/trade/PositionScreen.tsx
git commit -m "feat(app): markets from the relayer, market picker, trading on the selected market's slot"
```

---

### Task 5: список позицій зі слотів

**Files:**
- Modify: `app/src/features/positions/{PositionsScreen.tsx,PositionCard.tsx}`
- Create: `app/src/features/positions/usePositionActions.ts`
- Test: `app/test/positionsList.test.ts` (новий)

**Interfaces:**
- Consumes: Task 4 (`TradeSession.base`, `tradeAccountsFor`, `useMarkets`, `MarketInfo`, `PositionSlot`).
- Produces: чистий `export function positionRows(p: DecodedPositions | null, markets: MarketInfo[]): { slot: PositionSlot; symbol: string; market: MarketInfo | null }[]` — усі відкриті слоти в порядку індексу, символ з реєстру або `market.toBase58().slice(0, 4) + '…'` коли ринок невідомий реєстру (позиція все одно показується і керується — Review Focus 2). `usePositionActions(base, conn, session, market: MarketInfo | null)` → `{ close, increase, decrease, addMargin, busy }` (логіка з теперішнього `PositionsScreen`).

- [ ] **Step 1: падаючий тест** `app/test/positionsList.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { positionRows } from '../src/features/positions/positionRows'
import type { DecodedPositions, PositionSlot } from '../src/lib/positions'
import type { MarketInfo } from '../src/lib/markets'

const k = () => Keypair.generate().publicKey
const slot = (index: number, market = k()): PositionSlot =>
  ({ index, market, size: 1n, entry: 1n, margin: 1n, liqPrice: 1n, openedSlot: 1n, oiNotional: 1n, lastLiqSample: 0n, side: 'Long', liqTicks: 0 })
const mi = (symbol: string, market = k()): MarketInfo =>
  ({ symbol, market, feed: k(), params: { maxLevBps: 1, imrBps: 1, mmrBps: 1, openFeeBps: 1, closeFeeBps: 1, liqFeeBps: 1, oiCap: 0n, maxPosition: 1n, minSize: 1n, maxStalenessSecs: 1n, pausedOpen: false } })

test('positionRows: every open slot in index order, symbol from the registry, unknown market still listed', () => {
  const btc = mi('BTC')
  const stray = k()
  const p: DecodedPositions = { owner: k(), slots: [slot(2, stray), slot(5, btc.market)], history: [], version: 1, bump: 1 }
  const rows = positionRows(p, [mi('SOL'), btc])
  assert.deepEqual(rows.map((r) => r.slot.index), [2, 5])
  assert.equal(rows[1].symbol, 'BTC')
  assert.equal(rows[1].market?.symbol, 'BTC')
  assert.equal(rows[0].market, null)
  assert.match(rows[0].symbol, /…$/)
  assert.deepEqual(positionRows(null, [btc]), [])
})
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: реалізація.** `positionRows.ts` (чистий). `usePositionActions.ts`: приймає `market: MarketInfo | null` і будує `accounts = tradeAccountsFor(base, market)` лише коли ринок відомий; `close` → `closePosition(conn, session, accounts)`; `increase/decrease/addMargin` — як зараз, з `slot.side`; `mark` — з `useLiveAccount(conn, market.market, decodeMarket)` для ВИБРАНОЇ картки (один підписник на розгорнуту картку, не на всі ринки одразу). `PositionsScreen.tsx`: `positionsLive` одна підписка; `rows = positionRows(positionsLive.value, markets.data ?? [])`; список `PositionCard` (пропси `slot`, `symbol`, `mark`, дії); порожньо → «No open positions»; невідомий ринок → картка без mark/uPnL із підписом «Market not in the registry yet»; шити (`Increase/Decrease/AddMargin`) відкриваються для обраної картки (`selected: { slot, market } | null`). `PositionCard`: заголовок `` `${symbol}-PERP · ${side} · ${lev}×` ``.
- [ ] **Step 4: PASS** — `npm test`, `tsc` у `features/positions` чисто.
- [ ] **Step 5: commit**

```bash
git add app/src/features/positions app/test/positionsList.test.ts
git commit -m "feat(app): positions list from slots, per-market actions"
```

---

### Task 6: History з кільця + архів на пристрої; Ledger і commit-reveal прибрано

**Files:**
- Create: `app/src/features/history/historyArchive.ts`, `app/src/features/history/historyRows.ts` (переписати), `app/src/features/history/useHistoryRows.ts` (переписати)
- Delete: `app/src/features/history/hashStore.ts`, `app/src/features/ledger/{LedgerScreen,DisclosuresTab}.tsx`, `app/app/(tabs)/ledger.tsx`
- Modify: `app/src/features/history/HistoryScreen.tsx`, `app/src/features/ledger/{PoolTab,RootTab}.tsx` → перенести в `app/src/features/receipt/` як секції Account (Pool snapshot, Root) або видалити, якщо Receipt уже показує root (рішення: `PoolTab` → `PoolSnapshotCard` на Account; `RootTab` → видалити, `ReceiptSection` уже показує root), `app/app/(tabs)/_layout.tsx` (прибрати вкладку Ledger), `app/src/lib/features.ts` (прибрати `ledger`, `commitReveal`), `app/src/features/account/AccountScreen.tsx` (вставити `PoolSnapshotCard`)
- Test: `app/test/historyRows.test.ts` (новий), `app/test/historyArchive.test.ts` (новий)

**Interfaces:**
- Consumes: Task 1 (`DecodedPositions`, `HistoryRecord`, `historyKey`), Task 4 (`useMarkets` для символів).
- Produces:

```ts
// historyArchive.ts — on-device archive of every ring record this device has seen (spec §2.9.4: depth not limited to 16)
export interface ArchivedRecord { key: string; market: string; side: SideName; size: string; entry: string; exit: string; pnl: string; fees: string; openedSlot: string; closedSlot: string; reason: HistoryReason; seenAt: number }   // bigints as decimal strings (JSON), seenAt = Date.now() when first seen
export function toArchived(r: HistoryRecord, seenAt: number): ArchivedRecord
export function mergeArchive(existing: ArchivedRecord[], ring: HistoryRecord[], now: number): ArchivedRecord[]   // adds unseen ring records (by key), keeps the rest, never removes; sorted by closedSlot desc
export async function loadArchive(owner: PublicKey): Promise<ArchivedRecord[]>      // AsyncStorage key `dexxer.history.<owner>`; corrupt JSON → []
export async function saveArchive(owner: PublicKey, rows: ArchivedRecord[]): Promise<void>
// historyRows.ts
export interface Row { key: string; symbol: string; side: SideName; size: bigint; entry: bigint; exit: bigint; pnl: bigint; fees: bigint; closedSlot: bigint; reason: HistoryReason; seenAt: number }
export function historyRowsFrom(archive: ArchivedRecord[], symbolOf: (market: string) => string): Row[]
export function reasonLabel(r: HistoryReason): string     // 'Closed' | 'Liquidated' | 'Partial close'
// useHistoryRows.ts
export function useHistoryRows(owner, conn, positions: PublicKey | null): { rows: Row[]; live: LiveAccount<DecodedPositions>; archiveError: string | null; refreshing; onRefresh }
```

- [ ] **Step 1: падаючі тести.** `app/test/historyArchive.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { mergeArchive, toArchived } from '../src/features/history/historyArchive'
import type { HistoryRecord } from '../src/lib/positions'

const m = Keypair.generate().publicKey
const rec = (closedSlot: bigint, o: Partial<HistoryRecord> = {}): HistoryRecord =>
  ({ market: m, size: 10n, entry: 150n, exit: 160n, pnl: 7n, fees: 1n, openedSlot: closedSlot - 5n, closedSlot, side: 'Long', reason: 'User', ...o })

test('mergeArchive adds unseen ring records once, keeps records the ring has already overwritten, newest first', () => {
  const t0 = 1_000
  const a1 = mergeArchive([], [rec(100n), rec(101n)], t0)
  assert.deepEqual(a1.map((r) => r.closedSlot), ['101', '100'])
  assert.ok(a1.every((r) => r.seenAt === t0))
  const a2 = mergeArchive(a1, [rec(101n), rec(102n)], t0 + 5)   // 100 fell out of the ring
  assert.deepEqual(a2.map((r) => r.closedSlot), ['102', '101', '100'])
  assert.equal(a2.find((r) => r.closedSlot === '101')?.seenAt, t0, 'first-seen time is kept')
  assert.equal(a2.find((r) => r.closedSlot === '102')?.seenAt, t0 + 5)
})

test('a partial decrease and the later full close of the same position are two records', () => {
  const part = rec(50n, { reason: 'Decrease', size: 4n })
  const full = rec(60n, { reason: 'User', size: 6n })
  const a = mergeArchive([], [part, full], 1)
  assert.equal(a.length, 2)
  assert.deepEqual(a.map((r) => r.reason), ['User', 'Decrease'])
})

test('toArchived serialises bigints as decimal strings and keeps the identity key', () => {
  const r = toArchived(rec(7n, { pnl: -3n }), 42)
  assert.equal(r.pnl, '-3')
  assert.equal(r.size, '10')
  assert.match(r.key, new RegExp(`^${m.toBase58()}:2:7:10:User$`))
})
```

  `app/test/historyRows.test.ts`: `historyRowsFrom` — символ через `symbolOf`, bigint назад, порядок збережений, `reasonLabel` для трьох причин.

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: реалізація.** `historyArchive.ts` за Interfaces (AsyncStorage — `@react-native-async-storage/async-storage` уже в залежностях; у тестах модуль з AsyncStorage не імпортується — `load/save` винести так, щоб `mergeArchive`/`toArchived` були чисті й імпортувались без нативного модуля: окремий файл `historyArchiveStore.ts` для `load/save`, якщо `test/setup.ts` не мокає AsyncStorage). `historyRows.ts` — переписати: лише `Row`, `historyRowsFrom`, `reasonLabel` (старі `mergeHistoryRows`, `recordHash`, `RevealedEntry`, статуси — видалити). `useHistoryRows.ts`: `live = useLiveAccount(conn, positions, decodePositions)`; `useEffect` на зміну `live.value?.history` → `mergeArchive(archive, live.value.history, Date.now())` → `saveArchive`; `rows = historyRowsFrom(archive, symbolOf)` де `symbolOf` з `useMarkets()` (`market → symbol`, невідомий → скорочений ключ). `HistoryScreen.tsx`: рядок — `` `${reasonLabel(r.reason)} · ${r.side} ${fmtSize(r.size)} ${r.symbol}` ``, Entry → Exit, PnL, Fees, час `new Date(r.seenAt).toLocaleString()` з підписом «seen» (ER-слоти не мають unix-часу — spec); без пояснення «Why do trades become public?», без бейджів статусу й explorer-лінка. Видалити `hashStore.ts`, `features/ledger/*`, маршрут `ledger.tsx`, вкладку в `_layout.tsx`, `FEATURES.ledger/commitReveal` і їхні вживання. `PoolTab` → `features/receipt/PoolSnapshotCard.tsx` (той самий вміст, картка «Pool snapshot» на Account під Receipt); `RootTab` — видалити (Receipt показує root). Перевірити `grep -rn "disclos\|Disclos\|commitReveal\|ledger\|Ledger" app/src app/app` — лишаються лише історичні коментарі (переписати їх в один рядок) або нічого.
- [ ] **Step 4: PASS** — `npm test` увесь зелений; `npx tsc --noEmit` чисто; `npm run lint:check` чисто.
- [ ] **Step 5: commit**

```bash
git add app/src/features/history app/src/features/receipt app/src/features/account/AccountScreen.tsx app/app/\(tabs\)/_layout.tsx app/src/lib/features.ts app/test/historyRows.test.ts app/test/historyArchive.test.ts
git rm -q app/src/features/history/hashStore.ts app/src/features/ledger/LedgerScreen.tsx app/src/features/ledger/DisclosuresTab.tsx app/src/features/ledger/PoolTab.tsx app/src/features/ledger/RootTab.tsx app/app/\(tabs\)/ledger.tsx
git commit -m "feat(app): history from the Positions ring with an on-device archive; Ledger and commit-reveal UI removed"
```

---

### Task 7: підсумкова перевірка, документи, пам'ятка smoke-тесту

**Files:**
- Modify: `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` (§2.9 — абзац «**Реалізовано (app, <дата>)**», оновити «Відкрите для плану 3» → виконано/вказівник, доповнити «Відкрите для плану 4»), `CLAUDE.md` (новий розділ «Правила тижня 6: позиції-слоти, app»; рядок у «Документи»; застарілі app-правила — маркер `**[Застаріло з 30.09.2026: див. «Правила тижня 6: позиції-слоти»]**`), `docs/emulator-runbook.md` (чек-лист smoke на новій програмі), `app/README.md` (замінити шаблонний текст Expo коротким описом апки, запуску, тестів, IDL)

- [ ] **Step 1: повна перевірка** — `cd app && npx tsc --noEmit && npm run lint:check && npm test && npm run format:check`; записати лічильник тестів. `grep -rn "app/src/idl" .github services docs CLAUDE.md` — не має лишитись живих посилань (історичні — з маркером).
- [ ] **Step 2: spec «Реалізовано (app)»**: що зроблено по задачах; рішення цього плану (IDL імпортується з `idl/` напряму; архів історії в AsyncStorage за ключем `dexxer.history.<owner>`, `seenAt` як час; `Exited` як стан онбордингу замість `init_user_reuse_queue`; ринок обирається глобально, зберігається в AsyncStorage `dexxer.market`; `PositionScreen`/Ledger видалено); лічильники; **не перевірено:** жодного живого прогону (емулятор/гаманець/devnet) — усе лише `tsc`/lint/unit; відкрите для плану 4 (APK на нову програму лише після деплою; smoke-чек-лист нижче).
- [ ] **Step 3: CLAUDE.md**: розділ «app»: канонічний IDL через відносний імпорт `../../../idl/dexxer_core.json` (Metro `watchFolders`); ручні декодери (`positions.ts` зміщення = Rust-тест); `TradeAccounts` 12, `taskContext = positions`; `useSelectedMarket`/`useMarkets` (`GET /markets`), `useMark(symbol)`; `/ws?markets=*`; History = кільце + архів; Exit передає ринки з історії+слотів (≤16); стан `Exited`; мапа помилок 6046/6049/6050; видалені екрани; лічильник тестів. Застарілі правила про app (`DisclosuresTab`, `hashStore`, `commitReveal`, `useDisclosures`, `/disclosures` у «Публічні дані indexer-а», `decodePosition`) — маркер.
- [ ] **Step 4: `docs/emulator-runbook.md`** — додати розділ «Smoke на програмі слотів (план 4)»: кроки для користувача з реальним гаманцем: онбординг (два акаунти, 3 L1-леги + ER), вибір ринку, open на SOL і на BTC, список позицій з двома картками, часткове зменшення → запис `Partial close` в History, закриття, перезапуск апки → архів лишився, вихід з двома ринками в `remaining_accounts`, повторний онбординг після janitor-а (стан `Exited` → до 5 хв → нормальний онбординг). Позначити: не виконувалось у плані 3.
- [ ] **Step 5: commit**

```bash
git add docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md CLAUDE.md docs/emulator-runbook.md app/README.md
git commit -m "docs(week6): app on position slots — rules, smoke checklist"
```
