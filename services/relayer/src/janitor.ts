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
// Reads here are base-layer reads of accounts that are back under the program
// — public by then (exit scrubbed every private byte).
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { USER_DISC, pdas } from "../../../tests/er/lib/program.js";
import { sendAndConfirmIx } from "../../../tests/er/lib/env.js";
import { closeExitedUserAccounts } from "../../../tests/er/lib/trader.js";

/** Bounds what one cycle can spend in fees if many owners leave at once. */
export const JANITOR_MAX_CLOSES_PER_CYCLE = 8;

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
  skipped: number;
  errors: string[];
}

export async function runJanitorCycle(deps: JanitorDeps, maxCloses = JANITOR_MAX_CLOSES_PER_CYCLE): Promise<JanitorResult> {
  const out: JanitorResult = { scanned: 0, closed: [], skipped: 0, errors: [] };
  const log = deps.log ?? console.log;
  let owners: ExitedOwner[];
  try {
    owners = await deps.listExitedOwners();
  } catch (e) {
    out.errors.push(`janitor scan: ${String(e instanceof Error ? e.message : e)}`);
    return out;
  }
  out.scanned = owners.length;
  for (const o of owners) {
    if (out.closed.length >= maxCloses) break;
    try {
      if (!(await deps.bothUnderProgram(o.owner))) {
        out.skipped += 1;
        continue;
      }
      const sig = await deps.closeExitedUser(o);
      out.closed.push(o.owner.toBase58());
      log(`janitor: closed ${o.owner.toBase58()} rent_payer=${o.rentPayer.toBase58()} sig=${sig}`);
    } catch (e) {
      out.errors.push(`janitor ${o.owner.toBase58()}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
  return out;
}

export function janitorDeps(w: { baseConn: Connection; baseProg: Program; feePayer: Keypair }): JanitorDeps {
  const programId = w.baseProg.programId;
  return {
    async listExitedOwners() {
      const rows = await w.baseConn.getProgramAccounts(programId, { filters: [{ memcmp: { offset: 0, bytes: USER_DISC } }] });
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
