// services/relayer/test/disclosure.test.ts
//
// Week-5 Task 7: pure-function coverage for the `COMMIT_MAX_ACTIONS` budget
// and the halve-and-retry decision — no network, no Anchor `Program`. The
// devnet-tee measurement behind the default (bridge rejects a real 8-action
// bundle with 0xA0000002, see disclosure.ts's header comment) is recorded in
// docs/superpowers/plans/week5-results.md, not repeated here.
//
// Fix round 1 (controller review): quarantine/rotation coverage
// (`selectCandidates` + `recordCycleFailure`/`recordCycleSuccess`/
// `isQuarantined`, all pure) and one integration-shaped test that drives the
// real `runDisclosureCycle` end to end with a fake `conn`/`prog` (discovery)
// and a fake injected `sendCommitAggregate` (the try→halve→bare sequence) —
// see disclosure.ts's header comment for why oldest-debt-first needed this.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, type Connection, type PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import {
  createQuarantineState,
  isBridgeActionCapError,
  isQuarantined,
  parseCommitMaxActions,
  parseQuarantineCycles,
  recordCycleFailure,
  recordCycleSuccess,
  runDisclosureCycle,
  selectCandidates,
  type DisclosureCtx,
} from "../src/disclosure.js";

// --- parseCommitMaxActions ---

test("parseCommitMaxActions: defaults to 4 when unset", () => {
  assert.equal(parseCommitMaxActions(undefined), 4);
});

test("parseCommitMaxActions: passes through an in-range value", () => {
  assert.equal(parseCommitMaxActions("6"), 6);
  assert.equal(parseCommitMaxActions("1"), 1);
  assert.equal(parseCommitMaxActions("8"), 8);
});

test("parseCommitMaxActions: clamps above the program's MAX_ACTIONS_PER_COMMIT (8)", () => {
  assert.equal(parseCommitMaxActions("100"), 8);
});

test("parseCommitMaxActions: clamps below 1", () => {
  assert.equal(parseCommitMaxActions("0"), 1);
  assert.equal(parseCommitMaxActions("-5"), 1);
});

test("parseCommitMaxActions: falls back to the default 4 on unparseable input", () => {
  assert.equal(parseCommitMaxActions("not-a-number"), 4);
});

test("parseCommitMaxActions: truncates a fractional value", () => {
  assert.equal(parseCommitMaxActions("4.9"), 4);
});

// --- selectCandidates ---

test("selectCandidates: fills up to budget, oldest-first order preserved", () => {
  const a = Keypair.generate().publicKey;
  const b = Keypair.generate().publicKey;
  const c = Keypair.generate().publicKey;
  const queues = [
    { key: a, actions: 2 },
    { key: b, actions: 3 },
    { key: c, actions: 5 },
  ];
  const candidates = selectCandidates(queues, 4);
  // a takes 2 (budget 4 -> 2 left), b takes the remaining 2 (partial), c is never reached.
  assert.deepEqual(
    candidates.map((x) => x.actions),
    [2, 2],
  );
  assert.equal(candidates[0].key, a);
  assert.equal(candidates[1].key, b);
});

test("selectCandidates: a single queue larger than the whole budget is included partially", () => {
  const a = Keypair.generate().publicKey;
  const candidates = selectCandidates([{ key: a, actions: 8 }], 4);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].actions, 4);
});

test("selectCandidates: empty input yields an empty bundle", () => {
  assert.deepEqual(selectCandidates([], 4), []);
});

test("selectCandidates: zero budget yields an empty bundle", () => {
  const a = Keypair.generate().publicKey;
  assert.deepEqual(selectCandidates([{ key: a, actions: 3 }], 0), []);
});

// --- isBridgeActionCapError ---

test("isBridgeActionCapError: matches the measured 0xA0000002 bridge rejection", () => {
  const e = new Error('transaction abc failed: {"InstructionError":[0,{"Custom":2684354562}]}');
  assert.equal(isBridgeActionCapError(e), true);
});

test("isBridgeActionCapError: does not match an unrelated error", () => {
  assert.equal(isBridgeActionCapError(new Error("some other failure")), false);
  assert.equal(isBridgeActionCapError(new Error('{"InstructionError":[0,{"Custom":6023}]}')), false);
});

test("isBridgeActionCapError: handles a non-Error thrown value", () => {
  assert.equal(isBridgeActionCapError("Custom 2684354562"), true);
  assert.equal(isBridgeActionCapError({ foo: "bar" }), false);
});

// --- parseQuarantineCycles ---

test("parseQuarantineCycles: defaults to 10 when unset", () => {
  assert.equal(parseQuarantineCycles(undefined), 10);
});

test("parseQuarantineCycles: passes through a valid value", () => {
  assert.equal(parseQuarantineCycles("3"), 3);
  assert.equal(parseQuarantineCycles("1"), 1);
});

test("parseQuarantineCycles: falls back to 10 on a non-positive or unparseable value", () => {
  assert.equal(parseQuarantineCycles("0"), 10);
  assert.equal(parseQuarantineCycles("-5"), 10);
  assert.equal(parseQuarantineCycles("nope"), 10);
});

