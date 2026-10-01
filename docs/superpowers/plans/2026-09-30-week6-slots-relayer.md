# Позиції-слоти, план 2 з 4: relayer, адмін-TS і новий IDL

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TypeScript-частина репозиторію (`tests/er`, `scripts`, `services/relayer`) і закомічений IDL працюють із програмою плану 1 (слоти `Positions`, без розкриття) і з кількома ринками: crank тікає й ліквідує кожен ринок, індексер віддає ціни по ринках, janitor закриває акаунти тих, хто вийшов, CI знову зелений.

**Architecture:** спершу IDL (генератор у репозиторії, заміна `app/src/idl`), потім спільна бібліотека `tests/er/lib` (PDA, кодек `Positions`, хелпери трейдера й адміна), потім relayer у три кроки: перенесення незалежної від позицій частини з гілки `multi-market-relayer` (реєстр ринків, індексер по ринках, `/healthz.markets`), нові janitor і sponsor-whitelist, і нарешті crank по ринках на слотах плюс спрощений коміт-цикл. Розкриття видаляється з relayer-а повністю.

**Tech Stack:** Node 24.18 (`.nvmrc`), TypeScript (tsx, `node:test`), `@coral-xyz/anchor` 0.32.1 (нетипізований `Program` з IDL JSON), `@solana/web3.js` v1, `@magicblock-labs/ephemeral-rollups-sdk` 0.17, `@noble/hashes`, Express 5, `ws`, Postgres; Rust — лише генератор IDL (`anchor-lang-idl` 0.1.4) і один unit-тест зміщень.

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.9 (2.9.1–2.9.3 і «Реалізовано (програма…)», «Відкрите для плану 2»); §2.8.1 і §2.8.3 (ринок = символ, реєстр ринків) чинні з поправками §2.9.3.

**Джерело перенесення:** гілка `multi-market-relayer` (не змерджена, голова `2b58fd3`). Файли читати через `git show multi-market-relayer:<шлях>`; гілку не чекаутити й не мерджити.

**План 3 (app) і план 4 (чистий деплой, devnet-виміри)** — окремо. Цей план нічого не запускає на devnet і не деплоїть.

> **Поправка під час виконання (рулінг Task 1, 30.09).** Канонічний IDL живе в **`idl/dexxer_core.json`** (корінь репозиторію), а не в `app/src/idl`. Причина: апка будує інструкції й кодеки через IDL, тож заміна її копії ламає 12 її тестів до плану 3. Тому `app/` у цьому плані **не змінюється взагалі** (її `app/src/idl/dexxer_core.json` лишається старим до плану 3), а CI (`cmp`), Dockerfile relayer-а й `DEXXER_IDL_DIR` перемикаються на `idl/`. Усюди нижче, де згадано `app/src/idl/dexxer_core.json` як ціль генерації чи порівняння, читати `idl/dexxer_core.json`; кроки Task 1 про `app/src/lib/errors.ts` і тести апки замінено на: «`app/` без змін, `cd app && npm test` — 103/103», плюс правки `.github/workflows/ci.yml` (рядок `cmp` і `DEXXER_IDL_DIR`) та `services/relayer/Dockerfile` (`COPY idl/dexxer_core.json idl/dexxer_core.json`, `ENV DEXXER_IDL_DIR=/app/idl`).

## Global Constraints

- Гілка `positions-slots` (голова плану 1 — `b2176f7`). Нічого не пушити; коміт після кожної задачі, `git add <paths>` поштучно; повідомлення комітів англійською з трейлером сесії.
- Node — з `.nvmrc` (24.18.0): `. "$HOME/.nvm/nvm.sh" && nvm use`. Тести relayer-а: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl npm test`. Типи: `npx tsc --noEmit` у `tests/er`, `scripts`, `services/relayer`. Postgres-тести (`test/indexerDb.test.ts`) — лише з `TEST_DATABASE_URL` (Docker `postgres:16-alpine`, рецепт у `services/relayer/README.md`); без нього вони skipped, і це допустимо.
- `anchor build` локально НЕ запускати (перемикає глобальну Solana). Rust: `cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml`, `cargo test -p dexxer_core`, `cargo +nightly-2026-09-18 test -p dexxer_litesvm` (або `cargo +nightly`).
- Програму (`programs/`) не змінювати, крім одного unit-тесту зміщень у Task 2 (після нього — `program_autofixer` на зміненому файлі). `app/` не чіпати ВЗАГАЛІ (її копія IDL лишається старою до плану 3); канонічний IDL — `idl/dexxer_core.json`.
- `idl/dexxer_core.json` — без кінцевого `\n` (CI порівнює `cmp` з виходом `anchor build`).
- Правило приватності: сервери читають лише публічні акаунти й оракул; приватні (`Positions`, `UserAccount`, `MarketRisk`, `PoolLive`) — тільки crank через власний TEE-токен (він permission-член). Жоден REST/WS-ендпоінт не віддає нічого з приватних акаунтів. Відкритий інтерес не віддаємо.
- `Positions`, `PositionSlot`, `HistoryRecord`, `BalancesRoot` — `bytemuck`/`repr(C)`: Borsh-кодер Anchor їх НЕ декодує; лише ручний декодер за зміщеннями (Task 2).
- Кандидати `crank_tick` — пари `[Positions, UserAccount]`, ≤16 на інструкцію; акаунт не того типу першим у парі зриває весь батч (Anchor 3002) — сміття відсіюється на клієнті.
- `commit_aggregate()` — без аргументів і без `remaining_accounts`; викликається фіксованим інтервалом, ніколи подієво.
- Проміжні задачі можуть лишати частину набору relayer-а червоною (IDL уже новий, код ще старий) — кожна задача називає СВОЇ перевірки; повний зелений стан (`tsc` ×3, увесь `npm test`, selftest) обов'язковий з Task 6.
- Базова лінія relayer-а на `main`: 171 тест (161 + 10 Postgres). Кожна задача фіксує фактичні лічильники у звіті.

## Review Focus

1. **Трейдер із позиціями на кількох ринках.** Один акаунт `Positions` дає по кандидату на кожен ВІДКРИТИЙ слот; у батч ринку потрапляє лише трейдер із відкритим слотом на цьому ринку; одна пара не повторюється в одній транзакції — Task 6.
2. **Сміття серед акаунтів `Positions`.** Акаунт хибної довжини чи з чужим дискримінатором у видачі `getProgramAccounts` пропускається з логом і не потрапляє в батч (інакше програма зриває весь батч і ніхто не ліквідується) — Task 2 (декодер кидає), Task 6 (відбір пропускає).
3. **SOL тікає завжди; невідомий ринок видно.** Порожній реєстр або реєстр без SOL не зупиняє тіки SOL; відкриті позиції на ринку, якого нема в списку тіків, дають попередження в лог, а не мовчання — Task 6.
4. **Janitor не закриває зарано й шле ренту за адресою з акаунта.** Поки `UserAccount` або `Positions` ще під Delegation Program — пропуск; призначення ренти — `UserAccount.rent_payer`, прочитане з акаунта, а не `fee_payer` — Task 5.
5. **Коміт за годинником, а не за лічильником тіків.** Повільна петля з п'ятьма ринками комітить кожні `COMMIT_INTERVAL_MS`; збій коміту чи root-циклу не зупиняє тіки — Task 6.

---

### Task 1: генератор IDL у репозиторії, новий IDL

**Files:**
- Create: `tools/idlgen/Cargo.toml`, `tools/idlgen/src/main.rs`, `tools/idlgen/README.md`
- Modify: `app/src/idl/dexxer_core.json` (заміна цілком), `app/src/lib/errors.ts` (повідомлення для 6049 і 6050), `.gitignore` (якщо `tools/idlgen/target` ще не ігнорується)

**Interfaces:**
- Produces: `app/src/idl/dexxer_core.json` — IDL програми на `HEAD`: 40 інструкцій; акаунти `BalancesRoot, Config, Faucet, FeeEscrow, Market, MarketRisk, Pool, PoolLive, Positions, UserAccount`; помилки до 6050 `PositionLiquidatable`. Команда регенерації: `cargo run --release --manifest-path tools/idlgen/Cargo.toml -- <abs program dir> <out file>` (через зібраний бінар, див. Step 2).

- [ ] **Step 1: крейт-генератор**

`tools/idlgen/Cargo.toml`:

```toml
[package]
name = "idlgen"
version = "0.1.0"
edition = "2021"
publish = false

[dependencies]
anchor-lang-idl = { version = "0.1.4", features = ["build"] }
serde_json = "1"

# Standalone on purpose: not a member of the repo workspace, so the program's
# lockfile and `cargo fmt/clippy` over the workspace are unaffected.
[workspace]
```

`tools/idlgen/src/main.rs`:

```rust
// Regenerates the program IDL without `anchor-cli` (whose `[toolchain]
// solana_version` switches the machine's global Solana install).
//
// usage: idlgen <absolute path to programs/dexxer_core> <output file>
//
// The output has NO trailing newline — CI compares it byte-for-byte with
// `anchor build`'s `target/idl/dexxer_core.json`.
use std::path::PathBuf;

use anchor_lang_idl::build::IdlBuilder;

fn main() {
    let mut args = std::env::args().skip(1);
    let program = PathBuf::from(args.next().expect("program dir (absolute)"));
    let out = PathBuf::from(args.next().expect("output file"));
    assert!(program.is_absolute(), "program dir must be an absolute path");
    let idl = IdlBuilder::new()
        .program_path(program)
        .skip_lint(true)
        .build()
        .expect("IDL build failed");
    std::fs::write(&out, serde_json::to_string_pretty(&idl).expect("serialize")).expect("write");
}
```

`tools/idlgen/README.md` (українською, 10–15 рядків): навіщо (без `anchor-cli`), команда з Step 2, дві пастки — `IdlBuilder` підставляє літерал `+{toolchain}`, якщо виставлено `RUSTUP_TOOLCHAIN`, тому запускати ЗІБРАНИЙ бінар з `env -u RUSTUP_TOOLCHAIN`; свіжий `CARGO_TARGET_DIR` на кожен checkout; вихід без кінцевого `\n`.

- [ ] **Step 2: згенерувати й замінити IDL**

```bash
cd /Users/vitalikcholan/Projects/mobile_perp_dex
cargo build --release --manifest-path tools/idlgen/Cargo.toml
env -u RUSTUP_TOOLCHAIN CARGO_TARGET_DIR="$PWD/tools/idlgen/target/idl-build" \
  tools/idlgen/target/release/idlgen "$PWD/programs/dexxer_core" "$PWD/idl/dexxer_core.json"
```

Перевірити (записати вихід у звіт):

```bash
node -e '
const i=require("./idl/dexxer_core.json");
const n=(a)=>a.map(x=>x.name);
console.log("ix",i.instructions.length,"accounts",n(i.accounts).sort().join(","));
console.log("last errors",i.errors.slice(-2).map(e=>e.code+" "+e.name).join(", "));
for (const gone of ["write_commitment","init_position","close_orphan_queue","init_user_reuse_queue"]) if (n(i.instructions).includes(gone)) throw new Error("still has "+gone);
const iu=i.instructions.find(x=>x.name==="init_user"); console.log("init_user",n(iu.accounts).join(","));
'
tail -c 1 idl/dexxer_core.json | xxd -p   # НЕ 0a
```

Expected: `ix 40`; акаунти рівно `BalancesRoot,Config,Faucet,FeeEscrow,Market,MarketRisk,Pool,PoolLive,Positions,UserAccount`; `last errors 6049 NoFreeSlot, 6050 PositionLiquidatable`; `init_user owner,payer,config,user_account,positions,system_program`; останній байт не `0a`.

- [ ] **Step 3: повідомлення помилок апки.** Тест `app/test/errors.test.ts` вимагає повідомлення для кожного коду з IDL. У `app/src/lib/errors.ts` додати в мапу повідомлень (у стилі сусідніх записів):

```ts
  6049: 'All position slots are in use. Close a position to open a new market.',
  6050: 'This position is at its liquidation price. Add margin before increasing it.',
