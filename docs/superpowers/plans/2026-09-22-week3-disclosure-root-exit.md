# Dexxer — тиждень 3: 13F-розкриття, `BalancesRoot`, вихід. План імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закриті позиції залишають на L1 хеш-commitment і після затримки — публічний `Disclosure` з перевіркою хешу; `Position` повертається в `Empty` (знімає ліміт «одна позиція за прогін»); кожні 5 хв разом із `Pool` комітиться публічний `BalancesRoot` (хешовані листки балансів, квитанція боргу); юзер може повністю вийти (`undelegate_user`); мобілка отримує History і Receipt; CI на PR. П'ятниця: повний цикл close → commitment → reveal (хеш збігається) → друга позиція тим самим гаманцем + три кадри демо.

**Architecture:** Той самий `dexxer_core`. Усі L1-записи тижня 3 — Magic Actions **на коміті публічного `Pool`** (spec §2.1 правило #13: сирий приватний акаунт ніколи не йде на L1). `commit_aggregate` стає єдиним 5-хвилинним bundle: `commit(&[Pool, BalancesRoot])` + до `MAX_ACTIONS_PER_COMMIT` post-commit actions (`write_commitment` для `Closed && !commitment_written`, `write_disclosure` для записів `DisclosureQueue` зі `slot ≥ reveal_after_slot`). `mark_committed` (crank) переносить запис у `DisclosureQueue` після спостереження `Commitment` на base і повертає `Position → Empty`. `set_balances_root` (crank) заповнює 64 slot-прив'язані листки з реальних байтів `UserAccount`. `undelegate_user`: скраб → `CloseEphemeralPermissionCpi` ×3 → `commit_and_undelegate`. Мобілка читає `DisclosureQueue` (TEE, owner-токен) + `Disclosure`/`BalancesRoot` (base).

**Tech Stack:** як у тижні 2 — Anchor 1.0.2, `ephemeral-rollups-sdk =0.16.2` (`anchor`, `access-control`; з нього `ephem::{CallHandler, MagicIntentBundleBuilder}`, `ActionArgs`, `ShortAccountMeta`, `anchor::action`, `pda::ephemeral_balance_pda_from_payer`), `solana-keccak-hasher =3.1.0` (є), TS SDK 0.17.0 (`createTopUpEscrowInstruction`, `escrowPdaFromEscrowAuthority`), web3.js v1, Expo 57, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` — **§2.4** (дизайн тижня 3, затверджено 21.09), §2.1 (матриця акаунтів: `Commitment`, `BalancesRoot`), §2.2, §4.2, §7.1 ризики #19–21, §8 п.9–13 (виміри M-A…M-E). Результати тижня 2: `docs/superpowers/plans/week2-results.md`. Еталон Magic Actions: `spikes/06-magic-action/programs/magic-actions/src/lib.rs` (check 7, працює на devnet) і skill `magicblock` `references/magic-actions.md`.

## Global Constraints

- Усе з Global Constraints тижнів 1–2: `checked_*` у програмі, коментарі в коді англійською, `init_if_needed` заборонений, `program_autofixer` на кожен змінений `.rs` (навіть doc-коментар), LiteSVM лише `cargo +nightly-2026-09-18 test -p dexxer_litesvm` після `anchor build`, mb-stack 0.13.7, Node через `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.
- **Кожна ER-інструкція перевіряє підписанта в коді** (spec A3). `#[action]`-інструкції на L1 перевіряють `escrow` як signer з адресою `ephemeral_balance_pda_from_payer(escrow_auth, 255)` **і** `source_program == crate::ID` — обидва обов'язкові (check 7).
- **Сирий приватний акаунт ніколи не комітиться на L1** (§2.1). `commit_aggregate` комітить **лише `Pool` і `BalancesRoot`**. `Position`/`UserAccount`/`MarketRisk`/`DisclosureQueue` в жодному `.commit(...)`, крім `undelegate_user` — і там лише після скрабу та закриття permission.
- **Хеш-примітива — keccak256** через уже наявний `solana_keccak_hasher::hashv` (так уже рахується `salt` у `finalize_close`). Spec §2.4 пише «sha256» — формулювання правиться в Task 11; дизайн ідентичний (32-байтний колізійно-стійкий хеш), нову залежність (`solana-sha256-hasher`, у lock 2.3.0 ≠ сім'я 3.1.0) не додаємо.
- **Канонічні байти commitment-у** (програма і клієнт рахують однаково): `commitment_hash(rec) = keccak(market ‖ side:u8 ‖ size:u64le ‖ entry:u64le ‖ exit:u64le ‖ pnl:i64le ‖ fees:u64le ‖ reason:u8 ‖ opened_slot:u64le ‖ closed_slot:u64le ‖ nonce:u64le ‖ reveal_after_slot:u64le ‖ salt)`. Поле `commitment_written` **не входить** (воно мутує).
- **Лист root-у:** `leaf = keccak(owner ‖ free_margin:u64le ‖ exit_salt ‖ root_slot:u64le)`; паддинг `keccak(padding_seed ‖ i:u8)`; `ROOT_LEAVES = 64`, `ROOT_BATCH = 16`.
- Помилки додаються **лише в кінець** `DexxerError` (TS асертить числові коди): `CommitmentNotWritten=6031, RevealTooEarly=6032, QueueNotEmpty=6033, RootFull=6034, InvalidLeafAccount=6035, NotClosed=6036, BadDisclosureHash=6037, BalanceNotZero=6038, TooManyActions=6039`.
- Devnet: program id `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`, base `https://rpc.magicblock.app/devnet`, TEE `https://devnet-tee.magicblock.app`, validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, fee vault `EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b`, mint `2URtQ5L8oJiUtbtXXvbNk3MRoAt4w8DTZ8GB7r4uCZ29`. Ключі: `tests/er/.keys/devnet-{admin,crank,fee-payer}.json`, payer `spikes/keys/payer.json` (~5.19 SOL; редеплой потребує ~4.8 SOL float + можливий `solana program extend` ~0.2 SOL, якщо бінарник виріс — див. week2-results §Task 5 раунд 2).
- Ніколи не комітити нічого під `keys/` (крім README), `tests/er/.keys/`, `spikes/keys/`, `target/deploy/*-keypair.json`; не чіпати `.agents/`, `.claude/`, `skills-lock.json`. Docs українською, код/коміти англійською.

---

## Структура файлів

```
programs/dexxer_core/src/
  state/mod.rs                 + COMMIT_SEED, DISCLOSURE_SEED, BALANCES_ROOT_SEED, ROOT_LEAVES, ROOT_BATCH, MAX_ACTIONS_PER_COMMIT, ACTION_ESCROW_INDEX
  state/user.rs                + exit_salt: [u8;32]
  state/disclosure.rs          DisclosureCommitment → Commitment {hash, slot, nonce, bump}; Disclosure + bump; commitment_hash(); DisclosureArgs
  state/balances_root.rs       NEW: BalancesRoot, leaf(), pad()
  errors.rs                    + 9 варіантів у кінець
  instructions/disclosure.rs   NEW: write_commitment / write_disclosure (#[action], L1), mark_committed (ER, crank), pending_commitment(), due_reveals()
  instructions/commit.rs       commit_aggregate: remaining_accounts (Position | DisclosureQueue) → actions; commit(&[pool, balances_root])
  instructions/root.rs         NEW: init_balances_root, delegate_balances_root (admin, L1), set_balances_root (crank, ER)
  instructions/user.rs         init_user(exit_salt); undelegate_user
  instructions/mod.rs, lib.rs  wiring
tests/litesvm/src/{ixs,setup,pdas}.rs   builders/PDAs для нових ixs; new_trader передає exit_salt
tests/litesvm/tests/disclosure.rs        NEW (mark_committed / due reveals / action-only guards)
tests/litesvm/tests/root.rs              NEW (set_balances_root)
tests/litesvm/tests/undelegate.rs        NEW (guards + scrub)
tests/er/lib/program.ts                  + pdas.commitment/disclosure/balancesRoot, commitmentHash(), leaf()
tests/er/lib/admin.ts                    bootstrap: init/delegate BalancesRoot, top-up action escrow
tests/er/devnet/w3-measure.ts            NEW: M-A, M-C, M-D (M-B/M-E — у 06/07)
tests/er/devnet/06-commitment-reveal.ts  NEW
tests/er/devnet/07-balances-root.ts      NEW
tests/er/devnet/08-undelegate.ts         NEW
scripts/crank-fallback/disclosure.ts     NEW: runDisclosureCycle(), runRootCycle()
scripts/crank-fallback/index.ts          виклик циклів кожні 300 тіків
scripts/admin/devnet-bootstrap.ts        + BalancesRoot + action escrow
app/src/lib/live.ts                      NEW: useLiveAccount (витягнуто з PositionScreen)
app/src/lib/program.ts                   + decodeDisclosureQueue, decodeDisclosure, decodeBalancesRoot, readUserAccountExitSalt, leaf(), pdas
app/src/features/history/HistoryScreen.tsx   NEW
app/src/features/receipt/ReceiptSection.tsx  NEW (у Account-табі)
app/app/(tabs)/history.tsx, _layout.tsx
.github/workflows/ci.yml                 NEW
docs/superpowers/plans/week3-results.md  NEW
```

**Порядок виконання:** 0 → 1 (виміри M-A/M-C/M-D на спайках, паралельно з кодом не залежать) → 2 → 3 → 4 → 5 → 6 → 7 → 8 (редеплой + M-B/M-E) → 9 → 10 → 11.

---

### Task 0: Стан, seeds, помилки, `exit_salt` в `init_user`

**Files:**
- Modify: `programs/dexxer_core/src/state/mod.rs`, `state/user.rs`, `state/disclosure.rs`, `errors.rs`, `instructions/user.rs` (`init_user`), `lib.rs`
- Create: `programs/dexxer_core/src/state/balances_root.rs`
- Modify: `tests/litesvm/src/ixs.rs` (`init_user` з `exit_salt`), `tests/litesvm/src/setup.rs` (`new_trader`), `tests/er/lib/trader.ts` (`initUser` з salt), `app/src/features/onboard/useOnboarding.ts` (`init_user` з salt)

**Interfaces:**
- Produces: `state::{COMMIT_SEED=b"commit", DISCLOSURE_SEED=b"disclosure", BALANCES_ROOT_SEED=b"balances_root", ROOT_LEAVES=64usize, ROOT_BATCH=16usize, MAX_ACTIONS_PER_COMMIT=4usize, ACTION_ESCROW_INDEX=255u8}`; `UserAccount.exit_salt: [u8;32]`; `Commitment { version:u8, hash:[u8;32], slot:u64, nonce:u64, bump:u8 }`; `Disclosure { …як зараз…, bump:u8 }`; `DisclosureArgs` (borsh-структура без salt/flag) + `pub fn commitment_hash(a:&DisclosureArgs, salt:&[u8;32]) -> [u8;32]` + `impl From<&ClosedRecord> for DisclosureArgs`; `BalancesRoot { version:u8, root_slot:u64, filled:u8, leaves:[[u8;32];64], bump:u8 }`, `pub fn leaf(owner:&Pubkey, free_margin:u64, exit_salt:&[u8;32], root_slot:u64)->[u8;32]`, `pub fn pad(seed:&[u8;32], i:u8)->[u8;32]`; `init_user(ctx, exit_salt:[u8;32])`.

- [ ] **Step 1: Unit-тести (червоні) для хешів** — у `state/disclosure.rs` і `state/balances_root.rs`:

```rust
// state/balances_root.rs (tail)
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leaf_is_deterministic_and_slot_bound() {
        let o = Pubkey::new_unique();
        let s = [7u8; 32];
        assert_eq!(leaf(&o, 1_000, &s, 10), leaf(&o, 1_000, &s, 10));
        assert_ne!(leaf(&o, 1_000, &s, 10), leaf(&o, 1_000, &s, 11), "slot binding");
        assert_ne!(leaf(&o, 1_000, &s, 10), leaf(&o, 1_001, &s, 10), "balance binding");
        assert_ne!(leaf(&o, 1_000, &s, 10), leaf(&o, 1_000, &[8u8; 32], 10), "salt binding");
    }
    #[test]
    fn pad_differs_per_index_and_seed() {
        let a = [1u8; 32];
        assert_ne!(pad(&a, 0), pad(&a, 1));
        assert_ne!(pad(&a, 0), pad(&[2u8; 32], 0));
    }
}
```

```rust
// state/disclosure.rs (tail)
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commitment_hash_ignores_written_flag_and_binds_salt() {
        let mut rec = ClosedRecord { nonce: 5, salt: [3u8; 32], ..ClosedRecord::default() };
        let a = DisclosureArgs::from(&rec);
        let h1 = commitment_hash(&a, &rec.salt);
        rec.commitment_written = true;
        assert_eq!(h1, commitment_hash(&DisclosureArgs::from(&rec), &rec.salt), "flag must not affect hash");
        assert_ne!(h1, commitment_hash(&a, &[4u8; 32]), "salt must affect hash");
    }
}
```

- [ ] **Step 2: Запустити — має не компілюватись** (`leaf`, `pad`, `DisclosureArgs`, `commitment_hash` не існують).

Run: `cargo test -p dexxer_core leaf_is 2>&1 | tail -5` → Expected: `error[E0425]`/`E0433` cannot find.

- [ ] **Step 3: Реалізація стану**

```rust
// state/mod.rs — додати після FEE_ESCROW_SEED
pub mod balances_root;
pub use balances_root::*;
pub const COMMIT_SEED: &[u8] = b"commit";
pub const DISCLOSURE_SEED: &[u8] = b"disclosure";
pub const BALANCES_ROOT_SEED: &[u8] = b"balances_root";
/// Fixed leaf count — hides the real user count (spec §2.4.2). Merkle upgrade when N > 64.
pub const ROOT_LEAVES: usize = 64;
/// UserAccounts per `set_balances_root` call (tx size / CU budget).
pub const ROOT_BATCH: usize = 16;
/// Post-commit actions per `commit_aggregate` bundle; provisional until M-C measures the real cap.
pub const MAX_ACTIONS_PER_COMMIT: usize = 4;
/// `ActionArgs::new` default escrow index (magic-actions.md).
pub const ACTION_ESCROW_INDEX: u8 = 255;
```

```rust
// state/user.rs — вставити перед `pub bump: u8,`
    /// Week 3 (spec §2.4.2): per-user secret that salts this account's leaf in
    /// the public `BalancesRoot`. Supplied by the client at `init_user`; lives
    /// only in this private account, so nobody can brute-force `free_margin`
    /// from the published leaf hash.
    pub exit_salt: [u8; 32],
```

```rust
// state/balances_root.rs
use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;
use super::ROOT_LEAVES;

/// Public, delegated, committed with `Pool` every 5 min (spec §2.4.2).
/// Carries only keccak leaves — never a balance or owner in the clear.
#[account]
#[derive(InitSpace)]
pub struct BalancesRoot {
    pub version: u8,
    /// Slot the current leaf set was computed for; every leaf is bound to it.
    pub root_slot: u64,
    /// Real (non-padding) leaves written so far in the current cycle.
    pub filled: u8,
    pub leaves: [[u8; 32]; ROOT_LEAVES],
    pub bump: u8,
}

/// `keccak(owner ‖ free_margin ‖ exit_salt ‖ root_slot)` — spec §2.4.2 / Global Constraints.
pub fn leaf(owner: &Pubkey, free_margin: u64, exit_salt: &[u8; 32], root_slot: u64) -> [u8; 32] {
    hashv(&[
        owner.as_ref(),
        &free_margin.to_le_bytes(),
        exit_salt,
        &root_slot.to_le_bytes(),
    ])
    .to_bytes()
}

/// Padding leaf for unused slot `i`; `seed` is never stored on-chain, so padding
/// is indistinguishable from real leaves to an outside observer.
pub fn pad(seed: &[u8; 32], i: u8) -> [u8; 32] {
    hashv(&[seed, &[i]]).to_bytes()
}
```

```rust
// state/disclosure.rs — замінити DisclosureCommitment, доповнити Disclosure, додати DisclosureArgs + commitment_hash
use solana_keccak_hasher::hashv;

/// L1 `[b"commit", nonce]` — written by the `write_commitment` Magic Action on the Pool commit.
#[account]
#[derive(InitSpace)]
pub struct Commitment {
    pub version: u8,
    pub hash: [u8; 32],
    pub slot: u64,
    pub nonce: u64,
    pub bump: u8,
}

/// Public fields of a closed trade — the `write_disclosure` instruction argument
/// and the on-chain `Disclosure` body. Deliberately excludes `salt` (argument on
/// its own) and `commitment_written` (mutable bookkeeping) — see `commitment_hash`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct DisclosureArgs {
    pub market: Pubkey,
    pub side: Side,
    pub size: u64,
    pub entry: u64,
    pub exit: u64,
    pub pnl: i64,
    pub fees: u64,
    pub reason: CloseReason,
    pub opened_slot: u64,
    pub closed_slot: u64,
    pub nonce: u64,
    pub reveal_after_slot: u64,
}

impl From<&ClosedRecord> for DisclosureArgs {
    fn from(r: &ClosedRecord) -> Self {
        Self {
            market: r.market, side: r.side, size: r.size, entry: r.entry, exit: r.exit,
            pnl: r.pnl, fees: r.fees, reason: r.reason, opened_slot: r.opened_slot,
            closed_slot: r.closed_slot, nonce: r.nonce, reveal_after_slot: r.reveal_after_slot,
        }
    }
}

/// Canonical commitment: keccak over the fixed field order in Global Constraints, then `salt`.
pub fn commitment_hash(a: &DisclosureArgs, salt: &[u8; 32]) -> [u8; 32] {
    hashv(&[
        a.market.as_ref(),
        &[a.side as u8],
        &a.size.to_le_bytes(),
        &a.entry.to_le_bytes(),
        &a.exit.to_le_bytes(),
        &a.pnl.to_le_bytes(),
        &a.fees.to_le_bytes(),
        &[a.reason as u8],
        &a.opened_slot.to_le_bytes(),
        &a.closed_slot.to_le_bytes(),
        &a.nonce.to_le_bytes(),
        &a.reveal_after_slot.to_le_bytes(),
        salt,
    ])
    .to_bytes()
}
```
`Disclosure`: додати `pub version: u8` першим полем і `pub bump: u8` останнім (решта полів як є).

```rust
// errors.rs — додати в КІНЕЦЬ enum, після WithdrawCooldown
    #[msg("commitment not yet written for this closed position")]
    CommitmentNotWritten,
    #[msg("reveal slot not reached")]
    RevealTooEarly,
    #[msg("disclosure queue not empty")]
    QueueNotEmpty,
    #[msg("balances root has no free leaf slot")]
    RootFull,
    #[msg("invalid leaf account")]
    InvalidLeafAccount,
    #[msg("position is not closed")]
    NotClosed,
    #[msg("disclosure does not match commitment hash")]
    BadDisclosureHash,
    #[msg("account balance must be zero to exit")]
    BalanceNotZero,
    #[msg("too many actions in one commit bundle")]
    TooManyActions,
```

`init_user` (`instructions/user.rs`): сигнатура `pub fn init_user(ctx: Context<InitUser>, exit_salt: [u8; 32]) -> Result<()>`; у тілі після існуючих присвоєнь `UserAccount`: `u.exit_salt = exit_salt;`. `lib.rs`: `pub fn init_user(ctx: Context<InitUser>, exit_salt: [u8; 32]) -> Result<()> { user::init_user(ctx, exit_salt) }`.

- [ ] **Step 4: Клієнти `init_user`.** `tests/litesvm/src/ixs.rs::init_user(owner, wd)` → `init_user(owner, wd, exit_salt: [u8;32])`, дані `= disc ++ exit_salt`; `setup.rs::new_trader` передає `[0x5a; 32]`. `tests/er/lib/trader.ts::onboardTrader`: `.initUser(Array.from(randomBytes(32)))` (`crypto.randomBytes`), зберігати salt у `Trader.exitSalt: Uint8Array` (потрібен 07-скрипту). `app/src/features/onboard/useOnboarding.ts` крок `init_user`: `.initUser(Array.from(exitSalt))`, де `exitSalt = crypto.getRandomValues(new Uint8Array(32))`, збережений у `expo-secure-store` під `dexxer.exitsalt.<owner>` (поряд із session key, той самий модуль `session.ts` → `getOrCreateExitSalt(owner)`). **Receipt-екран (Task 9) читає salt з `UserAccount` через TEE, не зі стору** — стор лише щоб не загубити між `init_user` і першим читанням.

- [ ] **Step 5: Зелено + гаунтлет**

Run: `cargo test -p dexxer_core` → Expected: 46 + 3 нових = 49 passed. `anchor build` чисто. `cargo +nightly-2026-09-18 test -p dexxer_litesvm` → 39/39 (лише сигнатура `init_user` змінилась). Autofixer на `state/{mod,user,disclosure,balances_root}.rs`, `errors.rs`, `instructions/user.rs`, `lib.rs`. `npx tsc --noEmit` у `tests/er`, `scripts`, `app`.

- [ ] **Step 6: Commit** `feat(core): week-3 state — Commitment/Disclosure/BalancesRoot, exit_salt, keccak leaf and commitment hashes`

---

### Task 1: Виміри M-A, M-C, M-D на спайках (devnet)

**Files:**
- Create: `tests/er/devnet/w3-measure.ts`; розділ «Task 1» у `docs/superpowers/plans/week3-results.md` (новий файл, шапка як у week2-results)
- Modify: `spikes/01-private-counter-tee/programs/private-counter/src/lib.rs` (+ `close_permission_and_undelegate`), `spikes/06-magic-action/programs/magic-actions/src/lib.rs` (+ `commit_with_n_actions(n)`), `tests/er/package.json` (`devnet:w3measure`)

**Interfaces:**
- Produces: рядки «Рішення після M-A/M-C/M-D» у `week3-results.md`: (a) чи долітає `commit_and_undelegate` після `CloseEphemeralPermissionCpi` (вхід Task 6); (b) максимальна кількість actions в одному bundle → значення `MAX_ACTIONS_PER_COMMIT` (вхід Task 3, за замовчуванням 4); (c) планувальник: чи `iterations` капиться, чи задача переживає рестарт, чи self-reschedule з-під `CRANK_SIGNER` проходить (вхід Task 7 / тех-борг #18).

- [ ] **M-A.** У спайку 01 додати інструкцію `exit(ctx)` (owner): `CloseEphemeralPermissionCpi` для `counter` (той самий патерн invoke_signed, що `set_privacy`), потім `MagicIntentBundleBuilder::new(payer, magic_context, magic_program).commit_and_undelegate(&[counter]).build_and_invoke()`. Скрипт: `set_privacy(true, crank)` → `increment` → `exit` → поллінг base (≤120 с) до `counter.owner == PROGRAM_ID` (не `DELeGG…`) і `count` == ER-значення. **PASS** = байти долетіли. Якщо FAIL — повторити з **порядком без** close-permission (лише `commit_and_undelegate`) і записати, який варіант працює. Редеплой спайку 01 через `solana program deploy --program-id … --upgrade-authority payer` (як у тижні 2, дешево).
- [ ] **M-C.** У спайку 06 додати `commit_with_n_actions(n: u8)`: `n` × той самий `CallHandler{update_leaderboard}` у `add_post_commit_actions`. Скрипт: `n = 1, 2, 4, 8, 12`; для кожного — tx на ER, поллінг `leaderboard` на base; **записати найбільше `n`, за якого всі actions виконались** (лічильник leaderboard зріс на `n`), і перший `n`, що впав (помилка tx або частково виконані). Це і є `MAX_ACTIONS_PER_COMMIT`. Escrow топ-ап: `createTopUpEscrowInstruction(escrowPdaFromEscrowAuthority(payer), payer, 0.05 SOL)` на base перед серією (див. `spikes/06-magic-action/tests/magic-actions.ts:132`).
- [ ] **M-D.** На спайку 05 (ключ `keys sync`, деплой ~1.6 SOL, `program close` після): (1) `schedule` з `iterations = i64::MAX` → чи прийнято (лог) і чи тікає ≥60 с; (2) `iterations = 0` і `-1` → прийнято/відхилено; (3) **персистентність:** запланувати `iterations=86_400`, зафіксувати `count`, спитати MagicBlock-Discord / перевірити після відомого рестарту devnet-tee (якщо в межах сесії рестарту нема — записати «не виміряно, потребує вікна рестарту»); (4) self-reschedule: інструкція `tick_and_reschedule`, яка сама викликає `ScheduleCrankCpi` з payer=`CRANK_SIGNER`-підписом — записати результат (очікування: відхилено, бо payer не може підписати).
- [ ] **Записати «Рішення після M-A/M-C/M-D»** у `week3-results.md`. Закрити спайк 05 (`solana program close … --bypass-warning`), баланс payer до/після.
- [ ] **Commit** `test(devnet): week-3 measurements M-A undelegate-after-permission-close, M-C actions per bundle, M-D scheduler limits`

---

### Task 2: `write_commitment` і `write_disclosure` — L1 `#[action]`-інструкції

**Files:**
- Create: `programs/dexxer_core/src/instructions/disclosure.rs`
- Modify: `instructions/mod.rs`, `lib.rs`, `tests/litesvm/src/{ixs,pdas}.rs`; Create: `tests/litesvm/tests/disclosure.rs`

**Interfaces:**
- Produces: `write_commitment(ctx, nonce: u64, hash: [u8;32])` — контекст `WriteCommitment<'info>` з акаунтами `[commitment (init, w), config (ro), system_program, source_program, escrow_auth, escrow]`; `write_disclosure(ctx, args: DisclosureArgs, salt: [u8;32])` — `WriteDisclosure<'info>` `[disclosure (init, w), commitment (ro), config (ro), system_program, source_program, escrow_auth, escrow]`. PDA: `pdas::commitment(nonce)`, `pdas::disclosure(nonce)`. Обидві — **action-only** (escrow-signer робить прямий виклик неможливим).

- [ ] **Step 1: Тести (червоні).** `tests/litesvm/tests/disclosure.rs`:

```rust
use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{assert_custom_error, ixs, pdas, setup::World, Harness};
use solana_keypair::Keypair;
use solana_signer::Signer;

// Direct calls to the `#[action]` handlers must be impossible: `escrow` has to be
// a signer at the delegation program's balance PDA, which no wallet can produce.
#[test]
fn write_commitment_direct_call_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::write_commitment_direct(&stranger.pubkey(), &w, 1, [9u8; 32])],
        &[&stranger],
    );
    assert!(r.is_err(), "direct write_commitment must fail (escrow not a signer)");
}