test("parseQuarantineCycles: truncates a fractional value", () => {
  assert.equal(parseQuarantineCycles("3.9"), 3);
});

// --- selectCandidates + quarantine/rotation (fix round 1, CRITICAL finding) ---
//
// Without this, oldest-debt-first alone means a queue that always fails is
// always picked first, forever, and no younger queue is ever reached — a
// live outage of automatic draining (measured: week-5 Task 7's M-I needed a
// manual out-of-band commit for exactly this reason).

test("selectCandidates: a quarantined queue is skipped, letting the next-oldest queue through", () => {
  const a = Keypair.generate().publicKey; // oldest
  const b = Keypair.generate().publicKey; // younger
  const queues = [
    { key: a, actions: 2 },
    { key: b, actions: 2 },
  ];
  const q = createQuarantineState();
  recordCycleFailure(q, [a], 1, 10); // a's first failure -> rotation only
  const atCycle2 = selectCandidates(queues, 4, q, 2);
  assert.deepEqual(
    atCycle2.map((c) => c.key.toBase58()),
    [b.toBase58()],
  );
});

test("selectCandidates: rotation excludes a queue for exactly one cycle after a single failure", () => {
  const a = Keypair.generate().publicKey;
  const q = createQuarantineState();
  recordCycleFailure(q, [a], 1, 10);
  assert.equal(selectCandidates([{ key: a, actions: 1 }], 4, q, 2).length, 0); // excluded — the next cycle
  assert.equal(selectCandidates([{ key: a, actions: 1 }], 4, q, 3).length, 1); // back the cycle after that
});

test("selectCandidates: a poisoned oldest queue is excluded after its SECOND consecutive failure (quarantine, not just rotation)", () => {
  const a = Keypair.generate().publicKey; // poisoned, oldest
  const b = Keypair.generate().publicKey; // healthy, younger
  const queues = [
    { key: a, actions: 1 },
    { key: b, actions: 1 },
  ];
  const q = createQuarantineState();
  recordCycleFailure(q, [a], 1, 10); // failure #1 (rotation, until cycle 3)
  recordCycleFailure(q, [a], 2, 10); // failure #2 (quarantine threshold reached, until cycle 2+1+10=13)
  for (const cycle of [3, 7, 12]) {
    const candidates = selectCandidates(queues, 4, q, cycle);
    assert.deepEqual(
      candidates.map((c) => c.key.toBase58()),
      [b.toBase58()],
      `cycle ${cycle}: only the healthy queue should be selected`,
    );
  }
});

test("recordCycleFailure: logs 'quarantined queue <key> (n failures)' only once the threshold is reached", () => {
  const a = Keypair.generate().publicKey;
  const q = createQuarantineState();
  const lines: string[] = [];
  recordCycleFailure(q, [a], 1, 10, (l) => lines.push(l));
  assert.equal(lines.length, 0);
  recordCycleFailure(q, [a], 2, 10, (l) => lines.push(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`quarantined queue ${a.toBase58()} \\(2 failures\\)`));
});

test("recordCycleSuccess: clears failure/quarantine state entirely", () => {
  const a = Keypair.generate().publicKey;
  const q = createQuarantineState();
  recordCycleFailure(q, [a], 1, 10);
  recordCycleFailure(q, [a], 2, 10); // quarantined
  assert.equal(isQuarantined(q, a.toBase58(), 5), true);
  recordCycleSuccess(q, [a]);
  assert.equal(isQuarantined(q, a.toBase58(), 5), false);
  // healthy again: a single subsequent failure is failure #1 (rotation only), not an immediate re-quarantine
  recordCycleFailure(q, [a], 20, 10);
  assert.equal(isQuarantined(q, a.toBase58(), 21), true); // rotation window
  assert.equal(isQuarantined(q, a.toBase58(), 22), false); // rotation expired after just one cycle
});

test("quarantine expiry: the queue gets exactly one retry — a failure on that retry re-quarantines immediately (failure count not reset by expiry)", () => {
  const a = Keypair.generate().publicKey;
  const q = createQuarantineState();
  recordCycleFailure(q, [a], 1, 10); // #1
  recordCycleFailure(q, [a], 2, 10); // #2 -> quarantined until cycle 13
  assert.equal(isQuarantined(q, a.toBase58(), 12), true);
  assert.equal(isQuarantined(q, a.toBase58(), 13), false); // expired: eligible for its one retry
  assert.equal(selectCandidates([{ key: a, actions: 1 }], 4, q, 13).length, 1);

  const lines: string[] = [];
  recordCycleFailure(q, [a], 13, 10, (l) => lines.push(l)); // the retry fails
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\(3 failures\)/); // immediately re-quarantined, no need for 2 more strikes
  assert.equal(isQuarantined(q, a.toBase58(), 14), true);
});

// --- runDisclosureCycle: the try -> halve -> quarantine -> bare sequence,
// end to end (IMPORTANT finding, controller review) ---

