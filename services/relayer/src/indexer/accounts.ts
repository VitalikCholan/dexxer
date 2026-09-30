// services/relayer/src/indexer/accounts.ts
//
// Public-only account subscriptions for the indexer (Task 5). Every read
// here uses ONLY public RPC — the TEE oracle feed read with NO auth token
// (see `oracleConn` below), and base-layer `Pool`/`BalancesRoot`,
// both of which are public accounts. This module NEVER touches
// `cfg.crank`/`cfg.feePayer` — those identities stay inside crank.ts/
// the crank/janitor modules only (CLAUDE.md privacy rule: "жоден сервіс, крім
// крank-а, не тримає owner/session-токенів"; the indexer isn't the crank
// either, it just happens to run in the same process — it reads what any
// anonymous RPC client could read).
//
// `dexxerCoreProgram`/`accountNs` below are given a throwaway, randomly
// generated `Keypair` purely to satisfy `AnchorProvider`'s `Wallet`
// constructor argument — it is never used to sign or send anything (every
// call here is a read: `.fetch`/`coder.accounts.decode`/`getAccountInfo`/
// `getProgramAccounts`), so this is not a real identity and holds no funds.
//
// Subscription strategy per account: `onAccountChange` (fast path) plus a
// periodic poll-and-refresh fallback (`subscribeAccountWithFallback`) that
// both self-heals a WS subscription that silently stopped delivering and
// covers the oracle's explicit "fall back to 1s polling on WS error"
// requirement from the brief — the poll runs on a fixed cadence rather than
// being triggered by a raw WS error event (`@solana/web3.js`'s `Connection`
// does not expose one), so the guarantee is "the data is never staler than
// `staleAfterMs`", which is the actually useful property regardless of
// what the WS subscription is doing underneath.
//
// Oracle feeds (plan 2, Task 8): one subscription per market in the registry
// (`deps.markets()`), each with its own throttle/stale-watchdog state, ticks
// written under the market's symbol and `mark` frames tagged `market`.
// `reconcile()` runs at start and every FEED_RECONCILE_MS, so a market added
// with `add-market` gets its feed indexed within ~65 s (registry refresh 60 s
// + reconcile 5 s), no restart.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { AccountInfo } from "@solana/web3.js";
import { ORACLE, baseConn } from "../../../../tests/er/lib/env.js";
import { DEXXER_CORE_PROGRAM_ID, accountNs, decodeBalancesRoot, dexxerCoreProgram, pdas } from "../../../../tests/er/lib/program.js";
import { ORACLE_STALE_MS, decodeFeed, isStale, publishTimeMs } from "./prices.js";
import { insertPoolSnapshot, insertRoot, insertTick } from "./store.js";
import type { DbPool } from "../db.js";
import type { MarketInfo } from "../markets.js";

/** SOL's devnet Lazer feed id (`tests/er/lib/admin.ts`'s `LAZER_FEED_ID`) — used ONLY as the pre-registry fallback in `reconcile()`; every other feed comes from `Market.feed`. */
const SOL_LAZER_FEED_ID = "6";

const MARK_THROTTLE_MS = 1000;
/**
 * In-memory list diff only (no RPC), so it can run often: the registry itself
 * refreshes every MARKETS_REFRESH_MS (60 s); two independent 60-s timers would
 * let a new market wait up to ~120 s — at 5 s it is indexed within ~65 s.
 */
const FEED_RECONCILE_MS = 5_000;

export interface IndexerStats {
  ticks: number;
  lastTickTs: number | null;
  /** Week-5 Task 5: the ORACLE's `publish_time` of the newest decoded update, in epoch ms — what `oracleStale` is computed from (see prices.ts::isStale). */
  lastPublishTimeMs: number | null;
  lastPoolSlot: number | null;
  /** Per market symbol — the newest oracle `publish_time` (epoch ms). The top-level `ticks`/`lastTickTs`/`lastPublishTimeMs` above keep meaning SOL (/healthz compat). */
  feeds: Record<string, { lastPublishTimeMs: number | null }>;
}