#[test]
fn write_disclosure_direct_call_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let args = DisclosureArgs { market: w.market, side: Side::Long, size: 1, entry: 1, exit: 1, pnl: 0, fees: 0,
        reason: CloseReason::User, opened_slot: 1, closed_slot: 2, nonce: 1, reveal_after_slot: 3 };
    let r = h.send(
        &[ixs::write_disclosure_direct(&stranger.pubkey(), &w, args, [1u8; 32])],
        &[&stranger],
    );
    assert!(r.is_err(), "direct write_disclosure must fail (escrow not a signer)");
}
```
`ixs::write_commitment_direct`/`write_disclosure_direct` будують інструкцію, підставляючи `escrow_auth = stranger`, `escrow = ephemeral_balance_pda_from_payer(stranger, 255)` **не** як signer — так виглядає спроба зловмисника.

- [ ] **Step 2: Червоно.** `cargo +nightly-2026-09-18 test -p dexxer_litesvm --test disclosure` → compile error (немає `ixs::write_commitment_direct`).

- [ ] **Step 3: Реалізація** — `instructions/disclosure.rs` (копіює форму спайку 06 `UpdateLeaderboard`, лінія за лінією; коментар про `source_program` — з спайку):

```rust
use crate::{errors::DexxerError, state::*};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::action;
use ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer;

