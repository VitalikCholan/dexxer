# Market Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five-symbol row on the Trade tab with a header market button, favourite chips and a full-screen markets screen (search, tabs, A–Z/24h sort, position markers, 16-slot counter), backed by a `name` field in `GET /markets` and a new cached `GET /tickers`.

**Architecture:** The relayer gains one pure function (`tickerFrom`) plus one route; the app gains pure list logic (`marketList.ts`, `favorites.ts`, `tickers.ts`) tested under `node --test`, thin React wrappers (`FavoritesProvider`, `MarketsScreen`, `MarketRow`, `AssetIcon`), and a root modal route `app/app/markets.tsx`. Prices come from the WebSocket cache that already exists; 24h change from `/tickers`; nothing per-market is fetched by REST.

**Tech Stack:** Relayer — Node 24.18, Express, `pg`, `node --test` via `tsx`. App — Expo 57 / React Native 0.86, expo-router, React Query 5, AsyncStorage, `node --test` with `test/setup.ts` stubs.

**Spec:** `docs/superpowers/specs/2026-10-05-market-selector-design.md`

## Global Constraints

- Starts only after PR #22 (`fix/ui-design-plans-01-04`) is merged into `main`: uses `colors.accentText`, `control.minHitTarget` (= 48), `radius.xl` (= 26), the `Button` variant `long`, `formatUsd2`.
- No server learns which market a trader looks at or favourites: no per-market REST request from the markets screen; favourites and sort live only in `AsyncStorage`.
- Never serve private data: `/tickers` is built only from stored oracle candles.
- UI reads only tokens (`docs/design/tokens.json` → `app/src/theme/tokens.ts`); no hex in components, except inside brand SVGs in `AssetIcon`.
- Numbers in rows use the numeric face (`useTextStyle(..., { mono: true })` / `Row mono`); prices are `$x.xx`, collateral amounts `x.xx dUSDC`.
- `change24h` is a fraction (`0.0083` = +0.83 %); `null` means "not enough history" and renders as `—`.
- Relayer tests: `cd services/relayer && PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH DEXXER_IDL_DIR=$PWD/../../idl npm test`.
- App gate (every app task): `cd app && PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH sh -c 'npm test && npx tsc --noEmit && npm run lint:check && npm run format:check'`.
- Code and commit messages in English; commits end with the repository's Co-Authored-By / Claude-Session lines.

## Review Focus

1. **Search input with spaces, mixed case or regex characters** (`"  Eth "`, `"("`, `"."`) — must trim, match case-insensitively and never throw. Pinned in Task 7 (`filterRows` tests).
2. **Open 24 h ago equal to 0** (a broken candle) — `change24h` must be `null`, not `Infinity`/`NaN`. Pinned in Task 2.
3. **A market with no candles yet** — row must show `—` for price and 24h, never `$0.00`. Pinned in Task 7 (`rowPrice` returns `null`) and Task 2.
4. **Favourites that are not in the registry** (delisted, or garbage in storage) — skipped in chips and the ★ tab, kept in storage, never crash. Pinned in Task 6 (`chipSymbols`, `parseFavorites`).
5. **`/markets` still loading or failed** — the screen shows the SOL fallback row, the header button still opens it. Pinned in Task 7 (`marketRows` with an empty registry yields the SOL fallback row).

---

### Task 0: Branch baseline

**Files:** none changed.

- [ ] **Step 1: Confirm PR #22 is merged and rebase**

```bash
cd /Users/vitalikcholan/Projects/mobile_perp_dex
gh pr view 22 --json state -q .state   # Expected: MERGED
git fetch origin main
git switch feat/market-selector
git rebase origin/main
```
Expected: rebase succeeds (the branch only adds the spec and this plan).

- [ ] **Step 2: Baseline tests are green**

Run the relayer test command and the app gate from Global Constraints.
Expected: all pass (app: 193+ tests; relayer: 295+ passed, Postgres tests skipped without `TEST_DATABASE_URL`).

---

### Task 1: Relayer — `name` in `GET /markets`

**Files:**
- Modify: `services/relayer/src/indexer/http.ts` (`IndexerRouterOpts`, `/markets` handler)
- Modify: `services/relayer/src/index.ts` (pass `names`)
- Create: `services/relayer/test/marketsName.test.ts`

**Interfaces:**
- Produces: `IndexerRouterOpts.names?: (symbol: string) => string | null`; `/markets` rows gain `name: string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// services/relayer/test/marketsName.test.ts — `/markets` carries each asset's display name.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import { indexerRouter } from "../src/indexer/http.js";
import type { DbPool } from "../src/db.js";
import type { MarketInfo } from "../src/markets.js";

const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as DbPool;
const m = (symbol: string): MarketInfo => ({
  symbol, market: Keypair.generate().publicKey, marketRisk: Keypair.generate().publicKey, feed: Keypair.generate().publicKey,
  params: { maxLevBps: 100_000, imrBps: 1_000, mmrBps: 500, openFeeBps: 6, closeFeeBps: 6, liqFeeBps: 100,
    oiCap: "0", maxPosition: "1", minSize: "1", maxStalenessSecs: "15", pausedOpen: false },
});

async function get(opts: Parameters<typeof indexerRouter>[1], path: string): Promise<unknown> {
  const app = express();
  app.use(indexerRouter(pool, opts));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
    return await res.json();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /markets: name from the asset table, null when the symbol is not there", async () => {
  const names: Record<string, string> = { ETH: "Ethereum" };
  const body = (await get({ markets: () => [m("ETH"), m("NEW")], names: (s) => names[s] ?? null }, "/markets")) as { symbol: string; name: string | null }[];
  assert.deepEqual(body.map((r) => [r.symbol, r.name]), [["ETH", "Ethereum"], ["NEW", null]]);
});

test("GET /markets: without a names lookup every name is null (additive field)", async () => {
  const body = (await get({ markets: () => [m("ETH")] }, "/markets")) as { name: string | null }[];
  assert.equal(body[0].name, null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/relayer && PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/marketsName.test.ts`
Expected: FAIL — `name` is `undefined`.

- [ ] **Step 3: Implement**

In `services/relayer/src/indexer/http.ts`, extend the options and the handler:

```ts
export interface IndexerRouterOpts {
  /** The market registry's current list (markets.ts) — `/markets` and the `?market=` whitelist. */
  markets: () => MarketInfo[];
  /** Display name per symbol (`assets/assets.json`); `null` when unknown. Absent → every name is `null`. */
  names?: (symbol: string) => string | null;
}
```

```ts
  router.get("/markets", (_req, res) => {
    const nameOf = opts.names ?? (() => null);
    res.json(
      opts.markets().map((m) => ({
        symbol: m.symbol,
        name: nameOf(m.symbol),
        market: m.market.toBase58(),
        feed: m.feed.toBase58(),
        params: m.params,
      })),
    );
  });
```

In `services/relayer/src/index.ts`, just before `app.use(indexerRouter(pool, { markets: () => markets.list() }));`, load the names independently of `ASSETS_ENABLED` (the file is in the repo; a broken file must not stop the indexer):

```ts
  let assetNames = new Map<string, string>();
  try {
    const { loadStaticAssets } = await import("./assets/staticAssets.js");
    assetNames = new Map([...loadStaticAssets()].map(([sym, a]) => [sym, a.name]));
  } catch (e) {
    console.warn(`indexer: assets.json unreadable, /markets names are null: ${(e as Error).message}`);
  }
  app.use(indexerRouter(pool, { markets: () => markets.list(), names: (s) => assetNames.get(s) ?? null }));
```
(Replace the existing `app.use(indexerRouter(...))` line with the block above.)

- [ ] **Step 4: Run the test and the whole relayer suite**

Run the single test again (Expected: PASS), then the relayer test command from Global Constraints (Expected: all pass; `test/markets.test.ts` still passes — it does not assert the absence of extra fields).

- [ ] **Step 5: Commit**

```bash
git add services/relayer/src/indexer/http.ts services/relayer/src/index.ts services/relayer/test/marketsName.test.ts
git commit -m "feat(relayer): asset display name in GET /markets"
```

---

### Task 2: Relayer — `tickerFrom` (pure)

**Files:**
- Create: `services/relayer/src/indexer/tickers.ts`
- Create: `services/relayer/test/tickers.test.ts`

