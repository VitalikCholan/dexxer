// test/orders.test.ts — `src/lib/orders.ts` mirrors `state/order.rs`'s trigger rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeOrder,
  isTriggered,
  trailingStopPrice,
  validateAttached,
  validateExit,
  validateTrail,
} from '../src/lib/orders'
import type { DecodedOrder } from '../src/lib/codecs'

const $ = (n: number) => BigInt(Math.round(n * 1e6))

test('trigger directions match the program', () => {
  assert.equal(isTriggered('Limit', 'Long', $(100), $(99)), true)
  assert.equal(isTriggered('Limit', 'Long', $(100), $(101)), false)
  assert.equal(isTriggered('Stop', 'Long', $(100), $(101)), true)
  assert.equal(isTriggered('Stop', 'Short', $(100), $(99)), true)
  assert.equal(isTriggered('TakeProfit', 'Long', $(110), $(110)), true)
  assert.equal(isTriggered('StopLoss', 'Long', $(90), $(91)), false)
  assert.equal(isTriggered('StopLoss', 'Short', $(110), $(110)), true)
  assert.equal(isTriggered('None', 'Long', 0n, 0n), false)
})

test('trailing stop rounds like the program (long floors, short ceils)', () => {
  assert.equal(trailingStopPrice('Long', 200n, 500), 190n)
  assert.equal(trailingStopPrice('Short', 200n, 500), 210n)
  assert.equal(trailingStopPrice('Long', 101n, 500), 95n)
  assert.equal(trailingStopPrice('Short', 101n, 500), 107n)
})

test('validateExit refuses a trigger already past the mark', () => {
  assert.equal(validateExit('TakeProfit', 'Long', $(160), $(150)), null)
  assert.match(validateExit('TakeProfit', 'Long', $(140), $(150)) ?? '', /above/)
  assert.match(validateExit('StopLoss', 'Long', $(160), $(150)) ?? '', /below/)
  assert.match(validateExit('StopLoss', 'Short', $(140), $(150)) ?? '', /above/)
  assert.match(validateExit('TakeProfit', 'Short', $(160), $(150)) ?? '', /below/)
  assert.equal(validateExit('StopLoss', 'Long', $(140), null), null)
  assert.ok(validateExit('StopLoss', 'Long', 0n, $(150)))
})

test('validateAttached keeps TP/SL on the right side of the entry', () => {
  assert.equal(validateAttached('Long', $(150), $(160), $(140)), null)
  assert.equal(validateAttached('Long', $(150), 0n, 0n), null)
  assert.ok(validateAttached('Long', $(150), $(140), 0n))
  assert.ok(validateAttached('Long', $(150), 0n, $(160)))
  assert.equal(validateAttached('Short', $(150), $(140), $(160)), null)
  assert.ok(validateAttached('Short', $(150), $(160), 0n))
})

test('validateTrail bounds', () => {
  assert.equal(validateTrail(10), null)
  assert.equal(validateTrail(5000), null)
  assert.ok(validateTrail(9))
  assert.ok(validateTrail(5001))
  assert.ok(validateTrail(1.5))
})

test('describeOrder', () => {
  const base: DecodedOrder = {
    slot: 0,
    kind: 'TakeProfit',
    side: 'Long',
    trigger: $(160),
    size: 0n,
    margin: 0n,
    trailBps: 0,
    extreme: 0n,
    tp: 0n,
    sl: 0n,
  }
  assert.deepEqual(describeOrder(base), { title: 'Take profit', detail: 'at $160.00' })
  assert.equal(
    describeOrder({ ...base, kind: 'TrailingStop', trailBps: 250, extreme: $(200) }).title,
    'Trailing stop 2.5%',
  )
  const entry = describeOrder({ ...base, kind: 'Limit', trigger: $(140), size: 2_000_000_000n, tp: $(150), sl: $(130) })
  assert.equal(entry.title, 'Limit buy 2.0000 SOL')
  assert.equal(entry.detail, 'at $140.00 · TP $150.00 · SL $130.00')
})
