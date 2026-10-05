// test/status.test.ts — `formatSessionLeft` with the session's remaining action budget.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOW_SESSION_ACTIONS,
  formatDusdc,
  formatSessionLeft,
  formatSignedDusdc,
  sessionLowWarning,
} from '../src/lib/status'

const now = 1_000_000
test('formatSessionLeft without actions is unchanged', () => {
  assert.equal(formatSessionLeft(now + 7200, now), 'Session active · 2h left')
})
test('formatSessionLeft never shows the action count: only time while the session is usable', () => {
  assert.equal(formatSessionLeft(now + 7200, now, 20), 'Session active · 2h left')
  assert.equal(formatSessionLeft(now + 7200, now, 1), 'Session active · 2h left')
})
test('sessionLowWarning: silent above the threshold, a trades-left warning at or below it', () => {
  assert.equal(LOW_SESSION_ACTIONS, 3)
  assert.equal(sessionLowWarning(20), null)
  assert.equal(sessionLowWarning(4), null)
  assert.equal(sessionLowWarning(3), '3 trades left — re-authorize soon')
  assert.equal(sessionLowWarning(1), '1 trade left — re-authorize soon')
  assert.equal(sessionLowWarning(0), null, '0 is "Session used up", a block, not a warning')
  assert.equal(sessionLowWarning(undefined), null)
  assert.equal(sessionLowWarning(null), null)
})
test('a session with no actions left is used up even before it expires', () => {
  assert.equal(formatSessionLeft(now + 7200, now, 0), 'Session used up')
})
test('expired / no session read the same regardless of actions', () => {
  assert.equal(formatSessionLeft(now - 1, now, 5), 'Session expired')
  assert.equal(formatSessionLeft(0, now, 5), 'No session')
})

test('collateral amounts read as dUSDC, not $', () => {
  assert.equal(formatDusdc(20_000_000n), '20.00 dUSDC')
  assert.equal(formatDusdc(0n), '0.00 dUSDC')
})
test('signed amounts put the sign before the number (U+2212 for negatives)', () => {
  assert.equal(formatSignedDusdc(770_000n), '+0.77 dUSDC')
  assert.equal(formatSignedDusdc(-1_200_000n), '\u22121.20 dUSDC')
  assert.equal(formatSignedDusdc(0n), '+0.00 dUSDC')
})