**Interfaces:**
- Consumes: `CandleRow` (`src/indexer/store.ts`: `{ t: number; o: bigint; h: bigint; l: bigint; c: bigint }`, `t` = bucket start in unix ms).
- Produces:
  ```ts
  export const HOUR_MS = 3_600_000;
  export const DAY_MS = 86_400_000;
  export function tickerWindowStart(now: number): number; // hour bucket containing now − 24 h
  export interface Ticker { symbol: string; price: string | null; change24h: number | null; high24h: string | null; low24h: string | null }
  export function tickerFrom(symbol: string, candles: readonly CandleRow[], now: number): Ticker;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// services/relayer/test/tickers.test.ts — 24h ticker from the 1h candle tier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DAY_MS, HOUR_MS, tickerFrom, tickerWindowStart } from "../src/indexer/tickers.js";
import type { CandleRow } from "../src/indexer/store.js";

const now = Date.UTC(2026, 9, 5, 12, 30); // 12:30 UTC
const start = tickerWindowStart(now); // 11:00 UTC the day before
const c = (hoursFromStart: number, o: number, h: number, l: number, cl: number): CandleRow => ({
  t: start + hoursFromStart * HOUR_MS, o: BigInt(o), h: BigInt(h), l: BigInt(l), c: BigInt(cl),
});

test("tickerWindowStart is the hour bucket that contains now − 24h", () => {
  assert.equal(start, Date.UTC(2026, 9, 4, 12, 0));
  assert.ok(start <= now - DAY_MS && now - DAY_MS < start + HOUR_MS);
});

test("full 24h: change from the first open, high/low over the window, price = last close", () => {
  const t = tickerFrom("ETH", [c(0, 100_000_000, 105_000_000, 99_000_000, 101_000_000), c(24, 101_000_000, 120_000_000, 98_000_000, 110_000_000)], now);
  assert.deepEqual(t, { symbol: "ETH", price: "110000000", change24h: 0.1, high24h: "120000000", low24h: "98000000" });
});

test("under 24h of history: change is null, high/low over what exists", () => {
  const t = tickerFrom("NEW", [c(5, 100, 130, 90, 120)], now);
  assert.deepEqual(t, { symbol: "NEW", price: "120", change24h: null, high24h: "130", low24h: "90" });
});

test("no candles: everything null", () => {
  assert.deepEqual(tickerFrom("NEW", [], now), { symbol: "NEW", price: null, change24h: null, high24h: null, low24h: null });
});

test("open 24h ago of 0 never divides by zero", () => {
  const t = tickerFrom("BAD", [c(0, 0, 10, 0, 5), c(24, 5, 6, 4, 6)], now);
  assert.equal(t.change24h, null);
});

test("candles older than the window are ignored", () => {
  const t = tickerFrom("ETH", [c(-3, 1, 999, 1, 1), c(0, 100, 100, 100, 100), c(24, 100, 100, 100, 150)], now);
  assert.deepEqual([t.change24h, t.high24h], [0.5, "150"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/relayer && PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/tickers.test.ts`
Expected: FAIL — `Cannot find module '../src/indexer/tickers.js'`.

- [ ] **Step 3: Implement**

```ts
// services/relayer/src/indexer/tickers.ts
//
// One market's 24h ticker from the stored 1h candle tier (spec 2026-10-05
// market selector, §3.2). Pure: the route reads the candles, this does the
// arithmetic. Prices are 1e6 fixed point, served as decimal strings like the
// rest of the indexer; `change24h` is a plain fraction.
import type { CandleRow } from "./store.js";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Start of the hour bucket that contains `now − 24h` — the first candle of a full window. */
export function tickerWindowStart(now: number): number {
  return Math.floor((now - DAY_MS) / HOUR_MS) * HOUR_MS;
}

export interface Ticker {
  symbol: string;
  price: string | null;
  /** `(last close − open 24h ago) / open 24h ago`; `null` with under 24h of history or a zero open. */
  change24h: number | null;
  high24h: string | null;
  low24h: string | null;
}

export function tickerFrom(symbol: string, candles: readonly CandleRow[], now: number): Ticker {
  const start = tickerWindowStart(now);
  const w = candles.filter((x) => x.t >= start).sort((a, b) => a.t - b.t);
  if (w.length === 0) return { symbol, price: null, change24h: null, high24h: null, low24h: null };
  const first = w[0];
  const last = w[w.length - 1];
  let high = w[0].h;
  let low = w[0].l;
  for (const x of w) {
    if (x.h > high) high = x.h;
    if (x.l < low) low = x.l;
  }
  const full = first.t === start;
  const change24h = full && first.o > 0n ? Number(last.c - first.o) / Number(first.o) : null;
  return { symbol, price: last.c.toString(), change24h, high24h: high.toString(), low24h: low.toString() };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Same command. Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add services/relayer/src/indexer/tickers.ts services/relayer/test/tickers.test.ts
git commit -m "feat(relayer): 24h ticker from the 1h candle tier"
```

---

### Task 3: Relayer — `GET /tickers` with a 30 s cache

**Files:**
- Modify: `services/relayer/src/indexer/http.ts` (options, route)
- Modify: `services/relayer/src/index.ts` (`tickersCacheMs` from env)
- Modify: `services/relayer/README.md` (env table: `TICKERS_CACHE_MS`)
- Create: `services/relayer/test/tickersRoute.test.ts`

**Interfaces:**
- Consumes: `tickerFrom`, `tickerWindowStart`, `Ticker` (Task 2); `listCandles(pool, market, "1h", sinceT)` (`store.ts`); `knownSymbols` (http.ts).
- Produces: `IndexerRouterOpts.tickersCacheMs?: number` (default 30000), `IndexerRouterOpts.now?: () => number` (tests only); `GET /tickers` → `Ticker[]`, one per `knownSymbols(...)`, in that order.

- [ ] **Step 1: Write the failing test**

```ts
// services/relayer/test/tickersRoute.test.ts — GET /tickers: shape, cache, failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { indexerRouter, type IndexerRouterOpts } from "../src/indexer/http.js";
import type { DbPool } from "../src/db.js";
import { HOUR_MS, tickerWindowStart } from "../src/indexer/tickers.js";

const NOW = Date.UTC(2026, 9, 5, 12, 30);
const start = tickerWindowStart(NOW);

/** Fake pool: answers the 1h candle query with one full-window pair per market; counts calls; can be made to fail. */
function fakePool(state: { calls: number; fail: boolean }): DbPool {
  return {
    query: async (sql: string, params: unknown[]) => {
      state.calls++;
      if (state.fail) throw new Error("db down");
      assert.match(sql, /FROM candles/);
      assert.equal(params[1], "1h");
      return { rows: [
        { t: String(start), o: "100", h: "110", l: "90", c: "100" },
        { t: String(start + 24 * HOUR_MS), o: "100", h: "130", l: "95", c: "120" },
      ], rowCount: 2 };
    },
  } as unknown as DbPool;
}

async function withRouter(pool: DbPool, opts: Partial<IndexerRouterOpts>, fn: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(indexerRouter(pool, { markets: () => [], now: () => NOW, ...opts }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /tickers: one ticker per known market (SOL even with an empty registry)", async () => {
  const state = { calls: 0, fail: false };
  await withRouter(fakePool(state), {}, async (url) => {
    const res = await fetch(`${url}/tickers`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ symbol: "SOL", price: "120", change24h: 0.2, high24h: "130", low24h: "90" }]);
  });
});

test("GET /tickers: served from the cache inside the window, one DB round per refresh", async () => {
  const state = { calls: 0, fail: false };
  await withRouter(fakePool(state), { tickersCacheMs: 30_000 }, async (url) => {
    await fetch(`${url}/tickers`);
    await fetch(`${url}/tickers`);
    assert.equal(state.calls, 1);
  });
});

test("GET /tickers: DB failure with no cache → 503", async () => {
  const state = { calls: 0, fail: true };
  await withRouter(fakePool(state), {}, async (url) => {
    const res = await fetch(`${url}/tickers`);
    assert.equal(res.status, 503);
  });
});

test("GET /tickers: DB failure after a good answer → the last cached answer", async () => {
  const state = { calls: 0, fail: false };
  let now = NOW;
  await withRouter(fakePool(state), { tickersCacheMs: 5_000, now: () => now }, async (url) => {
    const good = await (await fetch(`${url}/tickers`)).json();
    state.fail = true;
    now += 60_000; // cache expired
    const res = await fetch(`${url}/tickers`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), good);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/relayer && PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH DEXXER_IDL_DIR=$PWD/../../idl node --import tsx --test test/tickersRoute.test.ts`
Expected: FAIL — 404 on `/tickers` and a type error on `now`/`tickersCacheMs`.

- [ ] **Step 3: Implement**

In `http.ts`, add the import and extend the options:

```ts
import { tickerFrom, tickerWindowStart, type Ticker } from "./tickers.js";
```

