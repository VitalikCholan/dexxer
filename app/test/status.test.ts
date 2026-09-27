// test/status.test.ts — `formatSessionLeft` with the session's remaining action budget.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatSessionLeft } from '../src/lib/status'

const now = 1_000_000
test('formatSessionLeft without actions is unchanged', () => {
  assert.equal(formatSessionLeft(now + 7200, now), 'Session active · 2h left')
})
test('formatSessionLeft appends the remaining actions', () => {
  assert.equal(formatSessionLeft(now + 7200, now, 5), 'Session active · 2h left · 5 actions')
  assert.equal(formatSessionLeft(now + 7200, now, 1), 'Session active · 2h left · 1 action')
})
test('a session with no actions left is used up even before it expires', () => {
  assert.equal(formatSessionLeft(now + 7200, now, 0), 'Session used up')
})
test('expired / no session read the same regardless of actions', () => {
  assert.equal(formatSessionLeft(now - 1, now, 5), 'Session expired')
  assert.equal(formatSessionLeft(0, now, 5), 'No session')
})
