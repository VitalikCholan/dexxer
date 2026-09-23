// services/relayer/src/crank.ts
//
// Moved from scripts/crank-fallback/index.ts (Task 4, week 4): the
// `tick()`/`main()` loop, minus `process.exit`/`SIGINT` (index.ts now owns
// process lifecycle — see `requestStop` below) and minus the
// `DEXXER_NET=devnet` env-forcing dance (index.ts does that, as plain
// top-level statements, before it dynamically imports this module — see
// index.ts's header comment for why that has to be a dynamic import).
//
// `startCrank(cfg, state)` mutates the shared `RelayerState` object on every
// successful tick/commit so `health.ts` can report `lastTickAt`/
// `lastCommitAt`/`tick` without polling this module or the chain again.
//
// Fallback for the ER scheduler (spec §3.5): "Бекенду нема. Crank — у ER
// (scheduler), fallback-скрипт зовні". Signer is `Config.crank` — on devnet
// a dedicated `devnet-crank` identity (`tests/er/.keys/devnet-crank.json`
// locally, `CRANK_KEY_B58` on Railway — see keys.ts) that is also a member
// of every private trader's `EphemeralPermission` (`[owner, session,
// crank]`, set during onboarding) — required for this file's
// candidate-discovery `getProgramAccounts` call to see private `Position`
// accounts at all.
//
// Every `CRANK_INTERVAL_MS` (default 1000): find every `Position` account
// on the ER via `getProgramAccounts` + a Position-discriminator memcmp
// filter, keep the ones with `state == Open`, pair each with its owner's
// `UserAccount`, and send `crank_tick` in chunks of <=8 candidate triples
// (`CRANK_TX_MAX_CANDIDATES` — the legacy-transaction size ceiling, below;
// the program itself accepts up to `MAX_CANDIDATES` = 16). `feed` is read
// off the on-chain `Market.feed` field each tick. One log line per chunk:
// `tick n=... slot=... mark=... mark_slot=... sig=... cu=... tick_ms=...
// candidates=... liquidated=[...]`.
//
// Three mb-stack/devnet-tee quirks fixed here, none reproducible on LiteSVM
// (no real ER/RPC there) — unchanged from scripts/crank-fallback/index.ts:
//
// 1. Duplicate-transaction guard (`freshBlockhash()` below): `crank_tick`
//    takes no instruction args, so two back-to-back ticks against an
//    unchanged candidate set build byte-identical messages whenever
//    `getLatestBlockhash("processed")` hands out the same blockhash twice in
//    a row — identical message bytes sign to an identical signature, and
//    the ER then rejects the resend with "This transaction has already been
//    processed."
//
// 2. `Connection.confirmTransaction`'s websocket-based confirmation stalls
//    unreliably on this validator — `confirmSignature` (tests/er/lib/env.ts)
//    polls `getSignatureStatuses` directly instead.
//
// 3. devnet-tee auth tokens are per-identity and can go stale (401) or hang
//    past what's reasonable for a 1s tick cadence — `reconnect()` below
//    re-derives a fresh `teeConn` and is triggered from the tick loop's
//    catch on anything that looks like a 401/timeout/connection-reset.
//
// Week 3 (Task 7): every `COMMIT_INTERVAL_TICKS` ticks (300 by default,
// ~5 min at the default 1s cadence; env-tunable since week-5 Task 5),
// `runRootCycle` then `runDisclosureCycle` (disclosure.ts) run root BEFORE
// disclosure, so a `commit_aggregate` call always carries a freshly computed
// `BalancesRoot`, and then `runOrphanCycle` (orphan.ts) reclaims the queues
// of owners who have finished leaving. All three are wrapped in their own
// try/catch here so a failure in any never kills the 1s tick loop.