/// Written on L1 by the delegation program as a post-commit action of the
/// 5-min `Pool` commit (spec §2.4.1). `escrow` signer + `source_program` are the
/// two checks that make this action-only (check 7, 19.09.2026): only the
/// delegation program can sign the escrow balance PDA, and it inserts the
/// destination program id as an extra account before the macro-injected
/// escrow pair — `source_program` absorbs that slot so Anchor's positional
/// deserialization stays aligned (see spikes/06-magic-action RESULT.md check 7).
#[action]
#[derive(Accounts)]
#[instruction(nonce: u64, hash: [u8; 32])]
pub struct WriteCommitment<'info> {
    #[account(init, payer = escrow, space = 8 + Commitment::INIT_SPACE,
        seeds = [COMMIT_SEED, &nonce.to_le_bytes()], bump)]
    pub commitment: Account<'info, Commitment>,
    /// Plain (never delegated) L1 account — readable here to pin `escrow_auth` to `Config.fee_payer`.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
    /// CHECK: program that scheduled the action; absorbs the dispatcher-inserted slot.
    #[account(address = crate::ID @ DexxerError::InvalidActionSigner)]
    pub source_program: UncheckedAccount<'info>,
    /// CHECK: escrow authority = the fee payer whose action-escrow funds L1 fees.
    #[account(constraint = escrow_auth.key() == config.fee_payer @ DexxerError::InvalidActionSigner)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: Magic escrow PDA; only the delegation program can sign for it.
    #[account(mut, signer @ DexxerError::InvalidActionSigner,
        address = ephemeral_balance_pda_from_payer(&escrow_auth.key(), ACTION_ESCROW_INDEX) @ DexxerError::InvalidActionSigner)]
    pub escrow: UncheckedAccount<'info>,
}

pub fn write_commitment(ctx: Context<WriteCommitment>, nonce: u64, hash: [u8; 32]) -> Result<()> {
    let c = &mut ctx.accounts.commitment;
    c.version = 1;
    c.hash = hash;
    c.slot = Clock::get()?.slot;
    c.nonce = nonce;
    c.bump = ctx.bumps.commitment;
    Ok(())
}

#[action]
#[derive(Accounts)]
#[instruction(args: DisclosureArgs, salt: [u8; 32])]
pub struct WriteDisclosure<'info> {
    #[account(init, payer = escrow, space = 8 + Disclosure::INIT_SPACE,
        seeds = [DISCLOSURE_SEED, &args.nonce.to_le_bytes()], bump)]
    pub disclosure: Account<'info, Disclosure>,
    #[account(seeds = [COMMIT_SEED, &args.nonce.to_le_bytes()], bump = commitment.bump)]
    pub commitment: Account<'info, Commitment>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
    /// CHECK: see WriteCommitment
    #[account(address = crate::ID @ DexxerError::InvalidActionSigner)]
    pub source_program: UncheckedAccount<'info>,
    /// CHECK: see WriteCommitment
    #[account(constraint = escrow_auth.key() == config.fee_payer @ DexxerError::InvalidActionSigner)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: see WriteCommitment
    #[account(mut, signer @ DexxerError::InvalidActionSigner,
        address = ephemeral_balance_pda_from_payer(&escrow_auth.key(), ACTION_ESCROW_INDEX) @ DexxerError::InvalidActionSigner)]
    pub escrow: UncheckedAccount<'info>,
}

