// tests/er/devnet/07-balances-root.ts
//
// Week 3 Task 8 (M-E): `BalancesRoot` root-cycle + commit round trip
// on real devnet, plus a 12x `commit_aggregate` cost measurement now that
// every commit carries TWO accounts (`Pool` and `BalancesRoot` — week 3,
// unlike week 2's single-`Pool` `03-commit-cycle.ts`).
//
// `runRootCycle` reuse: services/relayer/src/commit.ts's `runRootCycle`
// does exactly this batching (fetch every `UserAccount` via crank-token
// `getProgramAccounts`, `ROOT_BATCH`=16 per `set_balances_root` call,
// `begin`/`finalize` on the first/last batch), but it lives in the relayer's
// own npm package and its `CommitCtx` bundles both the crank AND fee-payer
// connections — importing it here would make `tests/er`'s `tsc --noEmit`
// reach across a sibling package's relative-import graph for no real benefit
// (the batching loop itself is ~15 lines). Replicated inline below instead
// (`runRootCycleInline`), same logic, same account list, so the two stay
// trivially comparable if `commit.ts` changes.
//
// `BalancesRoot` is `zero_copy` (controller ruling 5, week 3 task 5) —
// Anchor's Borsh `BorshAccountsCoder` cannot decode its `repr(C)`/bytemuck
// layout, so every read below goes through raw `getAccountInfo` +
// `decodeBalancesRoot` (program.ts), never `program.account.balancesRoot.fetch`.
//
// PASS lines (brief): implicit via `assert()` — see the block comments below
// for exactly which invariants this measures (leaf membership, `filled` vs
// real trader count, padding non-collision, 64/64 leaves changed across two
// consecutive cycles).
//
// Run: `npm run devnet:root` (from tests/er). Requires `devnet-bootstrap.ts`
// (this script also calls it itself, idempotently) and ideally a prior
// `01-onboard-private.ts` run (so at least one known trader's
// free_margin/exit_salt can be checked against the published root) — if
// `.keys/devnet-run-latest.json` is missing, this script still runs the
// root-cycle/commit/12x-cost measurements, just skips the leaf-membership
// check against a specific known trader and says so.

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { randomBytes } = await import("crypto");
const { PublicKey } = await import("@solana/web3.js");
const { MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { NET, baseConn, loadOrCreateKey, sendAndConfirmIx, teeConn, sleep } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { USER_DISC, ROOT_BATCH, ROOT_LEAVES, accountNs, dexxerCoreProgram, pdas, decodeBalancesRoot, leaf } = await import("../lib/program.js");
const { bootstrapDevnet } = await import("../lib/admin.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:root`);
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = resolve(HERE, "..", ".keys");
const NUM_COST_COMMITS = 12;
const MIN_INTERVAL_MS = 5_000;

async function pollBase<T>(label: string, fn: () => Promise<T | null>, tries = 60, delayMs = 2000): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v !== null) return v;
    await sleep(delayMs);
  }
  throw new Error(`timeout polling for ${label} (${tries * delayMs}ms)`);
}

