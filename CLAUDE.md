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

## Правила
- Anchor 1.0.2, Solana 3.1.9, Rust 1.89, `ephemeral-rollups-sdk` 0.16.2 (`anchor`, `access-control`), TS SDK 0.17, `@solana/web3.js` v1 (не kit)
- Округлення — завжди на користь пулу; вся математика в `math.rs`, `u128` проміжні, `checked_*`
- Коміт агрегату — фіксованим інтервалом батчем, ніколи подієво і ніколи на кожну дію
- Оракул: на кожне читання — feed id, `posted_slot > 0`, staleness, confidence, deviation. Stale → скіп ліквідацій, не ліквідація за старою ціною
- `init_if_needed` не використовувати; `write_commitment` перевіряє escrow-підписанта
- Solana MCP `program_autofixer` на кожну зміну програми до коміту
- Skill `magicblock` — для ER/PER/eSPL/oracle/session keys; `solana-dev` — для Anchor/клієнтів/тестів
- Мова документів і комітів — українська для docs, англійська для коду й commit messages
- `crank_tick` приймає `Config.crank` або `CRANK_SIGNER`; кандидати ліквідації — `remaining_accounts` парами `[Position, UserAccount]`, ≤16
- Пул — контрагент PnL через `Pool.protocol_liquidity`; інваріант тижня 1 (див. spec §3.6) перевіряється кожним LiteSVM-тестом трейдингу/кранка (`trade`, `resize`, `crank`, `invariants`) через `assert_invariant`
- OI-леджер (`MarketRisk.oi_long`/`oi_short`) змінювати лише через `Position.oi_notional`, ніколи перерахунком з VWAP `entry` (`notional(size, entry)`) — подвійне округлення VWAP → notional може underflow'нути `checked_sub`
- LiteSVM: `tests/litesvm` (`cargo +nightly-2026-09-18 test -p dexxer_litesvm`, потребує nightly через транзитивний `solana-syscalls`; `anchor build` перед першим прогоном)
- mb-stack: `tests/er` (`npm run q1|q2`, детальніше `tests/er/README.md`); `scripts` — crank fallback і week-1 CLI демо (`npm run crank`, `npm run week1` у `scripts/`)
