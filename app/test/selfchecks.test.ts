// test/selfchecks.test.ts — runs the `assert*SelfCheck` functions the app
// already carried as `if (__DEV__)` startup checks.
//
// On-device those blocks wrap each check in `try/catch` + `console.error`,
// so a mismatch between e.g. `math.ts` and `math.rs` was a log line nobody
// reads, not a failure. Here each one runs bare: a throw is a red test.
// `test/setup.ts` sets `__DEV__ = false` so the startup blocks stay silent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertMathSelfCheck } from '../src/lib/math'
import { assertCommitmentGolden, assertLeafGolden } from '../src/lib/hashes'
import { assertDisclosureStatusSelfCheck } from '../src/lib/status'
import { assertIdentityHashSelfCheck } from '../src/lib/mwa/tokenStore'
import {
  assertIsAuthorizationFailureSelfCheck,
  assertIsSessionEstablishmentFailureSelfCheck,
} from '../src/lib/mwa/errors'
import { assertDeriveTicketSelfCheck } from '../src/features/trade/TradeTicket'
import { assertLiqDistancePctSelfCheck } from '../src/features/positions/PositionCard'
import { assertHistoryMergeSelfCheck, chunk, MAX_ACCOUNTS_PER_RPC } from '../src/features/history/useHistoryRows'

// --- ports of on-chain math / hashing (golden vectors shared with Rust and tests/er) ---
test('math.ts matches math.rs vectors', () => assertMathSelfCheck())
test('leafHex matches the Rust BalancesRoot golden vector', () => assertLeafGolden())
test('commitmentHash matches the Rust disclosure golden vector', () => assertCommitmentGolden())

// --- pure UI/state helpers ---
test('disclosureStatus / formatSlotsAsTime / formatUsd2', () => assertDisclosureStatusSelfCheck())
test('deriveTicket (Trade ticket margin + insufficient gate)', () => assertDeriveTicketSelfCheck())
test('liqDistancePct (Position card)', () => assertLiqDistancePctSelfCheck())
test('mergeHistoryRows dedupes one trade seen in both sources', () => assertHistoryMergeSelfCheck())

// --- MWA error classification ---
test('identityHash is deterministic and field-sensitive', () => assertIdentityHashSelfCheck())
test('isAuthorizationFailure recognises every documented shape', () => assertIsAuthorizationFailureSelfCheck())
test('isSessionEstablishmentFailure recognises every documented shape', () =>
  assertIsSessionEstablishmentFailureSelfCheck())

// --- chunk (History's ≤100-keys-per-RPC batching) ---
test('chunk splits into slices of at most `size`, last one shorter', () => {
  const items = Array.from({ length: 250 }, (_, i) => i)
  const out = chunk(items, MAX_ACCOUNTS_PER_RPC)
  assert.deepEqual(
    out.map((c) => c.length),
    [100, 100, 50],
  )
  assert.deepEqual(out.flat(), items)
})
test('chunk of an empty list is an empty list', () => {
  assert.deepEqual(chunk([], MAX_ACCOUNTS_PER_RPC), [])
})
test('chunk rejects a non-positive size', () => {
  assert.throws(() => chunk([1], 0), /size must be positive/)
})
