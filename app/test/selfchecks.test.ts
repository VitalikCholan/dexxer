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
import { assertLeafGolden } from '../src/lib/hashes'
import { assertIdentityHashSelfCheck } from '../src/lib/mwa/tokenStore'
import {
  assertIsAuthorizationFailureSelfCheck,
  assertIsSessionEstablishmentFailureSelfCheck,
} from '../src/lib/mwa/errors'
import { assertDeriveTicketSelfCheck } from '../src/features/trade/ticketMath'
import { assertLiqDistancePctSelfCheck } from '../src/features/positions/PositionCard'

// --- ports of on-chain math / hashing (golden vectors shared with Rust and tests/er) ---
test('math.ts matches math.rs vectors', () => assertMathSelfCheck())
test('leafHex matches the Rust BalancesRoot golden vector', () => assertLeafGolden())

// --- pure UI/state helpers ---
test('deriveTicket (Trade ticket margin + insufficient gate)', () => assertDeriveTicketSelfCheck())
test('liqDistancePct (Position card)', () => assertLiqDistancePctSelfCheck())

// --- MWA error classification ---
test('identityHash is deterministic and field-sensitive', () => assertIdentityHashSelfCheck())
test('isAuthorizationFailure recognises every documented shape', () => assertIsAuthorizationFailureSelfCheck())
test('isSessionEstablishmentFailure recognises every documented shape', () =>
  assertIsSessionEstablishmentFailureSelfCheck())
