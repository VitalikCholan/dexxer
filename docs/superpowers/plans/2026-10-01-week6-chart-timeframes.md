# Графік: 16 таймфреймів, матеріалізовані свічки, бекфіл Pyth Pro, атрибуція (C.5, частина 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /prices` relayer-а віддає свічки на всіх 16 таймфреймах TradingView (`1s`…`1M`), історія для старших tf довантажується з Pyth Pro History API, сирі тіки мають ретеншн, а графік апки перемикає всі 16 tf, малює `1s` з whitespace у порожніх секундах і показує логотип TradingView, як вимагає ліцензія lightweight-charts.

**Architecture:** чиста логіка бакетування (`bucketStart`/`prevBucket`/`tierOf`/`mergeCandles`) у двох TS-копіях — relayer і апка — запінена спільним golden-файлом `tests/fixtures/timeframes.golden.json`. Relayer матеріалізує три яруси свічок `1m/1h/1d` у Postgres (кожен тік оракула — один SQL з трьома upsert-ами), решта 12 tf зливаються з найближчого нижчого ярусу на запит; `1s` — із сирих тіків. Бекфіл — окремий модуль з інʼєкцією `fetch`, вмикається лише ключем, пише `source='pyth_pro'` з `ON CONFLICT DO NOTHING`. Апка накопичує WS-потік `mark` у локальний хвіст і згортає його в бакети (`foldMarks`), а для `1s` вставляє whitespace-точки.

**Tech Stack:** relayer — Node 24.18.0 (`.nvmrc` у корені), TypeScript/ESM, Express 5, `pg`, `node:test` (`node --import tsx --test`); апка — Expo/RN (Hermes), lightweight-charts 5.2.1 у WebView, `@tanstack/react-query`, `node:test`. Зовнішнє: Pyth Pro History API (`https://pyth.dourolabs.app/v1`, TradingView UDF).

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.10 (2.10.1 бакетування, 2.10.2 схема й запис, 2.10.3 бекфіл, 2.10.4 `/prices`, 2.10.5 App, 2.10.6 тести, 2.10.7 ризики). Контекст коду: `services/relayer/src/indexer/{candles,http,store,accounts}.ts`, `services/relayer/src/{db,env,health,index}.ts`, `app/src/features/chart/*`, `app/src/lib/indexer.ts`.

## Global Constraints

- Гілка `chart-timeframes` від `main` (`a9de283`; спека — `afa07c6`). Коміт після кожної задачі, `git add <paths>` поштучно, нічого не пушити без прохання. Повідомлення комітів англійською; документи — українською. Трейлери кожного коміту:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01SsDZpAwBNJzkFQwRZ7LXkA
  ```
- Node — `. "$HOME/.nvm/nvm.sh" && nvm use` у корені репо (24.18.0). Тести relayer-а: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl npm test` (базова лінія **244** = 237 + 7 Postgres skipped). Гейт апки — усі чотири: `cd app && npx tsc --noEmit && npm run lint:check && npm test && npm run format:check` (базова лінія **140**). Postgres-тести без `TEST_DATABASE_URL` — skipped (Docker на машині немає); писати їх однаково.
- Програма, `idl/`, `tests/er` (крім нового `tests/fixtures/`) — НЕ чіпати. `tests/fixtures/timeframes.golden.json` уже записано (не закомічено) — Task 1 його комітить.
- Індексер читає лише публічне: фід оракула і публічний історичний API того самого фіду. `PYTH_PRO_API_KEY` — секрет relayer-а, живе лише в env, ніколи в логах, відповідях, тестових фікстурах чи документах. Жодного ключа в репо.
- Форма відповіді `/prices` незмінна: `{ market, tf, candles: [{ t, o, h, l, c }] }`, o/h/l/c — числа 1e6, `t` — мс початку бакета. `source` не віддається. `/mark`, `/ws` — без змін.
- Таймфрейми — рівно `1s 1m 5m 15m 30m 1h 2h 4h 6h 8h 12h 24h 2D 5D 1W 1M` (ярлик `24h`, не `1D`). Яруси — `1m`, `1h`, `1d`. Будь-яка зміна списку — одночасно в обох копіях і в golden-файлі.
- Дати лише в UTC: `Date.UTC`, `getUTC*`; жодного локального часу в бакетуванні.
- UI апки — лише токени `app/src/theme/tokens.ts`, жодного hex. Екрани render-only, логіка — в чистих модулях з тестами.
- Нічого не стверджувати як перевірене на devnet/емуляторі, якщо не запускалось (Task 12 — лише з ключем і `railway up` від власника).

## Review Focus

1. **Запит старшого tf із майже порожньою таблицею.** `/prices?tf=1M&limit=1000` на ринку з трьома свічками `1d` → 200 і одна-дві свічки, не помилка і не 1000 порожніх — Task 3 (тест `candlesForTf` на короткому вході).
2. **Момент рівно на межі бакета.** `now` = понеділок 00:00:00.000 UTC або перше число 00:00:00.000 → `bucketStart` повертає `now`, `since` відлічує від нього — Task 1 (golden-вектори `1W`/`1M` на межі).
3. **Пізній тік у вже закритому бакеті.** Тік із `ts` молодшим за початок поточного бакета (повтор нотифікації TEE) не змінює `o`, лише `h/l/c` свого бакета — Task 2 (Postgres-тест upsert) і Task 8 (`foldMarks` ігнорує mark, старший за останню свічку).
4. **Крива відповідь Pyth Pro.** Масиви `t/o/h/l/c` різної довжини, `t` не на межі бакета, `s: "error"` → чанк відкинуто цілком з логом, нічого не записано — Task 5 (`parseUdfHistory`).
5. **Великий пропуск на `1s`.** Дві свічки з розривом у годину → whitespace не роздувається до 3600 точок: пропуск понад `WHITESPACE_MAX_GAP` бакетів лишається розривом — Task 9 (`fillWhitespace`).
6. **Columns/Baseline/HLC з whitespace.** Точка без `value` у `columns` не фарбується і не ламає `Math.min`; `baseline` бере першу РЕАЛЬНУ точку; `bars` для OHLC-рядка — лише реальні — Task 9 (`chartHtml.ts`, перевірка на AVD у Task 12).

---

### Task 1: relayer — `timeframes.ts` і golden-вектори

**Files:**
- Create: `services/relayer/src/indexer/timeframes.ts`
- Create: `services/relayer/test/timeframes.test.ts`
- Commit (already written): `tests/fixtures/timeframes.golden.json`

**Interfaces:**
- Produces:
  ```ts
  export const TIMEFRAMES: readonly ["1s","1m","5m","15m","30m","1h","2h","4h","6h","8h","12h","24h","2D","5D","1W","1M"];
  export type Tf = (typeof TIMEFRAMES)[number];
  export const TIERS: readonly ["1m","1h","1d"]; export type StoredTier = (typeof TIERS)[number];
  export type Tier = "ticks" | StoredTier;
  export const TIER_TF: Record<StoredTier, Tf>;            // {"1m":"1m","1h":"1h","1d":"24h"}
  export function isTf(v: unknown): v is Tf;
  export function bucketStart(tf: Tf, ms: number): number;
  export function prevBucket(tf: Tf, t: number): number;
  export function nthPrevBucket(tf: Tf, t: number, n: number): number;
  export function tierOf(tf: Tf): Tier;
  export interface CandleLike<P> { t: number; o: P; h: P; l: P; c: P }
  export function mergeCandles<P extends bigint | number>(lower: readonly CandleLike<P>[], tf: Tf): CandleLike<P>[];
  ```
  Tasks 2–5 and the app copy (Task 7) rely on exactly these names.

- [x] **Step 1: Write the failing test**

`services/relayer/test/timeframes.test.ts`:

```ts
// services/relayer/test/timeframes.test.ts
//
// The bucketing logic exists twice (relayer + app). This file and
// app/test/timeframes.test.ts both read tests/fixtures/timeframes.golden.json,
// so the two copies cannot drift apart silently (same pattern as hashes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TIMEFRAMES, TIERS, TIER_TF, bucketStart, isTf, mergeCandles, nthPrevBucket, prevBucket, tierOf, type Tf } from "../src/indexer/timeframes.js";

interface Golden { tf: Tf; iso: string; ms: number; bucketStart: number; prevBucket: number }
const golden = JSON.parse(readFileSync(new URL("../../../tests/fixtures/timeframes.golden.json", import.meta.url), "utf8")) as Golden[];

test("timeframes: exactly the 16 TradingView tfs, in display order", () => {
  assert.deepEqual([...TIMEFRAMES], ["1s", "1m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "24h", "2D", "5D", "1W", "1M"]);
  assert.ok(isTf("1W"));
  assert.ok(!isTf("1D"));
  assert.ok(!isTf(60));
});

test("timeframes: golden vectors (year boundary, leap February, Sunday→Monday, 2D/5D from the epoch)", () => {
  assert.ok(golden.length >= 14);
  for (const g of golden) {
    assert.equal(bucketStart(g.tf, g.ms), g.bucketStart, `${g.tf} bucketStart ${g.iso}`);
    assert.equal(prevBucket(g.tf, g.bucketStart), g.prevBucket, `${g.tf} prevBucket ${g.iso}`);
    assert.equal(bucketStart(g.tf, g.bucketStart), g.bucketStart, `${g.tf} bucketStart is idempotent`);
  }
});

test("timeframes: 1W buckets start on Monday 00:00 UTC, 1M on the 1st", () => {
  const monday = Date.UTC(2026, 9, 5); // 2026-10-05 is a Monday
  assert.equal(new Date(bucketStart("1W", monday + 3 * 86_400_000)).getUTCDay(), 1);
  assert.equal(bucketStart("1W", monday), monday);
  assert.equal(bucketStart("1M", Date.UTC(2026, 1, 15)), Date.UTC(2026, 1, 1));
  assert.equal(prevBucket("1M", Date.UTC(2026, 0, 1)), Date.UTC(2025, 11, 1));
});

test("timeframes: nthPrevBucket walks back n buckets (calendar-aware)", () => {
  assert.equal(nthPrevBucket("1M", Date.UTC(2026, 2, 1), 3), Date.UTC(2025, 11, 1));
  assert.equal(nthPrevBucket("1h", 10 * 3_600_000, 4), 6 * 3_600_000);
  assert.equal(nthPrevBucket("1s", 5_000, 0), 5_000);
});

test("timeframes: tierOf picks the nearest lower stored tier", () => {
  assert.equal(tierOf("1s"), "ticks");
  for (const tf of ["1m", "5m", "15m", "30m"] as const) assert.equal(tierOf(tf), "1m");
  for (const tf of ["1h", "2h", "4h", "6h", "8h", "12h"] as const) assert.equal(tierOf(tf), "1h");
  for (const tf of ["24h", "2D", "5D", "1W", "1M"] as const) assert.equal(tierOf(tf), "1d");
  assert.deepEqual([...TIERS], ["1m", "1h", "1d"]);
  assert.deepEqual(TIER_TF, { "1m": "1m", "1h": "1h", "1d": "24h" });
});

test("mergeCandles: o of the first, max h, min l, c of the last; groups by the target bucket", () => {
  const H = 3_600_000;
  const rows = [
    { t: 0, o: 10n, h: 12n, l: 9n, c: 11n },
    { t: H, o: 11n, h: 15n, l: 11n, c: 14n },
    { t: 2 * H, o: 14n, h: 14n, l: 8n, c: 9n }, // next 2h bucket
  ];
  assert.deepEqual(mergeCandles(rows, "2h"), [
    { t: 0, o: 10n, h: 15n, l: 9n, c: 14n },
    { t: 2 * H, o: 14n, h: 14n, l: 8n, c: 9n },
  ]);
  // plain numbers work the same way (the app's copy uses numbers)
  assert.deepEqual(mergeCandles([{ t: 0, o: 1, h: 3, l: 1, c: 2 }, { t: 60_000, o: 2, h: 2, l: 0, c: 1 }], "5m"), [{ t: 0, o: 1, h: 3, l: 0, c: 1 }]);
});

test("mergeCandles: 1d rows across a month boundary land in two 1M buckets", () => {
  const D = 86_400_000;
  const jan31 = Date.UTC(2026, 0, 31);
  const rows = [
    { t: jan31, o: 1n, h: 2n, l: 1n, c: 2n },
    { t: jan31 + D, o: 2n, h: 3n, l: 2n, c: 3n },
  ];
  const out = mergeCandles(rows, "1M");
  assert.equal(out.length, 2);
  assert.equal(out[0].t, Date.UTC(2026, 0, 1));
  assert.equal(out[1].t, Date.UTC(2026, 1, 1));
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/timeframes.test.ts`
Expected: FAIL — `Cannot find module '../src/indexer/timeframes.js'`.

- [x] **Step 3: Write the implementation**

`services/relayer/src/indexer/timeframes.ts`:

```ts
// services/relayer/src/indexer/timeframes.ts
//
// Spec §2.10.1. Pure: the 16 TradingView timeframes, bucket arithmetic
// (`1W` = Monday 00:00 UTC, `1M` = the 1st 00:00 UTC, everything else a
// fixed width from the epoch — `2D`/`5D` included), the stored tier each
// tf is derived from, and merging lower-tier candles into a tf.
//
// A byte-for-byte twin lives in app/src/features/chart/timeframes.ts; both
// are pinned by tests/fixtures/timeframes.golden.json. Change one → change
// the other and the fixture.
export const TIMEFRAMES = ["1s", "1m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "24h", "2D", "5D", "1W", "1M"] as const;
export type Tf = (typeof TIMEFRAMES)[number];

/** Materialised in Postgres (`candles.tf`). */
export const TIERS = ["1m", "1h", "1d"] as const;
export type StoredTier = (typeof TIERS)[number];
export type Tier = "ticks" | StoredTier;
/** The tf whose bucket width a stored tier has (`1d` rows are `24h` buckets). */
export const TIER_TF: Record<StoredTier, Tf> = { "1m": "1m", "1h": "1h", "1d": "24h" };

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

type FixedTf = Exclude<Tf, "1W" | "1M">;
const FIXED_MS: Record<FixedTf, number> = {
  "1s": S, "1m": MIN, "5m": 5 * MIN, "15m": 15 * MIN, "30m": 30 * MIN,
  "1h": H, "2h": 2 * H, "4h": 4 * H, "6h": 6 * H, "8h": 8 * H, "12h": 12 * H,
  "24h": D, "2D": 2 * D, "5D": 5 * D,
};

export function isTf(v: unknown): v is Tf {
  return typeof v === "string" && (TIMEFRAMES as readonly string[]).includes(v);
}

export function bucketStart(tf: Tf, ms: number): number {
  if (tf === "1W") {
    const day = Math.floor(ms / D) * D;
    const dow = new Date(day).getUTCDay(); // 0 = Sunday … 6 = Saturday
    return day - ((dow + 6) % 7) * D; // back to Monday
  }
  if (tf === "1M") {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const w = FIXED_MS[tf];
  return Math.floor(ms / w) * w;
}

/** Start of the bucket before the one starting at `t` (`t` must itself be a bucket start). */
export function prevBucket(tf: Tf, t: number): number {
  if (tf === "1M") {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  }
  if (tf === "1W") return t - 7 * D;
  return t - FIXED_MS[tf];
}

export function nthPrevBucket(tf: Tf, t: number, n: number): number {
  let x = t;
  for (let i = 0; i < n; i++) x = prevBucket(tf, x);
  return x;
}

export function tierOf(tf: Tf): Tier {
  switch (tf) {
    case "1s":
      return "ticks";
    case "1m": case "5m": case "15m": case "30m":
      return "1m";
    case "1h": case "2h": case "4h": case "6h": case "8h": case "12h":
      return "1h";
    default:
      return "1d";
  }
}

export interface CandleLike<P> {
  /** Bucket start, unix ms. */
  t: number;
  o: P;
  h: P;
  l: P;
  c: P;
}

/**
 * Merge ascending-by-`t` lower-tier candles into `tf` buckets: o of the
 * first, max h, min l, c of the last. Works for bigint (relayer) and number
 * (app) alike — `<`/`>` compare both.
 */
export function mergeCandles<P extends bigint | number>(lower: readonly CandleLike<P>[], tf: Tf): CandleLike<P>[] {
  const out: CandleLike<P>[] = [];
  for (const c of lower) {
    const t = bucketStart(tf, c.t);
    const last = out[out.length - 1];
    if (!last || last.t !== t) {
      out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c });
      continue;
    }
    if (c.h > last.h) last.h = c.h;
    if (c.l < last.l) last.l = c.l;
    last.c = c.c;
  }
  return out;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/timeframes.test.ts`
