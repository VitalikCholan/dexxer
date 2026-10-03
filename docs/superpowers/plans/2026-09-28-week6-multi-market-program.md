# Мульти-маркет, план 1 з 3: програма `dexxer_core` + LiteSVM

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** програма дозволяє адміну створювати ринки за символом, а власнику — мати позицію на кожному ринку (увімкнення, сесія, вихід), без зміни лейауту акаунтів.

**Architecture:** `init_market`/`delegate_market` параметризуються символом (`[MARKET_SEED, symbol]`, SOL-PDA незмінний). Новий модуль `instructions/positions.rs`: `init_position`+`delegate_position` (L1), `init_position_permission` і `undelegate_position` (ER), `close_exited_position` (L1). `set_session` оновлює permission інших позицій власника з `remaining_accounts`. Торгівля, ліквідація, crank — уже параметризовані акаунтом ринку; це доводять тести, не зміни коду.

**Tech Stack:** Anchor 1.0.2, `ephemeral-rollups-sdk` 0.16.2, LiteSVM (`tests/litesvm`, nightly).

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.8 (2.8.1, 2.8.2, 2.8.5)

**План 2** (relayer + адмін-скрипти TS) і **план 3** (app) пишуться після цього шару — вони споживають IDL і виміри звідси.

## Global Constraints

- Лейаут жодного акаунта не змінюється; помилки лише ДОПИСУЮТЬСЯ в кінець `DexxerError` (стабільна нумерація).
- PDA SOL-ринку лишається `[MARKET_SEED, b"SOL\0\0\0\0\0"]`.
- Символ: 1–8 байт `A-Z0-9`, вирівняний вліво, доповнений нулями; інакше `InvalidSymbol`.
- Жодна нова інструкція не комітить приватні байти на L1: `undelegate_position` вимагає `Position::Empty` (поля вже обнулені `finalize_close`, trade.rs:748-761), закриває permission і викликає `exit()` ДО `commit_and_undelegate` (правило тижня 3, рулінг 10).
- CPI до Permission/Magic/Delegation програм у LiteSVM відсутні: гейти за `executable` (як `init_market_permissions`/`undelegate_user`) — авторизація все одно перевіряється до гейту.
- Solana MCP `program_autofixer` — за правилом CLAUDE.md на кожну зміну `.rs`; у цій сесії MCP недоступний → замість нього `cargo fmt --check` + `cargo clippy` + повний LiteSVM/unit (фіксується в ledger).
- Тести LiteSVM потребують зібраного `target/deploy/dexxer_core.so`: після кожної зміни програми — `cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml` (НЕ `anchor build`: локальний `anchor` — 0.26, а `anchor-1.0.2` з `[toolchain] solana_version` може перемкнути глобальну Solana).
- Коміти — Stop-хук автокоміту; окремих `git commit` не робимо.

## Review Focus

1. `set_session` з позицією, що належить **іншому** власнику, або з permission, виведеним не з цієї позиції → відмова (не мовчазне оновлення) — Task 4.
2. `init_position` для символу, чий ринок **ще не створено** → `MarketNotFound`, а не порожня позиція під неіснуючий ринок — Task 2.
3. `undelegate_position` від crank, поки власник **активний** → `Unauthorized` (janitor не може витягти позицію з-під живого трейдера) — Task 5.
4. `close_exited_position`, коли `UserAccount` на базі ще **делегований** (активний власник) → не закривати — Task 5 (гейт `user_has_left` консервативний: чужий власник = «не пішов»).
5. Трейдер з відкритою позицією на **іншому** ринку, ніж SOL, намагається вийти → `undelegate_user` відмовляє (`BalanceNotZero`) — Task 3.

---

### Task 1: символ ринку, параметризовані `init_market`/`delegate_market`, багаторинковий харнес

**Files:**
- Modify: `programs/dexxer_core/src/state/market.rs` (+ `validate_symbol`, тести)
- Modify: `programs/dexxer_core/src/errors.rs` (дописати `InvalidSymbol`, `NotOnboarded`, `UserExited`, `MarketNotFound`)
- Modify: `programs/dexxer_core/src/instructions/admin.rs` (`InitMarket`, `init_market`, `DelegateMarket`, `delegate_market`)
- Modify: `programs/dexxer_core/src/lib.rs` (сигнатури `init_market`, `delegate_market`)
- Modify: `tests/litesvm/src/pdas.rs`, `tests/litesvm/src/setup.rs`, `tests/litesvm/src/ixs.rs`
- Create: `tests/litesvm/tests/markets.rs`

**Interfaces:**
- Produces: `validate_symbol(&[u8; 8]) -> bool`; `DexxerError::{InvalidSymbol, NotOnboarded, UserExited, MarketNotFound}`; `init_market(ctx, symbol: [u8; 8], params, lazer_feed_id: String)`; `delegate_market(ctx, symbol: [u8; 8])`; харнес: `setup::sym(&str) -> [u8; 8]`, `setup::Mkt { symbol, market, risk, feed }`, `World::sol() -> Mkt`, `World::add_market(&self, h, symbol: &str, lazer_feed_id: &str, params) -> Mkt`, `World::set_price_on(&self, h, &Mkt, price_1e6, conf_bps, publish_time, posted_slot)`, `Trader::position_on(&Mkt) -> Pubkey`, `Trader::trade_accounts_on(&World, &Mkt, signer) -> Vec<AccountMeta>`, `pdas::market_for(&[u8; 8])`, `pdas::feed_for(oracle, lazer_id: &str)`, `ixs::init_market(admin, symbol, params, lazer)`, `ixs::delegate_market(admin, &World, &Mkt)`, `ixs::delegation_quad(&Pubkey)`, `ixs::dlp()`.

- [ ] **Step 1: unit-тест символу (падає — функції нема)**

У кінець `programs/dexxer_core/src/state/market.rs`:

```rust
#[cfg(test)]
mod symbol_tests {
    use super::validate_symbol;

    fn sym(s: &str) -> [u8; 8] {
        let mut b = [0u8; 8];
        b[..s.len()].copy_from_slice(s.as_bytes());
        b
    }

    #[test]
    fn accepts_uppercase_and_digits_zero_padded() {
        for s in ["SOL", "BTC", "HYPE", "ZEC", "ABCDEFGH", "1INCH"] {
            assert!(validate_symbol(&sym(s)), "{s}");
        }
    }

    #[test]
    fn rejects_empty_lowercase_and_punctuation() {
        for s in ["", "btc", "Btc", "BTC-", "B C", "ÄB"] {
            assert!(!validate_symbol(&sym(s)), "{s:?}");
        }
    }

    #[test]
    fn rejects_bytes_after_the_padding() {
        let mut b = sym("BTC");
        b[4] = b'X';
        assert!(!validate_symbol(&b));
    }
}
```

Run: `cargo test -p dexxer_core symbol_tests`
Expected: FAIL — `cannot find function validate_symbol`.

- [ ] **Step 2: `validate_symbol`**

У `state/market.rs` (перед `#[cfg(test)]`):

```rust
/// A market symbol: 1–8 bytes of `A-Z0-9`, left-aligned and zero-padded
/// (`b"BTC\0\0\0\0\0"`). It is a PDA seed, so a lowercase twin or a stray byte
/// after the padding would mint a second address for "the same" market.
pub fn validate_symbol(symbol: &[u8; 8]) -> bool {
    let len = symbol.iter().position(|&b| b == 0).unwrap_or(symbol.len());
    len > 0
        && symbol[..len].iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && symbol[len..].iter().all(|&b| b == 0)
}
```

Run: `cargo test -p dexxer_core symbol_tests` → Expected: 3 PASS.

- [ ] **Step 3: помилки**

У кінець enum `DexxerError` (після `QueueStillPending`):

```rust
    #[msg("market symbol must be 1-8 bytes of A-Z0-9, zero-padded")]
    InvalidSymbol,
    #[msg("owner has not onboarded (no UserAccount)")]
    NotOnboarded,
    #[msg("user account has exited")]
    UserExited,
    #[msg("market does not exist")]
    MarketNotFound,
```

- [ ] **Step 4: харнес — рынки як значення (падаючі LiteSVM-тести)**

