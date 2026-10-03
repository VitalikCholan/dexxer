# Ранбук: емулятор, Metro, проксі, гаманці (24.09.2026)

Як підняти локальне середовище для живого прогону застосунку на Android-емуляторі з fakewallet
або Phantom, і як його коректно вимкнути. Усе виміряно на macOS + Android SDK
(`~/Library/Android/sdk`), Node 24 через nvm.

## 0. Що є на машині

| Що | Де | Примітка |
| --- | --- | --- |
| AVD `local_phone` | google_apis, без root | fakewallet + dev-client `com.dexxer.app`; демо-гаманець `5Ahk…xf2B` |
| AVD `phantom_phone` | Play-образ, Google-акаунт | Phantom (devnet mode, «Testnet Mode») + dev-client; гаманець `A3xa…Ad97` |
| Metro | `app/`, порт 8081 | dev-client бере бандл через `adb reverse` |
| Проксі | `scripts/emu-proxy.cjs`, порт 8888 | DNS робить Mac, а не гість |
| Relayer | Railway, `https://relayer-production-1ae7.up.railway.app` | завжди онлайн, піднімати не треба |

Один емулятор за раз. Два одночасно — лише зайві питання «чому два».

## 1. Старт (повна послідовність)

```bash
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$HOME/Library/Android/sdk/platform-tools:$HOME/Library/Android/sdk/emulator:$PATH"

# 1. Проксі на Mac (лог у /tmp/emuproxy.log)
nohup node scripts/emu-proxy.cjs > /tmp/emuproxy.log 2>&1 &

# 2. Metro (лог у /tmp/metro.log)
(cd app && nohup npx expo start --dev-client --port 8081 > /tmp/metro.log 2>&1 &)

# 3. Емулятор — ОБОВ'ЯЗКОВО з проксі та DNS-прапорцями
emulator -avd local_phone -http-proxy http://10.0.2.2:8888 -dns-server 8.8.8.8,8.8.4.4 &
#   (для Phantom: -avd phantom_phone)

# 4. Дочекатись завантаження
until adb shell getprop sys.boot_completed 2>/dev/null | grep -q 1; do sleep 3; done

# 5. Системний проксі в гості (прапорець -http-proxy сам його НЕ виставляє) + міст до Metro
adb shell settings put global http_proxy 10.0.2.2:8888
adb reverse tcp:8081 tcp:8081

# 6. Перезапустити гаманець — процес, що стартував ДО п.5, проксі не бачить
adb shell am force-stop com.solana.mobilewalletadapter.fakewallet   # або app.phantom

# 7. Відкрити Dexxer через dev-client
adb shell am start -a android.intent.action.VIEW -d "app://expo-development-client/?url=http://localhost:8081" com.dexxer.app
```

Перевірка, що все живе:

```bash
lsof -nP -i :8081 -i :8888 | grep LISTEN                 # два LISTEN
tail -n 3 /tmp/emuproxy.log                              # CONNECT devnet-tee.magicblock.app:443 …
adb logcat -d | grep ReactNativeJS | grep -E "loaded|UnknownHost" | tail -n 3
```

`UnknownHostException` або `Failed to connect to /10.0.2.2:8888` = п.1 або п.5 не спрацював.

## 2. Гаманці

**fakewallet** (`local_phone`): AUTHORIZE на екрані підпису — верхня ліва кнопка
(`adb shell input tap 206 672` на 1080×2400); на екрані «AUTHORIZE DAPP» (fresh authorize)
кнопка нижче (`206 1085`). Ротує auth-token на кожному reauthorize, на fresh authorize створює
**новий акаунт** — це очікувано.

**Phantom** (`phantom_phone`): devnet у Settings → Developer → Testnet Mode. SOL на гаманець
переказує користувач зі свого CLI (`solana transfer <addr> 0.2 -u devnet --allow-unfunded-recipient`);
з SOL ≥ 0.05 онбординг іде self-funded (без «Failed to simulate»). Промпт Phantom триває
~35–40 с через 429 від `api.devnet.solana.com` — саме тому всі owner-L1-tx на durable nonce
(`app/src/lib/nonce.ts`). У логах Phantom: `IdentityVerifier: DAL verification … true`.

## 3. Що дивитись у логах

```bash
adb logcat -c                                                  # очистити перед прогоном
adb logcat -d -v time | grep ReactNativeJS | grep -E "\[dexxer\]|\[mwa\]"        # апка
adb logcat -d -v time | grep -E "invoke \`|Responding with error|DAL verification"   # MWA + гаманець
adb exec-out screencap -p > /tmp/screen.png                    # скріншот
adb shell dumpsys window | grep mCurrentFocus                  # хто у фокусі
```