Expected: PASS, 7 tests. Then the full suite: `DEXXER_IDL_DIR=$PWD/../../idl npm test` → 251 (244 + 7).

- [x] **Step 5: Commit**

```bash
git add tests/fixtures/timeframes.golden.json services/relayer/src/indexer/timeframes.ts services/relayer/test/timeframes.test.ts
git commit -m "feat(relayer): timeframes module — 16 tfs, calendar buckets, tiers, mergeCandles; shared golden vectors"
```

---

### Task 2: relayer — міграція 009, три яруси на кожен тік, store-функції

**Files:**
- Create: `services/relayer/migrations/009_candles.sql`
- Modify: `services/relayer/src/indexer/store.ts` (`insertTick` body; new `listCandles`, `insertBackfillCandles`, `deleteTicksBefore`; new `CandleRow`)
- Test: `services/relayer/test/indexerDb.test.ts` (Postgres, skipped without `TEST_DATABASE_URL`), `services/relayer/test/candleSql.test.ts` (pure)

**Interfaces:**
- Consumes: `bucketStart`, `TIER_TF`, `StoredTier` (Task 1).
- Produces:
  ```ts
  export interface CandleRow { t: number; o: bigint; h: bigint; l: bigint; c: bigint }
  export function tickBucketParams(ts: number): [m1: number, h1: number, d1: number];   // pure, tested
  export async function insertTick(pool, row: TickRow & { market: string }): Promise<void>; // unchanged signature, now also upserts 1m/1h/1d
  export async function listCandles(pool, market: string, tier: StoredTier, sinceT: number): Promise<CandleRow[]>;
  export async function insertBackfillCandles(pool, market: string, tier: StoredTier, rows: CandleRow[]): Promise<number>; // rows inserted (DO NOTHING on conflict)
  export async function deleteTicksBefore(pool, cutoffTs: number): Promise<number>;
  ```

- [x] **Step 1: Write the failing pure test**

`services/relayer/test/candleSql.test.ts`:

```ts
// services/relayer/test/candleSql.test.ts — the pure half of store.ts's
// candle writes (bucket params per tick). The SQL itself is exercised in
// indexerDb.test.ts against a real Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tickBucketParams } from "../src/indexer/store.js";

test("tickBucketParams: 1m / 1h / 1d bucket starts of a tick's ts", () => {
  const ts = Date.UTC(2026, 9, 1, 13, 47, 12, 345);
  assert.deepEqual(tickBucketParams(ts), [Date.UTC(2026, 9, 1, 13, 47), Date.UTC(2026, 9, 1, 13), Date.UTC(2026, 9, 1)]);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/candleSql.test.ts`
Expected: FAIL — `tickBucketParams` is not exported.

- [x] **Step 3: Write the migration**

`services/relayer/migrations/009_candles.sql`:

```sql
-- services/relayer/migrations/009_candles.sql
--
-- Spec §2.10.2: materialised candle tiers. `tf` is one of the three STORED
-- tiers (1m/1h/1d); the other 13 timeframes are merged from these at read
-- time (indexer/http.ts `/prices`). `source` says who wrote the bucket first:
-- 'oracle' (our tick stream) or 'pyth_pro' (backfill.ts). A later oracle
-- tick on a pyth_pro bucket flips it to 'oracle' (store.ts upsert); the
-- backfill never overwrites anything (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS candles (
  market text NOT NULL,
  tf text NOT NULL CHECK (tf IN ('1m', '1h', '1d')),
  t bigint NOT NULL,
  o bigint NOT NULL,
  h bigint NOT NULL,
  l bigint NOT NULL,
  c bigint NOT NULL,
  source text NOT NULL CHECK (source IN ('oracle', 'pyth_pro')),
  PRIMARY KEY (market, tf, t)
);

-- One-off roll-up of every tick already stored (SOL since 22.09.2026, the
-- other markets since 29.09) into the three tiers, so no own history is
-- lost when retention (indexer/retention.ts) starts deleting old ticks.
-- bigint / bigint is integer division in Postgres, so (ts / ms) * ms is the
-- bucket start — the same arithmetic timeframes.ts uses for fixed widths.
INSERT INTO candles (market, tf, t, o, h, l, c, source)
SELECT
  k.market,
  w.tf,
  (k.ts / w.ms) * w.ms AS t,
  (array_agg(k.price ORDER BY k.ts ASC))[1] AS o,
  MAX(k.price) AS h,
  MIN(k.price) AS l,
  (array_agg(k.price ORDER BY k.ts DESC))[1] AS c,
  'oracle'
FROM ticks k
CROSS JOIN (VALUES ('1m', 60000::bigint), ('1h', 3600000::bigint), ('1d', 86400000::bigint)) AS w(tf, ms)
GROUP BY k.market, w.tf, (k.ts / w.ms) * w.ms
ON CONFLICT DO NOTHING;
```

- [x] **Step 4: Write the store changes**

In `services/relayer/src/indexer/store.ts`, add the import and replace `insertTick`; append the new functions:

```ts
import { TIER_TF, bucketStart, type StoredTier } from "./timeframes.js";

export interface CandleRow {
  /** Bucket start, unix ms. */
  t: number;
  o: bigint;
  h: bigint;
  l: bigint;
  c: bigint;
}

/** 1m / 1h / 1d bucket starts of a tick — the `$6..$8` of `insertTick`'s SQL. Pure (test/candleSql.test.ts). */
export function tickBucketParams(ts: number): [number, number, number] {
  return [bucketStart(TIER_TF["1m"], ts), bucketStart(TIER_TF["1h"], ts), bucketStart(TIER_TF["1d"], ts)];
}

/**
 * `market` is the registry symbol (`MarketInfo.symbol`, e.g. "SOL") — ticks are keyed `(market, ts)` since migration 008.
 * Spec §2.10.2: one round-trip writes the tick AND upserts its 1m/1h/1d
 * candle (o kept, h = GREATEST, l = LEAST, c = this price, source flips to
 * 'oracle'). Ticks arrive in `ts` order per market, so `c` is the latest.
 */
export async function insertTick(pool: DbPool, row: TickRow & { market: string }): Promise<void> {
  const [m1, h1, d1] = tickBucketParams(row.ts);
  await pool.query(
    `WITH tick AS (
       INSERT INTO ticks (market, ts, price, slot, publish_time) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (market, ts) DO UPDATE SET price = EXCLUDED.price, slot = EXCLUDED.slot, publish_time = EXCLUDED.publish_time
     )
     INSERT INTO candles (market, tf, t, o, h, l, c, source) VALUES
       ($1, '1m', $6, $3, $3, $3, $3, 'oracle'),
       ($1, '1h', $7, $3, $3, $3, $3, 'oracle'),
       ($1, '1d', $8, $3, $3, $3, $3, 'oracle')
     ON CONFLICT (market, tf, t) DO UPDATE SET
       h = GREATEST(candles.h, EXCLUDED.h), l = LEAST(candles.l, EXCLUDED.l), c = EXCLUDED.c, source = 'oracle'`,
    [row.market, row.ts, row.price.toString(), row.slot, row.publishTime, m1, h1, d1],
  );
}

export async function listCandles(pool: DbPool, market: string, tier: StoredTier, sinceT: number): Promise<CandleRow[]> {
  const { rows } = await pool.query<{ t: string; o: string; h: string; l: string; c: string }>(
    "SELECT t, o, h, l, c FROM candles WHERE market = $1 AND tf = $2 AND t >= $3 ORDER BY t ASC",
    [market, tier, sinceT],
  );
  return rows.map((r) => ({ t: Number(r.t), o: BigInt(r.o), h: BigInt(r.h), l: BigInt(r.l), c: BigInt(r.c) }));
}

/** Backfill rows (source 'pyth_pro'): never overwrite — an oracle candle, or an earlier backfill, wins. Returns how many were inserted. */
export async function insertBackfillCandles(pool: DbPool, market: string, tier: StoredTier, rows: CandleRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { rowCount } = await pool.query(
    `INSERT INTO candles (market, tf, t, o, h, l, c, source)
     SELECT $1, $2, unnest($3::bigint[]), unnest($4::bigint[]), unnest($5::bigint[]), unnest($6::bigint[]), unnest($7::bigint[]), 'pyth_pro'
     ON CONFLICT (market, tf, t) DO NOTHING`,
    [market, tier, rows.map((r) => r.t), rows.map((r) => r.o.toString()), rows.map((r) => r.h.toString()), rows.map((r) => r.l.toString()), rows.map((r) => r.c.toString())],
  );
  return rowCount ?? 0;
}

/** Retention (spec §2.10.2): raw ticks older than `cutoffTs` go; candles keep the history. Returns rows deleted. */
export async function deleteTicksBefore(pool: DbPool, cutoffTs: number): Promise<number> {
  const { rowCount } = await pool.query("DELETE FROM ticks WHERE ts < $1", [cutoffTs]);
  return rowCount ?? 0;
}
```

Update the header comment of `store.ts` (first paragraph): "four indexer tables" → "the indexer tables (migrations `001_indexer.sql`, `009_candles.sql`)".

- [x] **Step 5: Add the Postgres tests (skipped locally)**

