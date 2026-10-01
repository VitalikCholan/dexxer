// Final review m2/m5/m6: one production classifier, exercised with the real
// error strings the relayer sees (confirmSignature, web3.js fetch, RPC).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isConnectionClass, looksLikeAuthError, looksLikeOnChainFailure, normalizeErrorMessage } from "../src/errors.js";

const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const ON_CHAIN = new Error(`transaction ${SIG} failed: {"InstructionError":[1,{"Custom":3002}]}`);
const TIMEOUT = new Error(`confirmSignature timeout waiting for ${SIG}`);
const RATE = new Error("429 Too Many Requests");
const FETCH = new TypeError("fetch failed");
const UNAUTH = new Error('401 Unauthorized: {"error":"invalid token"}');
const BAD_GATEWAY = new Error("502 Bad Gateway");
const BLOCKHASH = new Error("freshBlockhash timeout: no new blockhash within 5000 ms");

test("looksLikeOnChainFailure: only a landed-and-rejected transaction", () => {
  assert.equal(looksLikeOnChainFailure(ON_CHAIN), true);
  for (const e of [TIMEOUT, RATE, FETCH, UNAUTH, BAD_GATEWAY, BLOCKHASH]) assert.equal(looksLikeOnChainFailure(e), false, String(e));
});

test("isConnectionClass: everything that is not an on-chain failure (auth, timeout, fetch failed, 429, 5xx, other RPC errors)", () => {
  assert.equal(isConnectionClass(ON_CHAIN), false);
  for (const e of [TIMEOUT, RATE, FETCH, UNAUTH, BAD_GATEWAY, BLOCKHASH, new Error("Blockhash not found")]) {
    assert.equal(isConnectionClass(e), true, String(e));
  }
  assert.equal(isConnectionClass("fetch failed"), true, "a thrown string is classified too");
});

test("looksLikeAuthError: a 401 / unauthorized only", () => {
  assert.equal(looksLikeAuthError(UNAUTH), true);
  assert.equal(looksLikeAuthError(new Error("Unauthorized")), true);
  for (const e of [ON_CHAIN, TIMEOUT, RATE, FETCH, BAD_GATEWAY]) assert.equal(looksLikeAuthError(e), false, String(e));
});

test("normalizeErrorMessage strips the signature so one failure repeated with new signatures dedupes (m5)", () => {
  const other = `transaction 3xYz9abc failed: {"InstructionError":[1,{"Custom":3002}]}`;
  assert.equal(normalizeErrorMessage(ON_CHAIN.message), normalizeErrorMessage(other));
  assert.equal(normalizeErrorMessage(ON_CHAIN.message), 'transaction <sig> failed: {"InstructionError":[1,{"Custom":3002}]}');
  assert.equal(normalizeErrorMessage(TIMEOUT.message), "confirmSignature timeout waiting for <sig>");
  assert.equal(normalizeErrorMessage("429 Too Many Requests"), "429 Too Many Requests", "nothing to strip");
});
