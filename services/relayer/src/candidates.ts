// services/relayer/src/candidates.ts
//
// Liquidation candidates (spec §2.9.2): a trader's positions on every market
// live in ONE `Positions` account, so the crank reads those accounts (it is a
// permission member of each) and turns every OPEN slot into a candidate for
// that slot's market. `crank_tick` takes them as pairs
// `[Positions, UserAccount]`.
import { AccountMeta, PublicKey } from "@solana/web3.js";
import { decodePositions, slotFor } from "../../../tests/er/lib/positions.js";

// Pairs: 2 keys per candidate. The largest count whose transaction (6 fixed
// accounts + ComputeBudget) stays within 1232 B — pinned by
// test/candidates.test.ts (12 → 1175 B, 13 → 1241 B); the program's own cap
// is 16.
export const CRANK_TX_MAX_CANDIDATES = 12;

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
