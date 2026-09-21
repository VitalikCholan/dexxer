// scripts/crank-fallback/index.ts
//
// Fallback for the ER scheduler (spec §3.5): "Бекенду нема. Crank — у ER
// (scheduler), fallback-скрипт зовні". Signer is `Config.crank`: week 1 that
// was the same keypair as admin; week 2 (Task 6) adds a `DEXXER_NET=devnet`
// profile, where `Config.crank` is a dedicated `devnet-crank` keypair
// (`tests/er/.keys/devnet-crank.json`, per `bootstrapDevnet()`'s
// `init_config(crank.publicKey, ...)` call — see tests/er/lib/admin.ts) that
// is also a member of every private trader's `EphemeralPermission`
// (`[owner, session, crank]`, set during onboarding) — required for this
// script's candidate-discovery `getProgramAccounts` call to see private
// `Position` accounts at all (measured, week2-results.md Task 1 §M2:
// unauthenticated/non-member tokens get `null`/`[]` back, not an error).
//
// Every CRANK_INTERVAL_MS (default 1000): find every `Position` account on
// the ER via `getProgramAccounts` + a Position-discriminator memcmp filter,
// keep the ones with `state == Open`, pair each with its owner's
// `UserAccount`, and send `crank_tick` in chunks of <=16 candidate pairs
// (`MAX_CANDIDATES`, programs/dexxer_core/src/state/mod.rs). `feed` is read
// off the on-chain `Market.feed` field each tick (Task 6: not an env var —
// unlike week 1's `FEED_ID`/`LAZER_FEED_ID`, this works unchanged for both
// the local mock-oracle feed and devnet's real Pricing Oracle feed, since
// both are simply whatever `init_market` wrote into `Market.feed`). One log
// line per chunk: `tick n=... slot=... mark=... mark_slot=... sig=... cu=... tick_ms=... candidates=... liquidated=[...]`.
// SIGINT exits the loop after the in-flight tick finishes.
//
// Devnet profile (`DEXXER_NET=devnet`): same `tests/er/.env`-hardcodes-local
// issue documented in `scripts/admin/devnet-bootstrap.ts` and
// `tests/er/devnet/00-measure.ts`/`01-onboard-private.ts` — `lib/env.ts`'s
// `cfg()` reads `.env` *over* the `devnet` profile's own defaults unless the
// same env vars are already set in `process.env` before `lib/env.ts` first
// resolves them. Fixed the same way: force the devnet profile's endpoints
// into `process.env` *before* the dynamic `import("../../tests/er/lib/env.js")`
// below (this file was a plain top-level module with static imports before
// Task 6; converting it to top-level-await + dynamic imports is what makes
// the env-forcing order actually work — a static import is hoisted above any
// module-body code that would otherwise run first).
//
// Three mb-stack/devnet-tee quirks fixed here, none reproducible on LiteSVM
// (no real ER/RPC there):
//
// 1. Duplicate-transaction guard: `crank_tick` takes no instruction args, so
//    two back-to-back ticks against an unchanged candidate set build
//    byte-identical messages whenever `getLatestBlockhash("processed")` hands
//    out the same blockhash twice in a row — identical message bytes sign to
//    an identical signature, and the ER then rejects the resend with "This
//    transaction has already been processed." (reproduced even a full
//    CRANK_INTERVAL_MS apart between ticks). Fixed by `freshBlockhash()`
//    below: it polls until the blockhash differs from the one the previous
//    tick used — ER slots are ~50ms, so this is at most one or two 200ms
//    poll waits.
//
// 2. `Connection.confirmTransaction` always races a `signatureSubscribe`
//    websocket notification against an internal timeout, in EVERY call
//    shape. That notification does not reliably arrive on this validator
//    (its ws port accepts connections fine; it just doesn't push the
//    event), so both shapes can stall for tens of seconds per call.
//    `confirmSignature` (tests/er/lib/env.ts) sidesteps this entirely by
//    polling `getSignatureStatuses` directly.
//
// 3. (Task 6) devnet-tee auth tokens are per-identity and can go stale (401)
//    or a request can simply hang past what's reasonable for a 1s tick
//    cadence (timeout). `reconnect()` below re-derives a fresh `teeConn(crank)`
//    (a brand-new signed auth token) and is triggered from the tick loop's
//    catch whenever an error looks like a 401/timeout/connection-reset,
//    rather than letting the whole process crash on a transient TEE auth
//    hiccup. Locally (`DEXXER_NET` unset) `teeConn` returns the plain
//    unauthenticated `erConn` unchanged, so this codepath is a no-op there.
//
// Week 3 (Task 7): every `DISCLOSURE_EVERY_TICKS` ticks (~5 min at the
// default 1s cadence — the same cadence as the `Pool` commit itself, since
// `commit_aggregate` below IS that commit), `runRootCycle` then
// `runDisclosureCycle` (scripts/crank-fallback/disclosure.ts) run root BEFORE
// disclosure, so a `commit_aggregate` call always carries a freshly computed
// `BalancesRoot`. Both are wrapped in their own try/catch here so a failure
// in either never kills the 1s tick loop — see disclosure.ts's own per-call
// try/catch for the finer-grained (per-action) version of the same rule.