pub fn write_disclosure(ctx: Context<WriteDisclosure>, args: DisclosureArgs, salt: [u8; 32]) -> Result<()> {
    require!(
        commitment_hash(&args, &salt) == ctx.accounts.commitment.hash,
        DexxerError::BadDisclosureHash
    );
    let d = &mut ctx.accounts.disclosure;
    d.version = 1;
    d.owner = Pubkey::default(); // owner is NOT disclosed — spec §2.3: the record is the trade, not the trader
    d.market = args.market; d.side = args.side; d.size = args.size; d.entry = args.entry; d.exit = args.exit;
    d.pnl = args.pnl; d.fees = args.fees; d.reason = args.reason; d.opened_slot = args.opened_slot;
    d.closed_slot = args.closed_slot; d.nonce = args.nonce;
    d.bump = ctx.bumps.disclosure;
    Ok(())
}
```
`mod.rs`: `pub mod disclosure; pub use disclosure::*;`. `lib.rs`: два врапери з тими самими сигнатурами. `pdas.rs` (litesvm): `commitment(nonce:u64)`, `disclosure(nonce:u64)`. `ixs.rs`: `write_commitment_direct(caller, wd, nonce, hash)` і `write_disclosure_direct(caller, wd, args, salt)` — акаунти в порядку контексту, `escrow` **без** `is_signer`.

**Про `Disclosure.owner`:** spec §2.3 розкриває угоду, не трейдера; лишаємо `owner = Pubkey::default()` і фіксуємо в Task 11 (§4.1). Якщо у брейншторм-рішенні захочеться owner — це одна лінія, не архітектура.

- [ ] **Step 4: Зелено** — `anchor build`; `--test disclosure` 2/2; повний LiteSVM 41/41; `cargo test -p dexxer_core` 49; autofixer `disclosure.rs`, `lib.rs`, `mod.rs`.

- [ ] **Step 5: Commit** `feat(core): write_commitment and write_disclosure L1 actions (escrow-signer + source_program gated)`

---

### Task 3: `commit_aggregate` емітує actions (commitment для `Closed`, disclosure для due-записів)

**Files:**
- Modify: `programs/dexxer_core/src/instructions/commit.rs`, `instructions/disclosure.rs` (+ `pending_commitment`, `due_reveals`), `tests/litesvm/src/ixs.rs` (`commit_aggregate(payer, wd, extra: &[AccountMeta])`); Create/Modify: `tests/litesvm/tests/disclosure.rs` (+3 тести)

**Interfaces:**
- Consumes: `commitment_hash`, `DisclosureArgs`, `MAX_ACTIONS_PER_COMMIT`, `ACTION_ESCROW_INDEX`, контексти Task 2.
- Produces: `commit_aggregate(ctx)` приймає `remaining_accounts` = будь-яка суміш `Position` (w) і `DisclosureQueue` (w), обидва owner==program і seeds-звірені; чисті функції `disclosure::pending_commitment(pos:&Position) -> Option<(u64, [u8;32])>` (Some, якщо `Closed && closed.commitment_written == false`), `disclosure::due_reveals(dq:&mut DisclosureQueue, slot:u64, max:usize) -> Vec<(DisclosureArgs, [u8;32])>` (**витягує** з кільця записи `reveal_after_slot <= slot`, ≤max); `commit_aggregate` ставить `commitment_written = true` і серіалізує назад.

- [ ] **Step 1: Тести (червоні)** — додати в `tests/litesvm/tests/disclosure.rs`:

```rust
use dexxer_litesvm::{assert_invariant, token_ix::*, setup::SEED_AMOUNT};
use solana_instruction::AccountMeta;

fn open_then_close(h: &mut Harness, w: &World) -> dexxer_litesvm::setup::Trader {
    let t = w.new_trader(h, 1_000_000_000);
    t.set_price(h, w, 100_00000000); // $100
    h.send(&[ixs::open_position(&t.kp.pubkey(), &t, w, Side::Long, 1_000_000_000, 20_000_000, 101_00000000)], &[&t.kp]).unwrap();
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, w, 0)], &[&t.kp]).unwrap();
    t
}

#[test]
fn commit_aggregate_marks_closed_position_commitment_written() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = open_then_close(&mut h, &w);
    assert!(!h.account::<Position>(&t.position).closed.unwrap().commitment_written);
    let extra = vec![AccountMeta::new(t.position, false)];
    h.send(&[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra)], &[&w.fee_payer]).unwrap();
    let p = h.account::<Position>(&t.position);
    assert_eq!(p.state, PositionState::Closed, "state unchanged until mark_committed");
    assert!(p.closed.unwrap().commitment_written, "flag flips even though Magic CPI is skipped on LiteSVM");
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn commit_aggregate_ignores_open_position() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    t.set_price(&mut h, &w, 100_00000000);
    h.send(&[ixs::open_position(&t.kp.pubkey(), &t, &w, Side::Long, 1_000_000_000, 20_000_000, 101_00000000)], &[&t.kp]).unwrap();
    let extra = vec![AccountMeta::new(t.position, false)];
    h.send(&[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra)], &[&w.fee_payer]).unwrap();
    assert_eq!(h.account::<Position>(&t.position).state, PositionState::Open);
    assert!(h.account::<Position>(&t.position).closed.is_none());
}

#[test]
fn commit_aggregate_rejects_foreign_remaining_account() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let extra = vec![AccountMeta::new(w.market, false)]; // program-owned but neither Position nor DQ
    let r = h.send(&[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra)], &[&w.fee_payer]);
    assert_custom_error(&r, 6000 + DexxerError::InvalidCandidate as u32);
}
```
`World` потребує `pub fee_payer: Keypair` (bootstrap уже передає fee_payer у `init_config` — витягнути в поле, якщо ще не є; перевірити `setup.rs`).

- [ ] **Step 2: Червоно** — compile error на `ixs::commit_aggregate(..., &extra)`.

- [ ] **Step 3: Реалізація.** У `disclosure.rs`:

```rust
/// A closed position whose commitment has not been emitted yet → (nonce, hash).
pub fn pending_commitment(pos: &Position) -> Option<(u64, [u8; 32])> {
    if pos.state != PositionState::Open && pos.state != PositionState::Empty {
        if let Some(rec) = pos.closed.as_ref() {
            if !rec.commitment_written {
                let args = DisclosureArgs::from(rec);
                return Some((rec.nonce, commitment_hash(&args, &rec.salt)));
            }
        }
    }
    None
}

/// Pops up to `max` records whose reveal slot has passed. Ring order is preserved
/// for the remaining records (compaction is O(len), len <= 8).
pub fn due_reveals(dq: &mut DisclosureQueue, slot: u64, max: usize) -> Result<Vec<(DisclosureArgs, [u8; 32])>> {
    let mut out = Vec::new();
    let mut kept: Vec<ClosedRecord> = Vec::new();
    for i in 0..dq.len as usize {
        let idx = (dq.head as usize + i) % DQ_CAPACITY;
        let rec = dq.records[idx];
        if rec.reveal_after_slot <= slot && out.len() < max {
            out.push((DisclosureArgs::from(&rec), rec.salt));
        } else {
            kept.push(rec);
        }
    }
    dq.records = [ClosedRecord::default(); DQ_CAPACITY];
    for (i, r) in kept.iter().enumerate() { dq.records[i] = *r; }
    dq.head = 0;
    dq.len = u8::try_from(kept.len()).map_err(|_| DexxerError::MathOverflow)?;
    Ok(out)
}
```

У `commit.rs`: імпорти `ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta}`, `ephem::CallHandler`, `anchor_lang::{Discriminator, InstructionData}`, `crate::instructions::disclosure::{pending_commitment, due_reveals}`. `CommitAggregate` додає `balances_root` (Task 5 — тут лишити коментар-TODO **не можна**; поле додається в Task 5, зараз контекст без нього). Тіло:

```rust
pub fn commit_aggregate<'info>(ctx: Context<'_, '_, 'info, 'info, CommitAggregate<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    ctx.accounts.pool.last_commit_slot = clock.slot;

    // Collect post-commit actions from remaining_accounts: Position → write_commitment,
    // DisclosureQueue → write_disclosure for due records. Both kinds are seeds-verified
    // and mutated in place (flag / dequeue) so the same account is never emitted twice.
    let mut actions: Vec<CallHandler> = Vec::new();
    let system_program = anchor_lang::system_program::ID;
    for ai in ctx.remaining_accounts.iter() {
        require!(ai.owner == &crate::ID && ai.is_writable, DexxerError::InvalidCandidate);
        let data = ai.try_borrow_data()?;
        let disc: [u8; 8] = data[..8].try_into().map_err(|_| DexxerError::InvalidCandidate)?;
        drop(data);
        if disc == Position::DISCRIMINATOR {
            let mut pos = Position::try_deserialize(&mut &ai.try_borrow_data()?[..])?;
            let (exp, _) = Pubkey::find_program_address(&[POSITION_SEED, pos.owner.as_ref(), pos.market.as_ref()], &crate::ID);
            require!(ai.key() == exp, DexxerError::InvalidCandidate);
            if let Some((nonce, hash)) = pending_commitment(&pos) {
                require!(actions.len() < MAX_ACTIONS_PER_COMMIT, DexxerError::TooManyActions);
                let (commitment, _) = Pubkey::find_program_address(&[COMMIT_SEED, &nonce.to_le_bytes()], &crate::ID);
                let data = crate::instruction::WriteCommitment { nonce, hash }.data();
                actions.push(CallHandler {
                    destination_program: crate::ID,
                    accounts: vec![
                        ShortAccountMeta { pubkey: commitment.to_bytes().into(), is_writable: true },
                        ShortAccountMeta { pubkey: ctx.accounts.config.key().to_bytes().into(), is_writable: false },
                        ShortAccountMeta { pubkey: system_program.to_bytes().into(), is_writable: false },
                    ],
                    args: ActionArgs::new(data),
                    escrow_authority: ctx.accounts.payer.to_account_info(),
                    compute_units: 100_000,
                });
                if let Some(rec) = pos.closed.as_mut() { rec.commitment_written = true; }
                pos.try_serialize(&mut &mut ai.try_borrow_mut_data()?[..])?;
            }
        } else if disc == DisclosureQueue::DISCRIMINATOR {
            let mut dq = DisclosureQueue::try_deserialize(&mut &ai.try_borrow_data()?[..])?;
            let (exp, _) = Pubkey::find_program_address(&[DQ_SEED, dq.owner.as_ref()], &crate::ID);
            require!(ai.key() == exp, DexxerError::InvalidCandidate);
            let room = MAX_ACTIONS_PER_COMMIT.saturating_sub(actions.len());
            for (args, salt) in due_reveals(&mut dq, clock.slot, room)? {
                let (disclosure, _) = Pubkey::find_program_address(&[DISCLOSURE_SEED, &args.nonce.to_le_bytes()], &crate::ID);
                let (commitment, _) = Pubkey::find_program_address(&[COMMIT_SEED, &args.nonce.to_le_bytes()], &crate::ID);
                let data = crate::instruction::WriteDisclosure { args, salt }.data();
                actions.push(CallHandler {
                    destination_program: crate::ID,
                    accounts: vec![
                        ShortAccountMeta { pubkey: disclosure.to_bytes().into(), is_writable: true },
                        ShortAccountMeta { pubkey: commitment.to_bytes().into(), is_writable: false },
                        ShortAccountMeta { pubkey: ctx.accounts.config.key().to_bytes().into(), is_writable: false },
                        ShortAccountMeta { pubkey: system_program.to_bytes().into(), is_writable: false },
                    ],
                    args: ActionArgs::new(data),
                    escrow_authority: ctx.accounts.payer.to_account_info(),
                    compute_units: 120_000,
                });
            }
            dq.try_serialize(&mut &mut ai.try_borrow_mut_data()?[..])?;
        } else {
            return err!(DexxerError::InvalidCandidate);
        }
    }

    if ctx.accounts.magic_program.to_account_info().executable {
        let bump = ctx.accounts.fee_escrow.bump;
        let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &[bump]];
        let builder = MagicIntentBundleBuilder::new(
            ctx.accounts.fee_escrow.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit(&[ctx.accounts.pool.to_account_info()]);
        let builder = if actions.is_empty() { builder } else { builder.add_post_commit_actions(actions) };
        builder.build_and_invoke_signed(&[seeds])?;
    }
    Ok(())
}
```
Lifetimes `Context<'_, '_, 'info, 'info, …>` — як у `crank_tick` (anchor 1.0.2 однолайфтаймовий `Context<'info, T>`; узяти точну форму з `crank.rs`). `escrow_authority = payer` (`Config.fee_payer` — базовий гаманець, його action-escrow `ephemeral_balance_pda_from_payer(fee_payer, 255)` топ-апиться на base у Task 7 bootstrap). `lib.rs` wrapper повторює lifetime-форму `crank_tick`. `ixs::commit_aggregate(payer, wd, extra)` додає `extra` після фіксованих акаунтів.

