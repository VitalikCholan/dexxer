# Тиждень 4 — MVP polish: приватний агрегат, relayer, онбординг в один клік, UI, подача

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрити ризик #24 (`PoolLive` + `Pool`-знімок), винести crank/індексер на Railway, зробити онбординг одним підтвердженням гаманця, реалізувати UI за макетами Claude Design і підготувати подачу (README, відео, пітч, `v0.4-mvp`).

**Architecture:** Живі лічильники пулу переїжджають у permissioned `PoolLive` (ніколи не комітиться); публічний `Pool` стає огрубленим знімком, який пише лише `commit_aggregate` раз на 5 хв. Єдиний привілейований сервіс `services/relayer` (crank + індексер публічних даних + `/sponsor`) працює на Railway; MagicBlock scheduler з `iterations = i64::MAX` — резерв для ліквідацій. Клієнт підписує онбординг однією пачкою `signTransactions`, читає приватний стан через `accountSubscribe` owner-TEE, UI — токени з `docs/design/tokens.json`.

**Tech Stack:** Anchor 1.0.2 / Solana 3.1.9 / Rust 1.89 / `ephemeral-rollups-sdk` 0.16.2; LiteSVM (`cargo +nightly-2026-09-18 test -p dexxer_litesvm`); Node 24.18 + `tsx`; Railway (Dockerfile, volume, variables); Expo 57 / RN 0.86 / `@solana/web3.js` v1 / `@wallet-ui/react-native-web3js` (MWA) / `react-native-svg` / `expo-secure-store`.

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.5 (дизайн тижня 4), §2.1 (акаунти), §3.6 (інваріант), §5.5 (UI), §7.1 #22–#26. Дизайн-джерела: `docs/design/Dexxer App.dc.html`, `docs/design/tokens.json`, `docs/design/claude-design-prompt.md` (інспірейшн; адаптувати під логіку).

## Global Constraints

- Усе з Global Constraints тижнів 1–3: `checked_*`, коментарі в коді англійською, `init_if_needed` заборонений, `program_autofixer` на кожен змінений `.rs` (навіть doc-коментар), LiteSVM лише після `anchor build`, Node через `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`, IDL-копія `app/src/idl/dexxer_core.json` байт-у-байт з `target/idl` після кожного `anchor build` (CI перевіряє `cmp`).
- **Приватність:** сирий приватний акаунт ніколи не комітиться на L1. `commit_aggregate` комітить **лише `Pool` і `BalancesRoot`**. `PoolLive`, `MarketRisk`, `Position`, `UserAccount`, `DisclosureQueue` — в жодному `.commit(...)`, крім `undelegate_user`. `Pool` пишеться **лише** в `init_pool`, `seed_pool`-міграції (`init_pool_live` копіює з нього) і `commit_aggregate` (знімок).
- **Огрублення знімка:** `SNAPSHOT_STEP: u64 = 100_000_000` (100 dUSDC, 6 знаків). Активи (`capital_total`, `protocol_liquidity`, `insurance`, `fees_accrued`) → `floor_step`, зобовʼязання (`locked_total`, `bad_debt_total`) → `ceil_step`. Слот знімка — існуюче `Pool.last_commit_slot`.
- **Сервери читають лише публічні акаунти L1/ER і оракул** (CLAUDE.md, 22.09): relayer тримає лише `crank` і `fee_payer`; жодних owner/session-токенів; приватний стан читає лише клієнт через owner-TEE.
- **Помилки додаються лише в кінець** `DexxerError`: `SponsorNotAllowed` не потрібен (relayer-side); нова програмна помилка одна — `PoolLiveMismatch = 6040` (PoolLive.mint ≠ Pool.mint).
- Devnet: program `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`, base `https://rpc.magicblock.app/devnet`, TEE `https://devnet-tee.magicblock.app` (WS `wss://devnet-tee.magicblock.app?token=…`), validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, fee vault `EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b`, mint `2URtQ5L8oJiUtbtXXvbNk3MRoAt4w8DTZ8GB7r4uCZ29`, oracle `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`; ключі `tests/er/.keys/devnet-{admin,crank,fee-payer}.json`, payer `spikes/keys/payer.json` (≈6.1 SOL; редеплой ≈ 0.5 extend + 5.3 float).
- Ніколи не комітити нічого під `keys/` (крім README), `tests/er/.keys/`, `spikes/keys/`, `target/deploy/*-keypair.json`, `magicblock-test-storage/`, `.env`; не чіпати `.agents/`, `.claude/`, `skills-lock.json`. Docs українською, код/коміти англійською; UI-рядки англійською (як у макеті). Гілка `week4-mvp-polish`, PR у `main`.
- Порядок задач фіксований: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 (інфраструктура спочатку; 8–10 можуть іти паралельно з 4–7 після Task 3, бо не ділять файлів).

---

## Структура файлів

**Програма**
- Create `programs/dexxer_core/src/state/pool_live.rs` — `PoolLive` + `snapshot_into(&self, pool: &mut Pool, slot)`; Modify `state/mod.rs` (`POOL_LIVE_SEED`, `SNAPSHOT_STEP`), `state/pool.rs` (doc: знімок), `errors.rs` (+`PoolLiveMismatch`).
- Create `programs/dexxer_core/src/instructions/pool_live.rs` — `InitPoolLive`/`init_pool_live`, `DelegatePoolLive`/`delegate_pool_live`; `math.rs` (+`floor_step`, `ceil_step`).
- Modify `instructions/trade.rs`, `instructions/user.rs` (`credit_deposit`, `withdraw`), `instructions/admin.rs` (`seed_pool`), `instructions/crank.rs`, `risk.rs` — `pool` → `pool_live`; `instructions/commit.rs` (`CommitAggregate` +`pool_live`, знімок); `instructions/user.rs` (+`InitMarketPermissions`/`init_market_permissions`), `state/permissions.rs` (+`build_admin_members`); `lib.rs`.
- Tests: `tests/litesvm/src/{setup,ixs,pdas,lib}.rs`, new `tests/litesvm/tests/pool_live.rs`.

**Relayer**
- Create `services/relayer/` (переїзд `scripts/crank-fallback/*` через `git mv`): `src/index.ts` (процес), `src/crank.ts` (з `index.ts`), `src/disclosure.ts`, `src/indexer/{prices,accounts,store,http}.ts`, `src/sponsor.ts`, `src/health.ts`, `Dockerfile`, `railway.json`, `package.json`, `tsconfig.json`, `README.md`; `scripts/package.json` `crank` → делегує в `services/relayer`.
- Modify `tests/er/lib/env.ts` (+`loadKeyFromEnv(name)`), `tests/er/lib/admin.ts` (bootstrap: `init_pool_live`, `delegate_pool_live`, `init_market_permissions`), `tests/er/devnet/09-pool-snapshot.ts` (new), `tests/er/package.json`, `scripts/admin/schedule-eternal.ts` (new).

