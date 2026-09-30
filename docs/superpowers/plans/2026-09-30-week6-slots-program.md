# Позиції-слоти, план 1 з 4: програма `dexxer_core` + LiteSVM

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** трейдер тримає позиції на будь-яких ринках в одному акаунті `Positions` (8 слотів + приватне кільце історії на 16 записів); угоди не розкриваються; новий ринок не потребує жодної дії на трейдера; ризики #38 і #39 закриті.

**Architecture:** спершу видаляється підсистема розкриття й інструкції позицій-на-ринок (програма стає меншою й лишається зеленою), потім додається zero-copy акаунт `Positions` і на нього одним кроком переводяться онбординг, торгівля, ліквідація, crank і вихід. Ринок шукається в даних акаунта (слот за ключем ринку), а не в адресі PDA. Наприкінці — поведінкові тести кількох ринків, per-sample гістерезис (#38) і повернення ренти платнику (#39).

**Tech Stack:** Anchor 1.0.2 (`#[account(zero_copy)]`, `AccountLoader`), `bytemuck` 1.25.2, `ephemeral-rollups-sdk` 0.16.2, LiteSVM (`tests/litesvm`, nightly).

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.9 (2.9.1, 2.9.2, 2.9.5). §2.9 переважає §2.4.1 і §2.8.2.

**Плани 2–4** (relayer + адмін-TS; app; чистий деплой і виміри) пишуться після цього шару. До кінця плану 2 TS-частини репозиторію (`services/relayer`, `tests/er`, `app`) працюють проти СТАРОГО `app/src/idl/dexxer_core.json` — цей план його **не** перегенеровує (див. Task 8).

## Global Constraints

- Гілка `positions-slots` (від `main` 9904b98). Нічого не пушити; коміт після кожної задачі, `git add <paths>` поштучно; повідомлення комітів англійською з трейлером сесії.
- Чистий старт devnet: сумісність лейауту зі старими акаунтами **не потрібна** — поля можна видаляти й переставляти. Коди помилок `DexxerError` — лише ДОПИСУВАТИ в кінець; невживані варіанти лишаються (мапа помилок апки тримається на номерах).
- Лейаут `Positions` — рівно з spec §2.9.1: `owner: Pubkey | slots: [PositionSlot; 8] | history: [HistoryRecord; 16] | history_head: u8 | history_len: u8 | version: u8 | bump: u8 | _pad: [u8; 4] | _reserved: [u8; 64]` (2408 B + 8). `PositionSlot` 96 B: `market: Pubkey | size | entry | margin | liq_price | opened_slot | oi_notional | last_liq_mark_slot (u64 ×7) | state: u8 | side: u8 | liq_ticks: u8 | _pad: [u8; 5]`. `HistoryRecord` 96 B: `market: Pubkey | size | entry | exit: u64 | pnl: i64 | fees | opened_slot | closed_slot: u64 | side: u8 | reason: u8 | _pad: [u8; 6]`. Сіди `[b"positions", owner]`. Доступ лише через `AccountLoader` (Borsh by value 2.4 KiB пробиває SBF-стек).
- `RefMut` від `load_mut()` мусить бути звільнений (`drop`) ДО будь-якого CPI, що бере цей акаунт (планувальник, permission, `commit_and_undelegate`).
- Округлення — на користь пулу; математика — в `math.rs`, `u128` проміжні, `checked_*`. OI-леджер змінюється лише через `oi_notional` слота, ніколи перерахунком з VWAP `entry`.
- Приватний байт ніколи не виходить на L1: `undelegate_user` стирає історію й вимагає всі слоти `Empty` (гейт маржі) до `commit_and_undelegate`; очищений слот — усі 96 байт нулі, включно з `market`.
- CPI до Permission/Magic/Delegation програм у LiteSVM відсутні: гейти за `.executable`, авторизація — ДО гейту.
- `init_if_needed` не використовувати. Solana MCP `program_autofixer` — на кожен змінений `.rs` до коміту, цикл доки `require_another_tool_call_after_fixing == false`.
- Збірка: `cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml` (НЕ `anchor build`). LiteSVM: `cargo +nightly-2026-09-18 test -p dexxer_litesvm` (або `cargo +nightly`). Unit: `cargo test -p dexxer_core`. Перед комітом: `cargo fmt --check && cargo clippy -p dexxer_core -- -D warnings`.
- Інваріант пулу (`assert_invariant*`) перевіряється в кожному торговому/crank-тесті, як зараз.
- Базова лінія на `main`: LiteSVM 107, unit 64. Кожна задача фіксує фактичні лічильники у звіті.

## Review Focus

1. **Слот чужого ринку.** `close/increase/decrease/add_margin/liquidation_check/crank_tick` з ринком, на якому в трейдера немає відкритої позиції → `PositionNotOpen` (торгівля) або тихий `continue`/no-op (crank, планувальник), ніколи дія над слотом іншого ринку — Task 4 (тести в Task 5).
2. **Дев'ятий ринок.** `open_position` при 8 зайнятих слотах → `NoFreeSlot`, стан без змін; після закриття одного — відкривається — Task 5.
3. **Історія не блокує й не тече.** 17-те закриття перезаписує найстаріший запис; ліквідація пише запис із `reason = Liquidated`; `undelegate_user` лишає в акаунті нуль ненульових байтів історії й слотів — Task 5.
4. **Один семпл ціни — один тік ліквідації (#38).** Три виклики `liquidation_check`/`crank_tick` на одному `Market.mark_slot` не ліквідують позицію з гістерезисом 2; другий семпл — ліквідує — Task 6.
5. **Рента повертається платнику (#39).** `close_exited_user` шле лампорти на `UserAccount.rent_payer`, а не на підписанта; сторонній підписант → `Unauthorized`; власник може закрити сам — Task 7.

---

### Task 1: видалити підсистему розкриття

**Files:**
- Delete: `programs/dexxer_core/src/instructions/disclosure.rs`, `programs/dexxer_core/src/state/disclosure.rs`, `tests/litesvm/tests/disclosure.rs`, `tests/litesvm/tests/commit_actions.rs`
- Modify: `programs/dexxer_core/src/lib.rs`, `instructions/mod.rs`, `instructions/trade.rs`, `instructions/liquidation.rs`, `instructions/crank.rs`, `instructions/commit.rs`, `instructions/user.rs`, `instructions/admin.rs`, `state/mod.rs`, `state/position.rs`, `state/user.rs`, `state/config.rs`, `state/permissions.rs` (`build_crank_only`, якщо більше не вживається)
- Modify: `tests/litesvm/src/{setup.rs,ixs.rs,pdas.rs,lib.rs}`, `tests/litesvm/tests/{trade,resize,crank,liquidation,invariants,undelegate,user,markets,admin,withdraw}.rs`

**Interfaces:**
- Produces (споживають Task 4+):
  - `finalize_close(market_key: Pubkey, risk_acc: &mut MarketRisk, pool: &mut PoolLive, user: &mut UserAccount, pos: &mut Position, exit: u64, fee_bps: u32, reason: CloseReason, clock: &Clock) -> Result<Settlement>` — без черги й `delay_slots`; нічим не може впасти через заповненість.
  - `CloseReason` переїжджає в `state/position.rs` (лишається `User`/`Liquidated`).
  - `Trade` — 12 акаунтів: `[signer, config, market, market_risk, pool_live, user_account, position, feed, fee_escrow, task_context, magic_program, liq_crank_signer]`.
  - `crank_tick` — кандидати парами `[Position, UserAccount]` (`rem.len() % 2 == 0`, ≤ `MAX_CANDIDATES`).
  - `LiquidationCheck` — без `disclosure_queue`; запланована інструкція в `register_liq_task` — без її меты.
  - `commit_aggregate()` — без аргументів і без `remaining_accounts`-логіки: `commit(&[Pool, BalancesRoot])` через `FeeEscrow`.
  - `InitUser`/`DelegateUser`/`InitPermissions`/`SetSession`/`UndelegateUser`/`CloseExitedUser` — без `disclosure_queue`/`dq`/`dq_permission`.
  - `init_config` — без аргументу `disclosure_delay_slots`; `Config` без цього поля.
  - Видалені інструкції: `write_commitment`, `write_disclosure`, `set_disclosure_delay`, `close_orphan_queue`, `init_user_reuse_queue`.
  - Харнес: `Trader { kp, user, position, ata }` (без `dq`); `ixs::commit_aggregate(payer, wd)`; `ixs::crank_tick*` будує пари.

- [ ] **Step 1: падаючий тест — закриття більше не впирається в чергу**

У `tests/litesvm/tests/trade.rs` додати (зараз 9-те закриття падає `QueueFull`):

```rust
#[test]
fn nine_closes_in_a_row_all_succeed() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let o = t.kp.pubkey();
    for i in 0..9u64 {
        // Distinct slots keep each transaction's bytes unique.
        h.warp(9_200 + i * 2, NOW);
        w.set_price(&mut h, P150, 5, NOW, 100);
        h.send(
            &[ixs::open_position(&o, &t, &w, Side::Long, SOL10, M150, P150)],
            &[&t.kp],
        )
        .unwrap();
        h.warp(9_201 + i * 2, NOW);
        w.set_price(&mut h, P150, 5, NOW, 100);
        h.send(&[ixs::close_position(&o, &t, &w, P150)], &[&t.kp])
            .unwrap_or_else(|e| panic!("close #{i} failed: {e:?}"));
        assert_invariant(&h, &w, &[&t]);
    }
    let p: Position = h.account(&t.position);
    assert_eq!(p.state, PositionState::Empty);
}
```

- [ ] **Step 2: запустити — FAIL**

```bash
cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml
cargo +nightly-2026-09-18 test -p dexxer_litesvm --test trade nine_closes
```

Expected: FAIL на `close #8` з `QueueFull`.

- [ ] **Step 3: видалити розкриття з програми**

1. `lib.rs`: прибрати `write_commitment`, `write_disclosure`, `set_disclosure_delay`, `close_orphan_queue`, `init_user_reuse_queue`; `commit_aggregate` — без `max_actions`.
2. `state/`: видалити `disclosure.rs` і `pub mod`/`pub use`; з `mod.rs` — `DQ_SEED`, `COMMIT_SEED`, `DISCLOSURE_SEED`, `MAX_ACTIONS_PER_COMMIT`, `ACTION_ESCROW_INDEX`, рядки про `DisclosureQueue` у `size_tests`. `position.rs`: видалити `ClosedRecord`, `Position.closed`, варіант `PositionState::Closed`; `CloseReason` лишити тут. `user.rs`: видалити `nonce`. `config.rs`: видалити `disclosure_delay_slots` (і аргумент `init_config`, `AdminConfig::set_disclosure_delay`).
3. `trade.rs`: `Trade` без `disclosure_queue`; `finalize_close` за сигнатурою з Interfaces — без `dq.push`, без `salt`/`nonce`/`hashv` (імпорт `solana_keccak_hasher::hashv` прибрати, якщо більше не потрібен у файлі), решта тіла без змін; `close_position`/`decrease_position` — без `delay`; `liq_task_accounts`/`register_liq_task` — без акаунта й меты черги; оновити коментар STACK BUDGET (одним акаунтом менше).
4. `liquidation.rs`: `liquidate_now` без `dq`/`delay_slots` і без гілки «ring full» — завжди `finalize_close`, повертає `Result<()>`; `LiquidationCheck` без `disclosure_queue`.
5. `crank.rs`: видалити `liquidate_candidate`; цикл по `rem.chunks(2)`; перевірки власника/writable/`seen` — для пари; ліквідація — прямий `liquidate_now`.
6. `commit.rs`: видалити `process_disclosure_queue_candidate` і збирання дій; `commit_aggregate` — лише наявний коміт `Pool` (знімок з `PoolLive`, `SNAPSHOT_STEP`) + `BalancesRoot`; акаунти, потрібні лише діям (`system_program`, action-escrow тощо), прибрати.
7. `user.rs`: з `InitUser`/`DelegateUser`/`InitPermissions`/`SetSession`/`UndelegateUser`/`CloseExitedUser` прибрати чергу та її permission; `undelegate_user` — без `carries_debt` (завжди повний вихід: скраб `UserAccount`, `exit()` обох, закрити обидва permission, скасувати задачу, `commit_and_undelegate(&[user_account, position])`); видалити `CloseOrphanQueue`, `InitUserReuseQueue` та їхні хендлери; `close_exited_user` — без `dq` і `QueueStillPending`.
8. `admin.rs`: якщо `init_fee_escrow`/action-escrow логіка існує лише для дій розкриття — лишити `FeeEscrow` (він платить коміти й задачі), прибрати тільки те, що стосується `ACTION_ESCROW_INDEX`.

- [ ] **Step 4: харнес і тести**

`setup.rs`: `Trader` без `dq`; `trade_accounts_on` — 12 мет (без `self.dq`); `new_trader`/`init_user`/`init_config` під нові сигнатури. `ixs.rs`: видалити `set_disclosure_delay`, `write_*_direct*`, `close_orphan_queue`, `init_user_reuse_queue`; `commit_aggregate(payer, wd)` без черг і `max_actions`; `crank_tick_on` — пари; `liquidation_check`, `undelegate_user`, `close_exited_user`, `delegate_user`, `set_session`, `init_user` — без черги. `pdas.rs`: видалити `dq`, `commitment`, `disclosure`, `action_escrow`. Тести: видалити файли `disclosure.rs`, `commit_actions.rs`; у решті — видалити тести, що перевіряють лише чергу/розкриття/вихід із боргом/orphan/reuse (перелічити кожен видалений тест у звіті з причиною), а в тих, що лишаються, прибрати асерти про чергу. Жоден асерт про гроші, OI, маржу, ліквідацію не послаблювати.

- [ ] **Step 5: `program_autofixer`** на кожен змінений `.rs` (найбільші: `trade.rs`, `user.rs`, `crank.rs`, `commit.rs`, `liquidation.rs`).

- [ ] **Step 6: PASS**

```bash
cargo fmt --check && cargo clippy -p dexxer_core -- -D warnings
cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml
cargo test -p dexxer_core
cargo +nightly-2026-09-18 test -p dexxer_litesvm
```

Expected: усе зелене, `nine_closes_in_a_row_all_succeed` PASS. Записати лічильники (unit, LiteSVM) і список видалених тестів.

- [ ] **Step 7: commit**

```bash
git add programs/dexxer_core/src tests/litesvm
git commit -m "refactor(program): remove trade disclosure (queue, commitments, reveal actions)"
```

(каталоги тут — виняток із «поштучно»: видалення й правки зачіпають більшість файлів обох; перед комітом `git status --short` не має містити нічого поза цими двома каталогами.)

---

### Task 2: видалити інструкції позицій-на-ринок

**Files:**
- Delete: `programs/dexxer_core/src/instructions/positions.rs`
- Modify: `programs/dexxer_core/src/lib.rs`, `instructions/mod.rs`, `instructions/user.rs` (`set_session` — без пар; `undelegate_user`/`close_exited_user` — без `PrimaryPositionMismatch`-гейтів і `sol_market_key`), `state/market.rs` (якщо `sol_market_key` живе там і більше не вживається)
- Modify: `tests/litesvm/src/{ixs.rs,setup.rs}`, `tests/litesvm/tests/markets.rs`

**Interfaces:**
- Produces: інструкцій `init_position`, `delegate_position`, `init_position_permission`, `undelegate_position`, `close_exited_position` більше немає; `set_session` ігнорує `remaining_accounts`. `init_market(symbol, …)`/`delegate_market(symbol)`/`validate_symbol` — без змін. Варіанти помилок `NotOnboarded`, `UserExited`, `MarketNotFound`, `PrimaryPositionMismatch` лишаються в enum невживаними.

- [ ] **Step 1: видалити** `positions.rs`, його `pub mod`/`pub use`, п'ять інструкцій з `lib.rs`; у `set_session` — блок `rem.chunks(2)`; у `undelegate_user`/`close_exited_user` — перевірки `sol_market_key()` (до Task 4 позиція й так лише SOL-сідована).
- [ ] **Step 2: харнес і тести.** `ixs.rs`: видалити `init_position`, `delegate_position`, `init_position_permission`, `set_session_with`, `undelegate_position`, `close_exited_position`. `setup.rs`: `Trader::position_on` лишити (потрібен `trade_accounts_on` до Task 4). `markets.rs`: лишити тести ринків (`init_market_stores_symbol_and_feed`, `sol_market_pda_is_unchanged`, `init_market_rejects_invalid_symbols`, `init_market_rejects_a_duplicate_symbol_and_a_non_admin`, `delegate_market_passes_its_guards_for_any_symbol`); видалити всі тести, що викликають видалені інструкції або торгують на не-SOL ринку через позицію-PDA (вони повертаються на слотах у Task 5). Перелічити видалені у звіті.
- [ ] **Step 3: `program_autofixer`** на `user.rs`, `lib.rs`.
- [ ] **Step 4: PASS** — ті самі чотири команди, що в Task 1 Step 6. Записати лічильники.
- [ ] **Step 5: commit**

```bash
git add programs/dexxer_core/src tests/litesvm
git commit -m "refactor(program): remove per-market position instructions"
```

---

### Task 3: стан `Positions` — слоти й кільце історії

**Files:**
- Create: `programs/dexxer_core/src/state/positions.rs`
- Modify: `programs/dexxer_core/src/state/mod.rs` (`pub mod positions; pub use positions::*;`, `POSITIONS_SEED`, `liq_task_id`), `programs/dexxer_core/src/errors.rs` (дописати `NoFreeSlot` В КІНЕЦЬ), `programs/dexxer_core/src/state/position.rs` (`impl Side`/`CloseReason` — конверсії в `u8`)

**Interfaces:**
- Produces:

```rust
pub const POSITIONS_SEED: &[u8] = b"positions";
pub const MAX_SLOTS: usize = 8;
pub const HISTORY_LEN: usize = 16;
pub const SLOT_EMPTY: u8 = 0;
pub const SLOT_OPEN: u8 = 1;

impl Side { pub fn as_u8(self) -> u8; pub fn from_u8(v: u8) -> Self; }       // 0 Long, 1 Short
impl CloseReason { pub fn as_u8(self) -> u8; }                               // 0 User, 1 Liquidated

#[zero_copy] #[repr(C)] pub struct PositionSlot { /* layout per Global Constraints */ }
impl PositionSlot { pub fn is_open(&self) -> bool; pub fn side(&self) -> Side; }
#[zero_copy] #[repr(C)] pub struct HistoryRecord { /* layout per Global Constraints */ }
#[account(zero_copy)] #[repr(C)] pub struct Positions { /* layout per Global Constraints */ }
impl Positions {
    pub const SPACE: usize = 8 + core::mem::size_of::<Positions>();          // 2416
    pub fn find_open(&self, market: &Pubkey) -> Option<usize>;
    pub fn open_index(&self, market: &Pubkey) -> Result<usize>;              // Err(PositionNotOpen)
    pub fn alloc(&mut self, market: &Pubkey) -> Result<usize>;               // Err(PositionNotEmpty) | Err(NoFreeSlot)
    pub fn clear_slot(&mut self, idx: usize);
    pub fn open_count(&self) -> usize;
    pub fn push_history(&mut self, rec: HistoryRecord);
    pub fn scrub_history(&mut self);
}
pub fn liq_task_id(positions: &Pubkey, market: &Pubkey) -> i64;              // keccak(positions ‖ market)[0..8] LE
```

- [ ] **Step 1: падаючі unit-тести** — у `state/positions.rs`, модуль `#[cfg(test)] mod tests`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::DexxerError;

    fn key(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }
    fn blank() -> Positions {
        bytemuck::Zeroable::zeroed()
    }
    fn is(err: anchor_lang::error::Error, want: DexxerError) -> bool {
        err == anchor_lang::error::Error::from(want)
    }

    #[test]
    fn layout_is_exactly_the_spec() {
        assert_eq!(core::mem::size_of::<PositionSlot>(), 96);
        assert_eq!(core::mem::size_of::<HistoryRecord>(), 96);
        assert_eq!(core::mem::size_of::<Positions>(), 2408);
        assert_eq!(Positions::SPACE, 2416);
    }

    #[test]
    fn alloc_takes_the_first_empty_slot_and_refuses_a_second_position_on_a_market() {
        let mut p = blank();
        assert_eq!(p.alloc(&key(1)).unwrap(), 0);
        p.slots[0].state = SLOT_OPEN;
        p.slots[0].market = key(1);
        assert_eq!(p.alloc(&key(2)).unwrap(), 1);
        assert!(is(p.alloc(&key(1)).unwrap_err(), DexxerError::PositionNotEmpty));
    }

    #[test]
    fn a_ninth_market_gets_no_free_slot() {
        let mut p = blank();
        for i in 0..MAX_SLOTS {
            let idx = p.alloc(&key(i as u8 + 1)).unwrap();
            p.slots[idx].state = SLOT_OPEN;
            p.slots[idx].market = key(i as u8 + 1);
        }
        assert_eq!(p.open_count(), MAX_SLOTS);
        assert!(is(p.alloc(&key(99)).unwrap_err(), DexxerError::NoFreeSlot));
    }

    #[test]
    fn find_open_ignores_empty_slots_and_other_markets() {
        let mut p = blank();
        p.slots[3].state = SLOT_OPEN;
        p.slots[3].market = key(7);
        assert_eq!(p.find_open(&key(7)), Some(3));
        assert_eq!(p.find_open(&key(8)), None);
        // An all-zero slot must never match the zero key.
        assert_eq!(p.find_open(&Pubkey::default()), None);
        assert!(is(p.open_index(&key(8)).unwrap_err(), DexxerError::PositionNotOpen));
    }

    #[test]
    fn clear_slot_zeroes_every_byte_and_frees_it() {
        let mut p = blank();
        p.slots[2] = PositionSlot {
            market: key(5), size: 1, entry: 2, margin: 3, liq_price: 4, opened_slot: 5,
            oi_notional: 6, last_liq_mark_slot: 7, state: SLOT_OPEN, side: 1, liq_ticks: 2, _pad: [0; 5],
        };
        p.clear_slot(2);
        assert_eq!(bytemuck::bytes_of(&p.slots[2]), &[0u8; 96][..]);
        assert_eq!(p.alloc(&key(5)).unwrap(), 0);
    }

    fn rec(n: u64) -> HistoryRecord {
        HistoryRecord { closed_slot: n, ..bytemuck::Zeroable::zeroed() }
    }

    #[test]
    fn history_overwrites_the_oldest_record_on_the_seventeenth_push() {
        let mut p = blank();
        for n in 1..=16 {
            p.push_history(rec(n));
        }
        assert_eq!(p.history_len as usize, HISTORY_LEN);
        assert_eq!(p.history[0].closed_slot, 1);
        p.push_history(rec(17));
        assert_eq!(p.history_len as usize, HISTORY_LEN, "len saturates");
        assert_eq!(p.history[0].closed_slot, 17, "slot of the oldest record is reused");
        assert_eq!(p.history[1].closed_slot, 2);
        assert_eq!(p.history_head, 1, "head = next write index");
    }

    #[test]
    fn scrub_history_leaves_no_byte_behind() {
        let mut p = blank();
        for n in 1..=5 {
            p.push_history(rec(n));
        }
        p.scrub_history();
        assert_eq!(p.history_head, 0);
        assert_eq!(p.history_len, 0);
        assert!(bytemuck::bytes_of(&p.history).iter().all(|b| *b == 0));
    }

    #[test]
    fn liq_task_id_is_per_market() {
        let pos = key(9);
        assert_eq!(liq_task_id(&pos, &key(1)), liq_task_id(&pos, &key(1)));
        assert_ne!(liq_task_id(&pos, &key(1)), liq_task_id(&pos, &key(2)));
        assert_ne!(liq_task_id(&pos, &key(1)), liq_task_id(&key(8), &key(1)));
    }
}
```

- [ ] **Step 2: запустити — FAIL** (`cargo test -p dexxer_core positions` — модуля/типів ще нема).

- [ ] **Step 3: реалізація `state/positions.rs`**

```rust
// programs/dexxer_core/src/state/positions.rs
//
// A trader's positions on every market, in ONE account (spec §2.9.1). The
// market lives in the slot's DATA, not in the account's address: a PDA seeded
// by market would put which markets a trader uses on L1, where nothing filters
// reads, and would need a new L1 account per trader for every new market.
// Here a new market costs the trader nothing — a free slot is already there.
//
// `zero_copy`, accessed only through `AccountLoader`: a by-value Borsh
// deserialization of 2.4 KiB overflows the SBF stack (the `BalancesRoot`
// lesson, week 3). Field order is `repr(C)`-significant and padded by hand so
// `bytemuck::Pod` needs no implicit padding.
use anchor_lang::prelude::*;

use crate::errors::DexxerError;

use super::Side;

pub const MAX_SLOTS: usize = 8;
pub const HISTORY_LEN: usize = 16;
pub const SLOT_EMPTY: u8 = 0;
pub const SLOT_OPEN: u8 = 1;

#[zero_copy]
#[repr(C)]
pub struct PositionSlot {
    pub market: Pubkey,
    pub size: u64,
    pub entry: u64,
    pub margin: u64,
    pub liq_price: u64,
    pub opened_slot: u64,
    /// Exact notional this position contributes to `MarketRisk.oi_long` /
    /// `oi_short` — the OI ledger moves only through this field, never through
    /// a recompute off the VWAP `entry` (double rounding can underflow).
    pub oi_notional: u64,
    /// `Market.mark_slot` of the last price sample that counted toward
    /// `liq_ticks` (risk #38): one sample, one tick.
    pub last_liq_mark_slot: u64,
    pub state: u8,
    pub side: u8,
    pub liq_ticks: u8,
    pub _pad: [u8; 5],
}

impl PositionSlot {
    pub fn is_open(&self) -> bool {
        self.state == SLOT_OPEN
    }
    pub fn side(&self) -> Side {
        Side::from_u8(self.side)
    }
}

/// One closed trade, kept only for the owner's own History screen. Private
/// (the account is permissioned `[owner, session, crank]`), overwritten in a
/// ring, and scrubbed before the account ever leaves the ER.
#[zero_copy]
#[repr(C)]
pub struct HistoryRecord {
    pub market: Pubkey,
    pub size: u64,
    pub entry: u64,
    pub exit: u64,
    pub pnl: i64,
    pub fees: u64,
    pub opened_slot: u64,
    pub closed_slot: u64,
    pub side: u8,
    pub reason: u8,
    pub _pad: [u8; 6],
}

#[account(zero_copy)]
#[repr(C)]
pub struct Positions {
    pub owner: Pubkey,
    pub slots: [PositionSlot; MAX_SLOTS],
    pub history: [HistoryRecord; HISTORY_LEN],
    /// Index the NEXT record is written to.
    pub history_head: u8,
    pub history_len: u8,
    pub version: u8,
    pub bump: u8,
    pub _pad: [u8; 4],
    pub _reserved: [u8; 64],
}

impl Positions {
    pub const SPACE: usize = 8 + core::mem::size_of::<Positions>();

    /// The open position on `market`, if any. `state` is checked first, so an
    /// all-zero slot can never match the zero key.
    pub fn find_open(&self, market: &Pubkey) -> Option<usize> {
        self.slots
            .iter()
            .position(|s| s.is_open() && s.market == *market)
    }

    pub fn open_index(&self, market: &Pubkey) -> Result<usize> {
        self.find_open(market)
            .ok_or_else(|| error!(DexxerError::PositionNotOpen))
    }

    /// Slot for a NEW position on `market`: one position per market, first
    /// empty slot. The caller fills the slot; this only picks it.
    pub fn alloc(&mut self, market: &Pubkey) -> Result<usize> {
        require!(
            self.find_open(market).is_none(),
            DexxerError::PositionNotEmpty
        );
        self.slots
            .iter()
            .position(|s| !s.is_open())
            .ok_or_else(|| error!(DexxerError::NoFreeSlot))
    }

    /// Every byte back to zero, `market` included: an emptied slot must show
    /// the owner's client no phantom trade and carry nothing out of the ER.
    pub fn clear_slot(&mut self, idx: usize) {
        self.slots[idx] = bytemuck::Zeroable::zeroed();
    }

    pub fn open_count(&self) -> usize {
        self.slots.iter().filter(|s| s.is_open()).count()
    }

    /// Infallible by design: a full ring overwrites its oldest record, so a
    /// close or a liquidation can never be blocked by history.
    pub fn push_history(&mut self, rec: HistoryRecord) {
        let head = self.history_head as usize % HISTORY_LEN;
        self.history[head] = rec;
        self.history_head = ((head + 1) % HISTORY_LEN) as u8;
        if (self.history_len as usize) < HISTORY_LEN {
            self.history_len += 1;
        }
    }

    pub fn scrub_history(&mut self) {
        self.history = bytemuck::Zeroable::zeroed();
        self.history_head = 0;
        self.history_len = 0;
    }
}
```

`state/mod.rs`: `pub const POSITIONS_SEED: &[u8] = b"positions";`; замінити `liq_task_id` (і його два unit-тести в `liq_task_tests` — на версію з двома ключами):

```rust
/// Scheduler task id of one trader's liquidation check on one market:
/// keccak(positions ‖ market)[0..8], LE. Task ids are validator-global, so
/// both keys go into the hash.
pub fn liq_task_id(positions: &Pubkey, market: &Pubkey) -> i64 {
    let h = solana_keccak_hasher::hashv(&[positions.as_ref(), market.as_ref()]).to_bytes();
    let mut b = [0u8; 8];
    b.copy_from_slice(&h[..8]);
    i64::from_le_bytes(b)
}
```

До Task 4 старі виклики `liq_task_id(&position.key())` у `trade.rs`/`user.rs` тимчасово переходять на `liq_task_id(&position.key(), &market.key())` (у `undelegate_user` — `&a.position.market`) — поведінка в LiteSVM не змінюється (CPI за `.executable`).

`state/position.rs`:

```rust
impl Side {
    pub fn as_u8(self) -> u8 {
        match self {
            Side::Long => 0,
            Side::Short => 1,
        }
    }
    /// Only ever called on a byte this program wrote with `as_u8`.
    pub fn from_u8(v: u8) -> Self {
        if v == 1 {
            Side::Short
        } else {
            Side::Long
        }
    }
}
impl CloseReason {
    pub fn as_u8(self) -> u8 {
        match self {
            CloseReason::User => 0,
            CloseReason::Liquidated => 1,
        }
    }
}
```

`errors.rs` — останнім варіантом:

```rust
    #[msg("All position slots are in use")]
    NoFreeSlot,
```

- [ ] **Step 4: PASS** — `cargo test -p dexxer_core` (усі нові тести зелені), `cargo build-sbf …`, повний LiteSVM (без регресій).
- [ ] **Step 5: `program_autofixer`** на `state/positions.rs`, `state/mod.rs`.
- [ ] **Step 6: commit**

```bash
git add programs/dexxer_core/src/state/positions.rs programs/dexxer_core/src/state/mod.rs programs/dexxer_core/src/state/position.rs programs/dexxer_core/src/errors.rs programs/dexxer_core/src/instructions/trade.rs programs/dexxer_core/src/instructions/user.rs
git commit -m "feat(program): Positions account — 8 slots and a 16-record private history ring"
```

---

### Task 4: перевести програму на слоти

Найбільша задача: `Position` зникає, усі шляхи читають і пишуть слот у `Positions`. Страховка — наявний LiteSVM-набір, мігрований механічно; нова поведінка кількох ринків тестується в Task 5.

**Files:**
- Delete: `programs/dexxer_core/src/state/position.rs` → типи `Side`, `CloseReason` і їхні `impl` переїжджають у `state/positions.rs`; `Position`, `PositionState` видаляються
- Modify: `programs/dexxer_core/src/state/mod.rs` (прибрати `POSITION_SEED`, `pub mod position`), `risk.rs` (`liquidatable_now(&PositionSlot, …)`), `instructions/{trade.rs,liquidation.rs,crank.rs,user.rs}`, `lib.rs`
- Modify: `tests/litesvm/src/{setup.rs,ixs.rs,pdas.rs,lib.rs}`, усі `tests/litesvm/tests/*.rs`, що читають позицію

**Interfaces:**
- Consumes: усе з Task 3.
- Produces:
  - `Trade` (12 акаунтів): `[signer, config, market, market_risk, pool_live, user_account, positions, feed, fee_escrow, task_context(=positions), magic_program, liq_crank_signer]`; `positions: AccountLoader<'info, Positions>` із `seeds = [POSITIONS_SEED, user_account.owner.as_ref()], bump = positions.load()?.bump` і `constraint = positions.load()?.owner == user_account.owner @ Unauthorized`.
  - `finalize_close(market_key: Pubkey, risk_acc: &mut MarketRisk, pool: &mut PoolLive, user: &mut UserAccount, positions: &mut Positions, idx: usize, exit: u64, fee_bps: u32, reason: CloseReason, clock: &Clock) -> Result<Settlement>`.
  - `liq_due(slot: &mut PositionSlot, market: &Market, mark: u64) -> Result<bool>` (логіка як зараз; #38 — Task 6).
  - `LiquidationCheck`: `[crank, config, market, market_risk, pool_live, feed, positions, user_account]`; слота ринку нема → `Ok(())`.
  - `crank_tick`: пари `[Positions, UserAccount]`; PDA кожного звіряється; слота ринку нема → `continue`.
  - `InitUser`: `[owner, payer, config, user_account, positions, system_program]` (без `market`); `DelegateUser`: `[owner, payer, config, user_account, positions]` + quad-и делегації; `InitPermissions`/`SetSession`: без `market`, `positions` + `positions_permission`; `UndelegateUser`: `[owner, config, user_account, positions, user_permission, positions_permission, ephemeral_vault, permission_program, fee_escrow, magic_fee_vault, magic_context, magic_program]` + `remaining_accounts` = ринки, чиї задачі скасувати; `CloseExitedUser`: `[fee_payer, config, user_account, positions]`.
  - Харнес: `Trader { kp, user, positions, ata }`; `pdas::positions(owner)`; `Harness::positions(&self, key: &Pubkey) -> Positions` (копія через `bytemuck::pod_read_unaligned(&data[8..])`); `Harness::slot(&self, t: &Trader, market: &Pubkey) -> Option<PositionSlot>` (відкритий слот ринку); `ixs::undelegate_user(signer, t, wd, markets: &[Pubkey])`; решта білдерів — ті самі імена.

- [ ] **Step 1: програма — стан і ризик.** Перенести `Side`/`CloseReason` у `positions.rs`, видалити `position.rs`/`POSITION_SEED`. `risk::liquidatable_now(pos: &PositionSlot, market, mark)`: `pos.side` → `pos.side()`, решта полів — ті самі імена.

- [ ] **Step 2: `trade.rs`.** Шаблон для кожного хендлера — слот береться копією індексу, `RefMut` живе лише в блоці:

```rust
pub fn open_position<'info>(
    mut ctx: Context<'info, Trade<'info>>,
    side: Side,
    size: u64,
    margin: u64,
    limit_price: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    require!(!a.config.paused, DexxerError::Paused);
    require!(!a.market.paused_open, DexxerError::OpenPaused);
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    // … price reads, risk::check_open, user/pool/market_risk updates: unchanged …
    let market_key = a.market.key();
    {
        let mut positions = a.positions.load_mut()?;
        // `PositionNotEmpty` if this market already has a position, `NoFreeSlot`
        // when all eight are taken — both before any money moved would be
        // cleaner, so call `alloc` right after `assert_trader` and keep `idx`.
        let idx = positions.alloc(&market_key)?;
        positions.slots[idx] = PositionSlot {
            market: market_key,
            size,
            entry: px.price,
            margin,
            liq_price: chk.liq_price,
            opened_slot: clock.slot,
            oi_notional: entry_notional,
            last_liq_mark_slot: 0,
            state: SLOT_OPEN,
            side: side.as_u8(),
            liq_ticks: 0,
            _pad: [0; 5],
        };
    } // RefMut dropped before the scheduler CPI borrows the account
    seed_mark(&mut a.market, px.price, clock.slot);
    register_liq_task(ctx.accounts)
}
```

Порядок: `alloc` — одразу після `assert_trader` (до зміни грошей); запис слота — після обчислень. `add_margin`/`increase_position`/`decrease_position`: `let idx = positions.open_index(&market_key)?;` і далі `let p = &mut positions.slots[idx];` замість `a.position`; `side` — `p.side()`. Повне закриття:

```rust
    let idx = { a.positions.load()?.open_index(&market_key)? };
    // … read price, slippage check against `side` copied out of the slot …
    {
        let mut positions = a.positions.load_mut()?;
        finalize_close(
            market_key, &mut a.market_risk, &mut a.pool_live, &mut a.user_account,
            &mut positions, idx, px.price, fee_bps, CloseReason::User, &clock,
        )?;
    }
    cancel_liq_task(ctx.accounts)
```

`finalize_close`: копія слота `let pos = positions.slots[idx];` → розрахунок як зараз (`pos.side()`), зменшення OI на `pos.oi_notional`, потім:

```rust
    positions.push_history(HistoryRecord {
        market: market_key,
        size: pos.size,
        entry: pos.entry,
        exit,
        pnl,
        fees: s.fee_taken,
        opened_slot: pos.opened_slot,
        closed_slot: clock.slot,
        side: pos.side,
        reason: reason.as_u8(),
        _pad: [0; 6],
    });
    positions.clear_slot(idx);
    Ok(s)
```

`liq_task_accounts`/`register_liq_task`/`cancel_liq_task`: `a.position` → `a.positions`; `task_id = liq_task_id(&a.positions.key(), &a.market.key())`; мета запланованої інструкції — за новим `LiquidationCheck`. Оновити коментар STACK BUDGET (`AccountLoader` дешевший за `Box<Account<Position>>`).

- [ ] **Step 3: `liquidation.rs` і `crank.rs`.**

```rust
pub fn liquidation_check(mut ctx: Context<LiquidationCheck>) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    let signer = a.crank.key();
    let authorized = signer == liq_crank_signer(&fee_escrow_pda()) || signer == a.config.crank;
    require!(authorized, DexxerError::Unauthorized);

    let market_key = a.market.key();
    let mut positions = a.positions.load_mut()?;
    // A liquidated or user-closed position leaves its task registered until the
    // next open on this market or the owner's exit: a tick on a market with no
    // open slot is a no-op, never an error (spec §2.9.2).
    let Some(idx) = positions.find_open(&market_key) else {
        return Ok(());
    };
    // … read_price / check_deviation / mark == 0 early returns: unchanged …
    if liq_due(&mut positions.slots[idx], &a.market, mark)? {
        liquidate_now(
            market_key, &mut a.market_risk, &mut a.pool_live, &mut a.user_account,
            &mut positions, idx, mark, a.market.liq_fee_bps as u32, &clock,
        )?;
    }
    Ok(())
}
```

`LiquidationCheck`: `positions: AccountLoader<'info, Positions>` із сідами від `user_account.owner`; `user_account.owner == positions.load()?.owner`. `crank_tick`: для пари `(pos_ai, user_ai)` — перевірка власника/writable/`seen`, `let loader = AccountLoader::<Positions>::try_from(pos_ai)?; let mut positions = loader.load_mut()?;`, PDA `[POSITIONS_SEED, positions.owner]` == `pos_ai.key()`, `positions.owner == user.owner`, `find_open(&market_key)` → `None` → `continue`; ліквідація — `liquidate_now`; `user.try_serialize` як зараз (zero-copy акаунт серіалізувати не треба).

- [ ] **Step 4: `user.rs`.**
  - `InitUser`: прибрати `market`; `#[account(init, payer = payer, space = Positions::SPACE, seeds = [POSITIONS_SEED, owner.key().as_ref()], bump)] pub positions: AccountLoader<'info, Positions>`. Хендлер: `{ let mut p = ctx.accounts.positions.load_init()?; p.owner = o; p.version = 1; p.bump = ctx.bumps.positions; }`, префонд permission — двом акаунтам.
  - `DelegateUser`/`delegate_user`: `positions` з `del` і сідами `[POSITIONS_SEED, o]`; дві делегації.
  - `InitPermissions`/`SetSession`: масив із двох пар `(user_account, USER_SEED…)`, `(positions, [POSITIONS_SEED, o, &[bump]])`; `bump` читати через `positions.load()?.bump` у блоці.
  - `undelegate_user`: гейт маржі як зараз (`free_margin == 0 && locked_margin == 0`) плюс `require!(positions.open_count() == 0, HasOpenPosition)`; `positions.scrub_history()`; скраб `UserAccount`; `drop` позицій; `user_account.exit(&crate::ID)?`; закрити обидва permission; якщо `magic_program.executable` — для кожного акаунта з `ctx.remaining_accounts` викликати `cancel_liquidation_task(escrow, positions_ai, magic_program, liq_task_id(&positions_key, rem.key), bump)` (cancel невідомого id — безпечний no-op, тиждень 5; `require!(rem.len() <= 16, InvalidInput)`), потім `commit_and_undelegate(&[user_account, positions])`.
  - `CloseExitedUser`: `positions: AccountLoader` з `close = fee_payer`, `constraint = positions.load()?.open_count() == 0 @ HasOpenPosition`.

- [ ] **Step 5: харнес.** `pdas::positions`; `Trader.positions`; `trade_accounts_on` — `positions` на місці `position` і як `task_context`; `Harness::positions`/`Harness::slot`; `assert_invariant_markets_ctx` — `Σ margin` по відкритих слотах трейдера (`h.positions(&t.positions).slots.iter().filter(|s| s.is_open())`), параметр `markets` лишається для сумісності викликів, але фільтр — за ним (слот рахується, якщо його `market` є в `markets`); білдери `init_user`, `delegate_user`, `set_session`, `undelegate_user` (+ `markets`), `close_exited_user`, `liquidation_check`, `crank_tick_on` — під нові акаунти.

- [ ] **Step 6: міграція тестів.** Кожне `let p: Position = h.account(&t.position);` → `let p = h.slot(&t, &w.market).expect("open slot");` (для перевірки «закрито» — `assert!(h.slot(&t, &w.market).is_none())`); `p.state == PositionState::Open` → `p.is_open()`; `p.side` → `p.side()`. Жоден числовий асерт не змінюється. Тести, що перевіряли саме PDA-адресу позиції або `PositionState::Closed`, — видалити з поясненням у звіті.

- [ ] **Step 7: `program_autofixer`** на `trade.rs`, `liquidation.rs`, `crank.rs`, `user.rs`, `risk.rs`, `state/positions.rs`.

- [ ] **Step 8: PASS** — fmt, clippy, build-sbf, unit, повний LiteSVM. Записати лічильники й CU `open_position`/`close_position` з логів одного тесту (порівняння з `main` — у Task 8).

- [ ] **Step 9: commit**

```bash
git add programs/dexxer_core/src tests/litesvm
git commit -m "feat(program): positions live in slots of one per-trader account"
```

---

### Task 5: поведінка кількох ринків, стелі слотів та історії

**Files:**
- Modify: `tests/litesvm/tests/markets.rs` (нові тести), `tests/litesvm/tests/undelegate.rs`
- Modify (лише якщо тест знайшов дефект): відповідний файл програми

**Interfaces:**
- Consumes: харнес Task 4 (`open_position_on`, `close_position_on`, `crank_tick_on`, `liquidation_check`, `Harness::slot`, `Harness::positions`, `World::add_market`, `World::set_price_on`, `undelegate_user(.., markets)`).

> **Шлях ціни до ліквідації.** Один великий стрибок ціни спрацьовує як запобіжник відхилення (`max_deviation_bps`, `crank_tick` ставить `paused_open` і виходить ДО ліквідацій). Тому в тестах цієї задачі й Task 6 шлях ціни, яким позицію доводять до ліквідації, брати з наявних тестів (`tests/litesvm/tests/liquidation.rs`, і `git show main:tests/litesvm/tests/markets.rs` — тест `a_btc_crash_liquidates_only_the_btc_position`): ті самі кроки ціни й тіків. Обов'язковим у наведеному нижче коді є **набір асертів**, а не конкретні числа ціни й кількість тіків.

- [ ] **Step 1: тести** (константи `NOW`, `P150`, `SOL10`, `M150`, `B80K`, `B70K`, `BTC_01`, `M80`, `btc_params()` уже є на початку `markets.rs`; якщо `liquidation_check`-білдер не приймає ринок — додати `liquidation_check_on(signer, wd, m, t)` у `ixs.rs`):

```rust
fn two_markets(h: &mut Harness) -> (World, Mkt, dexxer_litesvm::setup::Trader) {
    let w = World::bootstrap(h);
    let btc = w.add_market(h, "BTC", "1", btc_params());
    h.warp(9_101, NOW);
    w.set_price(h, P150, 5, NOW, 100);
    w.set_price_on(h, &btc, B80K, 5, NOW, 100);
    let t = w.new_trader(h, 1_000_000_000);
    (w, btc, t)
}

#[test]
fn one_trader_holds_isolated_positions_on_two_markets() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    h.send(&[ixs::open_position(&o, &t, &w, Side::Long, SOL10, M150, P150)], &[&t.kp]).unwrap();
    h.send(&[ixs::open_position_on(&o, &t, &w, &btc, Side::Short, BTC_01, M80, B80K)], &[&t.kp]).unwrap();
    let sol = h.slot(&t, &w.market).expect("SOL slot");
    let b = h.slot(&t, &btc.market).expect("BTC slot");
    assert_eq!((sol.margin, b.margin), (M150, M80));
    assert_eq!(b.side(), Side::Short);
    let u: UserAccount = h.account(&t.user);
    assert_eq!(u.locked_margin, M150 + M80);
    assert_eq!(h.positions(&t.positions).open_count(), 2);
    assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

#[test]
fn closing_one_market_leaves_the_other_untouched_and_a_wrong_market_is_refused() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    h.send(&[ixs::open_position(&o, &t, &w, Side::Long, SOL10, M150, P150)], &[&t.kp]).unwrap();
    // No BTC position: closing on BTC must not touch the SOL slot.
    let r = h.send(&[ixs::close_position_on(&o, &t, &w, &btc, B80K)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::PositionNotOpen as u32);
    assert!(h.slot(&t, &w.market).is_some());
    h.warp(9_102, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    h.send(&[ixs::close_position(&o, &t, &w, P150)], &[&t.kp]).unwrap();
    assert!(h.slot(&t, &w.market).is_none());
    assert_eq!(h.positions(&t.positions).open_count(), 0);
    assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

#[test]
fn a_btc_crash_liquidates_only_the_btc_position() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    h.send(&[ixs::open_position(&o, &t, &w, Side::Long, SOL10, M150, P150)], &[&t.kp]).unwrap();
    h.send(&[ixs::open_position_on(&o, &t, &w, &btc, Side::Long, BTC_01, M80, B80K)], &[&t.kp]).unwrap();
    // Enough ticks on a crashed BTC price to pass the market's hysteresis.
    let ticks = h.account::<Market>(&btc.market).liq_hysteresis_ticks as u64 + 1;
    for i in 0..ticks {
        h.warp(9_110 + i, NOW);
        w.set_price(&mut h, P150, 5, NOW, 100);
        w.set_price_on(&mut h, &btc, B70K, 5, NOW, 100);
        h.send(&[ixs::crank_tick_on(&w.crank.pubkey(), &w, &btc, &[&t])], &[&w.crank]).unwrap();
    }
    assert!(h.slot(&t, &btc.market).is_none(), "BTC liquidated");
    assert!(h.slot(&t, &w.market).is_some(), "SOL untouched");
    let p = h.positions(&t.positions);
    assert_eq!(p.history_len, 1);
    assert_eq!(p.history[0].reason, CloseReason::Liquidated.as_u8());
    assert_eq!(pk(p.history[0].market), btc.market);
    assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

#[test]
fn the_ninth_market_has_no_free_slot_until_one_closes() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(9_101, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    // SOL + 8 more markets, all priced like SOL so SOL-sized trades fit.
    let mut mkts = vec![w.sol()];
    for (i, s) in ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"].iter().enumerate() {
        let m = w.add_market(&mut h, s, &format!("{}", 200 + i), MarketParams::sol_perp_defaults());
        w.set_price_on(&mut h, &m, P150, 5, NOW, 100);
        mkts.push(m);
    }
    let t = w.new_trader(&mut h, 5_000_000_000);
    let o = t.kp.pubkey();
    for m in &mkts[..8] {
        h.send(&[ixs::open_position_on(&o, &t, &w, m, Side::Long, SOL10, M150, P150)], &[&t.kp]).unwrap();
    }
    let before: UserAccount = h.account(&t.user);
    let r = h.send(&[ixs::open_position_on(&o, &t, &w, &mkts[8], Side::Long, SOL10, M150, P150)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::NoFreeSlot as u32);
    let after: UserAccount = h.account(&t.user);
    assert_eq!(before.free_margin, after.free_margin, "a refused open moves no money");
    h.warp(9_102, NOW);
    for m in &mkts {
        w.set_price_on(&mut h, m, P150, 5, NOW, 100);
    }
    h.send(&[ixs::close_position_on(&o, &t, &w, &mkts[0], P150)], &[&t.kp]).unwrap();
    h.send(&[ixs::open_position_on(&o, &t, &w, &mkts[8], Side::Long, SOL10, M150, P150)], &[&t.kp]).unwrap();
    let keys: Vec<Pubkey> = mkts.iter().map(|m| m.market).collect();
    assert_invariant_markets(&h, &w, &[&t], &keys);
}

#[test]
fn a_second_open_on_the_same_market_is_refused() {
    let mut h = Harness::new();
    let (w, _btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    h.send(&[ixs::open_position(&o, &t, &w, Side::Long, SOL10, M150, P150)], &[&t.kp]).unwrap();
    h.warp(9_102, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let r = h.send(&[ixs::open_position(&o, &t, &w, Side::Long, SOL10, M150, P150)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::PositionNotEmpty as u32);
}

#[test]
fn the_seventeenth_close_overwrites_the_oldest_history_record() {
    let mut h = Harness::new();
    let (w, _btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    let mut first_closed = 0u64;
    for i in 0..17u64 {
        h.warp(9_200 + i * 2, NOW);
        w.set_price(&mut h, P150, 5, NOW, 100);
        h.send(&[ixs::open_position(&o, &t, &w, Side::Long, SOL10, M150, P150)], &[&t.kp]).unwrap();
        h.warp(9_201 + i * 2, NOW);
        w.set_price(&mut h, P150, 5, NOW, 100);
        h.send(&[ixs::close_position(&o, &t, &w, P150)], &[&t.kp]).unwrap();
        if i == 0 {
            first_closed = h.positions(&t.positions).history[0].closed_slot;
        }
    }
    let p = h.positions(&t.positions);
    assert_eq!(p.history_len, 16);
    assert_eq!(p.history_head, 1);
    assert_ne!(p.history[0].closed_slot, first_closed, "record 17 replaced record 1");
    assert_eq!(p.history[0].reason, CloseReason::User.as_u8());
    assert_invariant(&h, &w, &[&t]);
}
```

У `undelegate.rs`:

```rust
#[test]
fn exit_scrubs_history_and_is_blocked_by_an_open_position_on_any_market() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", MarketParams::sol_perp_defaults());
    h.warp(9_101, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    w.set_price_on(&mut h, &btc, P150, 5, NOW, 100);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let o = t.kp.pubkey();
    h.send(&[ixs::open_position_on(&o, &t, &w, &btc, Side::Long, SOL10, M150, P150)], &[&t.kp]).unwrap();
    let markets = [w.market, btc.market];
    let r = h.send(&[ixs::undelegate_user(&o, &t, &w, &markets)], &[&t.kp]);
    assert!(r.is_err(), "open BTC position blocks the exit");
    h.warp(9_102, NOW);
    w.set_price_on(&mut h, &btc, P150, 5, NOW, 100);
    h.send(&[ixs::close_position_on(&o, &t, &w, &btc, P150)], &[&t.kp]).unwrap();
    assert_eq!(h.positions(&t.positions).history_len, 1);
    // Withdraw everything so the margin gate passes (same helper calls the
    // existing exit tests in this file use).
    drain_to_zero(&mut h, &w, &t);
    h.send(&[ixs::undelegate_user(&o, &t, &w, &markets)], &[&t.kp]).unwrap();
    let raw = h.svm.get_account(&t.positions).unwrap();
    let p = h.positions(&t.positions);
    assert_eq!(p.history_len, 0);
    // Everything after the 8-byte discriminator and the 32-byte owner, except
    // the trailing header (head/len/version/bump/pad/reserved), is zero.
    assert!(raw.data[40..40 + 768 + 1536].iter().all(|b| *b == 0), "no slot or history byte leaves the ER");
    assert!(h.account::<UserAccount>(&t.user).exited);
}
```

(`drain_to_zero` — наявний у файлі шлях «вивести все до нуля»; якщо в `undelegate.rs` він інлайновий — винести в локальну функцію з тим самим кодом. Константи `NOW`, `P150`, `SOL10`, `M150` — як у файлі; бракуючі додати на початок.)

- [ ] **Step 2: запустити.** Очікування: тести або зелені одразу (Task 4 зробив поведінку), або червоні через реальний дефект. Кожен червоний — виправити в програмі мінімальною зміною, повторити `program_autofixer` на зміненому файлі. У звіті — які тести були червоні й чому.
- [ ] **Step 3: PASS** — повний набір (fmt, clippy, build-sbf, unit, LiteSVM); лічильники.
- [ ] **Step 4: commit**

```bash
git add tests/litesvm/tests/markets.rs tests/litesvm/tests/undelegate.rs tests/litesvm/src/ixs.rs programs/dexxer_core/src
git commit -m "test(program): multi-market slots, slot ceiling, history ring, exit scrub"
```

---

### Task 6: ризик #38 — один семпл ціни, один тік ліквідації

**Files:**
- Modify: `programs/dexxer_core/src/instructions/liquidation.rs` (`liq_due`), `programs/dexxer_core/src/state/market.rs` (`sol_perp_defaults().liq_hysteresis_ticks` 3 → 2, якщо там 3)
- Modify: `tests/litesvm/tests/liquidation.rs`, `tests/litesvm/tests/crank.rs` (тести, що тікали двічі в одному слоті)

**Interfaces:**
- Produces: `liq_due` рахує тік лише коли `market.mark_slot > slot.last_liq_mark_slot`.

- [ ] **Step 1: падаючий тест** (`tests/litesvm/tests/liquidation.rs`; ціна краху `P100` = 100_000_000 — якщо константи з такою назвою нема, додати; позиція 10× лонг на $150 ліквідовна за $100):

```rust
#[test]
fn three_checks_on_one_price_sample_count_as_one_tick() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let o = t.kp.pubkey();
    h.send(&[ixs::open_position(&o, &t, &w, Side::Long, SOL10, M150, P150)], &[&t.kp]).unwrap();
    assert_eq!(h.account::<Market>(&w.market).liq_hysteresis_ticks, 2);

    // One crank tick moves the mark onto the crashed price: sample #1.
    h.warp(9_110, NOW);
    w.set_price(&mut h, P100, 5, NOW, 100);
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])], &[&w.crank]).unwrap();
    // Three more checks against the SAME mark_slot: still one tick.
    for i in 0..3u64 {
        h.svm.expire_blockhash();
        h.send(&[ixs::set_compute_unit_limit(200_000 + i as u32), ixs::liquidation_check(&w.crank.pubkey(), &w, &t)], &[&w.crank]).unwrap();
    }
    let s = h.slot(&t, &w.market).expect("not liquidated on one sample");
    assert_eq!(s.liq_ticks, 1);

    // Sample #2 (a new mark_slot) reaches the hysteresis and liquidates.
    h.warp(9_111, NOW);
    w.set_price(&mut h, P100, 5, NOW, 100);
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])], &[&w.crank]).unwrap();
    assert!(h.slot(&t, &w.market).is_none(), "liquidated on the second sample");
    assert_invariant(&h, &w, &[&t]);
}
```

(`set_compute_unit_limit` з різним значенням робить байти трьох транзакцій різними без зміни слота.)

(Шлях ціни — за приміткою в Task 5: якщо стрибок 150 → 100 за один тік вмикає запобіжник відхилення, довести mark до ліквідовного рівня тими ж кроками, що й наявні тести файлу; суть тесту — три перевірки на ОДНОМУ `mark_slot` дають один тік, наступний `mark_slot` — другий.)

- [ ] **Step 2: FAIL** — `cargo +nightly-2026-09-18 test -p dexxer_litesvm --test liquidation three_checks` (зараз: позицію ліквідовано на другому-третьому виклику в тому ж слоті, або дефолт гістерезису 3).

- [ ] **Step 3: реалізація**

```rust
/// Hysteresis with a per-sample guard (risk #38): `liq_ticks` counts distinct
/// price samples, not calls. `crank_tick` and the scheduled
/// `liquidation_check` both land here, several times per mark update — without
/// the guard, three calls in one slot liquidated on a single price.
pub(crate) fn liq_due(slot: &mut PositionSlot, market: &Market, mark: u64) -> Result<bool> {
    if !risk::liquidatable_now(slot, market, mark)? {
        slot.liq_ticks = 0;
        return Ok(false);
    }
    if market.mark_slot > slot.last_liq_mark_slot {
        slot.liq_ticks = slot
            .liq_ticks
            .checked_add(1)
            .ok_or(DexxerError::MathOverflow)?;
        slot.last_liq_mark_slot = market.mark_slot;
    }
    Ok(slot.liq_ticks >= market.liq_hysteresis_ticks)
}
```

Дефолт `liq_hysteresis_ticks` у `MarketParams::sol_perp_defaults()` — 2 (spec §2.9.2: повернення з 3, бо подвійного рахунку більше нема).

- [ ] **Step 4: наявні тести.** Тести ліквідації/crank, які робили кілька тіків в одному слоті й очікували ліквідацію, отримують `h.warp(slot + 1, NOW)` + `set_price` між тіками (нова семантика: потрібні різні `mark_slot`). Числові очікування не змінюються. Перелічити змінені тести у звіті.
- [ ] **Step 5: `program_autofixer`** на `liquidation.rs`, `state/market.rs`.
- [ ] **Step 6: PASS** — повний набір; лічильники.
- [ ] **Step 7: commit**

```bash
git add programs/dexxer_core/src/instructions/liquidation.rs programs/dexxer_core/src/state/market.rs tests/litesvm/tests
git commit -m "fix(program): liquidation hysteresis counts price samples, not calls (risk #38)"
```

---

### Task 7: ризик #39 — рента повертається платнику; власник може закрити сам

**Files:**
- Modify: `programs/dexxer_core/src/state/user.rs` (`rent_payer`, `_reserved`, `USER_ACCOUNT_VERSION = 3`), `programs/dexxer_core/src/instructions/user.rs` (`init_user`, `CloseExitedUser`, `close_exited_user`)
- Modify: `tests/litesvm/src/ixs.rs` (`close_exited_user(closer, t, wd, rent_payer)`), `tests/litesvm/tests/undelegate.rs`

**Interfaces:**
- Produces: `UserAccount { …, exited: bool, rent_payer: Pubkey, _reserved: [u8; 32] }`; `CloseExitedUser`: `[closer (signer), config, rent_payer (mut), user_account, positions]`.

- [ ] **Step 1: падаючі тести** (`tests/litesvm/tests/undelegate.rs`; `exit_trader(h, w, t)` — наявний у файлі шлях «онборд → вийти», якщо інлайновий — винести):

```rust
#[test]
fn close_exited_user_returns_rent_to_whoever_paid_it() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 0); // harness onboards with `payer = owner`
    let o = t.kp.pubkey();
    exit_trader(&mut h, &w, &t);
    let u: UserAccount = h.account(&t.user);
    assert_eq!(pk(u.rent_payer), o, "init_user recorded its payer");
    let rent = h.svm.get_account(&t.user).unwrap().lamports + h.svm.get_account(&t.positions).unwrap().lamports;
    let owner_before = h.svm.get_account(&o).unwrap().lamports;
    // The relayer's fee_payer closes; the lamports go to the recorded payer.
    h.send(&[ixs::close_exited_user(&w.fee_payer.pubkey(), &t, &w, &o)], &[&w.fee_payer]).unwrap();
    assert_eq!(h.svm.get_account(&o).unwrap().lamports, owner_before + rent);
    assert!(h.svm.get_account(&t.user).is_none_or(|a| a.data.is_empty()));
}

#[test]
fn close_exited_user_guards_signer_and_destination() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 0);
    let o = t.kp.pubkey();
    exit_trader(&mut h, &w, &t);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(&[ixs::close_exited_user(&stranger.pubkey(), &t, &w, &o)], &[&stranger]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    // Right signer, wrong destination.
    let r = h.send(&[ixs::close_exited_user(&w.fee_payer.pubkey(), &t, &w, &stranger.pubkey())], &[&w.fee_payer]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    // The owner may close their own accounts.
    h.send(&[ixs::close_exited_user(&o, &t, &w, &o)], &[&t.kp]).unwrap();
}
```

- [ ] **Step 2: FAIL** (білдер/поле ще не існують — помилка компіляції тестового крейта є очікуваним RED; зафіксувати).

- [ ] **Step 3: реалізація**

`state/user.rs` — після `exited`:

```rust
    /// Who funded this owner's rent at `init_user` — `Config.fee_payer` for a
    /// sponsored onboarding, the owner for a self-funded one. `close_exited_user`
    /// returns the lamports here, not to whoever signs the close (risk #39).
    pub rent_payer: Pubkey,
    pub _reserved: [u8; 32],
```

`USER_ACCOUNT_VERSION = 3`. `init_user`: `u.rent_payer = ctx.accounts.payer.key();`.

```rust
#[derive(Accounts)]
pub struct CloseExitedUser<'info> {
    /// `Config.fee_payer` (the relayer's janitor) or the owner themselves.
    pub closer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: lamports destination, pinned to the recorded payer.
    #[account(mut, constraint = rent_payer.key() == user_account.rent_payer @ DexxerError::Unauthorized)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, close = rent_payer, seeds = [USER_SEED, user_account.owner.as_ref()], bump = user_account.bump,
        constraint = closer.key() == config.fee_payer || closer.key() == user_account.owner @ DexxerError::Unauthorized,
        constraint = user_account.exited @ DexxerError::NotExited,
        constraint = user_account.free_margin == 0 && user_account.locked_margin == 0 @ DexxerError::BalanceNotZero)]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(mut, close = rent_payer, seeds = [POSITIONS_SEED, user_account.owner.as_ref()], bump = positions.load()?.bump,
        constraint = positions.load()?.open_count() == 0 @ DexxerError::HasOpenPosition)]
    pub positions: AccountLoader<'info, Positions>,
}
```

Хендлер — `Ok(())`.

- [ ] **Step 4: харнес** — `close_exited_user(closer, t, wd, rent_payer)`; оновити наявні виклики (`rent_payer` = той, хто платив у тесті).
- [ ] **Step 5: `program_autofixer`** на `user.rs`, `state/user.rs`.
- [ ] **Step 6: PASS** — повний набір; лічильники.
- [ ] **Step 7: commit**

```bash
git add programs/dexxer_core/src/state/user.rs programs/dexxer_core/src/instructions/user.rs tests/litesvm/src/ixs.rs tests/litesvm/tests/undelegate.rs
git commit -m "fix(program): close_exited_user returns rent to its payer; owner may close (risk #39)"
```

---

### Task 8: виміри, перевірка IDL, документи

**Files:**
- Modify: `tests/litesvm/tests/markets.rs` (тест-вимір), `programs/dexxer_core/src/state/mod.rs` (`size_tests`)
- Modify: `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` (§2.9 — абзац «**Реалізовано (програма, <дата>)**»), `CLAUDE.md`

- [ ] **Step 1: повна перевірка Rust**

```bash
cargo fmt --check && cargo clippy -p dexxer_core -p mock_oracle -- -D warnings
cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml
cargo test -p dexxer_core -p mock_oracle
cargo +nightly-2026-09-18 test -p dexxer_litesvm
```

- [ ] **Step 2: виміри.** `size_tests`: друкувати `UserAccount`, `Positions::SPACE`, L1-ренту обох (`(space + 128) * 6960`) і префонд permission ×2; асерт `Positions::SPACE == 2416`. Тест-вимір `measure_slots` у `markets.rs` (`-- --nocapture`): CU `init_user`, `open_position`, `close_position`, `increase_position`, `crank_tick` з 16 кандидатами без ліквідацій і з 16 ліквідаціями, `liquidation_check`, `undelegate_user` з 5 ринками в `remaining_accounts`; розмір `.so` (`ls -l target/deploy/dexxer_core.so`). Порівняти CU з `main` там, де є число в `week5-results.md`/spec (crank 16 кандидатів: 166k/367k).
- [ ] **Step 3: IDL — лише перевірка, без коміту в `app/src/idl`.** Згенерувати IDL методом плану мульти-маркету (CLAUDE.md, «Регенерація IDL без `anchor-cli`») у scratch-файл поза репозиторієм; перевірити: інструкцій 37 (47 − 10), серед акаунтів є `Positions` (zero-copy, `serialization: bytemuck`), нема `Position`/`DisclosureQueue`/`Commitment`/`Disclosure`, у `init_user` нема `market`. Список інструкцій — у звіт. `app/src/idl/dexxer_core.json` НЕ чіпати: його заміна разом із TS — перша задача плану 2 (інакше тести relayer-а й `tsc` червоніють посеред гілки).
- [ ] **Step 4: spec «Реалізовано (програма)»** у §2.9: що зроблено по задачах, лічильники тестів (unit, LiteSVM), список видалених тестів одним рядком на категорію, виміри (розміри, рента, CU, `.so`), відхилення від плану (рулінги), відкрите для плану 2 (IDL, TS).
- [ ] **Step 5: CLAUDE.md.**
  - «Архітектура»: рядок «Розкриття — commit-then-reveal…» замінити на «~~Розкриття — commit-then-reveal~~ **скасовано 30.09.2026 (spec §2.9):** угоди не розкриваються; публічні лише огрублений `Pool` і `BalancesRoot`; власна історія трейдера — приватне кільце на 16 записів у `Positions`»; рядки про позицію-PDA й `DisclosureQueue` — під `Positions`.
  - Новий розділ «Правила тижня 6: позиції-слоти (програма, §2.9)»: лейаут і `AccountLoader`/`drop` перед CPI; ринок у даних слота; `NoFreeSlot`; `finalize_close` не може впасти через заповненість; `liq_task_id(positions, market)` і скасування задач у `undelegate_user` через `remaining_accounts`; #38 (семпл, гістерезис 2); #39 (`rent_payer`, власник-closer); crank — пари; `commit_aggregate()` без дій; чистий старт devnet; IDL ще старий до плану 2.
  - Позначити застарілими правила тижнів 3–6 про `DisclosureQueue`/`write_commitment`/`MAX_ACTIONS`/трійки/позиції-на-ринок одним рядком-вказівником на новий розділ (не переписувати історію).
  - Лічильники тестів.
- [ ] **Step 6: commit**

```bash
git add tests/litesvm/tests/markets.rs programs/dexxer_core/src/state/mod.rs docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md CLAUDE.md
git commit -m "docs(week6): position slots implemented in the program — measures and rules"
```