```

(якщо мапа ключується інакше — за назвою чи через хелпер — додати ті самі два тексти в наявній формі; жодних інших змін в апці.)

- [ ] **Step 4: перевірка**

```bash
cd app && npm ci && npx tsc --noEmit && npm test
```

Expected: `tsc` чистий, усі тести апки зелені (зокрема `every error code the IDL declares has a message`). Тести relayer-а після цієї задачі НЕ проганяти як критерій — вони червоні до Task 6 (старий код проти нового IDL); записати це у звіт одним рядком.

- [ ] **Step 5: commit**

```bash
git add tools/idlgen/Cargo.toml tools/idlgen/src/main.rs tools/idlgen/README.md app/src/idl/dexxer_core.json app/src/lib/errors.ts
git commit -m "build(idl): in-repo IDL generator; IDL of the position-slots program"
```

(`tools/idlgen/Cargo.lock` — закомітити теж, якщо згенерувався; `tools/idlgen/target/` — в `.gitignore`.)

---

### Task 2: `tests/er/lib` — програма, PDA, символи, кодек `Positions`

**Files:**
- Create: `tests/er/lib/symbol.ts`, `tests/er/lib/positions.ts`
- Modify: `tests/er/lib/program.ts`, `tests/er/lib/hashes.ts`, `tests/er/lib/hashes.selftest.ts`
- Modify: `programs/dexxer_core/src/state/positions.rs` (лише новий unit-тест зміщень)
- Test: `services/relayer/test/symbol.test.ts` (перенести), `services/relayer/test/positionsCodec.test.ts` (новий)

**Interfaces:**
- Produces (`tests/er/lib/program.ts`):
  - `POSITIONS_DISC: string` (bs58), `POSITIONS_DISC_BYTES: Buffer`, `USER_DISC`, `MARKET_DISC`; **видалені**: `POSITION_DISC`, `DQ_DISC`, `DISCLOSURE_DISC`, `MAX_ACTIONS_PER_COMMIT`, `ACTION_ESCROW_INDEX`, `hashSeed`.
  - `pdas.positions(owner: PublicKey)` = `[b"positions", owner]`; `pdas.marketFor(symbol: string)`; **видалені**: `pdas.position`, `pdas.disclosureQueue`, `pdas.commitment`, `pdas.disclosure`. `pdas.market()` (SOL) лишається.
  - реекспорт `symbolBytes`, `symbolString` із `./symbol.js`; з `./hashes.js` — лише `leaf`, `pad`, `u64le`.
- Produces (`tests/er/lib/positions.ts`):

```ts
export const MAX_SLOTS = 16;
export const HISTORY_LEN = 16;
export const POSITIONS_SIZE = 3184;
export interface PositionSlot {
  index: number; market: PublicKey; size: bigint; entry: bigint; margin: bigint; liqPrice: bigint;
  openedSlot: bigint; oiNotional: bigint; lastLiqSample: bigint; side: "long" | "short"; liqTicks: number;
}
export interface HistoryRecord {
  market: PublicKey; size: bigint; entry: bigint; exit: bigint; pnl: bigint; fees: bigint;
  openedSlot: bigint; closedSlot: bigint; side: "long" | "short"; reason: "user" | "liquidated" | "decrease";
}
export interface Positions { owner: PublicKey; slots: PositionSlot[]; history: HistoryRecord[]; version: number; bump: number }
export function decodePositions(data: Buffer): Positions;          // throws on wrong length / discriminator
export function slotFor(p: Positions, market: PublicKey): PositionSlot | null;
export function liqTaskId(positions: PublicKey, market: PublicKey): bigint;  // signed i64, LE
```

`Positions.slots` містить ЛИШЕ відкриті слоти (у порядку індексу); `history` — від найстарішого до найновішого.

- [ ] **Step 1: Rust-тест, що пінить зміщення** (спільна «золота» таблиця для TS). У `programs/dexxer_core/src/state/positions.rs`, у наявний `mod tests`:

```rust
    /// Byte offsets the off-chain decoders rely on (tests/er/lib/positions.ts,
    /// and the app's codec): a layout change must fail here first.
    #[test]
    fn offsets_match_the_off_chain_decoders() {
        use core::mem::offset_of;
        assert_eq!(offset_of!(Positions, owner), 0);
        assert_eq!(offset_of!(Positions, slots), 32);
        assert_eq!(offset_of!(Positions, history), 1568);
        assert_eq!(offset_of!(Positions, history_head), 3104);
        assert_eq!(offset_of!(Positions, history_len), 3105);
        assert_eq!(offset_of!(Positions, version), 3106);
        assert_eq!(offset_of!(Positions, bump), 3107);
        assert_eq!(offset_of!(PositionSlot, market), 0);
        assert_eq!(offset_of!(PositionSlot, size), 32);
        assert_eq!(offset_of!(PositionSlot, entry), 40);
        assert_eq!(offset_of!(PositionSlot, margin), 48);
        assert_eq!(offset_of!(PositionSlot, liq_price), 56);
        assert_eq!(offset_of!(PositionSlot, opened_slot), 64);
        assert_eq!(offset_of!(PositionSlot, oi_notional), 72);
        assert_eq!(offset_of!(PositionSlot, last_liq_sample), 80);
        assert_eq!(offset_of!(PositionSlot, state), 88);
        assert_eq!(offset_of!(PositionSlot, side), 89);
        assert_eq!(offset_of!(PositionSlot, liq_ticks), 90);
        assert_eq!(offset_of!(HistoryRecord, market), 0);
        assert_eq!(offset_of!(HistoryRecord, size), 32);
        assert_eq!(offset_of!(HistoryRecord, entry), 40);
        assert_eq!(offset_of!(HistoryRecord, exit), 48);
        assert_eq!(offset_of!(HistoryRecord, pnl), 56);
        assert_eq!(offset_of!(HistoryRecord, fees), 64);
        assert_eq!(offset_of!(HistoryRecord, opened_slot), 72);
        assert_eq!(offset_of!(HistoryRecord, closed_slot), 80);
        assert_eq!(offset_of!(HistoryRecord, side), 88);
        assert_eq!(offset_of!(HistoryRecord, reason), 89);
    }
```

Run: `cargo test -p dexxer_core offsets_match` → PASS (якщо якесь число не збіглося — це розбіжність плану з кодом: виправити ЧИСЛО в тесті за фактом, перенести його в декодер Step 4 і записати у звіт). Потім `program_autofixer` на `state/positions.rs`.

- [ ] **Step 2: падаючі TS-тести.** `services/relayer/test/symbol.test.ts` — взяти дослівно: `git show multi-market-relayer:services/relayer/test/symbol.test.ts` (4 тести). `services/relayer/test/positionsCodec.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEXXER_CORE_PROGRAM_ID, POSITIONS_DISC_BYTES, pdas } from "../../../tests/er/lib/program.js";
import { HISTORY_LEN, MAX_SLOTS, POSITIONS_SIZE, decodePositions, liqTaskId, slotFor } from "../../../tests/er/lib/positions.js";

const SLOTS = 8 + 32;
const HISTORY = 8 + 1568;
const HEAD = 8 + 3104;

function blank(owner: PublicKey): Buffer {
  const b = Buffer.alloc(POSITIONS_SIZE);
  POSITIONS_DISC_BYTES.copy(b, 0);
  owner.toBuffer().copy(b, 8);
  b.writeUInt8(1, 8 + 3106); // version
  b.writeUInt8(254, 8 + 3107); // bump
  return b;
}
function putSlot(b: Buffer, i: number, market: PublicKey, o: { size: bigint; margin: bigint; side: number; liqTicks?: number; state?: number }): void {
  const at = SLOTS + i * 96;
  market.toBuffer().copy(b, at);
  b.writeBigUInt64LE(o.size, at + 32);
  b.writeBigUInt64LE(150_000_000n, at + 40);
  b.writeBigUInt64LE(o.margin, at + 48);
  b.writeBigUInt64LE(140_000_000n, at + 56);
  b.writeBigUInt64LE(77n, at + 64);
  b.writeBigUInt64LE(1_500_000_000n, at + 72);
  b.writeBigUInt64LE(5n, at + 80);
  b.writeUInt8(o.state ?? 1, at + 88);
  b.writeUInt8(o.side, at + 89);
  b.writeUInt8(o.liqTicks ?? 0, at + 90);
}
function putHistory(b: Buffer, i: number, closedSlot: bigint, pnl: bigint, reason: number): void {
  const at = HISTORY + i * 96;
  Keypair.generate().publicKey.toBuffer().copy(b, at);
  b.writeBigUInt64LE(10n, at + 32);
  b.writeBigInt64LE(pnl, at + 56);
  b.writeBigUInt64LE(closedSlot, at + 80);
  b.writeUInt8(1, at + 88);
  b.writeUInt8(reason, at + 89);
}

test("decodePositions returns only open slots, with their index and fields", () => {
  const owner = Keypair.generate().publicKey;
  const sol = Keypair.generate().publicKey;
  const btc = Keypair.generate().publicKey;
  const b = blank(owner);
  putSlot(b, 0, sol, { size: 10n, margin: 150n, side: 0 });
  putSlot(b, 3, btc, { size: 7n, margin: 80n, side: 1, liqTicks: 1 });
  putSlot(b, 5, Keypair.generate().publicKey, { size: 1n, margin: 1n, side: 0, state: 0 }); // residue in an EMPTY slot
  const p = decodePositions(b);
  assert.equal(p.owner.toBase58(), owner.toBase58());
  assert.deepEqual(p.slots.map((s) => s.index), [0, 3]);
  assert.equal(p.slots[1].market.toBase58(), btc.toBase58());
  assert.equal(p.slots[1].side, "short");
  assert.equal(p.slots[1].liqTicks, 1);
  assert.equal(p.slots[0].entry, 150_000_000n);
  assert.equal(p.slots[0].oiNotional, 1_500_000_000n);
  assert.equal(p.slots[0].lastLiqSample, 5n);
  assert.equal(slotFor(p, btc)?.index, 3);
  assert.equal(slotFor(p, Keypair.generate().publicKey), null);
  assert.equal(p.version, 1);
  assert.equal(p.bump, 254);
});

test("history comes back oldest first, before and after the ring wraps", () => {
  const b = blank(Keypair.generate().publicKey);
  for (let i = 0; i < 3; i++) putHistory(b, i, BigInt(100 + i), -5n, i);
  b.writeUInt8(3, HEAD); // head = next write index
  b.writeUInt8(3, HEAD + 1); // len
  const p = decodePositions(b);
  assert.deepEqual(p.history.map((h) => h.closedSlot), [100n, 101n, 102n]);
  assert.deepEqual(p.history.map((h) => h.reason), ["user", "liquidated", "decrease"]);
  assert.equal(p.history[0].pnl, -5n);
  assert.equal(p.history[0].side, "short");

  const w = blank(Keypair.generate().publicKey);
  for (let i = 0; i < HISTORY_LEN; i++) putHistory(w, i, BigInt(200 + i), 0n, 0);
  putHistory(w, 0, 300n, 0n, 0); // the 17th close overwrote record 0
  w.writeUInt8(1, HEAD);
  w.writeUInt8(HISTORY_LEN, HEAD + 1);
  const q = decodePositions(w);
  assert.equal(q.history.length, HISTORY_LEN);
  assert.equal(q.history[0].closedSlot, 201n, "oldest surviving record");
  assert.equal(q.history[HISTORY_LEN - 1].closedSlot, 300n, "newest record last");
});

test("decodePositions refuses a wrong length and a foreign discriminator", () => {
  const b = blank(Keypair.generate().publicKey);
  assert.throws(() => decodePositions(b.subarray(0, POSITIONS_SIZE - 1)), /length/);
  const foreign = Buffer.from(b);
  foreign.writeUInt8(foreign[0] ^ 0xff, 0);
  assert.throws(() => decodePositions(foreign), /discriminator/);
  assert.equal(MAX_SLOTS, 16);
});

