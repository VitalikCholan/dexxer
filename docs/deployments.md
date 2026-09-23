# Деплойменти

Живі деплойменти Dexxer поза локальним чекаутом. Жодних секретів у цьому
файлі — лише публічні ідентифікатори (project/service id, домен, PDA,
program id) і ролі ключів.

## Railway — `services/relayer`

Крank-fallback (Task 4, week 4) як always-on сервіс на Railway, замінює
ручний запуск `scripts/crank-fallback` з ноутбука.

| | |
| --- | --- |
| Проєкт | `dexxer` (id `2aac2416-043e-4845-8c19-8e1e2e862f4d`) |
| Оточення | `production` (id `0a5d310b-fac2-40f9-88d1-630df862695a`) |
| Сервіс `relayer` | id `c2581443-1fa1-46ce-bb08-8e95b1fd682f` |
| Сервіс `Postgres` | id `8d0f27fb-6df7-4eeb-8086-790f4d4ef3c5` |
| Домен | https://relayer-production-1ae7.up.railway.app |
| Healthcheck | `GET /healthz`, шлях налаштований у `services/relayer/railway.json` |
| Build | Dockerfile, контекст — корінь репо (`RAILWAY_DOCKERFILE_PATH=services/relayer/Dockerfile`, root directory сервісу `/`) |

Перевірено (22.09.2026): `curl https://relayer-production-1ae7.up.railway.app/healthz`
→ `200 {"ok":true,"tick":21+,"db":"ok",...}`; deploy-логи показують
`tick n=... slot=... mark=... sig=... liquidated=[]` кожну секунду проти
реального devnet-tee (`https://devnet-tee.magicblock.app`).

### Ключі (ролі, не значення)

Приватність-правило (CLAUDE.md): relayer тримає ЛИШЕ `crank`/`fee_payer` —
ніколи owner/session-токени.

| Env var на сервісі `relayer` | Роль | Джерело локально |
| --- | --- | --- |
| `CRANK_KEY_B58` | `Config.crank` — підписант `crank_tick`/`set_balances_root`/`mark_committed`; permission-член (`[owner, session, crank]`) кожної приватної `Position` | `tests/er/.keys/devnet-crank.json` |
| `FEE_PAYER_KEY_B58` | `Config.fee_payer` — єдиний прийнятний `payer` для `commit_aggregate` | `tests/er/.keys/devnet-fee-payer.json` |
| `DATABASE_URL` | reference-змінна на сервіс `Postgres` (`${{ Postgres.DATABASE_URL }}`) | — |
| `DEXXER_NET` | `devnet` | — |
| `PORT` | `8080` | — |
| `RAILWAY_DOCKERFILE_PATH` | `services/relayer/Dockerfile` | — |

Обидва ключі закодовано локально через `bs58.encode(Uint8Array.from(JSON.parse(readFileSync(...))))`
і встановлені через Railway API — значення ніколи не потрапляли в git чи в
цей файл.

### Program / PDA (devnet, з `tests/er/lib/program.ts`)

| | Адреса |
| --- | --- |
| `dexxer_core` program id | `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV` |
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| `Config` PDA | `5pTVyygsH7AYujAPCrtfViVT8e9GM1aWVt5pAjMYLGZK` |
| `Market` PDA (SOL) | `1347yiBYsvCwqjJf8TUB9D4KSPp7RVF2cwQxfxSj4udp` |
| `MarketRisk` PDA | `GNyNkDkb4CpG4ftuimmXsoXVxdv9tmoQRusmhfZvgnr5` |
| `Pool` PDA (dUSDC) | `S7S157Q7VGBSxfeUXscrdnobbMKC2gTFKXpQe5L31mj` |
| `BalancesRoot` PDA | `8VsGYfSbfAi8NSPh6xFvMQfvYSiQL1HwPrvL4YdhNDVZ` |
| `FeeEscrow` PDA | `85ncXT9nYSAjjne8zA2e32Ew77EPygfJnPF15aqsLhJH` |
| Oracle feed PDA (SOL/USD, `feedUnder(ORACLE, "6")`) | `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` |
| Base RPC | `https://rpc.magicblock.app/devnet` |
| ER/TEE | `https://devnet-tee.magicblock.app` |

### Деплой (як відтворити)

```sh
railway link -p 2aac2416-043e-4845-8c19-8e1e2e862f4d -e production -s relayer
railway up --service relayer --ci   # build context = repo root, див. services/relayer/Dockerfile
```

Змінні середовища (`set_variables`/`add_reference_variable` через Railway
MCP, або `railway variables set` через CLI) виставляються один раз і не
входять у деплой-скрипт.

### Відомі спостереження

- Кілька застарілих `UserAccount` з попередніх тестових прогонів (старий
  110/109-байтовий layout, до `last_withdraw_slot`) клієнтський фільтр
  пропускає щотіку (лог `skipping candidate ... stale layout?`) — той самий
  клієнтський фільтр, що й до переїзду в `services/relayer` (CLAUDE.md,
  правило `crank_tick`). Не є регресією Task 4.
