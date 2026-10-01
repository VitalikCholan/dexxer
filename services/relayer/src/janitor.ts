// services/relayer/src/janitor.ts
//
// Closes the two L1 accounts (`UserAccount`, `Positions`) of owners who have
// left the rollup (spec §2.9.2). There is no partial exit any more:
// `undelegate_user` requires zero margin and no open slot, scrubs the history
// ring and sends both accounts home, so one base-layer pass is the whole job.
//
// The rent goes to `UserAccount.rent_payer` — whoever funded the onboarding
// (risk #39): this service when it sponsored it, the owner when they paid
// themselves. The owner may also close on their own; this pass just does not
// make them.
//
// Spend is bounded two ways: at most JANITOR_MAX_ATTEMPTS_PER_CYCLE close
// attempts per cycle (successes AND failures — `sendAndConfirmIx` skips
// preflight, so a failing close still pays a fee), and a per-owner cooldown
// after a failed attempt. The cooldown memory is per process: a restart
// forgets it and retries each failing owner once.
//
// Reads here are base-layer reads of accounts that are back under the program
// — public by then (exit scrubbed every private byte).
import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { USER_DISC, accountNs, pdas } from "../../../tests/er/lib/program.js";
import { envNum } from "./env.js";
import { sendAndConfirmIx } from "../../../tests/er/lib/env.js";
import { closeExitedUserAccounts } from "../../../tests/er/lib/trader.js";

/** Bounds what one cycle can spend in fees: counts close ATTEMPTS (success or failure), not successes. */
export const JANITOR_MAX_ATTEMPTS_PER_CYCLE = 8;
/** An owner whose close failed is not attempted again for this long. */
export const JANITOR_RETRY_COOLDOWN_MS = envNum("JANITOR_RETRY_COOLDOWN_MS", 3_600_000, 60_000);
/**
 * Byte offset of `UserAccount.exited` (8 discriminator + 1 + 32 + 32 + 8 + 4 + 8
 * + 8 + 8 + 32 + 1); pinned against the IDL coder in test/janitor.test.ts.
 */
export const EXITED_OFFSET = 142;

export interface JanitorState {
  /** owner base58 -> Date.now() of the last failed attempt */
  failedAt: Map<string, number>;
}
export function createJanitorState(): JanitorState {
  return { failedAt: new Map() };
}
const moduleState = createJanitorState();
export interface JanitorOpts {
  maxAttempts?: number;
  cooldownMs?: number;
  now?: () => number;
  state?: JanitorState;
}

export interface ExitedOwner {
  owner: PublicKey;
  rentPayer: PublicKey;
}
export interface JanitorDeps {
  listExitedOwners: () => Promise<ExitedOwner[]>;
  /** Both accounts exist and are owned by the program again (not by the Delegation Program). */
  bothUnderProgram: (owner: PublicKey) => Promise<boolean>;
  closeExitedUser: (o: ExitedOwner) => Promise<string>;
  log?: (line: string) => void;
}
export interface JanitorResult {
  scanned: number;
  closed: string[];
  /** Not attempted: still delegated (not both home yet). */
  skipped: number;
  /** Not attempted: failed recently, inside the cooldown. */
  cooledDown: number;
  errors: string[];
}

export async function runJanitorCycle(deps: JanitorDeps, opts: JanitorOpts = {}): Promise<JanitorResult> {
  const maxAttempts = opts.maxAttempts ?? JANITOR_MAX_ATTEMPTS_PER_CYCLE;
  const cooldownMs = opts.cooldownMs ?? JANITOR_RETRY_COOLDOWN_MS;
  const now = opts.now ?? Date.now;
  const state = opts.state ?? moduleState;
  const out: JanitorResult = { scanned: 0, closed: [], skipped: 0, cooledDown: 0, errors: [] };
  const log = deps.log ?? console.log;
  let owners: ExitedOwner[];
  try {
    owners = await deps.listExitedOwners();
  } catch (e) {
    out.errors.push(`janitor scan: ${String(e instanceof Error ? e.message : e)}`);
    return out;
  }
  out.scanned = owners.length;
  let attempts = 0;
  for (const o of owners) {
    if (attempts >= maxAttempts) break;
    const key = o.owner.toBase58();
    try {
      const failed = state.failedAt.get(key);
      if (failed !== undefined && now() - failed < cooldownMs) {
        out.cooledDown += 1;
        continue;
      }
      if (!(await deps.bothUnderProgram(o.owner))) {
        out.skipped += 1;
        continue;
      }
      attempts += 1;
      const sig = await deps.closeExitedUser(o);
      state.failedAt.delete(key);
      out.closed.push(key);
      log(`janitor: closed ${key} rent_payer=${o.rentPayer.toBase58()} sig=${sig}`);
    } catch (e) {
      state.failedAt.set(key, now());
      out.errors.push(`janitor ${key}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
  return out;
}

export function janitorDeps(w: { baseConn: Connection; baseProg: Program; feePayer: Keypair }): JanitorDeps {
  const programId = w.baseProg.programId;
  return {
    async listExitedOwners() {
      const rows = await w.baseConn.getProgramAccounts(programId, {
        filters: [
          { dataSize: accountNs(w.baseProg).userAccount.size as number },
          { memcmp: { offset: 0, bytes: USER_DISC } },
          { memcmp: { offset: EXITED_OFFSET, bytes: bs58.encode([1]) } },
        ],
      });
      const out: ExitedOwner[] = [];
      for (const r of rows) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ua = w.baseProg.coder.accounts.decode("userAccount", r.account.data) as any;
          if (ua.exited) out.push({ owner: new PublicKey(ua.owner), rentPayer: new PublicKey(ua.rentPayer) });
        } catch {
          // Not this layout — not ours to close.
        }
      }
      return out;
    },
    async bothUnderProgram(owner) {
      const infos = await w.baseConn.getMultipleAccountsInfo([pdas.userAccount(owner), pdas.positions(owner)], "confirmed");
      return infos.every((i) => i !== null && i.owner.equals(programId));
    },
    async closeExitedUser(o) {
      const ix = await w.baseProg.methods
        .closeExitedUser()
        .accounts(closeExitedUserAccounts(w.feePayer.publicKey, o.owner, o.rentPayer))
        .instruction();
      return sendAndConfirmIx(w.baseConn, w.feePayer, ix);
    },
  };
}
