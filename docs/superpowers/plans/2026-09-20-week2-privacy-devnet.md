# Dexxer — тиждень 2: приватність, devnet-tee, мобільний скелет. План імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ядро тижня 1 стає приватним і живе на справжньому TEE: permission з членами `[owner, session, crank]`, deploy на devnet + `devnet-tee.magicblock.app`, `commit_aggregate` через fee-vault, `withdraw`, crank на devnet, витік-тест рівня 4 і мобільний скелет Connect → Onboard → Trade → Position. П'ятниця: open з емулятора без промпту гаманця; чужий ключ не бачить позицію; Solscan мовчить.

**Architecture:** Той самий `dexxer_core`; зміни лише в permission-шарі (`init_permissions` стає приватним, `set_session` перебудовує членів), у комітах (`commit_aggregate` через делегований fee payer + `magic_fee_vault`, бо plain-коміти обмежені 10 на акаунт), у `withdraw` (ER-нога: облік + SPL-переказ pool → user; L1-нога: eSPL `undelegateIx` + `withdrawSpl` на клієнті) і в кранку (планувальник ролапу тікає EMA без кандидатів; ліквідації шукає зовнішній crank-скрипт як **член permission**). Мобільний клієнт повторює `tests/er/lib/trader.ts` через MWA + `expo-secure-store` для session key.

**Tech Stack:** як у тижні 1 (Anchor 1.0.2, `ephemeral-rollups-sdk =0.16.2` `anchor`+`access-control`, TS SDK 0.17.0, web3.js v1, Node 24.18.0), плюс `magicblock-magic-program-api =0.10.1` (є), Expo 57 + `@wallet-ui/react-native-web3js` (є в `app/`), `expo-secure-store` (є).

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.1–2.3, §4.2, §5, §6.4, §7.1, §7.3 (тиждень 2). Результати тижня 1: `docs/superpowers/plans/week1-results.md`. Дослідження для цього плану: skill `magicblock` (`references/cranks.md`, `fees-and-commit-economics.md`, `ephemeral-spl-token.md`, `security.md`), `docs.magicblock.gg` (access-control, quickstart PER, fees-and-commit-economics), `spikes/07-session-payer/RESULT.md`.

## Global Constraints

- Усе з Global Constraints плану тижня 1 лишається: `checked_*` у програмі, коментарі в коді англійською, `init_if_needed` заборонений, `program_autofixer` на кожен змінений файл програми, LiteSVM лише `cargo +nightly-2026-09-18 test -p dexxer_litesvm`, mb-stack 0.13.7, `anchor build` перед LiteSVM.
- **Кожна ER-інструкція перевіряє підписанта в коді** (spec A3). Permission гейтить лише читання.
- Devnet-адреси: base `https://rpc.magicblock.app/devnet`, router `https://devnet-router.magicblock.app/`, TEE `https://devnet-tee.magicblock.app` (ws `wss://…`), TEE validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, oracle program `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`, feed SOL/USD `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` (seeds `["price_feed","pyth-lazer","6"]`). TEE-читання потребують `?token=` від `getAuthToken` (підпис повідомлення ключем).
- Program ids: `dexxer_core = G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`, `mock_oracle = 68xBWNR1uKorC7keLWvsT1pCmKC4RnwvRF4LoV3CCprh` (на devnet НЕ деплоїться). Keypair-и програм після Task 0 лежать у `keys/programs/` (gitignored).
- **Коміти:** без fee-vault ролап відхиляє 11-й plain-коміт акаунта (`0xA0000000`); з делегованим payer + validator-scoped `magic_fee_vault` кожен коміт після 25-го коштує `100_000` lamports за акаунт. Тому `commit_aggregate` завжди йде fee-vault-шляхом і комітить **лише `Pool`** (та `Market` при `set_params`); `UserAccount` комітиться лише в `withdraw` — це прибирає й витік `locked_margin` (spec §2.3, останній абзац).
- Devnet-фід віддає `conf == 0` → ринок на devnet ініціалізується з `max_conf_bps = 0` (ризик №11).
- Людські кроки (не автоматизуються): переказ SOL на payer, бекап keypair-ів, домен `dexxer.xyz`, правила Colosseum.

