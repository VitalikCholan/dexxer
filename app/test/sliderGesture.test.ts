// test/sliderGesture.test.ts — the leverage slider must not move on a vertical page scroll.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sliderIntent } from '../src/ui/sliderGesture'

test('a tap (barely moved) sets the value on release', () => {
  assert.equal(sliderIntent(0, 0), 'tap')
  assert.equal(sliderIntent(3, -2), 'tap')
})
test('a mostly horizontal move drags the slider', () => {
  assert.equal(sliderIntent(30, 5), 'drag')
  assert.equal(sliderIntent(-40, 10), 'drag')
})
test('a mostly vertical move is a page scroll, never a value change', () => {
  assert.equal(sliderIntent(5, 30), 'scroll')
  assert.equal(sliderIntent(20, -120), 'scroll')
  assert.equal(sliderIntent(15, 15), 'scroll')
})
