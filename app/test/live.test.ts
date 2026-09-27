// test/live.test.ts — `subscribeLiveAccount`, the React-free core of
// `useLiveAccount` (`src/lib/live.ts`): push-first, poll-fallback, byte-diffed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey, type AccountInfo } from '@solana/web3.js'
import { subscribeLiveAccount, type LiveAccount } from '../src/lib/live'

type PushCb = (info: AccountInfo<Buffer>) => void

/** Fake `Connection`: `getAccountInfo` serves `current`; `onAccountChange` hands the push callback back to the test. */
function fakeConn(current: () => AccountInfo<Buffer> | null) {
  const pushes: PushCb[] = []
  return {
    conn: {
      getAccountInfo: async () => current(),
      onAccountChange: (_pk: PublicKey, cb: PushCb) => {
        pushes.push(cb)
        return 1
      },
      removeAccountChangeListener: async () => {},
    },
    push: (info: AccountInfo<Buffer>) => pushes.forEach((cb) => cb(info)),
  }
}
const info = (bytes: number[]): AccountInfo<Buffer> => ({
  owner: PublicKey.default,
  data: Buffer.from(bytes),
  lamports: 1,
  executable: false,
})
const settle = () => new Promise((r) => setImmediate(r))

/** A decoder that throws on the byte `0xff` — stands in for a layout the client cannot read. */
function decodeOrThrow(data: Buffer): number {
  if (data[0] === 0xff) throw new Error('unknown layout')
  return data[0]
}

async function start(current: () => AccountInfo<Buffer> | null, decode = decodeOrThrow) {
  const fake = fakeConn(current)
  const states: LiveAccount<number>[] = []
  const stop = subscribeLiveAccount(fake.conn as never, PublicKey.unique(), decode, (s) => states.push(s))
  await settle()
  return { ...fake, states, stop, last: () => states[states.length - 1] }
}

test('a push whose decode throws becomes `error`, keeps the last good value, and never throws out of the callback', async () => {
  const s = await start(() => info([1]))
  try {
    assert.deepEqual(s.last(), { value: 1, missing: false, error: null })
    assert.doesNotThrow(() => s.push(info([0xff])))
    assert.equal(s.last().value, 1, 'last good value survives an undecodable push')
    assert.match(s.last().error ?? '', /unknown layout/)
  } finally {
    s.stop()
  }
})

test('a later push with decodable bytes clears the error', async () => {
  const s = await start(() => info([1]))
  try {
    s.push(info([0xff]))
    s.push(info([2]))
    assert.deepEqual(s.last(), { value: 2, missing: false, error: null })
  } finally {
    s.stop()
  }
})

test('identical bytes are not decoded twice (push diffing, unchanged behaviour)', async () => {
  let decodes = 0
  const s = await start(
    () => info([1]),
    (d) => {
      decodes++
      return decodeOrThrow(d)
    },
  )
  try {
    s.push(info([1]))
    s.push(info([1]))
    assert.equal(decodes, 1)
  } finally {
    s.stop()
  }
})

test('a missing account reports `missing` and clears the value', async () => {
  const s = await start(() => null)
  try {
    assert.deepEqual(s.last(), { value: null, missing: true, error: null })
  } finally {
    s.stop()
  }
})
