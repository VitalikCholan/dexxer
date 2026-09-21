# Dexxer

Приватний perpetual DEX для Solana Seeker. Позиція видима лише власнику.

## Архітектура (рішення прийняті 18.09.2026, не переглядати без причини)
- Опція A: власне перп-ядро на шаблоні MagicBlock, НЕ омнібус над Jupiter, НЕ форк Percolator
- Позиція — **делегований** PDA в PER з `EphemeralPermission { is_private, members: [owner, session, crank] }`; нуль комітів на L1 до закриття. На L1 видно лише акаунт під Delegation Program з байтами онбордингу
- Жоден акаунт із полями позиції не комітиться до закриття: `MarketRisk`, `DisclosureQueue` — ніколи; `UserAccount` — лише `free_margin`/`locked_margin`
- Усі акаунти програми в ER — permissioned. Публічний агрегат виходить у світ тільки через 5-хв коміт `Pool`
- Маржа — облік у приватних `UserAccount`/`Position`, не токени. eATA юзера існує лише на депозит/вивід; open/close не торкаються токен-акаунтів
- Приватність — MagicBlock PER (Intel TDX), не ZK і не FHE. Формулювання: від трекерів, копі-ботів і від нас; не від Intel і не від оператора
- Кастоді — Ephemeral SPL Token (Global Vault на L1 + pool eATA в ER)
- Ціни — Pyth Lazer через MagicBlock Pricing Oracle, mark = EMA над index, ліквідація за mark
- Розкриття — commit-then-reveal через Magic Actions; затримка параметр (демо хвилини, продукт 30 днів)
- Devnet-first: `devnet-tee-as.magicblock.app`, власний `dUSDC` faucet-мінт, пул фондує протокол
- Бекенду нема. Crank — у ER (scheduler), fallback-скрипт зовні

## Документи
- docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md — **джерело правди** для MVP (скоуп, акаунти, математика, програма, клієнт, тести, ризики, календар)
- docs/dexxer-architecture.md — обґрунтування, витік-модель, конкурентна рамка (§2.1 застарів там, де розходиться зі spec)
- docs/dexxer-plan.md — §2–3 застарілі, замінені spec §1 і §7.3
- docs/dexxer-mobile-stack.md — RN/Expo стек
- docs/solana-perp-privacy-landscape.md, docs/glossary-perp-privacy.md — ринок і терміни
- docs/superpowers/plans/2026-09-19-week1-core.md — план тижня 1 (задачі, послідовність)
- docs/superpowers/plans/week1-results.md — виміряні результати тижня 1 (Q1–Q3, CLI-прогін, CU, знахідки на mb-stack)
- docs/superpowers/plans/2026-09-20-week2-privacy-devnet.md — план тижня 2 (приватність, devnet-tee, мобільний скелет)
- docs/superpowers/plans/week2-results.md — виміряні результати тижня 2 (M1–M4, devnet-деплой, crank fix-раунди, мобільний скелет)