```ts
export interface IndexerRouterOpts {
  /** The market registry's current list (markets.ts) — `/markets` and the `?market=` whitelist. */
  markets: () => MarketInfo[];
  /** Display name per symbol (`assets/assets.json`); `null` when unknown. Absent → every name is `null`. */
  names?: (symbol: string) => string | null;
  /** `/tickers` cache lifetime (ms); default 30000. */
  tickersCacheMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}
```

Inside `indexerRouter`, after the `/mark` route:

```ts
  // One answer for every client (no params): it says nothing about which
  // market anyone looks at. Cached so a screen open costs no DB round trip.
  const tickersTtl = opts.tickersCacheMs ?? 30_000;
  const clock = opts.now ?? Date.now;
  let tickersCache: { at: number; body: Ticker[] } | null = null;
  router.get("/tickers", async (_req, res) => {
    const now = clock();
    if (tickersCache && now - tickersCache.at < tickersTtl) {
      res.json(tickersCache.body);
      return;
    }
    try {
      const since = tickerWindowStart(now);
      const body: Ticker[] = [];
      for (const symbol of known()) body.push(tickerFrom(symbol, await listCandles(pool, symbol, "1h", since), now));
      tickersCache = { at: now, body };
      res.json(body);
    } catch (e) {
      if (tickersCache) {
        res.json(tickersCache.body);
        return;
      }
      res.status(503).json({ error: `tickers unavailable: ${(e as Error).message}` });
    }
  });
```

In `index.ts`, extend the call from Task 1:

```ts
  app.use(
    indexerRouter(pool, {
      markets: () => markets.list(),
      names: (s) => assetNames.get(s) ?? null,
      tickersCacheMs: envNum("TICKERS_CACHE_MS", 30_000, 5_000),
    }),
  );
```
(`envNum` is already imported in `index.ts`.)

In `services/relayer/README.md`, add a row to the env table next to `ASSETS_CACHE_MS`:

```
| `TICKERS_CACHE_MS` | 30000 (min 5000) | Lifetime of the in-memory `/tickers` answer (24h change for every market, from the 1h candles). |
```

- [ ] **Step 4: Run the test and the whole relayer suite**

Single test: Expected PASS (4 tests). Full relayer command: Expected all pass.

- [ ] **Step 5: Commit**

```bash
git add services/relayer/src/indexer/http.ts services/relayer/src/index.ts services/relayer/README.md services/relayer/test/tickersRoute.test.ts
git commit -m "feat(relayer): GET /tickers - 24h change for every market, cached 30 s"
```

---

### Task 4: App — `name` in `MarketInfo`

**Files:**
- Modify: `app/src/lib/markets.ts` (`MarketInfo`, `parseMarkets`)
- Modify: `app/test/markets.test.ts`

**Interfaces:**
- Produces: `MarketInfo.name: string | null`.

- [ ] **Step 1: Write the failing test** (append to `app/test/markets.test.ts`)

```ts
test('parseMarkets: name is optional — a string, null, or absent (old relayer) → null', () => {
  const out = parseMarkets([{ ...row('SOL'), name: 'Solana' }, { ...row('BTC'), name: null }, row('ETH')])
  assert.deepEqual(
    out.map((m) => [m.symbol, m.name]),
    [
      ['SOL', 'Solana'],
      ['BTC', null],
      ['ETH', null],
    ],
  )
})

test('parseMarkets: a non-string name is a shape error', () => {
  assert.throws(() => parseMarkets([{ ...row('SOL'), name: 42 }]), IndexerShapeError)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH node --import tsx --import ./test/setup.ts --test test/markets.test.ts`
Expected: FAIL — `m.name` is `undefined`.

- [ ] **Step 3: Implement**

In `MarketInfo` (`app/src/lib/markets.ts`) add after `symbol`:

```ts
  /** Display name from the relayer's asset table (`"Ethereum"`); `null` when unknown or from an older relayer. */
  name: string | null
```

In `parseMarkets`, add after `symbol: str(o, 'symbol', w),`:

```ts
        name: optionalName(o, w),
```

and above `parseMarkets`:

```ts
function optionalName(o: Record<string, unknown>, where: string): string | null {
  const v = o.name
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new IndexerShapeError(where, `name: expected a string or null`)
  return v
}
```

Also give `SOL_FALLBACK` a name so the fallback row is readable:

```ts
export const SOL_FALLBACK: Pick<MarketInfo, 'symbol' | 'market' | 'name'> = {
  symbol: DEFAULT_SYMBOL,
  market: pdas.market(),
  name: 'Solana',
}
```

- [ ] **Step 4: Run the app gate** — Expected: all pass (fix any `SOL_FALLBACK` consumer type error by reading only the fields it uses).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/markets.ts app/test/markets.test.ts
git commit -m "feat(app): asset name in the market registry"
```

---

### Task 5: App — `/tickers` client

**Files:**
- Create: `app/src/lib/tickers.ts`
- Create: `app/test/tickers.test.ts`

**Interfaces:**
- Consumes: `getJson` (`app/src/lib/indexer.ts`), `IndexerShapeError`, `obj`, `str` (`app/src/lib/indexerCodec.ts`).
- Produces:
  ```ts
  export interface Ticker { symbol: string; price: bigint | null; change24h: number | null; high24h: bigint | null; low24h: bigint | null }
  export function parseTickers(v: unknown): Ticker[]
  export const TICKERS_KEY: readonly ['indexer', 'tickers']
  export function useTickers(enabled: boolean): UseQueryResult<Ticker[]>
  ```

- [ ] **Step 1: Write the failing test**

```ts
// app/test/tickers.test.ts — GET /tickers shape.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTickers } from '../src/lib/tickers'
import { IndexerShapeError } from '../src/lib/indexerCodec'

test('parseTickers: decimal strings become bigint, null stays null', () => {
  const out = parseTickers([
    { symbol: 'ETH', price: '2725880000', change24h: 0.0083, high24h: '2739060000', low24h: '2691770000' },
    { symbol: 'NEW', price: null, change24h: null, high24h: null, low24h: null },
  ])
  assert.deepEqual(out, [
    { symbol: 'ETH', price: 2725880000n, change24h: 0.0083, high24h: 2739060000n, low24h: 2691770000n },
    { symbol: 'NEW', price: null, change24h: null, high24h: null, low24h: null },
  ])
})

