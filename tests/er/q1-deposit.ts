// tests/er/q1-deposit.ts
//
// Spec §8 Q1: proves that a user's base-layer eSPL deposit becomes
// `UserAccount.free_margin` inside the ER via `credit_deposit`.
//
// Sequence (each step logs its signature):
//   1. bootstrap() — admin config/market/pool, pool funded with 10,000 dUSDC
//      on L1, then Market/MarketRisk/Pool(+eATA)/Feed delegated to the ER.
//   2. onboardTrader() (tests/er/lib/trader.ts): airdrop, faucet 1,000
//      dUSDC, init_user, delegateSpl(1,000 dUSDC), delegate_user — all on
//      L1 — then credit_deposit(1,000 dUSDC) on the ER. `initPermissions:
//      false`: q2-permissions.ts (run after this) specifically tests
//      init_permissions's own first-call/second-call behavior, so this
//      user must reach it with no permissions created yet.
//   3. Negative: a second credit_deposit fails (the user's ephemeral ATA is
//      now empty) — proves a double-spend is impossible, i.e. the deposit is
//      "idempotent by construction" even though the instruction itself has
//      no explicit nonce/idempotency key.
//
// Run: `npm run q1` (from tests/er).

import { assert, erConn } from "./lib/env.js";
import { bootstrap } from "./lib/admin.js";
import { accountNs, dexxerCoreProgram } from "./lib/program.js";
import { creditDeposit, onboardTrader } from "./lib/trader.js";

const USER_DEPOSIT = 1_000_000_000n; // 1,000 dUSDC (6 decimals)

async function main() {
  console.log("=== bootstrap ===");
  const boot = await bootstrap();

  // Assert on ER: pool funded before any deposit.
  const coreEr = dexxerCoreProgram(erConn, boot.admin);
  const poolAtaBalBoot = await erConn.getTokenAccountBalance(boot.poolAta, "confirmed");
  assert(poolAtaBalBoot.value.amount === "10000000000", `ER poolAta balance == 10_000e6 (got ${poolAtaBalBoot.value.amount})`);
  // week-4 Task 1: credit_deposit writes PoolLive now, not the public Pool
  // snapshot (only commit_aggregate writes that) — assert on the live counters.
  const poolStateBoot = await accountNs(coreEr).poolLive.fetch(boot.poolLive);
  assert(
    poolStateBoot.capitalTotal.toString() === "10000000000" && poolStateBoot.protocolLiquidity.toString() === "10000000000",
    `ER PoolLive.capital_total == protocol_liquidity == 10_000e6 (got ${poolStateBoot.capitalTotal.toString()}/${poolStateBoot.protocolLiquidity.toString()})`,
  );

  console.log("=== onboard user (L1 setup + credit_deposit on ER) ===");
  const user = await onboardTrader(boot, "user", USER_DEPOSIT, { initPermissions: false });
  console.log("credit_deposit CU:", user.creditDepositCU);

  const userAccountState = await accountNs(coreEr).userAccount.fetch(user.userAccount);
  assert(
    userAccountState.freeMargin.toString() === USER_DEPOSIT.toString(),
    `ER UserAccount.free_margin == 1_000e6 (got ${userAccountState.freeMargin.toString()})`,
  );

  const poolStateAfter = await accountNs(coreEr).poolLive.fetch(boot.poolLive);
  assert(poolStateAfter.capitalTotal.toString() === "11000000000", `ER PoolLive.capital_total == 11_000e6 (got ${poolStateAfter.capitalTotal.toString()})`);

  const poolAtaBalAfter = await erConn.getTokenAccountBalance(boot.poolAta, "confirmed");
  assert(poolAtaBalAfter.value.amount === "11000000000", `ER poolAta balance == 11_000e6 (got ${poolAtaBalAfter.value.amount})`);

  const userAtaBalAfter = await erConn.getTokenAccountBalance(user.userAta, "confirmed");
  assert(userAtaBalAfter.value.amount === "0", `ER userAta balance == 0 (got ${userAtaBalAfter.value.amount})`);

  console.log("=== negative: second credit_deposit(1) must fail (user's ephemeral ATA is empty) ===");
  let secondFailed = false;
  let secondError = "";
  try {
    await creditDeposit(boot, user, 1n);
  } catch (e) {
    secondFailed = true;
    secondError = String(e);
  }
  assert(secondFailed, "second credit_deposit(1) rejected (insufficient funds) — idempotent by construction");
  console.log("second credit_deposit error (expected):", secondError.slice(0, 300));

  console.log("\nQ1 PASS", {
    admin: boot.admin.publicKey.toBase58(),
    user: user.kp.publicKey.toBase58(),
    mint: boot.mint.toBase58(),
    pool: boot.pool.toBase58(),
    poolAta: boot.poolAta.toBase58(),
    userAccount: user.userAccount.toBase58(),
    userAta: user.userAta.toBase58(),
    userDeposit: USER_DEPOSIT.toString(),
    creditDepositSig: user.sigs.creditDeposit,
    creditDepositCU: user.creditDepositCU,
    freeMarginAfter: userAccountState.freeMargin.toString(),
    poolCapitalAfter: poolStateAfter.capitalTotal.toString(),
    sigs: { ...boot.sigs, ...user.sigs },
  });
}

main().catch((e) => {
  console.error("Q1 FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
