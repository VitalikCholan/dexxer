// scripts/admin/schedule-crank.ts
//
// Task 6: register `crank_tick` as a Magic Actions scheduled task on
// devnet-tee, so the ER's own scheduler keeps ticking `Market`'s EMA/mark
// forward even when the crank-fallback script (scripts/crank-fallback) isn't
// running — spec §8 Q2 / week-2 controller ruling task-4 #2.
// `programs/dexxer_core/src/instructions/crank.rs`'s `schedule_crank` is
// ER-only (writes `Market`/`MarketRisk`/`Pool`, all delegated — see that
// file's header comment on `ScheduleCrank`), so this script's admin call
// goes through `teeConn(admin)`, not `baseConn`, unlike most of
// `devnet-bootstrap.ts`. Kept as a separate script rather than folded into
// `devnet-bootstrap.ts` (task-6 brief left this as a judgment call) because
// every other bootstrap step runs on the base layer before the relevant PDA
// is delegated — this one only makes sense to run *after* `delegate_market`/
// `delegate_pool`, strictly on the ER, which would make it an odd outlier in
// that file's mostly-L1 sequence.
//
// `task_id`: first 8 bytes of SHA-256(program id bytes), read as a signed
// little-endian i64 (task-6 brief's formula: "task_id = hash(program
// id)[..8] as i64"). Deterministic per-deployment, not per-run. NOT
// idempotency-checked against `Config.crank_task_id` (task-6 fix round 3):
// that field can no longer be written on-chain at all (see
// `programs/dexxer_core/src/instructions/crank.rs`'s `ScheduleCrank.config`
// doc comment) — it always reads back `0`. Re-running this script re-sends
// `schedule_crank` with the same task_id every time; per the `magicblock`
// skill's `references/cranks.md`, "Rescheduling an existing task_id is an
// update only when the existing authority authorizes it" — same admin, same
// task_id here, so this is a safe reschedule/update, not a collision.
//
// Run (same DEXXER_NET requirement/order as devnet-bootstrap.ts — run that
// first so Config/Market/MarketRisk/Pool exist and are delegated):
//   cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/schedule-crank.ts
//
// task_context (ScheduleCrank's 7th remaining_account, matches the on-chain
// `expected` order [task_context, crank, config, market, market_risk, pool,
// feed]): week2-results.md Task 1's task-context finding — neither
// `ephemeral-rollups-sdk` 0.16.2 nor `magicblock-magic-program-api` 0.10.1
// expose an on-chain PDA derivation for this account, and empirically *any*
// consistent, already-existing account works at this position (a spike
// passed a duplicate payer and ticks still ran).
//
// Task-6 fix round 3, real on-chain evidence (the actual root cause of the
// "Account 2: <config> was illegally used as writable" /
// `TransactionError::InvalidWritableAccount` failure — turned out to be
// NEITHER the flat-`CRANK_SIGNER` issue (fix round 1) NOR a "config must be
// read-only" rule (fix round 2's working hypothesis, kept anyway as a
// harmless simplification — see `ScheduleCrank.config`'s doc comment): this
// script originally set `task_context = config` (the SAME address as the
// separately-passed, read-only `config` slot). `task_context` legitimately
// needs to be writable (`#[account(mut)] pub task_context`, Magic Program's
// own bookkeeping), and Solana's transaction compiler deduplicates repeated
// pubkeys to the WIDEST privilege requested anywhere in the message — so
// `config`, appearing a second time under the SAME address as the writable
// `task_context`, inherited that writable privilege regardless of what this
// script asked for at the `config` slot specifically. Fixed by giving
// `task_context` a DIFFERENT address that doesn't collide with anything else
// referenced here: `admin.publicKey` — directly mirroring Task 1 M1's own
// validated precedent ("a spike passed a duplicate payer and ticks still
// ran"), and consistent (`admin` is already writable+signer in this same
// transaction, so no new privilege is introduced).
//
// `crank` account (task-6 fix round 2, superseding fix round 1's flat
// `CRANK_SIGNER` attempt): must be `crank_signer_pda(admin)` — a PDA scoped
// to THIS schedule call's admin/payer, seeds `["crank-executor",
// admin.as_ref()]` under `CRANK_PROGRAM_ID`
// (`Crank11111111111111111111111111111111111111`). Real on-chain evidence
// (both attempts): `ER_VALIDATOR` failed with "Crank ERR: only the crank
// signer PDA can be a signer in cranks (invalid signer:
// 'MTEWGuq...')"; the flat, authority-independent `CRANK_SIGNER` constant
// from `magicblock-magic-program-api` 0.10.1's `pda.rs`
// (`431bz9ziJVBCqea1gSxzmxvm1Bn1qJoZzSNHoweNc1f1`, matches Task 1 M1's
// independently-measured value) failed with the SAME error, naming that
// exact value as the "invalid signer" this time — because the deployed
// devnet-tee validator runs a newer `magicblock-magic-program-api` than
// 0.10.1, whose `process_schedule_task` derives the accepted signer as
// `crank_signer_pda(payer_pubkey)` (per-authority, not a flat constant) —
// confirmed by reading the pinned validator source directly
// (`programs/magicblock/src/schedule_task/{mod,process_schedule_task}.rs`
// at commit 9c7a94470af1785d88f4c671571f87c146a93779 of
// magicblock-labs/magicblock-validator). See
// `programs/dexxer_core/src/instructions/crank.rs`'s `schedule_crank` for
// the matching on-chain derivation and week2-results.md §Task 6 for the
// full evidence trail (both failed attempts' sigs/logs).