test('parseTickers: wrong shapes throw IndexerShapeError naming the field', () => {
  assert.throws(() => parseTickers({}), IndexerShapeError)
  assert.throws(() => parseTickers([{ symbol: 'ETH', price: 12, change24h: null, high24h: null, low24h: null }]), /price/)
  assert.throws(() => parseTickers([{ symbol: 'ETH', price: null, change24h: 'x', high24h: null, low24h: null }]), /change24h/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH node --import tsx --import ./test/setup.ts --test test/tickers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/src/lib/tickers.ts
//
// GET /tickers (services/relayer/src/indexer/http.ts): every market's 24h
// change in one answer — the same for every client, so it says nothing about
// which market this trader looks at. Polled once a minute, only while the
// markets screen is open.
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { getJson } from './indexer'
import { IndexerShapeError, obj, str } from './indexerCodec'

export interface Ticker {
  symbol: string
  /** Last 1h close, 1e6 fixed point; `null` with no candles yet. */
  price: bigint | null
  /** Fraction (`0.0083` = +0.83 %); `null` with under 24h of history. */
  change24h: number | null
  high24h: bigint | null
  low24h: bigint | null
}

const DECIMAL = /^-?\d+$/

function nullableBig(o: Record<string, unknown>, k: string, where: string): bigint | null {
  const v = o[k]
  if (v === null) return null
  if (typeof v !== 'string' || !DECIMAL.test(v)) throw new IndexerShapeError(where, `${k}: expected a decimal string or null`)
  return BigInt(v)
}

function nullableNum(o: Record<string, unknown>, k: string, where: string): number | null {
  const v = o[k]
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new IndexerShapeError(where, `${k}: expected a number or null`)
  return v
}

export function parseTickers(v: unknown): Ticker[] {
  if (!Array.isArray(v)) throw new IndexerShapeError('tickers', 'expected an array')
  return v.map((row, i) => {
    const w = `tickers[${i}]`
    const o = obj(row, w)
    return {
      symbol: str(o, 'symbol', w),
      price: nullableBig(o, 'price', w),
      change24h: nullableNum(o, 'change24h', w),
      high24h: nullableBig(o, 'high24h', w),
      low24h: nullableBig(o, 'low24h', w),
    }
  })
}

export const TICKERS_KEY = ['indexer', 'tickers'] as const

/** 24h tickers for every market; `enabled` only while the markets screen is mounted. */
export function useTickers(enabled: boolean): UseQueryResult<Ticker[]> {
  return useQuery({
    queryKey: TICKERS_KEY,
    queryFn: () => getJson('/tickers', parseTickers),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 30_000,
  })
}
```

- [ ] **Step 4: Run the app gate** — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tickers.ts app/test/tickers.test.ts
git commit -m "feat(app): GET /tickers client"
```

---

### Task 6: App — favourites (pure logic + provider)

**Files:**
- Create: `app/src/lib/favorites.ts` (pure)
- Create: `app/src/lib/favoritesStore.tsx` (context + AsyncStorage)
- Modify: `app/src/shell/AppProviders.tsx` (mount `FavoritesProvider`)
- Create: `app/test/favorites.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // favorites.ts
  export const MAX_CHIPS = 5
  export function parseFavorites(raw: string | null): string[]
  export function toggleFavorite(list: readonly string[], symbol: string): string[]
  export function chipSymbols(favorites: readonly string[], registry: readonly string[], max?: number): string[]
  // favoritesStore.tsx
  export interface Favorites { list: string[]; isFavorite: (s: string) => boolean; toggle: (s: string) => void }
  export function FavoritesProvider(props: PropsWithChildren): JSX.Element
  export function useFavorites(): Favorites
  ```

- [ ] **Step 1: Write the failing test**

```ts
// app/test/favorites.test.ts — favourites: parse, toggle, chips.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CHIPS, chipSymbols, parseFavorites, toggleFavorite } from '../src/lib/favorites'

test('parseFavorites: a JSON array of valid symbols, anything else is empty', () => {
  assert.deepEqual(parseFavorites('["BTC","ETH"]'), ['BTC', 'ETH'])
  assert.deepEqual(parseFavorites(null), [])
  assert.deepEqual(parseFavorites('not json'), [])
  assert.deepEqual(parseFavorites('{"a":1}'), [])
  assert.deepEqual(parseFavorites('["BTC", 7, "eth", "TOOLONGSYM", "BTC"]'), ['BTC']) // invalid and duplicate entries dropped
})

test('toggleFavorite: appends in starring order, removes when present', () => {
  assert.deepEqual(toggleFavorite([], 'BTC'), ['BTC'])
  assert.deepEqual(toggleFavorite(['BTC'], 'ETH'), ['BTC', 'ETH'])
  assert.deepEqual(toggleFavorite(['BTC', 'ETH'], 'BTC'), ['ETH'])
})

test('chipSymbols: favourites in the registry, starring order, at most 5', () => {
  assert.equal(MAX_CHIPS, 5)
  const registry = ['SOL', 'BTC', 'ETH', 'HYPE', 'ZEC', 'A', 'B']
  assert.deepEqual(chipSymbols(['ZEC', 'GONE', 'BTC'], registry), ['ZEC', 'BTC']) // delisted skipped
  assert.deepEqual(chipSymbols(['A', 'B', 'SOL', 'BTC', 'ETH', 'HYPE'], registry), ['A', 'B', 'SOL', 'BTC', 'ETH'])
  assert.deepEqual(chipSymbols([], registry), [])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH node --import tsx --import ./test/setup.ts --test test/favorites.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure module**

```ts
// app/src/lib/favorites.ts
//
// Favourite markets (spec 2026-10-05 market selector, §4.3): an ordered list
// of symbols kept only on this device. Pure; storage is favoritesStore.tsx.
const SYMBOL = /^[A-Z0-9]{1,8}$/

/** Favourite chips under the Trade header. */
export const MAX_CHIPS = 5

/** Stored JSON → symbols. Anything malformed is an empty list; invalid or repeated entries are dropped. */
export function parseFavorites(raw: string | null): string[] {
  if (raw === null) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const s of v) if (typeof s === 'string' && SYMBOL.test(s) && !out.includes(s)) out.push(s)
  return out
}

export function toggleFavorite(list: readonly string[], symbol: string): string[] {
  return list.includes(symbol) ? list.filter((s) => s !== symbol) : [...list, symbol]
}

/** Favourites that are listed right now, in starring order, at most `max`. Unlisted ones stay stored, just not shown. */
export function chipSymbols(favorites: readonly string[], registry: readonly string[], max = MAX_CHIPS): string[] {
  return favorites.filter((s) => registry.includes(s)).slice(0, max)
}
```

- [ ] **Step 4: Implement the provider**

```tsx
// app/src/lib/favoritesStore.tsx
//
// Favourites context backed by AsyncStorage (`dexxer.favorites`). A read
// failure is never written back: until the first read succeeds, toggles stay
// in memory only (same rule as the History archive).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { parseFavorites, toggleFavorite } from './favorites'

const KEY = 'dexxer.favorites'

export interface Favorites {
  list: string[]
  isFavorite: (symbol: string) => boolean
  toggle: (symbol: string) => void
}

const FavoritesContext = createContext<Favorites>({ list: [], isFavorite: () => false, toggle: () => {} })

export function FavoritesProvider({ children }: PropsWithChildren) {
  const [list, setList] = useState<string[]>([])
  const [writable, setWritable] = useState(false)

  useEffect(() => {
    let cancelled = false
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (cancelled) return
        setList(parseFavorites(raw))
        setWritable(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = useCallback(
    (symbol: string) => {
      setList((prev) => {
        const next = toggleFavorite(prev, symbol)
        if (writable) AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {})
        return next
      })
    },
    [writable],
  )

  const value = useMemo(() => ({ list, isFavorite: (s: string) => list.includes(s), toggle }), [list, toggle])
  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>
}

export function useFavorites(): Favorites {
  return useContext(FavoritesContext)
}
```

In `app/src/shell/AppProviders.tsx`, import `FavoritesProvider` from `@/src/lib/favoritesStore` and wrap it directly inside `SelectedMarketProvider`:

```tsx
        <SelectedMarketProvider>
          <FavoritesProvider>
            <SolanaProvider>
              <AuthProvider>{children}</AuthProvider>
            </SolanaProvider>
          </FavoritesProvider>
        </SelectedMarketProvider>
```

- [ ] **Step 5: Run the app gate** — Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/favorites.ts app/src/lib/favoritesStore.tsx app/src/shell/AppProviders.tsx app/test/favorites.test.ts
git commit -m "feat(app): favourite markets stored on the device"
```

---

### Task 7: App — market list logic (pure)

**Files:**
- Create: `app/src/features/markets/marketList.ts`
- Create: `app/test/marketList.test.ts`

**Interfaces:**
- Consumes: `MarketInfo` (Task 4), `Ticker` (Task 5), `DecodedPositions`, `MAX_SLOTS` (`app/src/lib/positions.ts`), `maxLeverage` (`app/src/features/trade/headerStats.ts`), `DEFAULT_SYMBOL`, `SOL_FALLBACK` (`app/src/lib/markets.ts`).
- Produces:
  ```ts
  export type MarketTab = 'all' | 'favorites' | 'positions'
  export type MarketSort = 'az' | 'up' | 'down'
  export interface MarketRow {
    symbol: string; name: string | null; price: bigint | null; change24h: number | null
    maxLeverage: number | null; paused: boolean; hasPosition: boolean; hasOrders: boolean
    favorite: boolean; selected: boolean
  }
  export interface MarketRowsInput {
    markets: MarketInfo[]; tickers: Ticker[]; marks: Record<string, bigint | null>
    positions: DecodedPositions | null; favorites: readonly string[]; selected: string
  }
  export function marketRows(input: MarketRowsInput): MarketRow[]
  export function filterRows(rows: MarketRow[], query: string, tab: MarketTab): MarketRow[]
  export function sortRows(rows: MarketRow[], mode: MarketSort): MarketRow[]
  export function slotUsage(positions: DecodedPositions | null): { used: number; max: number } | null
  export function parseSort(raw: string | null): MarketSort
  ```

- [ ] **Step 1: Write the failing test**

```ts
// app/test/marketList.test.ts — rows, search, tabs, sort, slot usage.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { filterRows, marketRows, parseSort, slotUsage, sortRows, type MarketRow } from '../src/features/markets/marketList'
import type { MarketInfo } from '../src/lib/markets'
import type { DecodedPositions } from '../src/lib/positions'

const market = (symbol: string, name: string | null, o: Partial<MarketInfo['params']> = {}): MarketInfo => ({
  symbol,
  name,
  market: PublicKey.unique(),
  feed: PublicKey.unique(),
  params: {
    maxLevBps: 100_000, imrBps: 1_000, mmrBps: 500, openFeeBps: 6, closeFeeBps: 6, liqFeeBps: 100,
    oiCap: 0n, maxPosition: 1n, minSize: 1n, maxStalenessSecs: 15n, pausedOpen: false, ...o,
  },
})
const SOL = market('SOL', 'Solana')
const BTC = market('BTC', 'Bitcoin', { pausedOpen: true })
const ETH = market('ETH', 'Ethereum', { maxLevBps: 50_000 })
const positions = { slots: [{ market: ETH.market }], orders: [{ market: BTC.market }] } as unknown as DecodedPositions

const rows = marketRows({
  markets: [SOL, BTC, ETH],
  tickers: [
    { symbol: 'SOL', price: 150_000_000n, change24h: -0.02, high24h: null, low24h: null },
    { symbol: 'BTC', price: 60_000_000_000n, change24h: 0.05, high24h: null, low24h: null },
    { symbol: 'ETH', price: null, change24h: null, high24h: null, low24h: null },
  ],
  marks: { SOL: 151_000_000n },
  positions,
  favorites: ['BTC'],
  selected: 'ETH',
})
const by = (s: string) => rows.find((r) => r.symbol === s) as MarketRow

test('marketRows: live WS mark wins over the ticker price; no data → null, never 0', () => {
  assert.equal(by('SOL').price, 151_000_000n)
  assert.equal(by('BTC').price, 60_000_000_000n)
  assert.equal(by('ETH').price, null)
  assert.equal(by('ETH').change24h, null)
})

test('marketRows: flags — paused, position, orders, favourite, selected, leverage', () => {
  assert.equal(by('BTC').paused, true)
  assert.equal(by('ETH').hasPosition, true)
  assert.equal(by('BTC').hasOrders, true)
  assert.equal(by('BTC').favorite, true)
  assert.equal(by('ETH').selected, true)
  assert.equal(by('SOL').maxLeverage, 10)
  assert.equal(by('ETH').maxLeverage, 5)
})

test('marketRows: an empty registry still yields the SOL fallback row', () => {
  const out = marketRows({ markets: [], tickers: [], marks: {}, positions: null, favorites: [], selected: 'SOL' })
  assert.deepEqual(out.map((r) => [r.symbol, r.name, r.selected]), [['SOL', 'Solana', true]])
})

test('filterRows: case-insensitive on ticker or name, trims, never throws on regex characters', () => {
  assert.deepEqual(filterRows(rows, 'eth', 'all').map((r) => r.symbol), ['ETH'])
  assert.deepEqual(filterRows(rows, '  Bitco ', 'all').map((r) => r.symbol), ['BTC'])
  assert.deepEqual(filterRows(rows, '', 'all').length, 3)
  assert.deepEqual(filterRows(rows, '(', 'all'), [])
  assert.deepEqual(filterRows(rows, '.', 'all'), [])
})

test('filterRows: tabs — favourites, positions (open slot or pending order)', () => {
  assert.deepEqual(filterRows(rows, '', 'favorites').map((r) => r.symbol), ['BTC'])
  assert.deepEqual(filterRows(rows, '', 'positions').map((r) => r.symbol).sort(), ['BTC', 'ETH'])
})

test('sortRows: A–Z keeps SOL first; 24h sorts put null last both ways', () => {
  assert.deepEqual(sortRows(rows, 'az').map((r) => r.symbol), ['SOL', 'BTC', 'ETH'])
  assert.deepEqual(sortRows(rows, 'up').map((r) => r.symbol), ['BTC', 'SOL', 'ETH'])
  assert.deepEqual(sortRows(rows, 'down').map((r) => r.symbol), ['SOL', 'BTC', 'ETH'])
})

test('slotUsage: open slots out of 16; null without a Positions account', () => {
  assert.deepEqual(slotUsage(positions), { used: 1, max: 16 })
  assert.equal(slotUsage(null), null)
})

test('parseSort: stored value or the A–Z default', () => {
  assert.equal(parseSort('up'), 'up')
  assert.equal(parseSort('down'), 'down')
  assert.equal(parseSort(null), 'az')
  assert.equal(parseSort('garbage'), 'az')
})
```

Note on the `up`/`down` expectations: `up` = largest gain first (`BTC +5 %`, `SOL −2 %`, then `ETH null`); `down` = largest loss first (`SOL −2 %`, `BTC +5 %`, then `ETH null`).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH node --import tsx --import ./test/setup.ts --test test/marketList.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/src/features/markets/marketList.ts
//
// The markets screen's view data (spec 2026-10-05 market selector, §4.4).
// Pure: no hooks, no I/O — MarketsScreen feeds it the registry, /tickers,
// the WS mark cache and the owner's Positions.
import { DEFAULT_SYMBOL, SOL_FALLBACK, type MarketInfo } from '@/src/lib/markets'
import type { Ticker } from '@/src/lib/tickers'
import { MAX_SLOTS, type DecodedPositions } from '@/src/lib/positions'
import { maxLeverage } from '../trade/headerStats'

export type MarketTab = 'all' | 'favorites' | 'positions'
export type MarketSort = 'az' | 'up' | 'down'

export interface MarketRow {
  symbol: string
  name: string | null
  /** Live WS mark if cached, else the /tickers close; 1e6. `null` = no data (shown as "—"). */
  price: bigint | null
  change24h: number | null
  maxLeverage: number | null
  paused: boolean
  hasPosition: boolean
  hasOrders: boolean
  favorite: boolean
  selected: boolean
}

export interface MarketRowsInput {
  markets: MarketInfo[]
  tickers: Ticker[]
  marks: Record<string, bigint | null>
  positions: DecodedPositions | null
  favorites: readonly string[]
  selected: string
}

export function marketRows({ markets, tickers, marks, positions, favorites, selected }: MarketRowsInput): MarketRow[] {
  const tickerOf = new Map(tickers.map((t) => [t.symbol, t]))
  const base =
    markets.length > 0
      ? markets.map((m) => ({ symbol: m.symbol, name: m.name, key: m.market, params: m.params }))
      : [{ symbol: DEFAULT_SYMBOL, name: SOL_FALLBACK.name, key: SOL_FALLBACK.market, params: null }]
  return base.map((m) => {
    const t = tickerOf.get(m.symbol)
    return {
      symbol: m.symbol,
      name: m.name,
      price: marks[m.symbol] ?? t?.price ?? null,
      change24h: t?.change24h ?? null,
      maxLeverage: m.params ? maxLeverage(m.params.maxLevBps, m.params.imrBps) : null,
      paused: m.params?.pausedOpen ?? false,
      hasPosition: positions?.slots.some((s) => s.market.equals(m.key)) ?? false,
      hasOrders: positions?.orders.some((o) => o.market.equals(m.key)) ?? false,
      favorite: favorites.includes(m.symbol),
      selected: m.symbol === selected,
    }
  })
}

export function filterRows(rows: MarketRow[], query: string, tab: MarketTab): MarketRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter((r) => {
    if (tab === 'favorites' && !r.favorite) return false
    if (tab === 'positions' && !r.hasPosition && !r.hasOrders) return false
    if (q === '') return true
    return r.symbol.toLowerCase().includes(q) || (r.name?.toLowerCase().includes(q) ?? false)
  })
}

export function sortRows(rows: MarketRow[], mode: MarketSort): MarketRow[] {
  const out = [...rows]
  if (mode === 'az') {
    return out.sort((a, b) =>
      a.symbol === DEFAULT_SYMBOL ? -1 : b.symbol === DEFAULT_SYMBOL ? 1 : a.symbol.localeCompare(b.symbol),
    )
  }
  const dir = mode === 'up' ? -1 : 1
  return out.sort((a, b) => {
    if (a.change24h === null && b.change24h === null) return a.symbol.localeCompare(b.symbol)
    if (a.change24h === null) return 1
    if (b.change24h === null) return -1
    return dir * (a.change24h - b.change24h)
  })
}

export function slotUsage(positions: DecodedPositions | null): { used: number; max: number } | null {
  return positions ? { used: positions.slots.length, max: MAX_SLOTS } : null
}

export function parseSort(raw: string | null): MarketSort {
  return raw === 'up' || raw === 'down' ? raw : 'az'
}
```

Check: `maxLeverage(maxLevBps, imrBps)` in `app/src/features/trade/headerStats.ts` returns `100_000 / 10_000 = 10` and `50_000 / 10_000 = 5` for the fixture (it is what the header badge uses today). If its signature differs, adapt the call — not the test's expected 10 / 5.

- [ ] **Step 4: Run the app gate** — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/features/markets/marketList.ts app/test/marketList.test.ts
git commit -m "feat(app): market list rows, search, tabs, 24h sort, slot usage"
```

---

### Task 8: App — `AssetIcon`

**Files:**
- Create: `app/src/ui/AssetIcon.tsx`
- Create: `app/src/ui/assetIcons.ts` (pure: which symbols have a brand SVG, fallback letter)
- Modify: `app/src/features/trade/TradeHeader.tsx` (replace `SolIcon` usage) and delete `app/src/ui/SolIcon.tsx` once no import remains
- Modify: `app/app/(tabs)/settings/ui-gallery.tsx` (show icons)
- Create: `app/test/assetIcons.test.ts`

**Interfaces:**
- Produces: `AssetIcon({ symbol, size = 28 })`; `hasBrandIcon(symbol: string): boolean`; `fallbackLetter(symbol: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// app/test/assetIcons.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRAND_ICON_SYMBOLS, fallbackLetter, hasBrandIcon } from '../src/ui/assetIcons'

test('brand SVG for the listed assets; letter fallback for anything else', () => {
  for (const s of ['SOL', 'BTC', 'ETH', 'HYPE', 'ZEC']) assert.equal(hasBrandIcon(s), BRAND_ICON_SYMBOLS.includes(s), s)
  assert.equal(hasBrandIcon('SOL'), true)
  assert.equal(hasBrandIcon('NEW'), false)
  assert.equal(fallbackLetter('NEW'), 'N')
  assert.equal(fallbackLetter(''), '?')
})
```

- [ ] **Step 2: Run it to verify it fails** — `node --import tsx --import ./test/setup.ts --test test/assetIcons.test.ts` → FAIL, module not found.

- [ ] **Step 3: Get the brand SVGs (no redrawing)**

From each project's official brand/press kit, take the logomark SVG and extract its `<path d="...">` (and its brand fill colours):
- SOL — keep the paths already in `app/src/ui/SolIcon.tsx` (they are the official mark).
- BTC — bitcoin.org press kit (the logo is public domain).
- ETH — ethereum.org "assets" page (brand assets).
- HYPE — Hyperliquid's official brand assets / docs media kit.
- ZEC — Zcash Foundation / z.cash press kit.

If a kit cannot be obtained, leave that symbol out of `BRAND_ICON_SYMBOLS` — it renders the letter fallback. Never trace or invent a logo.

- [ ] **Step 4: Implement**

```ts
// app/src/ui/assetIcons.ts — which assets ship a brand SVG (AssetIcon.tsx draws them).
/** Keep in sync with the `ICONS` map in AssetIcon.tsx. */
export const BRAND_ICON_SYMBOLS: readonly string[] = ['SOL', 'BTC', 'ETH', 'HYPE', 'ZEC']

export function hasBrandIcon(symbol: string): boolean {
  return BRAND_ICON_SYMBOLS.includes(symbol)
}

export function fallbackLetter(symbol: string): string {
  return symbol.charAt(0) || '?'
}
```

`app/src/ui/AssetIcon.tsx` — a `surfaceAlt` circle of `size`, with either the brand glyph (SVG, ~55 % of `size`, as `SolIcon` does today) or the letter in `useTextStyle('bodyStrong')`, `colors.textPrimary`. Structure:

```tsx
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg'
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from './styles'
import { fallbackLetter, hasBrandIcon } from './assetIcons'

type Glyph = (size: number) => JSX.Element

// Brand marks from each project's official kit (see the plan's Task 8). Brand colours live only here.
const ICONS: Record<string, Glyph> = {
  SOL: (s) => (/* move the <Svg> body from SolIcon.tsx here unchanged, sized to s */ <Svg width={s} height={s * 0.78} viewBox="0 0 398 312">{/* ...SolIcon paths... */}</Svg>),
  // BTC, ETH, HYPE, ZEC: <Svg viewBox=...><Path d="<official path>" fill="<official colour>" /></Svg>
}

export function AssetIcon({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const { colors } = useTheme()
  const letter = useTextStyle('bodyStrong')
  const glyph = hasBrandIcon(symbol) ? ICONS[symbol] : undefined
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}
    >
      {glyph ? glyph(size * 0.55) : <Text style={[letter, { color: colors.textPrimary }]}>{fallbackLetter(symbol)}</Text>}
    </View>
  )
}
```

The SOL entry must reproduce `SolIcon` exactly (its `LinearGradient` uses `colors.accent` → `colors.long`; keep that). The icon is decorative: the symbol is always written next to it, so it is hidden from TalkBack.

Replace `<SolIcon />` in `TradeHeader.tsx` with `<AssetIcon symbol={symbol} />` (now every market gets an icon, not only SOL), delete `SolIcon.tsx`, and in `ui-gallery.tsx` add a section rendering `AssetIcon` for `SOL BTC ETH HYPE ZEC NEW`.

- [ ] **Step 5: Run the app gate** — Expected: all pass, no remaining `SolIcon` import (`grep -rn SolIcon app/src app/app` → nothing).

- [ ] **Step 6: Commit**

```bash
git add -A app/src/ui app/src/features/trade/TradeHeader.tsx app/app/\(tabs\)/settings/ui-gallery.tsx app/test/assetIcons.test.ts
git commit -m "feat(app): AssetIcon with brand marks and a letter fallback"
```

---

### Task 9: App — markets screen

**Files:**
- Create: `app/app/markets.tsx` (route)
- Modify: `app/app/_layout.tsx` (register the modal route)
- Create: `app/src/features/markets/MarketsScreen.tsx`
- Create: `app/src/features/markets/MarketRowView.tsx`
- Create: `app/src/features/markets/useMarketsSort.ts`

**Interfaces:**
- Consumes: `marketRows`, `filterRows`, `sortRows`, `slotUsage`, `parseSort`, `MarketTab`, `MarketSort`, `MarketRow` (Task 7); `useTickers` (Task 5); `useFavorites` (Task 6); `AssetIcon` (Task 8); `useMarkets`, `useSelectedMarket` (`markets.ts`); `QK`, `parseMark`-based `getJson` (`indexer.ts`); `useTradeSession` (`features/trade/useTradeSession.ts`); `useLiveAccount` (`lib/live.ts`); `decodePositions` (`lib/positions.ts`); `formatUsd2` (`lib/status.ts`).
- Produces: route `/markets`.

- [ ] **Step 1: Register the route**

`app/app/markets.tsx`:

```tsx
import { MarketsScreen } from '@/src/features/markets/MarketsScreen'

export default function MarketsRoute() {
  return <MarketsScreen />
}
```

In `app/app/_layout.tsx`, inside `<Stack.Protected guard={isAuthenticated}>`, after `<Stack.Screen name="(tabs)" />`:

```tsx
        <Stack.Screen name="markets" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
```

- [ ] **Step 2: Sort preference hook**

```ts
// app/src/features/markets/useMarketsSort.ts — the markets screen's sort, remembered on the device.
import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { parseSort, type MarketSort } from './marketList'

const KEY = 'dexxer.marketsSort'

export function useMarketsSort(): [MarketSort, (s: MarketSort) => void] {
  const [sort, setSort] = useState<MarketSort>('az')
  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => setSort(parseSort(raw)))
      .catch(() => {})
  }, [])
  const set = useCallback((s: MarketSort) => {
    setSort(s)
    AsyncStorage.setItem(KEY, s).catch(() => {})
  }, [])
  return [sort, set]
}
```

- [ ] **Step 3: Row view**

`app/src/features/markets/MarketRowView.tsx` renders one `MarketRow`:

```tsx
import { Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Badge } from '@/src/ui/Badge'
import { AssetIcon } from '@/src/ui/AssetIcon'
import { formatUsd2 } from '@/src/lib/status'
import type { MarketRow } from './marketList'

export function formatChange(c: number | null): string {
  if (c === null) return '—'
  const pct = c * 100
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`
}

export function MarketRowView({ row, onSelect, onToggleFavorite }: { row: MarketRow; onSelect: () => void; onToggleFavorite: () => void }) {
  const { colors, space, radius, border, control } = useTheme()
  const symbol = useTextStyle('bodyStrong')
  const name = useTextStyle('caption')
  const value = useTextStyle('bodyStrong', { mono: true })
  const change = useTextStyle('caption', { mono: true })
  const star = useTextStyle('heading')
  const changeColor = row.change24h === null ? colors.textSecondary : row.change24h >= 0 ? colors.long : colors.short
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: row.selected }}
      accessibilityLabel={`${row.symbol}${row.name ? `, ${row.name}` : ''}`}
      onPress={onSelect}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: space.md,
        padding: space.md, borderRadius: radius.md,
        borderWidth: border.hairline, borderColor: row.selected ? colors.accent : 'transparent',
        backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
      })}
    >
      <AssetIcon symbol={row.symbol} size={36} />
      <View style={{ flex: 1, gap: space.xs }}>
        <Text style={[symbol, { color: colors.textPrimary }]}>{row.symbol}</Text>
        {row.name ? <Text style={[name, { color: colors.textSecondary }]}>{row.name}</Text> : null}
        <View style={{ flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' }}>
          {row.maxLeverage !== null ? <Badge tone="neutral">{`${row.maxLeverage}×`}</Badge> : null}
          {row.hasPosition ? <Badge tone="pending">Position</Badge> : null}
          {row.hasOrders ? <Badge tone="pending">Orders</Badge> : null}
          {row.paused ? <Badge tone="warning">Paused</Badge> : null}
        </View>
      </View>
      <View style={{ alignItems: 'flex-end', gap: space.xs }}>
        <Text style={[value, { color: colors.textPrimary }]}>{row.price !== null ? `$${formatUsd2(row.price)}` : '—'}</Text>
        <Text style={[change, { color: changeColor }]}>{formatChange(row.change24h)}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.favorite ? `Remove ${row.symbol} from favorites` : `Add ${row.symbol} to favorites`}
        accessibilityState={{ selected: row.favorite }}
        onPress={onToggleFavorite}
        hitSlop={{ top: space.md, bottom: space.md, left: space.sm, right: space.sm }}
        style={{ minWidth: control.minHitTarget, alignItems: 'center' }}
      >
        <Text style={[star, { color: row.favorite ? colors.warning : colors.textTertiary }]}>{row.favorite ? '★' : '☆'}</Text>
      </Pressable>
    </Pressable>
  )
}
```

Add `formatChange` tests to `app/test/marketList.test.ts`:

```ts
import { formatChange } from '../src/features/markets/MarketRowView'