Append to `services/relayer/test/indexerDb.test.ts` (extend the imports with `deleteTicksBefore, insertBackfillCandles, listCandles` from `../src/indexer/store.js`; extend `beforeEach`'s `TRUNCATE` to `TRUNCATE pool_snapshots, ticks, candles`):

```ts
// --- candles (migration 009, spec §2.10.2) ---

dbTest("insertTick upserts the 1m/1h/1d candle: o kept, h/l stretched, c latest, source oracle", async () => {
  const t0 = Date.UTC(2026, 9, 1, 12, 0, 5);
  await insertTick(pool, { market: "SOL", ts: t0, price: 100n, slot: 1, publishTime: t0 });
  await insertTick(pool, { market: "SOL", ts: t0 + 10_000, price: 120n, slot: 2, publishTime: t0 + 10_000 });
  await insertTick(pool, { market: "SOL", ts: t0 + 20_000, price: 90n, slot: 3, publishTime: t0 + 20_000 });
  const m1 = await listCandles(pool, "SOL", "1m", 0);
  assert.deepEqual(m1, [{ t: Date.UTC(2026, 9, 1, 12, 0), o: 100n, h: 120n, l: 90n, c: 90n }]);
  const h1 = await listCandles(pool, "SOL", "1h", 0);
  assert.equal(h1[0].t, Date.UTC(2026, 9, 1, 12));
  const d1 = await listCandles(pool, "SOL", "1d", 0);
  assert.equal(d1[0].t, Date.UTC(2026, 9, 1));
  const { rows } = await pool.query<{ source: string }>("SELECT source FROM candles WHERE market = 'SOL' AND tf = '1m'");
  assert.equal(rows[0].source, "oracle");
});

dbTest("insertTick: a late tick in an older bucket touches only that bucket's h/l/c", async () => {
  const t0 = Date.UTC(2026, 9, 1, 12, 0, 5);
  await insertTick(pool, { market: "SOL", ts: t0, price: 100n, slot: 1, publishTime: t0 });
  await insertTick(pool, { market: "SOL", ts: t0 + 60_000, price: 110n, slot: 2, publishTime: t0 + 60_000 });
  await insertTick(pool, { market: "SOL", ts: t0 + 1_000, price: 95n, slot: 3, publishTime: t0 + 1_000 }); // late, first bucket
  const m1 = await listCandles(pool, "SOL", "1m", 0);
  assert.equal(m1.length, 2);
  assert.deepEqual(m1[0], { t: Date.UTC(2026, 9, 1, 12, 0), o: 100n, h: 100n, l: 95n, c: 95n });
  assert.deepEqual(m1[1], { t: Date.UTC(2026, 9, 1, 12, 1), o: 110n, h: 110n, l: 110n, c: 110n });
});

dbTest("insertBackfillCandles never overwrites; a later oracle tick flips a pyth_pro bucket to oracle", async () => {
  const t = Date.UTC(2026, 9, 1, 12, 0);
  const n1 = await insertBackfillCandles(pool, "BTC", "1m", [{ t, o: 1n, h: 2n, l: 1n, c: 2n }, { t: t + 60_000, o: 2n, h: 3n, l: 2n, c: 3n }]);
  assert.equal(n1, 2);
  const n2 = await insertBackfillCandles(pool, "BTC", "1m", [{ t, o: 9n, h: 9n, l: 9n, c: 9n }]);
  assert.equal(n2, 0);
  assert.deepEqual((await listCandles(pool, "BTC", "1m", 0))[0], { t, o: 1n, h: 2n, l: 1n, c: 2n });
  await insertTick(pool, { market: "BTC", ts: t + 30_000, price: 5n, slot: 1, publishTime: t });
  const after = await listCandles(pool, "BTC", "1m", 0);
  assert.deepEqual(after[0], { t, o: 1n, h: 5n, l: 1n, c: 5n });
  const { rows } = await pool.query<{ source: string }>("SELECT source FROM candles WHERE market = 'BTC' AND tf = '1m' AND t = $1", [t]);
  assert.equal(rows[0].source, "oracle");
  // the oracle candle also blocks a later backfill of the same bucket
  assert.equal(await insertBackfillCandles(pool, "BTC", "1m", [{ t, o: 7n, h: 7n, l: 7n, c: 7n }]), 0);
});

dbTest("listCandles filters by market, tier and sinceT", async () => {
  const t = Date.UTC(2026, 9, 1);
  await insertBackfillCandles(pool, "ETH", "1d", [{ t, o: 1n, h: 1n, l: 1n, c: 1n }, { t: t + 86_400_000, o: 2n, h: 2n, l: 2n, c: 2n }]);
  await insertBackfillCandles(pool, "SOL", "1d", [{ t, o: 3n, h: 3n, l: 3n, c: 3n }]);
  assert.equal((await listCandles(pool, "ETH", "1d", t + 1)).length, 1);
  assert.equal((await listCandles(pool, "ETH", "1h", 0)).length, 0);
  assert.equal((await listCandles(pool, "SOL", "1d", 0)).length, 1);
});

dbTest("deleteTicksBefore removes only older ticks; the rolled-up candles stay", async () => {
  const t0 = Date.UTC(2026, 9, 1, 12, 0, 5);
  await insertTick(pool, { market: "SOL", ts: t0, price: 100n, slot: 1, publishTime: t0 });
  await insertTick(pool, { market: "SOL", ts: t0 + 60_000, price: 110n, slot: 2, publishTime: t0 + 60_000 });
  assert.equal(await deleteTicksBefore(pool, t0 + 1), 1);
  assert.equal((await listTicks(pool, "SOL", 0)).length, 1);
  assert.equal((await listCandles(pool, "SOL", "1m", 0)).length, 2);
});

dbTest("migration 009 rolls existing ticks up into 1m/1h/1d (applied on a table with rows)", async () => {
  // Re-run the roll-up statement against ticks inserted without candles to
  // prove the SQL (the real migration ran on an empty scratch DB in `before`).
  await pool.query("DELETE FROM candles");
  const t0 = Date.UTC(2026, 9, 1, 12, 0, 5);
  await pool.query("INSERT INTO ticks (market, ts, price, slot) VALUES ('SOL', $1, 100, 1), ('SOL', $2, 130, 2), ('SOL', $3, 80, 3)", [t0, t0 + 20_000, t0 + 3_600_000]);
  await pool.query("DELETE FROM candles");
  const sql = readFileSync(new URL("../migrations/009_candles.sql", import.meta.url), "utf8");
  await pool.query(sql.slice(sql.indexOf("INSERT INTO candles")));
  const m1 = await listCandles(pool, "SOL", "1m", 0);
  assert.deepEqual(m1.map((c) => [c.t, c.o, c.h, c.l, c.c]), [
    [Date.UTC(2026, 9, 1, 12, 0), 100n, 130n, 100n, 130n],
    [Date.UTC(2026, 9, 1, 13, 0), 80n, 80n, 80n, 80n],
  ]);
  assert.equal((await listCandles(pool, "SOL", "1h", 0)).length, 2);
  assert.equal((await listCandles(pool, "SOL", "1d", 0)).length, 1);
});
```

Add `import { readFileSync } from "node:fs";` to that test file. (The `INSERT INTO ticks` without `publish_time`/candles exercises the roll-up on rows that bypassed `insertTick`, exactly the state of the live table.)

- [x] **Step 6: Run the tests**

Run: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl npm test`
Expected: pure test PASS; the six new `dbTest`s report `skipped` (no `TEST_DATABASE_URL`); total 258 (245 passed + 13 skipped). If Docker is available: `docker run -d --rm -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:16-alpine` and `TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres DEXXER_IDL_DIR=$PWD/../../idl npm test` → all pass. Record which of the two actually ran in the commit body.

- [x] **Step 7: Commit**

```bash
git add services/relayer/migrations/009_candles.sql services/relayer/src/indexer/store.ts services/relayer/test/candleSql.test.ts services/relayer/test/indexerDb.test.ts
git commit -m "feat(relayer): candles table (1m/1h/1d) — migration 009 with tick roll-up, per-tick tier upsert, backfill insert, tick retention delete"
```

---

### Task 3: relayer — `/prices` на 16 таймфреймах

**Files:**
- Modify: `services/relayer/src/indexer/candles.ts` (tf-aware aggregation, `planPrices`, `candlesForTf`; `tfMsOf` removed)
- Modify: `services/relayer/src/indexer/http.ts:69-90` (`/prices` handler)
- Modify: `services/relayer/test/candles.test.ts`
- Create: `services/relayer/test/pricesRoute.test.ts`

**Interfaces:**
- Consumes: `Tf`, `isTf`, `TIMEFRAMES`, `bucketStart`, `nthPrevBucket`, `tierOf`, `mergeCandles`, `StoredTier` (Task 1); `listCandles`, `CandleRow` (Task 2).
- Produces:
  ```ts
  export interface Candle { t: number; o: bigint; h: bigint; l: bigint; c: bigint }      // unchanged
  export function newSeries(tf: Tf): CandleSeries;                                        // was (tfMs: number)
  export function aggregateCandles(ticks: { ts: number; price: bigint | number }[], tf: Tf, limit: number): Candle[];
  export type PricesPlan = { tier: "ticks"; since: number } | { tier: StoredTier; since: number };
  export function planPrices(tf: Tf, limit: number, now: number): PricesPlan;
  export function candlesForTf(rows: readonly CandleRow[], tf: Tf, limit: number): Candle[];
  ```

- [x] **Step 1: Update the existing candle tests and add the new ones**

In `services/relayer/test/candles.test.ts`: replace every `newSeries(60_000)` with `newSeries("1m")`, delete the `tfMsOf` test, change the import line to
`import { aggregateCandles, candlesForTf, newSeries, planPrices, pushTick, seriesCandles } from "../src/indexer/candles.js";`
and append:

```ts
test("aggregateCandles: 1s buckets from ticks ~2 s apart leave gaps, never synthesize", () => {
  const cs = aggregateCandles([{ ts: 1_000, price: 1n }, { ts: 3_200, price: 2n }, { ts: 5_900, price: 3n }], "1s", 1000);
  assert.deepEqual(cs.map((c) => c.t), [1_000, 3_000, 5_000]);
});

test("planPrices: 1s reads ticks (limit+1 seconds back); other tfs read their tier from limit buckets back", () => {
  const now = Date.UTC(2026, 9, 1, 12, 34, 56, 789);
  assert.deepEqual(planPrices("1s", 300, now), { tier: "ticks", since: now - 301_000 });
  assert.deepEqual(planPrices("5m", 2, now), { tier: "1m", since: Date.UTC(2026, 9, 1, 12, 20) }); // bucket 12:30, 2 back = 12:20
  assert.deepEqual(planPrices("12h", 1, now), { tier: "1h", since: Date.UTC(2026, 9, 1, 0) });
  assert.deepEqual(planPrices("1M", 3, now), { tier: "1d", since: Date.UTC(2026, 6, 1) });
  assert.deepEqual(planPrices("1W", 1, Date.UTC(2026, 9, 5)), { tier: "1d", since: Date.UTC(2026, 8, 28) }); // Monday exactly
});

test("candlesForTf: merges tier rows into the tf and keeps only the newest `limit`", () => {
  const H = 3_600_000;
  const rows = Array.from({ length: 30 }, (_, i) => ({ t: i * H, o: BigInt(i), h: BigInt(i + 1), l: BigInt(i), c: BigInt(i + 1) }));
  const out = candlesForTf(rows, "12h", 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].t, 12 * H);
  assert.deepEqual(out[1], { t: 24 * H, o: 24n, h: 30n, l: 24n, c: 30n });
});

test("candlesForTf: a sparse table returns what exists (1M with three 1d rows → one or two candles, no padding)", () => {
  const D = 86_400_000;
  const rows = [Date.UTC(2026, 8, 29), Date.UTC(2026, 8, 30), Date.UTC(2026, 9, 1)].map((t, i) => ({ t, o: BigInt(i), h: BigInt(i), l: BigInt(i), c: BigInt(i) }));
  const out = candlesForTf(rows, "1M", 1000);
  assert.deepEqual(out.map((c) => c.t), [Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1)]);
  assert.equal(rows[1].t - rows[0].t, D);
});
```

- [x] **Step 2: Write the route test**

`services/relayer/test/pricesRoute.test.ts`:

```ts
// services/relayer/test/pricesRoute.test.ts — `/prices` on all 16 tfs with a
// fake pg pool (records the SQL and returns no rows). The real SQL runs in
// indexerDb.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { indexerRouter } from "../src/indexer/http.js";
import type { DbPool } from "../src/db.js";
import { TIMEFRAMES } from "../src/indexer/timeframes.js";

function fakePool(calls: { sql: string; params: unknown[] }[]): DbPool {
  return { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } } as unknown as DbPool;
}

async function withRouter(calls: { sql: string; params: unknown[] }[], fn: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(indexerRouter(fakePool(calls), { markets: () => [] }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /prices: every one of the 16 tfs answers 200 with the unchanged shape", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  await withRouter(calls, async (url) => {
    for (const tf of TIMEFRAMES) {
      const res = await fetch(`${url}/prices?tf=${tf}&limit=5`);
      assert.equal(res.status, 200, tf);
      assert.deepEqual(await res.json(), { market: "SOL", tf, candles: [] });
    }
  });
  const ticks = calls.filter((c) => /FROM ticks/.test(c.sql));
  const candles = calls.filter((c) => /FROM candles/.test(c.sql));
  assert.equal(ticks.length, 1); // 1s only
  assert.equal(candles.length, 15);
  assert.deepEqual(candles.map((c) => c.params[1]), ["1m", "1m", "1m", "1m", "1h", "1h", "1h", "1h", "1h", "1h", "1d", "1d", "1d", "1d", "1d"]);
});

test("GET /prices: unknown tf → 400 listing every accepted tf; default tf is 1m", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  await withRouter(calls, async (url) => {
    const bad = await fetch(`${url}/prices?tf=7m`);
    assert.equal(bad.status, 400);
    const body = (await bad.json()) as { error: string };
    for (const tf of TIMEFRAMES) assert.ok(body.error.includes(tf), tf);
    const def = await fetch(`${url}/prices`);
    assert.equal(((await def.json()) as { tf: string }).tf, "1m");
  });
});
```

- [x] **Step 3: Run both test files to verify they fail**

Run: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/candles.test.ts test/pricesRoute.test.ts`
Expected: FAIL — `planPrices`/`candlesForTf` not exported; `tf=1W` → 400.

- [x] **Step 4: Rewrite `candles.ts`**

Replace the file with:

```ts
// services/relayer/src/indexer/candles.ts
//
// Pure candle aggregation — no DB, no network I/O (unit-tested directly in
// test/candles.test.ts). `pushTick` buckets a price tick into `tf` windows
// keyed by `bucketStart(tf, ts)` (timeframes.ts); a `Map` preserves
// insertion order in JS, so buckets come back ordered by first-seen time
// with no gaps ever synthesized for quiet periods (no empty buckets).
//
// Spec §2.10.4: `/prices` reads raw ticks only for `1s` (`aggregateCandles`);
// every other tf reads its stored tier (1m/1h/1d, store.ts `listCandles`)
// and merges it with `candlesForTf`. `planPrices` decides which, and how far
// back to read.
import { bucketStart, mergeCandles, nthPrevBucket, tierOf, type StoredTier, type Tf } from "./timeframes.js";
import type { CandleRow } from "./store.js";

export interface Candle {
  /** Bucket start, unix ms. */
  t: number;
  o: bigint;
  h: bigint;
  l: bigint;
  c: bigint;
}

export interface CandleSeries {
  tf: Tf;
  buckets: Map<number, Candle>;
}

export function newSeries(tf: Tf): CandleSeries {
  return { tf, buckets: new Map() };
}

export function pushTick(series: CandleSeries, ts: number, price: bigint | number): void {
  const p = typeof price === "bigint" ? price : BigInt(Math.trunc(price));
  const t = bucketStart(series.tf, ts);
  const existing = series.buckets.get(t);
  if (!existing) {
    series.buckets.set(t, { t, o: p, h: p, l: p, c: p });
    return;
  }
  existing.c = p;
  if (p > existing.h) existing.h = p;
  if (p < existing.l) existing.l = p;
}

/** Buckets in insertion (chronological) order; `limit` keeps only the most recent ones. */
export function seriesCandles(series: CandleSeries, limit?: number): Candle[] {
  const all = Array.from(series.buckets.values());
  return limit !== undefined ? all.slice(-limit) : all;
}

/** Aggregates a flat, ascending-by-ts tick list (as `store.ts::listTicks` returns) into up to `limit` candles for `tf`. */
export function aggregateCandles(ticks: { ts: number; price: bigint | number }[], tf: Tf, limit: number): Candle[] {
  const series = newSeries(tf);
  for (const tick of ticks) pushTick(series, tick.ts, tick.price);
  return seriesCandles(series, limit);
}

export type PricesPlan = { tier: "ticks"; since: number } | { tier: StoredTier; since: number };

/**
 * Where `/prices` reads from and since when. `1s`: raw ticks, `limit + 1`
 * seconds back (one bucket of margin). Others: the stored tier, from the
 * bucket `limit` tf-buckets before the current one — calendar-aware for
 * 1W/1M via `nthPrevBucket`.
 */
export function planPrices(tf: Tf, limit: number, now: number): PricesPlan {
  const tier = tierOf(tf);
  if (tier === "ticks") return { tier, since: now - (limit + 1) * 1000 };
  return { tier, since: nthPrevBucket(tf, bucketStart(tf, now), limit) };
}

/** Tier rows (ascending) → tf candles, newest `limit`. Returns whatever exists — never pads. */
export function candlesForTf(rows: readonly CandleRow[], tf: Tf, limit: number): Candle[] {
  return mergeCandles(rows, tf).slice(-limit);
}
```

- [x] **Step 5: Update the `/prices` handler in `http.ts`**

Replace the import `import { aggregateCandles, tfMsOf } from "./candles.js";` with
`import { aggregateCandles, candlesForTf, planPrices, type Candle } from "./candles.js";`,
add `import { TIMEFRAMES, isTf } from "./timeframes.js";`, add `listCandles` to the `./store.js` import, and replace the handler body (from `const tf = String(...)` to `res.json(...)`) with:

```ts
    const tf = String(req.query.tf ?? "1m");
    if (!isTf(tf)) {
      res.status(400).json({ error: `unknown tf: ${tf} (expected ${TIMEFRAMES.join("|")})` });
      return;
    }
    const limit = clampLimit(req.query.limit, 300, 1000);
    const plan = planPrices(tf, limit, Date.now());
    const candles: Candle[] =
      plan.tier === "ticks"
        ? aggregateCandles(await listTicks(pool, mq.value, plan.since), tf, limit)
        : candlesForTf(await listCandles(pool, mq.value, plan.tier, plan.since), tf, limit);
    res.json({ market: mq.value, tf, candles: candles.map((c) => ({ t: c.t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c) })) });
```

Update the file's header comment: `/prices` now serves 16 tfs; `1s` from ticks, the rest from `candles`.

- [x] **Step 6: Run the suite**