export type WsMessage = { type: "mark" | "pool"; [k: string]: unknown };
export type Broadcast = (msg: WsMessage) => void;

export interface IndexerDeps {
  pool: DbPool;
  stats: IndexerStats;
  broadcast: Broadcast;
  /** The market registry's current list (markets.ts); may be empty until its first successful read. */
  markets: () => MarketInfo[];
}

interface FallbackOpts {
  /** How often to check whether the subscription looks stale / attempt the poll fallback. */
  checkIntervalMs: number;
  /** No update in this long ⇒ treat the WS subscription as dead and resubscribe. */
  staleAfterMs: number;
}

/** `onAccountChange` + a periodic poll fallback; returns a stop function. */
function subscribeAccountWithFallback(
  conn: Connection,
  pubkey: PublicKey,
  onData: (data: Buffer, slot: number) => void,
  opts: FallbackOpts,
  label: string,
): () => void {
  let subId: number | null = null;
  // Grace period: start the staleness clock at subscribe-time, not at 0 —
  // otherwise the very first `checkIntervalMs` tick always sees a huge
  // "elapsed" and treats a perfectly healthy brand-new subscription as
  // already stale, thrashing into an immediate pointless resubscribe.
  let lastUpdateAt = Date.now();
  let stopped = false;

  function handle(info: AccountInfo<Buffer> | null, slot: number): void {
    if (!info) return;
    lastUpdateAt = Date.now();
    try {
      onData(info.data, slot);
    } catch (e) {
      console.error(`indexer/${label}: onData failed`, String(e));
    }
  }

  function subscribe(): void {
    try {
      subId = conn.onAccountChange(pubkey, (info, ctx) => handle(info as AccountInfo<Buffer>, ctx.slot), "confirmed");
    } catch (e) {
      console.error(`indexer/${label}: onAccountChange failed, relying on poll fallback`, String(e));
      subId = null;
    }
  }
  subscribe();

  const timer = setInterval(() => {
    if (stopped) return;
    const stale = Date.now() - lastUpdateAt > opts.staleAfterMs;
    if (subId === null || stale) {
      if (stale && subId !== null) {
        console.warn(`indexer/${label}: subscription looks stale, resubscribing`);
        const old = subId;
        subId = null;
        void conn.removeAccountChangeListener(old).catch(() => {});
      }
      subscribe();
      void conn
        .getAccountInfo(pubkey, "confirmed")
        .then((info) => conn.getSlot("confirmed").then((slot) => handle(info as AccountInfo<Buffer> | null, slot)))
        .catch((e) => console.error(`indexer/${label}: poll fallback failed`, String(e)));
    }
  }, opts.checkIntervalMs);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
    if (subId !== null) void conn.removeAccountChangeListener(subId).catch(() => {});
  };
}