test('formatChange: signed percent with two decimals; null → —', () => {
  assert.equal(formatChange(0.0083), '+0.83%')
  assert.equal(formatChange(-0.02), '−2.00%')
  assert.equal(formatChange(0), '+0.00%')
  assert.equal(formatChange(null), '—')
})
```

If importing a `.tsx` component file into `node --test` fails under the stubs, move `formatChange` into `marketList.ts` (pure) and import it from there in both places.

- [ ] **Step 4: Screen**

`app/src/features/markets/MarketsScreen.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { FlatList, Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useQueries } from '@tanstack/react-query'
import { Page } from '@/src/ui/Page'
import { Input } from '@/src/ui/Input'
import { Segment } from '@/src/ui/Segment'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { useMarkets, useSelectedMarket, DEFAULT_SYMBOL } from '@/src/lib/markets'
import { useTickers } from '@/src/lib/tickers'
import { useFavorites } from '@/src/lib/favoritesStore'
import { QK, getJson, type Mark } from '@/src/lib/indexer'
import { parseMark } from '@/src/lib/indexerCodec'
import { useLiveAccount } from '@/src/lib/live'
import { decodePositions } from '@/src/lib/positions'
import { useTradeSession } from '../trade/useTradeSession'
import { filterRows, marketRows, slotUsage, sortRows, type MarketTab } from './marketList'
import { MarketRowView } from './MarketRowView'
import { useMarketsSort } from './useMarketsSort'

