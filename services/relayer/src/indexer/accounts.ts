// services/relayer/src/indexer/accounts.ts
//
// Public-only account subscriptions for the indexer (Task 5). Every read
// here uses ONLY public RPC — the TEE oracle feed read with NO auth token
// (see `oracleConn` below), and base-layer `Pool`/`BalancesRoot`/
// `Disclosure`, all of which are public accounts. This module NEVER touches
// `cfg.crank`/`cfg.feePayer` — those identities stay inside crank.ts/
// disclosure.ts only (CLAUDE.md privacy rule: "жоден сервіс, крім
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
// Disclosure accounts have no interesting "change" to subscribe to (each
// one is created once and never mutated again) — new ones are discovered
// via `getProgramAccounts` memcmp every 30s plus `onProgramAccountChange`
// with the same filter for near-real-time pickup in between polls.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { AccountInfo } from "@solana/web3.js";
import { ORACLE, baseConn } from "../../../../tests/er/lib/env.js";
import { DEXXER_CORE_PROGRAM_ID, DISCLOSURE_DISC, accountNs, decodeBalancesRoot, dexxerCoreProgram, pdas } from "../../../../tests/er/lib/program.js";
import { decodeFeed } from "./prices.js";
import { insertDisclosure, insertPoolSnapshot, insertRoot, insertTick } from "./store.js";
import type { DisclosureRow } from "./store.js";
import type { DbPool } from "../db.js";

/** Same devnet SOL/USD Lazer feed id the market was `init_market`'d with — see `tests/er/lib/admin.ts`'s `LAZER_FEED_ID` / `app/src/lib/pdas.ts`'s copy. Not imported from admin.ts (a much heavier, session/admin-oriented module) just for one string constant. */
const LAZER_FEED_ID = "6";
const FEED_PUBKEY = pdas.feedUnder(ORACLE, LAZER_FEED_ID);

const MARK_THROTTLE_MS = 1000;
const DISCLOSURE_POLL_MS = 30_000;

export interface IndexerStats {
  ticks: number;
  lastTickTs: number | null;
  lastPoolSlot: number | null;
  disclosures: number;
}

export type WsMessage = { type: "mark" | "pool" | "disclosure"; [k: string]: unknown };
export type Broadcast = (msg: WsMessage) => void;

