// test/confirm.test.ts — `confirmOnConn` (`src/lib/confirm.ts`): the
// getSignatureStatuses poll both `trade.ts` and `batchOnboarding.ts` use
// instead of `Connection.confirmTransaction` (see the module header).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmOnConn } from '../src/lib/confirm'

type Status = { err: unknown; confirmationStatus?: string } | null
function conn(seq: Status[]) {
  let i = 0
  return {
    calls: () => i,
    getSignatureStatuses: async () => ({ value: [seq[Math.min(i++, seq.length - 1)]] }),
  }
}

test('resolves once the signature is confirmed', async () => {
  const c = conn([null, null, { err: null, confirmationStatus: 'confirmed' }])
  await confirmOnConn(c as never, 'sig', 10, 1)
  assert.equal(c.calls(), 3)
})

test('finalized counts as confirmed', async () => {
  await confirmOnConn(conn([{ err: null, confirmationStatus: 'finalized' }]) as never, 'sig', 10, 1)
})

test('a status carrying err rejects with the error, without waiting out the tries', async () => {
  const c = conn([{ err: { InstructionError: [0, 'Custom'] } }])
  await assert.rejects(() => confirmOnConn(c as never, 'sig', 10, 1), /tx sig failed: .*InstructionError/)
  assert.equal(c.calls(), 1)
})

test('never confirmed within `tries` rejects with a confirm timeout', async () => {
  const c = conn([null])
  await assert.rejects(() => confirmOnConn(c as never, 'sig', 3, 1), /confirm timeout waiting for sig/)
  assert.equal(c.calls(), 3)
})
