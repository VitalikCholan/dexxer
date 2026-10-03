// test/errors.test.ts — program error codes -> user-facing messages.
//
// The IDL (`idl/dexxer_core.json`, CI-verified identical to `anchor
// build`'s output) is the source of truth for which error codes exist.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEXXER_CORE_IDL } from '../src/lib/anchor'
import { DEXXER_ERROR_MESSAGES, describeTxError } from '../src/lib/errors'
import { errText } from '../src/features/onboard/batchOnboarding'

interface IdlError {
  code: number
  name: string
  msg: string
}
const idlErrors = (DEXXER_CORE_IDL as unknown as { errors: IdlError[] }).errors
const byName = (name: string): IdlError => {
  const e = idlErrors.find((x) => x.name === name)
  if (!e) throw new Error(`IDL has no error named ${name}`)
  return e
}
/** The shape web3.js/Anchor put a custom program error into a thrown message. */
const thrown = (code: number) =>
  new Error(`Transaction simulation failed: custom program error: 0x${code.toString(16)}`)

test('every error code the IDL declares has a message', () => {
  const missing = idlErrors.filter((e) => DEXXER_ERROR_MESSAGES[e.code] === undefined).map((e) => `${e.code} ${e.name}`)
  assert.deepEqual(missing, [])
})

test('no message is kept for a code the IDL no longer declares', () => {
  const declared = new Set(idlErrors.map((e) => e.code))
  const stale = Object.keys(DEXXER_ERROR_MESSAGES)
    .map(Number)
    .filter((code) => !declared.has(code))
  assert.deepEqual(stale, [])
})

test('describeTxError names an exit-flow error instead of echoing the raw code', () => {
  const e = byName('BalanceNotZero')
  const out = describeTxError(thrown(e.code))
  assert.doesNotMatch(out, /custom program error/)
  assert.match(out, new RegExp(`\\(${e.code}\\)$`))
})

test('errText (onboarding) maps program error codes the same way describeTxError does', () => {
  // 6022 is already in the hand-written map, so this isolates errText's own
  // behaviour from the coverage gap the first test is about.
  const e = byName('HasOpenPosition')
  assert.equal(errText(thrown(e.code)), describeTxError(thrown(e.code)))
})

test('the slot-ceiling and liquidatable-increase codes have human messages', () => {
  assert.match(DEXXER_ERROR_MESSAGES[6049], /slot/)
  assert.match(DEXXER_ERROR_MESSAGES[6050], /liquidation/)
  assert.match(DEXXER_ERROR_MESSAGES[6046], /exited/)
})