/** Minimal fake `Connection`/`Program` pair: `getProgramAccounts`/`getSlot` and `coder.accounts.decode`, keyed by the raw `data` buffer's content so each fake queue can carry its own decoded shape. */
function fakeDiscovery(queues: { pubkey: InstanceType<typeof Keypair>["publicKey"]; tag: string; decoded: unknown }[], slot: number) {
  const byTag = new Map(queues.map((q) => [q.tag, q.decoded]));
  const conn = {
    getProgramAccounts: async () => queues.map((q) => ({ pubkey: q.pubkey, account: { data: Buffer.from(q.tag) } })),
    getSlot: async () => slot,
  } as unknown as Connection;
  const prog = {
    programId: Keypair.generate().publicKey,
    coder: { accounts: { decode: (_name: string, data: Buffer) => byTag.get(data.toString())! } },
  } as unknown as Program;
  return { conn, prog };
}

function fakeDqRecord(commitmentWritten: boolean, revealAfterSlot: number, closedSlot: number) {
  return { commitmentWritten, revealAfterSlot: BigInt(revealAfterSlot), closedSlot: BigInt(closedSlot) };
}

test("runDisclosureCycle: full-budget attempt fails, halved retry fails, bare retry succeeds — and the halved (confirmed-failing) queue is quarantined", async () => {
  const ownerA = Keypair.generate().publicKey; // oldest — the one that ends up in the halved (failing) set
  const ownerB = Keypair.generate().publicKey; // younger

  const { conn, prog } = fakeDiscovery(
    [
      { pubkey: ownerA, tag: "A", decoded: { len: 1, head: 0, records: [fakeDqRecord(true, 0, 1)] } },
      { pubkey: ownerB, tag: "B", decoded: { len: 1, head: 0, records: [fakeDqRecord(true, 0, 2)] } },
    ],
    100,
  );

  const calls: PublicKey[][] = [];
  const bridgeCapError = new Error('transaction x failed: {"InstructionError":[0,{"Custom":2684354562}]}');
  let call = 0;
  const sendCommitAggregate = async (_ctx: DisclosureCtx, keys: PublicKey[]): Promise<string> => {
    calls.push(keys);
    call += 1;
    if (call <= 2) throw bridgeCapError; // 1: full budget (A+B), 2: halved (A only) — both the bridge's action cap
    return "fake-sig"; // 3: bare retry (0 accounts)
  };

  const quarantine = createQuarantineState();
  const ctx = {
    conn,
    prog,
    crank: Keypair.generate(),
    feePayerConn: conn,
    feePayerProg: prog,
    feePayer: Keypair.generate(),
    pool: Keypair.generate().publicKey,
    poolLive: Keypair.generate().publicKey,
    balancesRoot: Keypair.generate().publicKey,
    feeEscrow: Keypair.generate().publicKey,
    sendCommitAggregate,
    quarantine,
    cycle: 1,
  } as unknown as DisclosureCtx;

  await runDisclosureCycle(ctx);

  assert.equal(calls.length, 3, "full budget, halved retry, bare retry");
  assert.deepEqual(
    calls[0].map((k) => k.toBase58()),
    [ownerA.toBase58(), ownerB.toBase58()],
  );
  assert.deepEqual(
    calls[1].map((k) => k.toBase58()),
    [ownerA.toBase58()],
  ); // halved to 1 action -> only the oldest (A) fits
  assert.deepEqual(calls[2], []); // bare retry

  // A was in the halved (confirmed-failing) set with ONE failure so far —
  // rotated out for the next cycle, not yet quarantined.
  assert.equal(isQuarantined(quarantine, ownerA.toBase58(), 2), true);
  assert.equal(isQuarantined(quarantine, ownerA.toBase58(), 3), false);
  // B was never in the failing (halved) set — untouched.
  assert.equal(isQuarantined(quarantine, ownerB.toBase58(), 2), false);

  // A SECOND cycle that fails the same way quarantines A for real.
  call = 0;
  await runDisclosureCycle({ ...ctx, cycle: 3 });
  assert.equal(isQuarantined(quarantine, ownerA.toBase58(), 4), true);
  assert.equal(isQuarantined(quarantine, ownerA.toBase58(), 13), true); // still within QUARANTINE_CYCLES (default 10)
  assert.equal(isQuarantined(quarantine, ownerA.toBase58(), 14), false); // expired

  // A THIRD cycle (A now quarantined): selection skips straight to B, so a
  // younger queue behind the poisoned one drains normally instead of
  // starving forever — this is the actual outage fix.
  call = 0;
  const onlyBCalls: PublicKey[][] = [];
  const sendThatSucceeds = async (_ctx: DisclosureCtx, keys: PublicKey[]): Promise<string> => {
    onlyBCalls.push(keys);
    return "fake-sig-2";
  };
  await runDisclosureCycle({ ...ctx, cycle: 4, sendCommitAggregate: sendThatSucceeds });
  assert.equal(onlyBCalls.length, 1);
  assert.deepEqual(
    onlyBCalls[0].map((k) => k.toBase58()),
    [ownerB.toBase58()],
  );
});