export function MarketsScreen() {
  const { colors, space } = useTheme()
  const title = useTextStyle('title')
  const caption = useTextStyle('caption')
  const markets = useMarkets()
  const tickers = useTickers(true)
  const favorites = useFavorites()
  const { symbol, setSymbol } = useSelectedMarket()
  const { conn, base } = useTradeSession()
  const positions = useLiveAccount(conn, base?.positions ?? null, decodePositions)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<MarketTab>('all')
  const [sort, setSort] = useMarketsSort()

  const symbols = (markets.data?.length ? markets.data : [{ symbol: DEFAULT_SYMBOL }]).map((m) => m.symbol)
  // Observe the WS-fed mark cache without fetching: `enabled: false` never issues /mark?market=X.
  const markQueries = useQueries({
    queries: symbols.map((s) => ({
      queryKey: QK.mark(s),
      queryFn: () => getJson(`/mark?market=${encodeURIComponent(s)}`, parseMark),
      enabled: false,
    })),
  })
  const marks: Record<string, bigint | null> = {}
  symbols.forEach((s, i) => (marks[s] = (markQueries[i].data as Mark | undefined)?.price ?? null))

  const rows = useMemo(
    () =>
      sortRows(
        filterRows(
          marketRows({ markets: markets.data ?? [], tickers: tickers.data ?? [], marks, positions: positions.value, favorites: favorites.list, selected: symbol }),
          query,
          tab,
        ),
        sort,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `marks` is rebuilt every render from markQueries
    [markets.data, tickers.data, markQueries, positions.value, favorites.list, symbol, query, tab, sort],
  )
  const slots = slotUsage(positions.value)

  const empty =
    query.trim() !== '' ? `No markets match "${query.trim()}"` : tab === 'favorites' ? 'Tap ☆ to pin markets here' : tab === 'positions' ? 'No open positions' : null

  return (
    <Page>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: space.lg }}>
        <Text style={[title, { color: colors.textPrimary }]}>Select market</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => router.back()} hitSlop={space.md}>
          <Text style={[title, { color: colors.textSecondary }]}>✕</Text>
        </Pressable>
      </View>
      <View style={{ gap: space.md, paddingVertical: space.md }}>
        <Input label="Search" value={query} onChangeText={setQuery} hint="Ticker or name" keyboardType="default" />
        <Segment value={tab} onChange={setTab} options={[{ value: 'all', label: 'All' }, { value: 'favorites', label: '★ Favorites' }, { value: 'positions', label: 'With positions' }]} />
        <Segment compact value={sort} onChange={setSort} options={[{ value: 'az', label: 'A–Z' }, { value: 'up', label: '24h ▲' }, { value: 'down', label: '24h ▼' }]} />
        {!markets.data?.length && !markets.isLoading ? (
          <Text style={[caption, { color: colors.warning }]}>Market list unavailable — showing SOL</Text>
        ) : null}
        {slots ? (
          <Text style={[caption, { color: slots.used >= slots.max ? colors.warning : colors.textSecondary }]}>
            {slots.used >= slots.max
              ? `All ${slots.max} position slots are in use. Close a position to open on another market.`
              : `Open positions: ${slots.used} / ${slots.max}`}
          </Text>
        ) : null}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.symbol}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: space.sm, paddingBottom: space.xl }}
        ListEmptyComponent={empty ? <Text style={[caption, { color: colors.textSecondary, textAlign: 'center', padding: space.xl }]}>{empty}</Text> : null}
        renderItem={({ item }) => (
          <MarketRowView
            row={item}
            onSelect={() => {
              setSymbol(item.symbol)
              router.back()
            }}
            onToggleFavorite={() => favorites.toggle(item.symbol)}
          />
        )}
      />
    </Page>
  )
}
```

Check against the real code before running: `parseMark` is exported from `indexerCodec.ts` and `getJson`/`QK`/`Mark` from `indexer.ts` (true on `main` at the time of writing); `useTradeSession` returns `{ conn, base }` (used the same way in `TradeScreen.tsx`); `Input` accepts `keyboardType="default"`; `Page` is the shared screen wrapper used by every tab. If `Page` adds a top inset the header already has, drop `paddingTop`.

- [ ] **Step 5: Run the app gate** — Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/app/markets.tsx app/app/_layout.tsx app/src/features/markets app/test/marketList.test.ts
git commit -m "feat(app): markets screen - search, tabs, 24h sort, favourites, slot counter"
```

