// services/relayer/src/candidates.ts
//
// Liquidation candidates (spec §2.9.2): a trader's positions on every market
// live in ONE `Positions` account, so the crank reads those accounts (it is a
// permission member of each) and turns every OPEN slot into a candidate for
// that slot's market. `crank_tick` takes them as pairs
// `[Positions, UserAccount]`.
import { AccountMeta, PublicKey } from "@solana/web3.js";
import { decodePositions, slotFor } from "../../../tests/er/lib/positions.js";
import { envNum } from "./env.js";
import { looksLikeOnChainFailure } from "./errors.js";

// Pairs: 2 keys per candidate. The largest count whose transaction (6 fixed
// accounts + ComputeBudget) stays within 1232 B — pinned by
// test/candidates.test.ts (12 → 1175 B, 13 → 1241 B); the program's own cap
// is 16.
export const CRANK_TX_MAX_CANDIDATES = 12;

// How long a pair that failed `crank_tick` ALONE stays out of the batches
// (`tickCandidates`). Min 5 s: a NaN/0 would retry a poisoned pair every loop.
export const CRANK_BAD_PAIR_COOLDOWN_MS = envNum("CRANK_BAD_PAIR_COOLDOWN_MS", 60_000, 5_000);

export interface Candidate {
  positions: PublicKey;
  owner: PublicKey;
  /** The slot's market, base58 — the grouping key. */
  market: string;
}

/**
 * An account that does not decode as `Positions` is dropped here: handed to
 * `crank_tick` it would abort the whole batch (Anchor 3002), and no candidate
 * in it would be liquidated.
 *
 * A `(Positions, market)` pair is emitted at most once — the program keeps one
 * slot per market, but a repeated pair would put the same account twice into
 * one `crank_tick`, and the whole batch would then hinge on how the program
 * treats a double borrow of one zero-copy account.
 */