---

## Структура файлів

```
programs/dexxer_core/src/
  state/config.rs            + scheduler_signer: Pubkey, fee_payer: Pubkey, crank_task_id: i64
  state/permissions.rs       NEW: member flag consts, build_members(owner, session, crank)
  instructions/user.rs       init_permissions → private + members; set_session → UpdateEphemeralPermissionCpi ×3; withdraw
  instructions/crank.rs      crank_tick signer += Config.scheduler_signer; schedule_crank / cancel_crank
  instructions/commit.rs     NEW: commit_aggregate (#[commit], fee-vault path), commit_market
  instructions/mod.rs, lib.rs
tests/litesvm/tests/withdraw.rs      NEW
tests/er/lib/env.ts                  + devnet/TEE profile, getAuthToken per key, router status
tests/er/lib/admin.ts                + bootstrapDevnet (без mock_oracle)
tests/er/devnet/00-measure.ts        NEW: вимірювання (signer scheduler-а, gPA/WS для членів, ліміт комітів, top-up)
tests/er/devnet/01-onboard-private.ts NEW
tests/er/devnet/02-leak-test.ts      NEW (spec §6.4, рівень 4)
tests/er/devnet/03-commit-cycle.ts   NEW (>10 комітів через fee-vault)
tests/er/devnet/04-withdraw.ts       NEW
scripts/crank-fallback/index.ts      + devnet-профіль, crank як член, джерело кандидатів
scripts/admin/devnet-bootstrap.ts    NEW
scripts/admin/fund-fee-payer.ts      NEW (lamportsDelegatedTransferIx)
keys/programs/                       gitignored: dexxer_core-keypair.json (+ README про бекап)
app/src/lib/{er.ts,session.ts,program.ts,pdas.ts}   NEW
app/src/features/onboard/OnboardScreen.tsx           NEW
app/src/features/trade/{TradeScreen,PositionScreen}.tsx NEW
app/app/(tabs)/{onboard,trade,position}.tsx           NEW
docs/superpowers/plans/week2-results.md              NEW
```

**Рішення тижня 2 (фіксуються в spec у Task 9 маркером `(week 2, дата)`):**

1. **Члени permission:** `owner` з `AUTHORITY_FLAG | TX_LOGS | TX_BALANCES | TX_MESSAGE | ACCOUNT_SIGNATURES`, `session_key` з `TX_LOGS | TX_MESSAGE | TX_BALANCES`, `Config.crank` з тими самими TX-прапорцями. Authority permission — сам PDA (підписує seeds), тому `set_session` може перебудувати список без окремого підпису.
2. **Кандидати ліквідації на devnet:** зовнішній `crank-fallback` (ключ `Config.crank`, член permission кожного юзера). Джерело кандидатів визначає Task 1: якщо `getProgramAccounts` з crank-токеном повертає приватні позиції — використовуємо його; якщо ні — програма веде реєстр `MarketRisk.traders: [Pubkey; 32]` (додається в `init_permissions`, ніколи не комітиться). Планувальник ролапу тікає **без кандидатів** (тільки оракул + EMA), тому `Market.mark` свіжий навіть коли скрипт лежить.
3. **Scheduler signer:** `crank_tick` приймає `Config.crank`, константу `CRANK_SIGNER` **і** `Config.scheduler_signer` (записує `schedule_crank` після Task 1, бо документація описує per-authority `crank_signer_pda(task_authority)`, а SDK 0.10.1 експортує глобальну константу — виміряти, не вгадувати).
4. **Fee payer:** окремий keypair `fee-payer` (не crank), делегований і поповнюваний `lamportsDelegatedTransferIx`; `Config.fee_payer` зберігає його pubkey; `commit_aggregate` приймає лише його як `payer`.
5. **`withdraw`:** ER-нога в програмі (`free_margin −= amount`, `capital_total −= amount`, SPL pool ATA → user ATA підписом pool PDA, потім `MagicIntentBundleBuilder.commit(&[user_account])`); L1-нога на клієнті — eSPL `undelegateIx` → дочекатися base-коміту → `withdrawSpl(…, { idempotent: false })`.
6. **`mark_committed` лишається на тижні 3**, тому одна позиція на юзера за прогін; демо-скрипти онбордять свіжі ключі.
7. **mock_oracle на devnet не деплоїться**; ціни рухає реальний фід, тести ліквідації на devnet чекають реального руху або використовують `set_params` з MMR, що робить позицію ліквідовною одразу (тільки для тест-ринку).