**App**
- Create `app/src/theme/{tokens.ts,index.ts}`, `app/src/ui/{Button,Input,Segment,LeverageSlider,Card,Badge,Sheet,Toast,Skeleton,EmptyState,Address}.tsx`, `app/src/lib/indexer.ts`, `app/src/features/ledger/LedgerScreen.tsx`, `app/src/features/positions/PositionsScreen.tsx`, `app/src/features/account/AccountScreen.tsx`, `app/src/features/onboard/OnboardScreen.tsx` (новий), `app/src/features/trade/{PriceChart,TradeTicket}.tsx`, `app/app/(tabs)/{positions,ledger}.tsx`.
- Modify `app/src/lib/live.ts` (WS), `app/src/features/onboard/useOnboarding.ts` (пачка + sponsor), `app/src/features/history/HistoryScreen.tsx`, `app/src/features/trade/TradeScreen.tsx`, `app/app/(tabs)/_layout.tsx`, `app/app/(tabs)/settings/index.tsx` (Developer), `app/src/lib/solana.ts` (`INDEXER_URL`).

**Docs/подача:** `README.md` (заміна), `docs/deployments.md`, `docs/superpowers/plans/week4-results.md`, `docs/superpowers/plans/assets/week4-*.png`, spec §7.3/§4.2, `CLAUDE.md`.

---

### Task 0: `PoolLive` — стан, seeds, огрублення, `init_pool_live`/`delegate_pool_live`

**Files:**
- Create: `programs/dexxer_core/src/state/pool_live.rs`, `programs/dexxer_core/src/instructions/pool_live.rs`, `tests/litesvm/tests/pool_live.rs`
- Modify: `programs/dexxer_core/src/state/mod.rs`, `programs/dexxer_core/src/math.rs`, `programs/dexxer_core/src/errors.rs` (append), `programs/dexxer_core/src/instructions/mod.rs`, `programs/dexxer_core/src/lib.rs`, `tests/litesvm/src/pdas.rs`, `tests/litesvm/src/ixs.rs`, `tests/litesvm/src/setup.rs`

**Interfaces:**
- Produces: `POOL_LIVE_SEED = b"pool_live"`, `SNAPSHOT_STEP: u64 = 100_000_000`; `math::floor_step(x: u64, step: u64) -> u64`, `math::ceil_step(x: u64, step: u64) -> Result<u64, MathError>`; `PoolLive { version, mint, capital_total, protocol_liquidity, locked_total, fees_accrued, insurance, bad_debt_total, bump }` з `PoolLive::snapshot_into(&self, pool: &mut Pool, slot: u64) -> Result<()>`; ixs `init_pool_live(ctx)` (admin, base; копіює з `Pool`), `delegate_pool_live(ctx)` (admin, base); `pdas::pool_live(mint)`, `ixs::init_pool_live(admin, mint)`, `World.pool_live: Pubkey` (bootstrap викликає `init_pool_live` одразу після `seed_pool`).

- [ ] **Step 1: Seeds, крок, помилка**

`state/mod.rs` після `BALANCES_ROOT_SEED`:
```rust
pub const POOL_LIVE_SEED: &[u8] = b"pool_live";
/// Public `Pool` snapshot granularity: 100 dUSDC (6 decimals). Assets round down, liabilities round up (spec §2.5.1).
pub const SNAPSHOT_STEP: u64 = 100_000_000;
```
`errors.rs` — в кінець enum: `#[msg("PoolLive mint does not match Pool mint")] PoolLiveMismatch,` (= 6040). `state/mod.rs`: `pub mod pool_live; pub use pool_live::*;`.

- [ ] **Step 2: Unit-тест огрублення (RED)**

`math.rs` `#[cfg(test)]`:
```rust
#[test]
fn step_rounding() {
    const S: u64 = 100_000_000;
    assert_eq!(floor_step(0, S), 0);
    assert_eq!(floor_step(99_999_999, S), 0);
    assert_eq!(floor_step(250_000_000, S), 200_000_000);
    assert_eq!(ceil_step(0, S).unwrap(), 0);
    assert_eq!(ceil_step(1, S).unwrap(), 100_000_000);
    assert_eq!(ceil_step(200_000_000, S).unwrap(), 200_000_000);
    assert!(ceil_step(u64::MAX, S).is_err());
}
```
Run: `cargo test -p dexxer_core step_rounding` → FAIL (not found).

- [ ] **Step 3: Реалізація**

```rust
/// Round down to a multiple of `step` (pool-favouring for assets in the public snapshot).
pub fn floor_step(x: u64, step: u64) -> u64 { x - x % step }
/// Round up to a multiple of `step` (conservative for liabilities). Errors on overflow.
pub fn ceil_step(x: u64, step: u64) -> Result<u64, MathError> {
    let r = x % step;
    if r == 0 { return Ok(x); }
    x.checked_add(step - r).ok_or(MathError::Overflow)
}
```
(`MathError::Overflow` — використати наявний варіант переповнення в `math.rs`; якщо він називається інакше — взяти його, не додавати новий.)

- [ ] **Step 4: `PoolLive` + `snapshot_into`**