Fast Refresh не завжди доносить нові модулі (особливо не-компоненти) — після правок у
`src/lib/*` робити повний reload: `adb shell input text "RR"` при відкритій апці.

## 4. Вимкнення

```bash
adb emu kill; sleep 4; pkill -f "qemu-system"       # емулятор
pkill -9 -f "expo start"                             # Metro
pkill -9 -f "emu-proxy.cjs"                           # проксі
adb devices; lsof -nP -i :8081 -i :8888 | grep LISTEN   # має бути порожньо
```

## 5. Відомі пастки

- `emulator -http-proxy` не виставляє `http_proxy` у гості — потрібен `settings put`.
- Процеси, що стартували до `settings put global http_proxy`, проксі не бачать — force-stop.
- Без проксі в гості не резолвляться Cloudflare/AAAA-хости (`rpc.magicblock.app`); з Private
  DNS `dns.google` — навпаки, лише AAAA. Проксі знімає обидва.
- `adb -s <serial>` через змінну з пробілом у zsh не розбивається — писати серіал явно.
- Тост із помилкою в апці зникає за ~5 с — читати `[dexxer] … failed` у logcat, не екран.
- Blockhash на devnet живе ~25 с (Alpenglow) — будь-який повільний промпт гаманця на
  blockhash-tx = «confirm timeout». Owner-L1-tx мають іти на nonce.

## 6. Smoke на програмі слотів (план 4)

**Не виконувалось у плані 3** (01.10.2026: лише `tsc`/lint/unit і `expo export`); **план 4 —
кроки 1–7 PASS, 8–9 не виконано** (1 — за логами й L1, 2–7 — за повідомленням власника; результати — в кінці розділу). Чек-лист
для користувача з реальним гаманцем (fakewallet або Phantom). Передумова: нова програма
задеплоєна, `bootstrapDevnet` і `add-market` (BTC тощо) виконані, relayer на новій адресі,
APK зібрано на ту саму програму. Біля кожного кроку — що дивитись у logcat (`[dexxer]`).

1. **Онбординг на двох акаунтах.** Свіжий гаманець → Onboarding → Confirm. Очікувано: три
   L1-леги (`faucet+init_user`, `delegate_spl`, `delegate_user`) і ER-лег
   (`permissions+session`). `UserAccount` і `Positions` під Delegation Program, «You're set».
   Записати розміри tx лег, якщо їх видно в лозі.
2. **Вибір ринку.** Trade → `MarketPicker` показує SOL і ринки з `GET /markets`. Обрати BTC:
   заголовок стає `BTC-PERP`, ціна й графік — BTC. Перезапустити апку: BTC лишився обраним
   (`dexxer.market`).
3. **Open на SOL і на BTC.** Відкрити позицію на SOL, потім на BTC. Обидві tx проходять,
   ціна кожного ринку оновлюється окремо.
4. **Список позицій.** Positions — дві картки, `SOL-PERP` і `BTC-PERP`, у кожній свій mark.
   Дії на картці BTC керують позицією BTC, не SOL.
5. **Часткове зменшення.** Decrease на одній позиції (не повністю). History показує запис
   `Partial close`, позиція лишається відкритою з меншим розміром.
6. **Закриття.** Close одним дотиком на іншій картці. Картка зникає, у History з'являється
   `Closed`.
7. **Архів після перезапуску.** Повністю закрити апку і відкрити знову. History показує ті
   самі записи (архів `dexxer.history.<owner>`), час «seen …» той самий.
8. **Вихід із двома ринками.** Закрити все, вивести маржу до 0 → Account → Exit. У лозі /
   в tx `undelegate_user` у `remaining_accounts` два ринки (SOL і BTC). Tx проходить,
   обидва акаунти розделеговано.
9. **Повторний онбординг після janitor-а.** Одразу після Exit відкрити Onboarding: стан
   `Exited` (текст про очікування, без кроків). Протягом ≈5 хв (цикл коміту relayer-а,
   `COMMIT_INTERVAL_MS`) janitor закриває акаунти (`close_exited_user`), і Onboarding
   повертається до звичайного онбордингу. Пройти його ще раз.

Будь-який провалений крок записати з рядком logcat і сигнатурою tx у `week6`-результати плану 4.

### Результати smoke (план 4, Task 6, 01.10.2026)

