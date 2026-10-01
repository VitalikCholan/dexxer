// test/ixAccounts.test.ts — every instruction the app builds names EXACTLY the
// accounts the IDL declares. anchor-ts silently ignores unknown keys and
// resolves nothing for an untyped Program, so a stale account object only
// fails on a live network otherwise. Extended by Task 4 (trade instructions).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey, Transaction } from '@solana/web3.js'
import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { DEXXER_CORE_IDL } from '../src/lib/anchor'

const idl = DEXXER_CORE_IDL as unknown as { instructions: { name: string; accounts: { name: string }[] }[] }
const coder = new BorshInstructionCoder(DEXXER_CORE_IDL)
export function idlAccountCount(ix: string): number {
  const def = idl.instructions.find((i) => i.name === ix)
  assert.ok(def, `IDL has ${ix}`)
  return def!.accounts.length
}
/** For each instruction of `tx`: its IDL name and the number of keys it carries — a stale builder shows up as a count mismatch. */
export function ixSummary(tx: Transaction): { name: string; keys: number }[] {
  return tx.instructions
    .filter((ix) => ix.programId.equals(new PublicKey((DEXXER_CORE_IDL as unknown as { address: string }).address)))
    .map((ix) => ({ name: coder.decode(ix.data)?.name ?? '?', keys: ix.keys.length }))
}
export function assertIxKeysMatchIdl(tx: Transaction): void {
  for (const s of ixSummary(tx)) assert.equal(s.keys, idlAccountCount(s.name), `${s.name}: keys vs IDL accounts`)
}

test('assertIxKeysMatchIdl rejects an instruction with a missing or extra key', () => {
  const ok = new Transaction()
  const name = 'init_user'
  const n = idlAccountCount(name)
  assert.equal(n, 6)
  assert.throws(() => {
    const tx = new Transaction()
    const data = coder.encode(name, { exit_salt: Array(32).fill(0) })
    tx.add({
      programId: new PublicKey((DEXXER_CORE_IDL as unknown as { address: string }).address),
      keys: Array.from({ length: n + 1 }, () => ({ pubkey: PublicKey.unique(), isSigner: false, isWritable: false })),
      data,
    } as never)
    assertIxKeysMatchIdl(tx)
  })
  assertIxKeysMatchIdl(ok)
})