`state/pool_live.rs`:
```rust
use anchor_lang::prelude::*;
use crate::{errors::DexxerError, math::{ceil_step, floor_step}, state::{Pool, SNAPSHOT_STEP}};

/// Live pool counters. Delegated, permissioned `[crank, admin]`, NEVER committed (spec §2.5.1, risk #24).
/// Every trading/money instruction writes here; the public `Pool` is a rounded snapshot written only by `commit_aggregate`.
#[account]
#[derive(InitSpace)]
pub struct PoolLive {
    pub version: u8,
    pub mint: Pubkey,
    pub capital_total: u64,
    pub protocol_liquidity: u64,
    pub locked_total: u64,
    pub fees_accrued: u64,
    pub insurance: u64,
    pub bad_debt_total: u64,
    pub bump: u8,
}

impl PoolLive {
    /// Copy into the public snapshot with step rounding: assets down, liabilities up.
    pub fn snapshot_into(&self, pool: &mut Pool, slot: u64) -> Result<()> {
        require!(pool.mint == self.mint, DexxerError::PoolLiveMismatch);
        pool.capital_total = floor_step(self.capital_total, SNAPSHOT_STEP);
        pool.protocol_liquidity = floor_step(self.protocol_liquidity, SNAPSHOT_STEP);
        pool.insurance = floor_step(self.insurance, SNAPSHOT_STEP);
        pool.fees_accrued = floor_step(self.fees_accrued, SNAPSHOT_STEP);
        pool.locked_total = ceil_step(self.locked_total, SNAPSHOT_STEP).map_err(|_| DexxerError::MathOverflow)?;
        pool.bad_debt_total = ceil_step(self.bad_debt_total, SNAPSHOT_STEP).map_err(|_| DexxerError::MathOverflow)?;
        pool.last_commit_slot = slot;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_rounds_assets_down_liabilities_up() {
        let mint = Pubkey::new_unique();
        let live = PoolLive { version: 1, mint, capital_total: 1_250_000_001, protocol_liquidity: 999_999_999,
            locked_total: 48_200_000_001, fees_accrued: 199_999_999, insurance: 100_000_000, bad_debt_total: 1, bump: 0 };
        let mut pool = Pool { version: 1, mint, vault_ata: Pubkey::default(), capital_total: 0, protocol_liquidity: 0,
            locked_total: 0, fees_accrued: 0, insurance: 0, bad_debt_total: 0, last_commit_slot: 0, bump: 0 };
        live.snapshot_into(&mut pool, 42).unwrap();
        assert_eq!(pool.capital_total, 1_200_000_000);
        assert_eq!(pool.protocol_liquidity, 900_000_000);
        assert_eq!(pool.locked_total, 48_300_000_000);
        assert_eq!(pool.fees_accrued, 100_000_000);
        assert_eq!(pool.insurance, 100_000_000);
        assert_eq!(pool.bad_debt_total, 100_000_000);
        assert_eq!(pool.last_commit_slot, 42);
    }
    #[test]
    fn snapshot_rejects_mint_mismatch() {
        let live = PoolLive { version: 1, mint: Pubkey::new_unique(), capital_total: 0, protocol_liquidity: 0, locked_total: 0,
            fees_accrued: 0, insurance: 0, bad_debt_total: 0, bump: 0 };
        let mut pool = Pool { version: 1, mint: Pubkey::new_unique(), vault_ata: Pubkey::default(), capital_total: 0,
            protocol_liquidity: 0, locked_total: 0, fees_accrued: 0, insurance: 0, bad_debt_total: 0, last_commit_slot: 0, bump: 0 };
        assert!(live.snapshot_into(&mut pool, 1).is_err());
    }
}
```
Run: `cargo test -p dexxer_core` → 51 → 54 passed.

- [ ] **Step 5: Інструкції `init_pool_live` / `delegate_pool_live`**

`instructions/pool_live.rs` (копія патерну `DelegateFeeEscrow` з `admin.rs:167-188`):
```rust
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use crate::{errors::DexxerError, state::*};

#[derive(Accounts)]
pub struct InitPoolLive<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// Public pool — read once to seed the live counters (devnet migration: values accumulated in weeks 1–3).
    #[account(seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(init, payer = admin, space = 8 + PoolLive::INIT_SPACE,
        seeds = [POOL_LIVE_SEED, pool.mint.as_ref()], bump)]
    pub pool_live: Account<'info, PoolLive>,
    pub system_program: Program<'info, System>,
}

pub fn init_pool_live(ctx: Context<InitPoolLive>) -> Result<()> {
    let p = &ctx.accounts.pool;
    let l = &mut ctx.accounts.pool_live;
    l.version = 1;
    l.mint = p.mint;
    l.capital_total = p.capital_total;
    l.protocol_liquidity = p.protocol_liquidity;
    l.locked_total = p.locked_total;
    l.fees_accrued = p.fees_accrued;
    l.insurance = p.insurance;
    l.bad_debt_total = p.bad_debt_total;
    l.bump = ctx.bumps.pool_live;
    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePoolLive<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub dusdc_mint: Account<'info, anchor_spl::token::Mint>,
    /// CHECK: delegated PDA
    #[account(mut, del, seeds = [POOL_LIVE_SEED, dusdc_mint.key().as_ref()], bump)]
    pub pool_live: UncheckedAccount<'info>,
}

pub fn delegate_pool_live(ctx: Context<DelegatePoolLive>) -> Result<()> {
    let mint = ctx.accounts.dusdc_mint.key();
    ctx.accounts.delegate_pool_live(
        &ctx.accounts.admin,
        &[POOL_LIVE_SEED, mint.as_ref()],
        DelegateConfig { validator: Some(ctx.accounts.config.tee_validator), ..Default::default() },
    )?;
    Ok(())
}
```
`lib.rs`: `pub fn init_pool_live(ctx: Context<InitPoolLive>) -> Result<()> { pool_live::init_pool_live(ctx) }` і `pub fn delegate_pool_live(...)`. (Спосіб імпорту `Mint` — як у `DelegatePool` в `admin.rs`; повторити його точно.)

- [ ] **Step 6: LiteSVM — pdas/ixs/bootstrap + тест (RED→GREEN)**

`pdas.rs`: `pub fn pool_live(mint: &Pubkey) -> Pubkey { Pubkey::find_program_address(&[POOL_LIVE_SEED, mint.as_ref()], &dexxer_core::ID).0 }`. `ixs.rs`: `pub fn init_pool_live(admin: &Pubkey, mint: &Pubkey) -> Instruction` з акаунтами `[admin(s,w), config, pool(mint), pool_live(w), system_program]` і дискримінатором `init_pool_live` (за зразком `init_fee_escrow` в `ixs.rs:100`). `setup.rs`: поле `pool_live: Pubkey`, у `bootstrap` після `seed_pool` (крок 11) — `ixs::init_pool_live(admin, mint)`.

`tests/litesvm/tests/pool_live.rs`:
```rust
#[test]
fn init_pool_live_copies_seeded_pool() {
    let (mut h, w) = World::bootstrap();
    let pool: Pool = h.account(&w.pool);
    let live: PoolLive = h.account(&w.pool_live);
    assert_eq!(live.mint, pool.mint);
    assert_eq!(live.capital_total, pool.capital_total);
    assert_eq!(live.protocol_liquidity, pool.protocol_liquidity);
    assert_eq!(live.capital_total, setup::SEED_AMOUNT);
}
#[test]
fn init_pool_live_admin_only() {
    let (mut h, w) = World::bootstrap_without_pool_live(); // add this variant: bootstrap minus step 12
    let stranger = h.funded_keypair(1_000_000_000);
    let r = h.send(&[ixs::init_pool_live(&stranger.pubkey(), &w.mint)], &[&stranger]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
}
```
(Імена хелперів `h.account`, `h.send`, `h.funded_keypair`, `assert_custom_error` — узяти точні з `tests/litesvm/src/lib.rs`; якщо `bootstrap_without_pool_live` незручний, додати параметр `bootstrap_with(opts)` — вирішує імплементер, але тест admin-only має бути.)

