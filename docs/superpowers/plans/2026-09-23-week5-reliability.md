# Тиждень 5 — Надійність: per-position ліквідації, Close без очікування, reveal за один цикл, Exit із боргом, 0-SOL онбординг

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ліквідації працюють без relayer (per-position scheduler у TEE), Close негайно звільняє позицію і reveal іде за один цикл, Exit не блокується нерозкритими угодами, онбординг проходить з 0 SOL.

**Architecture:** Усі зміни програми — в одному редеплої: `Trade` розширюється (`disclosure_queue`, `fee_escrow`, `task_context`, `magic_program`), `finalize_close` кладе `ClosedRecord` у `DisclosureQueue` і ставить `Position → Empty`; `commit_aggregate` бере commitment і disclosure з черги (при `disclosure_delay_slots == 0` — обидві дії в одному bundle); `mark_committed` вилучається. `open_position` реєструє scheduler-задачу `liquidation_check` з фіксованими акаунтами (рішення open-time vs init-time — після спайку). `undelegate_user` стає частковим; `close_orphan_queue` (crank) закриває сирітські черги. Relayer: DQ-first цикл, `COMMIT_INTERVAL_TICKS`, staleness за `publish_time`, ATA/delegate через fee_payer. App: онбординг без L1 top-up, identity-aware `auth_token`, History/Exit за новою моделлю.

**Tech Stack:** Anchor 1.0.2 / Solana 3.1.9 / Rust 1.89 / `ephemeral-rollups-sdk` 0.16.2 (`ephem`, `crank`, `access-control`); LiteSVM (`cargo +nightly-2026-09-18 test -p dexxer_litesvm`); Node 24 + `tsx`; Express 5 + `pg`; Expo 57 / RN 0.86 / `@solana/web3.js` v1 / `@wallet-ui/react-native-web3js` + `@solana-mobile/mobile-wallet-adapter-protocol-web3js`.

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.6 (2.6.1–2.6.5), §2.1, §3.5–3.6, §7.1. Правила: `CLAUDE.md` («Правила тижня 3/4»).

## Global Constraints

- Усе з тижнів 1–4: `checked_*`, коментарі в коді англійською, `init_if_needed` заборонений, `program_autofixer` на кожен змінений `.rs`, LiteSVM лише після `anchor build`, IDL-копія `app/src/idl/dexxer_core.json` байт-у-байт (CI `cmp`), Node через `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.
- **Приватність незмінна:** коміт ніколи подієвий; `commit_aggregate` комітить лише `Pool` і `BalancesRoot`; `PoolLive`/`MarketRisk`/`Position`/`UserAccount`/`DisclosureQueue` — в жодному `.commit(...)`, крім `undelegate_user`/`close_orphan_queue`; сервери читають лише публічне; relayer тримає лише `crank`/`fee_payer`.
- **Один редеплой програми** (після Tasks 1–3), одна міграція, регресія 06/07/08/09 один раз.
- Помилки додаються лише в кінець `DexxerError` після `PoolLiveMismatch = 6040`: `LiquidationTaskFailed = 6041`, `NotExited = 6042`, `QueueStillPending = 6043`. `QueueFull` (існує) — для Close при 8 нерозкритих.
- `MAX_ACTIONS_PER_COMMIT = 8` (виміряний cap мосту 28/29). `LIQ_TASK_INTERVAL_MS = 5_000`. `task_id` позиції = `i64::from_le_bytes(keccak(position_pubkey)[0..8])`.
- Лейаут: `Position.closed` лишається (завжди `None`) — без зміни лейауту; `UserAccount` отримує `exited: bool` у кінці → `version = 2`; акаунти `version < 2` на devnet crank пропускає, app пропонує повторний онбординг (тестові гаманці).
- Devnet: program `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`, base `https://rpc.magicblock.app/devnet`, TEE `https://devnet-tee.magicblock.app`, validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, mint `2URtQ5L8oJiUtbtXXvbNk3MRoAt4w8DTZ8GB7r4uCZ29`; ключі `tests/er/.keys/devnet-{admin,crank,fee-payer}.json`, payer `spikes/keys/payer.json` (≈5.2 SOL). Relayer `https://relayer-production-1ae7.up.railway.app` (Railway CLI залогінений; MCP-токен протух).
- Ніколи не комітити `keys/` (крім README), `tests/er/.keys/`, `spikes/keys/`, `target/`, `.env`, `node_modules`, `app/.expo/`, `app/android/`-артефакти. Docs українською, код/коміти англійською, UI-рядки англійською. Гілка `week5-reliability`, PR у `main`. Trailers: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, `Claude-Session: https://claude.ai/code/session_01GQKU89DcC5wQNGpFR7XxaP`.
- Емуляторні перевірки дозволені агентам (рішення 23.09); прогін з реальним гаманцем (Phantom/Solflare) — вимір M-K, нагадати користувачу.
- Порядок: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Tasks 5 і 6 не ділять файлів, але виконуються послідовно (спільне дерево).

## Review Focus

1. Close при повній черзі (8 нерозкритих) → `QueueFull`, позиція лишається `Open`, кошти не рухаються — тест `close_with_full_queue_fails_atomically` (Task 1).
2. Повторний `open_position` одразу після Close у тому ж слоті: OI/locked/invariant коректні, новий `task_id` той самий (update) — тест `reopen_immediately_after_close_keeps_invariant` (Task 1) і `open_registers_task_idempotently` (Task 3).
3. `write_disclosure` для запису без `commitment_written` не має потрапити в bundle (delay>0 і запис ще не закомічений) — тест `due_reveals_skips_uncommitted` (Task 1).
4. `undelegate_user` з непорожньою чергою: `UserAccount`/`Position` виходять, черга лишається з members `[crank]`, `exited = true`; повторний `undelegate_user` → `NotExited`-логіка не ламається; `close_orphan_queue` на черзі з `len > 0` → `QueueStillPending` — тести (Task 2).
5. `/sponsor`: ATA з `payer = fee_payer`, але `owner ≠ owner-signer` → відхилено; `delegate_user` з `payer ≠ fee_payer` → відхилено; будь-який `SystemProgram` → відхилено (top-up гілка видалена) — тести (Task 5).