---

### Task 0: Ключі, devnet-профіль, bootstrap на devnet

**Files:**
- Create: `keys/README.md`, `.gitignore` (+`keys/`), `scripts/admin/devnet-bootstrap.ts`, `scripts/admin/fund-fee-payer.ts`
- Modify: `Anchor.toml` (`[programs.devnet]`, `[provider] cluster = "devnet"` лишити localnet, передавати прапорцем), `tests/er/lib/env.ts` (профіль `DEXXER_NET=local|devnet`: BASE/ER/ROUTER/VALIDATOR/ORACLE; `teeConn(keypair)` з `getAuthToken`; `routerStatus`), `tests/er/lib/admin.ts` (`bootstrapDevnet`: `init_config(oracle=PriCems…, tee_validator=MTEWG…, crank, fee_payer)`, `init_market` з `max_conf_bps: 0`, `init_pool`, faucet+`seed_pool` 10 000, `delegate_market`, `delegate_pool` через `delegateSpl(admin, mint, 0, {initVaultIfMissing:true, validator})`)

**Interfaces:**
- Produces: `env.ts` → `NET`, `baseConn`, `erConn(token?)`, `teeConn(kp: Keypair): Promise<Connection>` (з ws `?token=`), `ROUTER`, `routerStatus(pubkey)`, `waitDelegated`; `admin.ts` → `bootstrapDevnet(): Promise<Bootstrapped>` з тими самими полями, що `bootstrap()`, плюс `feePayer: Keypair`.

- [ ] **Step 1: Keypair-и програм у `keys/programs/`**

```bash
mkdir -p keys/programs && cp target/deploy/dexxer_core-keypair.json keys/programs/ && cp target/deploy/mock_oracle-keypair.json keys/programs/
printf 'keys/\n' >> .gitignore
cat > keys/README.md <<'EOF'
# keys/ (gitignored)
programs/dexxer_core-keypair.json — upgrade authority + program id G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV.
Втрата файлу = втрата можливості оновлювати програму. Бекап у менеджері паролів — людський крок (Task 0).
Відновлення в target/deploy: cp keys/programs/*.json target/deploy/
EOF
solana-keygen pubkey keys/programs/dexxer_core-keypair.json   # має дати G2okX5…
```
Записати в `Anchor.toml`: `[programs.devnet] dexxer_core = "G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV"`.

- [ ] **Step 2: Гроші (людський крок)**

Deploy `dexxer_core` (~1.7 SOL) + bootstrap + два fee payer-и. Payer спайків `4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM` має 2.18 SOL. Попросити користувача: `solana transfer 4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM 4 -u devnet --allow-unfunded-recipient`. Зупинитися, поки баланс < 5 SOL.

- [ ] **Step 3: Deploy**

```bash
anchor build && anchor deploy --provider.cluster devnet --provider.wallet spikes/keys/payer.json --program-name dexxer_core 2>&1 | tail -3
solana program show G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV -u devnet | head -5
```

- [ ] **Step 4: env-профіль і bootstrap**

`env.ts`: `const NET = process.env.DEXXER_NET ?? "local"`; таблиця профілів (`local` = поточні значення; `devnet` = адреси з Global Constraints). `teeConn(kp)`:
```ts
export async function teeConn(kp: Keypair): Promise<Connection> {
  if (NET === "local") return erConn;
  const auth = await getAuthToken(ER, kp.publicKey, async (m) => nacl.sign.detached(m, kp.secretKey));
  return new Connection(`${ER}?token=${auth.token}`, { wsEndpoint: `${ER_WS}?token=${auth.token}`, commitment: "confirmed" });
}
```
`scripts/admin/devnet-bootstrap.ts` = `DEXXER_NET=devnet` + `bootstrapDevnet()`; ключі `admin`, `crank`, `fee-payer` у `tests/er/.keys/devnet-*.json`. `scripts/admin/fund-fee-payer.ts`: `lamportsDelegatedTransferIx(admin → feePayer, 0.2 SOL, validator)` на base, потім читання балансу fee payer через `teeConn(feePayer)` (очікувано ≥ 0.2 SOL у ролапі).

