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
| 9 | EAS internal distribution (сторінка/QR) + Expo Orbit | роздати тестувальникам, ставити в один клік | — | залежить | 📄 |
| 10 | EAS Update (OTA JS) | оновлювати вже встановлені збірки без переустановки | — | ні | 📄 |
| 11 | Firebase App Distribution | до 500 тестувальників, без Play | — | ні | 📄 |
| 12 | Google Play internal testing | до 100 тестувальників через Play Store | — | ні | 📄, потребує Play Console |
| 13 | Хмарні реальні пристрої (Android Device Streaming, BrowserStack App Live) | чужі моделі телефонів без закупівлі | — | ні | 📄, гаманець — під питанням |
| 14 | Емулятор у браузері (Appetize.io) | показати в браузері, без установки | — | ні | 📄, MWA-гаманця нема |
| 15 | Solana dApp Store | справжня дистрибуція на Seeker | — | ні | 📄, не для MVP |

Для демо на екрані Mac-а (не установка, а показ): **scrcpy** дзеркалить і керує реальним телефоном по USB
або Wi-Fi без застосунку на телефоні (`brew install scrcpy`), на відміну від AVD — зі справжнім гаманцем.

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

## 9. EAS internal distribution + Expo Orbit 📄

`"distribution": "internal"` у профілі `eas.json` → EAS віддає APK і сторінку встановлення з QR/посиланням;
тестувальнику не потрібен ні Play, ні акаунт Expo (доступ за посиланням можна закрити в Project Settings —
тоді лише колаборатори проєкту). **Expo Orbit** (menu-bar апка для macOS) ставить збірку з EAS на під'єднаний
телефон або емулятор одним кліком «Open with Expo Orbit» з дашборда і вміє запускати EAS Update у сумісну збірку.
Android-артефакт має бути `.apk`, не `.aab` (дефолт для Play) — інакше на пристрій не поставиться.

## 10. EAS Update (OTA) 📄

Оновлює лише JS/стилі/ассети у вже встановлених збірках: `eas update --branch preview --message "…"`. Збірка
підписана на **канал** (вшивається при збірці), публікація йде в **гілку** — зв'язок канал↔гілка змінюється
будь-коли. Не змінює нативний код, модулі, `AndroidManifest`, тому зміни MWA/патчів `app/patches/` потребують
нової збірки. Для нас зручно: роздати один `preview`-APK (§8) і далі штовхати зміни графіка/UI без переустановки.

## 11. Firebase App Distribution 📄

Безкоштовно, без Play: до 500 тестувальників на проєкт, 200 на роздачу; підписаний APK завантажується в консоль
Firebase, тестувальники ставлять «App Tester» і отримують збірки з повідомленнями. Альтернатива §9, якщо команда
вже сидить у Firebase; інакше EAS internal простіший (без зайвого застосунку в тестувальника).

## 12. Google Play internal testing 📄

До 100 тестувальників, збірка з'являється за хвилини без повного ревʼю, оновлення приходять через Play Store.
Потребує акаунта Play Console і запису апки в Play — для нас це означає завести лістинг раніше, ніж плануємо.
Підпис Play (App Signing) — інший ключ, ніж для dApp Store, і його відбиток теж має бути в assetlinks relayer-а.

## 13. Хмарні реальні пристрої 📄

**Android Device Streaming** (Android Studio Jellyfish+, Firebase): реальні Pixel/Samsung/Xiaomi у дата-центрах
Google, adb через SSL — працюють усі adb-команди, тож теоретично можна поставити й fakewallet. **BrowserStack
App Live**: APK/AAB на реальному пристрої в браузері. Обидва корисні перевірити чужі моделі/версії Android,
але гаманець на такому пристрої — окремий квест (fakewallet через adb — так; Phantom з логіном — ні), і Seeker
там немає.

## 14. Емулятор у браузері (Appetize.io) 📄

Завантажити APK і запускати в браузері, з логами й мережею; має інтеграцію з Expo. Для нас — лише показ UI без
гаманця: MWA-гаманця на такому емуляторі немає, Connect не спрацює. Підійде для демо графіка/ринків із публічних
даних relayer-а, не для торгівлі.

## 15. Solana dApp Store 📄

Передвстановлений на кожному Seeker, без комісій платформи. Потрібен **release-APK, підписаний окремим ключем**
(не тим, що для Play), debug-збірки не приймаються; публікація через CLI `dapp-store` з NFT видавця/апки
(skill `solana-mobile-publishing`). Тестувати можна на звичайному Android/емуляторі, Seeker не обов'язковий.
Для MVP не планується, але це єдиний «справжній» шлях на Seeker без sideload.

## Що обрати

- **Швидко перевірити зміну:** §1 (AVD + fakewallet) — усе автоматизовано, агент може сам.
- **Перевірити гаманцеві сценарії (nonce, DAL, промпт ~35 с):** §2 або §3 з Phantom.
- **Показати комусь на його телефоні:** §7 + §5 `--tunnel` (сьогодні) або §8 (після заведення keystore).
- **Seeker:** §3 по USB, потім §4 — єдине місце, де видно Seeker-специфіку.
- **Роздати 5–20 тестувальникам:** §9 EAS internal (QR), далі §10 OTA для правок UI.
- **Показати на великому екрані зі справжнім гаманцем:** scrcpy з реального телефона.

## Джерела (02.10.2026)

- Expo: [Android development build](https://docs.expo.dev/tutorial/eas/android-development-build/),
  [Build APKs](https://docs.expo.dev/build-reference/apk/), [Expo Orbit](https://github.com/expo/orbit),
  [EAS Updates з Orbit](https://expo.dev/blog/launching-eas-updates-with-orbit),
  [Internal distribution](https://expo-expo.mintlify.app/deployment/internal-distribution),
  [Share previews](https://docs.expo.dev/tutorial/eas/team-development/)
- Google: [Firebase App Distribution](https://firebase.google.com/docs/app-distribution),
  [Android Device Streaming](https://developer.android.com/studio/run/android-device-streaming),
  [Firebase vs Internal Test Track](https://glovorytech.medium.com/firebase-app-distribution-vs-internal-test-track-7f91680467bb)
- Solana Mobile: [dApp Store](https://docs.solanamobile.com/solana-mobile-stack/dapp-store),
  [Publishing checklist](https://docs.solanamobile.com/dapp-publishing/prepare),
  [Helius: Publishing Solana Mobile Apps](https://www.helius.dev/blog/publishing-solana-mobile-apps)
- Інше: [scrcpy](https://scrcpy.dev/), [Appetize uploading apps](https://docs.appetize.io/platform/app-management/uploading-apps),
  [BrowserStack App Live](https://www.browserstack.com/docs/app-live/get-started)