---

## Структура файлів

**Програма** (`programs/dexxer_core/src`)
- `state/mod.rs` — `MAX_ACTIONS_PER_COMMIT = 8`, `LIQ_TASK_INTERVAL_MS`, `liq_task_id(position: &Pubkey) -> i64`.
- `state/user.rs` — `UserAccount.exited: bool`, `version = 2`.
- `state/disclosure.rs` — `DisclosureQueue::push(rec) -> Result<()>`, `pending_commitments(&dq, max) -> Vec<(idx, nonce, hash)>`, `due_reveals` (лише `commitment_written`).
- `instructions/trade.rs` — `Trade` +`disclosure_queue`, `fee_escrow`, `task_context`, `magic_program`; `finalize_close(..., dq)`; `open_position` → `schedule_liquidation_task`; `close_position` → `cancel_liquidation_task` (умовно за спайком).
- `instructions/liquidation.rs` (новий) — `LiquidationCheck`/`liquidation_check`, `schedule_liquidation_task`, `cancel_liquidation_task` (CPI-хелпери).
- `instructions/commit.rs` — DQ-first дії; `process_position_candidate` вилучено.
- `instructions/disclosure.rs` — `mark_committed`/`pending_commitment` вилучено.
- `instructions/crank.rs` — кандидати трійками `[Position, UserAccount, DisclosureQueue]`.
- `instructions/user.rs` — `DelegateUser.payer`, `undelegate_user` частковий, `CloseOrphanQueue`/`close_orphan_queue`, `InitUserReuseQueue`/`init_user_reuse_queue`.
- `errors.rs`, `lib.rs`.

**Тести:** `tests/litesvm/src/{ixs,setup,pdas,lib}.rs`, `tests/litesvm/tests/{disclosure,undelegate,trade,crank,user,liquidation}.rs`.

**Спайк:** `spikes/05-crank-tee/programs/crank-tee/src/lib.rs` (+ `schedule_slot_task`, `cancel_slot_task`), `spikes/05-crank-tee/w5-p3.ts`.

**Relayer** (`services/relayer`): `src/crank.ts`, `src/disclosure.ts`, `src/orphan.ts` (новий), `src/sponsor.ts`, `src/indexer/prices.ts`, `src/index.ts`, `README.md`, `test/{sponsor,feed}.test.ts`.

**App** (`app/src`): `features/onboard/batchOnboarding.ts`, `lib/mwaAuth.ts` (новий), `components/app-providers.tsx`, `lib/program.ts` (`TradeAccounts`), `features/history/{HistoryScreen,useHistoryRows}.tsx`, `features/account/{AccountScreen,ExitSheet}.tsx`, `features/positions/PositionsScreen.tsx`, `lib/status.ts`.

**Devnet/docs:** `tests/er/lib/{admin,trader,program}.ts`, `tests/er/devnet/{05,06,08,10-liquidation-check,11-close-reopen,12-exit-debt}.ts`, `docs/superpowers/plans/week5-results.md`, spec §4.2/§7.1/§7.3, `CLAUDE.md`, `README.md`, `docs/deployments.md`.

---

### Task 0: Спайк P3 — per-position scheduler у TEE (devnet)

**Files:**
- Modify: `spikes/05-crank-tee/programs/crank-tee/src/lib.rs` (+`schedule_slot_task`, `cancel_slot_task`, `slot_tick`), `spikes/05-crank-tee/package.json` (`w5:p3`)
- Create: `spikes/05-crank-tee/w5-p3.ts`, розділ «Task 0» у `docs/superpowers/plans/week5-results.md` (новий файл, шапка як у `week4-results.md`)

**Interfaces:**
- Produces: рядок «Рішення після спайку P3» у `week5-results.md` з шістьма відповідями: (1) N паралельних задач тікають (N=3); (2) вартість реєстрації/тіка (lamports, з якого акаунта); (3) `CancelCrankCpi` з `authority = PDA` програми (`invoke_signed`) проходить; (4) реєстр задач видимий поза TEE (публічний RPC `getProgramAccounts` Magic Program / L1) — так/ні; (5) `instruction_accounts` може містити permissioned акаунт, членом якого scheduler-signer не є — тік виконується; (6) як деривується `task_context` для довільного `task_id` (з SDK `crank::task_context_pda` або вимір). Рішення: **open-time** (реєстрація в `open_position`, cancel у close) або **init-time** (реєстрація в `init_user`, без cancel) — вхід Task 3.

