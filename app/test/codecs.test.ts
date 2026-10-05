// test/codecs.test.ts — hand-written decoders (`src/lib/codecs.ts`) against
// accounts encoded by Anchor's own coder from the IDL (snake_case field
// names — the coder silently zero-fills unknown keys, see onboarding.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { DEXXER_CORE_IDL } from '../src/lib/anchor'
import { symbolString } from '../src/lib/pdas'
import { decodeUserAccount, readConfigDusdcMint, readConfigFeePayer, readConfigOracleProgram } from '../src/lib/codecs'

const coder = new BorshAccountsCoder(DEXXER_CORE_IDL)

test('decodeUserAccount reads actions_left (u32) — the session budget set_session hands out', async () => {
  const rentPayer = PublicKey.unique()
  const buf = await coder.encode('UserAccount', {
    version: 3,
    owner: PublicKey.unique(),
    session_key: PublicKey.unique(),
    session_expiry: new BN(1_700_000_000),
    actions_left: 17,
    free_margin: new BN(5),
    locked_margin: new BN(0),
    last_withdraw_slot: new BN(0),
    exit_salt: Array(32).fill(1),
    bump: 255,
    exited: true,
    rent_payer: rentPayer,
    order_reserved: new BN(123_456_789),
    _reserved: Array(24).fill(0),
  })
  const d = decodeUserAccount(buf)
  assert.equal(d.actionsLeft, 17)
  assert.equal(d.sessionExpiry, 1_700_000_000n)
  assert.equal(d.freeMargin, 5n)
  assert.equal(d.exited, true)
  assert.equal(d.rentPayer.toBase58(), rentPayer.toBase58())
  assert.equal(d.orderReserved, 123_456_789n, 'margin held by pending entry orders')
})

test('Config readers hit dusdc_mint, oracle_program and fee_payer (not magic_fee_vault)', async () => {
  const [oracle, dusdc, feePayer, vault] = [
    PublicKey.unique(),
    PublicKey.unique(),
    PublicKey.unique(),
    PublicKey.unique(),
  ]
  const buf = await coder.encode('Config', {
    version: 1,
    admin: PublicKey.unique(),
    crank: PublicKey.unique(),
    paused: false,
    oracle_program: oracle,
    tee_validator: PublicKey.unique(),
    dusdc_mint: dusdc,
    scheduler_signer: PublicKey.unique(),
    fee_payer: feePayer,
    magic_fee_vault: vault,
    crank_task_id: new BN(-1),
    bump: 255,
  })
  assert.equal(readConfigDusdcMint(buf).toBase58(), dusdc.toBase58())
  assert.equal(readConfigOracleProgram(buf).toBase58(), oracle.toBase58())
  assert.equal(readConfigFeePayer(buf).toBase58(), feePayer.toBase58())
})

// Hermes regression (plan 4 smoke, 01.10.2026): on the device `Buffer.subarray()`
// returns a plain Uint8Array whose `toString()` is "83,79,76,…", so the symbol
// must be decoded byte by byte. Feed a plain Uint8Array (not a Buffer) so the
// test cannot pass through Node's Buffer.toString by accident.
test('symbolString decodes a NUL-padded ASCII symbol from a plain Uint8Array', () => {
  assert.equal(symbolString(new Uint8Array([83, 79, 76, 0, 0, 0, 0, 0])), 'SOL')
  assert.equal(symbolString(new Uint8Array([72, 89, 80, 69, 0, 0, 0, 0])), 'HYPE')
  assert.equal(symbolString(new Uint8Array([65, 66, 67, 68, 69, 70, 71, 72])), 'ABCDEFGH')
  assert.equal(symbolString(new Uint8Array(8)), '')
})
