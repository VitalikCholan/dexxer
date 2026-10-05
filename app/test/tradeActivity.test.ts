// test/tradeActivity.test.ts — what the Trade screen's Positions / Open Orders block shows (`src/features/trade/activity.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityVisible, positionsLink } from '../src/features/trade/activity'

test('activityVisible: only once the private account is ready and its positions are read', () => {
  assert.equal(activityVisible('ready', true), true)
  assert.equal(activityVisible('ready', false), false, 'positions not read yet: no "(0)" that looks real')
  for (const s of ['needs_setup', 'loading', 'no_wallet'] as const) assert.equal(activityVisible(s, true), false, s)
})

test('positionsLink: nothing anywhere — no link', () => {
  assert.equal(positionsLink(0, false), null)
})

test('positionsLink: no position here but others open — points to them', () => {
  assert.equal(positionsLink(1, false), 'Positions on other markets: 1')
  assert.equal(positionsLink(3, false), 'Positions on other markets: 3')
})

test('positionsLink: a position here — manage it, with the total when there are more', () => {
  assert.equal(positionsLink(1, true), 'Manage in Positions')
  assert.equal(positionsLink(4, true), 'Manage all 4 positions')
})
