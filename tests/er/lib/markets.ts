// tests/er/lib/markets.ts
//
// The markets Dexxer lists (spec §2.8.1) and their parameters. Sizes are
// synthetic at 1e9 scale, so `min_size` is per market (~$1-2); `max_position`
// is a USD (1e6) notional and stays SOL's value everywhere. `max_staleness_secs`
// follows the devnet Lazer cadence (~9 s), `max_conf_bps: 0` because devnet
// Lazer reports conf == 0 (week 2, risk #11).
import { createHash } from "crypto";
import { BN } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";
import { MARKET_DEFAULTS } from "./admin.js";
import { DEXXER_CORE_PROGRAM_ID } from "./program.js";

type Params = typeof MARKET_DEFAULTS;
const TEN_X = { maxLevBps: 100_000, imrBps: 1_000, mmrBps: 500 };
const FIVE_X = { maxLevBps: 50_000, imrBps: 2_000, mmrBps: 1_000 };
const devnet = (o: Partial<Params>): Params => ({ ...MARKET_DEFAULTS, maxConfBps: 0, maxStalenessSecs: new BN(15), ...o });

export const MARKET_CATALOG: Record<string, { lazerFeedId: string; params: Params }> = {
  SOL: { lazerFeedId: "6", params: { ...MARKET_DEFAULTS, maxConfBps: 0 } },
  BTC: { lazerFeedId: "1", params: devnet({ ...TEN_X, minSize: new BN(20_000) }) },
  ETH: { lazerFeedId: "2", params: devnet({ ...TEN_X, minSize: new BN(500_000) }) },
  HYPE: { lazerFeedId: "110", params: devnet({ ...FIVE_X, minSize: new BN(15_000_000) }) },
  ZEC: { lazerFeedId: "66", params: devnet({ ...FIVE_X, minSize: new BN(800_000) }) },
};

/** Scheduler task id for a market's `schedule_crank` — distinct per market (SOL's live task uses sha256(programId) alone, schedule-eternal.ts). */
export function marketTaskId(market: PublicKey): bigint {
  return createHash("sha256").update(DEXXER_CORE_PROGRAM_ID.toBuffer()).update(market.toBuffer()).digest().readBigInt64LE(0);
}