Run: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl npm test`
Expected: PASS, 263 (250 + 13 skipped). `npx tsc --noEmit -p services/relayer` clean (run from the repo root).

- [x] **Step 7: Commit**

```bash
git add services/relayer/src/indexer/candles.ts services/relayer/src/indexer/http.ts services/relayer/test/candles.test.ts services/relayer/test/pricesRoute.test.ts
git commit -m "feat(relayer): /prices serves all 16 timeframes — 1s from ticks, the rest merged from the stored tier"
```

---

### Task 4: relayer — ретеншн сирих тіків

**Files:**
- Create: `services/relayer/src/indexer/retention.ts`
- Modify: `services/relayer/src/index.ts` (start/stop inside the indexer block)
- Create: `services/relayer/test/retention.test.ts`

**Interfaces:**
- Consumes: `deleteTicksBefore` (Task 2), `envNum` (`src/env.ts`), `COMMIT_INTERVAL_MS` (`src/commit.ts`).
- Produces:
  ```ts
  export const TICKS_RETENTION_MS: number;                        // envNum("TICKS_RETENTION_MS", 604_800_000, 3_600_000)
  export function retentionCutoff(now: number, retentionMs: number): number;   // now - retentionMs
  export function startRetention(pool: DbPool, opts: { intervalMs: number; retentionMs?: number; now?: () => number; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval }): () => void;
  ```
  Note (spec deviation, recorded here): §2.10.2 says "in the commit cycle"; `crank.ts`'s cycle has no `DbPool` (its `pool` is the `Pool` PDA), so retention runs on its own timer in `index.ts` with the same period `COMMIT_INTERVAL_MS`. Same cadence, no plumbing of Postgres into the crank.

- [x] **Step 1: Write the failing test**

`services/relayer/test/retention.test.ts`:

```ts
// services/relayer/test/retention.test.ts — spec §2.10.2 tick retention.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DbPool } from "../src/db.js";
import { TICKS_RETENTION_MS, retentionCutoff, startRetention } from "../src/indexer/retention.js";

test("retention: default 7 days, cutoff = now - retention", () => {
  assert.equal(TICKS_RETENTION_MS, 7 * 24 * 3_600_000);
  assert.equal(retentionCutoff(10_000_000, 1_000), 9_999_000);
});

test("startRetention: deletes ticks older than the cutoff on every interval; a DB error is logged, not thrown; stop clears the timer", async () => {
  const deletes: unknown[][] = [];
  let fail = false;
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      if (fail) throw new Error("db down");
      deletes.push(params);
      return { rows: [], rowCount: 3 };
    },
  } as unknown as DbPool;
  let tick: (() => void) | null = null;
  let cleared = false;
  const fakeSetInterval = ((fn: () => void) => { tick = fn; return { unref: () => undefined } as unknown as NodeJS.Timeout; }) as unknown as typeof setInterval;
  const fakeClearInterval = () => { cleared = true; };
  const stop = startRetention(pool, { intervalMs: 1000, retentionMs: 500, now: () => 10_000, setInterval: fakeSetInterval, clearInterval: fakeClearInterval as unknown as typeof clearInterval });
  assert.ok(tick);
  const flush = () => new Promise<void>((r) => setImmediate(r)); // the interval callback fires `void run()`; let the DELETE settle
  (tick as unknown as () => void)();
  await flush();
  assert.deepEqual(deletes, [[9_500]]);
  fail = true;
  (tick as unknown as () => void)(); // must not reject or throw
  await flush();
  assert.deepEqual(deletes, [[9_500]]);
  stop();
  assert.ok(cleared);
});
```

- [x] **Step 2: Run to verify it fails**

Run: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/retention.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

`services/relayer/src/indexer/retention.ts`:

```ts
// services/relayer/src/indexer/retention.ts
//
// Spec §2.10.2: raw `ticks` serve only `1s` candles and `/mark`; the 1m/1h/1d
// candles (migration 009) hold the history, so ticks older than
// TICKS_RETENTION_MS are deleted every `intervalMs` (index.ts passes
// COMMIT_INTERVAL_MS — same cadence as the commit cycle, on its own timer
// because crank.ts's cycle has no Postgres handle). A failed DELETE is
// logged and retried next interval; it never affects ticks or commits.
import type { DbPool } from "../db.js";
import { envNum } from "../env.js";
import { deleteTicksBefore } from "./store.js";

/** Default 7 days; floor 1 hour (a `1s` chart of 1000 candles needs ~17 minutes). */
export const TICKS_RETENTION_MS = envNum("TICKS_RETENTION_MS", 7 * 24 * 3_600_000, 3_600_000);

export function retentionCutoff(now: number, retentionMs: number): number {
  return now - retentionMs;
}