export interface IndexerDeps {
  pool: DbPool;
  stats: IndexerStats;
  broadcast: Broadcast;
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

function sideToString(v: unknown): string {
  return v !== null && typeof v === "object" && "long" in (v as Record<string, unknown>) ? "long" : "short";
}
function reasonToString(v: unknown): string {
  return v !== null && typeof v === "object" && "user" in (v as Record<string, unknown>) ? "user" : "liquidated";
}

export function startIndexer(deps: IndexerDeps): () => void {
  const { pool, stats, broadcast } = deps;
  const stops: Array<() => void> = [];
  // Read-only: never signs or sends anything (see header comment).
  const readOnly = Keypair.generate();
  const baseProg = dexxerCoreProgram(baseConn, readOnly);

  // --- oracle feed: TEE RPC, NO auth token — a public read (privacy rule). ---
  const erRpc = process.env.ER_RPC;
  const erWs = process.env.ER_WS;
  if (!erRpc) {
    console.warn("indexer: ER_RPC not set, oracle price feed subscription disabled");
  } else {
    const oracleConn = new Connection(erRpc, { commitment: "confirmed", wsEndpoint: erWs });
    let lastMarkAt = 0;
    stops.push(
      subscribeAccountWithFallback(
        oracleConn,
        FEED_PUBKEY,
        (data, slot) => {
          let feed;
          try {
            feed = decodeFeed(data);
          } catch (e) {
            console.error("indexer/oracle: decodeFeed failed", String(e));
            return;
          }
          if (feed.postedSlot === 0n) return; // unfilled/stale — CLAUDE.md's oracle rule
          const now = Date.now();
          if (now - lastMarkAt < MARK_THROTTLE_MS) return;
          lastMarkAt = now;
          stats.ticks += 1;
          stats.lastTickTs = now;
          void insertTick(pool, { ts: now, price: feed.price, slot }).catch((e) =>
            console.error("indexer/oracle: insertTick failed", String(e)),
          );
          broadcast({ type: "mark", price: feed.price.toString(), ts: now });
        },
        { checkIntervalMs: 1000, staleAfterMs: 3000 },
        "oracle",
      ),
    );
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

  // --- Disclosure: gPA discovery every 30s + onProgramAccountChange fast path. ---
  async function ingestDisclosure(pubkey: PublicKey, data: Buffer): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let d: any;
    try {
      d = baseProg.coder.accounts.decode("disclosure", data);
    } catch (e) {
      console.error(`indexer/disclosure: decode failed for ${pubkey.toBase58()}`, String(e));
      return;
    }
    const row: DisclosureRow = {
      pubkey: pubkey.toBase58(),
      side: sideToString(d.side),
      size: BigInt(d.size.toString()),
      entry: BigInt(d.entry.toString()),
      exit: BigInt(d.exit.toString()),
      pnl: BigInt(d.pnl.toString()),
      fees: BigInt(d.fees.toString()),
      reason: reasonToString(d.reason),
      openedSlot: BigInt(d.openedSlot.toString()),
      closedSlot: BigInt(d.closedSlot.toString()),
      nonce: BigInt(d.nonce.toString()),
      // Ingestion time, NOT `closed_slot`'s block time — an extra
      // `getBlockTime` per discovered Disclosure isn't worth the RPC cost
      // for a rolling public archive rather than a precise ledger
      // (documented in README).
      ts: Date.now(),
    };
    let isNew = false;
    try {
      isNew = await insertDisclosure(pool, row);
    } catch (e) {
      console.error(`indexer/disclosure: insertDisclosure failed for ${row.pubkey}`, String(e));
      return;
    }
    if (isNew) {
      stats.disclosures += 1;
      broadcast({
        type: "disclosure",
        pubkey: row.pubkey,
        side: row.side,
        size: row.size.toString(),
        entry: row.entry.toString(),
        exit: row.exit.toString(),
        pnl: row.pnl.toString(),
        fees: row.fees.toString(),
        reason: row.reason,
        opened_slot: row.openedSlot.toString(),
        closed_slot: row.closedSlot.toString(),
        nonce: row.nonce.toString(),
        ts: row.ts,
      });
    }
  }

  async function pollDisclosures(): Promise<void> {
    try {
      const accs = await baseConn.getProgramAccounts(DEXXER_CORE_PROGRAM_ID, {
        filters: [{ memcmp: { offset: 0, bytes: DISCLOSURE_DISC } }],
      });
      for (const a of accs) await ingestDisclosure(a.pubkey, a.account.data as Buffer);
    } catch (e) {
      console.error("indexer/disclosure: poll failed", String(e));
    }
  }
  void pollDisclosures(); // catch up on startup
  const disclosurePoll = setInterval(() => void pollDisclosures(), DISCLOSURE_POLL_MS);
  disclosurePoll.unref();
  stops.push(() => clearInterval(disclosurePoll));

  let disclosureSubId: number | null = null;
  try {
    disclosureSubId = baseConn.onProgramAccountChange(
      DEXXER_CORE_PROGRAM_ID,
      (info) => void ingestDisclosure(info.accountId, info.accountInfo.data as Buffer),
      "confirmed",
      [{ memcmp: { offset: 0, bytes: DISCLOSURE_DISC } }],
    );
  } catch (e) {
    console.error("indexer/disclosure: onProgramAccountChange failed, relying on 30s poll only", String(e));
  }
  stops.push(() => {
    if (disclosureSubId !== null) void baseConn.removeProgramAccountChangeListener(disclosureSubId).catch(() => {});
  });

  return () => {
    for (const stop of stops) stop();
  };
}