export function startIndexer(deps: IndexerDeps): () => void {
  const { pool, stats, broadcast } = deps;
  const stops: Array<() => void> = [];
  // Read-only: never signs or sends anything (see header comment).
  const readOnly = Keypair.generate();
  const baseProg = dexxerCoreProgram(baseConn, readOnly);

  // --- oracle feeds: TEE RPC, NO auth token — a public read (privacy rule). ---
  const erRpc = process.env.ER_RPC;
  const erWs = process.env.ER_WS;
  if (!erRpc) {
    console.warn("indexer: ER_RPC not set, oracle price feed subscription disabled");
  } else {
    const oracleConn = new Connection(erRpc, { commitment: "confirmed", wsEndpoint: erWs });

    /** One market's feed: its own throttle, last price and stale-announce state. Returns a stop function. */
    function subscribeFeed(symbol: string, feedPubkey: PublicKey): () => void {
      const isSol = symbol === "SOL";
      const label = `oracle/${symbol}`;
      let lastMarkAt = 0;
      let lastPrice: bigint | null = null;
      let lastPublishTimeMs: number | null = null;
      // Fix round 1 (code review): edge-triggered — `staleAnnounced` makes
      // sure the WS "the feed went stale" frame is sent exactly once per
      // outage, not on every watchdog tick (that would spam clients every
      // second for the whole duration of a TEE outage).
      let staleAnnounced = false;
      stats.feeds[symbol] = { lastPublishTimeMs: null };

      const stopSub = subscribeAccountWithFallback(
        oracleConn,
        feedPubkey,
        (data, slot) => {
          let feed;
          try {
            feed = decodeFeed(data);
          } catch (e) {
            console.error(`indexer/${label}: decodeFeed failed`, String(e));
            return;
          }
          if (feed.postedSlot === 0n) return; // unfilled/stale — CLAUDE.md's oracle rule
          const now = Date.now();
          const publishedAt = publishTimeMs(feed.publishTime);
          lastPrice = feed.price;
          lastPublishTimeMs = publishedAt;
          stats.feeds[symbol] = { lastPublishTimeMs: publishedAt };
          if (isSol) stats.lastPublishTimeMs = publishedAt;
          // Week-5 Task 5: only a genuinely FRESH publish clears the stale
          // announcement. The TEE re-pushes the same bytes every ER slot, so
          // "a notification arrived" is not evidence the publisher is alive —
          // its `publish_time` being recent is.
          if (!isStale(publishedAt, now, ORACLE_STALE_MS)) staleAnnounced = false;
          if (now - lastMarkAt < MARK_THROTTLE_MS) return;
          lastMarkAt = now;
          if (isSol) {
            stats.ticks += 1;
            stats.lastTickTs = now;
          }
          void insertTick(pool, { market: symbol, ts: now, price: feed.price, slot, publishTime: publishedAt }).catch((e) =>
            console.error(`indexer/${label}: insertTick failed`, String(e)),
          );
          broadcast({
            type: "mark",
            market: symbol,
            price: feed.price.toString(),
            ts: now,
            publishTime: publishedAt,
            stale: isStale(publishedAt, now, ORACLE_STALE_MS),
          });
        },
        { checkIntervalMs: 1000, staleAfterMs: 3000 },
        label,
      );

      // Staleness watchdog (fix round 1, code review): the base-layer copy of
      // the delegated oracle feed is a stale COMMIT snapshot, not a live
      // fallback — a TEE outage must surface as `stale:true`, never as
      // silently frozen prices served as if live. `/mark` computes staleness
      // per-request straight off the DB row (see http.ts); this watchdog is
      // only for the WS push side, which has no "per-request" moment to
      // compute it at — it must notice the transition itself.
      const staleWatchdog = setInterval(() => {
        const now = Date.now();
        if (!staleAnnounced && isStale(lastPublishTimeMs, now, ORACLE_STALE_MS)) {
          staleAnnounced = true;
          console.warn(`indexer/${label}: feed stale by publish_time, broadcasting stale:true once`);
          broadcast({
            type: "mark",
            market: symbol,
            price: lastPrice !== null ? lastPrice.toString() : null,
            ts: now,
            publishTime: lastPublishTimeMs,
            stale: true,
          });
        }
      }, 1000);
      staleWatchdog.unref();

      return () => {
        stopSub();
        clearInterval(staleWatchdog);
      };
    }

    // Keyed by symbol: a market is subscribed once and kept for the life of
    // the process (the registry never drops a market on a failed refresh,
    // and markets are never deleted on-chain). The feed is remembered so a
    // registry `Market.feed` that differs from the pre-registry SOL fallback
    // replaces it instead of the wrong account being indexed forever.
    const feedSubs = new Map<string, { feed: PublicKey; stop: () => void }>();
    function reconcile(): void {
      const list = deps.markets();
      if (list.length === 0 && !feedSubs.has("SOL")) {
        // The registry hasn't read the ER yet (or that read failed): index
        // SOL on its known feed right away rather than waiting — SOL is the
        // market every existing client charts. When the registry later
        // brings SOL (same feed), `feedSubs` already has it — no duplicate.
        const feed = pdas.feedUnder(ORACLE, SOL_LAZER_FEED_ID);
        feedSubs.set("SOL", { feed, stop: subscribeFeed("SOL", feed) });
        return;
      }
      for (const m of list) {
        const cur = feedSubs.get(m.symbol);
        if (cur?.feed.equals(m.feed)) continue;
        cur?.stop();
        console.log(`indexer: subscribing ${m.symbol} oracle feed ${m.feed.toBase58()}`);
        feedSubs.set(m.symbol, { feed: m.feed, stop: subscribeFeed(m.symbol, m.feed) });
      }
    }
    reconcile();
    const reconcileTimer = setInterval(reconcile, FEED_RECONCILE_MS);
    reconcileTimer.unref();
    stops.push(() => {
      clearInterval(reconcileTimer);
      for (const sub of feedSubs.values()) sub.stop();
      feedSubs.clear();
    });
  }

  // --- Pool: base RPC, public account, written every ~5 min by commit_aggregate. ---
  (async () => {
    const config = await accountNs(baseProg).config.fetch(pdas.config());
    const poolAddr: PublicKey = pdas.pool(config.dusdcMint as PublicKey);
    stops.push(
      subscribeAccountWithFallback(
        baseConn,
        poolAddr,
        (data) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let p: any;
          try {
            p = baseProg.coder.accounts.decode("pool", data);
          } catch (e) {
            console.error("indexer/pool: decode failed", String(e));
            return;
          }
          const slot = Number(p.lastCommitSlot.toString());
          const now = Date.now();
          stats.lastPoolSlot = slot;
          const row = {
            slot,
            ts: now,
            capitalTotal: BigInt(p.capitalTotal.toString()),
            protocolLiquidity: BigInt(p.protocolLiquidity.toString()),
            lockedTotal: BigInt(p.lockedTotal.toString()),
            feesAccrued: BigInt(p.feesAccrued.toString()),
            insurance: BigInt(p.insurance.toString()),
            badDebtTotal: BigInt(p.badDebtTotal.toString()),
          };
          void insertPoolSnapshot(pool, row).catch((e) => console.error("indexer/pool: insertPoolSnapshot failed", String(e)));
          broadcast({
            type: "pool",
            slot,
            ts: now,
            capital_total: row.capitalTotal.toString(),
            protocol_liquidity: row.protocolLiquidity.toString(),
            locked_total: row.lockedTotal.toString(),
            fees_accrued: row.feesAccrued.toString(),
            insurance: row.insurance.toString(),
            bad_debt_total: row.badDebtTotal.toString(),
          });
        },
        { checkIntervalMs: 15_000, staleAfterMs: 6 * 60_000 }, // Pool moves ~every 5 min
        "pool",
      ),
    );
  })().catch((e) => console.error("indexer/pool: failed to resolve Pool PDA (Config fetch), subscription disabled", String(e)));

  // --- BalancesRoot: base RPC, public zero_copy account. ---
  stops.push(
    subscribeAccountWithFallback(
      baseConn,
      pdas.balancesRoot(),
      (data) => {
        let root;
        try {
          root = decodeBalancesRoot(data);
        } catch (e) {
          console.error("indexer/root: decode failed", String(e));
          return;
        }
        void insertRoot(pool, {
          rootSlot: Number(root.rootSlot.toString()),
          ts: Date.now(),
          filled: root.filled,
          leavesHex: root.leaves.map((l) => Buffer.from(l).toString("hex")),
        }).catch((e) => console.error("indexer/root: insertRoot failed", String(e)));
      },
      { checkIntervalMs: 15_000, staleAfterMs: 6 * 60_000 },
      "root",
    ),
  );

  return () => {
    for (const stop of stops) stop();
  };
}
