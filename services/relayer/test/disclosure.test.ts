// services/relayer/test/disclosure.test.ts
//
// Week-5 Task 7: pure-function coverage for the `COMMIT_MAX_ACTIONS` budget
// and the halve-and-retry decision — no network, no Anchor `Program`. The
// devnet-tee measurement behind the default (bridge rejects a real 8-action
// bundle with 0xA0000002, see disclosure.ts's header comment) is recorded in
// docs/superpowers/plans/week5-results.md, not repeated here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { isBridgeActionCapError, parseCommitMaxActions, selectCandidates } from "../src/disclosure.js";

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