- [ ] **Step 5: Запуск і фіксація**

```bash
cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/devnet-bootstrap.ts 2>&1 | tail -30
DEXXER_NET=devnet npx tsx ../../scripts/admin/fund-fee-payer.ts 2>&1 | tail -5
```
Expected: усі підписи в логу; `routerStatus(market/pool/risk).isDelegated == true` з `fqdn` = devnet-tee; `Pool.capital_total == 10_000e6` через `teeConn(admin)`. Записати підписи, адреси PDA, mint у `docs/superpowers/plans/week2-results.md` §Task 0.

- [ ] **Step 6: Commit** `chore(devnet): program keys dir, devnet profile, bootstrap and fee-payer funding scripts`

---

### Task 1: Вимірювання на devnet-tee (закриває невідомі тижня 2 до коду)

**Files:**
- Create: `tests/er/devnet/00-measure.ts`, розділ «Task 1» у `week2-results.md`

**Що виміряти (кожен пункт — окрема функція зі своїм `PASS/FAIL` рядком):**

- [ ] **M1 — хто підписує тік планувальника.** Task 4 залежить від відповіді, тому міряємо без продуктового коду: `spikes/05-crank-tee` вже містить `schedule_increment`; задеплоїти його на devnet (1.6 SOL; ключ закритої програми втрачено → новий id, `anchor keys sync` у папці спайку), запланувати 3 тіки і прочитати `getTransaction(sig)` кожного тіка **через токен payer-а** (`accountKeys` + `header.numRequiredSignatures`). Зафіксувати: список підписантів, чи це `CRANK_SIGNER` (`magicblock_magic_program_api::pda::CRANK_SIGNER` = PDA `["crank-executor"]` під `CRANK_PROGRAM_ID`) чи per-authority PDA. Після вимірювання закрити програму спайку (`solana program close … --bypass-warning`) і повернути SOL.
- [ ] **M2 — видимість приватного акаунта для членів.** На `spikes/01-private-counter-tee` (вже на devnet, id `2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7`): `set_privacy(true)` з членами `[user, crank]` (оновити спайк-скрипт: `Member{pubkey: crank, flags: TX_*}`), потім з токенами **owner**, **crank**, **stranger**: `getAccountInfo`, `getProgramAccounts(program, {filters:[discriminator]})`, `onAccountChange` (60 с, зміна через `increment`). Таблиця 3×3.
- [ ] **M3 — ліміт plain-комітів і fee-vault.** На тому ж лічильнику: 11 × `commit` без fee-vault → очікувано 11-й падає з `0xA0000000`; потім знайти validator-scoped `magic_fee_vault` (SDK: `ephemeral_rollups_sdk::pda::magic_fee_vault_pda(validator)` або TS `magicFeeVaultPda`; якщо в SDK 0.16.2/0.17.0 хелпера нема — вивести адресу з логів валідатора/доків і записати), делегувати payer (`lamportsDelegatedTransferIx`), зробити 30 комітів через bundle з payer + vault; зафіксувати баланс payer до/після (очікувано −100_000 × 5 за коміти 26–30).
- [ ] **M4 — `undelegateIx` + `withdrawSpl` для eSPL** на mint спайку 02 (`44FTm7…`): депозит 10 → `undelegateIx` → дочекатися base-коміту (poll base ATA/eATA owner) → `withdrawSpl(owner, mint, 10n, {idempotent:false})`; зафіксувати час і підписи.

- [ ] **Step: Записати «Рішення після M1–M4»** у `week2-results.md`: (a) значення для `Config.scheduler_signer`; (b) джерело кандидатів (gPA vs реєстр `MarketRisk.traders`); (c) адреса `magic_fee_vault` devnet-tee і вартість 5-хв комітів `Pool` на добу; (d) послідовність withdraw для клієнта. Ці чотири рядки — вхід для Task 2–6.