- [ ] **Step 1:** У спайку додати `schedule_slot_task(task_id: i64, interval_ms: i64)` — копія `schedule_increment` з `payer = escrow PDA` (`invoke_signed`, seeds `[b"escrow"]`) і `instruction_accounts = [task_context, crank_signer, counter]`; `cancel_slot_task(task_id)` через `CancelCrankCpi { authority: escrow PDA }` `invoke_signed`; `slot_tick` — інкремент лише якщо `counter.flag == 1` (імітація «позиція Open»).
- [ ] **Step 2:** `w5-p3.ts`: (a) зробити `counter` permissioned `[owner]` через `set_privacy` (спайк 01 патерн уже є в 05? якщо ні — скопіювати `CreateEphemeralPermissionCpi` з `spikes/01`); (b) зареєструвати 3 задачі `task_id = keccak(counter||i)` з `interval 5000`; поллінг 60 с — рахувати інкременти по кожній; (c) записати баланс escrow до/після; (d) `cancel_slot_task` для однієї — тіки припиняються; (e) `getProgramAccounts(MAGIC_PROGRAM_ID)` з публічного (без токена) TEE RPC і base RPC — чи є task-context акаунти; (f) вивести `task_context` адресу, яку прийняв планувальник.
- [ ] **Step 3:** Деплой спайку (`solana program deploy`, ~1.6 SOL, `program close` після), прогін, таблиця результатів у `week5-results.md` §Task 0, рішення open-time/init-time з обґрунтуванням (якщо (4) = видимий → init-time; якщо (5) = не виконується → додати scheduler-signer у members позицій при `init_permissions` і зафіксувати як зміну Task 3).
- [ ] **Commit** `test(spike): per-position scheduler measurements — multi-task, cost, cancel via PDA, registry visibility, permissioned accounts`

---

### Task 1: Close → запис у чергу, `Position → Empty` одразу; commitment і disclosure з черги в одному bundle

**Files:**
- Modify: `programs/dexxer_core/src/state/mod.rs`, `state/disclosure.rs`, `instructions/trade.rs`, `instructions/commit.rs`, `instructions/disclosure.rs`, `instructions/crank.rs`, `lib.rs`, `errors.rs`; `tests/litesvm/src/{ixs,setup}.rs`; `tests/litesvm/tests/{disclosure,trade,crank,commit_actions}.rs`; `app/src/idl/dexxer_core.json`

**Interfaces:**
- Produces: `Trade` accounts order: `[signer, config, market, market_risk, pool_live, user_account, position, feed, disclosure_queue, fee_escrow, task_context, magic_program]` (останні чотири нові; `task_context`/`magic_program` використовуються з Task 3 — тут `UncheckedAccount` без обмежень, `magic_program` з `address = MAGIC_PROGRAM_ID`); `DisclosureQueue::push(&mut self, rec: ClosedRecord) -> Result<()>` (`QueueFull`); `pending_commitments(dq: &mut DisclosureQueue, max: usize) -> Vec<(u64, [u8;32])>` (ставить `commitment_written = true` на записі); `due_reveals` повертає лише `commitment_written && reveal_after_slot <= slot`; `crank_tick` remaining_accounts трійками `[Position, UserAccount, DisclosureQueue]` (`rem.len() % 3 == 0`, `≤ MAX_CANDIDATES`); LiteSVM `ixs::{open_position, close_position, increase_position, decrease_position, add_margin}` приймають `w` і додають нові акаунти; `ixs::crank_tick(.., candidates: &[(Pubkey, Pubkey, Pubkey)])`; `ixs::mark_committed` видалено.

