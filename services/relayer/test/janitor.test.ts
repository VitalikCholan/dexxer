import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { JANITOR_MAX_CLOSES_PER_CYCLE, runJanitorCycle, type ExitedOwner, type JanitorDeps } from "../src/janitor.js";

const k = () => Keypair.generate().publicKey;
function fakes(owners: ExitedOwner[], home: Set<string>, failing = new Set<string>()) {
  const closed: ExitedOwner[] = [];
  const deps: JanitorDeps = {
    listExitedOwners: async () => owners,
    bothUnderProgram: async (o: PublicKey) => home.has(o.toBase58()),
    closeExitedUser: async (o) => {
      if (failing.has(o.owner.toBase58())) throw new Error("boom");
      closed.push(o);
      return `sig-${o.owner.toBase58().slice(0, 4)}`;
    },
    log: () => {},
  };
  return { deps, closed };
}

test("closes an exited owner whose two accounts are back under the program, rent to the recorded payer", async () => {
  const o = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([o], new Set([o.owner.toBase58()]));
  const r = await runJanitorCycle(deps);
  assert.deepEqual(r, { scanned: 1, closed: [o.owner.toBase58()], skipped: 0, errors: [] });
  assert.equal(closed[0].rentPayer.toBase58(), o.rentPayer.toBase58());
});

test("an owner whose accounts are still delegated is skipped, not closed", async () => {
  const o = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([o], new Set());
  const r = await runJanitorCycle(deps);
  assert.equal(closed.length, 0);
  assert.deepEqual([r.scanned, r.skipped, r.closed.length], [1, 1, 0]);
});

test("one failing close does not stop the others", async () => {
  const a = { owner: k(), rentPayer: k() };
  const b = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([a, b], new Set([a.owner.toBase58(), b.owner.toBase58()]), new Set([a.owner.toBase58()]));
  const r = await runJanitorCycle(deps);
  assert.deepEqual(closed.map((c) => c.owner.toBase58()), [b.owner.toBase58()]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /boom/);
});

test("at most JANITOR_MAX_CLOSES_PER_CYCLE closes per cycle", async () => {
  const owners = Array.from({ length: JANITOR_MAX_CLOSES_PER_CYCLE + 3 }, () => ({ owner: k(), rentPayer: k() }));
  const { deps, closed } = fakes(owners, new Set(owners.map((o) => o.owner.toBase58())));
  const r = await runJanitorCycle(deps);
  assert.equal(closed.length, JANITOR_MAX_CLOSES_PER_CYCLE);
  assert.equal(r.scanned, owners.length);
});

test("a failing scan yields an error result, never a throw", async () => {
  const { deps } = fakes([], new Set());
  deps.listExitedOwners = async () => {
    throw new Error("rpc down");
  };
  const r = await runJanitorCycle(deps);
  assert.deepEqual([r.scanned, r.closed.length], [0, 0]);
  assert.match(r.errors[0], /rpc down/);
});