`tests/litesvm/src/pdas.rs` — замінити `market()` і `feed()`:

```rust
pub fn market_for(symbol: &[u8; 8]) -> Pubkey {
    pda(&[MARKET_SEED, symbol])
}
pub fn market() -> Pubkey {
    market_for(&SOL_SYMBOL)
}
pub fn feed_for(oracle_program: &Pubkey, lazer_feed_id: &str) -> Pubkey {
    Pubkey::find_program_address(&[b"price_feed", b"pyth-lazer", lazer_feed_id.as_bytes()], oracle_program).0
}
pub fn feed(oracle_program: &Pubkey) -> Pubkey {
    feed_for(oracle_program, "6")
}
```

`tests/litesvm/src/setup.rs` — після `SEED_AMOUNT`:

```rust
/// `"BTC"` → `b"BTC\0\0\0\0\0"`, the on-chain symbol / PDA seed.
pub fn sym(s: &str) -> [u8; 8] {
    let mut b = [0u8; 8];
    b[..s.len()].copy_from_slice(s.as_bytes());
    b
}

/// One market's accounts — everything a market-scoped instruction needs.
#[derive(Clone, Copy)]
pub struct Mkt {
    pub symbol: [u8; 8],
    pub market: Pubkey,
    pub risk: Pubkey,
    pub feed: Pubkey,
}
```

У `bootstrap_inner` виклик `ixs::init_market(&admin.pubkey(), MarketParams::sol_perp_defaults(), "6")` → `ixs::init_market(&admin.pubkey(), dexxer_core::state::SOL_SYMBOL, MarketParams::sol_perp_defaults(), "6")`. У `impl World` (другий блок, де `set_price`) — `set_price` стає обгорткою, плюс нові методи:

```rust
    pub fn sol(&self) -> Mkt {
        Mkt { symbol: dexxer_core::state::SOL_SYMBOL, market: self.market, risk: self.risk, feed: self.feed }
    }

    /// `init_market` for another symbol under the same admin/oracle (LiteSVM:
    /// no delegation, so the market is usable straight away).
    pub fn add_market(&self, h: &mut Harness, symbol: &str, lazer_feed_id: &str, params: MarketParams) -> Mkt {
        let s = sym(symbol);
        h.send(&[ixs::init_market(&self.admin.pubkey(), s, params, lazer_feed_id)], &[&self.admin])
            .unwrap();
        let market = pdas::market_for(&s);
        Mkt { symbol: s, market, risk: pdas::risk(&market), feed: pdas::feed_for(&self.oracle_program, lazer_feed_id) }
    }

    pub fn set_price(&self, h: &mut Harness, price_1e6: u64, conf_bps: u32, publish_time: i64, posted_slot: u64) {
        self.set_price_on(h, &self.sol(), price_1e6, conf_bps, publish_time, posted_slot);
    }
```

і перейменувати наявне тіло `set_price` на `set_price_on(&self, h: &mut Harness, m: &Mkt, price_1e6: u64, conf_bps: u32, publish_time: i64, posted_slot: u64)`, де `self.feed` → `m.feed`. У `impl Trader`:

```rust
    pub fn position_on(&self, m: &Mkt) -> Pubkey {
        pdas::position(&self.kp.pubkey(), &m.market)
    }
    pub fn trade_accounts(&self, w: &World, signer: &Pubkey) -> Vec<AccountMeta> {
        self.trade_accounts_on(w, &w.sol(), signer)
    }
```

а наявне тіло `trade_accounts` перейменувати на `trade_accounts_on(&self, w: &World, m: &Mkt, signer: &Pubkey)`, де `w.market` → `m.market`, `w.risk` → `m.risk`, `w.feed` → `m.feed`, обидва `self.position` → `self.position_on(m)`.

`tests/litesvm/src/ixs.rs` — `init_market` і нові хелпери делегації (імпорт `crate::setup::Mkt` у верхній `use`):

```rust
pub fn init_market(admin: &Pubkey, symbol: [u8; 8], params: MarketParams, lazer_feed_id: &str) -> Instruction {
    let m = pdas::market_for(&symbol);
    Instruction {
        program_id: prog(),
        accounts: vec![s(admin), r(&pdas::config()), w(&m), w(&pdas::risk(&m)), r(&SYSTEM)],
        data: ix::InitMarket { symbol, params, lazer_feed_id: lazer_feed_id.to_string() }.data(),
    }
}

pub fn dlp() -> Pubkey {
    pk(anchor_lang::prelude::Pubkey::new_from_array(
        ephemeral_rollups_sdk::consts::DELEGATION_PROGRAM_ID.to_bytes(),
    ))
}

/// The `[buffer, delegation_record, delegation_metadata, account]` quadruple the
/// `#[delegate]` macro expands each `del` field into (see `delegate_user`).
pub fn delegation_quad(acc: &Pubkey) -> [AccountMeta; 4] {
    use ephemeral_rollups_sdk::pda::{DELEGATE_BUFFER_TAG, DELEGATION_METADATA_TAG, DELEGATION_RECORD_TAG};
    let buffer = Pubkey::find_program_address(&[DELEGATE_BUFFER_TAG, acc.as_ref()], &prog()).0;
    let record = Pubkey::find_program_address(&[DELEGATION_RECORD_TAG, acc.as_ref()], &dlp()).0;
    let meta = Pubkey::find_program_address(&[DELEGATION_METADATA_TAG, acc.as_ref()], &dlp()).0;
    [w(&buffer), w(&record), w(&meta), w(acc)]
}

pub fn delegate_market(admin: &Pubkey, wd: &World, m: &Mkt) -> Instruction {
    let mut accounts = vec![s(admin), r(&wd.config)];
    accounts.extend(delegation_quad(&m.market));
    accounts.extend(delegation_quad(&m.risk));
    accounts.extend([r(&prog()), r(&dlp()), r(&SYSTEM)]);
    Instruction { program_id: prog(), accounts, data: ix::DelegateMarket { symbol: m.symbol }.data() }
}
```

`tests/litesvm/tests/markets.rs` — нова тест-сюїта:

```rust
// Spec §2.8: markets beyond SOL, an owner's position on every market, and the
// exit path across markets. LiteSVM has no Delegation/Permission/Magic
// program, so delegation CPIs fail by design (asserted as "passed every
// constraint": no custom error) and ER CPIs are gated off by `executable`.
use anchor_lang::InstructionData;
use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    assert_custom_error, custom_error_code, ixs, pdas, pk,
    setup::{sym, Mkt, World},
    Harness,
};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

const NOW: i64 = 2_000_000;

/// BTC-PERP: the SOL defaults with a dollar-equivalent size window
/// (0.00002 … 0.15 BTC at 1e9 size scale) and a staleness bound that fits the
/// ~9 s devnet feed cadence.
fn btc_params() -> MarketParams {
    MarketParams { min_size: 20_000, max_position: 150_000_000, max_staleness_secs: 15, ..MarketParams::sol_perp_defaults() }
}

#[test]
fn init_market_stores_symbol_and_feed() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let m: Market = h.account(&btc.market);
    assert_eq!(m.symbol, sym("BTC"));
    assert_eq!(pk(m.feed), btc.feed);
    assert_eq!(m.min_size, 20_000);
}

#[test]
fn sol_market_pda_is_unchanged() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let legacy = Pubkey::find_program_address(&[b"market", b"SOL\0\0\0\0\0"], &pk(dexxer_core::ID)).0;
    assert_eq!(w.market, legacy);
    assert_eq!(h.account::<Market>(&w.market).symbol, SOL_SYMBOL);
}

#[test]
fn init_market_rejects_invalid_symbols() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let mut after_padding = sym("BTC");
    after_padding[4] = b'X';
    for bad in [sym("btc"), sym(""), sym("B-C"), after_padding] {
        let r = h.send(&[ixs::init_market(&w.admin.pubkey(), bad, btc_params(), "1")], &[&w.admin]);
        assert_custom_error(&r, 6000 + DexxerError::InvalidSymbol as u32);
    }
}