- [ ] **Step 1 (RED):** у `tests/litesvm/tests/disclosure.rs` замінити тести `mark_committed*` на:
```rust
#[test]
fn close_moves_record_to_queue_and_frees_position() {
    let (mut h, w) = World::bootstrap();
    let t = w.new_trader(&mut h, 1_000_000_000);
    h.send(&[ixs::open_position(&t, &w, Side::Long, 1_000_000_000, 20_000_000, u64::MAX)], &[&t.session]).unwrap();
    h.send(&[ixs::close_position(&t, &w, 0)], &[&t.session]).unwrap();
    let pos: Position = h.account(&t.position);
    let dq: DisclosureQueue = h.account(&t.dq);
    assert_eq!(pos.state, PositionState::Empty);
    assert!(pos.closed.is_none());
    assert_eq!(dq.len, 1);
    assert!(!dq.records[0].commitment_written);
    assert_invariant(&h, &w, &[&t]);
}
#[test]
fn reopen_immediately_after_close_keeps_invariant() { /* open → close → open again in the same slot; second open succeeds; assert_invariant */ }
#[test]
fn close_with_full_queue_fails_atomically() { /* 8 × (open+close) → 9th close → assert_custom_error QueueFull; position still Open; invariant holds */ }
#[test]
fn commit_aggregate_emits_commitment_and_disclosure_in_one_bundle_at_delay_zero() {
    // Config.disclosure_delay_slots == 0 (bootstrap default) → after one close, commit_aggregate with [dq] in
    // remaining_accounts: record.commitment_written == true and the tx log contains both
    // "Instruction: WriteCommitment" and "Instruction: WriteDisclosure" CallHandlers (LiteSVM: assert via
    // the action count the program logs `actions=2`).
}
#[test]
fn due_reveals_skips_uncommitted() { /* delay > 0 (set_params); after close, record not committed → commit_aggregate emits 1 action (commitment), never disclosure */ }
```
Run: `cargo +nightly-2026-09-18 test -p dexxer_litesvm --test disclosure` → FAIL (старі акаунти / `mark_committed` ще є).
- [ ] **Step 2:** `state/disclosure.rs`:
```rust
impl DisclosureQueue {
    pub fn push(&mut self, rec: ClosedRecord) -> Result<()> {
        require!((self.len as usize) < DQ_CAPACITY, DexxerError::QueueFull);
        let idx = (self.head as usize).checked_add(self.len as usize).ok_or(DexxerError::MathOverflow)? % DQ_CAPACITY;
        self.records[idx] = rec;
        self.len = self.len.checked_add(1).ok_or(DexxerError::MathOverflow)?;
        Ok(())
    }
}
/// Records not yet committed: marks them written and returns (nonce, hash) for `write_commitment`.
pub fn pending_commitments(dq: &mut DisclosureQueue, max: usize) -> Result<Vec<(u64, [u8; 32])>> {
    let mut out = Vec::new();
    for i in 0..dq.len as usize {
        if out.len() >= max { break; }
        let idx = (dq.head as usize + i) % DQ_CAPACITY;
        let rec = &mut dq.records[idx];
        if !rec.commitment_written {
            let args = DisclosureArgs::from(&*rec);
            out.push((rec.nonce, commitment_hash(&args, &rec.salt)));
            rec.commitment_written = true;
        }
    }
    Ok(out)
}
```
`due_reveals`: умова `rec.commitment_written && rec.reveal_after_slot <= slot`.
- [ ] **Step 3:** `trade.rs`: `Trade` +
```rust
#[account(mut, seeds = [DQ_SEED, user_account.owner.as_ref()], bump = disclosure_queue.bump)]
pub disclosure_queue: Box<Account<'info, DisclosureQueue>>,
#[account(mut, seeds = [FEE_ESCROW_SEED], bump = fee_escrow.bump)]
pub fee_escrow: Box<Account<'info, FeeEscrow>>,
/// CHECK: scheduler task context for this position's liquidation task (Task 3)
#[account(mut)]
pub task_context: UncheckedAccount<'info>,
/// CHECK: address-checked
#[account(address = MAGIC_PROGRAM_ID)]
pub magic_program: UncheckedAccount<'info>,
```
`finalize_close(..., dq: &mut DisclosureQueue, ...)`: замість `pos.closed = Some(rec); pos.state = Closed;` → `dq.push(rec)?; pos.state = PositionState::Empty; pos.closed = None; pos.side = Side::Long; pos.entry = 0; pos.opened_slot = 0; pos.oi_notional = 0;` (решта скидань як тепер). Усі виклики `finalize_close` (close_position, decrease → full close, crank liquidation) передають dq.
- [ ] **Step 4:** `commit.rs`: видалити `process_position_candidate`; у `process_disclosure_queue_candidate` спочатку `pending_commitments(&mut dq, room)` → `write_commitment` дії (accounts як зараз), потім `due_reveals` → `write_disclosure` дії; `MAX_ACTIONS_PER_COMMIT = 8`; `remaining_accounts` тепер лише `DisclosureQueue` (Position ігнорується з помилкою `InvalidCandidate`). `disclosure.rs`: видалити `MarkCommitted`/`mark_committed`/`pending_commitment`; `lib.rs` — прибрати експорт. Ризик #20 знімається (прапорець ставиться в тому ж ER-tx, що планує дію; лишається #26 — дроп дії).
- [ ] **Step 5:** `crank.rs`: трійки `[pos, user, dq]`, перевірка `dq.owner == user.owner` і PDA-адреси; ліквідація викликає `finalize_close(..., &mut dq, ...)` і серіалізує dq назад.
- [ ] **Step 6:** LiteSVM: `ixs.rs` trade-білдери + `crank_tick` трійки; `setup.rs` `trade_accounts` додає `dq`, `fee_escrow`, `task_context = Pubkey::new_unique()` (у LiteSVM Magic program не executable → CPI пропускається, див. Task 3), `magic_program`. Оновити `tests/crank.rs` (кандидати трійками), `tests/commit_actions.rs`, `tests/trade.rs`. Run повний LiteSVM → усі зелені; кількість: 71 − 2 (mark_committed) + 5 = 74.
- [ ] **Step 7:** Гаунтлет (fmt, clippy, autofixer на `trade.rs`, `commit.rs`, `disclosure.rs`, `crank.rs`, `state/disclosure.rs`), `anchor build`, IDL → `app/src/idl/`; tsc у `tests/er`, `scripts`, `app` — **очікувано впаде** на нових акаунтах trade-ixs: оновити `tests/er/lib/trader.ts` (`tradeAccounts` +`disclosureQueue`, `feeEscrow`, `taskContext`, `magicProgram`), `scripts/demo/week1-cli.ts`, `app/src/lib/program.ts` `TradeAccounts` + `taskContext` derivation (`liqTaskContext(position)` — заглушка `PublicKey.default` до Task 3, з коментарем), `services/relayer/src/crank.ts` (трійки). Коміт `feat(core): close pushes the record into DisclosureQueue and frees the position; commitment+disclosure sourced from the queue in one bundle; mark_committed removed`.

---

### Task 2: Exit із боргом розкриття — частковий `undelegate_user`, `close_orphan_queue`, `init_user_reuse_queue`, `UserAccount.exited`

**Files:**
- Modify: `programs/dexxer_core/src/state/user.rs`, `instructions/user.rs`, `lib.rs`, `errors.rs`; `tests/litesvm/src/ixs.rs`; `tests/litesvm/tests/undelegate.rs`, `tests/litesvm/tests/user.rs`

**Interfaces:**
- Produces: `UserAccount { ..., exited: bool }` (`version = 2`, `INIT_SPACE` +1). `undelegate_user` (accounts без змін): при `dq.len == 0` — як тепер (скраб + close permission + `commit_and_undelegate` трьох акаунтів); при `dq.len > 0` — `exited = true`, `UpdateEphemeralPermissionCpi` на `dq` до members `[crank]`, `exit()` + `commit_and_undelegate` лише `[user_account, position]`; `dq` лишається делегованою. **Лейаут `DisclosureQueue` не змінюється** (1156 байт на вже делегованих акаунтах): сирітство визначається не полем, а відсутністю `UserAccount` у ER — після `commit_and_undelegate` акаунт зникає з ER-клону. `close_orphan_queue` (ER, crank) accounts `[crank(s) == config.crank, config, dq (mut), user_account (UncheckedAccount, seeds USER_SEED+dq.owner), dq_permission, ephemeral_vault, permission_program, fee_escrow, magic_fee_vault, magic_context, magic_program]`; вимагає `dq.len == 0` (`QueueStillPending`) і `user_account.data_is_empty() || user_account.owner != &crate::ID` (`NotExited`). `close_queue_l1` (base, `fee_payer`) accounts `[fee_payer(s, mut) == config.fee_payer, config, dq (mut, close = fee_payer, seeds DQ_SEED+dq.owner)]` — rent на `fee_payer`; вимагає `dq.owner_program == crate::ID` (тобто вже undelegated) — інакше Anchor відхиляє власника.
- `init_user_reuse_queue(exit_salt)` accounts `[owner(s), payer(s), config, market, user_account(init), position(init), disclosure_queue(mut, existing, has_one owner), system_program]`.

