// scripts/crank-fallback/index.ts
//
// Fallback for the ER scheduler (spec §3.5): "Бекенду нема. Crank — у ER
// (scheduler), fallback-скрипт зовні". Signer is `Config.crank` — in week 1
// that's the same keypair as admin (see tests/er/lib/admin.ts's
// `initConfig(admin.publicKey, ...)` call, whose first arg is `crank`).
//
// Every CRANK_INTERVAL_MS (default 1000): find every `Position` account on
// the ER via `getProgramAccounts` + a Position-discriminator memcmp filter,
// keep the ones with `state == Open`, pair each with its owner's
// `UserAccount`, and send `crank_tick` in chunks of <=16 candidate pairs
// (`MAX_CANDIDATES`, programs/dexxer_core/src/state/mod.rs). One log line per
// chunk: `tick n=... slot=... mark=... sig=... cu=... tick_ms=... candidates=... liquidated=[...]`.
// SIGINT exits the loop after the in-flight tick finishes.
//
// Two mb-stack quirks fixed here, neither reproducible on LiteSVM (no real
// ER/RPC there):
//
// 1. Duplicate-transaction guard: `crank_tick` takes no instruction args, so
//    two back-to-back ticks against an unchanged candidate set build
//    byte-identical messages whenever `erConn.getLatestBlockhash()` hands out
//    the same blockhash twice in a row — identical message bytes sign to an
//    identical signature, and the ER then rejects the resend with "This
//    transaction has already been processed." (reproduced even a full
//    CRANK_INTERVAL_MS apart between ticks). Fixed by `freshBlockhash()`
//    below: it polls `getLatestBlockhash("processed")` and only returns once
//    the blockhash differs from the one the previous tick used — ER slots
//    are ~50ms, so this is at most one or two 200ms poll waits.
//
// 2. `Connection.confirmTransaction` always races a `signatureSubscribe`
//    websocket notification against an internal timeout, in EVERY call
//    shape — the modern `{signature, blockhash, lastValidBlockHeight}`
//    strategy object, and even the deprecated single-signature-string form
//    Anchor's `.rpc()` falls back to (confirmed: a 30s timeout). That
//    notification does not reliably arrive on this validator (its ws port
//    accepts connections fine; it just doesn't push the event), so both
//    shapes can stall for tens of seconds per call — including plain
//    `.rpc()` calls elsewhere in this repo (trader.ts's ER sends hit this
//    too; see its header comment). `confirmSignature` (tests/er/lib/env.ts)
//    sidesteps this entirely by polling `getSignatureStatuses` directly,
//    the same idiom `waitDelegated`/`waitAccountExists` already use there.

import { PublicKey, Transaction } from "@solana/web3.js";
import { confirmSignature, erConn, loadOrCreateKey, sleep } from "../../tests/er/lib/env.js";
import { LAZER_FEED_ID } from "../../tests/er/lib/admin.js";
import { POSITION_DISC, accountNs, dexxerCoreProgram, pdas } from "../../tests/er/lib/program.js";

const crank = loadOrCreateKey("admin"); // week 1: admin == Config.crank
const INTERVAL = Number(process.env.CRANK_INTERVAL_MS ?? 1000);
const FEED_ID = process.env.FEED_ID ?? LAZER_FEED_ID;
const prog = dexxerCoreProgram(erConn, crank);

// Must match `programs/dexxer_core/src/state/mod.rs`'s `MAX_CANDIDATES`
// (crank_tick's Accounts context requires `remaining_accounts.len() / 2 <=
// MAX_CANDIDATES`, checked on-chain).
const MAX_CANDIDATES = 16;

let stop = false;
process.on("SIGINT", () => {
  stop = true;
});

let lastBlockhash: string | null = null;

/** A blockhash guaranteed different from the one the previous tick used. */
async function freshBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  for (;;) {
    const res = await erConn.getLatestBlockhash("processed");
    if (res.blockhash !== lastBlockhash) {
      lastBlockhash = res.blockhash;
      return res;
    }
    await sleep(200);
  }
}