- [ ] **Commit** `test(devnet): measurements M1–M4 for scheduler signer, member visibility, commit limits, espl withdraw`

---

### Task 2: Приватні permission і члени (`init_permissions`, `set_session`)

**Files:**
- Create: `programs/dexxer_core/src/state/permissions.rs`
- Modify: `state/config.rs` (+`scheduler_signer: Pubkey`, `fee_payer: Pubkey`, `crank_task_id: i64`; `init_config` приймає `fee_payer`), `state/market_risk.rs` (+`traders: [Pubkey; 32]`, `traders_len: u8` — лише якщо M2 показав, що gPA не працює для членів; інакше не додавати), `instructions/user.rs`, `instructions/admin.rs` (`init_config`), `tests/litesvm/src/{ixs,setup}.rs`, `tests/litesvm/tests/user.rs`

**Interfaces:**
- Produces: `permissions::{OWNER_FLAGS, VIEWER_FLAGS, build_members(owner, session, crank) -> Vec<Member>}` (session пропускається, якщо `Pubkey::default()`); `init_permissions` створює **або оновлює** permission кожного з трьох PDA: `EphemeralMembersArgs { is_private: true, members: build_members(..) }`; `set_session(session_key, expiry, actions)` після запису полів робить `UpdateEphemeralPermissionCpi` ×3 з `authority = PDA`, `authority_is_signer: false`, `invoke_signed` seeds PDA; новий контекст `SetSession` отримує ті самі permission/vault/magic/permission_program акаунти, що `InitPermissions`.

- [ ] **Step 1: Тести (червоні).** Permission-CPI на LiteSVM неможливий, тому: (a) unit-тести `permissions::build_members` (owner завжди перший з `AUTHORITY_FLAG`; без session → 2 члени; з session → 3; crank == `Config.crank`); (b) `set_session` робить CPI оновлення **умовно**: якщо `user_permission.owner != PERMISSION_PROGRAM_ID` (permission ще не створено — так на LiteSVM і на L1), CPI пропускається. LiteSVM-тести `user.rs::set_session_only_by_owner` і `trade.rs::session_key_can_trade…` передають permission-акаунти як порожні PDA і лишаються зеленими без змін очікувань.
- [ ] **Step 2: Реалізація** (див. `spikes/01-private-counter-tee/.../lib.rs::set_privacy` для `UpdateEphemeralPermissionCpi`):
```rust
// state/permissions.rs
use ephemeral_rollups_sdk::access_control::structs::{Member, AUTHORITY_FLAG, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG, ACCOUNT_SIGNATURES_FLAG};
pub const OWNER_FLAGS: u8 = AUTHORITY_FLAG | TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG | ACCOUNT_SIGNATURES_FLAG;
pub const VIEWER_FLAGS: u8 = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG;
pub fn build_members(owner: Pubkey, session: Pubkey, crank: Pubkey) -> Vec<Member> {
    let mut m = vec![Member { flags: OWNER_FLAGS, pubkey: owner }];
    if session != Pubkey::default() { m.push(Member { flags: VIEWER_FLAGS, pubkey: session }); }
    m.push(Member { flags: VIEWER_FLAGS, pubkey: crank });
    m
}
```
`Member.pubkey` — тип SDK `compat::Pubkey`; конвертувати `new_from_array(x.to_bytes())` як у `admin.rs::espl`. У `init_permissions`: якщо `perm.owner == PERMISSION_PROGRAM_ID` → `UpdateEphemeralPermissionCpi`, інакше `CreateEphemeralPermissionCpi`; обидва з `is_private: true`. `set_session`: після оновлення полів — та сама гілка оновлення для трьох PDA, пропуск якщо permission відсутній.
- [ ] **Step 3:** `anchor build`, autofixer, LiteSVM 32 зелених, `cargo test -p dexxer_core` (+3 unit).
- [ ] **Commit** `feat(core): private permissions with owner/session/crank members; set_session rebuilds members`

---

