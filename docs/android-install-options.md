# Варіанти встановлення Dexxer на Android для тестування й демо (02.10.2026)

Апка — Expo dev-client `com.dexxer.app` з Mobile Wallet Adapter (MWA). MWA — нативний Android-модуль,
тому **Expo Go не працює** ніяк: Connect мовчки нічого не робить. Потрібна власна збірка (dev-client
або release-APK). iOS збирається, але гаманців там немає.

Позначки: ✅ виміряно на цьому проєкті; 📄 документовано Expo/Solana Mobile, у нас не пробували.

| # | Варіант | Для чого | Кабель | Metro | Статус |
|---|---------|----------|--------|-------|--------|
| 1 | AVD `local_phone` + fakewallet | щоденний smoke, агентна верифікація | — | так | ✅ |
| 2 | AVD `phantom_phone` + Phantom | nonce, DAL, реальний гаманець без телефона | — | так | ✅ |
| 3 | Телефон/Seeker по USB, `expo run:android` | найближче до правди, логи adb | USB | так | ✅ (Seeker — не пробували) |
| 4 | Телефон по Wi-Fi (adb wireless) | те саме без кабелю | — | так | 📄 |
| 5 | Dev-client + `expo start --dev-client` по LAN/tunnel | розробка без adb | — | так | 📄 |
| 6 | EAS Build `development` | збірка в хмарі, без Android SDK | — | так | 📄 |
| 7 | APK напряму (sideload) | демо на чужому телефоні | — | ні/LAN | ✅ debug-APK, release — ні |
| 8 | EAS Build `preview` / release-APK | автономне демо на живому relayer-і | — | ні | 📄 |

Усі варіанти ходять у живий devnet-деплой (програма `Fyg2…UfCY`, relayer на Railway — `docs/deployments.md`),
збирати бекенд не треба.

## 0. Передумови (один раз)

```bash
npx solana-mobile@latest doctor          # Android SDK, Java, Node — що бракує, скаже
cd app && npm ci
```

Збірка dev-client-а: `npm run android` з `app/` (= `expo run:android`). Перша — хвилини (Gradle), далі
≈1 хв інкрементально; `npm run android -- --no-bundler`, якщо Metro вже запущений. APK після збірки —
`app/android/app/build/outputs/apk/debug/app-debug.apk`.

## 1–2. Емулятори (AVD)

Повна послідовність, логи, вимкнення й пастки — `docs/emulator-runbook.md` §1–§5; чек-лист smoke — §6.
Ключове: емулятор запускати з `-http-proxy http://10.0.2.2:8888 -dns-server 8.8.8.8,8.8.4.4` і проксі
`scripts/emu-proxy.cjs` (інакше TEE-ендпоінти не резолвляться з гостя), потім `settings put global http_proxy`
і `adb reverse tcp:8081 tcp:8081`. Свіжий AVD готує CLI:

```bash
npx solana-mobile@latest emu start local_phone --tune     # без анімацій, lock screen, first-run діалогів
npx solana-mobile@latest device install fakewallet        # тестовий MWA-гаманець
```

Phantom (`phantom_phone`): Play-образ з Google-акаунтом, Testnet Mode, ≥0.05 SOL для self-funded онбордингу.
Пастки графіка на AVD (швидкий свайп по таймфреймах перемикає ринок, пауза ≥2 с після тапу) — CLAUDE.md,
«Правила тижня 6: графік».

## 3. Реальний телефон або Seeker по USB

macOS драйверів не потребує. На телефоні: Developer options (7 тапів по Build number) → USB debugging;
кабель має бути з даними, не лише зарядний; підтвердити відбиток Mac-а на екрані.

```bash
npx solana-mobile@latest device list     # або adb devices — стан має бути `device`, не `unauthorized`
cd app && npm run android                # збирає й ставить dev-client на телефон
npx solana-mobile@latest device open http://localhost:8081   # сам робить adb reverse до Metro
```

Проксі з §1 не потрібен — у телефона свій DNS. Логи — як у ранбуці §3 (`adb logcat … ReactNativeJS`).
Якщо Connect нічого не робить — спершу відділити апку від середовища:

```bash
npx solana-mobile@latest playground      # тестова сторінка MWA, друкує кожен connect/sign у термінал
```

Не підписує й вона → винен гаманець/пристрій, не наш код. Для release-збірки Phantom перевіряє
Digital Asset Links: відбиток ключа підпису має бути в `ASSETLINKS_SHA256_FINGERPRINTS` relayer-а
(CLAUDE.md, «Правила тижня 5», п. 1); debug-keystore dev-client-а там уже є.

## 4. Телефон по Wi-Fi (adb wireless, Android 11+) 📄

Developer options → Wireless debugging, телефон і Mac в одній мережі:

```bash
adb pair <ip>:<pair-port>     # код і порт з діалогу «Pair device with pairing code», один раз
adb connect <ip>:<port>       # порт з головного екрана Wireless debugging (інший, ніж для pair)
adb devices
```

Далі все як у §3, включно з `adb reverse` і logcat. Збірка/установка по Wi-Fi повільніша — зручно
зібрати раз по USB, потім відключити кабель.

## 5. Dev-client без adb: `expo start --dev-client` 📄

Коли dev-client уже стоїть на телефоні (будь-яким із §3/§6/§7):

```bash
cd app && npx expo start --dev-client          # QR у терміналі; телефон і Mac в одній Wi-Fi
cd app && npx expo start --dev-client --tunnel # якщо мережа ізолює пристрої (гостьовий/офісний Wi-Fi)
```

У dev-client-і — відсканувати QR або ввести `http://<ip-Mac-а>:8081`. Логи JS видно в терміналі Metro,
нативні (MWA, гаманець) — лише через adb.

## 6. EAS Build, профіль `development` 📄

Збірка в хмарі Expo, без Android SDK на машині. `eas.json` у `app/` ще немає (в `app.json` — порожній
`extra.eas`):

```bash
npm i -g eas-cli && eas login
cd app && eas build:configure
eas build --platform android --profile development
```

Результат — посилання/QR, телефон качає й ставить APK напряму (дозволити «невідомі джерела»). Далі §5.
Безкоштовний тариф має місячний ліміт збірок і чергу; локальна `expo run:android` на macOS зазвичай швидша.
Увага: EAS підписує власним keystore — для Phantom його відбиток треба додати в assetlinks relayer-а.

## 7. APK напряму (sideload) ✅ для debug-APK

`app-debug.apk` із §0 передати на телефон будь-як (AirDrop-аналог, месенджер, `adb install`), дозволити
установку з цього джерела. Це той самий dev-client: без Metro він не стартує — потрібен §5 або §4/§3.
Підходить, щоб швидко дати тестувальнику збірку, яку далі годує ваш Metro по `--tunnel`.

## 8. Автономне демо: release-APK або EAS `preview` 📄

Без Metro, ходить у живий relayer. Варіанти: `eas build --profile preview` (після §6) або локально
`cd app/android && ./gradlew assembleRelease` з власним keystore (зараз release-keystore у проєкті не
заведено). Обов'язково перед роздачею:

- env збірки `EXPO_PUBLIC_*` (relayer, identity URI) — на живий relayer, як у `docs/deployments.md`;
- відбиток release-ключа — в `ASSETLINKS_SHA256_FINGERPRINTS` relayer-а, інакше Phantom відмовить
  («DAL verification … false»), fakewallet — ні;
- перевірити на Seeker: MWA identity, Seeker-гаманець, DAL — жодне на Seeker ще не виміряно.

Публікація в Solana dApp Store — окрема тема (skill `solana-mobile-publishing`), для MVP не планується.

## Що обрати

- **Швидко перевірити зміну:** §1 (AVD + fakewallet) — усе автоматизовано, агент може сам.
- **Перевірити гаманцеві сценарії (nonce, DAL, промпт ~35 с):** §2 або §3 з Phantom.
- **Показати комусь на його телефоні:** §7 + §5 `--tunnel` (сьогодні) або §8 (після заведення keystore).
- **Seeker:** §3 по USB, потім §4 — єдине місце, де видно Seeker-специфіку.
