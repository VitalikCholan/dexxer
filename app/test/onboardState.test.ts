// test/onboardState.test.ts — the onboarding state snapshot and the pure
// decisions derived from it (`src/features/onboard/onboardState.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js'
import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk'
import { DEXXER_CORE_IDL, DEXXER_CORE_PROGRAM_ID } from '../src/lib/anchor'
import {
  eataDelegated,
  isDelegated,
  l1KeysFor,
  l1ProgressFrom,
  needsReuseQueue,
  readL1Snapshot,
  sessionFresh,
  type L1Snapshot,
} from '../src/features/onboard/onboardState'

const coder = new BorshAccountsCoder(DEXXER_CORE_IDL)
function info(owner: PublicKey, data: Buffer = Buffer.alloc(0)): AccountInfo<Buffer> {
  return { owner, data, lamports: 1, executable: false }
}
async function userAccount(owner: PublicKey, exited: boolean): Promise<Buffer> {
  return coder.encode('UserAccount', {
    version: 2,
    owner,
    session_key: PublicKey.default,
    session_expiry: new BN(0),
    actions_left: 20,
    free_margin: new BN(0),
    locked_margin: new BN(0),
    nonce: new BN(0),
    last_withdraw_slot: new BN(0),
    exit_salt: Array(32).fill(1),
    bump: 255,
    exited,
  })
}
const empty = (): L1Snapshot => ({ config: null, faucet: null, ownerAta: null, userAccount: null, eata: null })

// --- readL1Snapshot ---------------------------------------------------------

test('readL1Snapshot reads all five accounts in ONE getMultipleAccountsInfo call, in key order', async () => {
  // On-curve: `getAssociatedTokenAddressSync` rejects an off-curve owner (`PublicKey.unique()` may be one).
  const owner = Keypair.generate().publicKey
  const mint = PublicKey.unique()
  const keys = l1KeysFor(owner, mint)
  const calls: PublicKey[][] = []
  const faucetInfo = info(DEXXER_CORE_PROGRAM_ID)
  const base = {
    getMultipleAccountsInfo: async (pks: PublicKey[]) => {
      calls.push(pks)
      return pks.map((pk) => (pk.equals(keys.faucet) ? faucetInfo : null))
    },
  }
  const snap = await readL1Snapshot(base, keys)
  assert.equal(calls.length, 1)
  assert.deepEqual(
    calls[0].map((k) => k.toBase58()),
    [keys.config, keys.faucet, keys.ownerAta, keys.userAccount, keys.eata].map((k) => k.toBase58()),
  )
  assert.equal(snap.faucet, faucetInfo)
  assert.equal(snap.config, null)
  assert.equal(snap.userAccount, null)
})

// --- l1ProgressFrom (the mount-time gate, formerly useOnboarding's checkL1Progress) ---

test('l1ProgressFrom: no faucet -> NotOnboarded', () => {
  assert.equal(l1ProgressFrom(empty()), 'NotOnboarded')
})
test('l1ProgressFrom: faucet but no UserAccount -> Funded', () => {
  assert.equal(l1ProgressFrom({ ...empty(), faucet: info(DEXXER_CORE_PROGRAM_ID) }), 'Funded')
})
test('l1ProgressFrom: UserAccount owned by dexxer_core -> Initialized', () => {
  assert.equal(
    l1ProgressFrom({ ...empty(), faucet: info(DEXXER_CORE_PROGRAM_ID), userAccount: info(DEXXER_CORE_PROGRAM_ID) }),
    'Initialized',
  )
})
test('l1ProgressFrom: UserAccount under the Delegation Program -> Delegated', () => {
  assert.equal(
    l1ProgressFrom({ ...empty(), faucet: info(DEXXER_CORE_PROGRAM_ID), userAccount: info(DELEGATION_PROGRAM_ID) }),
    'Delegated',
  )
})

// --- per-leg predicates --------------------------------------------------

test('isDelegated is true only for a UserAccount owned by the Delegation Program', () => {
  assert.equal(isDelegated(empty()), false)
  assert.equal(isDelegated({ ...empty(), userAccount: info(DEXXER_CORE_PROGRAM_ID) }), false)
  assert.equal(isDelegated({ ...empty(), userAccount: info(DELEGATION_PROGRAM_ID) }), true)
})

test('needsReuseQueue: an exited, non-delegated UserAccount; never a delegated or missing one', async () => {
  const owner = PublicKey.unique()
  assert.equal(needsReuseQueue(empty()), false)
  assert.equal(
    needsReuseQueue({ ...empty(), userAccount: info(DEXXER_CORE_PROGRAM_ID, await userAccount(owner, false)) }),
    false,
  )
  assert.equal(
    needsReuseQueue({ ...empty(), userAccount: info(DEXXER_CORE_PROGRAM_ID, await userAccount(owner, true)) }),
    true,
  )
  // Delegated accounts are Delegation-Program-owned clones; `exited` is not consulted.
  assert.equal(
    needsReuseQueue({ ...empty(), userAccount: info(DELEGATION_PROGRAM_ID, await userAccount(owner, true)) }),
    false,
  )
})

test('eataDelegated is true only for an eATA under the Delegation Program', () => {
  assert.equal(eataDelegated(empty()), false)
  assert.equal(eataDelegated({ ...empty(), eata: info(PublicKey.unique()) }), false)
  assert.equal(eataDelegated({ ...empty(), eata: info(DELEGATION_PROGRAM_ID) }), true)
})

// --- sessionFresh --------------------------------------------------------

// `set_session` hands out a finite action budget (SESSION_ACTIONS); a key
// that is valid by expiry but (nearly) out of actions must be re-set, or a
// re-authorize run finds "nothing to do" and the user stays stuck.
test('sessionFresh: same key, far expiry, but actions at or below the low-water mark -> stale', () => {
  const key = PublicKey.unique()
  const now = 1_000_000n
  assert.equal(
    sessionFresh({ sessionKey: key, sessionExpiry: now + 86_400n, actionsLeft: 3 }, key, now, 3600n, 3),
    false,
  )
  assert.equal(
    sessionFresh({ sessionKey: key, sessionExpiry: now + 86_400n, actionsLeft: 0 }, key, now, 3600n, 3),
    false,
  )
  assert.equal(
    sessionFresh({ sessionKey: key, sessionExpiry: now + 86_400n, actionsLeft: 4 }, key, now, 3600n, 3),
    true,
  )
})

test('sessionFresh: same key and expiry beyond the renew margin', () => {
  const key = PublicKey.unique()
  const now = 1_000_000n
  assert.equal(sessionFresh({ sessionKey: key, sessionExpiry: now + 7200n, actionsLeft: 20 }, key, now, 3600n, 3), true)
})
test('sessionFresh: same key but expiry inside the renew margin -> stale', () => {
  const key = PublicKey.unique()
  const now = 1_000_000n
  assert.equal(
    sessionFresh({ sessionKey: key, sessionExpiry: now + 1800n, actionsLeft: 20 }, key, now, 3600n, 3),
    false,
  )
})
test('sessionFresh: a different key is never fresh, whatever the expiry', () => {
  const now = 1_000_000n
  assert.equal(
    sessionFresh(
      { sessionKey: PublicKey.unique(), sessionExpiry: now + 86_400n, actionsLeft: 20 },
      PublicKey.unique(),
      now,
      3600n,
      3,
    ),
    false,
  )
})