### Task 3: `withdraw` (ER-нога) + LiteSVM

**Files:**
- Modify: `instructions/user.rs` (+`Withdraw` context, `withdraw(amount)`), `lib.rs`, `token.rs` (є `transfer_signed_by_pool`), `tests/litesvm/src/ixs.rs`; Create: `tests/litesvm/tests/withdraw.rs`

**Interfaces:**
- `withdraw(amount)`: signer = owner (не session — гроші виходять); `require!(amount > 0)`, `free_margin ≥ amount`; `free_margin −= amount`; `pool.capital_total −= amount`; SPL transfer `vault_ata → owner_ata` з підписом pool PDA; потім (тільки в ER) `MagicIntentBundleBuilder::new(payer=owner, magic_context, magic_program).commit(&[user_account])` — контекст `#[commit]`. На LiteSVM `magic_program` відсутній → коміт-CPI виконувати лише якщо `magic_program.executable` (перевірка `to_account_info().executable`); тест підтверджує облік і токени.
- Тести: `withdraw_moves_tokens_and_debits_free_margin` (invariant тримається: capital_total і vault balance зменшились однаково), `withdraw_more_than_free_rejected` (`InsufficientMargin`), `withdraw_by_session_rejected` (`Unauthorized`), `withdraw_zero_rejected`.

- [ ] Steps: тести → реалізація → `anchor build` + LiteSVM (36) → autofixer → **Commit** `feat(core): withdraw — ER accounting leg with pool-signed SPL transfer and UserAccount commit`

---

### Task 4: Планувальник і `commit_aggregate`

**Files:**
- Create: `programs/dexxer_core/src/instructions/commit.rs`
- Modify: `instructions/crank.rs` (`schedule_crank`, `cancel_crank`, signer set), `state/config.rs` (вже з Task 2), `lib.rs`, `mod.rs`

**Interfaces:**
- `schedule_crank(task_id: i64, interval_ms: i64, iterations: i64)` (ER, admin): будує `Instruction` на `crank_tick` з акаунтами `[crank=Config.scheduler_signer (readonly, signer), config, market(w), market_risk(w), pool(w), feed]` і **без** remaining_accounts; `ScheduleCrankCpi { payer: admin, magic_program, instruction_accounts, args: ScheduleTaskArgs {..} }`; записує `Config.crank_task_id`. `cancel_crank()` (ER, admin): `CancelCrankCpi { authority: admin, task_context, magic_program, crank_id }`. Значення `scheduler_signer` — з M1: якщо глобальна константа, `init_config` пише `CRANK_SIGNER`; якщо per-authority PDA — `schedule_crank` обчислює `crank_signer_pda(admin)` за формулою з M1 і записує.
- `crank_tick` signer-constraint: `crank.key() == config.crank || crank.key() == config.scheduler_signer || bytes == CRANK_SIGNER`.
- `commit_aggregate()` (ER, signer = `Config.fee_payer`): `#[commit]` контекст з `payer` (= fee_payer, `constraint = payer.key() == config.fee_payer`), `pool`, `magic_fee_vault` (`/// CHECK: address = validator-scoped vault з M3`, писати в `Config.magic_fee_vault`, встановлюється в `init_config` або `set_fee_vault` admin-ix), `magic_context`, `magic_program`; `MagicIntentBundleBuilder::new(payer, magic_context, magic_program).commit(&[pool]).build_and_invoke()`; `pool.last_commit_slot = clock.slot`. Fee-vault акаунти додаються так, як показує M3 (перевірити сигнатуру builder-а в SDK 0.16.2: `ephem/` модуль — чи є `.with_fee_vault(..)`/окремий акаунт у контексті; якщо builder не приймає vault явно, шлях активується наявністю делегованого payer + vault у списку акаунтів транзакції — зафіксувати, що спрацювало).
- `commit_market()` (ER, admin) — той самий шаблон для `Market` після `set_params`.

- [ ] Steps: реалізація → `anchor build` + autofixer → LiteSVM без регресій (ці ixs на LiteSVM не тестуються) → **Commit** `feat(core): schedule/cancel crank, commit_aggregate via delegated fee payer and magic_fee_vault`

