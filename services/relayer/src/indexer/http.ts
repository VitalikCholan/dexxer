// services/relayer/src/indexer/http.ts
//
// REST + WS surface for the public-data indexer (Task 5). `indexerRouter`
// mounts on the same Express `app` index.ts already runs `/healthz` on;
// `attachWs` attaches a `ws` server to the same underlying `http.Server` at
// path `/ws` — no separate port/listener.
//
// Numbers: Pool/Disclosure bigint fields come back from `store.ts` already
// as strings (pg's default bigint→string parsing) and are passed through
// unchanged — never `Number(...)`-coerced, since `capital_total` etc could
// exceed 2^53 as USDC volume grows (documented in README). Candle
// o/h/l/c stay plain JSON numbers: SOL/USD in 1e6 scale is nowhere near
// 2^53.

import express from "express";
import type { Router } from "express";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Server } from "http";
import type { DbPool } from "../db.js";
import { aggregateCandles, tfMsOf } from "./candles.js";
import { ORACLE_STALE_MS, isStale } from "./prices.js";
import { latestPoolSnapshot, latestRoot, latestTick, listDisclosures, listPoolSnapshots, listTicks } from "./store.js";
import type { WsMessage } from "./accounts.js";

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.trunc(n), max);
}

export function indexerRouter(pool: DbPool): Router {
  const router = express.Router();

  router.get("/prices", async (req, res) => {
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
    const ticks = await listTicks(pool, sinceTs);
    const candles = aggregateCandles(ticks, tf, limit).map((c) => ({ t: c.t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c) }));
    res.json({ tf, candles });
  });

  router.get("/mark", async (_req, res) => {
    const t = await latestTick(pool);
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
        ? { price: t.price.toString(), slot: t.slot, ts: t.ts, publishTime: t.publishTime, stale }
        : { price: null, slot: null, ts: null, publishTime: null, stale: true },
    );
  });

  router.get("/pool/history", async (req, res) => {
    const limit = clampLimit(req.query.limit, 100, 1000);
    res.json(await listPoolSnapshots(pool, limit));
  });

  router.get("/pool/latest", async (_req, res) => {
    res.json(await latestPoolSnapshot(pool));
  });

  router.get("/disclosures", async (req, res) => {
    const limit = clampLimit(req.query.limit, 100, 1000);
    res.json(await listDisclosures(pool, limit));
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

/** Attaches a `ws` server to the existing HTTP server at path `/ws`. */
export function attachWs(server: Server): WsHub {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });
  return {
    broadcast(msg) {
      const data = JSON.stringify(msg);
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(data);
      }
    },
    clientCount: () => clients.size,
    close: () => wss.close(),
  };
}