Run: `cargo +nightly-2026-09-18 test -p dexxer_litesvm` → 65 → 67.

- [ ] **Step 7: Гаунтлет і коміт**

`anchor build` (жодного нового stack-рядка з `dexxer_core`), `program_autofixer` на `pool_live.rs` ×2, `math.rs`, `errors.rs`, `mod.rs`; `cargo fmt --all -- --check`; `cargo clippy -p dexxer_core -- -D warnings`; IDL → `app/src/idl/`; `npx tsc --noEmit` у `tests/er`, `scripts`, `app`.
```bash
git add programs/dexxer_core/src tests/litesvm app/src/idl/dexxer_core.json
git commit -m "feat(core): PoolLive private aggregate — state, step rounding, init/delegate (risk #24, step 1)"
```

---

### Task 1: Усі записи → `PoolLive`; `commit_aggregate` пише огрублений знімок у `Pool`

**Files:**
- Modify: `programs/dexxer_core/src/instructions/trade.rs` (`Trade.pool` → `pool_live: Account<'info, PoolLive>`; `finalize_close(…, pool: &mut PoolLive …)`), `risk.rs` (`settle_into_pool(pool: &mut PoolLive, …)`), `instructions/user.rs` (`CreditDeposit`, `Withdraw`: `pool` → `pool_live`), `instructions/admin.rs` (`SeedPool`: додає `pool_live` і пише в обидва — `Pool` лишається джерелом для міграції на devnet, `PoolLive` — живий), `instructions/crank.rs` (`CrankTick.pool` → `pool_live`), `instructions/commit.rs` (`CommitAggregate` +`pool_live: Account<'info, PoolLive>`; тіло: `pool_live.snapshot_into(&mut pool, clock.slot)?` замість `pool.last_commit_slot = clock.slot`), `tests/litesvm/src/{ixs,lib}.rs`, `tests/litesvm/tests/pool_live.rs`
- Test: усі наявні LiteSVM-тести мають лишитись зеленими після заміни акаунтів у `ixs.rs`.

**Interfaces:**
- Consumes: `PoolLive`, `snapshot_into`, `pdas::pool_live`, `World.pool_live`.
- Produces: `assert_invariant` читає `PoolLive` (не `Pool`); `ixs::commit_aggregate` передає `pool_live` після `pool`; порядок акаунтів `CommitAggregate`: `[config, payer, pool, pool_live, balances_root, fee_escrow, magic_fee_vault, magic_context, magic_program]`.

- [ ] **Step 1: Тести знімка (RED)** — у `tests/litesvm/tests/pool_live.rs`:
```rust
#[test]
fn trades_write_pool_live_and_leave_pool_snapshot_untouched() {
    let (mut h, w) = World::bootstrap();
    let t = Trader::onboard(&mut h, &w, 1_000_000_000);
    let pool_before: Pool = h.account(&w.pool);
    open_long(&mut h, &w, &t, 1_000_000_000, 20_000_000);
    let live: PoolLive = h.account(&w.pool_live);
    let pool_after: Pool = h.account(&w.pool);
    assert_eq!(live.locked_total, 20_000_000, "live counters move on open");
    assert_eq!(pool_after.locked_total, pool_before.locked_total, "public Pool must not change between commits");
    assert_eq!(pool_after.last_commit_slot, pool_before.last_commit_slot);
    assert_invariant(&h, &w, &[&t]);
}
#[test]
fn commit_aggregate_snapshots_rounded_values() {
    let (mut h, w) = World::bootstrap();
    let t = Trader::onboard(&mut h, &w, 1_000_000_000);
    open_long(&mut h, &w, &t, 1_000_000_000, 20_000_000); // locked 20 dUSDC → ceil to 100
    h.send(&[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &[])], &[&w.fee_payer]).unwrap();
    let live: PoolLive = h.account(&w.pool_live);
    let pool: Pool = h.account(&w.pool);
    assert_eq!(pool.locked_total, 100_000_000);
    assert_eq!(pool.capital_total, floor_step(live.capital_total, SNAPSHOT_STEP));
    assert_eq!(pool.protocol_liquidity, floor_step(live.protocol_liquidity, SNAPSHOT_STEP));
    assert!(pool.last_commit_slot > 0);
}
```
(`Trader::onboard`, `open_long` — реальні хелпери з `tests/litesvm/src/setup.rs`/`trade.rs`-тестів; узяти точні імена.) Run → FAIL (ixs/акаунти ще старі).

- [ ] **Step 2: Перенести записи** — у кожному контексті замінити `pool: …<Pool>` на
```rust
#[account(mut, seeds = [POOL_LIVE_SEED, pool_live.mint.as_ref()], bump = pool_live.bump)]
pub pool_live: Account<'info, PoolLive>,
```
(`Box` там, де був `Box`; у `Trade` розмір такий самий, лишити як було) і всі `pool.<field>` → `pool_live.<field>`; `risk::settle_into_pool(pool: &mut PoolLive, …)`; `finalize_close(…, pool_live: &mut PoolLive, …)`. `SeedPool`: додати `pool_live` (mut) і писати `capital_total`/`protocol_liquidity` в обидва (коментар: `Pool` тут — лише для `init_pool_live`-міграції devnet; після Task 3 `seed_pool` на живому пулі не викликається).

- [ ] **Step 3: `commit_aggregate`** — у `CommitAggregate` після `pool`:
```rust
#[account(seeds = [POOL_LIVE_SEED, pool_live.mint.as_ref()], bump = pool_live.bump,
    constraint = pool_live.mint == pool.mint @ DexxerError::PoolLiveMismatch)]
pub pool_live: Account<'info, PoolLive>,
```
(read-only — знімок читає його; писати не треба). Тіло: замінити `ctx.accounts.pool.last_commit_slot = clock.slot;` на `ctx.accounts.pool_live.snapshot_into(&mut ctx.accounts.pool, clock.slot)?;`. `.commit(&[pool, balances_root])` — без змін (**`pool_live` в commit не потрапляє**).