---

### Task 10: App — Trade header: market button and favourite chips

**Files:**
- Modify: `app/src/features/trade/TradeHeader.tsx`
- Delete: `app/src/features/trade/MarketPicker.tsx`

**Interfaces:**
- Consumes: `AssetIcon` (Task 8), `useFavorites` (Task 6), `chipSymbols` (Task 6), `useMarkets`, `useSelectedMarket`.

- [ ] **Step 1: Replace `MarketPicker` and the symbol row**

In `TradeHeader.tsx`, remove `import { MarketPicker } from './MarketPicker'` and the `<MarketPicker />` line. Replace the left part of the first row (icon + `${symbol}-PERP` + leverage badge) with a pressable market button, and render the chips and the paused badge below the row:

```tsx
import { Pressable } from 'react-native'
import { router } from 'expo-router'
import { AssetIcon } from '@/src/ui/AssetIcon'
import { Segment } from '@/src/ui/Segment'
import { useFavorites } from '@/src/lib/favoritesStore'
import { chipSymbols } from '@/src/lib/favorites'
import { useMarkets, useSelectedMarket } from '@/src/lib/markets'
```

```tsx
  const markets = useMarkets()
  const favorites = useFavorites()
  const { setSymbol } = useSelectedMarket()
  const registry = markets.data?.length ? markets.data.map((m) => m.symbol) : [symbol]
  const chips = chipSymbols(favorites.list, registry)
  const paused = markets.data?.find((m) => m.symbol === symbol)?.params.pausedOpen ?? false
```

