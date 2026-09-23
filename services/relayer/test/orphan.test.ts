// services/relayer/test/orphan.test.ts
//
// `runOrphanCycle` takes every read and every write as an injected function
// (see src/orphan.ts's `OrphanCycleDeps`), so the whole decision table is
// exercised here with plain fakes — no TEE, no base RPC, no Postgres. What
// is under test is exactly the policy, not the plumbing:
//
//   ER pass:   len > 0            -> never closed (L1 is still owed a reveal)
//              len == 0, exited   -> closed as the crank
//              len == 0, !exited  -> skipped (a live owner's queue)
//              len == 0, UA gone  -> closed (the other half of the signal)
//   base pass: all three PDAs back under dexxer_core AND exited -> closed
//              anything still delegated                         -> skipped
//
// and that one failing owner never aborts the cycle for the others.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { runOrphanCycle, type OrphanCycleDeps, type OrphanQueueRow } from "../src/orphan.js";

function queue(owner: PublicKey, len: number): OrphanQueueRow {
  return { key: Keypair.generate().publicKey, owner, len };
}

interface Fakes {
  deps: OrphanCycleDeps;
  closedInEr: string[];
  closedOnBase: string[];
}

function fakes(opts: {
  queues?: OrphanQueueRow[];
  erUsers?: Map<string, { exited: boolean } | null>;
  baseOwners?: PublicKey[];
  baseTriples?: Map<string, { exited: boolean; allUnderProgram: boolean } | null>;
  failEr?: Set<string>;
}): Fakes {
  const closedInEr: string[] = [];
  const closedOnBase: string[] = [];
  const deps: OrphanCycleDeps = {
    listQueues: async () => opts.queues ?? [],
    readErUserAccount: async (owner) => opts.erUsers?.get(owner.toBase58()) ?? null,
    closeOrphanQueue: async (row) => {
      if (opts.failEr?.has(row.owner.toBase58())) throw new Error("simulated ER failure");
      closedInEr.push(row.owner.toBase58());
      return "er-sig";
    },
    listBaseOwners: async () => opts.baseOwners ?? [],
    readBaseTriple: async (owner) => opts.baseTriples?.get(owner.toBase58()) ?? null,
    closeExitedUser: async (owner) => {
      closedOnBase.push(owner.toBase58());
      return "base-sig";
    },
    log: () => {},
  };
  return { deps, closedInEr, closedOnBase };
}

test("runOrphanCycle: a queue with len > 0 is never closed", async () => {
  const owner = Keypair.generate().publicKey;
  const f = fakes({
    queues: [queue(owner, 1)],
    erUsers: new Map([[owner.toBase58(), { exited: true }]]), // exited, but still owes L1 a reveal
  });
  const res = await runOrphanCycle(f.deps);
  assert.deepEqual(f.closedInEr, []);
  assert.equal(res.closedInEr.length, 0);
  assert.equal(res.scanned, 1);
});

test("runOrphanCycle: a drained queue whose UserAccount is exited is closed", async () => {
  const owner = Keypair.generate().publicKey;
  const f = fakes({
    queues: [queue(owner, 0)],
    erUsers: new Map([[owner.toBase58(), { exited: true }]]),
  });
  const res = await runOrphanCycle(f.deps);
  assert.deepEqual(f.closedInEr, [owner.toBase58()]);
  assert.deepEqual(res.closedInEr, [owner.toBase58()]);
});

test("runOrphanCycle: a drained queue whose UserAccount is NOT exited is skipped", async () => {
  const owner = Keypair.generate().publicKey;
  const f = fakes({
    queues: [queue(owner, 0)],
    erUsers: new Map([[owner.toBase58(), { exited: false }]]),
  });
  const res = await runOrphanCycle(f.deps);
  assert.deepEqual(f.closedInEr, []);
  assert.equal(res.skipped, 1);
});

test("runOrphanCycle: a drained queue whose UserAccount is absent is closed", async () => {
  const owner = Keypair.generate().publicKey;
  const f = fakes({ queues: [queue(owner, 0)], erUsers: new Map([[owner.toBase58(), null]]) });
  const res = await runOrphanCycle(f.deps);
  assert.deepEqual(res.closedInEr, [owner.toBase58()]);
});

test("runOrphanCycle: one failing ER close does not stop the rest of the cycle", async () => {
  const bad = Keypair.generate().publicKey;
  const good = Keypair.generate().publicKey;
  const f = fakes({
    queues: [queue(bad, 0), queue(good, 0)],
    erUsers: new Map([
      [bad.toBase58(), { exited: true }],
      [good.toBase58(), { exited: true }],
    ]),
    failEr: new Set([bad.toBase58()]),
  });
  const res = await runOrphanCycle(f.deps);
  assert.deepEqual(f.closedInEr, [good.toBase58()]);
  assert.equal(res.errors, 1);
});

test("runOrphanCycle: base pass closes an owner whose three PDAs are back under the program", async () => {
  const owner = Keypair.generate().publicKey;
  const f = fakes({
    baseOwners: [owner],
    baseTriples: new Map([[owner.toBase58(), { exited: true, allUnderProgram: true }]]),
  });
  const res = await runOrphanCycle(f.deps);
  assert.deepEqual(f.closedOnBase, [owner.toBase58()]);
  assert.deepEqual(res.closedOnBase, [owner.toBase58()]);
});

test("runOrphanCycle: base pass skips an owner whose PDAs are still delegated", async () => {
  const owner = Keypair.generate().publicKey;
  const f = fakes({
    baseOwners: [owner],
    baseTriples: new Map([[owner.toBase58(), { exited: true, allUnderProgram: false }]]),
  });
  await runOrphanCycle(f.deps);
  assert.deepEqual(f.closedOnBase, []);
});

test("runOrphanCycle: base pass skips a live (not exited) owner", async () => {
  const owner = Keypair.generate().publicKey;
  const f = fakes({
    baseOwners: [owner],
    baseTriples: new Map([[owner.toBase58(), { exited: false, allUnderProgram: true }]]),
  });
  await runOrphanCycle(f.deps);
  assert.deepEqual(f.closedOnBase, []);
});

test("runOrphanCycle: an empty rollup is a no-op that still reports", async () => {
  const f = fakes({});
  const res = await runOrphanCycle(f.deps);
  assert.deepEqual(res, { scanned: 0, closedInEr: [], closedOnBase: [], skipped: 0, errors: 0 });
});