test("pdas.positions is seeded by the owner only", () => {
  const owner = Keypair.generate().publicKey;
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from("positions"), owner.toBuffer()], DEXXER_CORE_PROGRAM_ID);
  assert.equal(pdas.positions(owner).toBase58(), expected.toBase58());
});

test("liqTaskId matches the program's golden vector and depends on argument order", () => {
  const positions = new PublicKey(Buffer.alloc(32, 1));
  const market = new PublicKey(Buffer.alloc(32, 2));
  assert.equal(liqTaskId(positions, market), 1387748199796337972n);
  assert.equal(liqTaskId(market, positions), 4965387733951305052n);
});
```

- [ ] **Step 3: FAIL**

```bash
cd services/relayer && . "$HOME/.nvm/nvm.sh" && nvm use
DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/positionsCodec.test.ts test/symbol.test.ts
```

Expected: FAIL — модулів `positions.js`/`symbol.js` нема, а `program.ts` падає на `accountDiscriminator("Position")` при завантаженні.

- [ ] **Step 4: реалізація**

`tests/er/lib/symbol.ts` — дослівно з `git show multi-market-relayer:tests/er/lib/symbol.ts`.

`tests/er/lib/program.ts`:
  - дискримінатори: видалити `POSITION_DISC`, `DQ_DISC`, `DISCLOSURE_DISC`; додати

```ts
const coder = new BorshAccountsCoder(DEXXER_CORE_IDL);
/** `Positions` is bytemuck/zero-copy: the coder gives its discriminator, never its body (see positions.ts). */
export const POSITIONS_DISC_BYTES: Buffer = Buffer.from(coder.accountDiscriminator("Positions"));
export const POSITIONS_DISC = bs58.encode(POSITIONS_DISC_BYTES);
export const MARKET_DISC = bs58.encode(coder.accountDiscriminator("Market"));
```

  (`USER_DISC` лишається; якщо `coder` уже є під іншим іменем — використати наявний.)
  - сіди: видалити `POSITION_SEED`, `DQ_SEED`, `COMMIT_SEED`, `DISCLOSURE_SEED`; додати `const POSITIONS_SEED = Buffer.from("positions");`
  - `pdas`: видалити `position`, `disclosureQueue`, `commitment`, `disclosure`; додати

```ts
  marketFor: (symbol: string) => pda([MARKET_SEED, symbolBytes(symbol)], DEXXER_CORE_PROGRAM_ID),
  /** A trader's positions on every market and their private history ring — one account per owner (spec §2.9.1). */
  positions: (owner: PublicKey) => pda([POSITIONS_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
```

  - видалити `MAX_ACTIONS_PER_COMMIT`, `ACTION_ESCROW_INDEX`, `hashSeed`; реекспорт із `./hashes.js` звести до `leaf`, `pad`, `u64le`; додати `export { symbolBytes, symbolString } from "./symbol.js";`

`tests/er/lib/hashes.ts`: видалити `commitmentHash`, `DisclosureArgsBytes`, `sideIndex`, `reasonIndex`, `i64le` (якщо більше ніде не вживається в файлі); лишити `u64le`, `leaf`, `pad`. `hashes.selftest.ts`: видалити блок `commitmentHash`; блоки `leaf`/`pad` без змін.

`tests/er/lib/positions.ts`:

```ts
// tests/er/lib/positions.ts
//
// Manual decoder of the zero-copy `Positions` account (spec §2.9.1). Anchor's
// Borsh coder cannot read a bytemuck `repr(C)` account, so the layout is read
// by offset — the same numbers `offsets_match_the_off_chain_decoders` pins in
// programs/dexxer_core/src/state/positions.rs.
import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";
import { POSITIONS_DISC_BYTES } from "./program.js";

export const MAX_SLOTS = 16;
export const HISTORY_LEN = 16;
const DISC = 8;
const RECORD = 96;
const SLOTS_AT = DISC + 32;
const HISTORY_AT = DISC + 1568;
const HEAD_AT = DISC + 3104;
export const POSITIONS_SIZE = DISC + 3176;

export interface PositionSlot {
  index: number;
  market: PublicKey;
  size: bigint;
  entry: bigint;
  margin: bigint;
  liqPrice: bigint;
  openedSlot: bigint;
  oiNotional: bigint;
  lastLiqSample: bigint;
  side: "long" | "short";
  liqTicks: number;
}
export interface HistoryRecord {
  market: PublicKey;
  size: bigint;
  entry: bigint;
  exit: bigint;
  pnl: bigint;
  fees: bigint;
  openedSlot: bigint;
  closedSlot: bigint;
  side: "long" | "short";
  reason: "user" | "liquidated" | "decrease";
}
export interface Positions {
  owner: PublicKey;
  /** Open slots only, in slot-index order. */
  slots: PositionSlot[];
  /** Oldest record first. */
  history: HistoryRecord[];
  version: number;
  bump: number;
}

const side = (b: number): "long" | "short" => (b === 1 ? "short" : "long");
const REASONS = ["user", "liquidated", "decrease"] as const;
const key = (data: Buffer, at: number) => new PublicKey(data.subarray(at, at + 32));

export function decodePositions(data: Buffer): Positions {
  if (data.length !== POSITIONS_SIZE) throw new Error(`Positions: length ${data.length}, expected ${POSITIONS_SIZE}`);
  if (!data.subarray(0, DISC).equals(POSITIONS_DISC_BYTES)) throw new Error("Positions: discriminator mismatch");

  const slots: PositionSlot[] = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const at = SLOTS_AT + i * RECORD;
    if (data.readUInt8(at + 88) !== 1) continue; // SLOT_OPEN
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
    });
  }

  const head = data.readUInt8(HEAD_AT) % HISTORY_LEN;
  const len = Math.min(data.readUInt8(HEAD_AT + 1), HISTORY_LEN);
  const history: HistoryRecord[] = [];
  for (let k = 0; k < len; k++) {
    const at = HISTORY_AT + ((head - len + k + HISTORY_LEN) % HISTORY_LEN) * RECORD;
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
      reason: REASONS[data.readUInt8(at + 89)] ?? "user",
    });
  }

  return { owner: key(data, DISC), slots, history, version: data.readUInt8(DISC + 3106), bump: data.readUInt8(DISC + 3107) };
}

export function slotFor(p: Positions, market: PublicKey): PositionSlot | null {
  return p.slots.find((s) => s.market.equals(market)) ?? null;
}