**Про cap:** `MAX_ACTIONS_PER_COMMIT = 4` — тимчасове; Task 1 M-C дає реальне, Task 8 виставляє виміряне.

- [ ] **Step 4: Зелено** — `--test disclosure` 5/5; LiteSVM 44; autofixer `commit.rs`, `disclosure.rs`, `lib.rs`; tsc ×3.

- [ ] **Step 5: Commit** `feat(core): commit_aggregate emits write_commitment/write_disclosure actions on the Pool commit`

---

### Task 4: `mark_committed` (crank, ER) — `ClosedRecord` → `DisclosureQueue`, `Position → Empty`

**Files:**
- Modify: `instructions/disclosure.rs` (+ `MarkCommitted`, `mark_committed`), `lib.rs`, `tests/litesvm/src/ixs.rs`, `tests/litesvm/tests/disclosure.rs` (+4 тести)

**Interfaces:**
- Produces: `mark_committed(ctx)`, контекст `MarkCommitted { crank: Signer (== config.crank), config, position (mut, seeds, Box), dq (mut, seeds [DQ_SEED, position.owner], Box) }`. Після виклику: `dq.len += 1`, запис у кільці, `position.state == Empty`, `closed == None`, `size/entry/margin/liq_price/oi_notional/liq_ticks/opened_slot == 0`. Повторний `open_position` тим самим трейдером — успішний.

- [ ] **Step 1: Тести (червоні)**:

```rust
#[test]
fn mark_committed_moves_record_and_frees_position() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = open_then_close(&mut h, &w);
    h.send(&[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &[AccountMeta::new(t.position, false)])], &[&w.fee_payer]).unwrap();
    let before = h.account::<Position>(&t.position).closed.unwrap();
    h.send(&[ixs::mark_committed(&w.crank.pubkey(), &t, &w)], &[&w.crank]).unwrap();
    let p = h.account::<Position>(&t.position);
    assert_eq!(p.state, PositionState::Empty);
    assert!(p.closed.is_none());
    assert_eq!((p.size, p.entry, p.margin, p.liq_price, p.oi_notional, p.liq_ticks, p.opened_slot), (0, 0, 0, 0, 0, 0, 0));
    let dq = h.account::<DisclosureQueue>(&t.dq);
    assert_eq!(dq.len, 1);
    assert_eq!(dq.records[dq.head as usize].nonce, before.nonce);
    assert_eq!(dq.records[dq.head as usize].salt, before.salt);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn mark_committed_requires_commitment_written() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = open_then_close(&mut h, &w); // no commit_aggregate
    let r = h.send(&[ixs::mark_committed(&w.crank.pubkey(), &t, &w)], &[&w.crank]);
    assert_custom_error(&r, 6000 + DexxerError::CommitmentNotWritten as u32);
}

#[test]
fn mark_committed_only_by_crank() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = open_then_close(&mut h, &w);
    h.send(&[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &[AccountMeta::new(t.position, false)])], &[&w.fee_payer]).unwrap();
    let r = h.send(&[ixs::mark_committed(&t.kp.pubkey(), &t, &w)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
}

#[test]
fn second_position_after_mark_committed() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = open_then_close(&mut h, &w);
    h.send(&[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &[AccountMeta::new(t.position, false)])], &[&w.fee_payer]).unwrap();
    h.send(&[ixs::mark_committed(&w.crank.pubkey(), &t, &w)], &[&w.crank]).unwrap();
    // The week-1/2 "one position per trader per run" limit is gone:
    h.send(&[ixs::open_position(&t.kp.pubkey(), &t, &w, Side::Short, 500_000_000, 10_000_000, 99_00000000)], &[&t.kp]).unwrap();
    assert_eq!(h.account::<Position>(&t.position).state, PositionState::Open);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn mark_committed_queue_full() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 10_000_000_000);
    t.set_price(&mut h, &w, 100_00000000);
    for _ in 0..DQ_CAPACITY {
        h.send(&[ixs::open_position(&t.kp.pubkey(), &t, &w, Side::Long, 1_000_000_000, 20_000_000, 101_00000000)], &[&t.kp]).unwrap();
        h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp]).unwrap();
        h.send(&[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &[AccountMeta::new(t.position, false)])], &[&w.fee_payer]).unwrap();
        h.send(&[ixs::mark_committed(&w.crank.pubkey(), &t, &w)], &[&w.crank]).unwrap();
    }
    h.send(&[ixs::open_position(&t.kp.pubkey(), &t, &w, Side::Long, 1_000_000_000, 20_000_000, 101_00000000)], &[&t.kp]).unwrap();
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp]).unwrap();
    h.send(&[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &[AccountMeta::new(t.position, false)])], &[&w.fee_payer]).unwrap();
    let r = h.send(&[ixs::mark_committed(&w.crank.pubkey(), &t, &w)], &[&w.crank]);
    assert_custom_error(&r, 6000 + DexxerError::QueueFull as u32);
}
```

- [ ] **Step 2: Червоно** — compile error `ixs::mark_committed`.

- [ ] **Step 3: Реалізація** (у `disclosure.rs`):

```rust
#[derive(Accounts)]
pub struct MarkCommitted<'info> {
    pub crank: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump,
        constraint = crank.key() == config.crank @ DexxerError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POSITION_SEED, position.owner.as_ref(), position.market.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [DQ_SEED, position.owner.as_ref()], bump = dq.bump)]
    pub dq: Box<Account<'info, DisclosureQueue>>,
}

/// Crank observed the `Commitment` PDA on base (the ER cannot read L1 — spec
/// risk #2) and now retires the closed record into the disclosure ring,
/// returning the position to `Empty` so the trader can open again. Crank-
/// asserted by design (spec risk #20); the L1 `Commitment` is public, so a
/// crank that lies here is visible to anyone after the fact.
pub fn mark_committed(ctx: Context<MarkCommitted>) -> Result<()> {
    let pos = &mut ctx.accounts.position;
    require!(pos.state == PositionState::Closed, DexxerError::NotClosed);
    let rec = pos.closed.ok_or(DexxerError::NotClosed)?;
    require!(rec.commitment_written, DexxerError::CommitmentNotWritten);
    let dq = &mut ctx.accounts.dq;
    require!((dq.len as usize) < DQ_CAPACITY, DexxerError::QueueFull);
    let idx = (dq.head as usize).checked_add(dq.len as usize).ok_or(DexxerError::MathOverflow)? % DQ_CAPACITY;
    dq.records[idx] = rec;
    dq.len = dq.len.checked_add(1).ok_or(DexxerError::MathOverflow)?;
    pos.closed = None;
    pos.state = PositionState::Empty;
    pos.side = Side::Long;
    pos.size = 0; pos.entry = 0; pos.margin = 0; pos.liq_price = 0;
    pos.opened_slot = 0; pos.liq_ticks = 0; pos.oi_notional = 0;
    Ok(())
}
```
`lib.rs`: `pub fn mark_committed(ctx: Context<MarkCommitted>) -> Result<()>`. `ixs::mark_committed(crank, t, w)`.

- [ ] **Step 4: Зелено** — `--test disclosure` 10/10; LiteSVM 49; `cargo test -p dexxer_core` 49; autofixer.

- [ ] **Step 5: Commit** `feat(core): mark_committed retires closed record into DisclosureQueue and frees Position`

---

### Task 5: `BalancesRoot` — init/delegate (admin) і `set_balances_root` (crank); коміт разом із `Pool`

**Files:**
- Create: `programs/dexxer_core/src/instructions/root.rs`; `tests/litesvm/tests/root.rs`
- Modify: `instructions/commit.rs` (+ `balances_root` у контексті і в `.commit(&[pool, balances_root])`), `mod.rs`, `lib.rs`, `tests/litesvm/src/{ixs,pdas,setup}.rs` (`World.balances_root`, bootstrap викликає `init_balances_root`)

**Interfaces:**
- Produces: `init_balances_root(ctx)` (admin, L1, `init` PDA `[BALANCES_ROOT_SEED]`), `delegate_balances_root(ctx)` (admin, L1, `#[delegate]` + `del`, як `delegate_fee_escrow`), `set_balances_root(ctx, begin: bool, finalize: bool, padding_seed: [u8;32])` (crank, ER): `remaining_accounts` = `UserAccount`-и (≤ `ROOT_BATCH`, owner==program, seeds `[USER_SEED, owner]`); `begin` → `root_slot = clock.slot, filled = 0`; кожен акаунт → `leaves[filled] = leaf(owner, free_margin, exit_salt, root_slot)`, `filled += 1` (`RootFull` при 64); `finalize` → `leaves[filled..64] = pad(seed, i)`. `commit_aggregate` комітить `&[pool, balances_root]`.

