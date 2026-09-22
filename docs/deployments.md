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
- `schedulerActive` у `/healthz` завжди `false` цього тижня — Task 7 його
  підключить.

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