import { ComputeBudgetProgram, Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import { confirmSignature, sleep, teeConn } from "../../../tests/er/lib/env.js";
import type { Net } from "../../../tests/er/lib/env.js";
import { POSITION_DISC, accountNs, dexxerCoreProgram, pdas } from "../../../tests/er/lib/program.js";
import { runDisclosureCycle, runRootCycle } from "./disclosure.js";
import { orphanDeps, runOrphanCycle } from "./orphan.js";

type PublicKeyT = InstanceType<typeof PublicKey>;

export interface RelayerState {
  lastTickAt: number | null;
  lastCommitAt: number | null;
  tick: number;
  /** Bounded ring of recent error strings (most recent last) — see MAX_ERRORS below. */
  errors: string[];
}

export interface RelayerConfig {
  net: Net;
  baseRpc: string;
  /** Not read by startCrank directly — teeConn()/baseConn (tests/er/lib/env.ts, imported below) already resolve the ER endpoint from the same process.env forcing index.ts does before import. Kept on the config shape for future consumers (Task 5 indexer). */
  erRpc: string;
  erWs: string;
  crank: Keypair;
  feePayer: Keypair;
  port: number;
  /** Task 5 (indexer) — off until that task wires it up. */
  indexerEnabled: boolean;
  /** Task 6 (sponsor) — off until that task wires it up. */
  sponsorEnabled: boolean;
  databaseUrl?: string;
}

const INTERVAL = Number(process.env.CRANK_INTERVAL_MS ?? 1000);
// Week 3 (Task 7): cadence for `runRootCycle`/`runDisclosureCycle` — the
// same interval as the `Pool` commit itself, because `commit_aggregate` IS
// that commit.
//
// Week-5 Task 5: made an env knob (was a hard-coded 300 = ~5 min at the
// default 1s INTERVAL). The reveal delay and this interval together decide
// how long a closed trade takes to reach L1, and the week-5 demo needs that
// measured in a minute rather than five — see `/healthz.commitIntervalTicks`
// and README's env table. A non-positive or unparseable value falls back to
// the default rather than spinning the cycle every tick.
const DEFAULT_COMMIT_INTERVAL_TICKS = 300;
function parseCommitInterval(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_COMMIT_INTERVAL_TICKS);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : DEFAULT_COMMIT_INTERVAL_TICKS;
}
export const COMMIT_INTERVAL_TICKS = parseCommitInterval(process.env.COMMIT_INTERVAL_TICKS);
// How many candidates actually fit in ONE legacy (non-v0) transaction, which
// is what this client sends. Since week-5 Task 1 a candidate is a
// `[Position, UserAccount, DisclosureQueue]` triple, so a chunk costs 3
// account keys instead of 2: 8 triples plus the ComputeBudget instruction
// measure ~1175 bytes, and 9 overflow the 1232-byte packet limit
// (`Transaction too large`). The on-chain cap
// (`programs/dexxer_core/src/state/mod.rs`'s `MAX_CANDIDATES` = 16) is
// deliberately left higher — a v0 transaction with an address-lookup table
// could use all of it — but this client must chunk at the tx ceiling, or a
// market with 9+ open positions would fail EVERY tick and stop both
// liquidations and the mark/EMA advance.
const CRANK_TX_MAX_CANDIDATES = 8;
const MAX_ERRORS = 50;

let stopRequested = false;

/** index.ts calls this from its SIGTERM/SIGINT handler; the in-flight tick still finishes. */
export function requestStop(): void {
  stopRequested = true;
}

function looksLikeAuthOrTimeout(e: unknown): boolean {
  const msg = String(e instanceof Error ? e.message : e);
  return /\b401\b|unauthor|timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(msg);
}

function pushError(state: RelayerState, e: unknown): void {
  state.errors.push(String(e instanceof Error ? e.message : e));
  if (state.errors.length > MAX_ERRORS) state.errors.shift();
}

interface Ctx {
  market: PublicKeyT;
  marketRisk: PublicKeyT;
  pool: PublicKeyT;
  /** Private live pool counters (week 4, Task 1) — `crank_tick`/`commit_aggregate` both need this now. */
  poolLive: PublicKeyT;
  /** Week 3 (Task 7): `runRootCycle`/`runDisclosureCycle` — see disclosure.ts. */
  balancesRoot: PublicKeyT;
  feeEscrow: PublicKeyT;
}

