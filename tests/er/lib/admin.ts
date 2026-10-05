// tests/er/lib/admin.ts
//
// Admin bootstrap for Task 13's Q1/Q2 scenarios: deploys are assumed done
// (see README), so this module creates the dUSDC mint + Config, the SOL-perp
// Market, the Pool (funded with 10_000 dUSDC), the mock oracle feed, and
// delegates Market/MarketRisk/Pool(+its eATA)/Feed to the local ER validator.
//
// Every step checks on-chain state first and skips if already done, so
// `bootstrap()` is safe to re-run against a live mb-stack.
//
// Pool order (final review C1, plan pinned by `poolBootstrapPlan` in
// ./poolBootstrap.ts and its unit test): `init_pool` -> `init_pool_live` ->
// faucet + `seed_pool` -> `delegate_pool_live` -> `delegate_pool`.
// `seed_pool` is a plain admin_ata -> pool_ata SPL transfer on L1 that also
// raises `PoolLive`'s counters; its context takes BOTH `Pool` and `PoolLive`
// as program-owned `Account<…>`s, so it must land while neither is delegated
// (a delegated account is owned by the Delegation Program on L1 -> Anchor
// 3007). The previous order (init+delegate `PoolLive`, then seed) could never
// complete on a clean start. `delegate_pool` then moves the already-funded
// pool ATA into the eSPL vault and clones `Pool` into the ER. NOT executed on
// mb-stack or devnet after this change — run a fresh `bootstrap()` on
// mb-stack before the next devnet deploy.
//
// Task 0 (week 2) adds `bootstrapDevnet()`: same PDAs, same instructions,
// but against real devnet + `devnet-tee.magicblock.app` (`ER_VALIDATOR`/
// `ORACLE` from `env.ts`'s `devnet` profile) and without the mock oracle
// (devnet uses the real Pyth Lazer feed already live inside the TEE — see
// `keys/README.md` and the week-2 plan's Global Constraints). The pool block
// is identical between the two profiles, so it is factored into
// `bootstrapPool` below and shared.