- [ ] **Step 1 (RED)** `tests/undelegate.rs`:
```rust
#[test]
fn undelegate_with_pending_disclosures_keeps_queue() { /* open+close (record in dq, len 1) → withdraw all → undelegate_user: Ok; UserAccount.exited == true; dq.len still 1; position Empty */ }
#[test]
fn close_orphan_queue_requires_empty_queue_and_exited_user() { /* after the above: close_orphan_queue → QueueStillPending; then simulate reveal (commit_aggregate with delay 0 → due → record removed) → close_orphan_queue by crank Ok; by stranger → Unauthorized */ }
#[test]
fn init_user_reuse_queue_reactivates() { /* after full exit with orphan queue present: init_user → fails (dq exists); init_user_reuse_queue → Ok, exited == false, dq untouched */ }
```
Run → FAIL.
- [ ] **Step 2:** `state/user.rs`: `pub exited: bool` у кінці, `version` константа 2, `INIT_SPACE` авто. `instructions/user.rs`: `undelegate_user`: прибрати `require!(dq.len == 0)`; гілка `if a.dq.len == 0 { /* як тепер: скраб + close permission + commit_and_undelegate 3 акаунти */ } else { u.exited = true; UpdateEphemeralPermissionCpi на dq → build_admin_members-подібний `[crank]` (нова `build_crank_only(crank)` у `state/permissions.rs`); exit() лише user_account/position; commit_and_undelegate(&[user_account, position]) }`.
- [ ] **Step 3:** `CloseOrphanQueue { crank: Signer (== config.crank), config, dq (mut, seeds DQ_SEED+dq.owner), user_account: UncheckedAccount (seeds USER_SEED+dq.owner), dq_permission, ephemeral_vault, permission_program, fee_escrow, magic_fee_vault, magic_context, magic_program }`; тіло: `require!(dq.len == 0, QueueStillPending)`; `require!(user_account.data_is_empty() || user_account.owner != &crate::ID, NotExited)`; скраб `dq`; `dq.exit()`; `close_permission_if_present(dq)`; `commit_and_undelegate(&[dq])` через `FeeEscrow` (як у `undelegate_user`). Rent на L1: `CloseQueueL1 { fee_payer: Signer (mut, constraint = key == config.fee_payer), config, dq: Account<DisclosureQueue> (mut, close = fee_payer, seeds DQ_SEED+dq.owner) }` → `close_queue_l1` без тіла (Anchor `close`). Тест `close_queue_l1_returns_rent_to_fee_payer` у `tests/user.rs` (LiteSVM: dq не делегована → закривається; stranger → constraint fail).
- [ ] **Step 4:** `InitUserReuseQueue` + `init_user_reuse_queue` (копія `init_user` без `init` на `disclosure_queue`, `constraint = disclosure_queue.owner == owner.key()`; `extra` prefund лише для user_account/position). `lib.rs` експорти. Autofixer, LiteSVM (74 → 78), IDL, tsc ×3 (TS-білдери для нових інструкцій — у Task 6/7, тут лише IDL-типи).
- [ ] **Commit** `feat(core): exit with disclosure debt — partial undelegate_user keeps a pending DisclosureQueue; close_orphan_queue/close_queue_l1; init_user_reuse_queue; UserAccount.exited`

---

### Task 3: P1 `DelegateUser.payer` + P3 `liquidation_check` і реєстрація/скасування задачі

**Files:**
- Create: `programs/dexxer_core/src/instructions/liquidation.rs`; `tests/litesvm/tests/liquidation.rs`
- Modify: `instructions/user.rs` (`DelegateUser`), `instructions/trade.rs` (`open_position`/`close_position` CPI), `instructions/mod.rs`, `lib.rs`, `state/mod.rs`, `state/permissions.rs`; `tests/litesvm/src/{ixs,pdas}.rs`, `tests/litesvm/tests/user.rs`

**Interfaces:**
- Produces: `DelegateUser` accounts `[owner(s), payer(s,mut), config, market, user_account, position, disclosure_queue]` — `payer` одразу після `owner`; `delegate_*` CPI з `payer = payer`. `liquidation_check` accounts `[crank(s: == config.scheduler_signer), config, market, market_risk, pool_live, feed, position, user_account, disclosure_queue]`; `liq_task_id(&Pubkey) -> i64`; `LIQ_TASK_INTERVAL_MS = 5_000`; `schedule_liquidation_task(ctx-fields…)`/`cancel_liquidation_task` — виконуються лише якщо `magic_program.executable` (LiteSVM no-op). Клієнт: `taskContext = crank::task_context_pda(task_id)` (за Task 0 п.6) — `pdas::liq_task_context(position)` у LiteSVM, `pdas.liqTaskContext(position)` у TS.
- Рішення open-time/init-time — з `week5-results.md` §Task 0; нижче описано open-time; для init-time реєстрація переїжджає в `init_user`/`init_user_reuse_queue`, cancel не викликається, а `init_permissions` додає `config.scheduler_signer` у members позиції, якщо спайк (5) це вимагав.