---

### Task 5: Devnet-tee інтеграція: приватний онбординг, витік-тест рівня 4, цикл комітів, withdraw

**Files:**
- Create: `tests/er/devnet/01-onboard-private.ts`, `02-leak-test.ts`, `03-commit-cycle.ts`, `04-withdraw.ts`; Modify: `tests/er/lib/trader.ts` (`DEXXER_NET`-aware: `teeConn(kp)` для ER-транзакцій, MWA-незалежно), `tests/er/package.json` (скрипти `devnet:onboard|leak|commit|withdraw`)

- [ ] **01-onboard-private:** новий трейдер → faucet → `init_user` → `delegateSpl` → `delegate_user` → `credit_deposit` (ER, owner-token) → `init_permissions` (private, члени) → `set_session(session, +1h, 20)` → `open_position` **сесійним ключем** (tx підписує тільки session; fee payer = session, як у spike 07 — session потребує lamports у ролапі: `lamportsDelegatedTransferIx(owner → session, 0.01 SOL)` на base перед цим). Assert: `Position.state == Open` через owner-token.
- [ ] **02-leak-test (spec §6.4):** після 01: (a) `getAccountInfo(position)` через base RPC → owner == `DELeGG…`, дані == байти на момент делегації (порівняти зі знімком, зробленим у 01 до `delegate_user`); (b) TEE без токена → HTTP 401/помилка; (c) stranger-token → `null`; (d) session-token → позиція видима (член); (e) crank-token → видима; (f) owner-token → видима, `state == Open`. Друк таблиці, `LEAK TEST PASS` тільки якщо всі шість.
- [ ] **03-commit-cycle:** `commit_aggregate` ×12 з інтервалом ≥ 5 с підписом fee payer через `teeConn(feePayer)`; читати `Pool` на **base** після кожного (poll до появи `last_commit_slot`); assert 12-й пройшов (fee-vault шлях), баланс fee payer у ролапі зменшився не більше ніж на очікуване; `Position`/`UserAccount` на base **не змінилися**.
- [ ] **04-withdraw:** `withdraw(300e6)` owner-token → assert ER `free_margin`, потім L1-нога за M4 → base ATA юзера +300e6; `UserAccount` на base оновився (коміт із `withdraw`).
- [ ] Запуск усіх чотирьох, підписи в `week2-results.md`. **Commit** `test(devnet): private onboarding, level-4 leak test, fee-vault commit cycle, withdraw round-trip`

---

### Task 6: Crank на devnet

**Files:**
- Modify: `scripts/crank-fallback/index.ts` (профіль `DEXXER_NET=devnet`: `teeConn(crank)`; джерело кандидатів за M2 — gPA з crank-токеном **або** `MarketRisk.traders` → PDA; `feed` з `Market.feed`, не з env; повторне підключення при 401/timeouts), `scripts/admin/devnet-bootstrap.ts` (+`schedule_crank(task_id = hash(program id)[..8] as i64, 1000 ms, iterations = 86_400)`)

- [ ] Перевірка: 10 хв роботи скрипта проти devnet-tee: тіки з кандидатами проходять, `Market.mark` оновлюється і скриптом, і планувальником (порівняти `mark_slot` без скрипта); ліквідація тестової позиції: відкрити лонг 10x і `set_params(mmr_bps: 9_500)` на тест-ринку → ліквідація за ≤ 3 тіки → повернути параметри. Зафіксувати CU і час тіка на TEE.
- [ ] **Commit** `feat(scripts): crank fallback on devnet-tee as permission member; scheduler EMA ticks`

---

### Task 7: Мобільний скелет — з'єднання, сесія, онбординг