#[test]
fn init_market_rejects_a_duplicate_symbol_and_a_non_admin() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    w.add_market(&mut h, "BTC", "1", btc_params());
    let dup = h.send(&[ixs::init_market(&w.admin.pubkey(), sym("BTC"), btc_params(), "2")], &[&w.admin]);
    assert!(dup.is_err(), "a second BTC market must not be created");
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(&[ixs::init_market(&stranger.pubkey(), sym("ETH"), btc_params(), "2")], &[&stranger]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
}

#[test]
fn delegate_market_passes_its_guards_for_any_symbol() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let r = h.send(&[ixs::delegate_market(&w.admin.pubkey(), &w, &btc)], &[&w.admin]);
    assert!(r.is_err(), "no delegation program is deployed on LiteSVM");
    assert_eq!(custom_error_code(&r), None, "must fail at the delegation CPI, not at a constraint");
    let mut wrong = ixs::delegate_market(&w.admin.pubkey(), &w, &btc);
    wrong.data = dexxer_core::instruction::DelegateMarket { symbol: sym("ETH") }.data();
    let r = h.send(&[wrong], &[&w.admin]);
    assert_eq!(custom_error_code(&r), Some(2006), "ConstraintSeeds: the symbol must match the market account");
}
```

Run: `cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml && cd tests/litesvm && cargo +nightly test -p dexxer_litesvm --test markets`
Expected: FAIL (компіляція: `InitMarket` не має поля `symbol`, `DelegateMarket` не має `symbol`).

- [ ] **Step 5: програма — `init_market(symbol, …)` і `delegate_market(symbol)`**

`instructions/admin.rs`, `InitMarket`: додати `#[instruction(symbol: [u8; 8])]` одразу під `#[derive(Accounts)]`, сіди ринку `seeds = [MARKET_SEED, &symbol]`. Тіло:

```rust
pub fn init_market(
    ctx: Context<InitMarket>,
    symbol: [u8; 8],
    params: MarketParams,
    lazer_feed_id: String,
) -> Result<()> {
    require!(validate_symbol(&symbol), DexxerError::InvalidSymbol);
    require!(params.validate(), DexxerError::InvalidParams);
    let m = &mut ctx.accounts.market;
    m.version = 1;
    m.symbol = symbol;
```

(решта тіла без змін). `DelegateMarket`: `#[instruction(symbol: [u8; 8])]` під `#[derive(Accounts)]`, `seeds = [MARKET_SEED, &symbol]`; хендлер `pub fn delegate_market(ctx: Context<DelegateMarket>, symbol: [u8; 8]) -> Result<()>` з `&[MARKET_SEED, &symbol]` замість `&[MARKET_SEED, &SOL_SYMBOL]`. `lib.rs`:

```rust
    pub fn init_market(
        ctx: Context<InitMarket>,
        symbol: [u8; 8],
        params: MarketParams,
        lazer_feed_id: String,
    ) -> Result<()> {
        admin::init_market(ctx, symbol, params, lazer_feed_id)
    }
```

```rust
    pub fn delegate_market(ctx: Context<DelegateMarket>, symbol: [u8; 8]) -> Result<()> {
        admin::delegate_market(ctx, symbol)
    }
```

- [ ] **Step 6: GREEN**

Run: `cargo test -p dexxer_core && cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml && cd tests/litesvm && cargo +nightly test -p dexxer_litesvm`
Expected: unit — усі PASS (+3 `symbol_tests`); LiteSVM — `markets` 5 PASS, решта сюїт без регресій (89 + 5).

### Task 2: `init_position` + `delegate_position` (L1)

**Files:**
- Create: `programs/dexxer_core/src/instructions/positions.rs`
- Modify: `programs/dexxer_core/src/instructions/mod.rs`, `programs/dexxer_core/src/lib.rs`
- Modify: `tests/litesvm/src/ixs.rs`, `tests/litesvm/tests/markets.rs`

**Interfaces:**
- Consumes: Task 1 (`Mkt`, `delegation_quad`, `dlp`, помилки).
- Produces: `positions::{require_user_active, user_has_left}` (`pub(crate)`), інструкції `init_position(symbol)`, `delegate_position(symbol)`; `ixs::init_position(owner, payer, &Mkt)`, `ixs::delegate_position(owner, payer, &World, &Mkt)`.

- [ ] **Step 1: падаючі тести** — у `tests/markets.rs`:

```rust
#[test]
fn init_position_creates_an_empty_prefunded_position() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let t = w.new_trader(&mut h, 0);
    let payer = Keypair::new();
    h.fund(&payer.pubkey(), 5_000_000_000);
    let before = h.svm.get_account(&payer.pubkey()).unwrap().lamports;
    h.send(&[ixs::init_position(&t.kp.pubkey(), &payer.pubkey(), &btc)], &[&t.kp, &payer])
        .unwrap();
    let key = t.position_on(&btc);
    let p: Position = h.account(&key);
    assert_eq!(pk(p.owner), t.kp.pubkey());
    assert_eq!(pk(p.market), btc.market);
    assert_eq!(p.state, PositionState::Empty);
    let lamports = h.svm.get_account(&key).unwrap().lamports;
    assert_eq!(
        lamports,
        h.svm.get_account(&t.position).unwrap().lamports,
        "same rent + permission prefund as init_user's SOL position"
    );
    println!(
        "MEASURE init_position: position lamports {lamports}, payer spent {}",
        before - h.svm.get_account(&payer.pubkey()).unwrap().lamports
    );
}

#[test]
fn init_position_requires_an_onboarded_active_owner_and_an_existing_market() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 5_000_000_000);
    let r = h.send(&[ixs::init_position(&stranger.pubkey(), &stranger.pubkey(), &btc)], &[&stranger]);
    assert_custom_error(&r, 6000 + DexxerError::NotOnboarded as u32);

    let t = w.new_trader(&mut h, 0);
    let eth = sym("ETH");
    let ghost = Mkt { symbol: eth, market: pdas::market_for(&eth), risk: Pubkey::default(), feed: Pubkey::default() };
    let r = h.send(&[ixs::init_position(&t.kp.pubkey(), &t.kp.pubkey(), &ghost)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::MarketNotFound as u32);

    // LiteSVM: undelegate_user sets `exited` and skips the ER CPIs.
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp]).unwrap();
    let r = h.send(&[ixs::init_position(&t.kp.pubkey(), &t.kp.pubkey(), &btc)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::UserExited as u32);
}

#[test]
fn init_position_needs_the_owner_signature_and_is_one_per_market() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let t = w.new_trader(&mut h, 0);
    let payer = Keypair::new();
    h.fund(&payer.pubkey(), 5_000_000_000);
    let mut unsigned = ixs::init_position(&t.kp.pubkey(), &payer.pubkey(), &btc);
    unsigned.accounts[0].is_signer = false;
    let r = h.send(&[unsigned], &[&payer]);
    assert_eq!(custom_error_code(&r), Some(3010), "AccountNotSigner");
    h.send(&[ixs::init_position(&t.kp.pubkey(), &payer.pubkey(), &btc)], &[&t.kp, &payer])
        .unwrap();
    let again = h.send(&[ixs::init_position(&t.kp.pubkey(), &payer.pubkey(), &btc)], &[&t.kp, &payer]);
    assert!(again.is_err(), "one position per owner per market");
}

#[test]
fn delegate_position_passes_its_guards_and_refuses_an_exited_owner() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let t = w.new_trader(&mut h, 0);
    h.send(&[ixs::init_position(&t.kp.pubkey(), &t.kp.pubkey(), &btc)], &[&t.kp]).unwrap();
    let r = h.send(&[ixs::delegate_position(&t.kp.pubkey(), &t.kp.pubkey(), &w, &btc)], &[&t.kp]);
    assert!(r.is_err(), "no delegation program is deployed on LiteSVM");
    assert_eq!(custom_error_code(&r), None, "must fail at the delegation CPI, not at a constraint");
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp]).unwrap();
    let r = h.send(&[ixs::delegate_position(&t.kp.pubkey(), &t.kp.pubkey(), &w, &btc)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::UserExited as u32);
}
```

Білдери в `ixs.rs`:

