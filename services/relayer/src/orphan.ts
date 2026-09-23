// services/relayer/src/orphan.ts
//
// Week-5 Task 5: the janitor for the exit-with-debt path (spec §2.6.3).
//
// `undelegate_user` lets an owner leave the rollup while their
// `DisclosureQueue` still owes L1 the commitments and disclosures of trades
// they closed before exiting: `UserAccount`/`Position` go home, the queue
// stays behind in the ER, delegated and crank-only, with
// `UserAccount.exited = true`. `commit_aggregate` drains those records on
// its normal cycle. Once the last one is gone the queue is dead weight, and
// nothing on-chain reclaims it on its own — that is this file's job, in two
// passes per cycle:
//
//   1. ER (crank): every `DisclosureQueue` with `len == 0` whose owner has
//      actually left -> `close_orphan_queue`, which scrubs the ring, closes
//      its permission and hands the account back to L1.
//   2. base (`Config.fee_payer`): every owner whose three PDAs are back
//      under `dexxer_core` and whose `UserAccount.exited` is set ->
//      `close_exited_user`, which closes all three and returns their rent to
//      `fee_payer` (which fronted it at `init_user`).
//
// WHAT "the owner has left" MEANS, measured (week-5 Task 4, §Task 4 (c) of
// week5-results.md): after a partial exit the TEE goes on serving the BASE
// clone of the `UserAccount` — present, owned by `dexxer_core`, `exited =
// true`. The account does NOT disappear from the ER. So the signal this
// cycle reads (and the one the program reads since this task's upgrade) is
// `exited == true`, with "absent entirely" accepted as the other half.
//
// The two passes are deliberately independent: pass 1's undelegation takes
// a few seconds to land on base, well after this cycle has finished, so the
// owner it just closed in the ER is picked up by pass 2 of a LATER cycle
// (found by scanning base, not by remembering anything in memory — a
// relayer restart must not strand an account halfway home).
//
// Everything is injected (`OrphanCycleDeps`) so the policy above is unit
// tested directly — see test/orphan.test.ts. `orphanDeps()` at the bottom is
// the real wiring; it is the only part that touches an RPC.
//
// PRIVACY: the ER pass reads `DisclosureQueue`s, which the crank can see
// because it is a permission member of every per-user account (`[owner,
// session, crank]`) — the same membership `crank.ts` already relies on for
// liquidation candidates. The base pass reads L1 accounts, which are public
// to everyone by definition. No owner or session token is ever used here.