- [ ] **Step 4: LiteSVM плюмбінг** — `ixs.rs`: усі білдери (`open_position`, `add_margin`, `increase_position`, `decrease_position`, `close_position`, `credit_deposit`, `withdraw`, `crank_tick`, `seed_pool`, `commit_aggregate`) — акаунт `pool_live` за порядком контексту; `lib.rs::assert_invariant_ctx` читає `PoolLive` з `w.pool_live` замість `Pool` (усі пʼять полів). Run повний LiteSVM → 67 → 69, усі старі зелені.

- [ ] **Step 5: Гаунтлет, IDL, коміт** — як у Task 0 (autofixer на `trade.rs`, `user.rs`, `admin.rs`, `crank.rs`, `commit.rs`, `risk.rs`); TS: `tests/er/lib/program.ts` `pdas.poolLive(mint)`; `scripts/crank-fallback/disclosure.ts` `commit_aggregate` accounts +`poolLive`; `tests/er/devnet/03-commit-cycle.ts` +`poolLive`; `app/src/lib/pdas.ts` +`poolLive`; `app` `openPosition/closePosition` accounts +`poolLive` (перевірити `TradeAccounts`); tsc ×3.
```bash
git commit -m "feat(core): trading/money instructions write PoolLive; commit_aggregate publishes a step-rounded Pool snapshot"
```

---

### Task 2: `init_market_permissions` — `MarketRisk` permissioned `[crank, admin]`

**Files:**
- Modify: `programs/dexxer_core/src/state/permissions.rs` (+`build_admin_members`), `programs/dexxer_core/src/instructions/user.rs` (+`InitMarketPermissions`, `init_market_permissions` — поруч із `InitPermissions`, той самий Create/Update-патерн), `lib.rs`, `tests/litesvm/src/{ixs,pdas}.rs`, `tests/litesvm/tests/pool_live.rs` (+2 тести)

**Interfaces:**
- Produces: `init_market_permissions(ctx)` — accounts `[admin(s), config, market, market_risk(mut), pool_live(mut), risk_permission(mut), pool_live_permission(mut), permission_program, ephemeral_vault, magic_program]`; ставить permission `[crank(OWNER_FLAGS), admin(VIEWER_FLAGS)]` на **обидва** `MarketRisk` і `PoolLive` (одна ER-інструкція для обох приватних агрегатів). `build_admin_members(crank, admin) -> Vec<Member>`.

- [ ] **Step 1 (RED):**
```rust
#[test]
fn init_market_permissions_admin_only() { /* stranger → Unauthorized */ }
#[test]
fn init_market_permissions_skips_cpi_when_permission_program_absent() {
    // LiteSVM has no permission program: instruction must succeed as a no-op when
    // `permission_program.executable == false` (same guard style as commit.rs `magic_program.executable`),
    // so the admin bootstrap is idempotent locally and on devnet.
}
```
- [ ] **Step 2:** `build_admin_members`:
```rust
pub fn build_admin_members(crank: Pubkey, admin: Pubkey) -> Vec<Member> {
    vec![Member { flags: OWNER_FLAGS, pubkey: compat_pubkey(crank) }, Member { flags: VIEWER_FLAGS, pubkey: compat_pubkey(admin) }]
}
```
Контекст і тіло — копія `InitPermissions`/`init_permissions` (`user.rs:546-657`) з двома трійками `(market_risk, risk_permission, [RISK_SEED, market.key(), bump])`, `(pool_live, pool_live_permission, [POOL_LIVE_SEED, mint, bump])`, `has_one = admin` на `config`, і guard `if !ctx.accounts.permission_program.executable { return Ok(()); }` перед циклом (з коментарем чому).
- [ ] **Step 3:** LiteSVM 69 → 71; гаунтлет; IDL; коміт `feat(core): init_market_permissions — MarketRisk and PoolLive become permissioned [crank, admin]`.

---

### Task 3: Devnet-міграція, редеплой, вимір M-F (знімок), результати

**Files:**
- Create: `tests/er/devnet/09-pool-snapshot.ts`, `docs/superpowers/plans/week4-results.md`
- Modify: `tests/er/lib/admin.ts` (`bootstrapDevnet` +кроки 8–10: `init_pool_live` якщо PDA нема → `delegate_pool_live` якщо owner ≠ `DELeGG…` → `init_market_permissions` (ER, crank-конекшн не потрібен — підписує admin через owner-TEE-токен admin-а)), `tests/er/package.json` (`devnet:snapshot`), `scripts/admin/devnet-bootstrap.ts`

**Кроки:**
- [ ] `anchor build`; `solana program show G2okX5… -u devnet` (data len 1,048,272 vs новий `.so`); за потреби `solana program extend`; `anchor deploy --provider.cluster devnet --provider.wallet spikes/keys/payer.json --program-name dexxer_core` (fallback write-buffer/upgrade як у week3-results §Task 8); `solana program show --buffers` порожній; баланси до/після.
- [ ] `npm run devnet:bootstrap` (ідемпотентно): лог `init_pool_live sig`, `delegate_pool_live sig`, `init_market_permissions sig`; перевірити `PoolLive` owner на base == `DELeGG…`.
- [ ] **09-pool-snapshot (M-F):** свіжий трейдер → open → (a) читати `Pool` на L1 і в ER з crank-конекшну **між комітами**: значення не змінились від open; (b) `PoolLive` з crank-конекшну змінився (`locked_total` +margin); (c) `PoolLive` зі stranger-конекшну (свіжий ключ, TEE-токен) → помилка доступу/порожньо — **PASS `M-F private live aggregate`**; (d) `commit_aggregate` → L1 `Pool.locked_total % 100_000_000 == 0` і ≥ live, `capital_total ≤ live` — **PASS `M-F rounded snapshot`**; (e) `MarketRisk` зі stranger-конекшну — порожньо. Записати сигнатури (ER/base).
- [ ] Прогнати 06/07/08 повторно (регресія після редеплою) — усі PASS.
- [ ] `week4-results.md`: шапка як week3, §Task 3: редеплой-таблиця, M-F таблиця, баланси. Коміт `test(devnet): PoolLive migration, rounded Pool snapshot (M-F), regression 06/07/08`.

---

### Task 4: `services/relayer` — переїзд crank-а, ключі з env, `/healthz`, Dockerfile, Railway

**Files:**
- Create: `services/relayer/{package.json,tsconfig.json,Dockerfile,railway.json,README.md}`, `services/relayer/src/{index.ts,crank.ts,health.ts,keys.ts}`; `git mv scripts/crank-fallback/disclosure.ts services/relayer/src/disclosure.ts`
- Modify: `scripts/package.json` (`"crank": "npm --prefix ../services/relayer run start"`), `tests/er/lib/env.ts` (+`loadKeyFromEnvOrFile(name, envVar)`), `.github/workflows/ci.yml` (typescript job +`services/relayer`: `npm ci && npx tsc --noEmit && npm test`)