- `schedulerActive` у `/healthz` (Task 7, 23.09.2026): `null`, доки
  `CRANK_ENABLED=true` (не атрибутовано — і relayer, і scheduler можуть
  рухати `Market`); `true`/`false` лише коли `CRANK_ENABLED=false` — див.
  розділ «Scheduler (Task 7)» нижче.

## Індексер публічних даних (Task 5, 22.09.2026)

Другий підсервіс усередині того ж `relayer`-процесу (`INDEXER_ENABLED=true`
на сервісі `relayer`, той самий `Postgres`) — читає ЛИШЕ публічні акаунти
(оракул без токена на TEE RPC, `Pool`/`BalancesRoot`/`Disclosure` на base
RPC), ніколи `crank`/`fee_payer`-ключі. REST + WS ендпоінти на тому ж
домені/порту:

| Ендпоінт | Приклад відповіді (live, 22.09.2026) |
| --- | --- |
| `GET /prices?tf=1m&limit=5` | `{"tf":"1m","candles":[{"t":1790106000000,"o":118309140,"h":118327003,"l":118306592,"c":118324531}, ...]}` |
| `GET /mark` | `{"price":"118314540","slot":335253475,"ts":1790106407044}` |
| `GET /pool/latest` | `{"slot":335177389,"ts":1790106155570,"capital_total":"24100000000","protocol_liquidity":"9900000000","locked_total":"100000000","fees_accrued":"0","insurance":"0","bad_debt_total":"0"}` |
| `GET /disclosures?limit=3` | масив із 3 записів закритих позицій (реальні devnet-угоди тижнів 3-4) |
| `GET /root/latest` | `{"root_slot":335228040,"filled":11,"leavesHex":[...64 hex-рядки...]}` |
| `wss://…/ws` | `{"type":"mark","price":"118284685","ts":1790106415146}` кожну секунду (throttle) |

Повна специфікація ендпоінтів, формат чисел (bigint-поля як рядки) і
внутрішня будова — `services/relayer/README.md`'s "Indexer" section.

Міграція `services/relayer/migrations/001_indexer.sql` (таблиці `ticks`,
`pool_snapshots`, `disclosures`, `roots`) застосувалась автоматично на
рестарті (той самий `migrate()`, що й `000_meta.sql` у Task 4).

`/healthz` тепер несе й `indexer: { ticks, lastTickTs, lastPoolSlot,
disclosures, wsClients }` — перевірено live:
`{"ok":true,...,"indexer":{"ticks":44,"lastTickTs":1790106401894,"lastPoolSlot":null,"disclosures":0,"wsClients":0}}`
одразу після рестарту (лічильники ростуть з нуля щоразу; `/pool/*` і
`/disclosures` REST читають з Postgres напряму, тож стан там переживає
рестарт, на відміну від `stats`-лічильників у `/healthz`).

## Scheduler (Task 7, 23.09.2026)

`scripts/admin/schedule-eternal.ts` (`npm run admin:schedule-eternal --prefix
scripts`) зареєстрував `crank_tick` як MagicBlock-задачу планувальника з
`iterations = i64::MAX` на реальному `dexxer_core` — закриває тех-борг №18
(спека тижня 3 виміряла лише на одноразовому spike-деплої, це перший запуск
на живому контракті).

| | |
| --- | --- |
| `task_id` | `-8632762600545312817` (той самий, що й `schedule-crank.ts` — детермінований `sha256(program id)[..8]`, повторний `schedule_crank` над тим самим `task_id` — оновлення, не нова задача) |
| `interval_ms` | `1000` |
| `iterations` | `9223372036854775807` (i64::MAX) — **прийнято** з першої спроби, без потреби у fallback `cancel_crank`+retry |
| `set_scheduler_signer` | не знадобився — `Config.scheduler_signer` вже дорівнював `crank_signer_pda(admin)` з тижня 2 |
| `schedule_crank` sig | `2rF82FDokgMurrZTNqvG9DkDjXZh3tjvoczEZw7tG79XH1Go4984McYeg2C7c2bGT8n6EntsNfX8WiXE8FDQy3ER` |
| 60-секундний пруф (11 семплів, `Market.mark_slot`) | 11 різних слотів, монотонно (напр. `339119462 → 339125562`) — планувальник реально тіка́є |

### M-G: вимір «планувальник як backstop» (relayer crank вимкнено)

