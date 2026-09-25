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