- [ ] **Step 1 (RED)** `tests/liquidation.rs`:
```rust
#[test]
fn liquidation_check_liquidates_underwater_position() { /* open Long 10x; set_price down 15%; ixs::liquidation_check(scheduler_signer) → position Empty, dq.len 1, reason Liquidated; assert_invariant */ }
#[test]
fn liquidation_check_noop_when_healthy_or_stale() { /* healthy → no change; stale feed (posted_slot old) → no change, no error */ }
#[test]
fn liquidation_check_rejects_non_scheduler_signer() { /* stranger → Unauthorized */ }
#[test]
fn open_registers_task_idempotently() { /* LiteSVM: magic program non-executable → open logs "liq task: skipped (no magic program)"; two opens (close between) succeed */ }
```
`tests/user.rs`: `delegate_user_with_separate_payer` (owner ≠ payer; payer funds delegation records; owner balance unchanged except fee).
- [ ] **Step 2:** `liquidation.rs`: контекст `LiquidationCheck` (Box-акаунти; `crank: Signer` з `constraint = crank.key() == config.scheduler_signer || crank.key() == config.crank`); тіло — витяг гілки ліквідації з `crank_tick` у спільну `fn try_liquidate_pair(market, risk, pool_live, user, pos, dq, mark, clock) -> Result<bool>` у `instructions/risk_liq.rs` (або в `trade.rs`), яку викликають і `crank_tick`, і `liquidation_check`; `read_price` stale → `Ok(())`. Хелпери:
```rust
pub fn schedule_liquidation_task<'info>(fee_escrow: &Account<'info, FeeEscrow>, magic_program: &AccountInfo<'info>, task_context: &AccountInfo<'info>, ix_accounts: &[AccountInfo<'info>], ix: Instruction, task_id: i64) -> Result<()> {
    if !magic_program.executable { msg!("liq task: skipped (no magic program)"); return Ok(()); }
    let bump = fee_escrow.bump; let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &[bump]];
    ScheduleCrankCpi { payer: &fee_escrow.to_account_info(), magic_program, instruction_accounts: ix_accounts,
        args: ScheduleTaskArgs { task_id, execution_interval_millis: LIQ_TASK_INTERVAL_MS, iterations: i64::MAX, instructions: vec![ix] } }
    .invoke_signed(&[seeds]).map_err(Into::into)
}
```
(`invoke_signed` — якщо SDK CPI-структура не має `invoke_signed`, викликати `invoke` з `payer` = `fee_escrow` як PDA-signer через `solana_program::program::invoke_signed` на зібраній інструкції — Task 0 п.3 показує, який шлях працює; повторити його.) `cancel_liquidation_task` аналогічно з `CancelCrankCpi { authority: fee_escrow }`.
- [ ] **Step 3:** `open_position` наприкінці: зібрати `liquidation_check` `Instruction` з `AccountMeta`-списком (`crank_signer = config.scheduler_signer` як signer) і `instruction_accounts = [task_context, crank_signer(UncheckedAccount у Trade — додати `scheduler_signer: UncheckedAccount` з `address = config.scheduler_signer`), config, market, market_risk, pool_live, feed, position, user_account, disclosure_queue]` → `schedule_liquidation_task(...)`. `close_position` і ліквідаційна гілка (open-time): `cancel_liquidation_task(...)` — у `crank_tick`/`liquidation_check` cancel не викликається (без `task_context` у їхніх акаунтах) — задача лишається і тікає no-op до наступного open (update) або cancel при `undelegate_user` (додати `task_context` у `UndelegateUser`). Зафіксувати в коментарі.
- [ ] **Step 4:** `DelegateUser.payer`; `delegate_user` CPI з `&ctx.accounts.payer`. `state/mod.rs`: `pub fn liq_task_id(position: &Pubkey) -> i64 { i64::from_le_bytes(keccak::hashv(&[position.as_ref()]).to_bytes()[0..8].try_into().unwrap()) }`.
- [ ] **Step 5:** LiteSVM білдери: `ixs::delegate_user(owner, payer, w)`, `ixs::liquidation_check(signer, w, t)`, `pdas::liq_task_context`; `setup.rs` `trade_accounts` → реальний `task_context`. Run: LiteSVM 78 → 83. Autofixer на всіх змінених `.rs`, fmt, clippy, `anchor build`, IDL, tsc ×3 (додати `payer` у TS `delegateUser` білдери: `tests/er/lib/trader.ts`, `app` batch).
- [ ] **Commit** `feat(core): per-position liquidation_check scheduler task registered on open; delegate_user payer split`

---

### Task 4: Редеплой devnet, міграція, регресія

**Files:** Modify `tests/er/lib/admin.ts` (bootstrap: нічого нового в Config; але `init_permissions`/`init_market_permissions` за рішенням Task 0 п.5 — додати scheduler-signer у members позицій, якщо потрібно), `tests/er/devnet/{05,06,08}*.ts` (нові акаунти trade/undelegate, без `mark_committed`), `docs/superpowers/plans/week5-results.md` §Task 4.

- [ ] `anchor build`; `solana program show` → data len ≥ `.so`? інакше `solana program extend … 131072`; `solana program deploy … --program-id G2okX5… -k spikes/keys/payer.json --upgrade-authority spikes/keys/payer.json`; баланси до/після.
- [ ] `npm run devnet:bootstrap` (ідемпотентно). Legacy `UserAccount` (`version < 2`) — crank пропускає; записати кількість.
- [ ] Регресія: `devnet:liquidation` (05, тепер трійки), `devnet:disclosure` (06 — без `mark_committed`, reveal за один цикл при delay 0), `devnet:undelegate` (08), `devnet:snapshot` (09) — усі PASS; сигнатури в results.
- [ ] Коміт `test(devnet): week-5 redeploy + regression 05/06/08/09 on the queue-first disclosure model`