```rust
pub fn init_position(owner: &Pubkey, payer: &Pubkey, m: &Mkt) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            rs(owner),
            s(payer),
            r(&m.market),
            r(&pdas::user(owner)),
            w(&pdas::position(owner, &m.market)),
            r(&SYSTEM),
        ],
        data: ix::InitPosition { symbol: m.symbol }.data(),
    }
}

pub fn delegate_position(owner: &Pubkey, payer: &Pubkey, wd: &World, m: &Mkt) -> Instruction {
    let mut accounts = vec![rs(owner), s(payer), r(&wd.config), r(&m.market), r(&pdas::user(owner))];
    accounts.extend(delegation_quad(&pdas::position(owner, &m.market)));
    accounts.extend([r(&prog()), r(&dlp()), r(&SYSTEM)]);
    Instruction { program_id: prog(), accounts, data: ix::DelegatePosition { symbol: m.symbol }.data() }
}
```

Run: `cd tests/litesvm && cargo +nightly test -p dexxer_litesvm --test markets` → Expected: FAIL (компіляція: `ix::InitPosition`/`ix::DelegatePosition` не існують).

- [ ] **Step 2: `instructions/positions.rs`**

```rust
// programs/dexxer_core/src/instructions/positions.rs
//
// An owner's `Position` on every market beyond the SOL one `init_user` creates
// (spec §2.8.2): enable a market (`init_position` + `delegate_position` on L1,
// `init_position_permission` in the ER), and take an extra position back out
// on exit (`undelegate_position` in the ER, `close_exited_position` on L1).
//
// Every owner gets a position on EVERY market, created together and never at
// trade time (spec §2.8, "Приватність"): the PDA `[position, owner, market]`
// lives on L1, where nothing filters reads, so creating it at the first trade
// would publish which markets a trader uses and when they started.
use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};
use ephemeral_rollups_sdk::{
    access_control::structs::EphemeralPermission,
    anchor::delegate,
    consts::DELEGATION_PROGRAM_ID,
    cpi::DelegateConfig,
    ephemeral_accounts::rent,
};

use crate::{errors::DexxerError, state::*};

/// The owner is onboarded and has not exited. On L1 an active `UserAccount` is
/// delegated — owned by the Delegation Program, bytes frozen at delegation, so
/// `exited` is unreadable there, but an exited account is always handed back to
/// this program first. Owned by this program means mid-onboarding (or LiteSVM,
/// which has no delegation program) or exited: read it.
pub(crate) fn require_user_active(ua: &AccountInfo) -> Result<()> {
    require!(!ua.data_is_empty(), DexxerError::NotOnboarded);
    if ua.owner == &crate::ID {
        let u = UserAccount::try_deserialize(&mut &ua.try_borrow_data()?[..])?;
        require!(!u.exited, DexxerError::UserExited);
        return Ok(());
    }
    require!(ua.owner == &DELEGATION_PROGRAM_ID, DexxerError::NotOnboarded);
    Ok(())
}

/// The owner has left: their `UserAccount` is gone, or present under this
/// program with `exited`. Anything else — live, still delegated, foreign — is
/// "not left": the conservative answer for instructions that act on an
/// owner's position without the owner's signature.
pub(crate) fn user_has_left(ua: &AccountInfo) -> Result<bool> {
    if ua.data_is_empty() {
        return Ok(true);
    }
    if ua.owner != &crate::ID {
        return Ok(false);
    }
    let u = UserAccount::try_deserialize(&mut &ua.try_borrow_data()?[..])?;
    Ok(u.exited)
}

#[derive(Accounts)]
#[instruction(symbol: [u8; 8])]
pub struct InitPosition<'info> {
    pub owner: Signer<'info>,
    /// Funds the rent and the permission prefund — `fee_payer` via `/sponsor` for a 0-SOL owner, or the owner.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: pinned by the symbol seed; a live market is delegated on L1, so it cannot be a typed `Account<Market>` (same reason as `InitUser.market`). Existence is checked in the handler.
    #[account(seeds = [MARKET_SEED, &symbol], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: read by `require_user_active` — delegated on L1 for an active owner, so it cannot be typed.
    #[account(seeds = [USER_SEED, owner.key().as_ref()], bump)]
    pub user_account: UncheckedAccount<'info>,
    // Boxed like every `Position` in an init context (SBF stack frame).
    #[account(
        init,
        payer = payer,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    pub system_program: Program<'info, System>,
}

pub fn init_position(ctx: Context<InitPosition>, _symbol: [u8; 8]) -> Result<()> {
    require!(!ctx.accounts.market.data_is_empty(), DexxerError::MarketNotFound);
    require_user_active(&ctx.accounts.user_account.to_account_info())?;
    let p = &mut ctx.accounts.position;
    p.version = 1;
    p.owner = ctx.accounts.owner.key();
    p.market = ctx.accounts.market.key();
    p.state = PositionState::Empty;
    p.side = Side::Long;
    p.bump = ctx.bumps.position;
    // Same prefund as `init_user`: inside the ER the permission's rent is paid
    // by the permissioned PDA itself (spike 01 pattern).
    let extra = rent(EphemeralPermission::size_of(PERMISSION_MEMBERS) as u32);
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.position.to_account_info(),
            },
        ),
        extra,
    )
}

#[delegate]
#[derive(Accounts)]
#[instruction(symbol: [u8; 8])]
pub struct DelegatePosition<'info> {
    pub owner: Signer<'info>,
    /// Funds the delegation records (as `DelegateUser.payer`).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: market key for the position seed
    #[account(seeds = [MARKET_SEED, &symbol], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: read by `require_user_active`
    #[account(seeds = [USER_SEED, owner.key().as_ref()], bump)]
    pub user_account: UncheckedAccount<'info>,
    /// CHECK: delegated
    #[account(mut, del, seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
}

pub fn delegate_position(ctx: Context<DelegatePosition>, _symbol: [u8; 8]) -> Result<()> {
    require_user_active(&ctx.accounts.user_account.to_account_info())?;
    let o = ctx.accounts.owner.key();
    let m = ctx.accounts.market.key();
    ctx.accounts.delegate_position(
        &ctx.accounts.payer,
        &[POSITION_SEED, o.as_ref(), m.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    Ok(())
}
```

`instructions/mod.rs`: `pub mod positions;` + `pub use positions::*;` (за алфавітом). `lib.rs`:

```rust
    pub fn init_position(ctx: Context<InitPosition>, symbol: [u8; 8]) -> Result<()> {
        positions::init_position(ctx, symbol)
    }
    pub fn delegate_position(ctx: Context<DelegatePosition>, symbol: [u8; 8]) -> Result<()> {
        positions::delegate_position(ctx, symbol)
    }
```

- [ ] **Step 3: GREEN**

Run: `cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml && cd tests/litesvm && cargo +nightly test -p dexxer_litesvm --test markets -- --nocapture 2>&1 | grep -E "MEASURE|test result"`
Expected: 9 PASS; рядок `MEASURE init_position` — у ledger (рента на ринок).

### Task 3: торгівля на двох ринках — ізоляція, ліквідація за ринком, вихід (характеризаційні тести)

**Files:**
- Modify: `tests/litesvm/src/lib.rs` (`assert_invariant_markets`), `tests/litesvm/src/ixs.rs` (`open_position_on`, `close_position_on`, `crank_tick_on`)
- Modify: `tests/litesvm/tests/markets.rs`

**Interfaces:**
- Consumes: Task 1–2.
- Produces: `assert_invariant_markets(&Harness, &World, &[&Trader], markets: &[Pubkey])`; `ixs::open_position_on(signer, &Trader, &World, &Mkt, side, size, margin, limit)`, `ixs::close_position_on(signer, &Trader, &World, &Mkt, limit)`, `ixs::crank_tick_on(crank, &World, &Mkt, &[&Trader])`.

Програма тут не змінюється: торгові/crank-інструкції вже беруть ринок акаунтом. Тести — доказ, тому вони мають пройти одразу після Step 1–2; якщо ні — це знахідка (дефект програми), її чинимо з тестом, що впав.

- [ ] **Step 1: харнес**

`lib.rs` — інваріант по всіх ринках трейдера (старий стає частковим випадком):