export function candidatesFrom(rows: { pubkey: PublicKey; data: Buffer }[], onSkip?: (pubkey: PublicKey, reason: string) => void): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    try {
      const p = decodePositions(r.data);
      for (const s of p.slots) {
        const market = s.market.toBase58();
        const id = `${r.pubkey.toBase58()}:${market}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ positions: r.pubkey, owner: p.owner, market });
      }
    } catch (e) {
      onSkip?.(r.pubkey, String(e instanceof Error ? e.message : e));
    }
  }
  return out;
}

export function pairAccounts(chunk: Candidate[], userAccountOf: (owner: PublicKey) => PublicKey): AccountMeta[] {
  return chunk.flatMap((c) => [
    { pubkey: c.positions, isWritable: true, isSigner: false },
    { pubkey: userAccountOf(c.owner), isWritable: true, isSigner: false },
  ]);
}

/** At least one (possibly empty) chunk: a market with no open position still needs its mark and price sample advanced. */
export function chunkCandidates(open: Candidate[], size = CRANK_TX_MAX_CANDIDATES): Candidate[][] {
  const out: Candidate[][] = [];
  for (let i = 0; i < Math.max(1, open.length); i += size) out.push(open.slice(i, i + size));
  return out;
}

/** `after[i]` = the candidate's `Positions` bytes read after the tick (null if unreadable). */
export function liquidatedIn(chunk: Candidate[], after: (Buffer | null)[]): string[] {
  const out: string[] = [];
  chunk.forEach((c, i) => {
    const data = after[i];
    if (!data) return;
    try {
      if (slotFor(decodePositions(data), new PublicKey(c.market)) === null) out.push(c.positions.toBase58());
    } catch {
      // Unreadable now — say nothing rather than claim a liquidation.
    }
  });
  return out;
}

/** Quarantine key of a candidate: one pair on one market. */
export function pairKey(c: Candidate): string {
  return `${c.positions.toBase58()}:${c.market}`;
}

/** The inverse of `pairKey` — a released key may belong to any market, so the log names the market from the key (m3). */
export function splitPairKey(key: string): { positions: string; market: string } {
  const i = key.indexOf(":");
  return { positions: key.slice(0, i), market: key.slice(i + 1) };
}

/**
 * Drops candidates whose pair is quarantined until after `now`; pairs whose
 * time is up are removed from `quarantine` and returned in `released` (once).
 */
export function applyQuarantine(open: Candidate[], quarantine: Map<string, number>, now: number): { kept: Candidate[]; released: string[] } {
  const released: string[] = [];
  for (const [key, until] of quarantine) {
    if (until <= now) {
      quarantine.delete(key);
      released.push(key);
    }
  }
  return { kept: open.filter((c) => !quarantine.has(pairKey(c))), released };
}

/**
 * Retry a failed chunk one candidate per transaction? Only if it had more than
 * one candidate (a single one already failed alone) and it failed ON CHAIN
 * (m2): any other failure is connection-class and says nothing about who is in
 * the chunk — every send would fail the same way.
 */
export function shouldRetrySingly(chunkSize: number, onChainFailure: boolean): boolean {
  return chunkSize > 1 && onChainFailure;
}

export { looksLikeOnChainFailure };

export interface TickCandidatesDeps {
  /** One `crank_tick` over the chunk; resolves once it is confirmed, throws if it failed. */
  send: (chunk: Candidate[]) => Promise<void>;
  /** The production classifier (errors.ts): landed and rejected by the program. Everything else is connection-class. */
  isOnChainFailure: (e: unknown) => boolean;
  /** pairKey → quarantined until (ms). Lives as long as the process; mutated here. */
  quarantine: Map<string, number>;
  now: number;
  cooldownMs: number;
  size?: number;
}
export interface TickCandidatesResult {
  /** Transactions of this market that landed in this loop (the probe included). */
  landed: number;
  errors: unknown[];
  /** Pairs put into quarantine in this loop. */
  quarantined: string[];
  /** Pairs whose quarantine ended in this loop. */
  released: string[];
  /** A connection-class error stopped this market; the caller stops the loop and reconnects (I4). */
  connectionError: boolean;
  /** The market itself failed on chain (the zero-candidate probe was rejected too): nobody blamed, nobody quarantined (m1). */
  marketFailed: boolean;
}

/**
 * Every `crank_tick` of one market for one loop. Chunks are sent in order.
 *
 * - A connection-class failure (anything not on chain: auth, timeout, fetch
 *   failed, 429, 5xx) stops the market at once — no singles, no probe, no
 *   quarantine: whoever is in the next transaction, it would fail the same
 *   way (m2, I4).
 * - A chunk rejected ON CHAIN is followed by one zero-candidate probe for the
 *   market (m1). Probe rejected on chain too → the market is broken (oracle
 *   account, paused config…), not a pair: no singles, no quarantine, the
 *   market's remaining chunks are skipped. Probe lands → it counts as the
 *   market's tick (mark and price sample advance), and the chunk's
 *   candidates are retried one per transaction, so one bad pair cannot keep
 *   the rest of its chunk from being checked (chunk membership follows the
 *   `getProgramAccounts` order — it would be the same chunk every loop). A
 *   candidate rejected alone on chain is quarantined for `cooldownMs`.
 *
 * There is no separate fallback zero-candidate tick: with candidates, either
 * something landed, or the probe was tried, or a connection error stopped
 * the market; without candidates the only chunk IS a zero-candidate tick.
 */
export async function tickCandidates(open: Candidate[], deps: TickCandidatesDeps): Promise<TickCandidatesResult> {
  const out: TickCandidatesResult = { landed: 0, errors: [], quarantined: [], released: [], connectionError: false, marketFailed: false };
  const { kept, released } = applyQuarantine(open, deps.quarantine, deps.now);
  out.released = released;
  type Attempt = "landed" | "onchain" | "connection";
  const attempt = async (chunk: Candidate[]): Promise<Attempt> => {
    try {
      await deps.send(chunk);
      out.landed += 1;
      return "landed";
    } catch (e) {
      out.errors.push(e);
      if (deps.isOnChainFailure(e)) return "onchain";
      out.connectionError = true;
      return "connection";
    }
  };
  const quarantine = (c: Candidate): void => {
    const key = pairKey(c);
    deps.quarantine.set(key, deps.now + deps.cooldownMs);
    out.quarantined.push(key);
  };

  for (const chunk of chunkCandidates(kept, deps.size)) {
    const r = await attempt(chunk);
    if (r === "landed") continue;
    if (r === "connection") return out;
    // Rejected on chain.
    if (chunk.length === 0) {
      out.marketFailed = true;
      return out;
    }
    const probe = await attempt([]);
    if (probe === "connection") return out;
    if (probe === "onchain") {
      out.marketFailed = true;
      return out;
    }
    if (!shouldRetrySingly(chunk.length, true)) {
      quarantine(chunk[0]); // it failed alone, and the market is fine
      continue;
    }
    for (const c of chunk) {
      const s = await attempt([c]);
      if (s === "connection") return out;
      if (s === "onchain") quarantine(c);
    }
  }
  return out;
}