export interface RetentionOpts {
  intervalMs: number;
  retentionMs?: number;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export function startRetention(pool: DbPool, opts: RetentionOpts): () => void {
  const retentionMs = opts.retentionMs ?? TICKS_RETENTION_MS;
  const now = opts.now ?? Date.now;
  const si = opts.setInterval ?? setInterval;
  const ci = opts.clearInterval ?? clearInterval;
  const run = async (): Promise<void> => {
    try {
      const n = await deleteTicksBefore(pool, retentionCutoff(now(), retentionMs));
      if (n > 0) console.log(`retention: deleted ${n} ticks older than ${retentionMs} ms`);
    } catch (e) {
      console.error("retention: delete failed", String(e));
    }
  };
  const timer = si(() => { void run(); }, opts.intervalMs);
  timer.unref?.();
  return () => ci(timer);
}
```

- [x] **Step 4: Wire into `index.ts`**

Inside the `else if (cfg.indexerEnabled && pool)` block, after `console.log("indexer: started …")`:

```ts
    const { startRetention, TICKS_RETENTION_MS } = await import("./indexer/retention.js");
    stopRetention = startRetention(pool, { intervalMs: COMMIT_INTERVAL_MS });
    console.log(`retention: ticks older than ${TICKS_RETENTION_MS} ms deleted every ${COMMIT_INTERVAL_MS} ms`);
```

Declare `let stopRetention: (() => void) | null = null;` next to `stopIndexer`, and call `stopRetention?.();` in `handleSignal` right after `stopIndexer?.();`.

- [x] **Step 5: Run the suite and type-check**

Run: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl npm test && cd ../.. && npx tsc --noEmit -p services/relayer`
Expected: PASS, 265 (252 + 13 skipped); tsc clean.

- [x] **Step 6: Commit**

```bash
git add services/relayer/src/indexer/retention.ts services/relayer/src/index.ts services/relayer/test/retention.test.ts
git commit -m "feat(relayer): raw tick retention (TICKS_RETENTION_MS, default 7 d) on the commit-cycle cadence"
```

---

### Task 5: relayer — бекфіл з Pyth Pro History API

**Files:**
- Create: `services/relayer/src/indexer/backfill.ts`
- Modify: `services/relayer/src/health.ts` (`BackfillSnapshot` in the payload)
- Modify: `services/relayer/src/index.ts` (start after the indexer, snapshot into `/healthz`, stop on signal)
- Create: `services/relayer/test/backfill.test.ts`
- Modify: `services/relayer/test/health.test.ts` (one assertion for the new field)

**Interfaces:**
- Consumes: `insertBackfillCandles`, `CandleRow` (Task 2); `TIER_TF`, `bucketStart`, `StoredTier` (Task 1); `envNum`; `MARKET_CATALOG` from `tests/er/lib/markets.ts` (`Record<string, { lazerFeedId: string; params }>`).
- Produces:
  ```ts
  export const PYTH_PRO_BASE = "https://pyth.dourolabs.app/v1";
  export const PYTH_PRO_CHANNEL = "fixed_rate@200ms";
  export const TIER_RESOLUTION: Record<StoredTier, string>;       // {"1m":"1","1h":"60","1d":"D"}
  export const TIER_CHUNK_MS: Record<StoredTier, number>;         // 2 d / 90 d / 400 d
  export interface BackfillEnv { apiKey: string | null; intervalMs: number; m1Days: number; h1Days: number; d1FromMs: number; requestGapMs: number }
  export function backfillEnvFromProcess(): BackfillEnv;
  export function resolveProSymbol(symbols: unknown, lazerFeedId: string): string | null;
  export function backfillWindows(now: number, env: BackfillEnv): { tier: StoredTier; fromMs: number; toMs: number }[];
  export function chunkRanges(fromMs: number, toMs: number, chunkMs: number): { fromMs: number; toMs: number }[];
  export function toScaled(x: number): bigint;                     // BigInt(Math.round(x * 1e6))
  export class UdfError extends Error {}
  export class AuthError extends Error {}
  export function parseUdfHistory(body: unknown, tier: StoredTier): { rows: CandleRow[]; misaligned: number };
  export interface BackfillDeps { pool: DbPool; env: BackfillEnv; markets: () => { symbol: string }[]; catalog: Record<string, { lazerFeedId: string }>; fetch: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void }
  export interface BackfillResult { rows: number; perMarket: Record<string, number>; skipped: string[]; errors: string[]; authFailed: boolean }
  export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult>;
  export interface BackfillSnapshot { enabled: boolean; lastRunAt: number | null; lastOkAt: number | null; lastError: string | null; rows: number }
  export function startBackfill(deps: BackfillDeps, timers?: { setInterval?: typeof setInterval; clearInterval?: typeof clearInterval }): { snapshot: () => BackfillSnapshot; stop: () => void };
  ```
  `health.ts`: `HealthPayload.backfill: BackfillSnapshot | null`, `buildHealthPayload(..., markets, backfill: BackfillSnapshot | null = null)`, `HealthDeps.getBackfillSnapshot?: () => BackfillSnapshot`.

- [x] **Step 1: Write the failing tests**

`services/relayer/test/backfill.test.ts`:

```ts
// services/relayer/test/backfill.test.ts — spec §2.10.3. Pyth Pro is faked
// through the injected `fetch`; Postgres through a fake pool that records
// the backfill INSERT params. No key value ever appears here — the fake key
// is a placeholder string and the test asserts it is sent only as a header.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DbPool } from "../src/db.js";
import {
  PYTH_PRO_BASE, PYTH_PRO_CHANNEL, TIER_CHUNK_MS, TIER_RESOLUTION, backfillEnvFromProcess, backfillWindows, chunkRanges,
  parseUdfHistory, resolveProSymbol, runBackfill, startBackfill, toScaled, UdfError, type BackfillEnv,
} from "../src/indexer/backfill.js";

const D = 86_400_000;
const NOW = Date.UTC(2026, 9, 2, 12); // 2026-10-02 12:00 UTC
const ENV: BackfillEnv = { apiKey: "test-key-placeholder", intervalMs: D, m1Days: 7, h1Days: 90, d1FromMs: Date.UTC(2025, 3, 1), requestGapMs: 0 };
const SYMBOLS = [
  { pyth_lazer_id: 6, symbol: "Crypto.SOL/USD" },
  { pyth_lazer_id: 110, symbol: "Crypto.HYPE/USD" },
  { pyth_lazer_id: 1, symbol: "Crypto.BTC/USD" },
];
const CATALOG = { SOL: { lazerFeedId: "6" }, HYPE: { lazerFeedId: "110" }, BTC: { lazerFeedId: "1" } };

test("backfillEnvFromProcess: disabled without a key; defaults 24 h / 7 d / 90 d / 2025-04-01 / 500 ms", () => {
  for (const k of ["PYTH_PRO_API_KEY", "BACKFILL_INTERVAL_MS", "BACKFILL_1M_DAYS", "BACKFILL_1H_DAYS", "BACKFILL_1D_FROM", "BACKFILL_REQUEST_GAP_MS"]) delete process.env[k];
  const e = backfillEnvFromProcess();
  assert.deepEqual(e, { apiKey: null, intervalMs: 86_400_000, m1Days: 7, h1Days: 90, d1FromMs: Date.UTC(2025, 3, 1), requestGapMs: 500 });
  process.env.PYTH_PRO_API_KEY = "  k  ";
  process.env.BACKFILL_1D_FROM = "2026-01-15";
  process.env.BACKFILL_INTERVAL_MS = "1000"; // below the 10 min floor → default
  const f = backfillEnvFromProcess();
  assert.equal(f.apiKey, "k");
  assert.equal(f.d1FromMs, Date.UTC(2026, 0, 15));
  assert.equal(f.intervalMs, 86_400_000);
  process.env.BACKFILL_1D_FROM = "not a date";
  assert.equal(backfillEnvFromProcess().d1FromMs, Date.UTC(2025, 3, 1));
  for (const k of ["PYTH_PRO_API_KEY", "BACKFILL_INTERVAL_MS", "BACKFILL_1D_FROM"]) delete process.env[k];
});

test("resolveProSymbol: by pyth_lazer_id, never by name; garbage → null", () => {
  assert.equal(resolveProSymbol(SYMBOLS, "110"), "Crypto.HYPE/USD");
  assert.equal(resolveProSymbol(SYMBOLS, "66"), null);
  assert.equal(resolveProSymbol({ not: "an array" }, "6"), null);
  assert.equal(resolveProSymbol([{ pyth_lazer_id: 6 }], "6"), null); // no symbol field
});

test("backfillWindows + chunkRanges: three tiers, chunked by TIER_CHUNK_MS, last chunk clipped to `to`", () => {
  const w = backfillWindows(NOW, ENV);
  assert.deepEqual(w.map((x) => x.tier), ["1m", "1h", "1d"]);
  assert.equal(w[0].fromMs, NOW - 7 * D);
  assert.equal(w[2].fromMs, Date.UTC(2025, 3, 1));
  const chunks = chunkRanges(0, 5 * D, 2 * D);
  assert.deepEqual(chunks, [{ fromMs: 0, toMs: 2 * D }, { fromMs: 2 * D, toMs: 4 * D }, { fromMs: 4 * D, toMs: 5 * D }]);
  assert.deepEqual(chunkRanges(5, 5, 10), []);
  assert.deepEqual(TIER_CHUNK_MS, { "1m": 2 * D, "1h": 90 * D, "1d": 400 * D });
  assert.deepEqual(TIER_RESOLUTION, { "1m": "1", "1h": "60", "1d": "D" });
  assert.deepEqual(backfillWindows(NOW, { ...ENV, m1Days: 0 }).map((x) => x.tier), ["1h", "1d"]);
});

test("parseUdfHistory: ok → 1e6-scaled rows; no_data → []; misaligned t dropped and counted; malformed → UdfError", () => {
  const t0 = Date.UTC(2026, 9, 1) / 1000;
  const ok = parseUdfHistory({ s: "ok", t: [t0, t0 + 86_400, t0 + 86_400 + 60], o: [1.5, 2, 3], h: [2, 3, 4], l: [1, 1.5, 2], c: [1.75, 2.5, 3.5] }, "1d");
  assert.equal(ok.misaligned, 1);
  assert.deepEqual(ok.rows, [
    { t: t0 * 1000, o: 1_500_000n, h: 2_000_000n, l: 1_000_000n, c: 1_750_000n },
    { t: (t0 + 86_400) * 1000, o: 2_000_000n, h: 3_000_000n, l: 1_500_000n, c: 2_500_000n },
  ]);
  assert.deepEqual(parseUdfHistory({ s: "no_data" }, "1m"), { rows: [], misaligned: 0 });
  assert.throws(() => parseUdfHistory({ s: "error", errmsg: "boom" }, "1m"), UdfError);
  assert.throws(() => parseUdfHistory({ s: "ok", t: [1, 2], o: [1], h: [1, 2], l: [1, 2], c: [1, 2] }, "1m"), UdfError); // lengths differ
  assert.throws(() => parseUdfHistory({ s: "ok", t: [60], o: ["1"], h: [1], l: [1], c: [1] }, "1m"), UdfError); // non-numeric
  assert.throws(() => parseUdfHistory(null, "1m"), UdfError);
  assert.equal(toScaled(123456.789012), 123_456_789_012n);
});

interface Call { url: string; auth: string | undefined }
function fakeFetch(calls: Call[], history: (url: URL) => unknown, symbolsStatus = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url: url.toString(), auth });
    if (url.pathname === "/v1/symbols") return new Response(JSON.stringify(SYMBOLS), { status: symbolsStatus });
    const body = history(url);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}
function fakePool(inserts: unknown[][]): DbPool {
  return { query: async (_sql: string, params: unknown[]) => { inserts.push(params); return { rows: [], rowCount: (params[2] as unknown[]).length }; } } as unknown as DbPool;
}

test("runBackfill: resolves symbols by lazer id, requests each tier with the bearer header, writes rows; unknown market skipped", async () => {
  const calls: Call[] = [];
  const inserts: unknown[][] = [];
  const t0 = Date.UTC(2026, 9, 1) / 1000;
  const res = await runBackfill({
    pool: fakePool(inserts), env: { ...ENV, m1Days: 1, h1Days: 1 }, now: () => NOW, log: () => undefined,
    markets: () => [{ symbol: "SOL" }, { symbol: "ZEC" }],
    catalog: CATALOG,
    fetch: fakeFetch(calls, (u) => {
      // the 1d window spans two 400-day chunks: only the chunk containing t0 has the row
      const from = Number(u.searchParams.get("from"));
      const to = Number(u.searchParams.get("to"));
      return u.searchParams.get("resolution") === "D" && from <= t0 && t0 < to
        ? { s: "ok", t: [t0], o: [100], h: [110], l: [90], c: [105] }
        : { s: "no_data" };
    }),
  });
  assert.equal(res.authFailed, false);
  assert.deepEqual(res.skipped, ["ZEC: not in MARKET_CATALOG"]);
  assert.deepEqual(res.errors, []);
  assert.equal(calls[0].url, `${PYTH_PRO_BASE}/symbols?asset_type=crypto`);
  assert.equal(calls[0].auth, undefined); // symbols are keyless
  const hist = calls.slice(1);
  assert.ok(hist.length >= 3);
  for (const h of hist) {
    assert.ok(h.url.startsWith(`${PYTH_PRO_BASE}/${PYTH_PRO_CHANNEL}/history?symbol=Crypto.SOL%2FUSD`), h.url);
    assert.equal(h.auth, "Bearer test-key-placeholder");
    assert.ok(!h.url.includes("test-key-placeholder")); // never in the URL
  }
  const d1 = inserts.filter((p) => p[1] === "1d");
  assert.equal(d1.length >= 1, true);
  const withRows = d1.find((p) => (p[2] as number[]).length === 1)!;
  assert.deepEqual(withRows.slice(0, 4), ["SOL", "1d", [t0 * 1000], ["100000000"]]);
  assert.equal(res.rows, 1);
  assert.deepEqual(res.perMarket, { SOL: 1 });
});

test("runBackfill: 401 marks authFailed and stops; 5xx on one tier is an isolated error", async () => {
  const inserts: unknown[][] = [];
  const unauthorized = await runBackfill({
    pool: fakePool(inserts), env: ENV, now: () => NOW, log: () => undefined, markets: () => [{ symbol: "SOL" }, { symbol: "BTC" }], catalog: CATALOG,
    fetch: fakeFetch([], () => new Response("nope", { status: 401 })),
  });
  assert.equal(unauthorized.authFailed, true);
  assert.equal(unauthorized.errors.length, 1); // stopped after the first
  assert.equal(inserts.length, 0);

  const flaky = await runBackfill({
    pool: fakePool(inserts), env: { ...ENV, m1Days: 1, h1Days: 1 }, now: () => NOW, log: () => undefined, markets: () => [{ symbol: "SOL" }], catalog: CATALOG,
    fetch: fakeFetch([], (u) => (u.searchParams.get("resolution") === "60" ? new Response("", { status: 503 }) : { s: "no_data" })),
  });
  assert.equal(flaky.authFailed, false);
  assert.equal(flaky.errors.length, 1);
  assert.match(flaky.errors[0], /^SOL 1h: HTTP 503/);
});

test("runBackfill: no key → skipped, no fetch; symbols endpoint down → one error, no history calls", async () => {
  let fetched = 0;
  const off = await runBackfill({ pool: fakePool([]), env: { ...ENV, apiKey: null }, markets: () => [{ symbol: "SOL" }], catalog: CATALOG, fetch: (async () => { fetched++; return new Response(""); }) as typeof fetch });
  assert.equal(fetched, 0);
  assert.deepEqual(off.skipped, ["disabled: PYTH_PRO_API_KEY not set"]);
  const calls: Call[] = [];
  const down = await runBackfill({ pool: fakePool([]), env: ENV, markets: () => [{ symbol: "SOL" }], catalog: CATALOG, log: () => undefined, fetch: fakeFetch(calls, () => ({ s: "no_data" }), 500) });
  assert.equal(calls.length, 1);
  assert.match(down.errors[0], /^symbols: /);
});

test("startBackfill: runs once immediately, then on the interval; snapshot tracks runs; auth failure stops scheduling", async () => {
  let runs = 0;
  let intervalFn: (() => void) | null = null;
  let cleared = false;
  const timers = {
    setInterval: ((fn: () => void) => { intervalFn = fn; return { unref: () => undefined } as unknown as NodeJS.Timeout; }) as unknown as typeof setInterval,
    clearInterval: (() => { cleared = true; }) as unknown as typeof clearInterval,
  };
  const status = { code: 200 };
  const deps = {
    pool: fakePool([]), env: ENV, now: () => NOW + runs, log: () => undefined, markets: () => [{ symbol: "SOL" }], catalog: CATALOG,
    fetch: fakeFetch([], () => { runs++; return status.code === 200 ? { s: "no_data" } : new Response("", { status: status.code }); }),
  };
  const b = startBackfill(deps, timers);
  await new Promise((r) => setImmediate(r));
  assert.equal(b.snapshot().enabled, true);
  assert.equal(b.snapshot().lastRunAt, NOW);
  assert.equal(b.snapshot().lastOkAt, NOW);
  assert.equal(b.snapshot().lastError, null);
  status.code = 401;
  (intervalFn as unknown as () => void)();
  await new Promise((r) => setImmediate(r));
  assert.equal(b.snapshot().enabled, false);
  assert.match(b.snapshot().lastError ?? "", /401/);
  assert.ok(cleared);
  b.stop();
});
```

Add to `services/relayer/test/health.test.ts`:

```ts
test("buildHealthPayload: backfill snapshot is null by default and passed through when given", () => {
  const state: RelayerState = { lastTickAt: 1, lastCommitAt: null, tick: 1, errors: [], marketTicks: {} };
  assert.equal(buildHealthPayload(state, 2, null, null, "ok").backfill, null);
  const snap = { enabled: true, lastRunAt: 5, lastOkAt: 5, lastError: null, rows: 12 };
  assert.deepEqual(buildHealthPayload(state, 2, null, null, "ok", undefined, undefined, true, null, 300_000, {}, snap).backfill, snap);
});
```

- [x] **Step 2: Run to verify failure**

Run: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/backfill.test.ts test/health.test.ts`
Expected: FAIL — module not found / `backfill` undefined.

- [x] **Step 3: Implement `backfill.ts`**

```ts
// services/relayer/src/indexer/backfill.ts
//
// Spec §2.10.3: history for the stored candle tiers from the Pyth Pro
// History API (TradingView UDF: GET /v1/{channel}/history?symbol=&resolution=
// &from=&to=, bearer key). Pyth Pro IS the Lazer feed our oracle republishes
// (MagicBlock's Pricing Oracle keeps no history), so the market → symbol
// resolution goes by Lazer feed id (`MARKET_CATALOG[symbol].lazerFeedId` ==
// `/v1/symbols[].pyth_lazer_id`, keyless), never by name.
//
// Rows are written with source 'pyth_pro' and ON CONFLICT DO NOTHING
// (store.ts `insertBackfillCandles`): an oracle candle always wins, and gaps
// from relayer downtime get patched. Enabled only by PYTH_PRO_API_KEY; the
// key is sent as a header only and never logged. A 401 disables the job
// until restart; anything else is logged per market×tier and retried on the
// next run. Public data in, public data out — the indexer's privacy rule holds.
import type { DbPool } from "../db.js";
import { envNum } from "../env.js";
import { insertBackfillCandles, type CandleRow } from "./store.js";
import { TIER_TF, bucketStart, type StoredTier } from "./timeframes.js";

export const PYTH_PRO_BASE = "https://pyth.dourolabs.app/v1";
/** ≥ `min_channel` of every market we list (HYPE: real_time, ZEC: fixed_rate@200ms). */
export const PYTH_PRO_CHANNEL = "fixed_rate@200ms";
export const TIER_RESOLUTION: Record<StoredTier, string> = { "1m": "1", "1h": "60", "1d": "D" };
const D = 86_400_000;
/** Per-request time span: ~2 880 / ~2 160 / ≤ 400 rows. */
export const TIER_CHUNK_MS: Record<StoredTier, number> = { "1m": 2 * D, "1h": 90 * D, "1d": 400 * D };

export interface BackfillEnv {
  apiKey: string | null;
  intervalMs: number;
  m1Days: number;
  h1Days: number;
  d1FromMs: number;
  requestGapMs: number;
}

export function backfillEnvFromProcess(): BackfillEnv {
  const key = process.env.PYTH_PRO_API_KEY?.trim() || null;
  const from = Date.parse(process.env.BACKFILL_1D_FROM ?? "");
  return {
    apiKey: key,
    intervalMs: envNum("BACKFILL_INTERVAL_MS", 86_400_000, 600_000),
    m1Days: envNum("BACKFILL_1M_DAYS", 7, 0),
    h1Days: envNum("BACKFILL_1H_DAYS", 90, 0),
    d1FromMs: Number.isFinite(from) ? from : Date.UTC(2025, 3, 1), // Pyth Pro history starts April 2025
    requestGapMs: envNum("BACKFILL_REQUEST_GAP_MS", 500, 0),
  };
}

export function resolveProSymbol(symbols: unknown, lazerFeedId: string): string | null {
  if (!Array.isArray(symbols)) return null;
  for (const s of symbols) {
    if (!s || typeof s !== "object") continue;
    const o = s as { pyth_lazer_id?: unknown; symbol?: unknown };
    if (String(o.pyth_lazer_id) === lazerFeedId && typeof o.symbol === "string") return o.symbol;
  }
  return null;
}

export interface BackfillWindow { tier: StoredTier; fromMs: number; toMs: number }

export function backfillWindows(now: number, env: BackfillEnv): BackfillWindow[] {
  const all: BackfillWindow[] = [
    { tier: "1m", fromMs: now - env.m1Days * D, toMs: now },
    { tier: "1h", fromMs: now - env.h1Days * D, toMs: now },
    { tier: "1d", fromMs: env.d1FromMs, toMs: now },
  ];
  return all.filter((w) => w.fromMs < w.toMs);
}

export function chunkRanges(fromMs: number, toMs: number, chunkMs: number): { fromMs: number; toMs: number }[] {
  const out: { fromMs: number; toMs: number }[] = [];
  for (let a = fromMs; a < toMs; a += chunkMs) out.push({ fromMs: a, toMs: Math.min(a + chunkMs, toMs) });
  return out;
}

export function toScaled(x: number): bigint {
  return BigInt(Math.round(x * 1e6));
}

export class UdfError extends Error {}
export class AuthError extends Error {}

/** TradingView UDF history body → tier rows. Rows whose `t` is not a bucket start of the tier are dropped (counted), the rest is 1e6-scaled. */
export function parseUdfHistory(body: unknown, tier: StoredTier): { rows: CandleRow[]; misaligned: number } {
  if (!body || typeof body !== "object") throw new UdfError("history: body is not an object");
  const o = body as Record<string, unknown>;
  if (o.s === "no_data") return { rows: [], misaligned: 0 };
  if (o.s !== "ok") throw new UdfError(`history: status ${String(o.s)}${typeof o.errmsg === "string" ? ` (${o.errmsg})` : ""}`);
  const cols = [o.t, o.o, o.h, o.l, o.c];
  if (!cols.every(Array.isArray)) throw new UdfError("history: t/o/h/l/c must be arrays");
  const [t, op, hi, lo, cl] = cols as unknown[][];
  const n = t.length;
  if (![op, hi, lo, cl].every((a) => a.length === n)) throw new UdfError("history: t/o/h/l/c lengths differ");
  const rows: CandleRow[] = [];
  let misaligned = 0;
  for (let i = 0; i < n; i++) {
    const vals = [t[i], op[i], hi[i], lo[i], cl[i]];
    if (!vals.every((v) => typeof v === "number" && Number.isFinite(v))) throw new UdfError(`history: row ${i} is not numeric`);
    const tMs = (t[i] as number) * 1000;
    if (bucketStart(TIER_TF[tier], tMs) !== tMs) {
      misaligned += 1;
      continue;
    }
    rows.push({ t: tMs, o: toScaled(op[i] as number), h: toScaled(hi[i] as number), l: toScaled(lo[i] as number), c: toScaled(cl[i] as number) });
  }
  return { rows, misaligned };
}

export interface BackfillDeps {
  pool: DbPool;
  env: BackfillEnv;
  markets: () => { symbol: string }[];
  catalog: Record<string, { lazerFeedId: string }>;
  fetch: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface BackfillResult {
  rows: number;
  perMarket: Record<string, number>;
  skipped: string[];
  errors: string[];
  /** 401 from Pyth Pro — the key is wrong or expired; the caller stops scheduling. */
  authFailed: boolean;
}

export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? console.log;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const result: BackfillResult = { rows: 0, perMarket: {}, skipped: [], errors: [], authFailed: false };
  if (!deps.env.apiKey) {
    result.skipped.push("disabled: PYTH_PRO_API_KEY not set");
    return result;
  }
  let symbols: unknown;
  try {
    const r = await deps.fetch(`${PYTH_PRO_BASE}/symbols?asset_type=crypto`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    symbols = await r.json();
  } catch (e) {
    result.errors.push(`symbols: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  for (const m of deps.markets()) {
    const entry = deps.catalog[m.symbol];
    if (!entry) {
      result.skipped.push(`${m.symbol}: not in MARKET_CATALOG`);
      continue;
    }
    const pro = resolveProSymbol(symbols, entry.lazerFeedId);
    if (!pro) {
      result.skipped.push(`${m.symbol}: no Pyth Pro symbol with pyth_lazer_id ${entry.lazerFeedId}`);
      continue;
    }
    for (const w of backfillWindows(now, deps.env)) {
      try {
        let inserted = 0;
        for (const ch of chunkRanges(w.fromMs, w.toMs, TIER_CHUNK_MS[w.tier])) {
          const url =
            `${PYTH_PRO_BASE}/${PYTH_PRO_CHANNEL}/history?symbol=${encodeURIComponent(pro)}` +
            `&resolution=${TIER_RESOLUTION[w.tier]}&from=${Math.floor(ch.fromMs / 1000)}&to=${Math.floor(ch.toMs / 1000)}`;
          const r = await deps.fetch(url, { headers: { Authorization: `Bearer ${deps.env.apiKey}` } });
          if (r.status === 401) throw new AuthError("HTTP 401 — PYTH_PRO_API_KEY rejected");
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const parsed = parseUdfHistory(await r.json(), w.tier);
          if (parsed.misaligned > 0) log(`backfill: ${m.symbol} ${w.tier} dropped ${parsed.misaligned} misaligned rows`);
          inserted += await insertBackfillCandles(deps.pool, m.symbol, w.tier, parsed.rows);
          if (deps.env.requestGapMs > 0) await sleep(deps.env.requestGapMs);
        }
        result.rows += inserted;
        result.perMarket[m.symbol] = (result.perMarket[m.symbol] ?? 0) + inserted;
        log(`backfill: ${m.symbol} ${w.tier} inserted=${inserted}`);
      } catch (e) {
        result.errors.push(`${m.symbol} ${w.tier}: ${e instanceof Error ? e.message : String(e)}`);
        if (e instanceof AuthError) {
          result.authFailed = true;
          return result;
        }
      }
    }
  }
  return result;
}

export interface BackfillSnapshot {
  enabled: boolean;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  /** Rows inserted by the last run. */
  rows: number;
}

/** Runs once now and then every `env.intervalMs`; a 401 disables further runs until restart. */
export function startBackfill(
  deps: BackfillDeps,
  timers: { setInterval?: typeof setInterval; clearInterval?: typeof clearInterval } = {},
): { snapshot: () => BackfillSnapshot; stop: () => void } {
  const si = timers.setInterval ?? setInterval;
  const ci = timers.clearInterval ?? clearInterval;
  const snap: BackfillSnapshot = { enabled: deps.env.apiKey !== null, lastRunAt: null, lastOkAt: null, lastError: null, rows: 0 };
  let timer: ReturnType<typeof setInterval> | null = null;
  const run = async (): Promise<void> => {
    const at = deps.now?.() ?? Date.now();
    snap.lastRunAt = at;
    try {
      const r = await runBackfill(deps);
      snap.rows = r.rows;
      for (const s of r.skipped) (deps.log ?? console.log)(`backfill: skipped ${s}`);
      if (r.errors.length === 0) {
        snap.lastOkAt = at;
        snap.lastError = null;
      } else {
        snap.lastError = r.errors.join("; ");
        for (const e of r.errors) console.error(`backfill: ${e}`);
      }
      if (r.authFailed) {
        snap.enabled = false;
        if (timer) ci(timer);
        timer = null;
      }
    } catch (e) {
      snap.lastError = e instanceof Error ? e.message : String(e);
      console.error("backfill: run failed", snap.lastError);
    }
  };
  if (snap.enabled) {
    void run();
    timer = si(() => { void run(); }, deps.env.intervalMs);
    (timer as { unref?: () => void }).unref?.();
  } else {
    console.log("backfill: PYTH_PRO_API_KEY not set — candle history accrues from oracle ticks only");
  }
  return { snapshot: () => ({ ...snap }), stop: () => { if (timer) ci(timer); timer = null; } };
}
```

- [x] **Step 4: `health.ts` and `index.ts`**

`health.ts`: `import type { BackfillSnapshot } from "./indexer/backfill.js";` add `backfill: BackfillSnapshot | null;` to `HealthPayload` (after `markets`), a trailing parameter `backfill: BackfillSnapshot | null = null` to `buildHealthPayload` (returned as `backfill`), `getBackfillSnapshot?: () => BackfillSnapshot;` to `HealthDeps`, and pass `deps.getBackfillSnapshot?.() ?? null` as the last argument in `healthRouter`.

`index.ts`, inside the indexer block after the retention lines (Task 4):

```ts
    const { startBackfill, backfillEnvFromProcess } = await import("./indexer/backfill.js");
    const { MARKET_CATALOG } = await import("../../../tests/er/lib/markets.js");
    backfill = startBackfill({ pool, env: backfillEnvFromProcess(), markets: () => markets.list(), catalog: MARKET_CATALOG, fetch: globalThis.fetch.bind(globalThis) });
```

Declare `let backfill: { snapshot: () => import("./indexer/backfill.js").BackfillSnapshot; stop: () => void } | null = null;` next to `stopIndexer`; add `getBackfillSnapshot: () => backfill?.snapshot() ?? { enabled: false, lastRunAt: null, lastOkAt: null, lastError: null, rows: 0 },` to `healthRouter({...})`; call `backfill?.stop();` in `handleSignal`.

- [x] **Step 5: Run the suite and type-check**

Run: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl npm test && cd ../.. && npx tsc --noEmit -p services/relayer`
Expected: PASS, 274 (261 + 13 skipped); tsc clean.

- [x] **Step 6: Commit**

```bash
git add services/relayer/src/indexer/backfill.ts services/relayer/src/health.ts services/relayer/src/index.ts services/relayer/test/backfill.test.ts services/relayer/test/health.test.ts
git commit -m "feat(relayer): Pyth Pro history backfill for 1m/1h/1d candles — keyed by Lazer feed id, source pyth_pro, DO NOTHING, /healthz.backfill"
```

---

### Task 6: relayer — README і `docs/deployments.md`

**Files:**
- Modify: `services/relayer/README.md` (`### REST API` — `/prices`; `## Env vars` — new rows; new `### Candles, retention, backfill` under `## Indexer (Task 5)`; `## Tests` — counts)
- Modify: `docs/deployments.md` (env table under `## Railway — services/relayer`: new rows; «Відкрите» — `ticks` retention closed)

- [x] **Step 1: README — `/prices`**

In `### REST API`, replace the `/prices` line with:

```
- `GET /prices?tf=<tf>&limit=<n>&market=<SYM>` — candles `{ market, tf, candles: [{ t, o, h, l, c }] }` (o/h/l/c 1e6-scaled numbers, `t` bucket start ms). `tf` is one of `1s 1m 5m 15m 30m 1h 2h 4h 6h 8h 12h 24h 2D 5D 1W 1M` (400 otherwise, the error lists them); `limit` default 300, max 1000. `1s` is aggregated from raw ticks (gaps where the oracle printed nothing); every other tf is merged at read time from the stored tier (`1m` → 1m…30m, `1h` → 1h…12h, `1d` → 24h…1M). `1W` buckets start Monday 00:00 UTC, `1M` on the 1st; `2D`/`5D` are fixed widths from the epoch.
```

- [x] **Step 2: README — new subsection**

After `### Oracle staleness …`, add:

```
### Candles, retention, backfill (spec §2.10, 01.10.2026)

Every oracle tick is one SQL round-trip (`store.ts` `insertTick`): the raw row into `ticks` and an upsert into the three stored candle tiers `candles(market, tf ∈ {1m,1h,1d}, t)` — `o` kept, `h`/`l` stretched, `c` = this price, `source = 'oracle'`. Migration `009_candles.sql` created the table and rolled every tick already stored into it once.

Raw ticks are kept `TICKS_RETENTION_MS` (default 7 days) — `indexer/retention.ts` deletes older ones every `COMMIT_INTERVAL_MS`. They serve only `/mark` and `tf=1s`; candles hold the history.

History before this relayer existed (and gaps while it was down) comes from the **Pyth Pro History API** (`indexer/backfill.ts`) — the same Pyth Lazer feeds the MagicBlock Pricing Oracle republishes, so it is the same price source, not an exchange. Enabled only when `PYTH_PRO_API_KEY` is set (free trial key from Pyth Terminal); without it candles simply accrue from ticks. The market → Pyth symbol mapping goes by Lazer feed id (`tests/er/lib/markets.ts` `MARKET_CATALOG[symbol].lazerFeedId` == keyless `GET /v1/symbols[].pyth_lazer_id`), never by name; a market missing from the catalog is skipped with a log line. Windows: resolution `1` for `BACKFILL_1M_DAYS`, `60` for `BACKFILL_1H_DAYS`, `D` from `BACKFILL_1D_FROM`; channel `fixed_rate@200ms`. Rows are written with `source = 'pyth_pro'` and `ON CONFLICT DO NOTHING` — an oracle candle always wins. Runs at start and every `BACKFILL_INTERVAL_MS`; a 401 disables it until restart. `/healthz.backfill` = `{ enabled, lastRunAt, lastOkAt, lastError, rows }`. The key is sent as a header only and never logged.
```

- [x] **Step 3: README — env rows**

Append to the `## Env vars` table:

```
| `TICKS_RETENTION_MS` | no (default `604800000` = 7 d, min `3600000`) | raw `ticks` older than this are deleted every `COMMIT_INTERVAL_MS` (candles keep the history) |
| `PYTH_PRO_API_KEY` | no | Pyth Pro History API bearer key — enables the candle backfill (`indexer/backfill.ts`). Unset = backfill off. Never log or commit it |
| `BACKFILL_INTERVAL_MS` | no (default `86400000`, min `600000`) | how often the backfill re-runs |
| `BACKFILL_1M_DAYS` / `BACKFILL_1H_DAYS` | no (default `7` / `90`) | how far back the `1m` / `1h` tiers are backfilled |
| `BACKFILL_1D_FROM` | no (default `2025-04-01`) | ISO date the `1d` tier is backfilled from (Pyth Pro history starts April 2025) |
| `BACKFILL_REQUEST_GAP_MS` | no (default `500`) | pause between Pyth Pro requests |
```

Update `## Tests` counts to the Task 5 numbers (274 = 261 + 13 Postgres skipped) and mention `TEST_DATABASE_URL` now also covers migration 009/candles.

- [x] **Step 4: `docs/deployments.md`**

In the Railway env table (section `## Railway — services/relayer`, the table that lists `COMMIT_INTERVAL_MS`), add rows (Ukrainian, same column shape as neighbours):

```
| `TICKS_RETENTION_MS` **(графік C.5, після деплою цього плану; необов'язкова)** | ретеншн сирих `ticks`: старші рядки видаляються кожні `COMMIT_INTERVAL_MS`; дефолт 604800000 (7 діб), мін. 3600000. Свічки `1m/1h/1d` (міграція 009) тримають історію | — |
| `PYTH_PRO_API_KEY` **(графік C.5; СЕКРЕТ)** | ключ Pyth Pro History API — вмикає бекфіл свічок (той самий Lazer-фід, що оракул). Без ключа бекфіл вимкнено, свічки накопичуються з тіків. Trial-ключ — Pyth Terminal | власник |
| `BACKFILL_INTERVAL_MS`, `BACKFILL_1M_DAYS`, `BACKFILL_1H_DAYS`, `BACKFILL_1D_FROM`, `BACKFILL_REQUEST_GAP_MS` **(необов'язкові)** | параметри бекфілу; дефолти 86400000 / 7 / 90 / `2025-04-01` / 500 | — |
```

In «Відкрите» of «Стан на кінець плану 4», change `ретеншн ticks` to `~~ретеншн ticks~~ (закрито планом C.5 — \`TICKS_RETENTION_MS\`, після деплою)`.

- [x] **Step 5: Commit**

```bash
git add services/relayer/README.md docs/deployments.md
git commit -m "docs(relayer): /prices timeframes, candle tiers, tick retention and Pyth Pro backfill env"
```

---

### Task 7: app — `timeframes.ts` (копія), golden-тест, типи `Tf` на 16 значень

**Files:**
- Create: `app/src/features/chart/timeframes.ts`
- Create: `app/test/timeframes.test.ts`
- Modify: `app/src/features/chart/chartData.ts` (drop `TF_MS`; re-export `Tf`; `withLiveMark` uses `bucketStart` until Task 8 replaces it)
- Modify: `app/src/lib/indexer.ts:97-105` (`useCandles` signature)
- Modify: `app/test/chartData.test.ts` (import of `Tf` if needed — no behaviour change)

**Interfaces:**
- Produces (identical names/semantics to Task 1 so the two copies stay twins; number-only is fine here, the generic stays):
  `TIMEFRAMES, Tf, TIERS, StoredTier, Tier, TIER_TF, isTf, bucketStart, prevBucket, nthPrevBucket, tierOf, CandleLike, mergeCandles` from `app/src/features/chart/timeframes.ts`.
  `chartData.ts` re-exports `type Tf` and `TIMEFRAMES`. `useCandles(symbol: string, tf: Tf = '1m', limit = 300)`.

- [x] **Step 1: Write the failing test**

`app/test/timeframes.test.ts` (CJS under tsx — `__dirname`, not `import.meta`):

```ts
// test/timeframes.test.ts — the app's copy of the bucketing logic must agree
// byte-for-byte with the relayer's (services/relayer/src/indexer/timeframes.ts):
// both read tests/fixtures/timeframes.golden.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { TIMEFRAMES, bucketStart, isTf, mergeCandles, nthPrevBucket, prevBucket, tierOf, type Tf } from '../src/features/chart/timeframes'

interface Golden { tf: Tf; iso: string; ms: number; bucketStart: number; prevBucket: number }
const golden = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'timeframes.golden.json'), 'utf8')) as Golden[]

test('timeframes: the 16 TradingView tfs in display order', () => {
  assert.deepEqual([...TIMEFRAMES], ['1s', '1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '24h', '2D', '5D', '1W', '1M'])
  assert.ok(isTf('2D'))
  assert.ok(!isTf('1D'))
})

test('timeframes: golden vectors shared with the relayer', () => {
  assert.ok(golden.length >= 14)
  for (const g of golden) {
    assert.equal(bucketStart(g.tf, g.ms), g.bucketStart, `${g.tf} ${g.iso}`)
    assert.equal(prevBucket(g.tf, g.bucketStart), g.prevBucket, `${g.tf} prev ${g.iso}`)
  }
})

test('timeframes: tiers and nthPrevBucket', () => {
  assert.equal(tierOf('1s'), 'ticks')
  assert.equal(tierOf('30m'), '1m')
  assert.equal(tierOf('12h'), '1h')
  assert.equal(tierOf('1M'), '1d')
  assert.equal(nthPrevBucket('1M', Date.UTC(2026, 2, 1), 2), Date.UTC(2026, 0, 1))
})

test('mergeCandles on numbers: o first, h max, l min, c last, grouped by the target bucket', () => {
  const M = 60_000
  const rows = [
    { t: 0, o: 1, h: 3, l: 1, c: 2 },
    { t: M, o: 2, h: 2, l: 0, c: 1 },
    { t: 5 * M, o: 1, h: 1, l: 1, c: 1 },
  ]
  assert.deepEqual(mergeCandles(rows, '5m'), [
    { t: 0, o: 1, h: 3, l: 0, c: 1 },
    { t: 5 * M, o: 1, h: 1, l: 1, c: 1 },
  ])
})
```

- [x] **Step 2: Run to verify it fails**

Run: `cd app && npm test -- test/timeframes.test.ts` (or `node --import tsx --import ./test/setup.ts --test test/timeframes.test.ts`)
Expected: FAIL — module not found.

- [x] **Step 3: Create the copy**

`app/src/features/chart/timeframes.ts` — the body of Task 1's file verbatim (same constants, functions, comments), with this header instead:

```ts
// app/src/features/chart/timeframes.ts
//
// Spec §2.10.1. The app's twin of services/relayer/src/indexer/timeframes.ts
// — same 16 tfs, same bucket arithmetic (1W = Monday 00:00 UTC, 1M = the
// 1st, everything else a fixed width from the epoch), same tiers. Pinned to
// the relayer's copy by tests/fixtures/timeframes.golden.json; change one →
// change the other and the fixture. UTC only (`Date.UTC`/`getUTC*`).
```

(No imports in this file. Prettier: single quotes, no semicolons — run `npm run format` on it.)

- [x] **Step 4: `chartData.ts` and `indexer.ts`**

In `chartData.ts`: delete the `TF_MS`/`Tf` lines; add
```ts
import { TIMEFRAMES, bucketStart, type Tf } from './timeframes'
export { TIMEFRAMES }
export type { Tf }
```
and in `withLiveMark` replace `const bucket = Math.floor(nowMs / TF_MS[tf]) * TF_MS[tf]` with `const bucket = bucketStart(tf, nowMs)`. Update the header comment: timeframes come from `timeframes.ts`.

In `indexer.ts`: `import type { Tf } from '@/src/features/chart/timeframes'` and `export function useCandles(symbol: string, tf: Tf = '1m', limit = 300)`. Update the doc comment: 16 tfs.

- [x] **Step 5: Gate**

Run: `cd app && npx tsc --noEmit && npm run lint:check && npm test && npm run format:check`
Expected: all clean; tests 144 (140 + 4). `ChartSection`/`TradeScreen` compile unchanged (`Tf` re-exported).

- [x] **Step 6: Commit**

```bash
git add app/src/features/chart/timeframes.ts app/test/timeframes.test.ts app/src/features/chart/chartData.ts app/src/lib/indexer.ts
git commit -m "feat(app): timeframes module (twin of the relayer's, golden-pinned); Tf widens to 16 values"
```

---

### Task 8: app — `foldMarks` і хвіст WS-марків замість `withLiveMark`

**Files:**
- Modify: `app/src/features/chart/chartData.ts` (`withLiveMark` → `foldMarks`, `MarkPoint`, `appendMark`, `MARK_TAIL_MAX`)
- Create: `app/src/features/chart/useMarkTail.ts`
- Modify: `app/src/features/chart/TradingChart.tsx` (uses `useMark(symbol)` + `useMarkTail`; `markUsd` prop removed)
- Modify: `app/src/features/trade/ChartSection.tsx` (`markUsd` prop removed), `app/src/features/trade/TradeScreen.tsx:185` (stop passing it)
- Modify: `app/test/chartData.test.ts` (`withLiveMark` tests → `foldMarks`/`appendMark`)

**Interfaces:**
- Consumes: `bucketStart`, `Tf` (Task 7); `useMark`, `Mark` (`app/src/lib/indexer.ts`).
- Produces:
  ```ts
  export interface MarkPoint { ts: number; price: number }           // raw 1e6 as number
  export const MARK_TAIL_MAX = 2000
  export function appendMark(tail: readonly MarkPoint[], mark: { ts: number | null; price: bigint | null } | undefined, max?: number): readonly MarkPoint[]
  export function foldMarks(candles: readonly Candle[], marks: readonly MarkPoint[], tf: Tf): Candle[]
  // useMarkTail.ts
  export function useMarkTail(mark: Mark | undefined, resetStamp: number): readonly MarkPoint[]
  ```

- [x] **Step 1: Write the failing tests**

In `app/test/chartData.test.ts` replace the three `withLiveMark` tests with:

```ts
test('foldMarks: marks in the last bucket update close and stretch high/low', () => {
  const candles = [c(10 * M, 100e6, 101e6, 99e6, 100e6)]
  assert.deepEqual(foldMarks(candles, [{ ts: 10 * M + 30_000, price: 103e6 }], '1m'), [c(10 * M, 100e6, 103e6, 99e6, 103e6)])
  assert.deepEqual(foldMarks(candles, [{ ts: 10 * M + 30_000, price: 98e6 }], '1m'), [c(10 * M, 100e6, 101e6, 98e6, 98e6)])
})

test('foldMarks: a later bucket opens a new candle at the last close; several marks fold in order', () => {
  const candles = [c(10 * M, 100e6, 101e6, 99e6, 100e6)]
  const out = foldMarks(candles, [{ ts: 12 * M + 5, price: 102e6 }, { ts: 12 * M + 9_000, price: 97e6 }, { ts: 13 * M, price: 99e6 }], '1m')
  assert.equal(out.length, 3)
  assert.deepEqual(out[1], c(12 * M, 100e6, 102e6, 97e6, 97e6))
  assert.deepEqual(out[2], c(13 * M, 97e6, 99e6, 97e6, 99e6))
})

test('foldMarks: a mark older than the newest candle is ignored (the fetch already covers it); no candles → candles from marks', () => {
  const candles = [c(10 * M, 1, 1, 1, 1)]
  assert.deepEqual(foldMarks(candles, [{ ts: 9 * M, price: 5 }], '1m'), candles)
  assert.deepEqual(foldMarks(candles, [], '1m'), candles)
  assert.deepEqual(foldMarks([], [{ ts: 1_500, price: 7 }, { ts: 2_500, price: 8 }], '1s'), [c(1_000, 7, 7, 7, 7), c(2_000, 7, 8, 7, 8)])
})

test('foldMarks: 1W folds marks of the same week into one bucket starting Monday', () => {
  const monday = Date.UTC(2026, 9, 5)
  const out = foldMarks([], [{ ts: monday + 86_400_000, price: 10 }, { ts: monday + 3 * 86_400_000, price: 12 }], '1W')
  assert.deepEqual(out, [c(monday, 10, 12, 10, 12)])
})

test('appendMark: dedups the same tick, drops null marks, caps the tail', () => {
  const t0 = appendMark([], { ts: 1, price: 5n })
  assert.deepEqual(t0, [{ ts: 1, price: 5 }])
  assert.equal(appendMark(t0, { ts: 1, price: 5n }), t0) // same reference, nothing appended
  assert.deepEqual(appendMark(t0, { ts: null, price: 6n }), t0)
  assert.deepEqual(appendMark(t0, undefined), t0)
  const long = appendMark(Array.from({ length: 3 }, (_, i) => ({ ts: i, price: i })), { ts: 9, price: 9n }, 3)
  assert.deepEqual(long.map((m) => m.ts), [1, 2, 9])
  assert.equal(MARK_TAIL_MAX, 2000)
})
```

Update that file's import line to `import { CHART_TYPES, MARK_TAIL_MAX, appendMark, ema, foldMarks, heikinAshi, isChartType, seriesFor } from '../src/features/chart/chartData'`.

- [x] **Step 2: Run to verify failure**

Run: `cd app && node --import tsx --import ./test/setup.ts --test test/chartData.test.ts`
Expected: FAIL — `foldMarks`/`appendMark` not exported.

- [x] **Step 3: Implement in `chartData.ts`**

Replace `withLiveMark` with:

```ts
/** One live mark from the indexer (`useMark`/WS), price raw 1e6 as a number. */
export interface MarkPoint {
  ts: number
  price: number
}

/** Upper bound on marks kept between two `/prices` fetches (1 s cadence → ~33 min). */
export const MARK_TAIL_MAX = 2000

/** Append the latest mark to the tail: nothing for a null/absent mark or an exact repeat of the last one; oldest dropped past `max`. */
export function appendMark(
  tail: readonly MarkPoint[],
  mark: { ts: number | null; price: bigint | null } | undefined,
  max = MARK_TAIL_MAX,
): readonly MarkPoint[] {
  if (!mark || mark.ts === null || mark.price === null) return tail
  const price = Number(mark.price)
  const last = tail[tail.length - 1]
  if (last && last.ts === mark.ts && last.price === price) return tail
  return [...tail, { ts: mark.ts, price }].slice(-max)
}

/**
 * Fold live marks into the candles (spec §2.10.5): a mark in the newest
 * bucket becomes its close and stretches high/low; a mark in a later bucket
 * opens a new candle at the previous close; a mark older than the newest
 * candle is ignored — the fetch that produced the candles already saw it.
 * With no candles the marks alone build the series (a fresh `1s` chart).
 */
export function foldMarks(candles: readonly Candle[], marks: readonly MarkPoint[], tf: Tf): Candle[] {
  const out = [...candles]
  for (const m of marks) {
    const t = bucketStart(tf, m.ts)
    const last = out[out.length - 1]
    if (last && t < last.t) continue
    if (last && t === last.t) {
      out[out.length - 1] = { ...last, c: m.price, h: Math.max(last.h, m.price), l: Math.min(last.l, m.price) }
      continue
    }
    const open = last ? last.c : m.price
    out.push({ t, o: open, h: Math.max(open, m.price), l: Math.min(open, m.price), c: m.price })
  }
  return out
}
```

`app/src/features/chart/useMarkTail.ts`:

```ts
// app/src/features/chart/useMarkTail.ts
//
// Marks seen since the last `/prices` fetch (spec §2.10.5). `useMark` holds
// only the LATEST mark; the chart needs every one of them between two
// candle fetches to keep `1s` (and the current bucket of any tf) live
// without hammering `/prices`. `resetStamp` is the candles query's
// `dataUpdatedAt`: a new fetch already contains these marks, so the tail
// restarts empty.
import { useEffect, useRef, useState } from 'react'
import type { Mark } from '@/src/lib/indexer'
import { appendMark, type MarkPoint } from './chartData'

export function useMarkTail(mark: Mark | undefined, resetStamp: number): readonly MarkPoint[] {
  const [tail, setTail] = useState<readonly MarkPoint[]>([])
  const stamp = useRef(resetStamp)
  useEffect(() => {
    // Reconcile with the external fetch clock, same justification as
    // `indexer.ts`'s `useIndexerWs` for this lint rule.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    if (stamp.current !== resetStamp) {
      stamp.current = resetStamp
      setTail([])
    }
  }, [resetStamp])
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setTail((prev) => appendMark(prev, mark))
  }, [mark])
  return tail
}
```

(If `expo lint` still flags the rule, keep the disable comments on the exact `setTail` lines — the pattern already exists in `indexer.ts`.)

- [x] **Step 4: `TradingChart.tsx`, `ChartSection.tsx`, `TradeScreen.tsx`**

`TradingChart.tsx`:
- imports: `import { useCandles, useMark } from '@/src/lib/indexer'`; `import { CHART_TYPES, TIMEFRAMES, ema, foldMarks, seriesFor, type ChartType, type Tf } from './chartData'`; `import { useMarkTail } from './useMarkTail'`.
- props: remove `markUsd`.
- body: delete `const TIMEFRAMES: Tf[] = ['1m', '5m', '15m']` (now imported), delete the `now`/`withLiveMark` lines; add
  ```ts
  const mark = useMark(symbol)
  const tail = useMarkTail(mark.data, candles.dataUpdatedAt)
  const merged = useMemo(() => foldMarks(candles.data ?? [], tail, tf), [candles.data, tail, tf])
  ```
- the tick effect's dependency `[markUsd]` → `[tail]`.
- header comment: "Only 1m / 5m / 15m …" → "All 16 timeframes; live marks fold in via `useMarkTail`."

`ChartSection.tsx`: remove the `markUsd` prop from `ChartSectionProps`, the destructuring and the `<TradingChart … markUsd={markUsd} …>` attribute.
`TradeScreen.tsx:185` area: remove `markUsd={markUsd}` from `<ChartSection …>` (keep `markUsd` for the header/ticket).

- [x] **Step 5: Gate**

Run: `cd app && npx tsc --noEmit && npm run lint:check && npm test && npm run format:check`
Expected: clean; tests 146 (144 − 3 + 5).

- [x] **Step 6: Commit**

```bash
git add app/src/features/chart/chartData.ts app/src/features/chart/useMarkTail.ts app/src/features/chart/TradingChart.tsx app/src/features/trade/ChartSection.tsx app/src/features/trade/TradeScreen.tsx app/test/chartData.test.ts
git commit -m "feat(app): fold the WS mark stream into candles (foldMarks + useMarkTail) — replaces the single-mark withLiveMark"
```

---

### Task 9: app — whitespace для порожніх секунд на `1s`

**Files:**
- Modify: `app/src/features/chart/chartData.ts` (`fillWhitespace`, `WHITESPACE_MAX_GAP`, `Whitespace` type; `SeriesData.data` may contain whitespace)
- Modify: `app/src/features/chart/chartHtml.ts` (whitespace-safe `setData`, `bars`, baseline, columns, hlc)
- Modify: `app/src/features/chart/TradingChart.tsx` (apply for `tf === '1s'`)
- Modify: `app/test/chartData.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Whitespace { time: number }                      // lightweight-charts whitespace item
  export const WHITESPACE_MAX_GAP = 1000
  export function fillWhitespace<P extends { time: number }>(points: readonly P[], stepSec: number, maxGap?: number): (P | Whitespace)[]
  export function isWhitespace(p: { time: number; value?: unknown; close?: unknown; high?: unknown }): p is Whitespace
  ```
  `SeriesData` becomes `{ kind: 'ohlc'; data: (OhlcPoint | Whitespace)[] } | { kind: 'value'; data: (ValuePoint | Whitespace)[] } | { kind: 'hlc'; data: (HlcPoint | Whitespace)[] }`.

- [x] **Step 1: Write the failing tests**

Append to `app/test/chartData.test.ts`:

```ts
test('fillWhitespace: inserts {time} items for missing steps; keeps real points; leaves gaps wider than maxGap alone', () => {
  const pts = [{ time: 10, value: 1 }, { time: 13, value: 2 }, { time: 14, value: 3 }, { time: 5000, value: 4 }]
  const out = fillWhitespace(pts, 1, 1000)
  assert.deepEqual(out.slice(0, 5), [{ time: 10, value: 1 }, { time: 11 }, { time: 12 }, { time: 13, value: 2 }, { time: 14, value: 3 }])
  assert.deepEqual(out[5], { time: 5000, value: 4 }) // 4986-step gap > maxGap: no fill
  assert.equal(out.length, 6)
  assert.deepEqual(fillWhitespace([], 1), [])
  assert.deepEqual(fillWhitespace([{ time: 7, value: 1 }], 1), [{ time: 7, value: 1 }])
  assert.ok(isWhitespace({ time: 11 }))
  assert.ok(!isWhitespace({ time: 11, value: 0 }))
  assert.equal(WHITESPACE_MAX_GAP, 1000)
})

test('fillWhitespace: non-1 steps and ohlc points', () => {
  const out = fillWhitespace([{ time: 0, open: 1, high: 1, low: 1, close: 1 }, { time: 120, open: 2, high: 2, low: 2, close: 2 }], 60)
  assert.deepEqual(out.map((p) => p.time), [0, 60, 120])
  assert.deepEqual(out[1], { time: 60 })
})
```

Add `WHITESPACE_MAX_GAP, fillWhitespace, isWhitespace` to the test's import.

- [x] **Step 2: Run to verify failure**

Run: `cd app && node --import tsx --import ./test/setup.ts --test test/chartData.test.ts`
Expected: FAIL — not exported.

- [x] **Step 3: Implement**

`chartData.ts` — add:

```ts
/** A lightweight-charts whitespace item: a slot on the time axis with nothing drawn. */
export interface Whitespace {
  time: number
}

/** Longest gap (in steps) that gets filled; wider gaps stay gaps so a lone old candle cannot create thousands of slots. */
export const WHITESPACE_MAX_GAP = 1000

export function isWhitespace(p: { time: number; value?: unknown; close?: unknown; high?: unknown }): p is Whitespace {
  return p.value === undefined && p.close === undefined && p.high === undefined
}

/**
 * `1s` (spec §2.10.5): the oracle prints every ~2 s, so about every other
 * second has no candle. Whitespace keeps the time axis uniform without
 * inventing prices — the relayer never synthesizes buckets, the client
 * only marks where they are missing.
 */
export function fillWhitespace<P extends { time: number }>(points: readonly P[], stepSec: number, maxGap = WHITESPACE_MAX_GAP): (P | Whitespace)[] {
  const out: (P | Whitespace)[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (i > 0) {
      const prev = points[i - 1].time
      const gap = Math.round((p.time - prev) / stepSec)
      if (gap > 1 && gap <= maxGap) for (let k = 1; k < gap; k++) out.push({ time: prev + k * stepSec })
    }
    out.push(p)
  }
  return out
}
```

and widen `SeriesData` as in Interfaces (the `seriesFor` return values are unchanged — they contain no whitespace; `TradingChart` adds it).

`TradingChart.tsx`:

```ts
const series = useMemo(() => {
  const s = seriesFor(prefs.type, merged)
  return tf === '1s' ? ({ ...s, data: fillWhitespace(s.data, 1) } as typeof s) : s
}, [prefs.type, merged, tf])
const emaPoints = useMemo(() => {
  if (!prefs.ema) return null
  const pts = ema(seriesFor('candles', merged).data as { time: number; close: number }[], EMA_PERIOD)
  return tf === '1s' ? fillWhitespace(pts, 1) : pts
}, [prefs.ema, merged, tf])
```

The tick effect sends `series.data[series.data.length - 1]` — the last item is always a real point (whitespace is only inserted between points).

`chartHtml.ts` — make `setData` whitespace-safe:

```js
  function real(p) { return p.value != null || p.close != null || p.high != null; }
  function setData(s) {
    kind = s.kind;
    if (s.kind === 'hlc') {
      series[0].setData(s.data.map(function (p) { return real(p) ? { time: p.time, value: p.high } : { time: p.time }; }));
      series[1].setData(s.data.map(function (p) { return real(p) ? { time: p.time, value: p.low } : { time: p.time }; }));
      series[2].setData(s.data.map(function (p) { return real(p) ? { time: p.time, value: p.close } : { time: p.time }; }));
    } else if (chartType === 'columns') {
      var vals = s.data.filter(real).map(function (p) { return p.value; });
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      main.applyOptions({ base: lo - (hi - lo) * 0.1 });
      var prevVal = null;
      main.setData(s.data.map(function (p) {
        if (!real(p)) return { time: p.time };
        var color = prevVal == null || p.value >= prevVal ? C.up : C.down;
        prevVal = p.value;
        return { time: p.time, value: p.value, color: color };
      }));
    } else {
      main.setData(s.data);
    }
    var firstReal = s.data.filter(real)[0];
    if (chartType === 'baseline' && firstReal) main.applyOptions({ baseValue: { type: 'price', price: firstReal.value } });
    bars = s.data.filter(real);
  }
```

`updatePoint` is unchanged (always a real point). `setEma(points)` passes whitespace through as is (`LineSeries.setData` accepts it). Update the file's header comment: series data may carry whitespace items (`1s`).

- [x] **Step 4: Gate**

Run: `cd app && npx tsc --noEmit && npm run lint:check && npm test && npm run format:check`
Expected: clean; tests 148.

- [x] **Step 5: Commit**

```bash
git add app/src/features/chart/chartData.ts app/src/features/chart/chartHtml.ts app/src/features/chart/TradingChart.tsx app/test/chartData.test.ts
git commit -m "feat(app): whitespace for empty 1s buckets — uniform time axis without synthesized prices"
```

---

### Task 10: app — 16 пілюль таймфреймів, автопрокрутка, логотип TradingView

**Files:**
- Modify: `app/src/features/chart/TradingChart.tsx` (toolbar)
- Modify: `app/src/features/chart/chartHtml.ts:43` (`attributionLogo: true`)
- Modify: `app/src/lib/indexer.ts` (`useCandles` refetch interval per tf)

**Interfaces:**
- Consumes: `TIMEFRAMES`, `Tf` (Task 7).
- Produces: `useCandles` refetches every 15 s for `1s`, 30 s otherwise (`candlesRefetchMs(tf)` exported for the test).

- [x] **Step 1: Write the failing test**

Create `app/test/candlesRefetch.test.ts` (`indexerWs.test.ts` already imports `../src/lib/indexer` under the same setup, so React/react-query load fine):

```ts
// test/candlesRefetch.test.ts — `/prices` refetch cadence per timeframe (`src/lib/indexer.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candlesRefetchMs } from '../src/lib/indexer'

test('candlesRefetchMs: 15 s for 1s, 30 s otherwise', () => {
  assert.equal(candlesRefetchMs('1s'), 15_000)
  assert.equal(candlesRefetchMs('1m'), 30_000)
  assert.equal(candlesRefetchMs('1M'), 30_000)
})
```

- [x] **Step 2: Run to verify failure, then implement**

`indexer.ts`:

```ts
/** `/prices` refetch cadence: the mark tail keeps the chart live in between, so `1s` only needs a fresh baseline a bit more often. */
export function candlesRefetchMs(tf: Tf): number {
  return tf === '1s' ? 15_000 : 30_000
}
export function useCandles(symbol: string, tf: Tf = '1m', limit = 300): UseQueryResult<Candle[]> {
  useIndexerWs()
  return useQuery({
    queryKey: QK.candles(symbol, tf),
    queryFn: () => getJson(`/prices?tf=${tf}&limit=${limit}&market=${encodeURIComponent(symbol)}`, parseCandles),
    staleTime: candlesRefetchMs(tf),
    refetchInterval: candlesRefetchMs(tf),
  })
}
```

`chartHtml.ts:43`: `attributionLogo: true` with the comment
`// Apache-2.0 NOTICE of lightweight-charts: the TradingView attribution must stay visible. The link opens in the system browser (TradingChart's onShouldStartLoadWithRequest).`

`TradingChart.tsx` toolbar — the first `ScrollView` becomes:

```tsx
const tfScroll = useRef<ScrollView>(null)
const tfX = useRef<Partial<Record<Tf, number>>>({})
useEffect(() => {
  const x = tfX.current[tf]
  if (x !== undefined) tfScroll.current?.scrollTo({ x: Math.max(0, x - space.xl), animated: true })
}, [tf, space.xl])
…
<ScrollView ref={tfScroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs }}>
  {TIMEFRAMES.map((t) => (
    <View key={t} onLayout={(e) => { tfX.current[t] = e.nativeEvent.layout.x }}>
      <Pill label={t} active={t === tf} onPress={() => onTfChange(t)} />
    </View>
  ))}
  …types pills unchanged…
</ScrollView>
```

(`space.xl` = 24 exists in `app/src/theme/tokens.ts`: `xs 4, sm 8, md 12, lg 16, xl 24, xxl 32`.)

- [x] **Step 3: Gate**

Run: `cd app && npx tsc --noEmit && npm run lint:check && npm test && npm run format:check`
Expected: clean; tests 149. Then `npx expo export --platform android` once to make sure the bundle builds (no device needed).

- [x] **Step 4: Commit**

```bash
git add app/src/features/chart/TradingChart.tsx app/src/features/chart/chartHtml.ts app/src/lib/indexer.ts app/test/candlesRefetch.test.ts
git commit -m "feat(app): all 16 timeframes in the chart toolbar, per-tf refetch, TradingView attribution logo back on (Apache-2.0)"
```

---

### Task 11: документи — CLAUDE.md, spec «Реалізовано», бек-лог C.5

**Files:**
- Modify: `CLAUDE.md` (new section «Правила тижня 6: графік — таймфрейми, свічки, бекфіл (01.10.2026, spec §2.10)»; «Документи» — this plan; test counts)
- Modify: `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.10 (append «**Реалізовано (relayer і app, <date>)**» — facts only: files, env, counts, the retention-timer deviation from §2.10.2, anything deferred)
- Modify: `docs/superpowers/plans/week6-backlog.md` C.5 — status line: tfs ✅ (relayer + app, not yet deployed), attribution ✅, volume/VWAP ⛔ (deliberate), deploy/smoke ⬜ until Task 12

- [ ] **Step 1: CLAUDE.md section** (Ukrainian, dense, same style as the neighbours):

```
## Правила тижня 6: графік — 16 таймфреймів, свічки, бекфіл (01.10.2026, spec §2.10; гілка `chart-timeframes`, лише тести — на devnet НЕ виміряно)
- **Таймфрейми — рівно 16:** `1s 1m 5m 15m 30m 1h 2h 4h 6h 8h 12h 24h 2D 5D 1W 1M`. Бакетування — `bucketStart`/`prevBucket`/`tierOf`/`mergeCandles` у ДВОХ копіях (`services/relayer/src/indexer/timeframes.ts`, `app/src/features/chart/timeframes.ts`), запінених `tests/fixtures/timeframes.golden.json`; `1W` — понеділок 00:00 UTC, `1M` — перше число, `2D`/`5D` — від епохи. Новий tf — в обидві копії і в golden-файл
- **Свічки — три яруси в Postgres** (`candles(market, tf ∈ {1m,1h,1d}, t)`, міграція 009 з одноразовим роллапом тіків): `insertTick` = тік + три upsert-и (`o` незмінне, `h`/`l` розтягуються, `c` новий, `source='oracle'`); `/prices` зливає похідні tf з ярусу на запит (`planPrices`/`candlesForTf`), `1s` — із сирих тіків. Форма відповіді `/prices` незмінна. Ретеншн `ticks` — `TICKS_RETENTION_MS` (7 діб), окремий таймер в `index.ts` з періодом `COMMIT_INTERVAL_MS` (не всередині коміт-циклу — у `crank.ts` немає `DbPool`)
- **Бекфіл — Pyth Pro History API** (`indexer/backfill.ts`), лише з `PYTH_PRO_API_KEY` (секрет relayer-а, лише header, ніколи в логах/URL); безключовий Pyth Benchmarks — 404 (01.10.2026). Ринок → символ за **Lazer feed id** (`MARKET_CATALOG` ↔ `/v1/symbols[].pyth_lazer_id`), не за назвою; `source='pyth_pro'`, `ON CONFLICT DO NOTHING` — свічка оракула завжди переважає. 401 вимикає бекфіл до рестарту. `/healthz.backfill`
- **App:** `foldMarks` згортає хвіст WS-марків (`useMarkTail`, скидається на кожен fetch) замість одного останнього; `1s` — whitespace-точки лише на клієнті (`fillWhitespace`, пропуск > 1000 бакетів не заповнюється); `attributionLogo: true` — вимога ліцензії lightweight-charts, не вимикати
- **Тести:** relayer <N> (<passed> + 13 Postgres skipped), app <N>; Postgres-тести міграції 009 локально не запускались (немає Docker)
```

Fill `<N>` with the real counts from Tasks 5 and 10.

- [ ] **Step 2: spec «Реалізовано»** — append under §2.10.7 a short «**Реалізовано (01.10.2026, лише тести)**» list: files per task; the two deviations from the design text — (a) retention runs on its own `index.ts` timer with the `COMMIT_INTERVAL_MS` period, not inside the crank cycle (no `DbPool` there), (b) «збережений tf валідовується» is moot: the app never persisted `tf` (plain `useState('1m')` in `TradeScreen`), so nothing was added; test counts; what Task 12 still has to measure.

- [ ] **Step 3: Backlog C.5** — one status line at the top of the item.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md docs/superpowers/plans/week6-backlog.md docs/superpowers/plans/2026-10-01-week6-chart-timeframes.md
git commit -m "docs(week6): chart timeframes — rules, spec implemented section, backlog C.5 status"
```

---

### Task 12: devnet — деплой relayer-а, перевірка `/prices`, бекфіл, smoke апки (гейти власника)

Nothing in this task runs without the owner: the Pyth Pro key, `railway up`, the APK. Record every measurement in `docs/superpowers/plans/week6-results.md` (new section «Графік C.5») and `docs/deployments.md`; record what was NOT run just as explicitly.

- [ ] **Step 1 (owner):** get a trial key in Pyth Terminal; set on Railway from the repo root: `railway variable set PYTH_PRO_API_KEY=<key> --service relayer </dev/null` (never paste the key into a file or a commit). Optionally `TICKS_RETENTION_MS` if a value other than 7 d is wanted.
- [ ] **Step 2 (owner):** `railway up --service relayer --ci` from the repo root (not `redeploy`).
- [ ] **Step 3:** deploy log — `db: applying migration 009_candles.sql` and its duration; first `retention: deleted N ticks` line (N ≈ 600k expected; note the time); `backfill: SOL 1d inserted=…` lines for the five markets, any `dropped … misaligned` or `skipped` lines. `/healthz` → `backfill.enabled true`, `lastOkAt` set, `lastError null`.
- [ ] **Step 4:** Postgres via `railway ssh --service Postgres -- psql -U postgres -d railway -c "SELECT tf, source, count(*) FROM candles GROUP BY 1,2 ORDER BY 1,2"` and `SELECT count(*) FROM ticks` before/after the first retention pass.
- [ ] **Step 5:** `/prices` for each of the 16 tfs × SOL/BTC/ETH/HYPE/ZEC: HTTP 200, `candles.length`, `t` strictly increasing, every `t` equal to `bucketStart(tf, t)` (a 20-line Node script in the scratchpad — `tests/er` must not grow for this); `1W`/`1M` of SOL reach back to April 2025; `tf=7m` → 400.
- [ ] **Step 6:** build the APK as in plan 4 (`docs/superpowers/plans/2026-10-01-week6-slots-deploy.md`, Task 6) and smoke on the AVD with fakewallet (`docs/emulator-runbook.md`): switch all 16 tfs on SOL and HYPE; `1s` shows gaps, not flat bars; EMA aligns; Columns/Baseline/HLC area on `1s` render (Review Focus 6); the TradingView logo is visible and opens the browser.
- [ ] **Step 7:** docs — `week6-results.md` section, `deployments.md` state (env set, migration/retention/backfill timings), CLAUDE.md section header drops «на devnet НЕ виміряно». Commit:

```bash
git add docs/superpowers/plans/week6-results.md docs/deployments.md CLAUDE.md
git commit -m "docs(week6): chart timeframes measured on devnet — migration 009, retention, backfill, /prices on 16 tfs, app smoke"
```