```rust
pub fn assert_invariant_ctx(h: &Harness, w: &setup::World, traders: &[&setup::Trader], ctx: &str) {
    assert_invariant_markets_ctx(h, w, traders, &[w.market], ctx);
}

pub fn assert_invariant_markets(h: &Harness, w: &setup::World, traders: &[&setup::Trader], markets: &[Pubkey]) {
    assert_invariant_markets_ctx(h, w, traders, markets, "");
}

/// protocol_liquidity + fees + insurance + Σ free + Σ open margins (every market) == capital_total == vault.
pub fn assert_invariant_markets_ctx(
    h: &Harness,
    w: &setup::World,
    traders: &[&setup::Trader],
    markets: &[Pubkey],
    ctx: &str,
) {
    let pool: dexxer_core::state::PoolLive = h.account(&w.pool_live);
    let mut sum = pool.protocol_liquidity + pool.fees_accrued + pool.insurance;
    let mut locked_sum: u64 = 0;
    for t in traders {
        let u: dexxer_core::state::UserAccount = h.account(&t.user);
        let mut open_margin = 0u64;
        for m in markets {
            let key = pdas::position(&t.kp.pubkey(), m);
            if h.svm.get_account(&key).map_or(true, |a| a.data.is_empty()) {
                continue;
            }
            let p: dexxer_core::state::Position = h.account(&key);
            if p.state == dexxer_core::state::PositionState::Open {
                open_margin += p.margin;
            }
        }
        sum += u.free_margin + open_margin;
        locked_sum += open_margin;
        assert_eq!(u.locked_margin, open_margin, "{ctx}user.locked_margin != Σ open margins for {}", t.user);
    }
    assert_eq!(sum, pool.capital_total, "{ctx}sum != capital_total");
    assert_eq!(pool.capital_total, token_ix::token_balance(&h.svm, &w.pool_ata), "{ctx}capital_total != vault balance");
    assert_eq!(pool.locked_total, locked_sum, "{ctx}pool.locked_total != Σ open margins");
}
```

(стара тіло `assert_invariant_ctx` видаляється — воно тепер делегує.) `ixs.rs`:

```rust
#[allow(clippy::too_many_arguments)]
pub fn open_position_on(signer: &Pubkey, t: &Trader, wd: &World, m: &Mkt, side: Side, size: u64, margin: u64, limit_price: u64) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: t.trade_accounts_on(wd, m, signer),
        data: ix::OpenPosition { side, size, margin, limit_price }.data(),
    }
}
pub fn close_position_on(signer: &Pubkey, t: &Trader, wd: &World, m: &Mkt, limit_price: u64) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: t.trade_accounts_on(wd, m, signer),
        data: ix::ClosePosition { limit_price }.data(),
    }
}
pub fn crank_tick_on(crank: &Pubkey, wd: &World, m: &Mkt, candidates: &[&Trader]) -> Instruction {
    let mut accounts = vec![rs(crank), r(&wd.config), w(&m.market), w(&m.risk), w(&wd.pool_live), r(&m.feed)];
    for t in candidates {
        accounts.push(w(&t.position_on(m)));
        accounts.push(w(&t.user));
        accounts.push(w(&t.dq));
    }
    Instruction { program_id: prog(), accounts, data: ix::CrankTick {}.data() }
}
```

і наявний `crank_tick` → `crank_tick_on(crank, wd, &wd.sol(), candidates)`.

- [ ] **Step 2: тести**

```rust
const P150: u64 = 150_000_000;
const SOL10: u64 = 10_000_000_000;
const M150: u64 = 150_000_000;
const B80K: u64 = 80_000_000_000;
const B70K: u64 = 70_000_000_000;
const BTC_01: u64 = 10_000_000; // 0.01 BTC at 1e9 size scale → $800 notional at $80k
const M80: u64 = 80_000_000; // 10x

/// SOL at $150 and BTC at $80k, one trader with 1,000 dUSDC and a BTC position slot.
fn two_markets(h: &mut Harness) -> (World, Mkt, dexxer_litesvm::setup::Trader) {
    let w = World::bootstrap(h);
    let btc = w.add_market(h, "BTC", "1", btc_params());
    h.warp(100, NOW);
    w.set_price(h, P150, 5, NOW, 100);
    w.set_price_on(h, &btc, B80K, 5, NOW, 100);
    let t = w.new_trader(h, 1_000_000_000);
    h.send(&[ixs::init_position(&t.kp.pubkey(), &t.kp.pubkey(), &btc)], &[&t.kp]).unwrap();
    (w, btc, t)
}

#[test]
fn one_trader_holds_isolated_positions_on_two_markets() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    h.send(&[ixs::open_position(&t.kp.pubkey(), &t, &w, Side::Long, SOL10, M150, P150)], &[&t.kp]).unwrap();
    h.send(&[ixs::open_position_on(&t.kp.pubkey(), &t, &w, &btc, Side::Short, BTC_01, M80, B80K)], &[&t.kp]).unwrap();
    let u: UserAccount = h.account(&t.user);
    let sol: Position = h.account(&t.position);
    let b: Position = h.account(&t.position_on(&btc));
    assert_eq!((sol.state, b.state), (PositionState::Open, PositionState::Open));
    assert_eq!(u.locked_margin, sol.margin + b.margin);
    dexxer_litesvm::assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

#[test]
fn a_btc_crash_liquidates_only_the_btc_position() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    h.send(&[ixs::open_position(&t.kp.pubkey(), &t, &w, Side::Long, SOL10, M150, P150)], &[&t.kp]).unwrap();
    h.send(&[ixs::open_position_on(&t.kp.pubkey(), &t, &w, &btc, Side::Long, BTC_01, M80, B80K)], &[&t.kp]).unwrap();
    // Hard EMA + wide deviation guard: the BTC mark lands on $70k in one tick.
    let mut p = btc_params();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(&[ixs::set_params(&w.admin.pubkey(), &w.config, &btc.market, p)], &[&w.admin]).unwrap();
    w.set_price_on(&mut h, &btc, B70K, 5, NOW, 101);
    for _ in 0..btc_params().liq_hysteresis_ticks {
        h.send(&[ixs::crank_tick_on(&w.crank.pubkey(), &w, &btc, &[&t])], &[&w.crank]).unwrap();
    }
    assert_eq!(h.account::<Position>(&t.position_on(&btc)).state, PositionState::Empty, "BTC liquidated");
    let sol: Position = h.account(&t.position);
    assert_eq!(sol.state, PositionState::Open, "SOL untouched by the BTC crank");
    assert_eq!(h.account::<UserAccount>(&t.user).locked_margin, sol.margin);
    dexxer_litesvm::assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

#[test]
fn an_open_btc_position_blocks_the_exit_until_closed() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    h.send(&[ixs::open_position_on(&t.kp.pubkey(), &t, &w, &btc, Side::Long, BTC_01, M80, B80K)], &[&t.kp]).unwrap();
    // The SOL position is Empty — only the margin gate can stop this exit.
    let r = h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::BalanceNotZero as u32);
    h.send(&[ixs::close_position_on(&t.kp.pubkey(), &t, &w, &btc, B80K)], &[&t.kp]).unwrap();
    assert_eq!(h.account::<Position>(&t.position_on(&btc)).state, PositionState::Empty);
    assert_eq!(h.account::<UserAccount>(&t.user).locked_margin, 0);
    dexxer_litesvm::assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}
```

- [ ] **Step 3: прогін**

Run: `cd tests/litesvm && cargo +nightly test -p dexxer_litesvm` 
Expected: `markets` 12 PASS; усі наявні сюїти без регресій (інваріант делегує в новий хелпер).

### Task 4: `init_position_permission` (ER) + `set_session` для інших ринків

**Files:**
- Modify: `programs/dexxer_core/src/instructions/positions.rs`, `programs/dexxer_core/src/instructions/user.rs` (`set_session`), `programs/dexxer_core/src/lib.rs`
- Modify: `tests/litesvm/src/ixs.rs`, `tests/litesvm/tests/markets.rs`

**Interfaces:**
- Consumes: Task 2 (`positions.rs`).
- Produces: `init_position_permission()` (акаунти: `signer, config, position, user_account, position_permission, permission_program, ephemeral_vault, magic_program`); `set_session` приймає `remaining_accounts` парами `[position (w), position_permission (w)]`; `ixs::init_position_permission(signer, &World, owner, &Mkt)`, `ixs::set_session_with(signer, &Trader, session, expiry, actions, extra_positions: &[Pubkey])`.