**Interfaces:**
- Produces: `RelayerConfig { net, baseRpc, erRpc, erWs, crank: Keypair, feePayer: Keypair, port, indexerEnabled, sponsorEnabled, dbPath }` з env: `DEXXER_NET=devnet`, `CRANK_KEY_B58`, `FEE_PAYER_KEY_B58` (bs58 secret), `PORT=8080`, `RELAYER_DB=/data/relayer.sqlite`; `GET /healthz → { ok, lastTickAt, lastCommitAt, tick, crankSol, feePayerSol, schedulerActive }` (503 якщо `now - lastTickAt > 60_000`).

- [ ] **Step 1:** `keys.ts`:
```ts
export function keypairFromEnv(name: string, fileFallback: string): Keypair {
  const b58 = process.env[name];
  if (b58) return Keypair.fromSecretKey(bs58.decode(b58));
  return loadOrCreateKey(fileFallback); // local dev: tests/er/.keys/<file>.json
}
```
- [ ] **Step 2:** `crank.ts` = тіло `tick()`/`main()` з `scripts/crank-fallback/index.ts` без `process.exit`; експортує `startCrank(cfg, state): Promise<void>` і мутує `state: RelayerState { lastTickAt, lastCommitAt, tick, errors }`. `disclosure.ts` — без змін крім імпортів.
- [ ] **Step 3:** `health.ts` — `node:http` сервер: `/healthz` як вище (баланси через `getBalance` кешовано раз на 60 с). `index.ts` — читає конфіг, стартує health, crank, (Task 5) індексер, (Task 6) sponsor; graceful `SIGTERM`.
- [ ] **Step 4:** `Dockerfile` (`node:24-alpine`, `npm ci --omit=dev`, `CMD ["node","--import","tsx","src/index.ts"]` або збірка `tsc` у `dist/`), `railway.json` (`healthcheckPath: "/healthz"`, `restartPolicyType: "ON_FAILURE"`), volume `/data`.
- [ ] **Step 5:** Тест: `npm test` (node:test) на `keypairFromEnv` (b58 round-trip) і health-JSON (503 при старому тіку). Локально: `DEXXER_NET=devnet npm start` → `/healthz` 200 → зупинити.
- [ ] **Step 6:** Railway: `railway init`/через MCP `create_project` + `create_service` з source репо (root `services/relayer`), variables (`CRANK_KEY_B58`, `FEE_PAYER_KEY_B58` — з `tests/er/.keys/*.json` через `bs58.encode`, **ніколи не в репо**), volume `/data`, deploy; `generate_domain`; `curl https://<domain>/healthz` → 200; лог показує `tick n=…`. Записати домен у `docs/deployments.md`.
- [ ] Коміт `feat(relayer): crank service on Railway — env keys, /healthz, Dockerfile`.

---

### Task 5: Індексер публічних даних (ціни, знімки, розкриття) — SQLite + REST/WS

**Files:**
- Create: `services/relayer/src/indexer/{prices.ts,accounts.ts,store.ts,http.ts,candles.ts}`, `services/relayer/test/candles.test.ts`
- Modify: `services/relayer/src/index.ts`

**Interfaces:**
- Produces: REST `GET /prices?tf=1m|5m|15m&limit=300 → { tf, candles: [{t, o, h, l, c}] }` (t — unix ms, ціни в `1e6`), `GET /mark → { price, slot, ts }`, `GET /pool/history?limit=100 → [{slot, ts, capital_total, protocol_liquidity, locked_total, fees_accrued, insurance, bad_debt_total}]`, `GET /pool/latest`, `GET /disclosures?limit=100 → [{pubkey, side, size, entry, exit, pnl, fees, reason, opened_slot, closed_slot, nonce, ts}]`, `GET /root/latest → { root_slot, filled, leavesHex[] }`; WS `wss://…/ws` з повідомленнями `{type:"mark",price,ts}`, `{type:"pool",…}`, `{type:"disclosure",…}`. Джерела: оракул-акаунт `ORACLE`-feed (публічний, читається з ER-RPC без токена або з base — перевірити де читабельний; fallback — `Market.mark` з ER-RPC crank-токеном **не використовувати**: це приватний шлях; брати оракул), L1 `accountSubscribe(pdas.pool)`, `accountSubscribe(pdas.balancesRoot)`, gPA `Disclosure` (memcmp disc) раз на 30 с + `programSubscribe`.
- `candles.ts`: `pushTick(series, ts, price)` → агрегація у бакети `tf`; чистий модуль, unit-тести: один тік → o=h=l=c; два тіки в бакеті; межа бакета; порожні бакети не створюються.

- [ ] Steps: RED тести `candles.test.ts` → реалізація → `store.ts` (better-sqlite3; таблиці `ticks`, `pool_snapshots`, `disclosures`, `roots`) → `accounts.ts` підписки → `http.ts` (той самий `node:http` + `ws` пакет) → smoke `curl /prices?tf=1m` після 2 хв роботи повертає ≥1 свічку → деплой на Railway → коміт `feat(relayer): public-data indexer — oracle candles, Pool/BalancesRoot snapshots, Disclosure feed (REST/WS)`.

---

### Task 6: `/sponsor` + онбординг однією пачкою `signTransactions` зі спонсорованим rent

**Files:**
- Create: `services/relayer/src/sponsor.ts`, `services/relayer/test/sponsor.test.ts`, `app/src/lib/sponsor.ts`
- Modify: `app/src/features/onboard/useOnboarding.ts`, `app/src/lib/solana.ts` (+`RELAYER_URL`)