import { PublicKey } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { EPHEMERAL_VAULT_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { sendAndConfirmIx } from "../../../tests/er/lib/env.js";
import { DQ_DISC, USER_DISC, pdas } from "../../../tests/er/lib/program.js";

/** One `DisclosureQueue` as the crank sees it in the ER. */
export interface OrphanQueueRow {
  key: PublicKey;
  owner: PublicKey;
  len: number;
}

export interface OrphanCycleDeps {
  /** ER, crank token: every decodable `DisclosureQueue` in the rollup. */
  listQueues(): Promise<OrphanQueueRow[]>;
  /** ER, crank token: the owner's `UserAccount` as the ER serves it — `null` when absent or undecodable. */
  readErUserAccount(owner: PublicKey): Promise<{ exited: boolean } | null>;
  /** ER, crank: `close_orphan_queue`. Returns the signature. */
  closeOrphanQueue(row: OrphanQueueRow): Promise<string>;
  /** base: owners with a `UserAccount` under this program — the candidate set for the base pass. */
  listBaseOwners(): Promise<PublicKey[]>;
  /** base: is this owner's whole triple home and exited? `null` when the `UserAccount` is gone (already reclaimed). */
  readBaseTriple(owner: PublicKey): Promise<{ exited: boolean; allUnderProgram: boolean } | null>;
  /** base, `Config.fee_payer`: `close_exited_user`. Returns the signature. */
  closeExitedUser(owner: PublicKey): Promise<string>;
  log?(line: string): void;
}

export interface OrphanCycleResult {
  /** Queues seen in the ER this cycle. */
  scanned: number;
  /** Owners whose queue was closed in the ER (base58). */
  closedInEr: string[];
  /** Owners whose three PDAs were closed on base (base58). */
  closedOnBase: string[];
  /** Drained queues left alone because their owner is still live. */
  skipped: number;
  /** Per-owner failures — logged, never thrown: one stuck account must not stop the janitor. */
  errors: number;
}

/**
 * Idempotent: a queue already closed simply does not appear in `listQueues`
 * next cycle, and an owner already reclaimed does not appear in
 * `listBaseOwners`. Never throws for a per-owner failure — only a failing
 * `listQueues`/`listBaseOwners` (the whole scan) propagates, and the caller
 * in crank.ts wraps even that.
 */
export async function runOrphanCycle(deps: OrphanCycleDeps): Promise<OrphanCycleResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const result: OrphanCycleResult = { scanned: 0, closedInEr: [], closedOnBase: [], skipped: 0, errors: 0 };

  // --- pass 1: the ER ----------------------------------------------------
  const queues = await deps.listQueues();
  result.scanned = queues.length;
  for (const row of queues) {
    const owner = row.owner.toBase58();
    // A queue that still owes L1 a reveal is never touched — those records
    // are the only copy of trades already promised publicly. The program
    // enforces this too (`QueueStillPending`); not sending the transaction
    // at all just saves the fee.
    if (row.len > 0) continue;
    let ua: { exited: boolean } | null;
    try {
      ua = await deps.readErUserAccount(row.owner);
    } catch (e) {
      result.errors += 1;
      log(`orphan: ${owner} — UserAccount read failed: ${String(e)}`);
      continue;
    }
    if (ua !== null && !ua.exited) {
      result.skipped += 1;
      continue; // a live owner's queue that simply has nothing pending
    }
    try {
      const sig = await deps.closeOrphanQueue(row);
      result.closedInEr.push(owner);
      log(`orphan: closed queue ${row.key.toBase58()} of ${owner} in the ER (${ua === null ? "UserAccount absent" : "exited"}) sig=${sig}`);
    } catch (e) {
      result.errors += 1;
      log(`orphan: close_orphan_queue failed for ${owner}: ${String(e)}`);
    }
  }

  // --- pass 2: base ------------------------------------------------------
  let baseOwners: PublicKey[];
  try {
    baseOwners = await deps.listBaseOwners();
  } catch (e) {
    result.errors += 1;
    log(`orphan: base owner scan failed: ${String(e)}`);
    return result;
  }
  for (const owner of baseOwners) {
    const o = owner.toBase58();
    try {
      const triple = await deps.readBaseTriple(owner);
      // `allUnderProgram` false means at least one of the three is still
      // owned by the Delegation Program — the undelegation has not settled,
      // so `close_exited_user`'s typed accounts would reject it anyway. Next
      // cycle.
      if (!triple || !triple.exited || !triple.allUnderProgram) continue;
      const sig = await deps.closeExitedUser(owner);
      result.closedOnBase.push(o);
      log(`orphan: closed the three PDAs of ${o} on base, rent back to fee_payer sig=${sig}`);
    } catch (e) {
      result.errors += 1;
      log(`orphan: close_exited_user failed for ${o}: ${String(e)}`);
    }
  }

  return result;
}

// --- real wiring ---------------------------------------------------------

export interface OrphanWiring {
  /** Crank-authenticated ER connection + program (the permission member that can see private queues). */
  erConn: Connection;
  erProg: Program;
  crank: Keypair;
  /** Base RPC connection + a program bound to `fee_payer` (the only accepted `close_exited_user` signer). */
  baseConn: Connection;
  baseProg: Program;
  feePayer: Keypair;
  /** `Config.magic_fee_vault` — the ER close pays its commit through `FeeEscrow`, as every other commit-bearing ix does. */
  magicFeeVault: PublicKey;
}

