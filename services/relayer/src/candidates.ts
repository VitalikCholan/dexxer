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
 * one candidate (a single one already failed alone) and the error is not
 * auth/timeout (then every send fails the same way, whoever is in it).
 */
export function shouldRetrySingly(chunkSize: number, authOrTimeout: boolean): boolean {
  return chunkSize > 1 && !authOrTimeout;
}

/**
 * The transaction landed and the program rejected it (`confirmSignature`'s
 * "transaction <sig> failed: <err>") — the only failure that can be the
 * pair's fault. An RPC error (429, 5xx, send rejected) says nothing about the
 * pair and must never quarantine it.
 */
export function looksLikeOnChainFailure(e: unknown): boolean {
  return /\btransaction \S+ failed:/.test(String(e instanceof Error ? e.message : e));
}

export interface TickCandidatesDeps {
  /** One `crank_tick` over the chunk; resolves once it is confirmed, throws if it failed. */
  send: (chunk: Candidate[]) => Promise<void>;
  isAuthOrTimeout: (e: unknown) => boolean;
  /** Only such a failure of a lone candidate quarantines it. Default: every non-auth failure. */
  isOnChainFailure?: (e: unknown) => boolean;
  /** pairKey → quarantined until (ms). Lives as long as the process; mutated here. */
  quarantine: Map<string, number>;
  now: number;
  cooldownMs: number;
  size?: number;
}
export interface TickCandidatesResult {
  /** Transactions of this market that landed in this loop. */
  landed: number;
  errors: unknown[];
  /** Pairs put into quarantine in this loop. */
  quarantined: string[];
  /** Pairs whose quarantine ended in this loop. */
  released: string[];
}

/**
 * Every `crank_tick` of one market for one loop. Chunks are sent in order,
 * each isolated. A chunk failing for a reason other than auth/timeout is
 * retried one candidate per transaction, so one bad pair cannot keep the rest
 * of its chunk from being checked — chunk membership follows the
 * `getProgramAccounts` order, so it would otherwise be the same chunk every
 * loop. A candidate whose transaction fails alone ON CHAIN is quarantined for
 * `cooldownMs` (an RPC error is not the pair's fault). If
 * nothing landed although there were candidates (and not for auth/timeout),
 * one zero-candidate tick is sent so the mark and the price sample still
 * advance — liquidation counts accepted prints, `liquidation_check` included.
 */
export async function tickCandidates(open: Candidate[], deps: TickCandidatesDeps): Promise<TickCandidatesResult> {
  const out: TickCandidatesResult = { landed: 0, errors: [], quarantined: [], released: [] };
  const { kept, released } = applyQuarantine(open, deps.quarantine, deps.now);
  out.released = released;
  let lastAuth = false;
  let lastOnChain = false;
  const onChain = deps.isOnChainFailure ?? (() => true);
  const attempt = async (chunk: Candidate[]): Promise<boolean> => {
    try {
      await deps.send(chunk);
      out.landed += 1;
      lastAuth = false;
      return true;
    } catch (e) {
      out.errors.push(e);
      lastAuth = deps.isAuthOrTimeout(e);
      lastOnChain = !lastAuth && onChain(e);
      return false;
    }
  };
  const quarantine = (c: Candidate): void => {
    const key = pairKey(c);
    deps.quarantine.set(key, deps.now + deps.cooldownMs);
    out.quarantined.push(key);
  };

  for (const chunk of chunkCandidates(kept, deps.size)) {
    if (await attempt(chunk)) continue;
    if (chunk.length === 1) {
      if (lastOnChain) quarantine(chunk[0]);
      continue;
    }
    if (!shouldRetrySingly(chunk.length, lastAuth)) continue;
    for (const c of chunk) {
      if (await attempt([c])) continue;
      if (lastAuth) break; // the connection, not the pair — stop hammering
      if (lastOnChain) quarantine(c);
    }
  }

  if (out.landed === 0 && kept.length > 0 && !lastAuth) await attempt([]);
  return out;
}
