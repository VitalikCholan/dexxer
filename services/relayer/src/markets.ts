// services/relayer/src/markets.ts
//
// Market registry (spec §2.8.3): every `Market` the program has, read with
// `getProgramAccounts` over the ER by the `Market` discriminator. `Market`
// is PUBLIC in the ER (only `MarketRisk`/`PoolLive` are permissioned,
// week 4), so this is an unauthenticated read — no crank or fee_payer token,
// same as marketWatch.ts. Refreshed every MARKETS_REFRESH_MS so a market
// added with `add-market` is picked up without a restart. A failed refresh
// keeps the last good list: a flaky ER must never make markets disappear
// from the crank or the indexer.
//
// Final review F2: a market is listed only once its `MarketRisk` is private,
// i.e. the `EphemeralPermission` PDA of `MarketRisk` exists and is owned by
// the Permission Program. `add-market` delegates the market BEFORE
// `init_market_permissions`; a script that dies in between would otherwise
// get the market listed and ticked while its open interest is
// readable by anyone in the ER (risk #24 reopened). That owner check is the
// one read here that is NOT unauthenticated — the caller supplies it over
// the crank's TEE connection (index.ts); only the permission PDA's account
// owner is read, never `MarketRisk` data.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { PERMISSION_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { MARKET_DISC, dexxerCoreProgram, pdas, symbolString } from "../../../tests/er/lib/program.js";
import { envNum } from "./env.js";

// Min 5 s: a NaN/0 would make setInterval fire every 1 ms (final review F1).
export const MARKETS_REFRESH_MS = envNum("MARKETS_REFRESH_MS", 60_000, 5_000);

export interface MarketInfo {
  symbol: string;
  market: PublicKey;
  marketRisk: PublicKey;
  feed: PublicKey;
  /** Public `Market` fields only — never `MarketRisk` (private, risk #24). u64 as decimal strings. */
  params: {
    maxLevBps: number; imrBps: number; mmrBps: number;
    openFeeBps: number; closeFeeBps: number; liqFeeBps: number;
    oiCap: string; maxPosition: string; minSize: string; maxStalenessSecs: string;
    pausedOpen: boolean;
  };
}

const str = (v: { toString(): string }) => v.toString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function marketInfoFrom(pubkey: PublicKey, m: any): MarketInfo {
  return {
    symbol: symbolString(m.symbol),
    market: pubkey,
    marketRisk: pdas.marketRisk(pubkey),
    feed: new PublicKey(m.feed),
    params: {
      maxLevBps: m.maxLevBps, imrBps: m.imrBps, mmrBps: m.mmrBps,
      openFeeBps: m.openFeeBps, closeFeeBps: m.closeFeeBps, liqFeeBps: m.liqFeeBps,
      oiCap: str(m.oiCap), maxPosition: str(m.maxPosition), minSize: str(m.minSize), maxStalenessSecs: str(m.maxStalenessSecs),
      pausedOpen: Boolean(m.pausedOpen),
    },
  };
}

/** SOL first, then alphabetical. */
export function sortMarkets(list: MarketInfo[]): MarketInfo[] {
  return [...list].sort((a, b) => (a.symbol === "SOL" ? -1 : b.symbol === "SOL" ? 1 : a.symbol.localeCompare(b.symbol)));
}

export interface MarketRegistry {
  list(): MarketInfo[];
  get(symbol: string): MarketInfo | undefined;
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createMarketRegistry(opts: { load: () => Promise<MarketInfo[]>; refreshMs?: number; log?: (l: string) => void }): MarketRegistry {
  const log = opts.log ?? ((l: string) => console.log(l));
  let list: MarketInfo[] = [];
  let timer: NodeJS.Timeout | null = null;
  // One load at a time: a slow ER must not stack overlapping
  // `getProgramAccounts` calls — a refresh requested while one runs gets
  // the running one's promise (final review F1).
  let inFlight: Promise<void> | null = null;
  function refresh(): Promise<void> {
    inFlight ??= doRefresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }
  async function doRefresh(): Promise<void> {
    try {
      const next = sortMarkets(await opts.load());
      const before = list.map((m) => m.symbol).join(",");
      list = next;
      const after = list.map((m) => m.symbol).join(",");
      if (before !== after) log(`markets: ${after || "(none)"}`);
    } catch (e) {
      log(`markets: refresh failed, keeping ${list.length} known: ${String(e)}`);
    }
  }
  return {
    list: () => list,
    get: (symbol) => list.find((m) => m.symbol === symbol),
    refresh,
    start() {
      if (timer) return;
      timer = setInterval(() => void refresh(), opts.refreshMs ?? MARKETS_REFRESH_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/** Keeps the markets whose `MarketRisk` permission PDA is owned by the Permission Program; `permissionOwners[i]` belongs to `markets[i]` (null = account missing). */
export function keepPrivateMarkets(markets: MarketInfo[], permissionOwners: (PublicKey | null)[]): MarketInfo[] {
  return markets.filter((_, i) => permissionOwners[i]?.equals(PERMISSION_PROGRAM_ID) ?? false);
}

/**
 * `readOwners` returns the ACCOUNT OWNER of each key (null = missing). It is
 * used only for the `MarketRisk` permission PDAs and must be made by an
 * identity certain to see them (index.ts: the crank's TEE connection). If it
 * throws, the whole load throws and the registry keeps its last good list —
 * never "every market disappears", never "an unverified market appears".
 */
export function loadMarketsFromEr(
  erRpc: string,
  readOwners: (keys: PublicKey[]) => Promise<(PublicKey | null)[]>,
  log: (l: string) => void = (l) => console.log(l),
): () => Promise<MarketInfo[]> {
  const conn = new Connection(erRpc, "confirmed"); // no auth token — public read
  const prog = dexxerCoreProgram(conn, Keypair.generate()); // never signs
  // Logged on change only, not every MARKETS_REFRESH_MS.
  let lastSkipped = "";
  return async () => {
    const accs = await conn.getProgramAccounts(prog.programId, { filters: [{ memcmp: { offset: 0, bytes: MARKET_DISC } }] });
    const out: MarketInfo[] = [];
    for (const a of accs) {
      try {
        out.push(marketInfoFrom(a.pubkey, prog.coder.accounts.decode("market", a.account.data)));
      } catch (e) {
        console.error(`markets: skipped undecodable Market ${a.pubkey.toBase58()}: ${String(e)}`);
      }
    }
    const owners = out.length > 0 ? await readOwners(out.map((m) => permissionPdaFromAccount(m.marketRisk))) : [];
    const kept = keepPrivateMarkets(out, owners);
    const skipped = out.filter((m) => !kept.includes(m)).map((m) => m.symbol).sort();
    const key = skipped.join(",");
    if (key !== lastSkipped) {
      for (const sym of skipped) log(`markets: ${sym} skipped — MarketRisk is not private yet`);
      lastSkipped = key;
    }
    return kept;
  };
}
