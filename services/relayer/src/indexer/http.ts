// services/relayer/src/indexer/http.ts
//
// REST + WS surface for the public-data indexer (Task 5). `indexerRouter`
// mounts on the same Express `app` index.ts already runs `/healthz` on;
// `attachWs` attaches a `ws` server to the same underlying `http.Server` at
// path `/ws` — no separate port/listener.
//
// Multi-market (plan 2, Task 8): `/mark` and `/prices` take `?market=<SYMBOL>`
// (absent = SOL), `GET /markets` lists the registry's PUBLIC `Market` params,
// and `/ws?markets=*|A,B` picks which markets' `mark` frames a client gets.
// Every change is additive for the APK already in users' hands: it never
// sends `?market=`/`?markets=`, so it keeps seeing exactly SOL.
//
// Numbers: Pool bigint fields come back from `store.ts` already
// as strings (pg's default bigint→string parsing) and are passed through
// unchanged — never `Number(...)`-coerced, since `capital_total` etc could
// exceed 2^53 as USDC volume grows (documented in README). Candle
// o/h/l/c stay plain JSON numbers: a USD price in 1e6 scale (BTC included,
// ~1e11) is nowhere near 2^53.

import express from "express";
import type { Router } from "express";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Server } from "http";
import type { DbPool } from "../db.js";
import { aggregateCandles, tfMsOf } from "./candles.js";
import { ORACLE_STALE_MS, isStale } from "./prices.js";
import { latestPoolSnapshot, latestRoot, latestTick, listPoolSnapshots, listTicks } from "./store.js";
import { parseMarketParam, parsePoolHistoryQuery } from "./query.js";
import type { WsMessage } from "./accounts.js";
import type { MarketInfo } from "../markets.js";

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.trunc(n), max);
}

export interface IndexerRouterOpts {
  /** The market registry's current list (markets.ts) — `/markets` and the `?market=` whitelist. */
  markets: () => MarketInfo[];
}

export function indexerRouter(pool: DbPool, opts: IndexerRouterOpts): Router {
  const router = express.Router();
  // Before the registry's first successful read the list is empty; SOL stays
  // queryable anyway — accounts.ts indexes SOL's feed without waiting for the
  // registry, so its ticks are there to serve.
  const known = (): string[] => {
    const list = opts.markets();
    return list.length === 0 ? ["SOL"] : list.map((m) => m.symbol);
  };

  // Public `Market` fields only — `marketRisk` is deliberately not served
  // (MarketRisk is private, risk #24; its address alone says nothing, but the
  // contract stays "only what the program itself publishes").
  router.get("/markets", (_req, res) => {
    res.json(opts.markets().map((m) => ({ symbol: m.symbol, market: m.market.toBase58(), feed: m.feed.toBase58(), params: m.params })));
  });

  router.get("/prices", async (req, res) => {
    const mq = parseMarketParam(req.query.market, known());
    if (!mq.ok) {
      res.status(mq.status).json({ error: mq.error });
      return;
    }
    const tf = String(req.query.tf ?? "1m");
    let tfMs: number;
    try {
      tfMs = tfMsOf(tf);
    } catch {
      res.status(400).json({ error: `unknown tf: ${tf} (expected 1m|5m|15m)` });
      return;
    }
    const limit = clampLimit(req.query.limit, 300, 1000);
    // Enough history to cover `limit` buckets, plus one extra bucket's
    // margin for a tick landing right on a boundary.
    const sinceTs = Date.now() - tfMs * (limit + 1);
    const ticks = await listTicks(pool, mq.value, sinceTs);
    const candles = aggregateCandles(ticks, tf, limit).map((c) => ({ t: c.t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c) }));
    res.json({ market: mq.value, tf, candles });
  });

  router.get("/mark", async (req, res) => {
    const mq = parseMarketParam(req.query.market, known());
    if (!mq.ok) {
      res.status(mq.status).json({ error: mq.error });
      return;
    }
    const t = await latestTick(pool, mq.value);
    const now = Date.now();
    // Week-5 Task 5: staleness is judged on the ORACLE's own `publish_time`,
    // not on `ts` (when this relayer happened to receive the update) — the
    // TEE pushes a notification every ER slot regardless of whether the feed
    // changed, so arrival time cannot distinguish a live publisher from a
    // frozen one. `publishTime` is exposed alongside so a client can judge
    // for itself. (The base-layer copy of the delegated feed is a stale
    // COMMIT snapshot, never a live fallback — hence surfacing staleness
    // rather than failing over to it.)
    const stale = isStale(t?.publishTime ?? null, now, ORACLE_STALE_MS);
    res.json(
      t
        ? { market: mq.value, price: t.price.toString(), slot: t.slot, ts: t.ts, publishTime: t.publishTime, stale }
        : { market: mq.value, price: null, slot: null, ts: null, publishTime: null, stale: true },
    );
  });

  // Paginated backwards in time: `X-Next-Cursor` (a slot) is set only when the
  // page is full; pass it back as `?cursor=` for the next-older page.
  router.get("/pool/history", async (req, res) => {
    const q = parsePoolHistoryQuery(req.query);
    if (!q.ok) {
      res.status(400).json({ error: q.error });
      return;
    }
    const items = await listPoolSnapshots(pool, q.value);
    if (items.length === q.value.limit) res.setHeader("X-Next-Cursor", String(items[0].slot));
    res.json(items);
  });

  router.get("/pool/latest", async (_req, res) => {
    res.json(await latestPoolSnapshot(pool));
  });

  router.get("/root/latest", async (_req, res) => {
    const r = await latestRoot(pool);
    res.json(r ? { root_slot: r.rootSlot, filled: r.filled, leavesHex: r.leavesHex } : null);
  });

  return router;
}