## Правила
- Anchor 1.0.2, Solana 3.1.9, Rust 1.89, `ephemeral-rollups-sdk` 0.16.2 (`anchor`, `access-control`), TS SDK 0.17, `@solana/web3.js` v1 (не kit)
- Округлення — завжди на користь пулу; вся математика в `math.rs`, `u128` проміжні, `checked_*`
- **Приватність = фільтр читання в TEE/QFS, НЕ шифрування** (доки MagicBlock `onchain-privacy`/`local-development`). На L1 фільтра немає → **сирий приватний (permissioned) акаунт ніколи не комітиться на L1 як є** — це зробило б байти публічними; TEE такий коміт не пропускає (ризик №13, підтверджено механізмом). Усе, що має вийти на L1, виходить лише через окремий **публічний** похідний акаунт (`Pool`-агрегат; майбутній commitment/root для exit-доказів і 13F). Trustless-exit — на публічному root+merkle-доказі, не на комітах `UserAccount`
- Коміт агрегату — фіксованим інтервалом батчем, ніколи подієво і ніколи на кожну дію. **`commit_aggregate` комітить лише `Pool`** (week 2, 21.09.2026). `withdraw` містить commit-intent для `UserAccount`, але на devnet-tee він **не долітає до L1 за задумом** (див. правило приватності вище) — гроші рухаються коректно (ER-облік + SPL), лише L1-снапшот `UserAccount` лишається застарілим; це не баг для латання, а сигнал будувати exit на публічному root (тиждень 3)
- Оракул: на кожне читання — feed id, `posted_slot > 0`, staleness, confidence, deviation. Stale → скіп ліквідацій, не ліквідація за старою ціною
- `init_if_needed` не використовувати; `write_commitment` перевіряє escrow-підписанта
- Solana MCP `program_autofixer` на кожну зміну програми до коміту
- Skill `magicblock` — для ER/PER/eSPL/oracle/session keys; `solana-dev` — для Anchor/клієнтів/тестів
- Мова документів і комітів — українська для docs, англійська для коду й commit messages
- `crank_tick` приймає `Config.crank`, `Config.scheduler_signer` або плоский `CRANK_SIGNER`; кандидати ліквідації — `remaining_accounts` парами `[Position, UserAccount]`, ≤16. **Крank — permission-член кожної позиції** (`[owner, session, crank]`, week 2) — `getProgramAccounts` із crank-токеном повертає приватні акаунти, окремого реєстру кандидатів не потрібно
- **Планувальник (week 2, 21.09.2026):** запланований `crank_tick` підписує Magic Program значенням `crank_signer_pda(admin)` (per-authority PDA, не плоский `CRANK_SIGNER`), яке має лежати в `Config.scheduler_signer` **до** `schedule_crank`. Пишеться окремою base-layer admin-інструкцією `set_scheduler_signer` (`AdminConfig`-патерн, як `pause`/`unpause`) — `schedule_crank` сам більше нічого в `Config` не пише (writable-неделегований акаунт у `ScheduleCrankCpi`'s `instruction_accounts` заборонений безумовно, підтверджено двічі). **`iterations` — кінцеве** (виставляли `86_400` × 1 с ≈ 24 год): планувальник **не вічний**, після вичерпання `mark` застигає — не покладатися на нього як на завжди-онлайн без перезапуску; завжди-онлайн шлях — `crank-fallback`. Некостильне рішення (велике `iterations` / self-reschedule / персистентність через рестарт) — тех-борг №18, вимір тижня 3, не вгадувати
- `commit_aggregate`/`commit_market`/`withdraw`'s commit-intent платять через делегований `FeeEscrow` PDA (`[b"fee_escrow"]`, `init_fee_escrow`/`delegate_fee_escrow`), не `ctx.accounts.payer` напряму — акаунт, оголошений `Signer<'info>` на верхньому рівні прямо викликаної інструкції, структурно не може бути програмним PDA. `magic_fee_vault` потрібен у CPI щоразу, коли payer делегований, незалежно від ліміту комітів. `FeeEscrow` спільний — griefing surface, мітигований `withdraw`'s `MIN_WITHDRAW`/cooldown, не усунений
- `withdraw`: `require!(amount ≥ MIN_WITHDRAW = 1_000_000)`, per-account cooldown `WITHDRAW_COOLDOWN_SLOTS = 300` через `UserAccount.last_withdraw_slot`
- Пул — контрагент PnL через `Pool.protocol_liquidity`; інваріант тижня 1 (див. spec §3.6) перевіряється кожним LiteSVM-тестом трейдингу/кранка (`trade`, `resize`, `crank`, `invariants`) через `assert_invariant`
- OI-леджер (`MarketRisk.oi_long`/`oi_short`) змінювати лише через `Position.oi_notional`, ніколи перерахунком з VWAP `entry` (`notional(size, entry)`) — подвійне округлення VWAP → notional може underflow'нути `checked_sub`
- LiteSVM: `tests/litesvm` (`cargo +nightly-2026-09-18 test -p dexxer_litesvm`, потребує nightly через транзитивний `solana-syscalls`; `anchor build` перед першим прогоном) — **39 тестів** (week 2)
- mb-stack: `tests/er` (`npm run q1|q2`, детальніше `tests/er/README.md`); `scripts` — crank fallback і week-1 CLI демо (`npm run crank`, `npm run week1` у `scripts/`)
- **Devnet-профіль (week 2, 21.09.2026):** `DEXXER_NET=devnet` перемикає `tests/er/lib/env.ts`'s `cfg()` на профіль `devnet` (base `https://rpc.magicblock.app/devnet`, TEE `https://devnet-tee.magicblock.app`, router, `ER_VALIDATOR`, `ORACLE`) замість `local` (mb-stack); `.env` усе одно переважає профіль за замовчуванням — статичні `import`-и `lib/env.js` мають виставляти `process.env.*` *до* динамічного `await import(...)`, інакше `.env`'s localhost-адреси мовчки перемагають (знахідка Task 1/5, виправлено в кожному devnet-скрипті бутстрап-обгорткою). `teeConn(kp)` — TEE-з'єднання з токеном (`getAuthToken`) на devnet, прозорий проксі на `erConn` локально
- `keys/` — program keypairs (`keys/programs/*-keypair.json`) і devnet-ідентичності (`tests/er/.keys/*.json`); gitignored повністю, крім `keys/README.md` (`.gitignore`: `keys/*` + `!keys/README.md` — негація не працює на весь каталог, лише на файли всередині). **Ніколи не комітити нічого під `keys/`, крім `README.md`**
- Solana MCP `program_autofixer` покриває навіть чисто doc-коментарні зміни в `.rs`-файлах — запускати завжди, не лише на логіку