**Interfaces:**
- `POST /sponsor` body `{ tx: base64 }` → `{ tx: base64 }` (та сама tx з підписом `fee_payer`) або `400 { error }`. Правила: `tx.feePayer == feePayer.publicKey`; кожна інструкція — `programId ∈ {dexxer_core, eSPL, system(тільки createAccount від feePayer заборонено), token/ATA}` і дискримінатор ∈ whitelist `{init_user, init_position, init_dq, delegate_user, delegate_position, delegate_dq, faucet_init}` + eSPL `delegateSpl`; `owner`-акаунт у кожній ix — підписант tx (перевірка `tx.signatures` містить owner і його підпис валідний після власного підпису); rate-limit: 1 успішний спонсор на owner за 60 хв (SQLite таблиця `sponsors`), денний бюджет `SPONSOR_DAILY_SOL=0.5`.
- App: `useOnboarding` збирає `[txL1a, txL1b, txEr]`; `txL1a/b.feePayer = FEE_PAYER_PUBKEY` (з `Config.fee_payer`), blockhash з base; ER tx — `feePayer = owner`, blockhash з TEE. `signTransactions([txL1a, txL1b, txEr])` (масив — **один** екран гаманця; `@wallet-ui/react-native-web3js` `signTransactions` приймає масив — перевірити тип, якщо лише одну — використати низькорівневий `transact` з `@solana-mobile/mobile-wallet-adapter-protocol-web3js` `signTransactions(txs)`), далі `POST /sponsor` для L1-tx, `sendRawTransaction` послідовно з `confirm`, потім ER tx. Ідемпотентність: перед збором — `getAccountInfo` `user/position/dq`, owner delegation status, permission-PDA owner → пропускати готові кроки. Депозит (`faucet_mint`+`credit_deposit`) — окремий екран Deposit (Task 10), не в пачці.

- [ ] Steps: RED `sponsor.test.ts` (відкидає чужий programId; відкидає tx без підпису owner; приймає whitelist; rate-limit) → реалізація → app: `sponsor.ts` (`sponsorTx(tx): Promise<Transaction>`), `useOnboarding` новий flow `runBatchedOnboarding()` зі станами `Collecting → Signing → Submitting(i/3) → Done | Failed(step)` → перевірка на емуляторі: fakewallet + **Phantom APK** (встановити `adb install`), обидва підписують пачку одним екраном; свіжий гаманець без SOL проходить онбординг → скріншоти `week4-onboarding-*.png` → коміт `feat(app,relayer): one-tap onboarding — batched signTransactions with sponsored rent via /sponsor`.

---

### Task 7: Scheduler `i64::MAX` на devnet (резерв ліквідацій) — вимір і запис

**Files:** Create `scripts/admin/schedule-eternal.ts`; Modify `docs/superpowers/plans/week4-results.md` (§Task 7), spec §7.1 #18.

- [ ] `schedule-eternal.ts`: `set_scheduler_signer(crank_signer_pda(admin))` якщо ≠; `cancel_crank(old task_id)` якщо запис є в `docs/deployments.md`; `schedule_crank(task_id=<new>, interval_ms=1000, iterations=i64::MAX)`; записати `task_id` у `docs/deployments.md`.
- [ ] Вимір: зупинити Railway-relayer на 3 хв → відкрити позицію з liq-ціною близько до mark на devnet (окремий тестовий трейдер) → переконатися, що `crank_tick` від scheduler ліквідує (лог `Market`/`Position` зміна без relayer) — **PASS `scheduler liquidates without relayer`**; підняти relayer; `/healthz.schedulerActive = true` (relayer читає останній slot зміни `Market.mark` як heartbeat).
- [ ] Записати в week4-results і spec #18 «застосовано на devnet, task_id …». Коміт `feat(ops): eternal scheduler for crank_tick on devnet (#18 closed)`.

---

### Task 8: Тема з `tokens.json` + UI-примітиви + 5 табів

**Files:**
- Create: `app/src/theme/tokens.ts` (згенеровано з `docs/design/tokens.json` — скрипт `app/scripts/gen-tokens.ts` читає JSON → TS-константи `colors`, `type`, `space`, `radius`, `layout`, `control`), `app/src/theme/index.ts` (`useTheme()` → tokens; `ThemeProvider` dark-only), `app/src/ui/{Button,Input,Segment,LeverageSlider,Card,Row,Badge,Sheet,Toast,Skeleton,EmptyState,Address}.tsx`
- Modify: `app/app/(tabs)/_layout.tsx` (таби `trade`, `positions`, `history`, `ledger`, `account`; `onboard`, `position`, `demo`, `spikes`, `settings` — `href: null`, доступ з Account → Settings → Developer), `app/app.json` (шрифти IBM Plex Sans/Mono через `expo-font`; якщо завантаження шрифтів ускладнює білд — system + mono fallback, записати).

**Interfaces:**
- `Button { variant: 'primary'|'secondary'|'destructive'|'ghost'; loading?; disabled?; onPress; children }`, `Input { label; value; onChangeText; suffix?; hint?; onMax? }`, `Segment<T> { options: {value:T; label:string}[]; value; onChange; tone?: 'long-short' }`, `LeverageSlider { value: number; onChange; min=1; max=10 }`, `Card { title?; children }`, `Row { label; value; tone?; mono? }`, `Badge { tone: 'neutral'|'pending'|'success'|'warning'|'danger'; children }`, `Sheet { open; onClose; title; children }`, `Toast` (глобальний `showToast({tone, text})`), `Skeleton { lines }`, `EmptyState { text; action? }`, `Address { pubkey; explorer?: boolean }`.
- Правило: жодного hex у компонентах — лише `tokens`.

- [ ] Steps: gen-tokens → примітиви (кожен з мінімальним `__DEV__`-storybook-екраном `app/app/(tabs)/settings/ui-gallery.tsx` для візуальної перевірки) → tab layout → `npx tsc --noEmit` + `npm run lint:check` → скріншот галереї `week4-ui-gallery.png` → коміт `feat(app): design tokens, UI primitives, 5-tab layout (Claude Design)`.

---

### Task 9: Дані клієнта — `accountSubscribe` у `useLiveAccount`, індексер-клієнт, History одразу

**Files:**
- Modify: `app/src/lib/live.ts` (WS через `conn.onAccountChange` — `Connection` уже створено з `wsEndpoint: TEE_WS?token=…` у `teeConnectionForSession`; перевірити, що `er.ts`/`session.ts` передають `wsEndpoint`; fallback — polling 2 с при `ws error`), `app/src/features/history/HistoryScreen.tsx` (третє джерело: `useLiveAccount(conn, position, decodePosition)` → якщо `state === 'Closed'` — рядок зі статусом `committing` (`commitment_written === false`) або `committed` (`true`, ще не `mark_committed`)), `app/src/features/trade/TradeScreen.tsx` (замінити polling `readPosition/readMarket` на `useLiveAccount`)
- Create: `app/src/lib/indexer.ts` — `useMark()`, `useCandles(tf)`, `usePoolHistory()`, `useDisclosures()`, `useRootLatest()` (REST + WS з `RELAYER_URL`, react-query), `app/src/lib/status.ts` — `disclosureStatus(record, slot, hasCommitmentOnL1?) → 'committing'|'committed'|'reveals_in'|'revealed'` + `formatSlotsAsTime(n)`.