Новий env `CRANK_ENABLED` на `services/relayer` (default `true`; `false` —
crank-петля взагалі не стартує, `/healthz.crankEnabled: false`, `ok`
лишається `true` — стейлнес тіку більше не впливає на здоров'я, коли
crank навмисно вимкнений). Новий `marketWatch.ts` — неавтентифіковане
читання публічного `Market` на ER (окремо від `cfg.crank`'s TEE-токена),
керує `/healthz.schedulerActive`: `null`, доки `CRANK_ENABLED=true`
(не атрибутовано — і relayer, і scheduler можуть рухати `Market`);
`true`/`false` лише коли `CRANK_ENABLED=false`.

| Крок | Дія | Результат |
| --- | --- | --- |
| 1 | `railway variable set CRANK_ENABLED=false` + `railway up --service relayer --ci` (деплой `db16e79e-ee74-4be6-8d20-69a0bf2b0b2c`) | `/healthz` → `crankEnabled:false` |
| 2 | Поллінг `/healthz` ~70 с з вимкненим relayer-crank | `tick` лишався `0` (relayer-петля справді не стартувала), `schedulerActive:true` безперервно, `ok:true` — **PASS «scheduler ticks without relayer»** |
| 3 | `05-crank-liquidation.ts`: свіжий трейдер (0.05 SOL з `devnet-admin`, попередньо дозаряджений +0.15 SOL з `payer`, sig `3Lby7PHhrYwpD7yFgcfT8q1XHYqK9NZY1ujbje9n7BobVaeo6jSH1zKodydpmqMsPXFW1boxjR3vqmUNDbZpU1dt`), `open_position` ~9.09× long (sig `yKnAMreMqksX7wLWD65HG6hH76PuWggmgaHETDsugRRhWUSvKN5RwpNdp5XmA34W7bXfwjiBeyw4KRmqiaPAbxZ`), admin `set_params(mmr_bps=9500)` (sig `234nfZt3FoUyS1YqW8cp1GhhtHfAMeATYLMZmCbci3UJzcBtDFsWJceUjsZkA3ru9q7iwDPwZ5DtUSEdZ5Sieebd`), поллінг `Position.liq_ticks`/`state` 90×1 с | `liq_ticks` лишався **пласким `0` усі 90 семплів** — жодного тіку `crank_tick`, що бачив би цю позицію, за вікно спостереження. **FAIL «scheduler liquidates without relayer»** — **архітектурна причина, не таймінг**: `ScheduleCrank` (`programs/dexxer_core/src/instructions/crank.rs`) реєструє заплановану `crank_tick`-задачу з фіксованим набором акаунтів БЕЗ `remaining_accounts` (список акаунтів задачі фіксується в момент реєстрації, кандидатів ліквідації в нього додати неможливо) — власний коментар коду це прямо каже: «carries NO remaining_accounts (liquidation candidates are supplied by the fallback script's own `crank_tick` calls, not by the scheduler)». Тобто запланований тік **завжди виконується з нульовою кількістю кандидатів** — він рухає лише `Market.mark`/EMA, ніколи не оцінює й не ліквідовує жодної позиції, незалежно від `iterations`/часу очікування. Позицію відновлено безпечною: `set_params`-відкат (sig `39riRACXRoA8BiTwQ6Grioba4pbmC2xZaUktGshPxk2QGWztrAJ8r9ZsDAUB7E8yGi3Acc73JdzwN8zhYYQkU8xB`) повернув `mmr_bps` до 500, після чого лишена позиція (`BRqThEwJzvtBUrGv2JpbB1FZMRmyfWUtJ74oimrayuop`) вже не ліквідовна за нормальних параметрів — безпечний сміттєвий залишок (як інші тестові позиції в «Відомих спостереженнях» вище) |
| 4 | `railway variable set CRANK_ENABLED=true` + `railway up --service relayer --ci` (деплой `47ff81f6-183d-401f-9177-6b059d36a82f`) | `/healthz` → `crankEnabled:true`, `schedulerActive:null` (як задумано), `tick` знову росте (relayer-петля відновлена) |

**Висновок:** `i64::MAX`-планувальник закриває №18 лише частково —
гарантує, що `Market.mark` ніколи не замерзне, якщо Railway впаде, але
**не є ліквідаційним backstop-ом сам по собі**: ліквідації вимагають
crank-ідентичності, яка подає `remaining_accounts`-пари `[Position,
UserAccount]`, а це вміє лише `services/relayer` (або ручний
`crank-fallback`). `crank-fallback`/relayer лишається обов'язковим для
ліквідацій незалежно від того, чи заведено `i64::MAX`-планувальник.

**Баланси:** `devnet-admin` до задачі `0.2507278 SOL` → дозарядка +0.15 SOL
з `payer` → `0.4007278 SOL` → після всіх транзакцій (schedule_crank,
2× set_params) `0.3507228 SOL`. `payer` (`spikes/keys/payer.json`)
`5.221662297 SOL` → `5.071657297 SOL`. Railway `crank`/`fee_payer`
баланси не змінились протягом вимірювання (`crankSol: 0.1`,
`feePayerSol: 0.202817912` до і після).
