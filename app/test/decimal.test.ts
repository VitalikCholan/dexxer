// test/decimal.test.ts — `src/lib/decimal.ts`: numbers typed into order fields.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount, parseDecimal } from '../src/lib/decimal'

test('parseDecimal accepts a dot or a comma as the separator', () => {
  assert.equal(parseDecimal('125.5'), 125.5)
  assert.equal(parseDecimal('125,5'), 125.5)
  assert.equal(parseDecimal(' 0,5 '), 0.5)
  assert.equal(parseDecimal('.5'), 0.5)
  assert.equal(parseDecimal('3.'), 3)
  assert.equal(parseDecimal('0'), 0)
})

test('parseDecimal rejects everything that is not one plain decimal', () => {
  for (const bad of ['', ' ', 'abc', '1.2.3', '1,2,3', '1,000.5', '-1', '1e3', '0x10', '.', ',', 'Infinity', 'NaN']) {
    assert.equal(parseDecimal(bad), null, JSON.stringify(bad))
  }
})

test('parseAmount: an empty optional field is "not set", never an error', () => {
  assert.deepEqual(parseAmount(''), { value: 0, invalid: false })
  assert.deepEqual(parseAmount('  '), { value: 0, invalid: false })
})

test('parseAmount: a filled field is a positive number or an error — never a silent zero', () => {
  assert.deepEqual(parseAmount('0,5'), { value: 0.5, invalid: false })
  assert.deepEqual(parseAmount('125,5'), { value: 125.5, invalid: false })
  // These used to read as 0, i.e. as "field left empty": a typed part became
  // a whole-position order, a typed stop-limit bound became no bound.
  assert.deepEqual(parseAmount('0'), { value: 0, invalid: true })
  assert.deepEqual(parseAmount('1.2.3'), { value: 0, invalid: true })
  assert.deepEqual(parseAmount('abc'), { value: 0, invalid: true })
})