/** `state::liq_task_id`: keccak256(positions ‖ market), first 8 bytes, little-endian, signed. */
export function liqTaskId(positions: PublicKey, market: PublicKey): bigint {
  const h = keccak_256(Buffer.concat([positions.toBuffer(), market.toBuffer()]));
  return Buffer.from(h.subarray(0, 8)).readBigInt64LE(0);
}
```

- [ ] **Step 5: PASS** — команда зі Step 3 (9 тестів: 5 + 4), потім `cd tests/er && npm ci && npm run selftest:hashes` (друкує `ok:` для `leaf` і `pad`). `npx tsc --noEmit` у `tests/er` після цієї задачі ще червоний (`admin.ts`, `trader.ts`, скрипти — Task 3) — записати у звіт.

- [ ] **Step 6: commit**

```bash
git add tests/er/lib/symbol.ts tests/er/lib/positions.ts tests/er/lib/program.ts tests/er/lib/hashes.ts tests/er/lib/hashes.selftest.ts programs/dexxer_core/src/state/positions.rs services/relayer/test/symbol.test.ts services/relayer/test/positionsCodec.test.ts
git commit -m "feat(lib): Positions codec and PDA, market symbols; drop disclosure helpers"
```

---

### Task 3: `tests/er/lib` — адмін, трейдер, каталог ринків, `add-market`, скрипти

**Files:**
- Create: `tests/er/lib/markets.ts`, `tests/er/devnet/add-market.ts`
- Modify: `tests/er/lib/admin.ts`, `tests/er/lib/trader.ts`, `tests/er/package.json`, `tests/er/README.md`
- Modify: `tests/er/q1-deposit.ts`, `tests/er/q2-permissions.ts`, `tests/er/devnet/{01-onboard-private,02-leak-test,03-commit-cycle,05-crank-liquidation,07-balances-root,08-undelegate,09-pool-snapshot,11-liq-task-migration,13-liquidation-check}.ts`, `scripts/demo/week1-cli.ts`
- Delete: `tests/er/devnet/06-commitment-reveal.ts`, `12-close-orphan.ts`, `14-close-reopen.ts`, `15-exit-debt.ts` (і їхні рядки в `package.json` `scripts`)
- Test: `services/relayer/test/marketParams.test.ts` (перенести), `services/relayer/test/ixAccounts.test.ts` (новий)

**Interfaces:**
- Consumes: Task 2 (`pdas.positions`, `pdas.marketFor`, `decodePositions`, `slotFor`, `liqTaskId`).
- Produces (`tests/er/lib/trader.ts`) — чисті будівники акаунтів, якими користуються і хелпери, і скрипти, і тест:

```ts
export interface Trader { name: string; kp: Keypair; userAccount: PublicKey; positions: PublicKey; userAta: PublicKey; exitSalt: number[]; sigs: Record<string, string>; creditDepositCU: number | null }
export function initUserAccounts(owner: PublicKey, payer: PublicKey): Record<string, PublicKey>;
export function delegateUserAccounts(owner: PublicKey, payer: PublicKey): Record<string, PublicKey>;
export function permissionAccounts(owner: PublicKey): Record<string, PublicKey>;        // init_permissions and set_session
export function tradeAccounts(boot: { config: PublicKey; poolLive: PublicKey }, t: { userAccount: PublicKey; positions: PublicKey }, m: { market: PublicKey; marketRisk: PublicKey; feed: PublicKey }): Record<string, PublicKey>;   // everything except `signer`
export function undelegateUserAccounts(owner: PublicKey, magicFeeVault: PublicKey): Record<string, PublicKey>;
export function closeExitedUserAccounts(closer: PublicKey, owner: PublicKey, rentPayer: PublicKey): Record<string, PublicKey>;
export async function readPositions(conn: Connection, positions: PublicKey): Promise<Positions>;
```

  `openPosition`/`closePosition` приймають необов'язковий `m` (за замовчуванням SOL з `boot`); `readPosition`, `readLastClosedRecord` — видалені (замість них `readPositions` + `slotFor`/`history.at(-1)`).
- Produces (`tests/er/lib/admin.ts`): `fundMarketPermissions`, `initMarketPermissions` — експортовані; `setDisclosureDelay`, `DISCLOSURE_DELAY_SLOTS`, `topUpActionEscrow` — видалені; `initConfig` без аргументу затримки; `initMarket(Array.from(SOL_SYMBOL), …)`, `delegateMarket(Array.from(SOL_SYMBOL))`.
- Produces (`tests/er/lib/markets.ts`): `MARKET_CATALOG`, `marketTaskId(market)` — дослівно з гілки.

- [ ] **Step 1: падаючий тест форм акаунтів.** `services/relayer/test/marketParams.test.ts` — дослівно з `git show multi-market-relayer:services/relayer/test/marketParams.test.ts` (2 тести). `services/relayer/test/ixAccounts.test.ts`:

```ts
// Every account builder must name exactly the accounts the IDL declares for
// its instruction — a missing or misnamed key only fails on a live network
// otherwise (anchor-ts resolves nothing here: the Program is untyped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEXXER_CORE_IDL } from "../../../tests/er/lib/program.js";
import {
  closeExitedUserAccounts, delegateUserAccounts, initUserAccounts, permissionAccounts, tradeAccounts, undelegateUserAccounts,
} from "../../../tests/er/lib/trader.js";

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function idlAccounts(ix: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (DEXXER_CORE_IDL as any).instructions.find((i: any) => i.name === ix);
  assert.ok(def, `IDL has ${ix}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return def.accounts.map((a: any) => camel(a.name)).sort();
}
const k = () => Keypair.generate().publicKey;
const keys = (o: Record<string, PublicKey>, extra: string[] = []) => [...Object.keys(o), ...extra].sort();

test("init_user / delegate_user builders match the IDL", () => {
  assert.deepEqual(keys(initUserAccounts(k(), k())), idlAccounts("init_user"));
  assert.deepEqual(keys(delegateUserAccounts(k(), k())), idlAccounts("delegate_user"));
});

test("init_permissions and set_session share one builder that matches both", () => {
  const a = keys(permissionAccounts(k()));
  assert.deepEqual(a, idlAccounts("init_permissions"));
  assert.deepEqual(a, idlAccounts("set_session"));
});

test("every trading instruction takes the same 12 accounts", () => {
  const a = keys(tradeAccounts({ config: k(), poolLive: k() }, { userAccount: k(), positions: k() }, { market: k(), marketRisk: k(), feed: k() }), ["signer"]);
  assert.equal(a.length, 12);
  for (const ix of ["open_position", "close_position", "increase_position", "decrease_position", "add_margin"]) {
    assert.deepEqual(a, idlAccounts(ix), ix);
  }
});

test("task_context is the trader's Positions account", () => {
  const positions = k();
  const a = tradeAccounts({ config: k(), poolLive: k() }, { userAccount: k(), positions }, { market: k(), marketRisk: k(), feed: k() });
  assert.equal(a.taskContext.toBase58(), positions.toBase58());
  assert.equal(a.positions.toBase58(), positions.toBase58());
});

test("undelegate_user / close_exited_user builders match the IDL", () => {
  assert.deepEqual(keys(undelegateUserAccounts(k(), k())), idlAccounts("undelegate_user"));
  const rentPayer = k();
  const c = closeExitedUserAccounts(k(), k(), rentPayer);
  assert.deepEqual(keys(c), idlAccounts("close_exited_user"));
  assert.equal(c.rentPayer.toBase58(), rentPayer.toBase58());
});
```

- [ ] **Step 2: FAIL** — `DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/ixAccounts.test.ts test/marketParams.test.ts` (модуль `trader.js` не експортує будівників; `markets.js` нема).

- [ ] **Step 3: `tests/er/lib/markets.ts`** — дослівно з `git show multi-market-relayer:tests/er/lib/markets.ts`.

- [ ] **Step 4: `tests/er/lib/admin.ts`.**
  1. Імпорт `SOL_SYMBOL`; `initMarket(Array.from(SOL_SYMBOL), MARKET_DEFAULTS, LAZER_FEED_ID)` і `delegateMarket(Array.from(SOL_SYMBOL))` — в обох `bootstrap()` і `bootstrapDevnet()` (4 місця; зразок — `git diff 9904b98..multi-market-relayer -- tests/er/lib/admin.ts`).
  2. `export` на `fundMarketPermissions` і `initMarketPermissions`.
  3. `initConfig(...)` — прибрати четвертий аргумент `new BN(DISCLOSURE_DELAY_SLOTS)` в обох викликах; порядок, що лишається: `crank, oracle_program, tee_validator, scheduler_signer, fee_payer, magic_fee_vault`.
  4. Видалити `DISCLOSURE_DELAY_SLOTS`, `setDisclosureDelay`, `topUpActionEscrow` та його виклики й згадки в `Bootstrapped`/`BootstrappedDevnet` (дій після коміту більше немає — escrow дій не потрібен).
  5. `MARKET_DEFAULTS.liqHysteresisTicks` — 2 (дефолт програми після #38), якщо там 3.

- [ ] **Step 5: `tests/er/lib/trader.ts`.** Будівники:

```ts
export function initUserAccounts(owner: PublicKey, payer: PublicKey): Record<string, PublicKey> {
  return { owner, payer, config: pdas.config(), userAccount: pdas.userAccount(owner), positions: pdas.positions(owner), systemProgram: SystemProgram.programId };
}

export function delegateUserAccounts(owner: PublicKey, payer: PublicKey): Record<string, PublicKey> {
  const userAccount = pdas.userAccount(owner);
  const positions = pdas.positions(owner);
  const ut = delegationTriple(userAccount, DEXXER_CORE_PROGRAM_ID);
  const pt = delegationTriple(positions, DEXXER_CORE_PROGRAM_ID);
  return {
    owner, payer, config: pdas.config(),
    bufferUserAccount: ut.buffer, delegationRecordUserAccount: ut.record, delegationMetadataUserAccount: ut.metadata, userAccount,
    bufferPositions: pt.buffer, delegationRecordPositions: pt.record, delegationMetadataPositions: pt.metadata, positions,
    ownerProgram: DEXXER_CORE_PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
}

export function permissionAccounts(owner: PublicKey): Record<string, PublicKey> {
  const userAccount = pdas.userAccount(owner);
  const positions = pdas.positions(owner);
  return {
    owner, config: pdas.config(), userAccount, positions,
    userPermission: permissionPdaFromAccount(userAccount), positionsPermission: permissionPdaFromAccount(positions),
    permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID,
  };
}

export function tradeAccounts(
  boot: { config: PublicKey; poolLive: PublicKey },
  t: { userAccount: PublicKey; positions: PublicKey },
  m: { market: PublicKey; marketRisk: PublicKey; feed: PublicKey },
): Record<string, PublicKey> {
  return {
    config: boot.config, market: m.market, marketRisk: m.marketRisk, poolLive: boot.poolLive,
    userAccount: t.userAccount, positions: t.positions, feed: m.feed, feeEscrow: pdas.feeEscrow(),
    // The per-market liquidation task is registered against the trader's Positions.
    taskContext: t.positions, magicProgram: MAGIC_PROGRAM_ID, liqCrankSigner: crankSignerPda(pdas.feeEscrow()),
  };
}

export function undelegateUserAccounts(owner: PublicKey, magicFeeVault: PublicKey): Record<string, PublicKey> {
  const userAccount = pdas.userAccount(owner);
  const positions = pdas.positions(owner);
  return {
    owner, config: pdas.config(), userAccount, positions,
    userPermission: permissionPdaFromAccount(userAccount), positionsPermission: permissionPdaFromAccount(positions),
    ephemeralVault: EPHEMERAL_VAULT_ID, permissionProgram: PERMISSION_PROGRAM_ID,
    feeEscrow: pdas.feeEscrow(), magicFeeVault, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
  };
}

export function closeExitedUserAccounts(closer: PublicKey, owner: PublicKey, rentPayer: PublicKey): Record<string, PublicKey> {
  return { closer, config: pdas.config(), rentPayer, userAccount: pdas.userAccount(owner), positions: pdas.positions(owner) };
}

export async function readPositions(conn: Connection, positions: PublicKey): Promise<Positions> {
  const info = await conn.getAccountInfo(positions, "confirmed");
  if (!info) throw new Error(`Positions ${positions.toBase58()} not found`);
  return decodePositions(info.data);
}
```

(якщо назва акаунта в IDL відрізняється від ключа будівника — тест Step 1 скаже, який ключ виправити; джерело правди — IDL.)

  Решта файлу: `Trader` — `positions` замість `position`/`disclosureQueue`; `onboardTrader` — `initUser(exitSalt).accounts(initUserAccounts(owner, owner))`, `delegateUser().accounts(delegateUserAccounts(owner, owner))`, `waitDelegated(positions)`; `initPermissions(t)` — `permissionAccounts(t.kp.publicKey)`; `openPosition(boot, t, side, size, margin, limit, m = solMarket(boot))`, `closePosition(boot, t, limit, m = solMarket(boot))` — сторона для ліміту береться з `slotFor(await readPositions(...), m.market)`; локальна `solMarket(boot)` повертає `{ market: boot.market, marketRisk: boot.marketRisk, feed: boot.feed }`. Видалити `readPosition`, `readLastClosedRecord`.

- [ ] **Step 6: `add-market` і `package.json`.** `tests/er/devnet/add-market.ts` — дослівно з `git show multi-market-relayer:tests/er/devnet/add-market.ts`; у коментар біля `--schedule` дописати: «since risk #38 a relayer-less liquidation on this market needs this task (or the relayer) to keep sampling prices — spec §2.9». `tests/er/package.json`: додати `"devnet:add-market": "DEXXER_NET=devnet tsx devnet/add-market.ts"`; видалити скрипти видалених файлів (`devnet:disclosure`, `devnet:orphan`, `devnet:reopen`, `devnet:exitdebt` — звірити назви з файлом).

- [ ] **Step 7: скрипти.** Видалити `06-commitment-reveal.ts`, `12-close-orphan.ts`, `14-close-reopen.ts`, `15-exit-debt.ts`. В решті — механічна заміна на будівники й кодек (логіку вимірів не переписувати; що вимірювати на новому деплої — план 4):
  - `q2-permissions.ts`: два permission (`userPermission`, `positionsPermission`) замість трьох; `permissionAccounts`.
  - `01`, `05`, `13`: `initUserAccounts`/`delegateUserAccounts`/`permissionAccounts`/`tradeAccounts`; читання позиції — `readPositions` + `slotFor(p, market)` (`liq_ticks` → `slot.liqTicks`; «ліквідовано» → слот зник і `history.at(-1)?.reason === "liquidated"`).
  - `02-leak-test.ts`: суб'єкт — акаунт `Positions` (ключ із файла прогону — поле `positions`).
  - `03`, `07`, `09`: `.commitAggregate()` без аргументу й без `remainingAccounts`.
  - `08-undelegate.ts`: без дренування черги; `undelegateUser().accounts(undelegateUserAccounts(owner, magicFeeVault)).remainingAccounts(markets)` де `markets` — ключі ринків з історії трейдера плюс SOL (`isWritable: false, isSigner: false`), ≤16; після виходу — два PDA під програмою, у `Positions` байти `[40, 40 + 3072)` нульові.
  - `11-liq-task-migration.ts`: локальну `liqTaskId(position)` замінити імпортом `liqTaskId(positions, market)` з `lib/positions.js`; видалити частини про сирітську чергу (`closeOrphanQueue`, `commitAggregate(4).remainingAccounts([dq])`, знімки `disclosureQueue`); лишити «cancel невідомого task_id» і «open реєструє задачу».
  - `scripts/demo/week1-cli.ts`: `readLastClosedRecord`/`readPosition` → `readPositions`; «позиція порожня» → `slotFor(p, boot.market) === null`; причина — `p.history.at(-1)?.reason === "liquidated"`; PnL — `p.history.at(-1)?.pnl`. `parseTickLine` уже розбирає довільні `key=value`, тож нове поле `market=` йому не заважає.
  - `tests/er/README.md`: рядок про `UserAccount/Position/DisclosureQueue` → `UserAccount/Positions`; додати рядок про `devnet:add-market`.

- [ ] **Step 8: PASS**

```bash
cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/ixAccounts.test.ts test/marketParams.test.ts test/positionsCodec.test.ts test/symbol.test.ts
cd ../../tests/er && npx tsc --noEmit && npm run selftest:hashes
cd ../../scripts && npm ci && npx tsc --noEmit
grep -rnE "disclosureQueue|pdas\.position\(|commitmentHash|setDisclosureDelay|closeOrphanQueue|initUserReuseQueue|commitAggregate\([0-9]" tests/er scripts --include=*.ts -l
```

Expected: 16 тестів зелені (5 + 2 + 5 + 4); `tsc` у `tests/er` і `scripts` чистий; `grep` нічого не знаходить.

- [ ] **Step 9: commit**

```bash
git add tests/er scripts/demo/week1-cli.ts services/relayer/test/ixAccounts.test.ts services/relayer/test/marketParams.test.ts
git commit -m "feat(lib): admin/trader helpers and scripts on position slots; add-market"
```

(`git status --short` перед комітом — лише `tests/er/**`, `scripts/demo/week1-cli.ts` і два тести.)

---

### Task 4: relayer — реєстр ринків, індексер по ринках, без розкриття

**Files:**
- Create: `services/relayer/src/env.ts`, `services/relayer/src/markets.ts`, `services/relayer/migrations/008_ticks_market.sql`
- Modify: `services/relayer/src/health.ts`, `services/relayer/src/indexer/{accounts.ts,http.ts,query.ts,store.ts}`
- Test (перенести): `services/relayer/test/{env,markets,wsFilter,wsHeartbeat}.test.ts`; (змінити) `test/{health,indexerQuery,indexerDb}.test.ts`

**Interfaces:**
- Consumes: `MARKET_DISC`, `pdas.marketRisk`, `symbolString` (Task 2).
- Produces (дослівно з гілки, сигнатури не міняти — їх споживає Task 6):
  - `src/env.ts`: `envNum(name: string, def: number, min?: number): number`.
  - `src/markets.ts`: `MARKETS_REFRESH_MS`, `MarketInfo { symbol, market, marketRisk, feed, params }`, `marketInfoFrom(pubkey, m)`, `sortMarkets(list)`, `MarketRegistry { list(): MarketInfo[]; refresh(): Promise<void>; start(): void; stop(): void }`, `createMarketRegistry({ load, refreshMs?, log? })`, `keepPrivateMarkets(markets, permissionOwners)`, `loadMarketsFromEr(erRpc, readOwners)`.
  - `src/health.ts`: `MarketsHealth`, `buildMarketsHealth(...)`, поле `markets` у payload, `HealthDeps.getMarketsHealth`; **без** `commitMaxActions` і `indexer.disclosures`; `commitIntervalTicks` → `commitIntervalMs: number`.
  - індексер: `insertTick/listTicks/latestTick` з `market`; `parseMarketParam`; `GET /markets`; `?market=` на `/mark` і `/prices`; `wsFilterFrom`, `wsWants`, `attachWs(server, { heartbeatMs? })`; `IndexerDeps.markets`, `IndexerStats.feeds`; **без** `/disclosures`, `/stats`, WS-кадру `disclosure`, `IndexerStats.disclosures`.

- [ ] **Step 1: перенести тести (RED).** Дослівно з гілки (`git show multi-market-relayer:services/relayer/test/<file>`): `env.test.ts` (1), `markets.test.ts` (6), `wsFilter.test.ts` (3), `wsHeartbeat.test.ts` (1). У `wsFilter.test.ts` прибрати згадку кадру `disclosure` (лишається: `pool` іде всім). `health.test.ts`, `indexerQuery.test.ts`, `indexerDb.test.ts` — взяти версії з гілки і з них прибрати все про розкриття:
  - `health.test.ts`: видалити тести/асерти `commitMaxActions`; `commitIntervalTicks` → `commitIntervalMs`; у літералах `IndexerSnapshot` нема `disclosures`.
  - `indexerQuery.test.ts`: видалити тести `parseDisclosureQuery`, `disclosureCursor`, `parseStatsQuery`; лишити pool-history і `parseMarketParam`.
  - `indexerDb.test.ts`: видалити тести `insertDisclosure`/`listDisclosures`/`disclosureStats`/HTTP `/disclosures`/`/stats`; `TRUNCATE` — лише `pool_snapshots, ticks`; лишити pool-history і 4 тести ринків.

  Додати в `markets.test.ts` або `indexerDb.test.ts` (не потребує БД — роутер з порожнім пулом допустимий, як у наявному тесті `GET /markets`) один тест:

```ts
test("the disclosure endpoints are gone", async () => {
  await withRouter(async (base) => {   // the same helper the GET /markets test in this file uses
    for (const path of ["/disclosures", "/stats"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, path);
    }
  });
});
```

  (назву хелпера взяти з файлу; якщо там інлайновий запуск сервера — повторити той самий спосіб.)

- [ ] **Step 2: FAIL** — `DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/env.test.ts test/markets.test.ts test/wsFilter.test.ts test/wsHeartbeat.test.ts test/health.test.ts test/indexerQuery.test.ts`.

- [ ] **Step 3: перенести джерела.** Дослівно: `src/env.ts`, `src/markets.ts`, `migrations/008_ticks_market.sql`. У коментарі `markets.ts` слова «listed, provisioned and ticked» → «listed and ticked» (роздачі позицій більше нема). `src/health.ts`, `src/indexer/{accounts,http,query,store}.ts` — застосувати зміни гілки (`git diff 9904b98..multi-market-relayer -- services/relayer/src/health.ts services/relayer/src/indexer`).

- [ ] **Step 4: прибрати розкриття з індексера й health.**
  - `indexer/accounts.ts`: видалити секцію «Disclosure» (`DISCLOSURE_POLL_MS`, `pollDisclosures`, `onProgramAccountChange` по `DISCLOSURE_DISC`, `sideToString`/`reasonToString`, кадр `disclosure`), імпорти `DISCLOSURE_DISC`, `insertDisclosure`, `DisclosureRow`; `WsMessage.type` — `"mark" | "pool"`; `IndexerStats` без `disclosures`. Оракул, `Pool`, `BalancesRoot` — без змін.
  - `indexer/store.ts`: видалити `DisclosureRow`, `insertDisclosure`, `disclosureRowToJson`, `listDisclosures`, `DisclosureStats`, `disclosureStats`.
  - `indexer/query.ts`: видалити `DisclosureCursor`, `DisclosureQuery`, `STATS_WINDOWS`, `StatsQuery`, `parseDisclosureQuery`, `disclosureCursor`, `parseStatsQuery`.
  - `indexer/http.ts`: видалити маршрути `GET /disclosures`, `GET /stats` та їхні імпорти.
  - `health.ts`: `IndexerSnapshot`/`EMPTY_INDEXER_SNAPSHOT` без `disclosures`; `commitMaxActions` — видалити з `HealthPayload`, `buildHealthPayload`, `HealthDeps`; `commitIntervalTicks` → `commitIntervalMs` (дефолт `300_000`).
  - Міграції `001`/`007` НЕ чіпати і таблицю `disclosures` НЕ видаляти: на живій БД вона лишається невживаною (рішення про її видалення — при деплої, план 4).

- [ ] **Step 5: PASS** — команда зі Step 2 зелена. З Postgres (якщо є Docker): `TEST_DATABASE_URL=… node --import tsx --test test/indexerDb.test.ts`. `npx tsc --noEmit` у `services/relayer` ще червоний через `crank.ts`/`disclosure.ts`/`orphan.ts`/`index.ts`/`sponsor.ts` (Tasks 5–6) — записати, які саме файли.

- [ ] **Step 6: commit**

```bash
git add services/relayer/src/env.ts services/relayer/src/markets.ts services/relayer/migrations/008_ticks_market.sql services/relayer/src/health.ts services/relayer/src/indexer services/relayer/test/env.test.ts services/relayer/test/markets.test.ts services/relayer/test/wsFilter.test.ts services/relayer/test/wsHeartbeat.test.ts services/relayer/test/health.test.ts services/relayer/test/indexerQuery.test.ts services/relayer/test/indexerDb.test.ts
git commit -m "feat(relayer): market registry and per-market indexer; disclosure feed removed"
```

---

### Task 5: relayer — janitor і sponsor-whitelist

**Files:**
- Create: `services/relayer/src/janitor.ts`, `services/relayer/test/janitor.test.ts`
- Delete: `services/relayer/src/orphan.ts`, `services/relayer/test/orphan.test.ts`
- Modify: `services/relayer/src/sponsor.ts`, `services/relayer/test/sponsor.test.ts`

**Interfaces:**
- Consumes: `closeExitedUserAccounts`, `initUserAccounts`, `delegateUserAccounts` (Task 3), `USER_DISC`, `pdas`.
- Produces (`src/janitor.ts`):

```ts
export const JANITOR_MAX_CLOSES_PER_CYCLE = 8;
export interface ExitedOwner { owner: PublicKey; rentPayer: PublicKey }
export interface JanitorDeps {
  listExitedOwners: () => Promise<ExitedOwner[]>;
  bothUnderProgram: (owner: PublicKey) => Promise<boolean>;
  closeExitedUser: (o: ExitedOwner) => Promise<string>;
  log?: (line: string) => void;
}
export interface JanitorResult { scanned: number; closed: string[]; skipped: number; errors: string[] }
export async function runJanitorCycle(deps: JanitorDeps, maxCloses?: number): Promise<JanitorResult>;
export function janitorDeps(w: { baseConn: Connection; baseProg: Program; feePayer: Keypair }): JanitorDeps;
```

- [ ] **Step 1: падаючі тести janitor-а** (`test/janitor.test.ts`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { JANITOR_MAX_CLOSES_PER_CYCLE, runJanitorCycle, type ExitedOwner, type JanitorDeps } from "../src/janitor.js";

const k = () => Keypair.generate().publicKey;
function fakes(owners: ExitedOwner[], home: Set<string>, failing = new Set<string>()) {
  const closed: ExitedOwner[] = [];
  const deps: JanitorDeps = {
    listExitedOwners: async () => owners,
    bothUnderProgram: async (o: PublicKey) => home.has(o.toBase58()),
    closeExitedUser: async (o) => {
      if (failing.has(o.owner.toBase58())) throw new Error("boom");
      closed.push(o);
      return `sig-${o.owner.toBase58().slice(0, 4)}`;
    },
    log: () => {},
  };
  return { deps, closed };
}

test("closes an exited owner whose two accounts are back under the program, rent to the recorded payer", async () => {
  const o = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([o], new Set([o.owner.toBase58()]));
  const r = await runJanitorCycle(deps);
  assert.deepEqual(r, { scanned: 1, closed: [o.owner.toBase58()], skipped: 0, errors: [] });
  assert.equal(closed[0].rentPayer.toBase58(), o.rentPayer.toBase58());
});

test("an owner whose accounts are still delegated is skipped, not closed", async () => {
  const o = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([o], new Set());
  const r = await runJanitorCycle(deps);
  assert.equal(closed.length, 0);
  assert.deepEqual([r.scanned, r.skipped, r.closed.length], [1, 1, 0]);
});

test("one failing close does not stop the others", async () => {
  const a = { owner: k(), rentPayer: k() };
  const b = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([a, b], new Set([a.owner.toBase58(), b.owner.toBase58()]), new Set([a.owner.toBase58()]));
  const r = await runJanitorCycle(deps);
  assert.deepEqual(closed.map((c) => c.owner.toBase58()), [b.owner.toBase58()]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /boom/);
});

test("at most JANITOR_MAX_CLOSES_PER_CYCLE closes per cycle", async () => {
  const owners = Array.from({ length: JANITOR_MAX_CLOSES_PER_CYCLE + 3 }, () => ({ owner: k(), rentPayer: k() }));
  const { deps, closed } = fakes(owners, new Set(owners.map((o) => o.owner.toBase58())));
  const r = await runJanitorCycle(deps);
  assert.equal(closed.length, JANITOR_MAX_CLOSES_PER_CYCLE);
  assert.equal(r.scanned, owners.length);
});

test("a failing scan yields an error result, never a throw", async () => {
  const { deps } = fakes([], new Set());
  deps.listExitedOwners = async () => {
    throw new Error("rpc down");
  };
  const r = await runJanitorCycle(deps);
  assert.deepEqual([r.scanned, r.closed.length], [0, 0]);
  assert.match(r.errors[0], /rpc down/);
});
```

- [ ] **Step 2: FAIL** — `node --import tsx --test test/janitor.test.ts` (модуля нема).

- [ ] **Step 3: `src/janitor.ts`**

```ts
// services/relayer/src/janitor.ts
//
// Closes the two L1 accounts (`UserAccount`, `Positions`) of owners who have
// left the rollup (spec §2.9.2). There is no partial exit any more:
// `undelegate_user` requires zero margin and no open slot, scrubs the history
// ring and sends both accounts home, so one base-layer pass is the whole job.
//
// The rent goes to `UserAccount.rent_payer` — whoever funded the onboarding
// (risk #39): this service when it sponsored it, the owner when they paid
// themselves. The owner may also close on their own; this pass just does not
// make them.
//
// Reads here are base-layer reads of accounts that are back under the program
// — public by then (exit scrubbed every private byte).
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { USER_DISC, pdas } from "../../../tests/er/lib/program.js";
import { sendAndConfirmIx } from "../../../tests/er/lib/env.js";
import { closeExitedUserAccounts } from "../../../tests/er/lib/trader.js";

/** Bounds what one cycle can spend in fees if many owners leave at once. */
export const JANITOR_MAX_CLOSES_PER_CYCLE = 8;

export interface ExitedOwner {
  owner: PublicKey;
  rentPayer: PublicKey;
}
export interface JanitorDeps {
  listExitedOwners: () => Promise<ExitedOwner[]>;
  /** Both accounts exist and are owned by the program again (not by the Delegation Program). */
  bothUnderProgram: (owner: PublicKey) => Promise<boolean>;
  closeExitedUser: (o: ExitedOwner) => Promise<string>;
  log?: (line: string) => void;
}
export interface JanitorResult {
  scanned: number;
  closed: string[];
  skipped: number;
  errors: string[];
}

export async function runJanitorCycle(deps: JanitorDeps, maxCloses = JANITOR_MAX_CLOSES_PER_CYCLE): Promise<JanitorResult> {
  const out: JanitorResult = { scanned: 0, closed: [], skipped: 0, errors: [] };
  const log = deps.log ?? console.log;
  let owners: ExitedOwner[];
  try {
    owners = await deps.listExitedOwners();
  } catch (e) {
    out.errors.push(`janitor scan: ${String(e instanceof Error ? e.message : e)}`);
    return out;
  }
  out.scanned = owners.length;
  for (const o of owners) {
    if (out.closed.length >= maxCloses) break;
    try {
      if (!(await deps.bothUnderProgram(o.owner))) {
        out.skipped += 1;
        continue;
      }
      const sig = await deps.closeExitedUser(o);
      out.closed.push(o.owner.toBase58());
      log(`janitor: closed ${o.owner.toBase58()} rent_payer=${o.rentPayer.toBase58()} sig=${sig}`);
    } catch (e) {
      out.errors.push(`janitor ${o.owner.toBase58()}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
  return out;
}

export function janitorDeps(w: { baseConn: Connection; baseProg: Program; feePayer: Keypair }): JanitorDeps {
  const programId = w.baseProg.programId;
  return {
    async listExitedOwners() {
      const rows = await w.baseConn.getProgramAccounts(programId, { filters: [{ memcmp: { offset: 0, bytes: USER_DISC } }] });
      const out: ExitedOwner[] = [];
      for (const r of rows) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ua = w.baseProg.coder.accounts.decode("userAccount", r.account.data) as any;
          if (ua.exited) out.push({ owner: new PublicKey(ua.owner), rentPayer: new PublicKey(ua.rentPayer) });
        } catch {
          // Not this layout — not ours to close.
        }
      }
      return out;
    },
    async bothUnderProgram(owner) {
      const infos = await w.baseConn.getMultipleAccountsInfo([pdas.userAccount(owner), pdas.positions(owner)], "confirmed");
      return infos.every((i) => i !== null && i.owner.equals(programId));
    },
    async closeExitedUser(o) {
      const ix = await w.baseProg.methods
        .closeExitedUser()
        .accounts(closeExitedUserAccounts(w.feePayer.publicKey, o.owner, o.rentPayer))
        .instruction();
      return sendAndConfirmIx(w.baseConn, w.feePayer, ix);
    },
  };
}
```

(`getProgramAccounts` на базі повертає лише акаунти під програмою — делегований `UserAccount` має власника Delegation Program і сюди не потрапляє; `bothUnderProgram` додатково перевіряє `Positions`.)

  Видалити `src/orphan.ts` і `test/orphan.test.ts`.

- [ ] **Step 4: sponsor.** `src/sponsor.ts`: з `CORE_WHITELIST` і `CORE_SHAPES` прибрати `init_user_reuse_queue`; оновити коментарі, що перелічують whitelist (лишаються `faucet_init`, `init_user`, `delegate_user`, `faucet_mint` — усі `{ownerIdx: 0, payerIdx: 1}`, `faucet_mint` — `{ownerIdx: 0}`; індекси не змінюються). `test/sponsor.test.ts`: `buildInitUserTx` — `.initUser(exitSalt).accounts(initUserAccounts(owner, payer))`; `buildDelegateUserIx` — `.delegateUser().accounts(delegateUserAccounts(owner, payer))`; видалити `buildInitUserReuseQueueIx` і тест «accepts init_user_reuse_queue»; додати:

```ts
test("rejects init_user whose payer slot is not the fee payer", async () => {
  const stranger = Keypair.generate();
  const tx = await buildInitUserTx({ owner: owner.publicKey, payer: stranger.publicKey });   // same builder/arguments the accepting test above uses
  const r = checkWhitelist(tx, feePayer.publicKey);                                          // same call the accepting test makes
  assert.equal(r.ok, false);
});
```

  (імена хелпера, аргументів і форми результату взяти з сусіднього тесту «accepts init_user» у цьому файлі; якщо такий негативний тест для `init_user` уже є — не дублювати, а переконатися, що він зелений на нових акаунтах, і записати це у звіт.)

- [ ] **Step 5: PASS** — `DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/janitor.test.ts test/sponsor.test.ts` зелені.

- [ ] **Step 6: commit**

```bash
git add services/relayer/src/janitor.ts services/relayer/test/janitor.test.ts services/relayer/src/sponsor.ts services/relayer/test/sponsor.test.ts
git rm -q services/relayer/src/orphan.ts services/relayer/test/orphan.test.ts
git commit -m "feat(relayer): janitor closes exited owners (rent to its payer); sponsor whitelist without reuse-queue"
```

---

### Task 6: relayer — crank по ринках на слотах, коміт за годинником, wiring

**Files:**
- Create: `services/relayer/src/candidates.ts`, `services/relayer/src/commit.ts`
- Delete: `services/relayer/src/disclosure.ts`, `services/relayer/test/disclosure.test.ts`
- Modify: `services/relayer/src/crank.ts`, `services/relayer/src/index.ts`, `services/relayer/src/shutdown.ts` (коментар)
- Test: `services/relayer/test/candidates.test.ts`, `services/relayer/test/commit.test.ts` (нові), `services/relayer/test/crankMarkets.test.ts` (перенести й доповнити)

**Interfaces:**
- Consumes: Task 2 (`decodePositions`, `slotFor`, `POSITIONS_DISC`), Task 4 (`MarketInfo`, `MarketRegistry`, `marketInfoFrom`, `envNum`, `buildMarketsHealth`), Task 5 (`runJanitorCycle`, `janitorDeps`).
- Produces:

```ts
// src/candidates.ts
export const CRANK_TX_MAX_CANDIDATES: number;   // measured in Step 1, ≤ 16
export interface Candidate { positions: PublicKey; owner: PublicKey; market: string }   // market = base58
export function candidatesFrom(rows: { pubkey: PublicKey; data: Buffer }[], onSkip?: (pubkey: PublicKey, reason: string) => void): Candidate[];
export function pairAccounts(chunk: Candidate[], userAccountOf: (owner: PublicKey) => PublicKey): AccountMeta[];
export function chunkCandidates(open: Candidate[], size?: number): Candidate[][];       // always ≥ 1 chunk
export function liquidatedIn(chunk: Candidate[], after: (Buffer | null)[]): string[];   // positions keys whose slot on the chunk's market is gone

// src/commit.ts
export const COMMIT_INTERVAL_MS: number;        // envNum("COMMIT_INTERVAL_MS", 300_000, 10_000)
export function commitDue(lastAttemptAt: number | null, now: number, intervalMs: number): boolean;
export interface CommitCtx { conn: Connection; prog: Program; crank: Keypair; feePayerConn: Connection; feePayerProg: Program; feePayer: Keypair; pool: PublicKey; poolLive: PublicKey; balancesRoot: PublicKey; feeEscrow: PublicKey }
export async function runRootCycle(ctx: CommitCtx): Promise<void>;
export async function runCommitCycle(ctx: CommitCtx): Promise<string>;
export async function runIsolated(steps: [name: string, run: () => Promise<void>][], onError: (name: string, e: unknown) => void): Promise<string[]>;   // names that succeeded

// src/crank.ts
export interface RelayerState { lastTickAt: number | null; lastCommitAt: number | null; tick: number; errors: string[]; marketTicks: Record<string, number> }
export function withSol(list: MarketInfo[], sol: () => MarketInfo): MarketInfo[];
export function untickedMarkets(byMarket: Map<string, unknown[]>, ticked: MarketInfo[]): string[];
export { runMarkets, groupOpenByMarket, shouldRecordError, type RunMarketsResult };   // as on the branch
export async function startCrank(cfg: RelayerConfig, state: RelayerState, registry: MarketRegistry): Promise<void>;
```

- [ ] **Step 1: падаючі тести відбору кандидатів** (`test/candidates.test.ts`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { POSITIONS_DISC_BYTES, pdas } from "../../../tests/er/lib/program.js";
import { POSITIONS_SIZE } from "../../../tests/er/lib/positions.js";
import { CRANK_TX_MAX_CANDIDATES, candidatesFrom, chunkCandidates, liquidatedIn, pairAccounts, type Candidate } from "../src/candidates.js";

const k = () => Keypair.generate().publicKey;
function positionsBytes(owner: PublicKey, open: PublicKey[]): Buffer {
  const b = Buffer.alloc(POSITIONS_SIZE);
  POSITIONS_DISC_BYTES.copy(b, 0);
  owner.toBuffer().copy(b, 8);
  open.forEach((m, i) => {
    const at = 8 + 32 + i * 96;
    m.toBuffer().copy(b, at);
    b.writeUInt8(1, at + 88);
  });
  return b;
}

test("one Positions account yields one candidate per open slot, keyed by market", () => {
  const owner = k();
  const sol = k();
  const btc = k();
  const key = k();
  const c = candidatesFrom([{ pubkey: key, data: positionsBytes(owner, [sol, btc]) }]);
  assert.deepEqual(c.map((x) => x.market).sort(), [sol.toBase58(), btc.toBase58()].sort());
  assert.ok(c.every((x) => x.positions.equals(key) && x.owner.equals(owner)));
});

test("an account with no open slot yields nothing", () => {
  assert.deepEqual(candidatesFrom([{ pubkey: k(), data: positionsBytes(k(), []) }]), []);
});

test("garbage among the accounts is skipped and reported, the rest survive", () => {
  const good = k();
  const short = k();
  const foreign = k();
  const bad = positionsBytes(k(), [k()]);
  bad.writeUInt8(bad[0] ^ 0xff, 0);
  const skipped: string[] = [];
  const c = candidatesFrom(
    [
      { pubkey: short, data: Buffer.alloc(100) },
      { pubkey: good, data: positionsBytes(k(), [k()]) },
      { pubkey: foreign, data: bad },
    ],
    (p) => skipped.push(p.toBase58()),
  );
  assert.deepEqual(c.map((x) => x.positions.toBase58()), [good.toBase58()]);
  assert.deepEqual(skipped.sort(), [short.toBase58(), foreign.toBase58()].sort());
});

test("pairAccounts emits [Positions, UserAccount] per candidate, both writable", () => {
  const a: Candidate = { positions: k(), owner: k(), market: k().toBase58() };
  const metas = pairAccounts([a], (o) => pdas.userAccount(o));
  assert.deepEqual(metas.map((m) => m.pubkey.toBase58()), [a.positions.toBase58(), pdas.userAccount(a.owner).toBase58()]);
  assert.ok(metas.every((m) => m.isWritable && !m.isSigner));
});

test("chunkCandidates: at least one chunk, none above the limit, none lost, no pair twice in a chunk", () => {
  assert.deepEqual(chunkCandidates([]), [[]]);
  const many = Array.from({ length: CRANK_TX_MAX_CANDIDATES * 2 + 1 }, () => ({ positions: k(), owner: k(), market: "m" }));
  const chunks = chunkCandidates(many);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.length <= CRANK_TX_MAX_CANDIDATES));
  assert.equal(chunks.flat().length, many.length);
  for (const c of chunks) assert.equal(new Set(c.map((x) => x.positions.toBase58())).size, c.length);
});

test("liquidatedIn reports a candidate whose slot on the market is gone", () => {
  const market = k();
  const owner = k();
  const c: Candidate = { positions: k(), owner, market: market.toBase58() };
  assert.deepEqual(liquidatedIn([c], [positionsBytes(owner, [market])]), []);
  assert.deepEqual(liquidatedIn([c], [positionsBytes(owner, [k()])]), [c.positions.toBase58()], "open elsewhere only");
  assert.deepEqual(liquidatedIn([c], [null]), [], "an unreadable account is not reported as liquidated");
});

test("a full chunk fits a transaction and one more candidate does not", () => {
  const size = (n: number): number => {
    const keys = [k(), k(), k(), k(), k(), k()].map((pubkey, i) => ({ pubkey, isWritable: i > 1, isSigner: i === 0 }));
    const rem = pairAccounts(Array.from({ length: n }, () => ({ positions: k(), owner: k(), market: "m" })), () => k());
    const ix = new TransactionInstruction({ programId: k(), keys: [...keys, ...rem], data: Buffer.alloc(8) });
    const tx = new Transaction({ feePayer: keys[0].pubkey, recentBlockhash: "11111111111111111111111111111111" })
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(ix);
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  };
  assert.ok(CRANK_TX_MAX_CANDIDATES <= 16, "program cap");
  assert.ok(size(CRANK_TX_MAX_CANDIDATES) <= 1232, `full chunk is ${size(CRANK_TX_MAX_CANDIDATES)} B`);
  if (CRANK_TX_MAX_CANDIDATES < 16) assert.ok(size(CRANK_TX_MAX_CANDIDATES + 1) > 1232, "the limit is the largest that fits");
});
```

(шість фіксованих акаунтів — `crank, config, market, market_risk, pool_live, feed`, перший — підписант і платник.)

- [ ] **Step 2: тести коміту й ринків.** `test/commit.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitDue, runIsolated } from "../src/commit.js";

test("commitDue: first attempt at once, then once per interval of wall-clock time", () => {
  assert.equal(commitDue(null, 1_000, 300_000), true);
  assert.equal(commitDue(1_000, 1_000 + 299_999, 300_000), false);
  assert.equal(commitDue(1_000, 1_000 + 300_000, 300_000), true);
});

test("runIsolated: a failing step is reported and the later steps still run", async () => {
  const ran: string[] = [];
  const failed: string[] = [];
  const ok = await runIsolated(
    [
      ["root", async () => { throw new Error("root down"); }],
      ["commit", async () => { ran.push("commit"); }],
      ["janitor", async () => { ran.push("janitor"); }],
    ],
    (name, e) => failed.push(`${name}: ${String(e instanceof Error ? e.message : e)}`),
  );
  assert.deepEqual(ran, ["commit", "janitor"]);
  assert.deepEqual(failed, ["root: root down"]);
  assert.deepEqual(ok, ["commit", "janitor"]);
});
```

`test/crankMarkets.test.ts` — взяти з гілки (`git show multi-market-relayer:services/relayer/test/crankMarkets.test.ts`, 7 тестів), замінити тест `marketsOrSolFallback` на:

```ts
test("withSol: SOL is always ticked — empty list, list without SOL, list with SOL", () => {
  const sol = mi("SOL");
  const btc = mi("BTC");
  assert.deepEqual(withSol([], () => sol).map((m) => m.symbol), ["SOL"]);
  assert.deepEqual(withSol([btc], () => sol).map((m) => m.symbol), ["SOL", "BTC"]);
  const listed = mi("SOL");
  assert.equal(withSol([listed, btc], () => sol)[0], listed, "the registry's own SOL entry wins");
});

test("untickedMarkets names markets that have open positions but are not ticked", () => {
  const btc = mi("BTC");
  const stray = Keypair.generate().publicKey.toBase58();
  const byMarket = new Map<string, unknown[]>([[btc.market.toBase58(), [1]], [stray, [1]]]);
  assert.deepEqual(untickedMarkets(byMarket, [btc]), [stray]);
  assert.deepEqual(untickedMarkets(new Map(), [btc]), []);
});
```

(`mi(symbol)` — хелпер побудови `MarketInfo`, який уже є в цьому тесті на гілці; імпорти доповнити `withSol`, `untickedMarkets`, `Keypair`.)

- [ ] **Step 3: FAIL** — `node --import tsx --test test/candidates.test.ts test/commit.test.ts test/crankMarkets.test.ts`.

- [ ] **Step 4: `src/candidates.ts`**

```ts
// services/relayer/src/candidates.ts
//
// Liquidation candidates (spec §2.9.2): a trader's positions on every market
// live in ONE `Positions` account, so the crank reads those accounts (it is a
// permission member of each) and turns every OPEN slot into a candidate for
// that slot's market. `crank_tick` takes them as pairs
// `[Positions, UserAccount]`.
import { AccountMeta, PublicKey } from "@solana/web3.js";
import { decodePositions, slotFor } from "../../../tests/er/lib/positions.js";

// Pairs: 2 keys per candidate. The largest count whose transaction (6 fixed
// accounts + ComputeBudget) stays within 1232 B — pinned by
// test/candidates.test.ts; the program's own cap is 16.
export const CRANK_TX_MAX_CANDIDATES = 12;

export interface Candidate {
  positions: PublicKey;
  owner: PublicKey;
  /** The slot's market, base58 — the grouping key. */
  market: string;
}

/**
 * An account that does not decode as `Positions` is dropped here: handed to
 * `crank_tick` it would abort the whole batch (Anchor 3002), and no candidate
 * in it would be liquidated.
 */
export function candidatesFrom(rows: { pubkey: PublicKey; data: Buffer }[], onSkip?: (pubkey: PublicKey, reason: string) => void): Candidate[] {
  const out: Candidate[] = [];
  for (const r of rows) {
    try {
      const p = decodePositions(r.data);
      for (const s of p.slots) out.push({ positions: r.pubkey, owner: p.owner, market: s.market.toBase58() });
    } catch (e) {
      onSkip?.(r.pubkey, String(e instanceof Error ? e.message : e));
    }
  }
  return out;
}

export function pairAccounts(chunk: Candidate[], userAccountOf: (owner: PublicKey) => PublicKey): AccountMeta[] {
  return chunk.flatMap((c) => [
    { pubkey: c.positions, isWritable: true, isSigner: false },
    { pubkey: userAccountOf(c.owner), isWritable: true, isSigner: false },
  ]);
}

/** At least one (possibly empty) chunk: a market with no open position still needs its mark and price sample advanced. */
export function chunkCandidates(open: Candidate[], size = CRANK_TX_MAX_CANDIDATES): Candidate[][] {
  const out: Candidate[][] = [];
  for (let i = 0; i < Math.max(1, open.length); i += size) out.push(open.slice(i, i + size));
  return out;
}

/** `after[i]` = the candidate's `Positions` bytes read after the tick (null if unreadable). */
export function liquidatedIn(chunk: Candidate[], after: (Buffer | null)[]): string[] {
  const out: string[] = [];
  chunk.forEach((c, i) => {
    const data = after[i];
    if (!data) return;
    try {
      if (slotFor(decodePositions(data), new PublicKey(c.market)) === null) out.push(c.positions.toBase58());
    } catch {
      // Unreadable now — say nothing rather than claim a liquidation.
    }
  });
  return out;
}
```

Якщо тест розміру показує, що 12 не влазить або влазить і 13 — виставити константу за фактом (найбільше, що влазить, ≤16) і записати виміряні байти у звіт.

- [ ] **Step 5: `src/commit.ts`.** Перенести `runRootCycle` дослівно з `src/disclosure.ts` (рядки 405–452 на `main`: gPA по `USER_DISC`, фільтр за довжиною `coder.accounts.size("userAccount")`, батчі `ROOT_BATCH`, `setBalancesRoot(begin, finalize, paddingSeed)`), замінивши тип контексту на `CommitCtx`. Додати:

```ts
// Min 10 s: a NaN/0 would commit on every loop — commits are billed (spec §2.2) and must stay a fixed-interval batch.
export const COMMIT_INTERVAL_MS = envNum("COMMIT_INTERVAL_MS", 300_000, 10_000);

/** Wall-clock, not a tick count: with several markets one loop takes seconds, and a tick count would stretch the interval with the market count. */
export function commitDue(lastAttemptAt: number | null, now: number, intervalMs: number): boolean {
  return lastAttemptAt === null || now - lastAttemptAt >= intervalMs;
}

/** `commit_aggregate()` — the fixed-interval commit of the coarse `Pool` snapshot and `BalancesRoot`. No arguments, no remaining accounts: nothing else ever leaves the rollup (spec §2.9.2). */
export async function runCommitCycle(ctx: CommitCtx): Promise<string> {
  const config = await accountNs(ctx.feePayerProg).config.fetch(pdas.config());
  const ix = await ctx.feePayerProg.methods
    .commitAggregate()
    .accounts({
      config: pdas.config(), payer: ctx.feePayer.publicKey, pool: ctx.pool, poolLive: ctx.poolLive,
      balancesRoot: ctx.balancesRoot, feeEscrow: ctx.feeEscrow, magicFeeVault: config.magicFeeVault,
      magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();
  return sendAndConfirmIx(ctx.feePayerConn, ctx.feePayer, ix);
}
```

```ts
/** The cycle's steps each stand alone: a failed root cycle must not skip the commit, and none of them may stop the crank's ticks. */
export async function runIsolated(steps: [name: string, run: () => Promise<void>][], onError: (name: string, e: unknown) => void): Promise<string[]> {
  const ok: string[] = [];
  for (const [name, run] of steps) {
    try {
      await run();
      ok.push(name);
    } catch (e) {
      onError(name, e);
    }
  }
  return ok;
}
```

Видалити `src/disclosure.ts` і `test/disclosure.test.ts`.

- [ ] **Step 6: `src/crank.ts`.** Основа — версія з гілки (`git show multi-market-relayer:services/relayer/src/crank.ts`): `RelayerState` з `marketTicks`, `runMarkets`, `groupOpenByMarket`, `shouldRecordError`, `onMarketError`, петля з одним `reconnect()` на тік, `lastTickAt` лише за SOL. Зміни проти неї:
  1. Імпорти: прибрати `POSITION_DISC`, `./disclosure.js`, `./orphan.js`, `./positions.js`; додати `POSITIONS_DISC`, `./candidates.js`, `./commit.js`, `./janitor.js`.
  2. `openCandidates(n)`:

```ts
  /** ONE `getProgramAccounts` per tick for every market's candidates. The crank's own TEE token reads these private accounts — it is a permission member of each. */
  async function openCandidates(n: number): Promise<Candidate[]> {
    const rows = await conn.getProgramAccounts(prog.programId, { filters: [{ memcmp: { offset: 0, bytes: POSITIONS_DISC } }] });
    const found = candidatesFrom(
      rows.map((r) => ({ pubkey: r.pubkey, data: r.account.data })),
      (pubkey, reason) => console.error(`tick n=${n}: skipping ${pubkey.toBase58()} — not a Positions account (${reason})`),
    );
    // A pair whose UserAccount does not decode is skipped by the program, but
    // dropping it here keeps the chunk's room for real candidates.
    const owners = [...new Map(found.map((c) => [c.owner.toBase58(), c.owner])).values()];
    const infos = owners.length > 0 ? await conn.getMultipleAccountsInfo(owners.map((o) => pdas.userAccount(o)), "confirmed") : [];
    const ok = new Set<string>();
    owners.forEach((o, i) => {
      const info = infos[i];
      if (!info) return;
      try {
        prog.coder.accounts.decode("userAccount", info.data);
        ok.add(o.toBase58());
      } catch (e) {
        console.error(`tick n=${n}: skipping owner ${o.toBase58()} — UserAccount failed to decode: ${String(e)}`);
      }
    });
    return found.filter((c) => ok.has(c.owner.toBase58()));
  }
```

  3. `tickMarket(m, ctx, open, n)`: `for (const chunk of chunkCandidates(open))`; `remaining = pairAccounts(chunk, (o) => pdas.userAccount(o))`; транзакція й підтвердження — як на гілці (`ComputeBudget 1_400_000`, `freshBlockhash`, `skipPreflight`, `confirmSignature`); після тіку — `const after = chunk.length > 0 ? await conn.getMultipleAccountsInfo(chunk.map((c) => c.positions), "confirmed") : [];` і `liquidated.push(...liquidatedIn(chunk, after.map((a) => a?.data ?? null)))`; рядок логу — як на гілці (`tick n=… market=… slot=… mark=… mark_slot=… sig=… cu=… tick_ms=… candidates=… liquidated=[…]`). Коментар про CU замінити на факт плану 1: 16 кандидатів у LiteSVM — 142k–172k без ліквідацій і 162k–192k з 16 ліквідаціями (залежить від bump-ів PDA), тому ліміт піднято явно.
  4. `marketsOrSolFallback` → `withSol` і `untickedMarkets`:

```ts
/** SOL is ticked whatever the registry says: an empty list (first read not done yet) or a list that lost SOL must never stop the market the shipped APK trades — nor its liquidations. */
export function withSol(list: MarketInfo[], sol: () => MarketInfo): MarketInfo[] {
  return list.some((m) => m.symbol === "SOL") ? list : [sol(), ...list];
}

/** Markets (base58) that have open positions but are not in the tick list — nothing liquidates there until the registry catches up. */
export function untickedMarkets(byMarket: Map<string, unknown[]>, ticked: MarketInfo[]): string[] {
  const known = new Set(ticked.map((m) => m.market.toBase58()));
  return [...byMarket.keys()].filter((k) => !known.has(k)).sort();
}
```

     У петлі: `const markets = withSol(registry.list(), solFallback);`, `const unticked = untickedMarkets(byMarket, markets).join(",");` (попередження при зміні — як на гілці).
  5. Цикл коміту замість блоку `n % COMMIT_INTERVAL_TICKS`:

```ts
    const now = Date.now();
    if (commitDue(lastCommitAttemptAt, now, COMMIT_INTERVAL_MS)) {
      lastCommitAttemptAt = now;
      const commitCtx = { conn, prog, crank: cfg.crank, feePayerConn, feePayerProg, feePayer: cfg.feePayer, pool, poolLive, balancesRoot, feeEscrow };
      const onStepError = (name: string, e: unknown): void => {
        console.error(`${name} cycle failed`, String(e));
        pushError(state, e);
      };
      const ok = await runIsolated(
        [
          ["root", () => runRootCycle(commitCtx)],
          ["commit", async () => { await runCommitCycle(commitCtx); }],
          ["janitor", async () => {
            const r = await runJanitorCycle(janitorDeps({ baseConn, baseProg: baseFeePayerProg, feePayer: cfg.feePayer }));
            for (const err of r.errors) pushError(state, err);
            if (r.closed.length > 0 || r.errors.length > 0) console.log(`janitor: scanned=${r.scanned} closed=${r.closed.length} skipped=${r.skipped} errors=${r.errors.length}`);
          }],
        ],
        onStepError,
      );
      if (ok.includes("commit")) state.lastCommitAt = Date.now();
    }
```

     `let lastCommitAttemptAt: number | null = null;` — перед петлею. Видалити `COMMIT_INTERVAL_TICKS`, реекспорт `COMMIT_MAX_ACTIONS`, `createQuarantineState`, `disclosureCycle`, блок `runProvisionCycle`, читання `config.magicFeeVault` для ER-закриття.
  6. Шапку файлу переписати під новий стан (пари `[Positions, UserAccount]`, цикл «root → commit → janitor» за годинником, без розкриття).

- [ ] **Step 7: `src/index.ts`.** Застосувати зміни гілки (`git diff 9904b98..multi-market-relayer -- services/relayer/src/index.ts`): побудова реєстру (`createMarketRegistry({ load: () => loadMarketsFromEr(erRpc, readPermissionOwners) })` з crank-TEE-з'єднанням для читання власників permission-PDA), `state.marketTicks = {}`, `startIndexer({ …, markets })`, `indexerRouter(pool, { markets })`, `getMarketsHealth`, `markets.stop()` при завершенні, `startCrank(cfg, state, registry)`. Прибрати: `COMMIT_MAX_ACTIONS`, `disclosures: 0` у `IndexerStats`, рядки логів про «Disclosure feed»; `commitIntervalTicks: COMMIT_INTERVAL_TICKS` → `commitIntervalMs: COMMIT_INTERVAL_MS` (імпорт із `./commit.js`). `src/shutdown.ts`: коментар про `runDisclosureCycle` → `runCommitCycle`.

- [ ] **Step 8: PASS — повний зелений стан**

```bash
cd services/relayer && npx tsc --noEmit && DEXXER_IDL_DIR=$PWD/../../idl npm test
cd ../../tests/er && npx tsc --noEmit && npm run selftest:hashes
cd ../../scripts && npx tsc --noEmit
cd ../app && npx tsc --noEmit && npm test
grep -rnE "disclosure|Disclosure|DQ_DISC|POSITION_DISC|quarantine|COMMIT_MAX_ACTIONS|closeOrphanQueue|initUserReuseQueue|pdas\.position\(" services/relayer/src services/relayer/test | grep -v "^services/relayer/migrations"
```

Expected: усе зелене, 0 failed; останній `grep` порожній (крім, можливо, слова в історичному коментарі — такий коментар переписати). Якщо є Docker — один прогін із `TEST_DATABASE_URL`. Записати лічильники (усього / пройшло / skipped).

- [ ] **Step 9: commit**

```bash
git add services/relayer/src/candidates.ts services/relayer/src/commit.ts services/relayer/src/crank.ts services/relayer/src/index.ts services/relayer/src/shutdown.ts services/relayer/test/candidates.test.ts services/relayer/test/commit.test.ts services/relayer/test/crankMarkets.test.ts
git rm -q services/relayer/src/disclosure.ts services/relayer/test/disclosure.test.ts
git commit -m "feat(relayer): per-market crank on position slots; wall-clock commit cycle; disclosure cycle removed"
```

---

### Task 7: документи й підсумкова перевірка

**Files:**
- Modify: `services/relayer/README.md`, `docs/deployments.md`, `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` (§2.9 — абзац «**Реалізовано (relayer і адмін-TS, <дата>)**»), `CLAUDE.md`

- [ ] **Step 1: повна перевірка** — усі команди Task 6 Step 8, плюс Rust (програму зачепив лише тест зміщень):

```bash
cargo fmt --check && cargo clippy -p dexxer_core -p mock_oracle -- -D warnings
cargo test -p dexxer_core -p mock_oracle
cargo +nightly-2026-09-18 test -p dexxer_litesvm
```

Expected: unit 69 (68 + тест зміщень), LiteSVM 89. І свіжість IDL: перегенерувати в тимчасовий файл командою Task 1 Step 2 і `cmp` з `app/src/idl/dexxer_core.json` — ідентичні (програма між Task 1 і тепер отримала лише `#[cfg(test)]`-код).

- [ ] **Step 2: `services/relayer/README.md`.** «What it does»: `crank.ts` (по ринках, пари `[Positions, UserAccount]`, SOL завжди), `candidates.ts`, `commit.ts` (root + `commit_aggregate()` кожні `COMMIT_INTERVAL_MS`), `janitor.ts`, `markets.ts`; видалити описи `disclosure.ts`/`orphan.ts`. REST: додати `GET /markets`, `?market=`, `/ws?markets=`; видалити `/disclosures`, `/stats`, WS-кадр `disclosure` і розділ «Pagination, filters, stats» в частині розкриттів. Whitelist: без рядка `init_user_reuse_queue`. Таблиця env: додати `MARKETS_REFRESH_MS` (60000, мін. 5000), `COMMIT_INTERVAL_MS` (300000, мін. 10000); видалити `COMMIT_INTERVAL_TICKS`, `COMMIT_MAX_ACTIONS`, `QUARANTINE_CYCLES`. Tests: нові лічильники, згадка `janitor.test.ts` замість `orphan`. Тексти про ринки — з гілки (`git diff 9904b98..multi-market-relayer -- services/relayer/README.md`), без усього про роздачу позицій (`PROVISION_*`).

- [ ] **Step 3: `docs/deployments.md`.** Таблиця env Railway: ті самі зміни змінних (позначити, що `COMMIT_INTERVAL_TICKS=60` на живому сервісі при переході стає `COMMIT_INTERVAL_MS=60000`). Розділ індексера: без `/disclosures`/`/stats`, з ринками й міграцією `008`; таблиця `disclosures` у живій БД лишається невживаною. Розділи `set_disclosure_delay` і «Legacy UserAccount» — позначити застарілими одним рядком-вказівником. Індекс devnet-скриптів: прибрати 06/12/14/15, додати `add-market`. Розкатку мульти-маркету з гілки (`git diff 9904b98..multi-market-relayer -- docs/deployments.md`) перенести БЕЗ кроків про роздачу позицій і поповнення `fee_payer` під неї; додати примітку: сама розкатка на чистий деплой — план 4.

- [ ] **Step 4: spec §2.9 — «Реалізовано (relayer і адмін-TS)».** По задачах: що зроблено; лічильники тестів relayer-а; `CRANK_TX_MAX_CANDIDATES` і виміряний розмір транзакції; відхилення від цього плану (рулінги виконання); рішення плану: коміт за годинником (`COMMIT_INTERVAL_MS`), SOL тікає завжди (`withSol`), таблиця `disclosures` не видаляється, генератор IDL у `tools/idlgen`. «Не виміряно (devnet)» — усе з плану 1 плюс: розмір і CU реального `crank_tick` з 12 парами, читання `Positions` crank-токеном через `getProgramAccounts`, читання власників permission-PDA. «Відкрите для плану 3» і «для плану 4» — доповнити: апка має перейти з `/disclosures`/`/stats` (їх більше нема) на кільце історії; на новому деплої — `add-market --schedule` для кожного ринку, щоб ліквідація без relayer-а мала джерело семплів.

- [ ] **Step 5: `CLAUDE.md`.** Новий розділ «Правила тижня 6: позиції-слоти, relayer і TS (§2.9.3)»: IDL новий і CI знову порівнює його з `anchor build` (регенерація — `tools/idlgen`, команда); `Positions` декодується лише вручну (`tests/er/lib/positions.ts`, зміщення запінені Rust-тестом `offsets_match_the_off_chain_decoders`); будівники акаунтів у `tests/er/lib/trader.ts` звіряються з IDL тестом `ixAccounts.test.ts`; crank — кандидати зі слотів, пари, `CRANK_TX_MAX_CANDIDATES`, сміття відсіюється на клієнті; SOL тікає завжди; коміт за годинником; janitor — один прохід, рента на `rent_payer`; розкриття в relayer-і нема (`/disclosures`, `/stats` видалені); env; лічильники тестів. У розділі «Правила тижня 6: позиції-слоти» прибрати твердження, що IDL старий і CI червоний. Старі правила про relayer-розкриття (`COMMIT_MAX_ACTIONS`, `QUARANTINE_CYCLES`, індексер `/disclosures`/`/stats`) — позначити маркером `**[Застаріло з 30.09.2026: див. «Правила тижня 6: позиції-слоти»]**` (той самий єдиний формат). Рядок у «Документи» про цей план.

- [ ] **Step 6: commit**

```bash
git add services/relayer/README.md docs/deployments.md docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md CLAUDE.md
git commit -m "docs(week6): relayer and admin TS on position slots — rules, env, rollout notes"
```