interface Ctx {
  market: PublicKey;
  marketRisk: PublicKey;
  pool: PublicKey;
  feed: PublicKey;
}

async function tick(ctx: Ctx, n: number): Promise<void> {
  const positions = await erConn.getProgramAccounts(prog.programId, {
    filters: [{ memcmp: { offset: 0, bytes: POSITION_DISC } }],
  });
  // "position" (lowercase): `new Program(idl, ...)` camelCases every
  // `idl.accounts[].name` on the copy it hands to `BorshCoder` (so
  // `program.account.position` works), but each entry keeps its original
  // pre-computed `discriminator` bytes — `POSITION_DISC` above is
  // unaffected either way, since it's read straight off the on-disk IDL.
  const open = positions
    .map((p) => ({ key: p.pubkey, acc: prog.coder.accounts.decode("position", p.account.data) }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((p) => "open" in (p.acc as any).state);

  const slot = await erConn.getSlot("confirmed");
  const liquidated: string[] = [];
  // At least one iteration even with zero open positions, so the market's
  // mark/EMA still advances every tick (matches the brief's crank-fallback
  // pseudocode: `for (let i = 0; i < Math.max(1, open.length); i += 16)`,
  // with the literal `16` replaced by `MAX_CANDIDATES` here).
  for (let i = 0; i < Math.max(1, open.length); i += MAX_CANDIDATES) {
    const chunk = open.slice(i, i + MAX_CANDIDATES);
    const remaining = chunk.flatMap((p) => [
      { pubkey: p.key, isWritable: true, isSigner: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pubkey: pdas.userAccount(new PublicKey((p.acc as any).owner)), isWritable: true, isSigner: false },
    ]);
    const ix = await prog.methods
      .crankTick()
      .accounts({ crank: crank.publicKey, config: pdas.config(), market: ctx.market, marketRisk: ctx.marketRisk, pool: ctx.pool, feed: ctx.feed })
      .remainingAccounts(remaining)
      .instruction();

    const sendT0 = Date.now();
    const { blockhash } = await freshBlockhash();
    const txn = new Transaction({ feePayer: crank.publicKey, recentBlockhash: blockhash }).add(ix);
    txn.sign(crank);
    const sig = await erConn.sendRawTransaction(txn.serialize(), { skipPreflight: true });
    await confirmSignature(erConn, sig);
    const tickMs = Date.now() - sendT0;

    const tx = await erConn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const cu = tx?.meta?.computeUnitsConsumed ?? null;

    for (const p of chunk) {
      const after = await accountNs(prog).position.fetch(p.key);
      if ("closed" in after.state) liquidated.push(p.key.toBase58());
    }

    const market = await accountNs(prog).market.fetch(ctx.market);
    console.log(
      `tick n=${n} slot=${slot} mark=${market.mark.toString()} sig=${sig} cu=${cu} tick_ms=${tickMs} candidates=${chunk.length} liquidated=${JSON.stringify(liquidated)}`,
    );
  }
}

async function main(): Promise<void> {
  const config = await accountNs(prog).config.fetch(pdas.config());
  const market = pdas.market();
  const marketRisk = pdas.marketRisk(market);
  const pool = pdas.pool(config.dusdcMint as PublicKey);
  const feed = pdas.feed(FEED_ID);
  console.log("crank-fallback starting", {
    crank: crank.publicKey.toBase58(),
    market: market.toBase58(),
    pool: pool.toBase58(),
    feed: feed.toBase58(),
    intervalMs: INTERVAL,
  });

  let n = 0;
  while (!stop) {
    const t0 = Date.now();
    n += 1;
    try {
      await tick({ market, marketRisk, pool, feed }, n);
    } catch (e) {
      console.error("tick failed", String(e));
    }
    await sleep(Math.max(0, INTERVAL - (Date.now() - t0)));
  }
  console.log("crank-fallback stopped (SIGINT)");
}

main().catch((e) => {
  console.error("crank-fallback FAIL", e);
  process.exit(1);
});