**Files:**
- Create: `app/src/lib/er.ts` (`useTeeConnection(owner)`: `getAuthToken` через MWA `signMessages` + `pickSignature` з `app/src/spikes/mwa.ts`; кеш токена в пам'яті), `app/src/lib/session.ts` (генерація `Keypair`, `expo-secure-store` `dexxer.session.<owner>`, `getAuthToken` для сесії, top-up через `lamportsDelegatedTransferIx`), `app/src/lib/program.ts` (IDL з `target/idl/dexxer_core.json` скопійований у `app/src/idl/`, `Program` на ER/base з'єднаннях), `app/src/lib/pdas.ts` (ті самі seeds, що `tests/er/lib/program.ts`), `app/src/features/onboard/OnboardScreen.tsx`, `app/app/(tabs)/onboard.tsx`
- Modify: `app/app/(tabs)/_layout.tsx` (вкладки Onboard/Trade/Position; `spikes` лишити)

**Interfaces:**
- Produces: `useOnboarding()` — стани `NotOnboarded → Funded → Initialized → Delegated → Credited → Permissioned → SessionSet` з кроками, що повторюють `trader.ts::onboardTrader` через MWA: L1-кроки `signAndSendTransaction` (faucet_init, init_user, delegateSpl, delegate_user), ER-кроки `signTransactions` + `sendRawTransaction` на TEE (credit_deposit, init_permissions, set_session). Кожен крок ідемпотентний за станом on-chain (перевірка перед виконанням), щоб повторний тап продовжував з місця обриву. Прогрес і підписи на екрані.

- [ ] Перевірка на емуляторі з fakewallet (як у тижні 0): повний онбординг новим гаманцем; `Position` видима через owner-token; коміт `feat(app): TEE connection, session key store, onboarding flow`

---

### Task 8: Мобільний скелет — Trade і Position

**Files:**
- Create: `app/src/features/trade/TradeScreen.tsx` (форма side/size/margin, limit = index ± 1 %, кнопка Open/Close; транзакції підписує **session key** локально — без MWA-промпту; fee payer = session), `app/src/features/trade/PositionScreen.tsx` (`onAccountChange(position)` через ws з session-токеном + fallback poll 1 с; показує state/side/size/entry/mark/liq/uPnL/free_margin; `Market.mark` через `onAccountChange(market)`), `app/app/(tabs)/{trade,position}.tsx`
- Modify: `app/src/lib/program.ts` (хелпери `openPosition`, `closePosition`, `readPosition`, `readMarket`)

- [ ] Перевірка (п'ятниця): з емулятора: Open → без промпту гаманця → Position оновилась ≤ 2 с; Close → те саме; у Solana Explorer (`?cluster=custom&customUrl=devnet-tee` без токена) — відмова; Solscan devnet: `Position` PDA owner `DELeGG…`, байти незмінні. Скріншоти в `week2-results.md`. Коміт `feat(app): trade and position screens over session key`

---

### Task 9: Документи, spec, CLAUDE.md, PR

- [ ] Spec: §2.1 (`UserAccount` коміт лише при `withdraw` — витік `locked_margin` прибрано), §2.2 (`withdraw`, `commit_aggregate` fee-vault, `schedule_crank`), §3.5 (планувальник без кандидатів + crank-член), §4.1 (`Config.scheduler_signer/fee_payer/magic_fee_vault/crank_task_id`, `MarketRisk.traders` якщо додано), §4.2 (нові інструкції), §5.3/§5.4 (сесія в `expo-secure-store`, top-up сесії), §7.1 (ризик №3 частково закрито; новий ризик: вартість комітів; №4 — мітигація «uniform tx shape» ще не зроблена), §8 (нові питання: скільки коштує коміт на добу; `getProgramAccounts` для членів — відповідь M2). `week2-results.md` повний. CLAUDE.md: devnet-профіль, правило «`UserAccount` не комітиться крім withdraw», crank як член, keys/. `docs/superpowers/plans/week0-gate.md`: нагадування про правила Colosseum 26–27.09.
- [ ] Верифікація: fmt, clippy (stable), `anchor build`, core+mock tests, LiteSVM (≥36), `tsc` для `app`/`tests/er`/`scripts`. PR у `main`.

---

## Не в цьому плані (тиждень 3+)

`mark_committed`, `DisclosureQueue` логіка, `write_commitment`/`write_disclosure` (`#[action]` + escrow), `reveal`, History, push-нотифікації, TEE-атестація в застосунку, `undelegate_user`, CI, uniform tx shape / cover traffic (ризик №4), Railway для crank-скрипта.