export async function startCrank(cfg: RelayerConfig, state: RelayerState): Promise<void> {
  let conn = await teeConn(cfg.crank);
  let prog = dexxerCoreProgram(conn, cfg.crank);
  // Week 3 (Task 7): separate connection/program pair, authenticated as
  // `feePayer` — `commit_aggregate`'s only accepted `payer` signer, distinct
  // from `crank`'s identity (see disclosure.ts's `DisclosureCtx`).
  let feePayerConn = await teeConn(cfg.feePayer);
  let feePayerProg = dexxerCoreProgram(feePayerConn, cfg.feePayer);
  // Week-5 Task 5: the orphan janitor's base-layer half (`close_exited_user`)
  // is a plain L1 transaction signed by `fee_payer` — no TEE auth, no
  // reconnect dance, so this pair is built once and never re-derived.
  const baseConn = new Connection(cfg.baseRpc, "confirmed");
  const baseFeePayerProg = dexxerCoreProgram(baseConn, cfg.feePayer);
  let lastBlockhash: string | null = null;

  async function reconnect(): Promise<void> {
    conn = await teeConn(cfg.crank);
    prog = dexxerCoreProgram(conn, cfg.crank);
    feePayerConn = await teeConn(cfg.feePayer);
    feePayerProg = dexxerCoreProgram(feePayerConn, cfg.feePayer);
    lastBlockhash = null; // the old value belongs to the just-replaced connection
    console.log("crank: reconnected (fresh TEE auth token)");
  }

  /** A blockhash guaranteed different from the one the previous tick used. */
  async function freshBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    for (;;) {
      const res = await conn.getLatestBlockhash("processed");
      if (res.blockhash !== lastBlockhash) {
        lastBlockhash = res.blockhash;
        return res;
      }
      await sleep(200);
    }
  }

  async function tick(ctx: Ctx, n: number): Promise<void> {
    const positions = await conn.getProgramAccounts(prog.programId, {
      filters: [{ memcmp: { offset: 0, bytes: POSITION_DISC } }],
    });
    const openCandidates = positions
      .map((p) => ({ key: p.pubkey, acc: prog.coder.accounts.decode("position", p.account.data) }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((p) => "open" in (p.acc as any).state);

    // Stale-layout leftovers (pre-migration test accounts) must not stall a
    // whole chunk's real liquidation candidates — filter client-side by
    // attempting a decode against the CURRENT UserAccount coder first (see
    // scripts/crank-fallback/index.ts's original Task 6 finding).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userAccountPdas = openCandidates.map((p) => pdas.userAccount(new PublicKey((p.acc as any).owner)));
    const userAccountInfos = userAccountPdas.length > 0 ? await conn.getMultipleAccountsInfo(userAccountPdas, "confirmed") : [];
    const open = openCandidates.filter((_, i) => {
      const info = userAccountInfos[i];
      if (!info) return false;
      try {
        prog.coder.accounts.decode("userAccount", info.data);
        return true;
      } catch (e) {
        console.error(`tick n=${n}: skipping candidate ${openCandidates[i].key.toBase58()} — paired UserAccount ${userAccountPdas[i].toBase58()} failed to decode (stale layout?): ${String(e)}`);
        return false;
      }
    });

    // Feed read off the live Market account each tick (works unchanged for
    // both a local mock-oracle feed and devnet's real Pricing Oracle feed —
    // both are simply whatever `init_market` wrote into `Market.feed`).
    const marketAcc = await accountNs(prog).market.fetch(ctx.market);
    const feed = marketAcc.feed as PublicKeyT;

    const slot = await conn.getSlot("confirmed");
    const liquidated: string[] = [];
    // At least one iteration even with zero open positions, so the market's
    // mark/EMA still advances every tick.
    for (let i = 0; i < Math.max(1, open.length); i += CRANK_TX_MAX_CANDIDATES) {
      const chunk = open.slice(i, i + CRANK_TX_MAX_CANDIDATES);
      // Triples since week-5 Task 1: a liquidation is a close, and a close
      // pushes its `ClosedRecord` into the owner's `DisclosureQueue`, so the
      // tick has to carry that account for every candidate it might liquidate.
      const remaining = chunk.flatMap((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const owner = new PublicKey((p.acc as any).owner);
        return [
          { pubkey: p.key, isWritable: true, isSigner: false },
          { pubkey: pdas.userAccount(owner), isWritable: true, isSigner: false },
          { pubkey: pdas.disclosureQueue(owner), isWritable: true, isSigner: false },
        ];
      });
      const ix = await prog.methods
        .crankTick()
        .accounts({ crank: cfg.crank.publicKey, config: pdas.config(), market: ctx.market, marketRisk: ctx.marketRisk, poolLive: ctx.poolLive, feed })
        .remainingAccounts(remaining)
        .instruction();

      const sendT0 = Date.now();
      const { blockhash } = await freshBlockhash();
      // 16 candidates measured 166k CU in LiteSVM when none liquidate and 367k
      // when all of them do (week-5 Task 1 put a `DisclosureQueue` in every
      // triple) — the liquidating case is well past the 200k default, so the
      // limit has to be raised explicitly even though a chunk is only 8 here.
      const txn = new Transaction({ feePayer: cfg.crank.publicKey, recentBlockhash: blockhash })
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(ix);
      txn.sign(cfg.crank);
      const sig = await conn.sendRawTransaction(txn.serialize(), { skipPreflight: true });
      await confirmSignature(conn, sig);
      const tickMs = Date.now() - sendT0;

      const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const cu = tx?.meta?.computeUnitsConsumed ?? null;

      for (const p of chunk) {
        const after = await accountNs(prog).position.fetch(p.key);
        // Week-5 Task 1: a liquidated position is reset straight to `Empty`
        // (the record now lives in the owner's queue), so "was open before the
        // tick, empty after it" is what a liquidation looks like from here.
        if ("empty" in after.state) liquidated.push(p.key.toBase58());
      }

      const market = await accountNs(prog).market.fetch(ctx.market);
      console.log(
        `tick n=${n} slot=${slot} mark=${market.mark.toString()} mark_slot=${market.markSlot.toString()} sig=${sig} cu=${cu} tick_ms=${tickMs} candidates=${chunk.length} liquidated=${JSON.stringify(liquidated)}`,
      );
    }
  }

  const config = await accountNs(prog).config.fetch(pdas.config());
  const market = pdas.market();
  const marketRisk = pdas.marketRisk(market);
  const pool = pdas.pool(config.dusdcMint as PublicKeyT);
  const poolLive = pdas.poolLive(config.dusdcMint as PublicKeyT);
  const balancesRoot = pdas.balancesRoot();
  const feeEscrow = pdas.feeEscrow();
  console.log("crank starting", {
    net: cfg.net,
    crank: cfg.crank.publicKey.toBase58(),
    feePayer: cfg.feePayer.publicKey.toBase58(),
    market: market.toBase58(),
    pool: pool.toBase58(),
    balancesRoot: balancesRoot.toBase58(),
    intervalMs: INTERVAL,
    commitIntervalTicks: COMMIT_INTERVAL_TICKS,
  });

  let n = 0;
  while (!stopRequested) {
    const t0 = Date.now();
    n += 1;
    try {
      await tick({ market, marketRisk, pool, poolLive, balancesRoot, feeEscrow }, n);
      state.lastTickAt = Date.now();
      state.tick = n;
    } catch (e) {
      console.error("tick failed", String(e));
      pushError(state, e);
      if (looksLikeAuthOrTimeout(e)) {
        try {
          await reconnect();
        } catch (re) {
          console.error("reconnect failed", String(re));
          pushError(state, re);
        }
      }
    }

    // Root BEFORE disclosure, so `commit_aggregate` always carries a
    // freshly computed `BalancesRoot`. Each cycle is its own try/catch, so
    // neither ever kills this 1s tick loop.
    if (n % COMMIT_INTERVAL_TICKS === 0) {
      const cycleCtx = { conn, prog, crank: cfg.crank, feePayerConn, feePayerProg, feePayer: cfg.feePayer, pool, poolLive, balancesRoot, feeEscrow };
      try {
        await runRootCycle(cycleCtx);
      } catch (e) {
        console.error("runRootCycle failed", String(e));
        pushError(state, e);
      }
      try {
        await runDisclosureCycle(cycleCtx);
        state.lastCommitAt = Date.now();
      } catch (e) {
        console.error("runDisclosureCycle failed", String(e));
        pushError(state, e);
      }
      // Week-5 Task 5: the exit-with-debt janitor, LAST in the cycle — the
      // disclosure cycle above is what drains a departing owner's ring, and
      // only a drained ring can be reclaimed, so running it after gives an
      // owner who finished paying their debt this very cycle a chance at
      // being cleaned up in the same one. Its own try/catch, like the other
      // two: a stuck orphan must never touch the 1s tick loop.
      try {
        const r = await runOrphanCycle(
          orphanDeps({
            erConn: conn,
            erProg: prog,
            crank: cfg.crank,
            baseConn,
            baseProg: baseFeePayerProg,
            feePayer: cfg.feePayer,
            magicFeeVault: config.magicFeeVault as PublicKeyT,
          }),
        );
        if (r.closedInEr.length > 0 || r.closedOnBase.length > 0 || r.errors > 0) {
          console.log(`orphan cycle: scanned=${r.scanned} closedInEr=${r.closedInEr.length} closedOnBase=${r.closedOnBase.length} skipped=${r.skipped} errors=${r.errors}`);
        }
      } catch (e) {
        console.error("runOrphanCycle failed", String(e));
        pushError(state, e);
      }
    }

    await sleep(Math.max(0, INTERVAL - (Date.now() - t0)));
  }
  console.log("crank stopped (requestStop)");
}