---

### Task 5: Relayer — DQ-first цикл, orphan queues, інтервал, staleness за `publish_time`, sponsor-shapes

**Files:**
- Create: `services/relayer/src/orphan.ts`, `services/relayer/test/orphan.test.ts`
- Modify: `src/disclosure.ts`, `src/crank.ts`, `src/index.ts`, `src/sponsor.ts`, `src/indexer/prices.ts`, `src/indexer/http.ts`, `test/sponsor.test.ts`, `test/feed.test.ts`, `README.md`, `.github/workflows/ci.yml` (без змін, перевірити)

**Interfaces:**
- `COMMIT_INTERVAL_TICKS` (env, default 300) замінює константу `DISCLOSURE_EVERY_TICKS`; `/healthz.commitIntervalTicks`.
- `runDisclosureCycle`: кандидати = лише `DisclosureQueue` з (`len > 0` і (є `!commitment_written` або є due)); крок `mark_committed` видалено.
- `runOrphanCycle(ctx)` (раз на `COMMIT_INTERVAL_TICKS`): gPA `DisclosureQueue` з `len == 0`, чий `UserAccount` PDA **відсутній у ER** (`getAccountInfo` через crank-конекшн → null) → `close_orphan_queue` (crank, ER), дочекатися undelegation на base (`owner == crate::ID`), потім `close_queue_l1` (`fee_payer`, base).
- Staleness: `isStale(lastTs, now)` → `isStale(publishTimeMs, now)`; `/mark` → `{price, slot, ts, publishTime, stale}`; `oracleStale` у healthz за `publishTime`.
- Sponsor: `CORE_SHAPES.delegate_user = { ownerIdx: 0, payerIdx: 1 }`; `ATA_SHAPE = { payerIdx: 0, ownerIdx: 2 }`; видалити SystemProgram-гілку, `allowSessionTopUp`, `SPONSOR_ALLOW_SESSION_TOPUP`, `init_permissions`/`set_session` з whitelist (ER-леґ не спонсорується); тести: ATA з payer=fee_payer і owner≠signer → reject; delegate_user payer≠fee_payer → reject; будь-який SystemProgram → reject; успішний L1a/L1b.

- [ ] Steps: RED тести (sponsor 4 нових, orphan 2: «черга з len>0 не закривається», «черга з відсутнім UserAccount закривається»; feed: `isStale` за `publishTime`) → реалізація → `npm test` (61 → ~68), tsc → `railway up --service relayer` → `/healthz` 200 → `curl /mark` має `publishTime`. Коміт `feat(relayer): queue-first disclosure cycle, orphan-queue closer, COMMIT_INTERVAL_TICKS, publish_time staleness, fee_payer-paid ATA/delegate shapes`.

---

### Task 6: App — онбординг без top-up, identity-aware MWA auth, History/Positions/Exit за новою моделлю

**Files:**
- Create: `app/src/lib/mwaAuth.ts`, `app/src/features/history/useHistoryRows.ts`
- Modify: `app/src/features/onboard/batchOnboarding.ts`, `app/components/app-providers.tsx`, `app/src/lib/program.ts`, `app/src/features/history/HistoryScreen.tsx`, `app/src/features/positions/PositionsScreen.tsx`, `app/src/features/account/{AccountScreen,ExitSheet}.tsx`, `app/src/lib/status.ts`, `app/src/features/onboard/OnboardScreen.tsx`

**Interfaces:**
- `batchOnboarding`: L1a `[ATA CreateIdempotent(payer=feePayer), faucet_init(payer), init_user(payer) | init_user_reuse_queue(payer)]` (вибір за наявністю DQ PDA), L1b `[...delegateSpl({payer: feePayer}), delegate_user(payer)]`, ER `[init_permissions, set_session]` (owner-paid); top-up-леґ видалено; `SESSION_LAMPORTS` не використовується.
- `mwaAuth.ts`: `identityHash(identity)`, `loadAuthToken(): {token, identityHash} | null`, `ensureAuthorized(wallet)` → якщо збережений hash ≠ поточний → `wallet.deauthorize({auth_token})` → `authorize` без токена; `disconnect()` → `deauthorize`. Використовує `transact` з `@solana-mobile/mobile-wallet-adapter-protocol-web3js` (уже транзитивна залежність `@wallet-ui`; додати в `package.json` явно).
- `TradeAccounts` +`disclosureQueue`, `feeEscrow`, `taskContext` (`pdas.liqTaskContext(position)`), `magicProgram`, `schedulerSigner` (з `Config.scheduler_signer`).
- History: джерела = DQ записи (`commitment_written` → `committing`/`reveals_in`) + L1 `Disclosure`; джерело `Position.closed` видалено; статус `pending_commitment` для `!commitment_written`.
- Exit: чеклист `noOpenPosition`, `balanceWithdrawn`, інформаційно `pendingDisclosures: N` («N trades will be revealed after you exit»); кнопка активна без умови на чергу; після exit — Onboard-гейт показує Connect/Set up (`init_user_reuse_queue`).
- Onboard copy: «No SOL needed — account rent is sponsored».

- [ ] Steps: RED — `__DEV__` self-checks для `identityHash` і History merge без Position-джерела; реалізація; `npx tsc --noEmit`, `npm run lint:check`, prettier; емулятор: свіжий fakewallet-акаунт з **0 SOL** → Connect → Set up (2 промпти) → Deposit → Long → Close → History «Committing…» → Open знову одразу → Exit при непорожній черзі → повторний Connect/Set up (reuse queue). Скріншоти `docs/superpowers/plans/assets/week5-*.png`. Коміти: `feat(app): zero-SOL onboarding — fee_payer-paid ATA/delegation, no L1 session top-up`, `feat(app): identity-aware MWA auth token (deauthorize on identity change/disconnect)`, `feat(app): History/Positions/Exit on the queue-first disclosure model`.

