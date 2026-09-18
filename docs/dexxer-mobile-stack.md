# Dexxer — мобільний стек (React Native)

Стек фронтенду для приватного perp DEX на Solana Seeker. Актуально на вересень 2026.

---

## 1. Основа

| Шар | Вибір | Чому |
|---|---|---|
| Фреймворк | **Expo + custom dev client** (`expo-dev-client`) | MWA використовує Kotlin-модулі — Expo Go не працює. Вимога, не опція |
| Навігація | **Expo Router** | Файловий роутинг, вбудований, мінімум коду |
| Мова | **TypeScript** (strict) | — |
| Стилі | **NativeWind** | Tailwind-синтаксис у RN; швидше за StyleSheet, легше за Tamagui |
| Скафолд | **`create-solana-dapp`** (Expo-шаблон) | Поліфіли, MWA і провайдер уже зшиті |

---

## 2. Solana-шар

### Рішення тижня 0: `@solana/kit` чи `@solana/web3.js`

Доки Solana Mobile радять `@solana/kit` для нових застосунків. Але вибір диктують бібліотеки, від яких залежить проєкт:

- `@coral-xyz/anchor` (клієнт до форку перп-ядра)
- `@magicblock-labs/ephemeral-rollups-sdk`

**Перевірити `package.json` обох SDK до першого компонента.** Якщо вони на web3.js v1 — брати `@wallet-ui/react-native-web3js`, інакше доведеться конвертувати `PublicKey ↔ Address` на кожному кордоні. Прогноз: web3.js.

### Обов'язкові поліфіли

```
react-native-quick-crypto
react-native-nitro-modules
```

`polyfill.js` імпортується **першим рядком** в `index.js`, до будь-якого Solana-коду.

---

## 3. Гаманець і сесії

| Компонент | Пакет / джерело | Роль |
|---|---|---|
| MWA | `@wallet-ui/react-native-web3js` (або `-kit`) | `MobileWalletProvider` + `useMobileWallet`. Одна авторизація |
| Session Keys | MagicBlock SDK; референс — форк `flash-trade/session-keys` (MIT) | MWA підписує створення session key один раз → далі торгові дії підписує ефемерний ключ без bottom sheet. Це і є «один тап» |
| Зберігання ключа | `expo-secure-store` | Приватний ключ — не в AsyncStorage |
| Доступ до PER | SIWS (`signIn`) | Токен для token-gated TEE-ендпоінту ER видається за підписом челенджу; SIWS закриває це одним промптом |

---

## 4. Дані та стан

| Задача | Інструмент |
|---|---|
| Читання RPC | **TanStack Query** — `staleTime`, рефетч на фокус |
| UI-стан | **Zustand** — вибраний ринок, чернетка ордера |
| Реальний час | **WebSocket `accountSubscribe`** на приватний RPC ER (позиція користувача). Референс — `flash-trade/magicblock-grpc-example` |
| Кеш | **`react-native-mmkv`** — замість AsyncStorage |

---

## 5. Графіки

**`react-native-wagmi-charts`** — свічки й лінії на Reanimated + Skia, жести з коробки. Victory Native надлишкова для одного ринку.

---

## 6. Push при наближенні до ліквідації

> ⚠️ Пастка приватності: бекенд, який стежить за позиціями, стає ще одним, хто їх бачить.

| Етап | Схема | Компроміс |
|---|---|---|
| **MVP** | Апка сама читає свою позицію через token-gated ER-ендпоінт і планує **локальне** сповіщення (`expo-notifications`) при досягненні порогу маржі | Нуль серверів, нуль витоку. Не працює, якщо застосунок убитий системою |
| **v1** | Notifier усередині ER/TEE як permissioned viewer → Expo Push | Узгоджено з моделлю довіри — TEE і так бачить усе |

Для деку: конкуренти ставлять бекенд не замислюючись.

---

## 7. Seeker-специфіка

- **Detecting Seeker Users** (рецепт із доків) — Seed Vault-специфічний UX лише на пристрої.
- **Digital Asset Links** — гаманець перевіряє `identity.uri` проти `/.well-known/assetlinks.json` на домені. Без цього MWA-авторизація може бути відхилена. **`dexxer.xyz` потрібен для MWA, не лише для лендінгу.** Зробити на тижні 1.
- `identity.icon` — **відносний шлях** від `uri`, не абсолютний URL. Kotlin-клієнт строгий.
- `identity.uri` — абсолютний, обов'язковий.

---

## 8. Збірка й тести

| Задача | Інструмент |
|---|---|
| Збірка | **EAS Build** → APK (перевірити актуальні вимоги dApp Store при подачі) |
| Гаманець для розробки | **Mock MWA Wallet** на емуляторі |
| E2E | **Maestro** — YAML-сценарії, простіший за Detox |
| Unit / компоненти | **Jest + React Native Testing Library** |

---

## 9. Чого не брати

- **Redux** — надлишок для цього обсягу стану
- **Expo Go** — не заведеться з MWA
- **Tamagui** — тиждень на налаштування
- **Окремий NestJS-бекенд у MVP** — усе читається з ER напряму; відсутність бекенду — плюс для приватності

---

## 10. Порядок дій тижня 0

1. Перевірити версії web3.js в Anchor і MagicBlock SDK → вибрати `-web3js` або `-kit`
2. `create-solana-dapp` → Expo-шаблон
3. Поліфіл `react-native-quick-crypto` першим рядком
4. MWA `connect` на емуляторі з Mock Wallet
5. Далі — позиції

---

## Джерела

- Solana Mobile docs — React Native: Installation, Setup, Quickstart, MWA TypeScript Reference
- MagicBlock docs — Private Ephemeral Rollups, Session Keys
- `flash-trade/session-keys`, `flash-trade/magicblock-grpc-example`