- [ ] **Step 1: падаючі тести**

```rust
#[test]
fn init_position_permission_accepts_the_owner_or_a_live_session_only() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    h.warp(100, NOW);
    let t = w.new_trader(&mut h, 0);
    let o = t.kp.pubkey();
    h.send(&[ixs::init_position(&o, &o, &btc)], &[&t.kp]).unwrap();
    h.send(&[ixs::init_position_permission(&o, &w, &o, &btc)], &[&t.kp]).unwrap();

    let stranger = Keypair::new();
    let r = h.send(&[ixs::init_position_permission(&stranger.pubkey(), &w, &o, &btc)], &[&stranger]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);

    let session = Keypair::new();
    h.send(&[ixs::set_session(&o, &t, &session.pubkey(), NOW + 3_600, 10)], &[&t.kp]).unwrap();
    h.send(&[ixs::init_position_permission(&session.pubkey(), &w, &o, &btc)], &[&session]).unwrap();

    h.warp(200, NOW + 7_200);
    let r = h.send(&[ixs::init_position_permission(&session.pubkey(), &w, &o, &btc)], &[&session]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
}

#[test]
fn set_session_updates_the_owners_other_positions_and_rejects_foreign_or_mismatched_pairs() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    h.warp(100, NOW);
    let t = w.new_trader(&mut h, 0);
    let u = w.new_trader(&mut h, 0);
    for x in [&t, &u] {
        h.send(&[ixs::init_position(&x.kp.pubkey(), &x.kp.pubkey(), &btc)], &[&x.kp]).unwrap();
    }
    let o = t.kp.pubkey();
    let session = Keypair::new().pubkey();

    h.send(&[ixs::set_session_with(&o, &t, &session, NOW + 3_600, 10, &[t.position_on(&btc)])], &[&t.kp])
        .unwrap();

    let r = h.send(&[ixs::set_session_with(&o, &t, &session, NOW + 3_601, 10, &[u.position_on(&btc)])], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);

    let mut wrong_perm = ixs::set_session_with(&o, &t, &session, NOW + 3_602, 10, &[t.position_on(&btc)]);
    let last = wrong_perm.accounts.len() - 1;
    wrong_perm.accounts[last].pubkey = pdas::permission(&t.user);
    let r = h.send(&[wrong_perm], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::InvalidInput as u32);

    let mut odd = ixs::set_session_with(&o, &t, &session, NOW + 3_603, 10, &[t.position_on(&btc)]);
    odd.accounts.pop();
    let r = h.send(&[odd], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::InvalidInput as u32);

    let not_a_position = ixs::set_session_with(&o, &t, &session, NOW + 3_604, 10, &[t.user]);
    let r = h.send(&[not_a_position], &[&t.kp]);
    assert_eq!(custom_error_code(&r), Some(3002), "AccountDiscriminatorMismatch");
}
```

Білдери:

```rust
pub fn init_position_permission(signer: &Pubkey, wd: &World, owner: &Pubkey, m: &Mkt) -> Instruction {
    let pos = pdas::position(owner, &m.market);
    Instruction {
        program_id: prog(),
        accounts: vec![
            rs(signer),
            r(&wd.config),
            w(&pos),
            r(&pdas::user(owner)),
            w(&pdas::permission(&pos)),
            r(&pdas::permission_program()),
            w(&pdas::ephemeral_vault()),
            r(&pdas::magic_program()),
        ],
        data: ix::InitPositionPermission {}.data(),
    }
}

/// `set_session` plus `[position, permission]` pairs for the owner's positions on other markets (spec §2.8.2).
pub fn set_session_with(signer: &Pubkey, t: &Trader, session: &Pubkey, expiry: i64, actions: u32, extra_positions: &[Pubkey]) -> Instruction {
    let mut ix = set_session(signer, t, session, expiry, actions);
    for p in extra_positions {
        ix.accounts.push(w(p));
        ix.accounts.push(w(&pdas::permission(p)));
    }
    ix
}
```

Run: `cd tests/litesvm && cargo +nightly test -p dexxer_litesvm --test markets` → Expected: FAIL (`ix::InitPositionPermission` не існує).

- [ ] **Step 2: `init_position_permission`** — у `positions.rs` (імпорти розширити: `access_control::{instructions::{CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi}, structs::{EphemeralMembersArgs, EphemeralPermission, PERMISSION_SEED}}`, `consts::{DELEGATION_PROGRAM_ID, EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID}`):

```rust
/// Owner, or the owner's live session key (not consuming `actions_left` —
/// making one's own position private is not a trade).
fn is_owner_or_live_session(signer: &Pubkey, u: &UserAccount, now: i64) -> bool {
    *signer == u.owner || (u.session_key != Pubkey::default() && *signer == u.session_key && now < u.session_expiry)
}

// ER: make a freshly delegated position private, `[owner, session, crank]`
// (session from `UserAccount.session_key`) — the per-market twin of
// `init_permissions`. Signable by the session key, so the app can enable new
// markets in the ER without a wallet prompt.
#[derive(Accounts)]
pub struct InitPositionPermission<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POSITION_SEED, position.owner.as_ref(), position.market.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(seeds = [USER_SEED, position.owner.as_ref()], bump = user_account.bump)]
    pub user_account: Box<Account<'info, UserAccount>>,
    /// CHECK: permission PDA of `position`, under the permission program
    #[account(mut, seeds = [PERMISSION_SEED, position.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub position_permission: UncheckedAccount<'info>,
    /// CHECK:
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK:
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

pub fn init_position_permission(ctx: Context<InitPositionPermission>) -> Result<()> {
    let a = &ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    require!(is_owner_or_live_session(&a.signer.key(), &a.user_account, now), DexxerError::Unauthorized);
    require!(!a.user_account.exited, DexxerError::UserExited);
    // LiteSVM and L1 have no permission program — authorization above still ran.
    if !a.permission_program.to_account_info().executable {
        return Ok(());
    }
    let o = a.position.owner;
    let m = a.position.market;
    let pb = [a.position.bump];
    let seeds: &[&[u8]] = &[POSITION_SEED, o.as_ref(), m.as_ref(), &pb];
    let args = EphemeralMembersArgs {
        is_private: true,
        members: build_members(o, a.user_account.session_key, a.config.crank),
    };
    let acc = a.position.to_account_info();
    let perm = a.position_permission.to_account_info();
    // Ownership, not lamports, detects an existing permission (a fresh one has
    // 0 lamports — its rent lives in the shared vault; see `init_permissions`).
    if perm.owner == &PERMISSION_PROGRAM_ID {
        UpdateEphemeralPermissionCpi {
            payer: acc.clone(),
            permissioned_account: acc.clone(),
            permission: perm.clone(),
            vault: a.ephemeral_vault.to_account_info(),
            magic_program: a.magic_program.to_account_info(),
            permission_program: a.permission_program.to_account_info(),
            authority: acc.clone(),
            authority_is_signer: false,
            args,
        }
        .invoke_signed(&[seeds])?;
    } else {
        CreateEphemeralPermissionCpi {
            payer: acc.clone(),
            permissioned_account: acc.clone(),
            permission: perm.clone(),
            vault: a.ephemeral_vault.to_account_info(),
            magic_program: a.magic_program.to_account_info(),
            permission_program: a.permission_program.to_account_info(),
            args,
        }
        .invoke_signed(&[seeds])?;
    }
    Ok(())
}
```

- [ ] **Step 3: `set_session` — пари інших ринків.** У `user.rs`, сигнатура `pub fn set_session<'info>(ctx: Context<'info, SetSession<'info>>, session_key: Pubkey, expiry: i64, actions: u32) -> Result<()>`; перед фінальним `Ok(())`:

```rust
    // Spec §2.8.2: the owner's positions on other markets, as
    // `[position, position_permission]` pairs in `remaining_accounts`. They
    // arrive untyped, so each is checked by hand — otherwise a foreign account
    // could slip itself into this owner's member list.
    let rem = ctx.remaining_accounts;
    require!(rem.len() % 2 == 0, DexxerError::InvalidInput);
    for pair in rem.chunks(2) {
        let (pos_ai, perm_ai) = (&pair[0], &pair[1]);
        require_keys_eq!(*pos_ai.owner, crate::ID, DexxerError::InvalidInput);
        let pos = Position::try_deserialize(&mut &pos_ai.try_borrow_data()?[..])?;
        require_keys_eq!(pos.owner, o, DexxerError::Unauthorized);
        let (expected, _) = Pubkey::find_program_address(&[PERMISSION_SEED, pos_ai.key.as_ref()], &PERMISSION_PROGRAM_ID);
        require_keys_eq!(*perm_ai.key, expected, DexxerError::InvalidInput);
        if perm_ai.owner != &PERMISSION_PROGRAM_ID {
            continue;
        }
        UpdateEphemeralPermissionCpi {
            payer: pos_ai.clone(),
            permissioned_account: pos_ai.clone(),
            permission: perm_ai.clone(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: pos_ai.clone(),
            authority_is_signer: false,
            args: EphemeralMembersArgs { is_private: true, members: members.clone() },
        }
        .invoke_signed(&[&[POSITION_SEED, o.as_ref(), pos.market.as_ref(), &[pos.bump]]])?;
    }
```

`lib.rs`: `set_session<'info>(ctx: Context<'info, SetSession<'info>>, …)`, плюс

```rust
    pub fn init_position_permission(ctx: Context<InitPositionPermission>) -> Result<()> {
        positions::init_position_permission(ctx)
    }
```

- [ ] **Step 4: GREEN**

Run: `cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml && cd tests/litesvm && cargo +nightly test -p dexxer_litesvm`
Expected: `markets` 14 PASS; `set_session`-тести в `user.rs` без регресій.

### Task 5: `undelegate_position` (ER) + `close_exited_position` (L1)

**Files:**
- Modify: `programs/dexxer_core/src/instructions/positions.rs`, `programs/dexxer_core/src/instructions/user.rs` (`close_permission_if_present` → `pub(crate)`), `programs/dexxer_core/src/lib.rs`
- Modify: `tests/litesvm/src/ixs.rs`, `tests/litesvm/tests/markets.rs`

**Interfaces:**
- Consumes: Task 2 (`user_has_left`), `user::close_permission_if_present`, `liquidation::cancel_liquidation_task`, `state::liq_task_id`.
- Produces: `undelegate_position()` (акаунти: `signer, config, position, user_account, position_permission, ephemeral_vault, permission_program, fee_escrow, magic_fee_vault, magic_context, magic_program`), `close_exited_position()` (акаунти: `fee_payer, config, position, user_account`); `ixs::undelegate_position(signer, &World, owner, &Mkt)`, `ixs::close_exited_position(fee_payer, &World, owner, &Mkt)`.

- [ ] **Step 1: падаючі тести**

```rust
#[test]
fn undelegate_position_owner_anytime_crank_only_after_exit_never_while_open() {
    let mut h = Harness::new();
    let (w, btc, a) = two_markets(&mut h);
    h.send(&[ixs::open_position_on(&a.kp.pubkey(), &a, &w, &btc, Side::Long, BTC_01, M80, B80K)], &[&a.kp]).unwrap();
    let r = h.send(&[ixs::undelegate_position(&a.kp.pubkey(), &w, &a.kp.pubkey(), &btc)], &[&a.kp]);
    assert_custom_error(&r, 6000 + DexxerError::HasOpenPosition as u32);

    let b = w.new_trader(&mut h, 0);
    let o = b.kp.pubkey();
    h.send(&[ixs::init_position(&o, &o, &btc)], &[&b.kp]).unwrap();
    let stranger = Keypair::new();
    let r = h.send(&[ixs::undelegate_position(&stranger.pubkey(), &w, &o, &btc)], &[&stranger]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    let r = h.send(&[ixs::undelegate_position(&w.crank.pubkey(), &w, &o, &btc)], &[&w.crank]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    h.send(&[ixs::undelegate_position(&o, &w, &o, &btc)], &[&b.kp]).unwrap();

    h.send(&[ixs::undelegate_user(&o, &b, &w)], &[&b.kp]).unwrap();
    h.send(&[ixs::undelegate_position(&w.crank.pubkey(), &w, &o, &btc)], &[&w.crank]).unwrap();
}

#[test]
fn close_exited_position_only_for_empty_positions_of_owners_who_left() {
    let mut h = Harness::new();
    let (w, btc, a) = two_markets(&mut h);
    // Active owner with an open BTC position: the Empty constraint fires first.
    h.send(&[ixs::open_position_on(&a.kp.pubkey(), &a, &w, &btc, Side::Long, BTC_01, M80, B80K)], &[&a.kp]).unwrap();
    let r = h.send(&[ixs::close_exited_position(&w.fee_payer.pubkey(), &w, &a.kp.pubkey(), &btc)], &[&w.fee_payer]);
    assert_custom_error(&r, 6000 + DexxerError::HasOpenPosition as u32);

    let b = w.new_trader(&mut h, 0);
    let o = b.kp.pubkey();
    h.send(&[ixs::init_position(&o, &o, &btc)], &[&b.kp]).unwrap();
    let r = h.send(&[ixs::close_exited_position(&w.fee_payer.pubkey(), &w, &o, &btc)], &[&w.fee_payer]);
    assert_custom_error(&r, 6000 + DexxerError::NotExited as u32);
    // A UserAccount still delegated on L1 (owned by the Delegation Program) is
    // an ACTIVE owner, not a departed one (Review Focus 4). LiteSVM has no
    // delegation program, so the ownership is set by hand.
    let mut ua = h.svm.get_account(&b.user).unwrap();
    let program_owner = ua.owner;
    ua.owner = ixs::dlp();
    h.svm.set_account(b.user, ua.clone()).unwrap();
    let r = h.send(&[ixs::close_exited_position(&w.fee_payer.pubkey(), &w, &o, &btc)], &[&w.fee_payer]);
    assert_custom_error(&r, 6000 + DexxerError::NotExited as u32);
    ua.owner = program_owner;
    h.svm.set_account(b.user, ua).unwrap();
    h.send(&[ixs::undelegate_user(&o, &b, &w)], &[&b.kp]).unwrap();
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(&[ixs::close_exited_position(&stranger.pubkey(), &w, &o, &btc)], &[&stranger]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    h.send(&[ixs::close_exited_position(&w.fee_payer.pubkey(), &w, &o, &btc)], &[&w.fee_payer]).unwrap();
    assert!(h.svm.get_account(&b.position_on(&btc)).map_or(true, |x| x.lamports == 0), "closed");

    // Owner fully gone (close_exited_user already reclaimed UserAccount/SOL/queue).
    let c = w.new_trader(&mut h, 0);
    let oc = c.kp.pubkey();
    h.send(&[ixs::init_position(&oc, &oc, &btc)], &[&c.kp]).unwrap();
    h.send(&[ixs::undelegate_user(&oc, &c, &w)], &[&c.kp]).unwrap();
    h.send(&[ixs::close_exited_user(&w.fee_payer.pubkey(), &c, &w)], &[&w.fee_payer]).unwrap();
    h.send(&[ixs::close_exited_position(&w.fee_payer.pubkey(), &w, &oc, &btc)], &[&w.fee_payer]).unwrap();
}
```

Білдери:

```rust
pub fn undelegate_position(signer: &Pubkey, wd: &World, owner: &Pubkey, m: &Mkt) -> Instruction {
    let pos = pdas::position(owner, &m.market);
    Instruction {
        program_id: prog(),
        accounts: vec![
            rs(signer),
            r(&wd.config),
            w(&pos),
            r(&pdas::user(owner)),
            w(&pdas::permission(&pos)),
            w(&pdas::ephemeral_vault()),
            r(&pdas::permission_program()),
            w(&wd.fee_escrow),
            w(&wd.magic_fee_vault),
            w(&pdas::magic_context()),
            r(&pdas::magic_program()),
        ],
        data: ix::UndelegatePosition {}.data(),
    }
}

pub fn close_exited_position(fee_payer: &Pubkey, wd: &World, owner: &Pubkey, m: &Mkt) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![s(fee_payer), r(&wd.config), w(&pdas::position(owner, &m.market)), r(&pdas::user(owner))],
        data: ix::CloseExitedPosition {}.data(),
    }
}
```