import { randomBytes } from "crypto";
import { BN, type Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  delegateSpl,
  EPHEMERAL_VAULT_ID,
  lamportsDelegatedTransferIx,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { NET, ORACLE, airdrop, baseConn, ER_VALIDATOR, loadOrCreateKey, sendAndConfirmIx, teeConn, waitDelegated } from "./env.js";
import { crankSignerPda } from "./crank-signer.js";
import { poolBootstrapPlan, type PoolBootstrapState } from "./poolBootstrap.js";
import {
  DELEGATION_PROGRAM_ID,
  DEXXER_CORE_PROGRAM_ID,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  MOCK_ORACLE_PROGRAM_ID,
  SOL_SYMBOL,
  accountNs,
  dexxerCoreProgram,
  delegationTriple,
  espl,
  mockOracleProgram,
  pdas,
} from "./program.js";

export const LAZER_FEED_ID = "6";
// devnet-tee's validator-scoped magic fee vault (M3, weeks0-5-history.md#week-2 §Task 1):
// `magicFeeVaultPdaFromValidator(ER_VALIDATOR)` = this address, measured with
// 8.39 SOL funded. Local mb-stack keeps `PublicKey.default()` (no fee-vault
// requirement there).
export const MAGIC_FEE_VAULT = new PublicKey("EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b");
export const POOL_SEED_AMOUNT = 10_000_000_000n; // 10,000 dUSDC (6 decimals)
export const MOCK_PRICE_1E8 = 15_000_000_000n; // $150.00
export const MOCK_CONF = 5_000_000n;

// Matches `MarketParams::sol_perp_defaults()` in
// programs/dexxer_core/src/state/market.rs verbatim.
export const MARKET_DEFAULTS = {
  maxLevBps: 100_000,
  imrBps: 1_000,
  mmrBps: 500,
  openFeeBps: 6,
  closeFeeBps: 6,
  liqFeeBps: 100,
  oiCap: new BN(0),
  maxPosition: new BN(100_000_000_000),
  minSize: new BN(10_000_000),
  maxStalenessSecs: new BN(2),
  maxConfBps: 50,
  maxDeviationBps: 200,
  emaAlphaBps: 3_000,
  liqHysteresisTicks: 2,
  maxStaleTicks: 30,
};

export interface Bootstrapped {
  admin: Keypair;
  mint: PublicKey;
  market: PublicKey;
  marketRisk: PublicKey;
  pool: PublicKey;
  poolAta: PublicKey;
  /** Private live pool counters (week 4, Task 1) — see `pdas.poolLive`. Both `bootstrap()`/`bootstrapDevnet()` init, seed and delegate it (`bootstrapPool`); `bootstrapDevnet()` additionally makes it (+`marketRisk`) permissioned `[crank, admin]` via `init_market_permissions` (Task 3 migration step 10). */
  poolLive: PublicKey;
  feed: PublicKey;
  /** `commit_aggregate`'s delegated CPI-payer PDA (Task 5 fix round 1 — see admin.rs `FeeEscrow`). */
  feeEscrow: PublicKey;
  sigs: Record<string, string>;
}

/** `bootstrapDevnet()`'s return value: same fields as `bootstrap()`, plus the devnet fee payer and week-3's `BalancesRoot`. */
export interface BootstrappedDevnet extends Bootstrapped {
  feePayer: Keypair;
  /** `[b"balances_root"]`, week 3 Task 5/7 — see `initAndDelegateBalancesRoot`. */
  balancesRoot: PublicKey;
}

async function ensureFunded(pubkey: PublicKey, minSol: number, label: string) {
  const bal = await baseConn.getBalance(pubkey, "confirmed");
  if (bal < minSol * 0.5 * 1_000_000_000) {
    const sig = await airdrop(baseConn, pubkey, minSol);
    console.log(`airdrop ${label}`, sig);
  }
}

/**
 * Devnet has no faucet on `baseConn` (real cluster), so unlike `ensureFunded`
 * this never tries to top up — it only checks and fails loudly. Funding the
 * admin key is a human step (task-0 brief Step 2), out of scope for this
 * function on purpose.
 */
async function requireFunded(pubkey: PublicKey, minSol: number, label: string): Promise<void> {
  const bal = await baseConn.getBalance(pubkey, "confirmed");
  if (bal < minSol * LAMPORTS_PER_SOL) {
    throw new Error(
      `${label} (${pubkey.toBase58()}) has ${bal / LAMPORTS_PER_SOL} SOL, needs >= ${minSol} SOL — fund it manually, then re-run`,
    );
  }
  console.log(`ok: ${label} funded (${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL)`);
}

/** What already exists of the pool on L1 — the input of `poolBootstrapPlan`. */
async function readPoolState(core: Program, pool: PublicKey, poolLive: PublicKey): Promise<PoolBootstrapState> {
  const [poolInfo, poolLiveInfo] = await Promise.all([
    baseConn.getAccountInfo(pool, "confirmed"),
    baseConn.getAccountInfo(poolLive, "confirmed"),
  ]);
  // A delegated account keeps its data on L1 (owner = Delegation Program), so
  // `capital_total` is read from the raw bytes, whoever owns them.
  let poolSeeded = false;
  if (poolInfo) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = core.coder.accounts.decode("pool", poolInfo.data) as any;
    poolSeeded = BigInt(p.capitalTotal.toString()) > 0n;
  }
  return {
    poolExists: poolInfo !== null,
    poolSeeded,
    poolDelegated: poolInfo !== null && poolInfo.owner.equals(DELEGATION_PROGRAM_ID),
    poolLiveExists: poolLiveInfo !== null,
    poolLiveDelegated: poolLiveInfo !== null && poolLiveInfo.owner.equals(DELEGATION_PROGRAM_ID),
  };
}

/**
 * The pool block, identical between `bootstrap()` and `bootstrapDevnet()`
 * (neither the ixs nor the PDAs differ — only `ER_VALIDATOR`, which
 * `env.ts`'s `DEXXER_NET` profile already resolves for both). Final review
 * C1: the order comes from `poolBootstrapPlan` (see the file header) and is
 * recomputed from on-chain state on every run, so a half-finished run can be
 * re-run; a state no order can finish (an account delegated before `Pool`
 * was seeded) throws with the plan's message BEFORE anything is sent.
 * Mutates `sigs` in place, matching the rest of this file's style.
 */