export {}; // module marker: top-level await below requires this file to be a module (also keeps `let stop` below out of the global/DOM scope)

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { PublicKey, Transaction } = await import("@solana/web3.js");
const { NET, baseConn, confirmSignature, loadOrCreateKey, sleep, teeConn } = await import("../../tests/er/lib/env.js");
const { POSITION_DISC, accountNs, dexxerCoreProgram, pdas } = await import("../../tests/er/lib/program.js");
const { runDisclosureCycle, runRootCycle } = await import("./disclosure.js");
type PublicKeyT = InstanceType<typeof PublicKey>;

const crank = loadOrCreateKey(NET === "devnet" ? "devnet-crank" : "admin");
// Week 3 (Task 7): `commit_aggregate`'s `payer` must equal `Config.fee_payer`
// exactly (task-7 brief) — locally that's `admin` (see `bootstrap()`'s
// `init_config` call in tests/er/lib/admin.ts), on devnet the dedicated
// `devnet-fee-payer` identity (see `bootstrapDevnet()`).
const feePayer = loadOrCreateKey(NET === "devnet" ? "devnet-fee-payer" : "admin");
const INTERVAL = Number(process.env.CRANK_INTERVAL_MS ?? 1000);
// Week 3 (Task 7): cadence for `runRootCycle`/`runDisclosureCycle` — the same
// 300-tick (~5 min at the default 1s INTERVAL) interval as the `Pool` commit
// itself.
const DISCLOSURE_EVERY_TICKS = 300;

// Must match `programs/dexxer_core/src/state/mod.rs`'s `MAX_CANDIDATES`
// (crank_tick's Accounts context requires `remaining_accounts.len() / 2 <=
// MAX_CANDIDATES`, checked on-chain).
const MAX_CANDIDATES = 16;

let stop = false;
process.on("SIGINT", () => {
  stop = true;
});

// Mutable connection/program pair (Task 6: refreshed on auth/timeout errors
// — see file header point 3). `var`-like `let` bindings at module scope
// rather than a class: matches this file's existing style (module-level
// `crank`/`INTERVAL`/etc above).
let conn = await teeConn(crank);
let prog = dexxerCoreProgram(conn, crank);
// Week 3 (Task 7): separate connection/program pair, authenticated as
// `feePayer` — `commit_aggregate`'s only accepted `payer` signer, distinct
// from `crank`'s identity (see disclosure.ts's `DisclosureCtx`).
let feePayerConn = await teeConn(feePayer);
let feePayerProg = dexxerCoreProgram(feePayerConn, feePayer);
let lastBlockhash: string | null = null;

function looksLikeAuthOrTimeout(e: unknown): boolean {
  const msg = String(e instanceof Error ? e.message : e);
  return /\b401\b|unauthor|timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(msg);
}

