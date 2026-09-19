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

## Правила
- Anchor 1.0.2, Solana 3.1.9, Rust 1.89, `ephemeral-rollups-sdk` 0.16.2 (`anchor`, `access-control`), TS SDK 0.17, `@solana/web3.js` v1 (не kit)
- Округлення — завжди на користь пулу; вся математика в `math.rs`, `u128` проміжні, `checked_*`
- Коміт агрегату — фіксованим інтервалом батчем, ніколи подієво і ніколи на кожну дію
- Оракул: на кожне читання — feed id, `posted_slot > 0`, staleness, confidence, deviation. Stale → скіп ліквідацій, не ліквідація за старою ціною
- `init_if_needed` не використовувати; `write_commitment` перевіряє escrow-підписанта
- Solana MCP `program_autofixer` на кожну зміну програми до коміту
- Skill `magicblock` — для ER/PER/eSPL/oracle/session keys; `solana-dev` — для Anchor/клієнтів/тестів
- Мова документів і комітів — українська для docs, англійська для коду й commit messages