async function bootstrapPool(
  core: Program,
  admin: Keypair,
  config: PublicKey,
  mintAuth: PublicKey,
  mint: PublicKey,
  sigs: Record<string, string>,
): Promise<{ pool: PublicKey; poolAta: PublicKey; poolLive: PublicKey }> {
  const pool = pdas.pool(mint);
  const poolAta = pdas.poolAta(mint);
  const poolLive = pdas.poolLive(mint);
  const plan = poolBootstrapPlan(await readPoolState(core, pool, poolLive));
  if (!Array.isArray(plan)) throw new Error(`pool bootstrap cannot continue: ${plan.error}`);
  console.log(`pool bootstrap plan: ${plan.length > 0 ? plan.join(" -> ") : "(all done, skipped)"}`);

  for (const step of plan) {
    switch (step) {
      case "init_pool": {
        const sig = await core.methods
          .initPool()
          .accounts({
            admin: admin.publicKey,
            config,
            pool,
            dusdcMint: mint,
            poolAta,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .rpc();
        sigs.initPool = sig;
        console.log("init_pool", sig);
        break;
      }
      case "init_pool_live": {
        // Copies `Pool`'s current counters: zero on a clean start (seed_pool
        // below raises both), the seeded values on a deployment that predates
        // `PoolLive` (week 4 migration; `Pool` read owner-unchecked).
        const sig = await core.methods
          .initPoolLive()
          .accounts({ admin: admin.publicKey, config, pool, poolLive, systemProgram: SystemProgram.programId })
          .rpc();
        sigs.initPoolLive = sig;
        console.log("init_pool_live", sig);
        break;
      }
      case "seed_pool": {
        const adminAta = await getOrCreateAssociatedTokenAccount(baseConn, admin, mint, admin.publicKey);
        const faucetPda = pdas.faucet(admin.publicKey);
        const faucetInfo = await baseConn.getAccountInfo(faucetPda, "confirmed");
        if (!faucetInfo) {
          const sig = await core.methods
            .faucetInit(new BN(POOL_SEED_AMOUNT.toString()))
            .accounts({
              owner: admin.publicKey,
              payer: admin.publicKey,
              config,
              faucet: faucetPda,
              dusdcMint: mint,
              mintAuth,
              ownerAta: adminAta.address,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
          sigs.faucetInitAdmin = sig;
          console.log("faucet_init (admin)", sig);
        } else {
          const sig = await core.methods
            .faucetMint(new BN(POOL_SEED_AMOUNT.toString()))
            .accounts({
              owner: admin.publicKey,
              config,
              faucet: faucetPda,
              dusdcMint: mint,
              mintAuth,
              ownerAta: adminAta.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
          sigs.faucetMintAdmin = sig;
          console.log("faucet_mint (admin)", sig);
        }
        // `SeedPool`: `pool` and `pool_live` are `Account<…>` (program-owned,
        // i.e. not delegated yet) — the plan guarantees that here.
        const sig = await core.methods
          .seedPool(new BN(POOL_SEED_AMOUNT.toString()))
          .accounts({
            admin: admin.publicKey,
            config,
            pool,
            poolLive,
            adminAta: adminAta.address,
            vaultAta: poolAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        sigs.seedPool = sig;
        console.log("seed_pool (L1)", sig);
        break;
      }
      case "delegate_pool_live": {
        const t = delegationTriple(poolLive, DEXXER_CORE_PROGRAM_ID);
        const sig = await core.methods
          .delegatePoolLive()
          .accounts({
            admin: admin.publicKey,
            config,
            dusdcMint: mint,
            bufferPoolLive: t.buffer,
            delegationRecordPoolLive: t.record,
            delegationMetadataPoolLive: t.metadata,
            poolLive,
            ownerProgram: DEXXER_CORE_PROGRAM_ID,
            delegationProgram: DELEGATION_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        sigs.delegatePoolLive = sig;
        console.log("delegate_pool_live", sig);
        await waitDelegated(baseConn, poolLive, "pool_live");
        break;
      }
      case "delegate_pool": {
        // The shared eSPL global vault for this mint must exist first (admin
        // acts as the first owner purely to bootstrap the vault, matching
        // spikes/02-espl-tee).
        const vault = espl.vault(mint);
        const vaultInfo = await baseConn.getAccountInfo(vault, "confirmed");
        if (!vaultInfo) {
          const ixs = await delegateSpl(admin.publicKey, mint, 0n, {
            validator: ER_VALIDATOR,
            initVaultIfMissing: true,
            idempotent: false,
          });
          const sig = await sendAndConfirmTransaction(baseConn, new Transaction().add(...ixs), [admin], { commitment: "confirmed" });
          sigs.createVault = sig;
          console.log("delegateSpl(admin, 0) — creates global vault", sig);
        } else {
          console.log("global vault: exists, skipped");
        }
        // delegate_pool: the pool PDA + its eATA; moves the pool ATA's whole
        // (seeded) balance into the vault.
        const poolEata = espl.eata(pool, mint);
        const vaultAta = espl.vaultAta(mint, vault);
        const eataDelegation = espl.eataDelegation(poolEata);
        const pt = delegationTriple(pool, DEXXER_CORE_PROGRAM_ID);
        const sig = await core.methods
          .delegatePool()
          .accounts({
            admin: admin.publicKey,
            config,
            dusdcMint: mint,
            bufferPool: pt.buffer,
            delegationRecordPool: pt.record,
            delegationMetadataPool: pt.metadata,
            pool,
            poolAta,
            poolEata,
            vault,
            vaultAta,
            eataBuffer: eataDelegation.buffer,
            eataRecord: eataDelegation.record,
            eataMetadata: eataDelegation.metadata,
            esplProgram: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            ownerProgram: DEXXER_CORE_PROGRAM_ID,
            delegationProgram: DELEGATION_PROGRAM_ID,
          })
          .rpc();
        sigs.delegatePool = sig;
        console.log("delegate_pool", sig);
        await waitDelegated(baseConn, pool, "pool");
        break;
      }
    }
  }
  return { pool, poolAta, poolLive };
}

/**
 * Task 5 fix round 1 (controller ruling): create + delegate the dedicated
 * `FeeEscrow` PDA that `commit_aggregate` now uses as its intent CPI payer
 * (see `programs/dexxer_core/src/instructions/{admin,commit}.rs`) —
 * identical between `bootstrap()`/`bootstrapDevnet()`, so factored out the
 * same way `bootstrapPool` is. Idempotent: skips `init_fee_escrow` if
 * the PDA already exists, skips `delegate_fee_escrow` if already delegated.
 */
async function initAndDelegateFeeEscrow(core: Program, admin: Keypair, config: PublicKey, sigs: Record<string, string>): Promise<PublicKey> {
  const feeEscrow = pdas.feeEscrow();
  const info = await baseConn.getAccountInfo(feeEscrow, "confirmed");
  if (!info) {
    const sig = await core.methods
      .initFeeEscrow()
      .accounts({ admin: admin.publicKey, config, feeEscrow, systemProgram: SystemProgram.programId })
      .rpc();
    sigs.initFeeEscrow = sig;
    console.log("init_fee_escrow", sig);
  } else {
    console.log("init_fee_escrow: exists, skipped");
  }
  const infoNow = info ?? (await baseConn.getAccountInfo(feeEscrow, "confirmed"));
  if (!infoNow || !infoNow.owner.equals(DELEGATION_PROGRAM_ID)) {
    const t = delegationTriple(feeEscrow, DEXXER_CORE_PROGRAM_ID);
    const sig = await core.methods
      .delegateFeeEscrow()
      .accounts({
        admin: admin.publicKey,
        config,
        bufferFeeEscrow: t.buffer,
        delegationRecordFeeEscrow: t.record,
        delegationMetadataFeeEscrow: t.metadata,
        feeEscrow,
        ownerProgram: DEXXER_CORE_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    sigs.delegateFeeEscrow = sig;
    console.log("delegate_fee_escrow", sig);
    await waitDelegated(baseConn, feeEscrow, "fee_escrow");
  } else {
    console.log("delegate_fee_escrow: already delegated, skipped");
  }
  return feeEscrow;
}

/**
 * Week 3 (Task 5/7): create + delegate the `[b"balances_root"]` PDA that
 * `set_balances_root`/`commit_aggregate` write to — same idempotent
 * init-then-delegate shape as `initAndDelegateFeeEscrow` above (mirrors
 * `delegate_fee_escrow`'s account list, per task-7 brief).
 */
async function initAndDelegateBalancesRoot(core: Program, admin: Keypair, config: PublicKey, sigs: Record<string, string>): Promise<PublicKey> {
  const balancesRoot = pdas.balancesRoot();
  const info = await baseConn.getAccountInfo(balancesRoot, "confirmed");
  if (!info) {
    const sig = await core.methods
      .initBalancesRoot()
      .accounts({ admin: admin.publicKey, config, balancesRoot, systemProgram: SystemProgram.programId })
      .rpc();
    sigs.initBalancesRoot = sig;
    console.log("init_balances_root", sig);
  } else {
    console.log("init_balances_root: exists, skipped");
  }
  const infoNow = info ?? (await baseConn.getAccountInfo(balancesRoot, "confirmed"));
  if (!infoNow || !infoNow.owner.equals(DELEGATION_PROGRAM_ID)) {
    const t = delegationTriple(balancesRoot, DEXXER_CORE_PROGRAM_ID);
    const sig = await core.methods
      .delegateBalancesRoot()
      .accounts({
        admin: admin.publicKey,
        config,
        bufferBalancesRoot: t.buffer,
        delegationRecordBalancesRoot: t.record,
        delegationMetadataBalancesRoot: t.metadata,
        balancesRoot,
        ownerProgram: DEXXER_CORE_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    sigs.delegateBalancesRoot = sig;
    console.log("delegate_balances_root", sig);
    await waitDelegated(baseConn, balancesRoot, "balances_root");
  } else {
    console.log("delegate_balances_root: already delegated, skipped");
  }
  return balancesRoot;
}

/** Rent for a ~200-byte `EphemeralPermission` account is ≈1.5–2.5M lamports on this ER; 5M gives headroom. */
const MIN_PERMISSION_SURPLUS = 5_000_000;

/**
 * Week 4 (Task 3 fix round 1): `init_market_permissions` needs
 * `market_risk`/`pool_live` to self-fund their new `EphemeralPermission`
 * account's rent (matching `InitPermissions`'s pattern), but on this
 * devnet neither PDA carries any lamport surplus above its own
 * rent-exempt minimum, so that self-funding CPI fails with
 * `InsufficientFundsForRent` (fully investigated in fix round 0 — see
 * `instructions/user.rs`'s `InitMarketPermissions` doc comment for the
 * ruled-out in-transaction mechanisms). The sanctioned fix: top up each
 * PDA on the base layer via the eSPL sponsored delegated-lamports
 * transfer (`lamportsDelegatedTransferIx`, already used by
 * `scripts/admin/fund-fee-payer.ts` for `FeeEscrow`) — it requires the
 * destination to already be delegated, which both `market_risk` (week 1)
 * and `pool_live` (`bootstrapPool`'s `delegate_pool_live`) are by the time
 * this runs. Idempotent: skips a PDA whose ER balance already meets
 * `MIN_PERMISSION_SURPLUS`.
 */
export async function fundMarketPermissions(admin: Keypair, marketRisk: PublicKey, poolLive: PublicKey, sigs: Record<string, string>): Promise<void> {
  const conn = await teeConn(admin);
  const targets: [string, PublicKey][] = [
    ["marketRisk", marketRisk],
    ["poolLive", poolLive],
  ];
  for (const [label, dest] of targets) {
    const before = await conn.getBalance(dest, "confirmed");
    if (before >= MIN_PERMISSION_SURPLUS) {
      console.log(`fund_market_permissions: ${label} already has surplus (${before} lamports), skipped`);
      continue;
    }
    const salt = randomBytes(32);
    const ix = lamportsDelegatedTransferIx(admin.publicKey, dest, BigInt(MIN_PERMISSION_SURPLUS), salt);
    const sig = await sendAndConfirmTransaction(baseConn, new Transaction().add(ix), [admin], { commitment: "confirmed" });
    sigs[`fundMarketPermissions.${label}`] = sig;
    console.log(`lamportsDelegatedTransferIx(${label})`, sig, "amount", MIN_PERMISSION_SURPLUS, "salt", Buffer.from(salt).toString("hex"));

    const deadline = Date.now() + 60_000;
    let after = before;
    while (Date.now() < deadline) {
      after = await conn.getBalance(dest, "confirmed");
      if (after >= MIN_PERMISSION_SURPLUS) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    console.log(`fund_market_permissions: ${label} ER balance ${before} -> ${after} lamports`);
    if (after < MIN_PERMISSION_SURPLUS) {
      throw new Error(`fund_market_permissions: ${label} ER balance still ${after} < ${MIN_PERMISSION_SURPLUS} lamports after 60s (sig ${sig})`);
    }
  }
}

/**
 * Week 4 (Task 3, migration step 10, devnet only): make `MarketRisk` and
 * `PoolLive` permissioned `[crank(owner), admin(viewer)]` in one ER call —
 * `init_market_permissions` (Task 2), closing risk #24 (public-in-ER
 * market/pool aggregates — see CLAUDE.md's Architecture note). Signed by
 * `admin` (per the program's `has_one = admin` check) via its own owner-TEE
 * token — matches the original brief. Caller must run
 * `fundMarketPermissions` first (see above) so the self-funding CPI inside
 * this instruction has rent to spend; the instruction itself no longer
 * tolerates a per-account CPI failure (fix round 1 — see
 * `instructions/user.rs`), so a real failure here throws.
 */
export async function initMarketPermissions(
  admin: Keypair,
  config: PublicKey,
  market: PublicKey,
  marketRisk: PublicKey,
  poolLive: PublicKey,
  sigs: Record<string, string>,
): Promise<{ riskPermissioned: boolean; poolLivePermissioned: boolean }> {
  const conn = await teeConn(admin);
  const riskPermission = permissionPdaFromAccount(marketRisk);
  const poolLivePermission = permissionPdaFromAccount(poolLive);
  const [riskPermInfoBefore, poolLivePermInfoBefore] = await Promise.all([
    conn.getAccountInfo(riskPermission, "confirmed"),
    conn.getAccountInfo(poolLivePermission, "confirmed"),
  ]);
  const alreadyDone =
    riskPermInfoBefore !== null &&
    riskPermInfoBefore.owner.equals(PERMISSION_PROGRAM_ID) &&
    poolLivePermInfoBefore !== null &&
    poolLivePermInfoBefore.owner.equals(PERMISSION_PROGRAM_ID);
  if (alreadyDone) {
    console.log("init_market_permissions: risk_permission/pool_live_permission exist, skipped");
    return { riskPermissioned: true, poolLivePermissioned: true };
  }
  const core = dexxerCoreProgram(conn, admin);
  const ix = await core.methods
    .initMarketPermissions()
    .accounts({
      admin: admin.publicKey,
      config,
      market,
      marketRisk,
      poolLive,
      riskPermission,
      poolLivePermission,
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();
  const sig = await sendAndConfirmIx(conn, admin, ix);
  sigs.initMarketPermissions = sig;
  console.log("init_market_permissions", sig);
  // Fix round 1: the instruction now propagates every CPI error with `?`
  // (matching `init_permissions`) instead of tolerating a per-account
  // failure, so a landed `sig` already means both CPIs succeeded on-chain.
  // This post-call ownership check is the caller's own positive
  // confirmation of that (not a defense against silent tolerance) — it's
  // what `bootstrapDevnet()` throws on if either flag comes back false.
  const [riskPermInfoAfter, poolLivePermInfoAfter] = await Promise.all([
    conn.getAccountInfo(riskPermission, "confirmed"),
    conn.getAccountInfo(poolLivePermission, "confirmed"),
  ]);
  const riskPermissioned = riskPermInfoAfter !== null && riskPermInfoAfter.owner.equals(PERMISSION_PROGRAM_ID);
  const poolLivePermissioned = poolLivePermInfoAfter !== null && poolLivePermInfoAfter.owner.equals(PERMISSION_PROGRAM_ID);
  console.log(`init_market_permissions outcome: marketRisk permissioned=${riskPermissioned}, poolLive permissioned=${poolLivePermissioned}`);
  return { riskPermissioned, poolLivePermissioned };
}

export async function bootstrap(): Promise<Bootstrapped> {
  const admin = loadOrCreateKey("admin");
  await ensureFunded(admin.publicKey, 50, "admin");
  console.log("admin", admin.publicKey.toBase58());

  const core = dexxerCoreProgram(baseConn, admin);
  const oracle = mockOracleProgram(baseConn, admin);
  const sigs: Record<string, string> = {};

  const config = pdas.config();
  const mintAuth = pdas.mintAuth();
  const market = pdas.market();
  const marketRisk = pdas.marketRisk(market);
  const feed = pdas.feed(LAZER_FEED_ID);

  // --- init_config (creates the dUSDC mint). task-2: `init_config` gained
  // `fee_payer`/`magic_fee_vault` args (`Config` layout froze there). Locally
  // there's no real scheduler/fee-vault requirement, so reuse `admin` as the
  // fee payer (an admin-side keypair this function already manages) and
  // `PublicKey.default()` for the vault. ---
  let mint: PublicKey;
  const configInfo = await baseConn.getAccountInfo(config, "confirmed");
  if (!configInfo) {
    const mintKp = loadOrCreateKey("mint");
    const sig = await core.methods
      .initConfig(
        admin.publicKey,
        MOCK_ORACLE_PROGRAM_ID,
        ER_VALIDATOR,
        ER_VALIDATOR, // scheduler_signer (Task 5 M1: local mb-stack validator identity)
        admin.publicKey,
        PublicKey.default,
      )
      .accounts({
        admin: admin.publicKey,
        config,
        dusdcMint: mintKp.publicKey,
        mintAuth,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKp])
      .rpc();
    sigs.initConfig = sig;
    mint = mintKp.publicKey;
    console.log("init_config", sig, "mint", mint.toBase58());
  } else {
    const cfg = await accountNs(core).config.fetch(config);
    mint = cfg.dusdcMint as PublicKey;
    console.log("init_config: exists, skipped. mint", mint.toBase58());
  }

  // --- init_market ---
  const marketInfo = await baseConn.getAccountInfo(market, "confirmed");
  if (!marketInfo) {
    const sig = await core.methods
      .initMarket(Array.from(SOL_SYMBOL), MARKET_DEFAULTS, LAZER_FEED_ID)
      .accounts({ admin: admin.publicKey, config, market, marketRisk, systemProgram: SystemProgram.programId })
      .rpc();
    sigs.initMarket = sig;
    console.log("init_market", sig);
  } else {
    console.log("init_market: exists, skipped");
  }

  // --- mock oracle: init_feed + set_price (only while feed is still L1-owned by us) ---
  const feedInfo = await baseConn.getAccountInfo(feed, "confirmed");
  const feedDelegated = feedInfo !== null && feedInfo.owner.equals(DELEGATION_PROGRAM_ID);
  if (!feedInfo) {
    const sig = await oracle.methods
      .initFeed(LAZER_FEED_ID)
      .accounts({ authority: admin.publicKey, feed, systemProgram: SystemProgram.programId })
      .rpc();
    sigs.initFeed = sig;
    console.log("init_feed", sig);
  } else {
    console.log("init_feed: exists, skipped");
  }
  if (!feedDelegated) {
    const now = Math.floor(Date.now() / 1000);
    const sig = await oracle.methods
      .setPrice(new BN(MOCK_PRICE_1E8.toString()), new BN(MOCK_CONF.toString()), new BN(now))
      .accounts({ authority: admin.publicKey, feed })
      .rpc();
    sigs.setPrice = sig;
    console.log("set_price", sig, "price=150.00 conf=5e6 publish=" + now);
  } else {
    console.log("set_price: feed already delegated, skipped");
  }

  // --- delegate_feed ---
  if (!feedDelegated) {
    const t = delegationTriple(feed, MOCK_ORACLE_PROGRAM_ID);
    const sig = await oracle.methods
      .delegateFeed(LAZER_FEED_ID)
      .accounts({
        authority: admin.publicKey,
        bufferFeed: t.buffer,
        delegationRecordFeed: t.record,
        delegationMetadataFeed: t.metadata,
        feed,
        ownerProgram: MOCK_ORACLE_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
      .rpc();
    sigs.delegateFeed = sig;
    console.log("delegate_feed", sig);
    await waitDelegated(baseConn, feed, "feed");
  } else {
    console.log("delegate_feed: already delegated, skipped");
  }

  // --- delegate_market (+ market_risk) ---
  const marketNowInfo = await baseConn.getAccountInfo(market, "confirmed");
  if (!marketNowInfo || !marketNowInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    const mt = delegationTriple(market, DEXXER_CORE_PROGRAM_ID);
    const rt = delegationTriple(marketRisk, DEXXER_CORE_PROGRAM_ID);
    const sig = await core.methods
      .delegateMarket(Array.from(SOL_SYMBOL))
      .accounts({
        admin: admin.publicKey,
        config,
        bufferMarket: mt.buffer,
        delegationRecordMarket: mt.record,
        delegationMetadataMarket: mt.metadata,
        market,
        bufferMarketRisk: rt.buffer,
        delegationRecordMarketRisk: rt.record,
        delegationMetadataMarketRisk: rt.metadata,
        marketRisk,
        ownerProgram: DEXXER_CORE_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    sigs.delegateMarket = sig;
    console.log("delegate_market", sig);
    await waitDelegated(baseConn, market, "market");
    await waitDelegated(baseConn, marketRisk, "market_risk");
  } else {
    console.log("delegate_market: already delegated, skipped");
  }

  // --- pool: init_pool -> init_pool_live -> faucet + seed_pool ->
  // delegate_pool_live -> delegate_pool (C1; see the file header) ---
  const { pool, poolAta, poolLive } = await bootstrapPool(core, admin, config, mintAuth, mint, sigs);

  // --- init + delegate the fee-escrow PDA (Task 5 fix round 1) ---
  const feeEscrow = await initAndDelegateFeeEscrow(core, admin, config, sigs);

  return { admin, mint, market, marketRisk, pool, poolAta, poolLive, feed, feeEscrow, sigs };
}

export async function bootstrapDevnet(): Promise<BootstrappedDevnet> {
  if (NET !== "devnet") {
    throw new Error(`bootstrapDevnet() requires DEXXER_NET=devnet (got "${NET}") — see keys/README.md / task-0 brief`);
  }

  const admin = loadOrCreateKey("devnet-admin");
  const crank = loadOrCreateKey("devnet-crank");
  const feePayer = loadOrCreateKey("devnet-fee-payer");
  // Rough sanity floor, not an exact budget: rent for Config/Market/MarketRisk/Pool/mint/ATAs
  // + tx fees. Task 5 (real run): the program deploy alone cost ~4.61 SOL of the payer's 6.1 SOL
  // budget (program-data rent at current devnet rates, well above the brief's ~1.7 SOL estimate),
  // and `devnet-admin` is funded separately from the deploy payer — lowered from the original "2
  // SOL, ~6 total incl. deploy" placeholder (which assumed one shared budget) to a floor that still
  // comfortably covers this function's actual on-chain cost (small account rents + tx fees, well
  // under 0.3 SOL in practice) without requiring more of the payer's remaining balance than needed.
  await requireFunded(admin.publicKey, 0.3, "devnet-admin");
  console.log("admin", admin.publicKey.toBase58());
  console.log("crank", crank.publicKey.toBase58());
  console.log("fee-payer", feePayer.publicKey.toBase58());

  const core = dexxerCoreProgram(baseConn, admin);
  const sigs: Record<string, string> = {};

  const config = pdas.config();
  const mintAuth = pdas.mintAuth();
  const market = pdas.market();
  const marketRisk = pdas.marketRisk(market);
  // The real Pricing Oracle's feed PDA — not created/delegated by us, already
  // live inside devnet-tee (spec §7.2 check 4 / spikes/04-oracle-tee).
  const feed = pdas.feedUnder(ORACLE, LAZER_FEED_ID);

  // --- init_config (creates the dUSDC mint). `crank` is a dedicated devnet
  // keypair here (week 1 reused `admin` for this role — see spec §7.3 week 2
  // decision #1, permission members). task-2: `init_config` gained
  // `fee_payer`/`magic_fee_vault` args; pass the persisted devnet fee-payer
  // pubkey and `PublicKey.default()` for the vault for now — a later task
  // fills the real fee-vault address. ---
  let mint: PublicKey;
  const configInfo = await baseConn.getAccountInfo(config, "confirmed");
  if (!configInfo) {
    const mintKp = loadOrCreateKey("devnet-mint");
    const sig = await core.methods
      .initConfig(
        crank.publicKey,
        ORACLE,
        ER_VALIDATOR,
        // scheduler_signer (task-6 fix round 3): crank_signer_pda(admin) for a
        // FRESH bootstrap, not ER_VALIDATOR (Task 1 M1's value — that was the
        // signer of ALREADY-scheduled ticks on a different, simpler spike
        // program; it is NOT what the Magic Program accepts as a signer
        // inside `dexxer_core`'s own scheduled `crank_tick`, see
        // `crank-signer.ts` and weeks0-5-history.md#week-2 §Task 6 for the full
        // evidence trail). An EXISTING Config still needs a real
        // `set_scheduler_signer` call — see `scripts/admin/set-scheduler-signer.ts`.
        crankSignerPda(admin.publicKey),
        feePayer.publicKey,
        MAGIC_FEE_VAULT,
      )
      .accounts({
        admin: admin.publicKey,
        config,
        dusdcMint: mintKp.publicKey,
        mintAuth,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKp])
      .rpc();
    sigs.initConfig = sig;
    mint = mintKp.publicKey;
    console.log("init_config", sig, "mint", mint.toBase58());
  } else {
    const cfg = await accountNs(core).config.fetch(config);
    mint = cfg.dusdcMint as PublicKey;
    console.log("init_config: exists, skipped. mint", mint.toBase58());
  }

  // --- init_market (max_conf_bps: 0 — the real Lazer feed reads conf == 0 on
  // devnet, see spikes/04-oracle-tee/RESULT.md and week-2 plan risk #11). ---
  const marketInfo = await baseConn.getAccountInfo(market, "confirmed");
  if (!marketInfo) {
    const params = { ...MARKET_DEFAULTS, maxConfBps: 0 };
    const sig = await core.methods
      .initMarket(Array.from(SOL_SYMBOL), params, LAZER_FEED_ID)
      .accounts({ admin: admin.publicKey, config, market, marketRisk, systemProgram: SystemProgram.programId })
      .rpc();
    sigs.initMarket = sig;
    console.log("init_market", sig);
  } else {
    console.log("init_market: exists, skipped");
  }

  // --- delegate_market (+ market_risk); no mock-oracle feed to init/delegate
  // here (see file header comment). ---
  const marketNowInfo = await baseConn.getAccountInfo(market, "confirmed");
  if (!marketNowInfo || !marketNowInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    const mt = delegationTriple(market, DEXXER_CORE_PROGRAM_ID);
    const rt = delegationTriple(marketRisk, DEXXER_CORE_PROGRAM_ID);
    const sig = await core.methods
      .delegateMarket(Array.from(SOL_SYMBOL))
      .accounts({
        admin: admin.publicKey,
        config,
        bufferMarket: mt.buffer,
        delegationRecordMarket: mt.record,
        delegationMetadataMarket: mt.metadata,
        market,
        bufferMarketRisk: rt.buffer,
        delegationRecordMarketRisk: rt.record,
        delegationMetadataMarketRisk: rt.metadata,
        marketRisk,
        ownerProgram: DEXXER_CORE_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    sigs.delegateMarket = sig;
    console.log("delegate_market", sig);
    await waitDelegated(baseConn, market, "market");
    await waitDelegated(baseConn, marketRisk, "market_risk");
  } else {
    console.log("delegate_market: already delegated, skipped");
  }

  // --- pool: init_pool -> init_pool_live -> faucet + seed_pool ->
  // delegate_pool_live -> delegate_pool (C1, shared with `bootstrap()`; see
  // the file header). `seed_pool` needs `Pool` AND `PoolLive` still
  // program-owned on L1, so neither is delegated before it. ---
  const { pool, poolAta, poolLive } = await bootstrapPool(core, admin, config, mintAuth, mint, sigs);

  // --- init + delegate the fee-escrow PDA (Task 5 fix round 1) ---
  const feeEscrow = await initAndDelegateFeeEscrow(core, admin, config, sigs);

  // --- init + delegate BalancesRoot (week 3, Task 7) ---
  const balancesRoot = await initAndDelegateBalancesRoot(core, admin, config, sigs);

  // --- PoolLive migration (Task 3, steps 9-10): make MarketRisk + PoolLive
  // (already init+delegated above) permissioned [crank, admin] on the ER
  // (risk #24). Fix round 1: top up both PDAs' ER rent surplus first (see
  // `fundMarketPermissions`'s doc comment), then `init_market_permissions`
  // must succeed — no tolerance here, bootstrap must not silently leave
  // risk #24 open. Fix round 2: the tx landing is not sufficient proof —
  // `initMarketPermissions`'s own post-call ownership check can come back
  // false for one account even when the transaction itself didn't throw
  // (e.g. a partially-applied state some future Rust change might allow),
  // so check its returned flags here too rather than only relying on the
  // instruction to throw.
  await fundMarketPermissions(admin, marketRisk, poolLive, sigs);
  const marketPerm = await initMarketPermissions(admin, config, market, marketRisk, poolLive, sigs);
  if (!marketPerm.riskPermissioned || !marketPerm.poolLivePermissioned) {
    throw new Error(
      `init_market_permissions: landed but did not permission everything — marketRisk permissioned=${marketPerm.riskPermissioned}, poolLive permissioned=${marketPerm.poolLivePermissioned}`,
    );
  }

  return { admin, mint, market, marketRisk, pool, poolAta, poolLive, feed, feeEscrow, sigs, feePayer, balancesRoot };
}