- [ ] Steps: спайк 30 хв: `accountSubscribe` на TEE з токеном працює? (лог у `week4-results`); `live.ts` → `HistoryScreen` статуси → `indexer.ts` → tsc/lint → емулятор: Close → рядок History зʼявляється одразу → коміт `feat(app): live subscriptions, indexer client, History shows closed position immediately`.

---

### Task 10: Екрани за макетом — Onboarding, Trade, Positions, History, Ledger, Account

**Files:**
- Create: `app/src/features/onboard/OnboardScreen.tsx` (Connect → Set up private account (3 кроки, стани waiting/signing/confirming/done/failed, «No SOL needed — we sponsor account rent») → Done), `app/src/features/trade/{PriceChart.tsx,TradeTicket.tsx}`, `app/src/features/positions/PositionsScreen.tsx` (картка: Unrealized PnL, Size, Entry, Mark, Margin, Liq. price, «N% away from liquidation»; Close / Increase / Decrease через `Sheet` на `increase_position`/`decrease_position`; стан «Recording commitment on-chain (≤5 min)»), `app/src/features/ledger/LedgerScreen.tsx` (сегмент Disclosures | Pool | Root; «Trader: hidden by design»; «Updated at slot … · every 5 min»; «Values rounded to 100 dUSDC»), `app/src/features/account/AccountScreen.tsx` (адреса, «23h left», Available/Locked, Deposit/Withdraw sheets (`faucet_mint`+`credit_deposit`; `withdraw` з правилом «Min 1 dUSDC · one withdrawal per ~2 min»), Receipt (з `ReceiptSection`), Exit з чек-листом → `undelegate_user`, Settings → Developer)
- Modify: `app/src/features/trade/TradeScreen.tsx` (header SOL-PERP + mark + 24h + «Pyth Lazer» бейдж свіжості; `PriceChart` 1m/5m/15m з `useCandles`; `TradeTicket`: Long/Short, Size (SOL), Margin (dUSDC, Available/MAX), Leverage 1–10× — `margin = notional/leverage`, превʼю Entry ≈ / Liq. price (`math` порт з `program.ts`) / Fee / Slippage limit `mark × 1.01`; кнопка `Open Long`/`Open Short`; «No wallet prompt — signed by your session key»; заблокований тікет «One position per market» при `Open`; банери `Oracle price is stale — trading paused`, `Session expired → Re-authorize`), `app/app/(tabs)/{trade,positions,history,ledger,account}.tsx`

- [ ] Steps: по одному екрану — реалізація → tsc/lint → емулятор → скріншот `week4-<screen>.png`; UI-копірайт із макета (`docs/design/Dexxer App.dc.html`, витяг у плані тижня — секція «Екрани» промту). Коміти по екрану: `feat(app): Trade screen — chart + ticket per design`, `feat(app): Positions screen`, `feat(app): Ledger screen`, `feat(app): Account screen — deposit/withdraw/receipt/exit`, `feat(app): Onboard screen`.

---

### Task 11: Прогін, відео, README, пітч, документи, PR

**Files:** Create `README.md` (заміна), `docs/deployments.md`, `docs/pitch.md`; Modify `docs/superpowers/plans/week4-results.md`, spec §7.3/§4.2/§7.1, `CLAUDE.md`, `.github/workflows/ci.yml` (relayer job — якщо не в Task 4).

- [ ] Повний прогін на емуляторі з **Phantom APK**: Connect → Set up (один екран) → Deposit → Long → Positions → Close → History (одразу) → через цикл: Revealed, Ledger показує розкриття без власника, Pool-знімок огруглений, Receipt ✓ → Exit. Скріншоти всіх табів. Другий прогін з fakewallet.
- [ ] Відео 2–3 хв: `adb shell screenrecord --time-limit 180 /sdcard/dexxer.mp4` → `adb pull` → `docs/superpowers/plans/assets/dexxer-mvp.mp4` (або посилання, якщо >50 MB — не комітити бінарник, покласти в Release).
- [ ] README: що/чому/як (діаграма з `docs/dexxer-architecture.md`), швидкий старт (relayer URL, devnet-адреси), «Чесні обмеження» (#23–#26, anonymity set, TEE), roadmap (§2.4.5). `docs/pitch.md` — форма Colosseum. `docs/deployments.md` — program id, PDAs, relayer домен, scheduler task_id, ключові акаунти.
- [ ] Docs: `week4-results.md` повний (Tasks 0–10, M-F, вартість, скріншоти); spec §7.3 факт тижня 4, §4.2 сигнатури `init_pool_live`/`delegate_pool_live`/`init_market_permissions`, §7.1 #24 «закрито (знімок), лишається anonymity-set», #18 закрито, #22 закрито; `CLAUDE.md` — правила тижня 4 (PoolLive/знімок, relayer, sponsor, UI-токени, LiteSVM N).
- [ ] Гаунтлет: fmt, clippy, `anchor build`, unit, LiteSVM, tsc ×4, lint, relayer tests; тег `v0.4-mvp` після мержу. PR у `main` (тіло як тижні 2–3 + посилання на відео). Коміт `docs(week4): results, README, pitch, deployments, spec/CLAUDE.md rules`.

---

## Не в цьому плані (пост-MVP)
ZK-знімок забезпеченості (§2.4.5), власний vault, merkle при N>64, перенесення disclosure/root у scheduler, funding/TP/SL, мульти-маркет, TEE-атестація в застосунку, локальні push, iOS.

## Self-review (виконано при написанні)
- **Spec §2.5 coverage:** 2.5.1 → Tasks 0–3; 2.5.2 → Tasks 4–5, 7; 2.5.3 → Tasks 6, 9; 2.5.4 → Tasks 8–10; 2.5.5 → Task 11. #22 → Task 6/10; #24 → 0–3; #18 → 7.
- **Type consistency:** `PoolLive` поля/`snapshot_into` (T0) ↔ T1 `commit_aggregate`; `pdas::pool_live(mint)`/`World.pool_live` (T0) ↔ T1/T2 тести; `CommitAggregate` порядок акаунтів (T1) ↔ T1 TS-білдери ↔ T3 скрипти; `RelayerConfig`/`/healthz` (T4) ↔ T7 `schedulerActive`; індексер REST (T5) ↔ `indexer.ts` (T9) ↔ екрани (T10); `/sponsor` контракт (T6) ↔ `sponsor.ts`; примітиви (T8) ↔ екрани (T10).
- **Placeholders:** «узяти точні імена хелперів з `tests/litesvm/src/lib.rs`» і «порт `math` у `program.ts`» — свідомі вказівки на існуючий код у репо з точним шляхом, не TBD. Спайк у T9 (WS з токеном) має записаний fallback.