async function main() {
  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const crank = loadOrCreateKey("devnet-crank");
  const feePayer = loadOrCreateKey("devnet-fee-payer");

  const crankConn = await teeConn(crank);
  const crankCore = dexxerCoreProgram(crankConn, crank);
  const feePayerConn = await teeConn(feePayer);
  const feePayerCore = dexxerCoreProgram(feePayerConn, feePayer);
  const cfg = await accountNs(feePayerCore).config.fetch(pdas.config());
  const coreBaseAdmin = dexxerCoreProgram(baseConn, boot.admin);

  async function runRootCycleInline(): Promise<{ filled: number; rootSlotEr: bigint; owners: InstanceType<typeof PublicKey>[] }> {
    const userAccs = await crankConn.getProgramAccounts(crankCore.programId, { filters: [{ memcmp: { offset: 0, bytes: USER_DISC } }] });
    // LEGACY-LAYOUT FINDING (measured while building this script — see
    // weeks0-5-history.md#week-3 §Task 8): this devnet deployment carries `UserAccount`
    // PDAs from before `exit_salt`/`last_withdraw_slot` were added to the
    // struct (weeks 1-2 testing, same program id, never migrated) — 150B
    // (current) vs 110B/118B (pre-week3). `set_balances_root`'s Rust loop
    // (`UserAccount::try_deserialize` + a PDA-derivation `require!`) does not
    // error cleanly on these: it was observed to fail the WHOLE batch with
    // `InvalidLeafAccount` (0x6035) the first time this script ran, because
    // the short/legacy bytes still parse far enough to produce a garbage
    // `owner` field whose derived PDA then mismatches the account's own key.
    // The crank is explicitly allowed to omit a user from a root cycle (spec
    // risk #19 — "the crank chooses which accounts to include ... it can
    // omit a user"), so this client-side pre-filter (decode + verify the PDA
    // matches, using the same program coder any real crank would have)
    // exercises exactly that allowance rather than patching the program:
    // `init_if_needed` is banned (CLAUDE.md) and there is no migration ix, so
    // fixing this for real is an account-versioning task outside Task 8's
    // scope (redeploy + scripts). 8 of 12 accounts were legacy on this run.
    const filtered: (typeof userAccs)[number][] = [];
    for (const u of userAccs) {
      try {
        const ua = crankCore.coder.accounts.decode("userAccount", u.account.data);
        const owner = new PublicKey(ua.owner);
        const [exp] = PublicKey.findProgramAddressSync([Buffer.from("user"), owner.toBuffer()], crankCore.programId);
        if (exp.equals(u.pubkey)) filtered.push(u);
        else console.log(`skipping ${u.pubkey.toBase58()}: decoded owner's PDA does not match (legacy layout)`);
      } catch {
        console.log(`skipping ${u.pubkey.toBase58()}: decode failed (legacy layout, ${u.account.data.length}B)`);
      }
    }
    console.log(`UserAccount scan: ${userAccs.length} found, ${filtered.length} current-layout, ${userAccs.length - filtered.length} skipped as legacy`);
    const owners = filtered.map((u) => u.pubkey);
    const paddingSeed = Array.from(randomBytes(32));
    const batches: InstanceType<typeof PublicKey>[][] = [];
    for (let i = 0; i < owners.length; i += ROOT_BATCH) batches.push(owners.slice(i, i + ROOT_BATCH));
    if (batches.length === 0) batches.push([]);

    for (let i = 0; i < batches.length; i++) {
      const begin = i === 0;
      const finalize = i === batches.length - 1;
      const ix = await crankCore.methods
        .setBalancesRoot(begin, finalize, paddingSeed)
        .accounts({ crank: crank.publicKey, config: pdas.config(), balancesRoot: boot.balancesRoot })
        .remainingAccounts(batches[i].map((pk) => ({ pubkey: pk, isWritable: false, isSigner: false })))
        .instruction();
      const sig = await sendAndConfirmIx(crankConn, crank, ix);
      console.log(`set_balances_root batch ${i + 1}/${batches.length} (${batches[i].length} accounts): ${sig}`);
    }
    const erInfo = await crankConn.getAccountInfo(boot.balancesRoot, "confirmed");
    if (!erInfo) throw new Error("balances_root not found on ER after cycle");
    const erRoot = decodeBalancesRoot(erInfo.data);
    console.log(`ER balances_root after cycle: filled=${erRoot.filled} root_slot=${erRoot.rootSlot}`);
    return { filled: erRoot.filled, rootSlotEr: erRoot.rootSlot, owners };
  }

  async function commitAggregateEmpty(): Promise<string> {
    const ix = await feePayerCore.methods
      .commitAggregate()
      .accounts({
        config: pdas.config(), payer: feePayer.publicKey, pool: boot.pool, poolLive: boot.poolLive, balancesRoot: boot.balancesRoot,
        feeEscrow: boot.feeEscrow, magicFeeVault: cfg.magicFeeVault, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
      })
      .instruction();
    return sendAndConfirmIx(feePayerConn, feePayer, ix);
  }

  async function baseRootSlot(): Promise<bigint | null> {
    const info = await baseConn.getAccountInfo(boot.balancesRoot, "confirmed");
    if (!info) return null;
    return decodeBalancesRoot(info.data).rootSlot;
  }

  // === cycle #1: root + commit, then verify against a known trader ===
  console.log("\n=== root cycle #1 ===");
  const prevBaseRootSlot = (await baseRootSlot()) ?? -1n;
  const cycle1 = await runRootCycleInline();
  console.log("commit_aggregate (root cycle #1)...");
  const commitSig1 = await commitAggregateEmpty();
  console.log("commit_aggregate sig:", commitSig1);

  const baseInfo1 = await pollBase("BalancesRoot.root_slot advance (cycle #1)", async () => {
    const slot = await baseRootSlot();
    return slot !== null && slot > prevBaseRootSlot && slot === cycle1.rootSlotEr ? slot : null;
  });
  const info1 = await baseConn.getAccountInfo(boot.balancesRoot, "confirmed");
  const decoded1 = decodeBalancesRoot(info1!.data);
  console.log(`base BalancesRoot after cycle #1: root_slot=${decoded1.rootSlot} filled=${decoded1.filled} version=${decoded1.version}`);
  assert(decoded1.rootSlot === cycle1.rootSlotEr, "base root_slot == ER root_slot after commit (cycle #1)");
  assert(decoded1.filled <= cycle1.owners.length, `filled (${decoded1.filled}) <= real trader count (${cycle1.owners.length})`);
  assert(decoded1.filled <= ROOT_LEAVES, "filled <= ROOT_LEAVES");

  const pointerPath = resolve(KEYS_DIR, "devnet-run-latest.json"); // written by 01-onboard-private.ts
  if (existsSync(pointerPath)) {
    const runState = JSON.parse(readFileSync(pointerPath, "utf8"));
    const owner = loadOrCreateKey(runState.traderName);
    const ownerConn = await teeConn(owner);
    const coreOwnerEr = dexxerCoreProgram(ownerConn, owner);
    const userAccount = pdas.userAccount(owner.publicKey);
    const ua = await accountNs(coreOwnerEr).userAccount.fetch(userAccount);
    const freeMargin = BigInt(ua.freeMargin.toString());
    const exitSalt = Uint8Array.from(ua.exitSalt as number[]);
    const expectedLeaf = leaf(owner.publicKey, freeMargin, exitSalt, decoded1.rootSlot);
    const expectedLeafHex = Buffer.from(expectedLeaf).toString("hex");
    const found = decoded1.leaves.findIndex((l) => Buffer.from(l).toString("hex") === expectedLeafHex);
    console.log(`known trader ${owner.publicKey.toBase58()}: free_margin=${freeMargin} leaf=${expectedLeafHex} found at index ${found}`);
    assert(found >= 0, `leaf(owner, free_margin, exit_salt, root_slot) ∈ leaves for known trader`);
    assert(found < decoded1.filled, "known trader's leaf is within the real (non-padding) filled range");

    // padding slots (index >= filled) must never equal a real trader's leaf
    let paddingCollision = false;
    for (let i = decoded1.filled; i < ROOT_LEAVES; i++) {
      if (Buffer.from(decoded1.leaves[i]).toString("hex") === expectedLeafHex) paddingCollision = true;
    }
    assert(!paddingCollision, "no padding slot (index >= filled) equals the known real leaf");
  } else {
    console.log(`(skipping known-trader leaf-membership check — ${pointerPath} not found; run 01-onboard-private.ts first for that assertion)`);
  }

  // === cycle #2: root + commit again, assert ALL 64 leaves changed ===
  console.log("\n=== root cycle #2 (assert all 64 leaves change vs cycle #1) ===");
  await sleep(3000); // let at least one slot pass so root_slot genuinely advances
  const cycle2 = await runRootCycleInline();
  const commitSig2 = await commitAggregateEmpty();
  console.log("commit_aggregate sig:", commitSig2);
  const baseInfo2 = await pollBase("BalancesRoot.root_slot advance (cycle #2)", async () => {
    const slot = await baseRootSlot();
    return slot !== null && slot > decoded1.rootSlot && slot === cycle2.rootSlotEr ? slot : null;
  });
  const info2 = await baseConn.getAccountInfo(boot.balancesRoot, "confirmed");
  const decoded2 = decodeBalancesRoot(info2!.data);
  console.log(`base BalancesRoot after cycle #2: root_slot=${decoded2.rootSlot} filled=${decoded2.filled}`);

  let changed = 0;
  for (let i = 0; i < ROOT_LEAVES; i++) {
    if (Buffer.from(decoded1.leaves[i]).toString("hex") !== Buffer.from(decoded2.leaves[i]).toString("hex")) changed++;
  }
  console.log(`leaves changed between cycle #1 and cycle #2: ${changed}/${ROOT_LEAVES}`);
  assert(changed === ROOT_LEAVES, "all 64 leaves changed across two consecutive root cycles");

  // === FeeEscrow ER balance before/after NUM_COST_COMMITS commit_aggregate
  // calls, each committing TWO accounts (Pool + BalancesRoot) — compare with
  // week 2's single-account 03-commit-cycle.ts measurement (0 lamports below
  // nonce 25 on that escrow). ===
  console.log(`\n=== ${NUM_COST_COMMITS}x commit_aggregate cost measurement (two committed accounts: Pool + BalancesRoot) ===`);
  const results: { i: number; ok: boolean; sig?: string; err?: string; escrowBefore: number; escrowAfter: number }[] = [];
  for (let i = 1; i <= NUM_COST_COMMITS; i++) {
    const escrowBefore = await feePayerConn.getBalance(boot.feeEscrow, "confirmed").catch(() => -1);
    try {
      const sig = await commitAggregateEmpty();
      const escrowAfter = await feePayerConn.getBalance(boot.feeEscrow, "confirmed").catch(() => -1);
      console.log(`commit #${i}: OK sig=${sig} escrow ${escrowBefore} -> ${escrowAfter} (delta ${escrowBefore >= 0 && escrowAfter >= 0 ? escrowAfter - escrowBefore : "n/a"})`);
      results.push({ i, ok: true, sig, escrowBefore, escrowAfter });
    } catch (e: any) {
      const escrowAfter = await feePayerConn.getBalance(boot.feeEscrow, "confirmed").catch(() => -1);
      const msg = e?.message ?? String(e);
      console.log(`commit #${i}: FAILED — ${msg}`);
      results.push({ i, ok: false, err: msg, escrowBefore, escrowAfter });
    }
    if (i < NUM_COST_COMMITS) await sleep(MIN_INTERVAL_MS);
  }
  console.log("\n=== cost SUMMARY ===");
  for (const r of results) {
    console.log(`#${r.i}: ${r.ok ? "OK" : "FAIL"} escrow ${r.escrowBefore}->${r.escrowAfter} (delta ${r.escrowBefore >= 0 && r.escrowAfter >= 0 ? r.escrowAfter - r.escrowBefore : "n/a"})${r.sig ? ` sig=${r.sig}` : ""}`);
  }
  const succeeded = results.filter((r) => r.ok).length;
  console.log(`succeeded=${succeeded}/${NUM_COST_COMMITS}`);

  console.log("\n07-BALANCES-ROOT PASS");
}

main().catch((e) => {
  console.error("07-balances-root FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