export {}; // module marker: top-level await below requires this file to be a module

import { createHash } from "node:crypto";

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { BN } = await import("@coral-xyz/anchor");
const { PublicKey } = await import("@solana/web3.js");
const { NET, loadOrCreateKey, sendAndConfirmIx, teeConn } = await import("../../tests/er/lib/env.js");
const { accountNs, dexxerCoreProgram, pdas } = await import("../../tests/er/lib/program.js");
const { MAGIC_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");

if (NET !== "devnet") {
  console.error(
    `FAIL: DEXXER_NET must be "devnet" to run this script (got "${NET}"). ` +
      "Run: DEXXER_NET=devnet npx tsx scripts/admin/schedule-crank.ts",
  );
  process.exit(1);
}

const INTERVAL_MS = 1_000;
const ITERATIONS = 86_400; // 1000ms * 86_400 == 24h of ticks

// magicblock-magic-program-api (current, post-0.10.1): CRANK_SEED =
// b"crank-executor" under CRANK_PROGRAM_ID, PDA seeds
// [CRANK_SEED, authority.as_ref()] — see the header comment above.
const CRANK_PROGRAM_ID = new PublicKey("Crank11111111111111111111111111111111111111");
function crankSignerPda(authority: InstanceType<typeof PublicKey>): InstanceType<typeof PublicKey> {
  return PublicKey.findProgramAddressSync([Buffer.from("crank-executor"), authority.toBuffer()], CRANK_PROGRAM_ID)[0];
}

async function main(): Promise<void> {
  const admin = loadOrCreateKey("devnet-admin");
  const config = pdas.config();
  const market = pdas.market();
  const marketRisk = pdas.marketRisk(market);
  const crankSigner = crankSignerPda(admin.publicKey);

  const conn = await teeConn(admin);
  const core = dexxerCoreProgram(conn, admin);

  const configBefore = await accountNs(core).config.fetch(config);
  const pool = pdas.pool(configBefore.dusdcMint);
  const marketAcc = await accountNs(core).market.fetch(market);
  const feed = marketAcc.feed;

  const { DEXXER_CORE_PROGRAM_ID } = await import("../../tests/er/lib/program.js");
  const programHash = createHash("sha256").update(DEXXER_CORE_PROGRAM_ID.toBuffer()).digest();
  const taskId = programHash.readBigInt64LE(0);
  console.log("program id", DEXXER_CORE_PROGRAM_ID.toBase58(), "-> task_id", taskId.toString());

  console.log("admin", admin.publicKey.toBase58());
  console.log("config", config.toBase58(), "(Config.crank_task_id is always 0 on-chain now, see header comment — not read/checked here)");
  console.log("scheduler_signer (Config field, informational only — NOT used as the crank account below)", (configBefore.schedulerSigner as { toBase58: () => string }).toBase58());
  console.log("crank_signer_pda(admin) (actual crank account)", crankSigner.toBase58());
  console.log("market", market.toBase58(), "market_risk", marketRisk.toBase58(), "pool", pool.toBase58(), "feed", feed.toBase58());

  const taskContext = admin.publicKey; // task-6 fix round 3 — see header comment (must NOT collide with config's address)

  const ix = await core.methods
    .scheduleCrank(new BN(taskId.toString()), new BN(INTERVAL_MS), new BN(ITERATIONS))
    .accounts({
      admin: admin.publicKey,
      config,
      market,
      marketRisk,
      pool,
      feed,
      crank: crankSigner,
      taskContext,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: taskContext, isWritable: true, isSigner: false },
      { pubkey: crankSigner, isWritable: false, isSigner: false },
      // config: NOT writable (task-6 fix round 3) — a writable, non-delegated
      // account here is rejected by the validator with
      // TransactionError::InvalidWritableAccount ("Account N: <config> was
      // illegally used as writable"). market/market_risk/pool stay writable
      // — they ARE delegated, which the same real-world test showed is fine.
      { pubkey: config, isWritable: false, isSigner: false },
      { pubkey: market, isWritable: true, isSigner: false },
      { pubkey: marketRisk, isWritable: true, isSigner: false },
      { pubkey: pool, isWritable: true, isSigner: false },
      { pubkey: feed, isWritable: false, isSigner: false },
    ])
    .instruction();

  const sig = await sendAndConfirmIx(conn, admin, ix);
  console.log("schedule_crank sig", sig, "task_id", taskId.toString());
}

main().catch((e) => {
  console.error("schedule-crank FAIL", e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
