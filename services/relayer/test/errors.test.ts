// Final review m2/m5/m6 + fix round 2 (R1): one production classifier with
// three classes, exercised with the real error strings the relayer sees
// (confirmSignature, web3.js fetch, RPC, our own freshBlockhash).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyError, isSharedError, looksLikeAuthError, looksLikeOnChainFailure, normalizeErrorMessage, shouldReconnectOnDiscoveryError } from "../src/errors.js";

const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const ON_CHAIN = new Error(`transaction ${SIG} failed: {"InstructionError":[1,{"Custom":3002}]}`);
const CONFIRM_TIMEOUT = new Error(`confirmSignature timeout waiting for ${SIG}`);
const RATE = new Error("429 Too Many Requests");
const RATE_JSON = new Error('failed to get recent blockhash: {"code":429,"message":"rate limit exceeded"}');
const FETCH = new TypeError("fetch failed");
const UNAUTH = new Error('401 Unauthorized: {"error":"invalid token"}');
const BAD_GATEWAY = new Error("502 Bad Gateway");
const UNAVAILABLE = new Error("503 Service Unavailable:  ");
const ECONNRESET = new Error("request to https://devnet-tee.magicblock.app/ failed, reason: read ECONNRESET");
const ETIMEDOUT = new Error("connect ETIMEDOUT 1.2.3.4:443");
const HANGUP = new Error("socket hang up");
const BLOCKHASH = new Error("freshBlockhash timeout: no new blockhash within 5000 ms");
const BUILD = new Error("Invalid arguments: feed not provided.");
const TOO_LARGE = new Error("Transaction too large: 1300 > 1232");
const NOT_FOUND = new Error("Blockhash not found");

test("classifyError: on-chain — the transaction landed and the program rejected it", () => {
  assert.equal(classifyError(ON_CHAIN), "on-chain");
  assert.equal(looksLikeOnChainFailure(ON_CHAIN), true);
});

test("classifyError: shared — auth, network, 429/rate limit, 5xx, freshBlockhash timeout (plausibly every market)", () => {
  for (const e of [UNAUTH, FETCH, ECONNRESET, ETIMEDOUT, HANGUP, RATE, RATE_JSON, BAD_GATEWAY, UNAVAILABLE, BLOCKHASH]) {
    assert.equal(classifyError(e), "shared", String(e));
    assert.equal(isSharedError(e), true, String(e));
  }
  assert.equal(classifyError("fetch failed"), "shared", "a thrown string is classified too");
});

test("classifyError: market-local — everything else, INCLUDING a confirm timeout (one market's dropped tx)", () => {
  for (const e of [CONFIRM_TIMEOUT, BUILD, TOO_LARGE, NOT_FOUND]) {
    assert.equal(classifyError(e), "market-local", String(e));
    assert.equal(isSharedError(e), false, String(e));
  }
});

test("an on-chain error whose program data happens to contain 429/5xx digits stays on-chain", () => {
  assert.equal(classifyError(new Error(`transaction ${SIG} failed: {"InstructionError":[0,{"Custom":503}]}`)), "on-chain");
});

test("shouldReconnectOnDiscoveryError: auth or network only (not 429/5xx, not market-local)", () => {
  for (const e of [UNAUTH, FETCH, ECONNRESET, ETIMEDOUT, HANGUP]) assert.equal(shouldReconnectOnDiscoveryError(e), true, String(e));
  for (const e of [RATE, BAD_GATEWAY, BUILD, CONFIRM_TIMEOUT, ON_CHAIN]) assert.equal(shouldReconnectOnDiscoveryError(e), false, String(e));
});

test("looksLikeAuthError: a 401 / unauthorized only", () => {
  assert.equal(looksLikeAuthError(UNAUTH), true);
  assert.equal(looksLikeAuthError(new Error("Unauthorized")), true);
  for (const e of [ON_CHAIN, CONFIRM_TIMEOUT, RATE, FETCH, BAD_GATEWAY]) assert.equal(looksLikeAuthError(e), false, String(e));
});

test("normalizeErrorMessage strips the signature so one failure repeated with new signatures dedupes (m5)", () => {
  const other = `transaction 3xYz9abc failed: {"InstructionError":[1,{"Custom":3002}]}`;
  assert.equal(normalizeErrorMessage(ON_CHAIN.message), normalizeErrorMessage(other));
  assert.equal(normalizeErrorMessage(ON_CHAIN.message), 'transaction <sig> failed: {"InstructionError":[1,{"Custom":3002}]}');
  assert.equal(normalizeErrorMessage(CONFIRM_TIMEOUT.message), "confirmSignature timeout waiting for <sig>");
  assert.equal(normalizeErrorMessage("429 Too Many Requests"), "429 Too Many Requests", "nothing to strip");
});
