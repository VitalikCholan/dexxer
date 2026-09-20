// tests/er/q1-deposit.ts
//
// Spec §8 Q1: proves that a user's base-layer eSPL deposit becomes
// `UserAccount.free_margin` inside the ER via `credit_deposit`.
//
// Sequence (each step logs its signature):
//   1. bootstrap() — admin config/market/pool, pool funded with 10,000 dUSDC
//      on L1, then Market/MarketRisk/Pool(+eATA)/Feed delegated to the ER.
//   2. user: airdrop, faucet 1,000 dUSDC, init_user, delegateSpl(1,000 dUSDC),
//      delegate_user — all on L1.
//   3. ER: credit_deposit(1,000 dUSDC) signed by the user (Anchor provider
//      bound to the ER connection, so blockhash/send/confirm all go through
//      http://127.0.0.1:7799 — never the base connection).
//   4. Negative: a second credit_deposit fails (the user's ephemeral ATA is
//      now empty) — proves a double-spend is impossible, i.e. the deposit is
//      "idempotent by construction" even though the instruction itself has
//      no explicit nonce/idempotency key.
//
// Run: `npm run q1` (from tests/er).

import { BN } from "@coral-xyz/anchor";
import { Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DELEGATION_PROGRAM_ID, delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { assert, baseConn, ER_VALIDATOR, erConn, loadOrCreateKey, waitAccountExists, waitDelegated } from "./lib/env.js";
import { bootstrap } from "./lib/admin.js";
import { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, delegationTriple, pdas } from "./lib/program.js";

const USER_DEPOSIT = 1_000_000_000n; // 1,000 dUSDC (6 decimals)

async function main() {
  const sigs: Record<string, string> = {};

  console.log("=== bootstrap ===");
  const boot = await bootstrap();
  Object.assign(sigs, boot.sigs);

  // Assert on ER: pool funded before any deposit.
  const coreEr = dexxerCoreProgram(erConn, boot.admin);
  const poolAtaBalBoot = await erConn.getTokenAccountBalance(boot.poolAta, "confirmed");
  assert(poolAtaBalBoot.value.amount === "10000000000", `ER poolAta balance == 10_000e6 (got ${poolAtaBalBoot.value.amount})`);
  const poolStateBoot = await accountNs(coreEr).pool.fetch(boot.pool);
  assert(
    poolStateBoot.capitalTotal.toString() === "10000000000" && poolStateBoot.protocolLiquidity.toString() === "10000000000",
    `ER Pool.capital_total == protocol_liquidity == 10_000e6 (got ${poolStateBoot.capitalTotal.toString()}/${poolStateBoot.protocolLiquidity.toString()})`,
  );

  console.log("=== user setup (L1) ===");
  const user: Keypair = loadOrCreateKey("user");
  const userBal = await baseConn.getBalance(user.publicKey, "confirmed");
  if (userBal < 2_500_000_000) {
    const sig = await baseConn.requestAirdrop(user.publicKey, 5_000_000_000);
    const { blockhash, lastValidBlockHeight } = await baseConn.getLatestBlockhash();
    await baseConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    sigs.userAirdrop = sig;
    console.log("airdrop user 5 SOL", sig);
  } else {
    console.log("user already funded, skipped airdrop");
  }

  const core = dexxerCoreProgram(baseConn, user);
  const config = pdas.config();
  const market = pdas.market();
  const userAccount = pdas.userAccount(user.publicKey);
  const position = pdas.position(user.publicKey, market);
  const disclosureQueue = pdas.disclosureQueue(user.publicKey);
  const faucetPda = pdas.faucet(user.publicKey);
  const mintAuth = pdas.mintAuth();

  // user's real (base-layer) ATA — this is also the address the ER exposes
  // the ephemeral (eSPL) balance under, once delegated.
  const userAta = getAssociatedTokenAddressSync(boot.mint, user.publicKey);
  await getOrCreateAssociatedTokenAccount(baseConn, user, boot.mint, user.publicKey);

  const faucetInfo = await baseConn.getAccountInfo(faucetPda, "confirmed");
  if (!faucetInfo) {
    const sig = await core.methods
      .faucetInit(new BN(USER_DEPOSIT.toString()))
      .accounts({
        owner: user.publicKey,
        config,
        faucet: faucetPda,
        dusdcMint: boot.mint,
        mintAuth,
        ownerAta: userAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    sigs.faucetInitUser = sig;
    console.log("faucet_init (user)", sig);
  } else {
    console.log("faucet_init (user): faucet exists, skipped (assuming already funded)");
  }

  const userAccountInfoPre = await baseConn.getAccountInfo(userAccount, "confirmed");
  if (!userAccountInfoPre) {
    const sig = await core.methods
      .initUser()
      .accounts({ owner: user.publicKey, config, market, userAccount, position, disclosureQueue, systemProgram: SystemProgram.programId })
      .rpc();
    sigs.initUser = sig;
    console.log("init_user", sig);
  } else {
    console.log("init_user: exists, skipped");
  }

  const userAccountInfoNow = await baseConn.getAccountInfo(userAccount, "confirmed");
  const userDelegated = userAccountInfoNow !== null && userAccountInfoNow.owner.equals(DELEGATION_PROGRAM_ID);
  if (!userDelegated) {
    // delegateSpl(user, mint, 1_000 dUSDC) on L1 — the global vault already
    // exists (created by bootstrap()'s admin delegateSpl call).
    const ixs = await delegateSpl(user.publicKey, boot.mint, USER_DEPOSIT, {
      validator: ER_VALIDATOR,
      initVaultIfMissing: false,
      idempotent: false,
    });
    const delegateSplSig = await sendAndConfirmTransaction(baseConn, new Transaction().add(...ixs), [user], { commitment: "confirmed" });
    sigs.delegateSplUser = delegateSplSig;
    console.log("delegateSpl(user, 1_000e6)", delegateSplSig);

    const ut = delegationTriple(userAccount, DEXXER_CORE_PROGRAM_ID);
    const pt = delegationTriple(position, DEXXER_CORE_PROGRAM_ID);
    const dt = delegationTriple(disclosureQueue, DEXXER_CORE_PROGRAM_ID);
    const sig = await core.methods
      .delegateUser()
      .accounts({
        owner: user.publicKey,
        config,
        market,
        bufferUserAccount: ut.buffer,
        delegationRecordUserAccount: ut.record,
        delegationMetadataUserAccount: ut.metadata,
        userAccount,
        bufferPosition: pt.buffer,
        delegationRecordPosition: pt.record,
        delegationMetadataPosition: pt.metadata,
        position,
        bufferDisclosureQueue: dt.buffer,
        delegationRecordDisclosureQueue: dt.record,
        delegationMetadataDisclosureQueue: dt.metadata,
        disclosureQueue,
        ownerProgram: DEXXER_CORE_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    sigs.delegateUser = sig;
    console.log("delegate_user", sig);
  } else {
    console.log("delegate_user: already delegated, skipped");
  }

  await waitDelegated(baseConn, userAccount, "UserAccount");
  await waitDelegated(baseConn, position, "Position");
  await waitDelegated(baseConn, disclosureQueue, "DisclosureQueue");
  await waitAccountExists(erConn, userAta, "user eATA (as userAta on ER)");

  console.log("=== credit_deposit (ER, signed by user) ===");
  const coreErUser = dexxerCoreProgram(erConn, user);
  const creditSig = await coreErUser.methods
    .creditDeposit(new BN(USER_DEPOSIT.toString()))
    .accounts({
      owner: user.publicKey,
      userAccount,
      pool: boot.pool,
      ownerAta: userAta,
      vaultAta: boot.poolAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  sigs.creditDeposit = creditSig;
  console.log("credit_deposit", creditSig);

  const creditTx = await erConn.getTransaction(creditSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const cu = creditTx?.meta?.computeUnitsConsumed ?? null;
  console.log("credit_deposit CU:", cu);

  const userAccountState = await accountNs(coreEr).userAccount.fetch(userAccount);
  assert(
    userAccountState.freeMargin.toString() === USER_DEPOSIT.toString(),
    `ER UserAccount.free_margin == 1_000e6 (got ${userAccountState.freeMargin.toString()})`,
  );

  const poolStateAfter = await accountNs(coreEr).pool.fetch(boot.pool);
  assert(poolStateAfter.capitalTotal.toString() === "11000000000", `ER Pool.capital_total == 11_000e6 (got ${poolStateAfter.capitalTotal.toString()})`);

  const poolAtaBalAfter = await erConn.getTokenAccountBalance(boot.poolAta, "confirmed");
  assert(poolAtaBalAfter.value.amount === "11000000000", `ER poolAta balance == 11_000e6 (got ${poolAtaBalAfter.value.amount})`);

  const userAtaBalAfter = await erConn.getTokenAccountBalance(userAta, "confirmed");
  assert(userAtaBalAfter.value.amount === "0", `ER userAta balance == 0 (got ${userAtaBalAfter.value.amount})`);

  console.log("=== negative: second credit_deposit(1) must fail (user's ephemeral ATA is empty) ===");
  let secondFailed = false;
  let secondError = "";
  try {
    await coreErUser.methods
      .creditDeposit(new BN(1))
      .accounts({
        owner: user.publicKey,
        userAccount,
        pool: boot.pool,
        ownerAta: userAta,
        vaultAta: boot.poolAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  } catch (e) {
    secondFailed = true;
    secondError = String(e);
  }
  assert(secondFailed, "second credit_deposit(1) rejected (insufficient funds) — idempotent by construction");
  console.log("second credit_deposit error (expected):", secondError.slice(0, 300));

  console.log("\nQ1 PASS", {
    admin: boot.admin.publicKey.toBase58(),
    user: user.publicKey.toBase58(),
    mint: boot.mint.toBase58(),
    pool: boot.pool.toBase58(),
    poolAta: boot.poolAta.toBase58(),
    userAccount: userAccount.toBase58(),
    userAta: userAta.toBase58(),
    userDeposit: USER_DEPOSIT.toString(),
    creditDepositSig: creditSig,
    creditDepositCU: cu,
    freeMarginAfter: userAccountState.freeMargin.toString(),
    poolCapitalAfter: poolStateAfter.capitalTotal.toString(),
    sigs,
  });
}

main().catch((e) => {
  console.error("Q1 FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