Run: `cd tests/litesvm && cargo +nightly test -p dexxer_litesvm --test markets` → Expected: FAIL (`ix::UndelegatePosition` не існує).

- [ ] **Step 2: програма.** У `user.rs`: `fn close_permission_if_present` → `pub(crate) fn close_permission_if_present`. У `positions.rs` (імпорти додати: `consts::MAGIC_CONTEXT_ID`, `ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder}`, `crate::instructions::{liquidation::cancel_liquidation_task, user::close_permission_if_present}`):

```rust
// ER: an extra position leaves the rollup on exit — the per-market twin of the
// position half of `undelegate_user`. `Position::Empty` is the privacy gate:
// `finalize_close` zeroes every trade field (trade.rs), so the committed bytes
// carry nothing. Owner-signed normally; the crank may do it only for an owner
// who has left (an exit the app did not finish).
#[derive(Accounts)]
pub struct UndelegatePosition<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POSITION_SEED, position.owner.as_ref(), position.market.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: the owner's `UserAccount` if it still exists — read by `user_has_left` on the crank path.
    #[account(seeds = [USER_SEED, position.owner.as_ref()], bump)]
    pub user_account: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `position`
    #[account(mut, seeds = [PERMISSION_SEED, position.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub position_permission: UncheckedAccount<'info>,
    /// CHECK: shared ER vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    #[account(mut, seeds = [FEE_ESCROW_SEED], bump = fee_escrow.bump)]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: validator-scoped Magic Program fee vault; constrained to Config.magic_fee_vault
    #[account(mut, constraint = magic_fee_vault.key() == config.magic_fee_vault @ DexxerError::Unauthorized)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    /// CHECK: ER `MagicContext`; only written when `magic_program` is executable
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: gates the CPIs via `.executable`
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

pub fn undelegate_position<'info>(ctx: Context<'info, UndelegatePosition<'info>>) -> Result<()> {
    let a = ctx.accounts;
    require!(a.position.state == PositionState::Empty, DexxerError::HasOpenPosition);
    let signer = a.signer.key();
    let authorized = signer == a.position.owner
        || (signer == a.config.crank && user_has_left(&a.user_account.to_account_info())?);
    require!(authorized, DexxerError::Unauthorized);

    let o = a.position.owner;
    let m = a.position.market;
    let pb = [a.position.bump];
    // Flush before any CPI can move the owner (ruling 10) — a no-op write, but
    // it keeps Anchor's automatic post-handler exit from ever changing bytes.
    a.position.exit(&crate::ID)?;
    close_permission_if_present(
        &a.position.to_account_info(),
        &a.position_permission.to_account_info(),
        &a.ephemeral_vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
        &[POSITION_SEED, o.as_ref(), m.as_ref(), &pb],
    )?;

    let a: &'info UndelegatePosition<'info> = a;
    // Absent on LiteSVM — skip, as `undelegate_user` does.
    if a.magic_program.to_account_info().executable {
        let escrow: &'info Account<'info, FeeEscrow> = &a.fee_escrow;
        let position: &'info Account<'info, Position> = &a.position;
        // An Empty position's task was normally cancelled at close; cancelling
        // an unknown task id is a measured no-op (week 5).
        cancel_liquidation_task(
            escrow.as_ref(),
            position.as_ref(),
            &a.magic_program,
            liq_task_id(&position.key()),
            a.fee_escrow.bump,
        )?;
        let bump = a.fee_escrow.bump;
        let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &[bump]];
        MagicIntentBundleBuilder::new(
            a.fee_escrow.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .magic_fee_vault(a.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[a.position.to_account_info()])
        .build_and_invoke_signed(&[seeds])?;
    }
    Ok(())
}

// L1: reclaim an extra position's rent once it is back under this program,
// Empty, and its owner has left — the per-market twin of `close_exited_user`
// (same typed-`Account` gate: it cannot touch a still-delegated position).
#[derive(Accounts)]
pub struct CloseExitedPosition<'info> {
    #[account(mut, constraint = fee_payer.key() == config.fee_payer @ DexxerError::Unauthorized)]
    pub fee_payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, close = fee_payer,
        seeds = [POSITION_SEED, position.owner.as_ref(), position.market.as_ref()], bump = position.bump,
        constraint = position.state == PositionState::Empty @ DexxerError::HasOpenPosition)]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: the owner's `UserAccount` if any — `user_has_left` must hold (a still-delegated account means an active owner).
    #[account(seeds = [USER_SEED, position.owner.as_ref()], bump)]
    pub user_account: UncheckedAccount<'info>,
}

pub fn close_exited_position(ctx: Context<CloseExitedPosition>) -> Result<()> {
    require!(user_has_left(&ctx.accounts.user_account.to_account_info())?, DexxerError::NotExited);
    Ok(())
}
```

`lib.rs`:

```rust
    pub fn undelegate_position<'info>(ctx: Context<'info, UndelegatePosition<'info>>) -> Result<()> {
        positions::undelegate_position(ctx)
    }
    pub fn close_exited_position(ctx: Context<CloseExitedPosition>) -> Result<()> {
        positions::close_exited_position(ctx)
    }
```

- [ ] **Step 3: GREEN**

Run: `cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml && cd tests/litesvm && cargo +nightly test -p dexxer_litesvm`
Expected: `markets` 16 PASS; решта без регресій.

### Task 6: якість, IDL, виміри, документи

**Files:**
- Modify: `app/src/idl/dexxer_core.json` (регенерований IDL)
- Modify: `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` (§2.8 «Реалізовано (програма)»), `CLAUDE.md` (лічильники тестів, правило)

- [ ] **Step 1: якість.** `cargo fmt --all -- --check && cargo clippy -p dexxer_core --lib -- -D warnings` → Expected: без попереджень (виправити, якщо є).
- [ ] **Step 2: повні набори.** `cargo test -p dexxer_core` (unit: 61 + 3) і `cd tests/litesvm && cargo +nightly test -p dexxer_litesvm` (89 + 16) → Expected: усе PASS; числа — у ledger.
- [ ] **Step 3: виміри.** Із `-- --nocapture`: рента `init_position` (Task 2), CU кожної нової інструкції з `TransactionMetadata.compute_units_consumed` (додати `println!("MEASURE cu <name> {}", r.compute_units_consumed)` у відповідні тести), розмір серіалізованої tx `[init_position, delegate_position]` для одного ринку (`bincode`-довжина через `Transaction::new(...)`, або підрахунок `Message::serialize().len() + 64 * signers`). Числа — у spec §2.8 «Реалізовано».
- [ ] **Step 4: IDL.** Спершу перевірити, чи `anchor-1.0.2 idl build` застосовує `[toolchain] solana_version` (читання джерел `anchor-cli` 1.0.2 у `~/.cargo/registry/src/*/anchor-cli-1.0.2` або репо AVM; якщо перемикає глобальну Solana — НЕ запускати). Безпечний шлях: `cargo test -p dexxer_core --features idl-build __anchor_private_print_idl -- --show-output --quiet` і витягти JSON програми з виводу; **валідувати метод** на `main` (тимчасовий `git worktree` у scratchpad: той самий метод на коді `main` мусить відтворити закомічений `app/src/idl/dexxer_core.json` до байта/семантично). Потім згенерувати для цієї гілки й записати в `app/src/idl/dexxer_core.json`. Перевірка: нові інструкції (`initPosition`, `delegatePosition`, `initPositionPermission`, `undelegatePosition`, `closeExitedPosition`) і `symbol` в `initMarket`/`delegateMarket` присутні; `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../app/src/idl npm test` — без регресій (whitelist `/sponsor` читає IDL).
- [ ] **Step 5: документи.** Spec §2.8 — абзац «**Реалізовано (програма, 28.09)**»: інструкції, тести (числа), виміри, рулінги. CLAUDE.md — лічильники LiteSVM/unit і правило «Правила тижня 6: мульти-маркет (програма)» (символ, `init_position`… , `set_session` з парами, гейт виходу за маржею, `user_has_left` консервативний).
