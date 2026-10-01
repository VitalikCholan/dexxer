// services/relayer/src/withSol.ts
//
// SOL is ticked whatever the registry says: an empty list (first read not done
// yet) or a list that lost SOL must never stop the market the shipped APK
// trades — nor its liquidations. The same view decides what `/healthz.markets`
// lists and which `?market=` the indexer accepts. No imports on purpose:
// indexer/http.ts is loaded statically by index.ts, before its env-forcing
// block, and must not pull tests/er/lib/env.ts in through crank.ts.
export function withSol<T extends { symbol: string }>(list: T[], sol: () => T): T[] {
  return list.some((m) => m.symbol === "SOL") ? list : [sol(), ...list];
}
