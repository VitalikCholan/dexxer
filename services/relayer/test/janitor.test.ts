import { test } from "node:test";
import assert from "node:assert/strict";
import { BN, BorshAccountsCoder } from "@coral-xyz/anchor";
import { DEXXER_CORE_IDL } from "../../../tests/er/lib/program.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { EXITED_OFFSET, JANITOR_MAX_ATTEMPTS_PER_CYCLE, createJanitorState, runJanitorCycle, type ExitedOwner, type JanitorDeps } from "../src/janitor.js";

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
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.deepEqual(r, { scanned: 1, closed: [o.owner.toBase58()], skipped: 0, cooledDown: 0, errors: [] });
  assert.equal(closed[0].rentPayer.toBase58(), o.rentPayer.toBase58());
});

test("an owner whose accounts are still delegated is skipped, not closed", async () => {
  const o = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([o], new Set());
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.equal(closed.length, 0);
  assert.deepEqual([r.scanned, r.skipped, r.closed.length], [1, 1, 0]);
});

test("one failing close does not stop the others", async () => {
  const a = { owner: k(), rentPayer: k() };
  const b = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([a, b], new Set([a.owner.toBase58(), b.owner.toBase58()]), new Set([a.owner.toBase58()]));
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.deepEqual(closed.map((c) => c.owner.toBase58()), [b.owner.toBase58()]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /boom/);
});

test("at most JANITOR_MAX_ATTEMPTS_PER_CYCLE successful closes per cycle", async () => {
  const owners = Array.from({ length: JANITOR_MAX_ATTEMPTS_PER_CYCLE + 3 }, () => ({ owner: k(), rentPayer: k() }));
  const { deps, closed } = fakes(owners, new Set(owners.map((o) => o.owner.toBase58())));
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.equal(closed.length, JANITOR_MAX_ATTEMPTS_PER_CYCLE);
  assert.equal(r.scanned, owners.length);
});

test("a failing scan yields an error result, never a throw", async () => {
  const { deps } = fakes([], new Set());
  deps.listExitedOwners = async () => {
    throw new Error("rpc down");
  };
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.deepEqual([r.scanned, r.closed.length], [0, 0]);
  assert.match(r.errors[0], /rpc down/);
});

test("failed attempts count toward the cap", async () => {
  const bad = Array.from({ length: JANITOR_MAX_ATTEMPTS_PER_CYCLE }, () => ({ owner: k(), rentPayer: k() }));
  const good = Array.from({ length: 3 }, () => ({ owner: k(), rentPayer: k() }));
  const all = [...bad, ...good];
  const { deps } = fakes(all, new Set(all.map((o) => o.owner.toBase58())), new Set(bad.map((o) => o.owner.toBase58())));
  let calls = 0;
  const inner = deps.closeExitedUser;
  deps.closeExitedUser = async (o) => {
    calls += 1;
    return inner(o);
  };
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.equal(calls, JANITOR_MAX_ATTEMPTS_PER_CYCLE);
  assert.equal(r.errors.length, JANITOR_MAX_ATTEMPTS_PER_CYCLE);
  assert.equal(r.closed.length, 0);
});

test("a failed owner is in cooldown, retried after it; a success clears the entry", async () => {
  const o = { owner: k(), rentPayer: k() };
  const failing = new Set([o.owner.toBase58()]);
  const { deps, closed } = fakes([o], new Set([o.owner.toBase58()]), failing);
  const state = createJanitorState();
  let t = 1_000;
  const opts = { state, cooldownMs: 5_000, now: () => t };
  let r = await runJanitorCycle(deps, opts);
  assert.equal(r.errors.length, 1);
  t += 1_000;
  r = await runJanitorCycle(deps, opts);
  assert.deepEqual([r.cooledDown, r.errors.length, r.skipped], [1, 0, 0]);
  t += 5_000;
  failing.delete(o.owner.toBase58());
  r = await runJanitorCycle(deps, opts);
  assert.deepEqual(r.closed, [o.owner.toBase58()]);
  assert.equal(closed.length, 1);
  assert.equal(state.failedAt.has(o.owner.toBase58()), false);
});

test("not-yet-home owner sets no cooldown", async () => {
  const o = { owner: k(), rentPayer: k() };
  const { deps } = fakes([o], new Set());
  const state = createJanitorState();
  await runJanitorCycle(deps, { state });
  assert.equal(state.failedAt.size, 0);
});

test("EXITED_OFFSET is the only byte that differs between exited=true/false encodings", async () => {
  const coder = new BorshAccountsCoder(DEXXER_CORE_IDL);
  const base = {
    version: 3, owner: k(), session_key: k(), session_expiry: new BN(7), actions_left: 5, free_margin: new BN(1), locked_margin: new BN(2),
    last_withdraw_slot: new BN(3), exit_salt: Array(32).fill(9), bump: 254, rent_payer: k(), _reserved: Array(32).fill(0),
  };
  const a = await coder.encode("UserAccount", { ...base, exited: true });
  const b = await coder.encode("UserAccount", { ...base, exited: false });
  assert.equal(a.length, b.length);
  const diff = [...a.keys()].filter((i) => a[i] !== b[i]);
  assert.deepEqual(diff, [EXITED_OFFSET]);
  assert.equal(a[EXITED_OFFSET], 1);
  assert.equal(b[EXITED_OFFSET], 0);
});