async function reconnect(): Promise<void> {
  conn = await teeConn(crank);
  prog = dexxerCoreProgram(conn, crank);
  feePayerConn = await teeConn(feePayer);
  feePayerProg = dexxerCoreProgram(feePayerConn, feePayer);
  lastBlockhash = null; // the old value belongs to the just-replaced connection
  console.log("crank-fallback: reconnected (fresh TEE auth token)");
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

interface Ctx {
  market: PublicKeyT;
  marketRisk: PublicKeyT;
  pool: PublicKeyT;
  /** Week 3 (Task 7): `runRootCycle`/`runDisclosureCycle` — see disclosure.ts. */
  balancesRoot: PublicKeyT;
  feeEscrow: PublicKeyT;
}

async function tick(ctx: Ctx, n: number): Promise<void> {
  const positions = await conn.getProgramAccounts(prog.programId, {
    filters: [{ memcmp: { offset: 0, bytes: POSITION_DISC } }],
  });
  // "position" (lowercase): `new Program(idl, ...)` camelCases every
  // `idl.accounts[].name` on the copy it hands to `BorshCoder` (so
  // `program.account.position` works), but each entry keeps its original
  // pre-computed `discriminator` bytes — `POSITION_DISC` above is
  // unaffected either way, since it's read straight off the on-disk IDL.
  const openCandidates = positions
    .map((p) => ({ key: p.pubkey, acc: prog.coder.accounts.decode("position", p.account.data) }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((p) => "open" in (p.acc as any).state);

  // Task 6 finding (real devnet-tee data, not a hypothetical): gPA turned up
  // several leftover `Position` accounts from earlier week-2 Task 5 sessions
  // whose paired `UserAccount` PDA still has the OLD (pre-fix-round-2)
  // 110-byte layout — `UserAccount` grew to 118 bytes when
  // `last_withdraw_slot` was added. `crank_tick`'s on-chain
  // `UserAccount::try_deserialize` rejects those short buffers with Anchor's
  // `AccountDidNotDeserialize` (3003), which aborts the WHOLE transaction —
  // including every other, decodable candidate in the same chunk — since the
  // instruction processes remaining_accounts in one loop with `?`
  // early-return. Filtering stale-layout candidates out client-side (a
  // batched decode-attempt against the CURRENT UserAccount coder, same as
  // `.decode("position", ...)` above) is the fix: it's this script's own
  // candidate-discovery step, not a program change, and a single bad
  // leftover test account should never be able to stall every real
  // liquidation candidate sharing its tick.
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

  // Task 6: feed read off the live Market account each tick, not an env var
  // (works unchanged for the local mock-oracle feed and devnet's real
  // Pricing Oracle feed — both are just whatever `init_market` wrote here).
  const marketAcc = await accountNs(prog).market.fetch(ctx.market);
  const feed = marketAcc.feed as PublicKeyT;

  const slot = await conn.getSlot("confirmed");
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
      .accounts({ crank: crank.publicKey, config: pdas.config(), market: ctx.market, marketRisk: ctx.marketRisk, pool: ctx.pool, feed })
      .remainingAccounts(remaining)
      .instruction();

    const sendT0 = Date.now();
    const { blockhash } = await freshBlockhash();
    const txn = new Transaction({ feePayer: crank.publicKey, recentBlockhash: blockhash }).add(ix);
    txn.sign(crank);
    const sig = await conn.sendRawTransaction(txn.serialize(), { skipPreflight: true });
    await confirmSignature(conn, sig);
    const tickMs = Date.now() - sendT0;

    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const cu = tx?.meta?.computeUnitsConsumed ?? null;

    for (const p of chunk) {
      const after = await accountNs(prog).position.fetch(p.key);
      if ("closed" in after.state) liquidated.push(p.key.toBase58());
    }

    const market = await accountNs(prog).market.fetch(ctx.market);
    console.log(
      `tick n=${n} slot=${slot} mark=${market.mark.toString()} mark_slot=${market.markSlot.toString()} sig=${sig} cu=${cu} tick_ms=${tickMs} candidates=${chunk.length} liquidated=${JSON.stringify(liquidated)}`,
    );
  }
}

async function main(): Promise<void> {
  const config = await accountNs(prog).config.fetch(pdas.config());
  const market = pdas.market();
  const marketRisk = pdas.marketRisk(market);
  const pool = pdas.pool(config.dusdcMint as PublicKeyT);
  const balancesRoot = pdas.balancesRoot();
  const feeEscrow = pdas.feeEscrow();
  console.log("crank-fallback starting", {
    net: NET,
    crank: crank.publicKey.toBase58(),
    feePayer: feePayer.publicKey.toBase58(),
    market: market.toBase58(),
    pool: pool.toBase58(),
    balancesRoot: balancesRoot.toBase58(),
    intervalMs: INTERVAL,
    disclosureEveryTicks: DISCLOSURE_EVERY_TICKS,
  });

  let n = 0;
  while (!stop) {
    const t0 = Date.now();
    n += 1;
    try {
      await tick({ market, marketRisk, pool, balancesRoot, feeEscrow }, n);
    } catch (e) {
      console.error("tick failed", String(e));
      if (looksLikeAuthOrTimeout(e)) {
        try {
          await reconnect();
        } catch (re) {
          console.error("reconnect failed", String(re));
        }
      }
    }

    // Week 3 (Task 7): root BEFORE disclosure, so `commit_aggregate` always
    // carries a freshly computed `BalancesRoot`. Each cycle is its own
    // try/catch — see file header point (Task 7) and disclosure.ts's own
    // per-action try/catch — so neither ever kills this 1s tick loop.
    if (n % DISCLOSURE_EVERY_TICKS === 0) {
      const cycleCtx = { baseConn, conn, prog, crank, feePayerConn, feePayerProg, feePayer, pool, balancesRoot, feeEscrow };
      try {
        await runRootCycle(cycleCtx);
      } catch (e) {
        console.error("runRootCycle failed", String(e));
      }
      try {
        await runDisclosureCycle(cycleCtx);
      } catch (e) {
        console.error("runDisclosureCycle failed", String(e));
      }
    }

    await sleep(Math.max(0, INTERVAL - (Date.now() - t0)));
  }
  console.log("crank-fallback stopped (SIGINT)");
}

main().catch((e) => {
  console.error("crank-fallback FAIL", e);
  process.exit(1);
});