export interface WsHub {
  broadcast(msg: WsMessage): void;
  clientCount(): number;
  close(): void;
}

export type WsFilter = Set<string> | "all";

/**
 * `/ws?markets=*|A,B` — absent keeps the pre-plan-2 contract: SOL marks only.
 * An old APK reads ANY `mark` frame as SOL's price, so sending it BTC's marks
 * would show BTC's price as SOL's (Review Focus 1).
 */
export function wsFilterFrom(url: string | undefined): WsFilter {
  const q = new URL(url ?? "/ws", "http://x").searchParams.get("markets");
  if (q === "*") return "all";
  if (!q) return new Set(["SOL"]);
  // REST answers 400 for a bad symbol; a WS upgrade has no such channel, so
  // junk is dropped and an all-junk list degrades to the old-client default.
  const syms = q
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{1,8}$/.test(s));
  return new Set(syms.length ? syms : ["SOL"]);
}

/** Only `mark` frames are per market; `pool` goes to every client. */
export function wsWants(filter: WsFilter, msg: WsMessage): boolean {
  if (msg.type !== "mark" || filter === "all") return true;
  return filter.has(String(msg.market ?? "SOL"));
}

/** Attaches a `ws` server to the existing HTTP server at path `/ws`. */
export function attachWs(server: Server, opts: { heartbeatMs?: number } = {}): WsHub {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Map<WebSocket, { filter: WsFilter; alive: boolean }>();
  wss.on("connection", (ws, req) => {
    clients.set(ws, { filter: wsFilterFrom(req.url), alive: true });
    ws.on("pong", () => {
      const c = clients.get(ws);
      if (c) c.alive = true;
    });
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });
  // C.3: a phone that dropped off the network never sends a FIN — without a
  // heartbeat its socket sits in `clients` forever and every broadcast is
  // written into the void.
  const heartbeat = setInterval(() => {
    for (const [ws, c] of clients) {
      if (!c.alive) {
        clients.delete(ws);
        ws.terminate();
        continue;
      }
      c.alive = false;
      ws.ping();
    }
  }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref();
  return {
    broadcast(msg) {
      const data = JSON.stringify(msg);
      for (const [ws, c] of clients) {
        if (ws.readyState === ws.OPEN && wsWants(c.filter, msg)) ws.send(data);
      }
    },
    clientCount: () => clients.size,
    close: () => {
      clearInterval(heartbeat);
      wss.close();
    },
  };
}
