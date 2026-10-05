// test/sessionEvents.test.ts — screens learn that a session key was saved after they mounted (`src/lib/sessionEvents.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notifySessionKeySaved, onSessionKeySaved } from '../src/lib/sessionEvents'

test('a subscriber hears the owner whose session key was saved', () => {
  const heard: string[] = []
  const off = onSessionKeySaved((owner) => heard.push(owner))
  notifySessionKeySaved('A3xa')
  notifySessionKeySaved('B3BY')
  off()
  assert.deepEqual(heard, ['A3xa', 'B3BY'])
})

test('after unsubscribing nothing is heard, and other subscribers still are', () => {
  const a: string[] = []
  const b: string[] = []
  const offA = onSessionKeySaved((o) => a.push(o))
  const offB = onSessionKeySaved((o) => b.push(o))
  offA()
  notifySessionKeySaved('X')
  offB()
  assert.deepEqual(a, [])
  assert.deepEqual(b, ['X'])
})