/** Builds the real `OrphanCycleDeps` — the only part of this file that touches an RPC. */
export function orphanDeps(w: OrphanWiring): OrphanCycleDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decode = (prog: Program, name: string, data: Buffer): any => prog.coder.accounts.decode(name, data);

  return {
    async listQueues() {
      const accs = await w.erConn.getProgramAccounts(w.erProg.programId, {
        filters: [{ memcmp: { offset: 0, bytes: DQ_DISC } }],
      });
      const rows: OrphanQueueRow[] = [];
      for (const a of accs) {
        try {
          const dq = decode(w.erProg, "disclosureQueue", a.account.data);
          rows.push({ key: a.pubkey, owner: new PublicKey(dq.owner), len: Number(dq.len) });
        } catch (e) {
          // Legacy-layout leftovers from weeks 1-2 testing share the
          // discriminator but not the byte layout — skip, never crash the
          // cycle (same policy as disclosure.ts's `decodeOrSkip`).
          console.log(`orphan: skipped legacy queue ${a.pubkey.toBase58()} len=${a.account.data.length} (${String(e)})`);
        }
      }
      return rows;
    },

    async readErUserAccount(owner) {
      const info = await w.erConn.getAccountInfo(pdas.userAccount(owner), "confirmed");
      if (!info || info.data.length === 0) return null;
      if (!info.owner.equals(w.erProg.programId)) return null; // foreign-owned reads the same as absent (the program treats it so)
      try {
        const ua = decode(w.erProg, "userAccount", info.data);
        return { exited: Boolean(ua.exited) };
      } catch {
        // Undecodable means an unknown layout, not a proven exit — leave it
        // alone rather than close a queue on a guess.
        return { exited: false };
      }
    },

    async closeOrphanQueue(row) {
      const ix = await w.erProg.methods
        .closeOrphanQueue()
        .accounts({
          crank: w.crank.publicKey,
          config: pdas.config(),
          dq: row.key,
          userAccount: pdas.userAccount(row.owner),
          dqPermission: permissionPdaFromAccount(row.key),
          ephemeralVault: EPHEMERAL_VAULT_ID,
          permissionProgram: PERMISSION_PROGRAM_ID,
          feeEscrow: pdas.feeEscrow(),
          magicFeeVault: w.magicFeeVault,
          magicContext: MAGIC_CONTEXT_ID,
          magicProgram: MAGIC_PROGRAM_ID,
        })
        .instruction();
      return sendAndConfirmIx(w.erConn, w.crank, ix);
    },

    async listBaseOwners() {
      // `dataSlice: {offset: 0, length: 0}` — only the keys are needed here;
      // `readBaseTriple` fetches the bytes of the few that matter.
      const accs = await w.baseConn.getProgramAccounts(w.baseProg.programId, {
        filters: [{ memcmp: { offset: 0, bytes: USER_DISC } }],
        dataSlice: { offset: 0, length: 0 },
      });
      const owners: PublicKey[] = [];
      for (const a of accs) {
        // The `UserAccount` PDA is seeded by its owner, so the owner cannot
        // be recovered from the address — read the account and take the
        // stored field. Cheap enough: this runs once per commit interval.
        const info = await w.baseConn.getAccountInfo(a.pubkey, "confirmed");
        if (!info) continue;
        try {
          const ua = decode(w.baseProg, "userAccount", info.data);
          if (ua.exited) owners.push(new PublicKey(ua.owner));
        } catch {
          // legacy layout — ignore
        }
      }
      return owners;
    },

    async readBaseTriple(owner) {
      const market = pdas.market();
      const keys = [pdas.userAccount(owner), pdas.position(owner, market), pdas.disclosureQueue(owner)];
      const infos = await w.baseConn.getMultipleAccountsInfo(keys, "confirmed");
      const [uaInfo] = infos;
      if (!uaInfo) return null;
      const allUnderProgram = infos.every((i) => i !== null && i.owner.equals(w.baseProg.programId));
      try {
        const ua = decode(w.baseProg, "userAccount", uaInfo.data);
        return { exited: Boolean(ua.exited), allUnderProgram };
      } catch {
        return { exited: false, allUnderProgram };
      }
    },

    async closeExitedUser(owner) {
      const market = pdas.market();
      const ix = await w.baseProg.methods
        .closeExitedUser()
        .accounts({
          feePayer: w.feePayer.publicKey,
          config: pdas.config(),
          userAccount: pdas.userAccount(owner),
          position: pdas.position(owner, market),
          dq: pdas.disclosureQueue(owner),
        })
        .instruction();
      return sendAndConfirmIx(w.baseConn, w.feePayer, ix);
    },
  };
}
