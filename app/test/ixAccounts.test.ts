// test/ixAccounts.test.ts — every instruction the app builds names EXACTLY the
// accounts the IDL declares. anchor-ts silently ignores unknown keys and
// resolves nothing for an untyped Program, so a stale account object only
// fails on a live network otherwise. Extended by Task 4 (trade instructions).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { DEXXER_CORE_IDL, dexxerCoreProgram } from '../src/lib/anchor'
import { baseConn } from '../src/lib/solana'
import { pdas } from '../src/lib/pdas'

const idl = DEXXER_CORE_IDL as unknown as { instructions: { name: string; accounts: { name: string }[] }[] }
const coder = new BorshInstructionCoder(DEXXER_CORE_IDL)
export function idlAccountCount(ix: string): number {
  const def = idl.instructions.find((i) => i.name === ix)
  assert.ok(def, `IDL has ${ix}`)
  return def!.accounts.length
}
const PROGRAM_ID = new PublicKey((DEXXER_CORE_IDL as unknown as { address: string }).address)
/** IDL instruction name -> IDL account name (snake_case) -> the key the instruction must carry there. */
export type ExpectedKeys = Record<string, Record<string, PublicKey>>

/**
 * Every `dexxer_core` instruction of `tx` carries, at EVERY index, exactly the
 * key `expected[ix][idlAccountName]` — and nothing else. Counting keys proves
 * nothing: almost all accounts of these instructions carry `pda`/`address` in
 * the IDL, so anchor-ts auto-resolves a missing key and silently drops unknown
 * ones (a stale object still builds the full account count, and a wrong key
 * still builds). A missing `expected` entry fails too, so a new IDL account
 * cannot slip through unnoticed. Task 4 extends `expected` with trade ixs.
 */
export function assertIxKeysMatchIdl(tx: Transaction, expected: ExpectedKeys): void {
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(PROGRAM_ID)) continue
    const name = coder.decode(ix.data)?.name
    assert.ok(name, 'unknown dexxer_core instruction')
    const def = idl.instructions.find((i) => i.name === name)
    assert.ok(def, `IDL has ${name}`)
    assert.equal(ix.keys.length, def!.accounts.length, `${name}: keys vs IDL accounts`)
    const exp = expected[name!]
    assert.ok(exp, `${name}: no expected keys given`)
    def!.accounts.forEach((acc, i) => {
      const want = exp[acc.name]
      assert.ok(want, `${name}[${i}] ${acc.name}: no expected key given`)
      assert.ok(
        ix.keys[i].pubkey.equals(want),
        `${name}[${i}] ${acc.name}: got ${ix.keys[i].pubkey.toBase58()}, want ${want.toBase58()}`,
      )
    })
  }
}

test('assertIxKeysMatchIdl fails on a wrong key and on a missing expected entry (real anchor-built init_user)', async () => {
  const core = dexxerCoreProgram(baseConn, Keypair.generate().publicKey)
  const owner = Keypair.generate().publicKey
  const payer = PublicKey.unique()
  const config = pdas.config()
  const userAccount = pdas.userAccount(owner)
  const positions = pdas.positions(owner)
  const exp: ExpectedKeys = {
    init_user: {
      owner,
      payer,
      config,
      user_account: userAccount,
      positions,
      system_program: SystemProgram.programId,
    },
  }
  const build = async (pos: PublicKey) =>
    new Transaction().add(
      await core.methods
        .initUser(Array(32).fill(0))
        .accounts({ owner, payer, config, userAccount, positions: pos, systemProgram: SystemProgram.programId })
        .instruction(),
    )
  assertIxKeysMatchIdl(await build(positions), exp)
  // (a) wrong pubkey at one index: still 6 keys, count alone would pass
  const bad = await build(PublicKey.unique())
  assert.equal(bad.instructions[0].keys.length, 6)
  assert.throws(() => assertIxKeysMatchIdl(bad, exp), /init_user\[4\] positions/)
  // (b) missing expected entry
  const { positions: _omit, ...rest } = exp.init_user
  void _omit
  assert.throws(() => assertIxKeysMatchIdl(bad, { init_user: rest }), /positions: no expected key/)
  assert.throws(() => assertIxKeysMatchIdl(bad, {}), /no expected keys/)
})
