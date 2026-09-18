# Dexxer

Приватний perpetual DEX для Solana Seeker. Позиція видима лише власнику.

## Архітектура (рішення прийняті, не переглядати без причини)
- Опція 2: власне перп-ядро, НЕ омнібус над Jupiter
- Позиція — ephemeral-акаунт в ER, на L1 не існує
- Приватність — MagicBlock PER (Intel TDX), не ZK і не FHE
- Кастоді — Ephemeral SPL Token (Global Vault + eATA)
- Ціни — Pyth Lazer через MagicBlock Oracle, mark = EMA над index
- Розкриття — commit-then-reveal із затримкою 30 днів
- Devnet-first, власний faucet-токен як застава

## Документи
- docs/dexxer-architecture.md — компоненти, акаунти, патерни
- docs/dexxer-plan.md — календар і ризики
- docs/dexxer-mobile-stack.md — RN/Expo стек

## Правила
- Anchor 1.0, Solana 3.1.9, Rust 1.89
- Округлення — завжди на користь протоколу
- Коміт агрегату — батчем, ніколи на кожну дію (приватність + вартість)