- [ ] **Step 1: Тести (червоні)** `tests/litesvm/tests/root.rs`:

```rust
use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{assert_custom_error, ixs, setup::World, Harness};
use solana_instruction::AccountMeta;
use solana_signer::Signer;

#[test]
fn root_leaves_are_program_computed_from_real_accounts() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let a = w.new_trader(&mut h, 1_000_000_000);
    let b = w.new_trader(&mut h, 2_000_000_000);
    let seed = [0xabu8; 32];
    let metas = vec![AccountMeta::new_readonly(a.user, false), AccountMeta::new_readonly(b.user, false)];
    h.send(&[ixs::set_balances_root(&w.crank.pubkey(), &w, true, true, seed, &metas)], &[&w.crank]).unwrap();
    let root = h.account::<BalancesRoot>(&w.balances_root);
    let ua = h.account::<UserAccount>(&a.user);
    let ub = h.account::<UserAccount>(&b.user);
    assert_eq!(root.filled, 2);
    assert_eq!(root.leaves[0], leaf(&a.kp.pubkey().into_anchor(), ua.free_margin, &ua.exit_salt, root.root_slot));
    assert_eq!(root.leaves[1], leaf(&b.kp.pubkey().into_anchor(), ub.free_margin, &ub.exit_salt, root.root_slot));
    for i in 2..ROOT_LEAVES { assert_eq!(root.leaves[i], pad(&seed, i as u8), "padding slot {i}"); }
}

#[test]
fn root_slot_binding_changes_every_leaf() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let a = w.new_trader(&mut h, 1_000_000_000);
    let metas = vec![AccountMeta::new_readonly(a.user, false)];
    h.send(&[ixs::set_balances_root(&w.crank.pubkey(), &w, true, true, [1u8; 32], &metas)], &[&w.crank]).unwrap();
    let l1 = h.account::<BalancesRoot>(&w.balances_root).leaves[0];
    let slot = h.svm.get_sysvar::<solana_clock::Clock>().slot;
    h.warp(slot + 10, 1_000_000);
    h.send(&[ixs::set_balances_root(&w.crank.pubkey(), &w, true, true, [1u8; 32], &metas)], &[&w.crank]).unwrap();
    let l2 = h.account::<BalancesRoot>(&w.balances_root).leaves[0];
    assert_ne!(l1, l2, "same balance, new slot → new leaf (unlinkable across commits)");
}

#[test]
fn set_balances_root_only_by_crank_and_rejects_foreign_account() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let a = w.new_trader(&mut h, 1_000_000_000);
    let metas = vec![AccountMeta::new_readonly(a.user, false)];
    let r = h.send(&[ixs::set_balances_root(&a.kp.pubkey(), &w, true, true, [1u8; 32], &metas)], &[&a.kp]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    let bad = vec![AccountMeta::new_readonly(w.market, false)];
    let r = h.send(&[ixs::set_balances_root(&w.crank.pubkey(), &w, true, true, [1u8; 32], &bad)], &[&w.crank]);
    assert_custom_error(&r, 6000 + DexxerError::InvalidLeafAccount as u32);
}

#[test]
fn set_balances_root_batches_and_caps_at_64() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let a = w.new_trader(&mut h, 1_000_000_000);
    let one = vec![AccountMeta::new_readonly(a.user, false)];
    h.send(&[ixs::set_balances_root(&w.crank.pubkey(), &w, true, false, [1u8; 32], &one)], &[&w.crank]).unwrap();
    for _ in 1..ROOT_LEAVES {
        h.send(&[ixs::set_balances_root(&w.crank.pubkey(), &w, false, false, [1u8; 32], &one)], &[&w.crank]).unwrap();
    }
    assert_eq!(h.account::<BalancesRoot>(&w.balances_root).filled as usize, ROOT_LEAVES);
    let r = h.send(&[ixs::set_balances_root(&w.crank.pubkey(), &w, false, false, [1u8; 32], &one)], &[&w.crank]);
    assert_custom_error(&r, 6000 + DexxerError::RootFull as u32);
}
```
(`into_anchor()` — існуючий хелпер `apk`/`pk` у `dexxer_litesvm` для конверсії Pubkey; використати той, що є: `dexxer_litesvm::apk(a.kp.pubkey())`.)

- [ ] **Step 2: Червоно** — compile error.

- [ ] **Step 3: Реалізація** `instructions/root.rs`:

```rust
use crate::{errors::DexxerError, state::*};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

#[derive(Accounts)]
pub struct InitBalancesRoot<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + BalancesRoot::INIT_SPACE, seeds = [BALANCES_ROOT_SEED], bump)]
    pub balances_root: Account<'info, BalancesRoot>,
    pub system_program: Program<'info, System>,
}
pub fn init_balances_root(ctx: Context<InitBalancesRoot>) -> Result<()> {
    let r = &mut ctx.accounts.balances_root;
    r.version = 1;
    r.bump = ctx.bumps.balances_root;
    Ok(())
}

// Same shape as `DelegateFeeEscrow` (instructions/admin.rs) — copy its account list
// (buffer/delegation_record/delegation_metadata/owner_program/delegation_program) verbatim,
// replacing `fee_escrow` by `balances_root` with seeds `[BALANCES_ROOT_SEED]`.
#[delegate]
#[derive(Accounts)]
pub struct DelegateBalancesRoot<'info> { /* mirror DelegateFeeEscrow, account `balances_root` marked `del` */ }
pub fn delegate_balances_root(ctx: Context<DelegateBalancesRoot>) -> Result<()> {
    ctx.accounts.delegate_balances_root(
        &ctx.accounts.admin,
        &[BALANCES_ROOT_SEED],
        DelegateConfig { validator: Some(ctx.accounts.config.tee_validator), ..Default::default() },
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct SetBalancesRoot<'info> {
    pub crank: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump,
        constraint = crank.key() == config.crank @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [BALANCES_ROOT_SEED], bump = balances_root.bump)]
    pub balances_root: Box<Account<'info, BalancesRoot>>,
}

/// Leaves are computed HERE from the real `UserAccount` bytes — the crank chooses
/// which accounts to include (it can omit a user: spec risk #19) but cannot forge
/// a balance. `padding_seed` is never stored, so padding is indistinguishable.
pub fn set_balances_root<'info>(
    ctx: Context<'_, '_, 'info, 'info, SetBalancesRoot<'info>>,
    begin: bool, finalize: bool, padding_seed: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let root = &mut ctx.accounts.balances_root;
    if begin { root.root_slot = clock.slot; root.filled = 0; }
    require!(ctx.remaining_accounts.len() <= ROOT_BATCH, DexxerError::InvalidLeafAccount);
    for ai in ctx.remaining_accounts.iter() {
        require!(ai.owner == &crate::ID, DexxerError::InvalidLeafAccount);
        let ua = UserAccount::try_deserialize(&mut &ai.try_borrow_data()?[..])
            .map_err(|_| DexxerError::InvalidLeafAccount)?;
        let (exp, _) = Pubkey::find_program_address(&[USER_SEED, ua.owner.as_ref()], &crate::ID);
        require!(ai.key() == exp, DexxerError::InvalidLeafAccount);
        let i = root.filled as usize;
        require!(i < ROOT_LEAVES, DexxerError::RootFull);
        root.leaves[i] = leaf(&ua.owner, ua.free_margin, &ua.exit_salt, root.root_slot);
        root.filled = root.filled.checked_add(1).ok_or(DexxerError::MathOverflow)?;
    }
    if finalize {
        for i in (root.filled as usize)..ROOT_LEAVES {
            root.leaves[i] = pad(&padding_seed, u8::try_from(i).map_err(|_| DexxerError::MathOverflow)?);
        }
    }
    Ok(())
}
```
Заповнити `DelegateBalancesRoot` — скопіювати `DelegateFeeEscrow` з `admin.rs` точно (той файл — джерело правди для полів `#[delegate]`-контексту в цьому репо). `commit.rs`: `CommitAggregate` + `#[account(mut, seeds = [BALANCES_ROOT_SEED], bump = balances_root.bump)] pub balances_root: Box<Account<'info, BalancesRoot>>` і `.commit(&[pool, balances_root])`. `mod.rs`/`lib.rs` wiring (три ixs). `setup.rs::bootstrap`: після `init_fee_escrow` — `init_balances_root`; `World.balances_root = pdas::balances_root()`. `ixs::commit_aggregate` додає `balances_root`.

- [ ] **Step 4: Зелено** — `--test root` 4/4; LiteSVM 53; unit 49; autofixer `root.rs`, `commit.rs`, `lib.rs`, `mod.rs`; tsc.

- [ ] **Step 5: Commit** `feat(core): BalancesRoot — program-computed slot-bound leaves, padded to 64, committed with Pool`

---

### Task 6: `undelegate_user` — скраб → закрити permission ×3 → `commit_and_undelegate`

**Files:**
- Modify: `instructions/user.rs` (+ `UndelegateUser`, `undelegate_user`), `lib.rs`, `tests/litesvm/src/ixs.rs`; Create: `tests/litesvm/tests/undelegate.rs`

**Interfaces:**
- Consumes: Task 1 M-A (якщо M-A показав, що після `CloseEphemeralPermissionCpi` undelegate **не** долітає, а без нього — долітає: прибрати крок закриття permission і задокументувати; **скраб лишається за будь-яких умов**).
- Produces: `undelegate_user(ctx)` (owner, ER). Guards: `position.state == Empty` → `HasOpenPosition`; `dq.len == 0` → `QueueNotEmpty`; `free_margin == 0 && locked_margin == 0` → `BalanceNotZero`. Скраб: `UserAccount{session_key=default, session_expiry=0, actions_left=0, exit_salt=[0;32], nonce=0}`, `Position` вже Empty-нульова, `DisclosureQueue{head=0,len=0,records=default}`. Контекст = `SetSession`'s permission-акаунти (`user_permission`, `position_permission`, `dq_permission`, `ephemeral_vault`, `permission_program`) + `fee_escrow`, `magic_fee_vault`, `magic_context`, `magic_program`.

- [ ] **Step 1: Тести (червоні)** `tests/litesvm/tests/undelegate.rs`:

```rust
use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{assert_custom_error, ixs, setup::World, Harness};
use solana_signer::Signer;

#[test]
fn undelegate_rejected_with_open_position() {
    let mut h = Harness::new(); let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    t.set_price(&mut h, &w, 100_00000000);
    h.send(&[ixs::open_position(&t.kp.pubkey(), &t, &w, Side::Long, 1_000_000_000, 20_000_000, 101_00000000)], &[&t.kp]).unwrap();
    let r = h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::HasOpenPosition as u32);
}

#[test]
fn undelegate_rejected_with_balance() {
    let mut h = Harness::new(); let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000); // free_margin = 1000
    let r = h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::BalanceNotZero as u32);
}

#[test]
fn undelegate_scrubs_after_full_withdraw() {
    let mut h = Harness::new(); let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, &w, 1_000_000_000)], &[&t.kp]).unwrap();
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp]).unwrap();
    let u = h.account::<UserAccount>(&t.user);
    assert_eq!(u.session_key, anchor_lang::prelude::Pubkey::default());
    assert_eq!((u.session_expiry, u.actions_left, u.nonce), (0, 0, 0));
    assert_eq!(u.exit_salt, [0u8; 32]);
    assert_eq!(u.owner, dexxer_litesvm::apk(t.kp.pubkey()), "owner kept — it is the PDA seed");
    let dq = h.account::<DisclosureQueue>(&t.dq);
    assert_eq!((dq.head, dq.len), (0, 0));
}

#[test]
fn undelegate_only_by_owner() {
    let mut h = Harness::new(); let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, &w, 1_000_000_000)], &[&t.kp]).unwrap();
    let r = h.send(&[ixs::undelegate_user(&w.crank.pubkey(), &t, &w)], &[&w.crank]);
    assert!(r.is_err()); // seeds/has_one — same shape as withdraw_by_session_rejected (ConstraintSeeds 2006)
}
```

- [ ] **Step 2: Червоно.**

- [ ] **Step 3: Реалізація** (у `user.rs`; контекст копіює `SetSession`'s permission-поля + `Withdraw`'s magic-поля):

```rust
#[derive(Accounts)]
pub struct UndelegateUser<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_account.bump, has_one = owner)]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(mut, seeds = [POSITION_SEED, owner.key().as_ref(), position.market.as_ref()], bump = position.bump, has_one = owner)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [DQ_SEED, owner.key().as_ref()], bump = dq.bump, has_one = owner)]
    pub dq: Box<Account<'info, DisclosureQueue>>,
    // --- same permission accounts as SetSession (copy the three PDAs + vault + permission_program verbatim) ---
    /// CHECK: permission PDA of user_account (seeds::program = PERMISSION_PROGRAM_ID)
    #[account(mut)] pub user_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of position
    #[account(mut)] pub position_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of dq
    #[account(mut)] pub dq_permission: UncheckedAccount<'info>,
    /// CHECK: ephemeral vault (as in SetSession)
    #[account(mut)] pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: permission program
    pub permission_program: UncheckedAccount<'info>,
    // --- same magic accounts as Withdraw ---
    #[account(mut, seeds = [FEE_ESCROW_SEED], bump = fee_escrow.bump)]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: constrained to Config.magic_fee_vault (as in Withdraw)
    #[account(mut, constraint = magic_fee_vault.key() == config.magic_fee_vault @ DexxerError::Unauthorized)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    /// CHECK: as in Withdraw
    #[account(mut, address = MAGIC_CONTEXT_ID)] pub magic_context: UncheckedAccount<'info>,
    /// CHECK: as in Withdraw
    #[account(address = MAGIC_PROGRAM_ID)] pub magic_program: UncheckedAccount<'info>,
}

/// Exit with a live TEE (spec §2.4.3). Order matters: scrub first (nothing
/// private may survive into a public commit), close the three permissions
/// (the accounts become public — safe, they are empty now), then commit-and-
/// undelegate so the PDAs return to this program on L1. Whether the TEE lets
/// a just-un-permissioned account through is measurement M-A (week3-results).
pub fn undelegate_user(ctx: Context<UndelegateUser>) -> Result<()> {
    let a = &mut ctx.accounts;
    require!(a.position.state == PositionState::Empty, DexxerError::HasOpenPosition);
    require!(a.dq.len == 0, DexxerError::QueueNotEmpty);
    require!(a.user_account.free_margin == 0 && a.user_account.locked_margin == 0, DexxerError::BalanceNotZero);
    // scrub
    let u = &mut a.user_account;
    u.session_key = Pubkey::default(); u.session_expiry = 0; u.actions_left = 0; u.nonce = 0; u.exit_salt = [0; 32];
    a.dq.head = 0; a.dq.len = 0; a.dq.records = [ClosedRecord::default(); DQ_CAPACITY];
    // close permissions — same conditional (perm.owner == PERMISSION_PROGRAM_ID) + invoke_signed pattern
    // as set_session's UpdateEphemeralPermissionCpi, using CloseEphemeralPermissionCpi for each PDA.
    close_permission_if_present(/* user_account, its seeds, user_permission, vault, program */)?;
    close_permission_if_present(/* position ... */)?;
    close_permission_if_present(/* dq ... */)?;
    if a.magic_program.to_account_info().executable {
        let bump = a.fee_escrow.bump;
        let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &[bump]];
        MagicIntentBundleBuilder::new(a.fee_escrow.to_account_info(), a.magic_context.to_account_info(), a.magic_program.to_account_info())
            .magic_fee_vault(a.magic_fee_vault.to_account_info())
            .commit_and_undelegate(&[a.user_account.to_account_info(), a.position.to_account_info(), a.dq.to_account_info()])
            .build_and_invoke_signed(&[seeds])?;
    }
    Ok(())
}
```
`close_permission_if_present` — приватний хелпер у `user.rs`, побудований **точно** за наявним `UpdateEphemeralPermissionCpi`-блоком `set_session` (той самий authority-PDA, ті самі seeds, `invoke_signed`), але з `CloseEphemeralPermissionCpi` (поля — з `ephemeral_rollups_sdk::access_control` у `~/.cargo/registry/src/*/ephemeral-rollups-sdk-0.16.2/src/access_control/`; звірити, не вгадувати). На LiteSVM permission відсутній → крок пропускається (як у `set_session`).

- [ ] **Step 4: Зелено** — `--test undelegate` 4/4; LiteSVM 57; autofixer `user.rs`, `lib.rs`; tsc.

- [ ] **Step 5: Commit** `feat(core): undelegate_user — scrub, close permissions, commit_and_undelegate`

---

### Task 7: Crank-скрипт: цикли розкриття й root-у; bootstrap `BalancesRoot` + action-escrow

**Files:**
- Create: `scripts/crank-fallback/disclosure.ts`
- Modify: `scripts/crank-fallback/index.ts` (виклик кожні `DISCLOSURE_EVERY_TICKS = 300`), `scripts/admin/devnet-bootstrap.ts`, `tests/er/lib/admin.ts` (`bootstrapDevnet`: `init_balances_root`, `delegate_balances_root`, escrow top-up), `tests/er/lib/program.ts` (+ `pdas.commitment(nonce)`, `pdas.disclosure(nonce)`, `pdas.balancesRoot()`, `commitmentHash(args, salt)`, `leaf(owner, freeMargin, salt, slot)` — keccak через `@noble/hashes/sha3` `keccak_256` (уже в дереві залежностей web3.js; перевірити `npm ls @noble/hashes`), `DQ_DISC`, `USER_DISC`)

**Interfaces:**
- Consumes: усі ixs Tasks 3–5; `MAX_ACTIONS_PER_COMMIT` (виміряне в M-C).
- Produces: `runRootCycle(ctx)`: gPA `UserAccount` (crank-токен, memcmp по дискримінатору) → батчі по 16 → `set_balances_root(begin=i==0, finalize=i==last, seed=randomBytes(32))`. `runDisclosureCycle(ctx)`: (1) gPA `Position` → фільтр `state==Closed && closed.commitment_written==false`; gPA `DisclosureQueue` → фільтр «є запис із `reveal_after_slot <= slot`»; зібрати ≤`MAX_ACTIONS_PER_COMMIT` акаунтів → **один** `commit_aggregate` підписом `devnet-fee-payer` з `remaining_accounts`; (2) для кожної `Position` з `commitment_written==true`: base `getAccountInfo(pdas.commitment(nonce))` — якщо існує → `mark_committed` (crank). Обидва цикли раз на 300 тіків, root **перед** disclosure (щоб коміт ніс свіжий root). Логи: `root: filled=N slot=S`, `commit_aggregate: sig … actions=K`, `mark_committed: owner=… nonce=… sig …`.
- Bootstrap: `init_balances_root` → `delegate_balances_root`; `createTopUpEscrowInstruction(escrowPdaFromEscrowAuthority(feePayer.publicKey), feePayer.publicKey, 0.05 SOL)` на base (fee payer — escrow authority для actions). Ідемпотентно (перевірка існування PDA / балансу escrow ≥ 0.02 SOL).

- [ ] Реалізувати → `npx tsc --noEmit` у `scripts` і `tests/er` → локальна перевірка на mb-stack **не потрібна** (Magic Actions там не емулюються) — перевірка на devnet у Task 8.
- [ ] **Commit** `feat(scripts): crank disclosure/root cycles on the 5-min Pool commit; bootstrap BalancesRoot and action escrow`

---

### Task 8: Редеплой + devnet-скрипти 06/07/08 (M-B, M-E)

**Files:**
- Create: `tests/er/devnet/06-commitment-reveal.ts`, `07-balances-root.ts`, `08-undelegate.ts`; Modify: `tests/er/package.json` (`devnet:disclosure|root|undelegate`), `state/mod.rs` (`MAX_ACTIONS_PER_COMMIT` = виміряне M-C, якщо ≠ 4), `docs/superpowers/plans/week3-results.md` §Task 8

