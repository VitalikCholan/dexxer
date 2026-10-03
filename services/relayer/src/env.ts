// services/relayer/src/env.ts
//
// Numeric env knobs. An unparseable, non-finite or below-`min` value falls
// back to the default instead of flowing through as NaN/0: a NaN floor would
// make `balance < floor` always false (silently disabling a balance floor
// such as janitor.ts's `JANITOR_MIN_FEE_PAYER_SOL`) and a NaN/0 interval
// makes `setInterval` fire every 1 ms (markets.ts refresh, final-review F1). Integer knobs truncate at the
// call site. No imports on purpose — safe to load before index.ts's
// env-forcing block.
export function envNum(name: string, def: number, min?: number): number {
  const n = Number(process.env[name] ?? def);
  if (!Number.isFinite(n) || (min !== undefined && n < min)) return def;
  return n;
}
