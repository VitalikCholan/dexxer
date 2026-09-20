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
// Ordering note (deviates from the brief's compressed one-liner, follows its
// detailed clarification instead): `seed_pool` runs on L1 BEFORE
// `delegate_pool`, as a plain admin_ata -> pool_ata SPL transfer while `pool`
// is still owned by our program. This avoids needing a second (admin) eATA
// inside the ER just to move funds there — `delegate_pool` then clones the
// already-funded `Pool`/`pool_ata` into the ER as part of normal PDA/account
// delegation.
//
// Task 0 (week 2) adds `bootstrapDevnet()`: same PDAs, same instructions,
// but against real devnet + `devnet-tee.magicblock.app` (`ER_VALIDATOR`/
// `ORACLE` from `env.ts`'s `devnet` profile) and without the mock oracle
// (devnet uses the real Pyth Lazer feed already live inside the TEE — see
// `keys/README.md` and the week-2 plan's Global Constraints). The
// faucet+seed_pool+delegate_pool block is identical between the two
// profiles, so it is factored into `seedAndDelegatePool` below and shared.

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
import { delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { NET, ORACLE, airdrop, baseConn, ER_VALIDATOR, loadOrCreateKey, waitDelegated } from "./env.js";
import {
  DELEGATION_PROGRAM_ID,
  DEXXER_CORE_PROGRAM_ID,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  MOCK_ORACLE_PROGRAM_ID,
  accountNs,
  dexxerCoreProgram,
  delegationTriple,
  espl,
  mockOracleProgram,
  pdas,
} from "./program.js";

export const LAZER_FEED_ID = "6";
export const DISCLOSURE_DELAY_SLOTS = 100;
// devnet-tee's validator-scoped magic fee vault (M3, week2-results.md §Task 1):
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
  feed: PublicKey;
  sigs: Record<string, string>;
}

/** `bootstrapDevnet()`'s return value: same fields as `bootstrap()`, plus the devnet fee payer. */
export interface BootstrappedDevnet extends Bootstrapped {
  feePayer: Keypair;
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

/**
 * The faucet+seed_pool+delegate_pool block, identical between `bootstrap()`
 * and `bootstrapDevnet()` (neither the ixs nor the PDAs differ — only
 * `ER_VALIDATOR`, which `env.ts`'s `DEXXER_NET` profile already resolves for
 * both). Mutates `sigs` in place, matching the rest of this file's style.
 */
async function seedAndDelegatePool(
  core: Program,
  admin: Keypair,
  config: PublicKey,
  mintAuth: PublicKey,
  mint: PublicKey,
  pool: PublicKey,
  poolAta: PublicKey,
  sigs: Record<string, string>,
): Promise<void> {
  const adminAta = await getOrCreateAssociatedTokenAccount(baseConn, admin, mint, admin.publicKey);
  const poolInfoNow = await baseConn.getAccountInfo(pool, "confirmed");
  const poolDelegated = poolInfoNow !== null && poolInfoNow.owner.equals(DELEGATION_PROGRAM_ID);
  if (poolDelegated) {
    console.log("delegate_pool: already delegated, skipped");
    return;
  }

  const poolAcc = await accountNs(core).pool.fetch(pool);
  if (BigInt(poolAcc.capitalTotal.toString()) === 0n) {
    const faucetPda = pdas.faucet(admin.publicKey);
    const faucetInfo = await baseConn.getAccountInfo(faucetPda, "confirmed");
    if (!faucetInfo) {
      const sig = await core.methods
        .faucetInit(new BN(POOL_SEED_AMOUNT.toString()))
        .accounts({
          owner: admin.publicKey,
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

    const sig = await core.methods
      .seedPool(new BN(POOL_SEED_AMOUNT.toString()))
      .accounts({
        admin: admin.publicKey,
        config,
        pool,
        adminAta: adminAta.address,
        vaultAta: poolAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    sigs.seedPool = sig;
    console.log("seed_pool (L1)", sig);
  } else {
    console.log("seed_pool: pool.capital_total already funded, skipped");
  }

  // --- create the shared eSPL global vault for this mint (admin acts as the
  // first owner purely to bootstrap the vault, matching spikes/02-espl-tee). ---
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

  // --- delegate_pool (pool PDA + its eATA) ---
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
        new BN(DISCLOSURE_DELAY_SLOTS),
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
      .initMarket(MARKET_DEFAULTS, LAZER_FEED_ID)
      .accounts({ admin: admin.publicKey, config, market, marketRisk, systemProgram: SystemProgram.programId })
      .rpc();
    sigs.initMarket = sig;
    console.log("init_market", sig);
  } else {
    console.log("init_market: exists, skipped");
  }

  // --- init_pool ---
  const pool = pdas.pool(mint);
  const poolAta = pdas.poolAta(mint);
  const poolInfo = await baseConn.getAccountInfo(pool, "confirmed");
  if (!poolInfo) {
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
  } else {
    console.log("init_pool: exists, skipped");
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
      .delegateMarket()
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

  // --- admin dUSDC ATA + faucet + seed_pool + delegate_pool (L1, before delegating the pool) ---
  await seedAndDelegatePool(core, admin, config, mintAuth, mint, pool, poolAta, sigs);

  return { admin, mint, market, marketRisk, pool, poolAta, feed, sigs };
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
        new BN(DISCLOSURE_DELAY_SLOTS),
        ER_VALIDATOR, // scheduler_signer — Task 1 M1: devnet-tee ticks are signed by the TEE validator identity, not CRANK_SIGNER
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
      .initMarket(params, LAZER_FEED_ID)
      .accounts({ admin: admin.publicKey, config, market, marketRisk, systemProgram: SystemProgram.programId })
      .rpc();
    sigs.initMarket = sig;
    console.log("init_market", sig);
  } else {
    console.log("init_market: exists, skipped");
  }

  // --- init_pool ---
  const pool = pdas.pool(mint);
  const poolAta = pdas.poolAta(mint);
  const poolInfo = await baseConn.getAccountInfo(pool, "confirmed");
  if (!poolInfo) {
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
  } else {
    console.log("init_pool: exists, skipped");
  }

  // --- delegate_market (+ market_risk); no mock-oracle feed to init/delegate
  // here (see file header comment). ---
  const marketNowInfo = await baseConn.getAccountInfo(market, "confirmed");
  if (!marketNowInfo || !marketNowInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    const mt = delegationTriple(market, DEXXER_CORE_PROGRAM_ID);
    const rt = delegationTriple(marketRisk, DEXXER_CORE_PROGRAM_ID);
    const sig = await core.methods
      .delegateMarket()
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

  // --- admin dUSDC ATA + faucet + seed_pool + delegate_pool (shared with `bootstrap()`) ---
  await seedAndDelegatePool(core, admin, config, mintAuth, mint, pool, poolAta, sigs);

  return { admin, mint, market, marketRisk, pool, poolAta, feed, sigs, feePayer };
}
