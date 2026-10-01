// services/relayer/src/ixAccounts.ts
//
// Account maps of the relayer's own instructions (final review I7), pure so
// test/ixAccounts.test.ts can pin every key against the IDL the same way it
// pins the trader builders in tests/er/lib/trader.ts — the Program is
// untyped, so a missing or misnamed key would otherwise fail only on a live
// network.
import type { PublicKey } from "@solana/web3.js";
import { MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { pdas } from "../../../tests/er/lib/program.js";

/** `crank_tick` — candidates go in as remaining accounts (`pairAccounts`). */
export function crankTickAccounts(crank: PublicKey, m: { market: PublicKey; marketRisk: PublicKey; feed: PublicKey }, poolLive: PublicKey) {
  return { crank, config: pdas.config(), market: m.market, marketRisk: m.marketRisk, poolLive, feed: m.feed };
}

/** `commit_aggregate()` — no arguments, no remaining accounts (spec §2.9.2). */
export function commitAggregateAccounts(a: {
  payer: PublicKey;
  pool: PublicKey;
  poolLive: PublicKey;
  balancesRoot: PublicKey;
  feeEscrow: PublicKey;
  magicFeeVault: PublicKey;
}) {
  return {
    config: pdas.config(),
    payer: a.payer,
    pool: a.pool,
    poolLive: a.poolLive,
    balancesRoot: a.balancesRoot,
    feeEscrow: a.feeEscrow,
    magicFeeVault: a.magicFeeVault,
    magicContext: MAGIC_CONTEXT_ID,
    magicProgram: MAGIC_PROGRAM_ID,
  };
}

/** `set_balances_root(begin, finalize, padding_seed)` — `UserAccount`s go in as remaining accounts. */
export function setBalancesRootAccounts(crank: PublicKey, balancesRoot: PublicKey) {
  return { crank, config: pdas.config(), balancesRoot };
}
