// test/codecs.test.ts — hand-written decoders (`src/lib/codecs.ts`) against
// accounts encoded by Anchor's own coder from the IDL (snake_case field
// names — the coder silently zero-fills unknown keys, see onboarding.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { DEXXER_CORE_IDL } from '../src/lib/anchor'
import { decodeUserAccount } from '../src/lib/codecs'

const coder = new BorshAccountsCoder(DEXXER_CORE_IDL)

test('decodeUserAccount reads actions_left (u32) — the session budget set_session hands out', async () => {
  const buf = await coder.encode('UserAccount', {
    version: 2,
    owner: PublicKey.unique(),
    session_key: PublicKey.unique(),
    session_expiry: new BN(1_700_000_000),
    actions_left: 17,
    free_margin: new BN(5),
    locked_margin: new BN(0),
    nonce: new BN(0),
    last_withdraw_slot: new BN(0),
    exit_salt: Array(32).fill(1),
    bump: 255,
    exited: false,
  })
  const d = decodeUserAccount(buf)
  assert.equal(d.actionsLeft, 17)
  assert.equal(d.sessionExpiry, 1_700_000_000n)
  assert.equal(d.freeMargin, 5n)
})