Вів власник на AVD `local_phone` (fakewallet), агент на кнопки гаманця не натискав. Середовище: dev
client `com.dexxer.app`, `npm run android -- --no-bundler` (інкрементальна збірка, 55 с), APK
`app/android/app/build/outputs/apk/debug/app-debug.apk` 110 870 032 B, sha256
`4178ed2223f56777a6766f8cdf60a558eb35d3cc7890a98840fd4c464137e531`; сертифікат підпису SHA-256
`FA:C6:17:45:DC:09:…:03:3B:9C` == дефолт `services/relayer/src/assetlinks.ts` == живий
`/.well-known/assetlinks.json`. Бандл Metro: program id `Fyg2…UfCY` ×7, `G2ok…` ×0. Relayer —
`https://relayer-production-1ae7.up.railway.app` (деплоймент `8b33d95d`, `COMMIT_INTERVAL_MS=300000`).
Owner (свіжий акаунт fakewallet): `2TQerBRHvjxR3hGbSqGaSKZWBhbiB7mRfEWCeVeEFgWi`.

| Крок | Результат | Що спостерігали |
|---|---|---|
| 1 | PASS | `[dexxer] selfFund: owner has 0 lamports, min 50000000 → sponsored`; `leg faucet+init_user: 3 ixs (+advance+2 CB), 795 bytes`, `leg delegate_spl: … 812 bytes`, `leg delegate_user: 1 ixs (+advance+2 CB), 765 bytes`, `leg permissions+session: 2 ixs (+blockhash), 506 bytes`; `feePayer` трьох L1-легів — `fee_payer` `3HgD…3Chnt`, ER-лега — owner. На L1 (публічний RPC): `NtRjGqL7…` 20:35:10, `3cCf6rVL…` 20:35:11, `36BWmyeX…` 20:35:12 (час за Києвом, UTC+3; так само нижче), помилок нема. Далі депозит: `selfFund … min 1000000 → sponsored`, `signOwnerL1: durable nonce slot 0 8HijrvhF…`, гаманець повернув `ixs=[111111,Comput,Comput,Fyg2yJ]` (advance першим, свої CB), `sendL1Sponsored: sent 2YRYNrwZ…` (20:35:26 на L1) |
| 2 | PASS | вибір BTC, збереження після перезапуску (за повідомленням власника) |
| 3 | PASS (після фіксу дефекту #1) | open на SOL і BTC — тости (ER-дії сигнатури в logcat не пишуть) |
| 4 | PASS | дві картки, `/positions` у логах маршрутів |
| 5 | PASS | `Partial close` у History |
| 6 | PASS | картка зникла, `Closed` у History |
| 7 | PASS | архів History після перезапуску апки |
| 8 | **не виконано 01.10.2026** | власник відклав |
| 9 | **не виконано 01.10.2026** | власник відклав |

Кроки 2–7 — PASS за повідомленням власника; з логів видно лише маршрути (`Track /trade`, `/positions`,
`/history`, `/account`), бо ER-дії сигнатур не логують.

**Дефект #1 — виправлено `c0d39db`.** Open мовчки нічого не робив на жодному ринку. У Hermes
`Buffer.subarray().toString()` повертає `"83,79,76,0,0,0,0,0"`, а не `"SOL"`, тож `decodeMarket.symbol`
ніколи не дорівнював обраному символу: ринок/акаунти — `null`, `handleOpen` мовчки виходив. Знайдено
тимчасовим DEBUG-логом (`[dexxer] DEBUG open gate … marketSymbol: '83,79,76,0,0,0,0,0'`; відкочено,
не закомічено). Фікс — побайтове декодування символу (`pdas.ts`, `codecs.ts`) + регресійний тест.
Застосовано перезавантаженням JS о 20:46; кроки 3–7 пройшли на цьому бандлі, нового APK не збирали.

**Дефект #2 — виправлено `b276769`.** HYPE, Open Short 7× → тост `insufficient margin (6010)`:
`LeverageSlider` мав зашиті 1–10× і не знав `max_lev_bps` ринку (HYPE/ZEC — 5×). Програма поводилась
коректно. Фікс — повзунок і MAX обмежені `maxLeverage(market)`. JS перезавантажено о 20:58, **на
пристрої повторно не перевірено**.

Обмеження доказів: ER-дії (open/increase/decrease/close/add margin/exit) не пишуть сигнатуру в logcat,
збої в Trade/Positions — лише тостом; `remaining_accounts` Exit (крок 8) з логів не перевірити — лише
станом L1 за адресою власника.