---

### Task 7: Devnet-виміри M-G′, M-H, M-I, M-J, M-K

**Files:** Create `tests/er/devnet/10-liquidation-check.ts`, `11-close-reopen.ts`, `12-exit-debt.ts`; Modify `tests/er/package.json`, `docs/superpowers/plans/week5-results.md`.

- [ ] **M-G′ (10):** relayer `CRANK_ENABLED=false` (Railway env + redeploy) → свіжий трейдер, позиція з liq поруч із mark (`set_params` тимчасово, як у тижні 4, з відновленням) → поллінг ≤3 хв: `Position → Empty`, `dq.len == 1`, `reason == Liquidated` без relayer → PASS; `CRANK_ENABLED=true`.
- [ ] **M-H:** `COMMIT_INTERVAL_TICKS=60` на Railway; Close → `Disclosure` на L1 за ≤ один цикл (секунди); повернути 300 або лишити 60 для демо (записати рішення).
- [ ] **M-J (11):** open → close → open у наступній tx (той самий слот) PASS; 8 закриттів → 9-те `QueueFull` → після reveal знову OK.
- [ ] **M-I (12):** гаманець з 0 SOL: онбординг через `/sponsor` → Long → Close → `undelegate_user` з `len > 0` → crank: reveal → `close_orphan_queue` → `close_queue_l1` → rent на fee_payer; `init_user_reuse_queue` → повторний онбординг.
- [ ] **M-K (нагадати користувачу):** прогін на емуляторі з **Phantom** (devnet mode, sideload APK): SIWS показує «Dexxer», `signTransactions` з 3 payload одним екраном, ER-леґ з TEE-blockhash підписується; результат у results (PASS/нюанси).
- [ ] Коміт `test(devnet): week-5 measurements — liquidation without relayer, one-cycle reveal, close→reopen, exit with debt, real-wallet run`

---

### Task 8: Документи

**Files:** `docs/superpowers/plans/week5-results.md` (повний), spec §4.2 (`liquidation_check`, `close_orphan_queue`, `close_queue_l1`, `init_user_reuse_queue`, нові акаунти `Trade`/`DelegateUser`), §7.1 (#18 закрито, #20 знято, #22 закрито, #26 лишається, нові: видимість реєстру задач / вартість per-position тіків / legacy `UserAccount v1`), §7.3; `CLAUDE.md` «Правила тижня 5» (≤10 пунктів: queue-first, no mark_committed, Trade accounts, task_id, exit with debt, sponsor shapes, интервал, staleness); `README.md` («Чесні обмеження», quick start); `docs/deployments.md` (нові env, інструкції). Коміт `docs(week5): results, spec §4.2/§7.1/§7.3, CLAUDE.md week-5 rules, README`.

---

### Task 9: Тех-борг

**Files:** `app/src/features/history/HistoryScreen.tsx` (→ ≤200 рядків, `HistoryRow.tsx` + `useHistoryRows.ts`), видалити `app/src/features/trade/PositionScreen.tsx` + `app/app/(tabs)/position.tsx` (роут прибрати з `_layout.tsx`), `programs/dexxer_core/src/instructions/permissions.rs` (винести `InitPermissions`/`SetSession`/`InitMarketPermissions` з `user.rs`, спільний `apply_permission_updates(pairs, members, vault, magic, permission_program)`), `app/src/ui/{Toast,Sheet}.tsx` (таймери/unmount), `services/relayer/src/indexer/http.ts` (WS ping/pong 30 с). Тести без змін у поведінці: LiteSVM/unit/relayer/tsc/lint зелені. Коміт `refactor: permissions module, History split, remove legacy PositionScreen, UI timers, WS heartbeat`.

---

## Не в цьому плані (тиждень 6+)
#27 (`/sponsor` SIWS + L1-гейт/invite), мульти-маркет (кілька одночасних позицій), відео/пітч/тег `v0.4-mvp`, Seeker Connect, ZK-знімок, iOS.

## Self-review (виконано при написанні)
- **Spec §2.6 coverage:** 2.6.1 → T0, T3, T7 (M-G′); 2.6.2 → T1, T5, T7 (M-H, M-J); 2.6.3 → T2, T5 (orphan), T6 (Exit), T7 (M-I); 2.6.4 → T3 (payer), T5 (shapes, staleness, інтервал), T6 (0-SOL, auth); 2.6.5 → T4, T7, T8, T9.
- **Уточнення, що виникли з коду (внесено в spec §2.6 окремим коммітом):** `Trade` розширюється на 4 акаунти (dq, fee_escrow, task_context, magic_program); `mark_committed` вилучається; `DisclosureQueue` лейаут не змінюється — сирітство визначається відсутністю `UserAccount` у ER; `close_queue_l1` підписує `fee_payer`; `UserAccount v2` (`exited`).
- **Type consistency:** `pending_commitments`/`due_reveals` (T1) ↔ T5 relayer кандидати; `liq_task_id`/`pdas.liqTaskContext` (T3) ↔ T6 `TradeAccounts` ↔ T7 скрипти; `close_orphan_queue`/`close_queue_l1` (T2) ↔ T5 `orphan.ts`; `DelegateUser.payer` (T3) ↔ T5 shape ↔ T6 leg.
- **Placeholders:** усі «за рішенням Task 0» мають обидві гілки описані (open-time/init-time); немає TBD.