```tsx
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Market ${symbol}-PERP, change market`}
          onPress={() => router.push('/markets')}
          hitSlop={space.sm}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.sm, opacity: pressed ? 0.6 : 1 })}
        >
          <AssetIcon symbol={symbol} />
          <Text style={[heading, { color: colors.textPrimary }]}>{`${symbol}-PERP`}</Text>
          <Text style={[heading, { color: colors.textSecondary }]}>▾</Text>
          {maxLeverage !== null ? (
            <View style={{ justifyContent: 'center' }}>
              <Badge tone="pending">{`${maxLeverage}×`}</Badge>
            </View>
          ) : null}
        </Pressable>
```

Below that row (before the big mark price):

```tsx
      {chips.length > 0 ? (
        <Segment compact value={symbol} onChange={setSymbol} options={chips.map((s) => ({ value: s, label: s }))} />
      ) : null}
      {paused ? <Badge tone="warning">{`Opening paused on ${symbol}-PERP`}</Badge> : null}
```

Delete `app/src/features/trade/MarketPicker.tsx`.

- [ ] **Step 2: Run the app gate** — Expected: all pass; `grep -rn MarketPicker app/src` → nothing.

- [ ] **Step 3: Check on the emulator**

With Metro and the AVD running (`docs/emulator-runbook.md` §1), open Trade:
- the header shows `[icon] ETH-PERP ▾ 10×`; no chips row (no favourites yet);
- tap the button → "Select market" slides up; Back closes it;
- star BTC on the markets screen, close → a `BTC` chip appears; tap it → header becomes `BTC-PERP`.

- [ ] **Step 4: Commit**

```bash
git add -A app/src/features/trade/TradeHeader.tsx app/src/features/trade/MarketPicker.tsx
git commit -m "feat(app): Trade header market button and favourite chips"
```

---

### Task 11: App — the submit button names the market

**Files:**
- Modify: `app/src/features/trade/ticketMath.ts` (add `submitLabel`)
- Modify: `app/src/features/trade/TradeTicket.tsx` (use it)
- Modify: `app/src/features/trade/CloseTab.tsx` (full close label)
- Modify: `app/test/ticketMath.test.ts`

**Interfaces:**
- Produces: `submitLabel(o: { busy: boolean; orderType: 'market' | 'limit' | 'stop'; side: 'long' | 'short'; symbol: string }): string`.

- [ ] **Step 1: Write the failing test** (append to `app/test/ticketMath.test.ts`)

```ts
import { submitLabel } from '../src/features/trade/ticketMath'

test('submitLabel: names the market on every entry; busy wins', () => {
  assert.equal(submitLabel({ busy: false, orderType: 'market', side: 'long', symbol: 'ETH' }), 'Open Long ETH')
  assert.equal(submitLabel({ busy: false, orderType: 'market', side: 'short', symbol: 'BTC' }), 'Open Short BTC')
  assert.equal(submitLabel({ busy: false, orderType: 'limit', side: 'short', symbol: 'BTC' }), 'Place Limit Short BTC')
  assert.equal(submitLabel({ busy: false, orderType: 'stop', side: 'long', symbol: 'SOL' }), 'Place Stop Long SOL')
  assert.equal(submitLabel({ busy: true, orderType: 'market', side: 'long', symbol: 'ETH' }), 'Signing with session key…')
})
```

- [ ] **Step 2: Run it to verify it fails** — `node --import tsx --import ./test/setup.ts --test test/ticketMath.test.ts` → FAIL, `submitLabel` is not exported.

- [ ] **Step 3: Implement** (append to `ticketMath.ts`)

```ts
/** The ticket's submit text: always names the market, so a wrong-market tap is visible before it lands. */
export function submitLabel(o: { busy: boolean; orderType: 'market' | 'limit' | 'stop'; side: 'long' | 'short'; symbol: string }): string {
  if (o.busy) return 'Signing with session key…'
  const side = o.side === 'long' ? 'Long' : 'Short'
  if (o.orderType === 'market') return `Open ${side} ${o.symbol}`
  return `Place ${o.orderType === 'limit' ? 'Limit' : 'Stop'} ${side} ${o.symbol}`
}
```

In `TradeTicket.tsx`, replace the nested ternary inside the submit `<Button>` with:

```tsx
        {submitLabel({ busy, orderType, side, symbol })}
```
and add `submitLabel` to the existing `import { ... } from './ticketMath'`.

In `CloseTab.tsx`, change the full-close text `'Close position'` to `` `Close ${symbol} position` `` (the partial branch already names the symbol).

- [ ] **Step 4: Run the app gate** — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/features/trade/ticketMath.ts app/src/features/trade/TradeTicket.tsx app/src/features/trade/CloseTab.tsx app/test/ticketMath.test.ts
git commit -m "feat(app): the ticket's submit button names the market"
```

---

### Task 12: Emulator pass, docs, PR

**Files:**
- Modify: `CLAUDE.md` (a short "Market selector rules" section)
- Modify: `docs/superpowers/specs/2026-10-05-market-selector-design.md` (status line)

- [ ] **Step 1: Emulator checklist (Phantom AVD, `docs/emulator-runbook.md` §1; relayer with `/tickers` deployed or a local relayer)**

1. Header button opens "Select market"; Android Back and ✕ close it.
2. Search `eth`, `Ethereum`, `  Eth ` → only ETH; `zzz` → `No markets match "zzz"`.
3. Sort 24h ▲ / ▼ reorders; rows without 24h show `—` and sit last; reopen the screen → the sort is remembered.
4. Star BTC → ★ tab lists it, a `BTC` chip appears under the header; restart the app → still there.
5. Select via a chip and via a row → header, chart and ticket switch; ticket button reads `Open Long BTC`.
6. Font scale 1.3× (`adb shell settings put system font_scale 1.3`, then back to `1.0`): rows and header do not overlap.
7. With the relayer's `/tickers` unreachable: list still works, 24h shows `—`.
Position markers, the `Position`/`Orders` badges and the 16/16 warning need an onboarded account — list them in the PR as the live-run checklist.

- [ ] **Step 2: CLAUDE.md**

Append under the last rules section:

```markdown
## Market selector rules (05.10.2026, spec `2026-10-05-market-selector-design.md`)
- The Trade header is a market button (`AssetIcon` + `SYMBOL-PERP ▾` + max leverage) that opens the modal route `/markets`; favourite chips (≤ 5, `chipSymbols`) sit under it only when the trader has favourites. `MarketPicker` is gone.
- The markets screen never fetches per market: prices come from the WS mark cache (`useQueries` with `enabled: false`), 24h change from `GET /tickers` (one answer for every client, cached 30 s on the relayer, `TICKERS_CACHE_MS`). Favourites (`dexxer.favorites`) and sort (`dexxer.marketsSort`) stay on the device; a storage read error is never written back.
- `GET /markets` carries `name` from `services/relayer/assets/assets.json` (`null` when absent). A new market needs an `assets.json` entry for its name and a brand SVG in `AssetIcon` (otherwise a letter avatar).
- The ticket's submit button always names the market (`submitLabel`).
```

- [ ] **Step 3: Spec status**

In the spec header, change `**Status:** approved in brainstorming, pending review of this file and the implementation plan` to `**Status:** implemented (plan 2026-10-05-market-selector.md)`.

- [ ] **Step 4: Full gates once more**

Relayer test command and app gate from Global Constraints. Expected: all pass.

- [ ] **Step 5: Commit, push, PR**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-05-market-selector-design.md
git commit -m "docs: market selector rules and spec status"
git push -u origin feat/market-selector
gh pr create --base main --title "feat: market selector - header button, markets screen, favourites, /tickers" --body-file <(printf '%s\n' "Implements docs/superpowers/specs/2026-10-05-market-selector-design.md (plan docs/superpowers/plans/2026-10-05-market-selector.md)." "" "Rollout: deploy the relayer first (name in /markets, GET /tickers), then the app." "" "Live-run checklist (needs an onboarded account): Position/Orders badges, With positions tab, 16/16 warning.")
```

Deploy order after merge: relayer (`railway up` from `services/relayer`), then a new app build.