**Кроки:**
- [ ] **Редеплой** (`anchor build`; якщо бінарник виріс — `solana program extend G2okX5… <bytes> -u devnet -k spikes/keys/payer.json`; `anchor deploy --provider.cluster devnet --provider.wallet spikes/keys/payer.json --program-name dexxer_core`); `devnet-bootstrap.ts` (ідемпотентно: BalancesRoot + escrow). Записати підписи/баланс payer.
- [ ] **06-commitment-reveal (M-B):** свіжий трейдер → onboard (з `exit_salt`) → open Long → close → зняти `ClosedRecord` через owner-TEE (`nonce`, `salt`, поля) → `runDisclosureCycle` (або прямо `commit_aggregate` з `remaining_accounts=[position]`) → **poll base до появи `Commitment[nonce]`** (≤120 с) → assert `Commitment.hash == commitmentHash(args, salt)` (TS-реалізація з `program.ts`) → `mark_committed` (crank) → assert TEE: `Position.state==Empty`, `DisclosureQueue.len==1` → **друга позиція** тим самим трейдером: open → assert Open → close → чекати `slot >= reveal_after_slot` (bootstrap `disclosure_delay_slots` малий — у devnet Config уже виставлений; якщо >600 слотів, `set_params`-подібного ix нема → використати наявне значення й чекати, або записати обмеження) → `commit_aggregate` з `remaining_accounts=[dq]` → poll base `Disclosure[nonce]` → assert поля == `ClosedRecord` і `Disclosure.owner == default`. **PASS-рядки:** `M-B commitment landed`, `hash matches`, `second position opened`, `disclosure landed`, `hash verified on-chain`.
- [ ] **07-balances-root (M-E):** `runRootCycle` + `commit_aggregate` → poll base `BalancesRoot.root_slot` до оновлення → owner-TEE читає `free_margin`, `exit_salt` → assert `leaf(owner, fm, salt, root_slot) ∈ leaves` → assert `filled` ≤ реальна кількість трейдерів і решта слотів ≠ жодному реальному листку → два коміти поспіль: assert **усі 64 листки змінились**. Записати ER-баланс `FeeEscrow` до/після 12 комітів **двох** акаунтів (`M-E`), порівняти з тижнем-2 (один акаунт).
- [ ] **08-undelegate:** трейдер із 06 після reveal (черга порожня) → `withdraw(all)` → `undelegate_user` (owner-TEE) → poll base ≤180 с: `UserAccount/Position/DisclosureQueue.owner == G2okX5…` (не `DELeGG…`) і байти скрабнуті (session_key=default, salt=0) → **PASS `M-A confirmed on dexxer_core`**. Якщо не долітає — записати з підписами (як #13), не латати наосліп.
- [ ] Записати все в `week3-results.md` §Task 8 (підписи, PDA, таблиця M-B/M-E, cap M-C, cost). **Commit** `test(devnet): commitment→reveal round trip with second position, balances-root receipt, undelegate exit`

---

### Task 9: Мобілка — `live.ts`, History-таб, Receipt-секція, повторний Open

**Files:**
- Create: `app/src/lib/live.ts` (перенести `useLiveAccount` з `PositionScreen.tsx`, експортувати), `app/src/features/history/HistoryScreen.tsx`, `app/src/features/receipt/ReceiptSection.tsx`, `app/app/(tabs)/history.tsx`
- Modify: `app/src/features/trade/PositionScreen.tsx` (імпорт з `live.ts`), `app/src/lib/program.ts` (+ `decodeDisclosureQueue(data): {head,len,records: DecodedClosedRecord[]}` фіксовані офсети з `state/disclosure.rs` — вивести й задокументувати як для `Position`; `decodeDisclosure`, `decodeBalancesRoot`, `readUserAccountExitSalt(data)` (офсет після `last_withdraw_slot`), `leafHex(owner, fm, salt, slot)` keccak через `@noble/hashes/sha3`), `app/src/lib/pdas.ts` (+ `commitment(nonce)`, `disclosure(nonce)`, `balancesRoot()`), `app/app/(tabs)/_layout.tsx` (+ History), `app/app/(tabs)/account/*` (Receipt-секція), `app/src/idl/dexxer_core.json` (перекопіювати з `target/idl/` після Task 6 — байт-у-байт, як у тижні 2)

**Interfaces:**
- HistoryScreen: owner-TEE `useLiveAccount(dq)` → список записів: `side/size/entry/exit/pnl/closed_slot`, статус — `reveal_after_slot > slot ? «розкриється через N слотів» : «розкрито ✓»`; для `Disclosure` — base `getProgramAccounts(DEXXER_CORE_PROGRAM_ID, {filters:[memcmp disc(Disclosure)]})` (§8 Q5) з фільтром по `nonce`-ам, що були в черзі юзера (нонси зберігає застосунок у `expo-secure-store` `dexxer.nonces.<owner>` при виявленні запису в DQ — бо `Disclosure.owner == default`, інакше не звʼязати).
- ReceiptSection: owner-TEE `UserAccount` (`free_margin`, `exit_salt`) + base `BalancesRoot` → `leafHex` → `leaves.includes` → «Засвідчено публічним root-ом на слоті S ✓ / ще не включено (наступний коміт ≤5 хв)».
- Trade: після `mark_committed` `hasOpenPosition=false` → форма Open доступна (нічого не змінюється — перевірити живим прогоном).

- [ ] Реалізувати; `npx tsc --noEmit`, `npx expo lint` чисто; емулятор: onboard → open → close → (crank виконує cycle) → History показує запис → після `mark_committed` Trade дозволяє другий Open → Receipt показує ✓ після наступного коміту. Скріншоти в `docs/superpowers/plans/assets/`.
- [ ] **Commit** `feat(app): History tab and balances-root Receipt; extract useLiveAccount`

---

### Task 10: CI (GitHub Actions)

**Files:**
- Create: `.github/workflows/ci.yml`

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  program:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { toolchain: "1.89" }
      - uses: dtolnay/rust-toolchain@master
        with: { toolchain: nightly-2026-09-18 }
      - name: Install Solana CLI
        run: |
          sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.9/install)"
          echo "$HOME/.local/share/solana/install/active_release/bin" >> "$GITHUB_PATH"
      - name: Install Anchor 1.0.2
        run: cargo install --git https://github.com/solana-foundation/anchor avm --locked && avm install 1.0.2 && avm use 1.0.2
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --check
      - run: cargo clippy -p dexxer_core -p mock_oracle -- -D warnings
      - run: anchor build
      - run: cargo test -p dexxer_core -p mock_oracle
      - run: cargo +nightly-2026-09-18 test -p dexxer_litesvm
  typescript:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "24.18.0" }
      - run: cd tests/er && npm ci && npx tsc --noEmit
      - run: cd scripts && npm ci && npx tsc --noEmit
      - run: cd app && npm ci && npx tsc --noEmit && npx expo lint
```
- [ ] Перевірити версії: `avm`/Anchor install URL і Solana release URL — узяти з `docs/superpowers/plans/week1-results.md`/`CLAUDE.md` тулчейну, якщо там зафіксовано інакше. Devnet-скрипти **не** в CI. Якщо `anchor build` у CI > 40 хв — винести LiteSVM-крок у окремий job з кешем `target/`.
- [ ] **Commit** `ci: GitHub Actions — fmt, clippy, anchor build, unit + LiteSVM, tsc x3, expo lint`

---

### Task 11: Документи, spec, CLAUDE.md, PR

- [ ] **Spec:** §2.4 — «sha256» → «keccak256 (`solana_keccak_hasher`, той самий, що `salt`)»; §2.4.1 — `reveal` виконується всередині `commit_aggregate` (єдиний bundle), не окремим ix; §2.4.2 — сигнатура `set_balances_root(begin, finalize, padding_seed)`; §4.1 — `Commitment`/`Disclosure` (з `owner = default`, `version`, `bump`), `BalancesRoot`, `UserAccount.exit_salt`; §4.2 — 8 нових рядків з фактичними сигнатурами; §4.3 — 9 нових помилок 6031–6039; §7.1 #19–21 — фактичні виміри (M-A результат, cap M-C, M-E cost); §8 п.9–13 — закрити виміряним; §7.3 — фактичний скоуп/дати тижня 3.
- [ ] **`week3-results.md`** повний (Tasks 0–10, виміри, підписи, cost, скріншоти). **CLAUDE.md:** правила тижня 3 (actions лише на коміті `Pool`; keccak-канон commitment/leaf; `commit_aggregate` = єдиний bundle `Pool`+`BalancesRoot`+actions; `mark_committed` crank-асертований; `MAX_ACTIONS_PER_COMMIT`; LiteSVM 57; CI). **`docs/superpowers/plans/week0-gate.md`:** статус Colosseum-правил.
- [ ] **Гаунтлет:** fmt, clippy, `anchor build`, unit 49, LiteSVM 57, tsc ×3, expo lint. PR у `main` (тіло — як тиждень 2: що зроблено, виміряні рішення, чесні відкриті пункти, людські кроки).
- [ ] **Commit** `docs(week3): spec amendments, results, CLAUDE.md rules, PR body`

---

## Не в цьому плані (тиждень 4+)

Локальні push; TEE-атестація в застосунку; increase/decrease UI; Railway для crank; merkle-root (N>64); root у програмі; власний vault / суверенний exit (§2.4.5); `MarketRisk.buckets`; uniform tx shape (ризик #4); Seeker-пристрій, відео, подача — тиждень 4.

---

## Self-review (виконано при написанні)

**Spec coverage §2.4:** 2.4.1 — Tasks 2/3/4 (write_commitment, write_disclosure, commit_aggregate actions, mark_committed; reveal усередині commit_aggregate — задокументовано в Task 11); 2.4.2 — Tasks 0/5/7/8 (exit_salt, BalancesRoot, set_balances_root, root cycle, 07-скрипт), Receipt — Task 9; 2.4.3 — Task 6 + 08; 2.4.4 — Task 1 (M-A/M-C/M-D) + Task 8 (M-B/M-E); 2.4.5 — Task 11 (запис апгрейдів уже в spec, план не кодить); History — Task 9; CI — Task 10; ризики #19–21 — Task 11.

**Type consistency:** `DisclosureArgs`/`commitment_hash(&DisclosureArgs,&[u8;32])` — однакові в Tasks 0/2/3; `pending_commitment(&Position)->Option<(u64,[u8;32])>` і `due_reveals(&mut DisclosureQueue,u64,usize)->Result<Vec<(DisclosureArgs,[u8;32])>>` — Task 3 визначає, Task 3 використовує; `leaf(&Pubkey,u64,&[u8;32],u64)`/`pad(&[u8;32],u8)` — Task 0 визначає, Task 5 використовує; `set_balances_root(begin,finalize,padding_seed)` — Tasks 5/7/8 однаково; `ixs::commit_aggregate(payer,wd,&[AccountMeta])` — Tasks 3/4/5; `World.fee_payer`, `World.balances_root` — Tasks 3/5; `MAX_ACTIONS_PER_COMMIT` — Tasks 0/3/7/8.

**Placeholder scan:** єдина навмисна «дірка» — `DelegateBalancesRoot` тіло та `close_permission_if_present` подані як «скопіювати з `DelegateFeeEscrow`/`set_session`» з точним джерелом у репо (не «TBD»); `CloseEphemeralPermissionCpi` поля — з SDK-сорсу за вказаним шляхом. Обидва — свідома вказівка «копіюй перевірений локальний патерн», бо точні назви полів залежать від макро-генерації SDK і повторювати їх наосліп у плані ризикованіше, ніж вказати джерело.
