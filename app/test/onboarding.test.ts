// test/onboarding.test.ts — characterization tests for `collectBatchLegs`.
//
// Pins what the batched onboarding collector emits for each on-chain state
// it can find an owner in, so the week-6 restructuring (state snapshot +
// declarative leg specs) can be checked for behaviour preservation without
// a devnet run. Chain state is faked at the `Connection` level: `baseConn`
// (module singleton, `src/lib/solana.ts`) has its read methods replaced per
// test and restored after; the owner's TEE connection comes in through
// `mwa.getConnection`, so it is a plain fake.
//
// Account fixtures are encoded by Anchor's own `BorshAccountsCoder` from
// the IDL. NOTE: it takes the IDL's snake_case field names and SILENTLY
// encodes zeros for any key it does not recognise (a camelCase `sessionKey`
// yields an all-zero session key, no error) — `encodeAccount` below guards
// against that by rejecting unknown keys.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import { Keypair, PublicKey, SystemProgram, Transaction, type AccountInfo, type Connection, type TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  DELEGATION_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  deriveEphemeralAta,
  permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk'
import { baseConn } from '../src/lib/solana'
import { DEXXER_CORE_IDL, DEXXER_CORE_PROGRAM_ID } from '../src/lib/anchor'
import { pdas } from '../src/lib/pdas'
import { assertIxKeysMatchIdl } from './ixAccounts.test'
import { l1KeysFor, l1ProgressFrom, readL1Snapshot } from '../src/features/onboard/onboardState'
import type { NonceInfo } from '../src/lib/nonce'
import {
  collectBatchLegs,
  SESSION_EXPIRY_SECS,
  type BatchLeg,
  type OnboardCtx,
} from '../src/features/onboard/batchOnboarding'

// --- fixtures -------------------------------------------------------------

const coder = new BorshAccountsCoder(DEXXER_CORE_IDL)
type IdlType = { name: string; type: { kind: string; fields?: { name: string }[] } }

/** Anchor-encode an account from snake_case IDL field names; throws on a key the IDL does not declare (see file header). */
async function encodeAccount(name: string, fields: Record<string, unknown>): Promise<Buffer> {
  const t = (DEXXER_CORE_IDL as unknown as { types: IdlType[] }).types.find((x) => x.name === name)
  if (!t?.type.fields) throw new Error(`IDL has no struct type ${name}`)
  const declared = new Set(t.type.fields.map((f) => f.name))
  for (const k of Object.keys(fields))
    if (!declared.has(k)) throw new Error(`${name}: unknown field ${k} (IDL uses snake_case)`)
  for (const k of declared) if (!(k in fields)) throw new Error(`${name}: missing field ${k}`)
  return coder.encode(name, fields)
}

function info(owner: PublicKey, data: Buffer = Buffer.alloc(0)): AccountInfo<Buffer> {
  return { owner, data, lamports: 1, executable: false }
}

async function userAccountData(o: {
  owner: PublicKey
  sessionKey?: PublicKey
  sessionExpiry?: number
  exited?: boolean
  actionsLeft?: number
}) {
  return encodeAccount('UserAccount', {
    version: 3,
    owner: o.owner,
    session_key: o.sessionKey ?? PublicKey.default,
    session_expiry: new BN(o.sessionExpiry ?? 0),
    actions_left: o.actionsLeft ?? 20,
    free_margin: new BN(0),
    locked_margin: new BN(0),
    last_withdraw_slot: new BN(0),
    exit_salt: Array(32).fill(1),
    bump: 255,
    exited: o.exited ?? false,
    rent_payer: PublicKey.default,
    _reserved: Array(32).fill(0),
  })
}

/** A `Connection`-shaped fake over a pubkey -> AccountInfo map; unknown keys read as missing. */
function fakeConn(accounts: Map<string, AccountInfo<Buffer>>) {
  return {
    getAccountInfo: async (pk: PublicKey) => accounts.get(pk.toBase58()) ?? null,
    getMultipleAccountsInfo: async (pks: PublicKey[]) => pks.map((pk) => accounts.get(pk.toBase58()) ?? null),
  }
}

const originalBase = {
  getAccountInfo: baseConn.getAccountInfo,
  getMultipleAccountsInfo: baseConn.getMultipleAccountsInfo,
}
function installBase(accounts: Map<string, AccountInfo<Buffer>>) {
  const f = fakeConn(accounts)
  ;(baseConn as { getAccountInfo: unknown }).getAccountInfo = f.getAccountInfo
  ;(baseConn as { getMultipleAccountsInfo: unknown }).getMultipleAccountsInfo = f.getMultipleAccountsInfo
}
afterEach(() => {
  ;(baseConn as { getAccountInfo: unknown }).getAccountInfo = originalBase.getAccountInfo
  ;(baseConn as { getMultipleAccountsInfo: unknown }).getMultipleAccountsInfo = originalBase.getMultipleAccountsInfo
})

const MINT = PublicKey.unique()
const FEE_PAYER = PublicKey.unique()

function makeCtx(): OnboardCtx {
  const owner = Keypair.generate().publicKey
  const market = pdas.market()
  return {
    owner,
    config: pdas.config(),
    mint: MINT,
    market,
    userAccount: pdas.userAccount(owner),
    positions: pdas.positions(owner),
    faucetPda: pdas.faucet(owner),
    mintAuth: pdas.mintAuth(),
    pool: pdas.pool(MINT),
    poolLive: pdas.poolLive(MINT),
    poolAta: pdas.poolAta(MINT),
    ownerAta: getAssociatedTokenAddressSync(MINT, owner),
    session: Keypair.generate(),
    exitSalt: new Uint8Array(32).fill(7),
  }
}

const NONCES: NonceInfo[] = [0, 1, 2].map((slot) => ({
  slot: slot as 0 | 1 | 2,
  account: PublicKey.unique(),
  value: `nonce-${slot}`,
}))

function ixName(ix: TransactionInstruction): string {
  if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return 'ata:create'
  if (!ix.programId.equals(DEXXER_CORE_PROGRAM_ID)) return `other:${ix.programId.toBase58().slice(0, 4)}`
  const disc = ix.data.subarray(0, 8)
  const hit = (
    DEXXER_CORE_IDL as unknown as { instructions: { name: string; discriminator: number[] }[] }
  ).instructions.find((i) => Buffer.from(i.discriminator).equals(disc))
  return hit ? hit.name : 'dexxer:?'
}

/** The observable shape of a leg, minus the instruction objects themselves. */
function shape(l: BatchLeg) {
  return {
    label: l.label,
    ixs: l.ixs.map(ixName),
    sponsor: l.sponsor,
    onLanded: l.onLanded,
    feePayer: l.feePayer.toBase58(),
    nonce: l.nonce?.slot ?? null,
  }
}

async function collect(
  ctx: OnboardCtx,
  base: Map<string, AccountInfo<Buffer>>,
  tee: Map<string, AccountInfo<Buffer>>,
  feePayer = FEE_PAYER,
) {
  installBase(base)
  const log: string[] = []
  const mwa = { getConnection: async () => fakeConn(tee) as unknown as Connection }
  const legs = await collectBatchLegs(ctx, mwa, feePayer, (s) => log.push(s), NONCES)
  // anchor-ts drops unknown keys silently: every built leg must carry exactly the IDL's account count.
  for (const l of legs) assertIxKeysMatchIdl(new Transaction().add(...l.ixs))
  return { legs: legs.map(shape), log, raw: legs }
}

const nowSec = () => Math.floor(Date.now() / 1000)

// --- scenarios ------------------------------------------------------------

test('fresh owner: four legs, L1 legs sponsored on nonces 0/1/2, ER leg owner-paid', async () => {
  const ctx = makeCtx()
  const { legs, raw } = await collect(ctx, new Map(), new Map())
  assert.deepEqual(legs, [
    {
      label: 'faucet+init_user',
      ixs: ['ata:create', 'faucet_init', 'init_user'],
      sponsor: true,
      onLanded: ['Funded', 'Initialized'],
      feePayer: FEE_PAYER.toBase58(),
      nonce: 0,
    },
    { label: 'delegate_spl', ixs: legs[1].ixs, sponsor: true, onLanded: [], feePayer: FEE_PAYER.toBase58(), nonce: 1 },
    {
      label: 'delegate_user',
      ixs: ['delegate_user'],
      sponsor: true,
      onLanded: ['Delegated'],
      feePayer: FEE_PAYER.toBase58(),
      nonce: 2,
    },
    {
      label: 'permissions+session',
      ixs: ['init_permissions', 'set_session'],
      sponsor: false,
      onLanded: ['Permissioned', 'SessionSet'],
      feePayer: ctx.owner.toBase58(),
      nonce: null,
    },
  ])
  assert.ok(
    legs[1].ixs.length >= 1 && legs[1].ixs.every((n) => n.startsWith('other:')),
    'delegate_spl carries only eSPL instructions',
  )
  assert.ok(raw[3].conn !== baseConn, 'ER leg is sent on the owner TEE connection, not the base one')

  // Exact account sets and order (the IDL's), on real PDAs.
  const keys = (ix: TransactionInstruction) => ix.keys.map((k) => k.pubkey.toBase58())
  const b58 = (...p: PublicKey[]) => p.map((k) => k.toBase58())
  const initUser = raw[0].ixs[2]
  assert.deepEqual(
    keys(initUser),
    b58(ctx.owner, FEE_PAYER, ctx.config, ctx.userAccount, ctx.positions, SystemProgram.programId),
  )
  const delegateUser = keys(raw[2].ixs[0])
  assert.equal(delegateUser.length, 14)
  assert.equal(delegateUser[1], FEE_PAYER.toBase58())
  assert.equal(delegateUser[6], ctx.userAccount.toBase58())
  assert.equal(delegateUser[10], ctx.positions.toBase58())
  const initPerm = keys(raw[3].ixs[0])
  assert.equal(initPerm.length, 9)
  assert.equal(initPerm[4], permissionPdaFromAccount(ctx.userAccount).toBase58())
  assert.equal(initPerm[5], permissionPdaFromAccount(ctx.positions).toBase58())
})

test('self-funded owner (feePayer === owner): L1 legs are not sponsored', async () => {
  const ctx = makeCtx()
  const { legs } = await collect(ctx, new Map(), new Map(), ctx.owner)
  assert.deepEqual(
    legs.map((l) => [l.label, l.sponsor]),
    [
      ['faucet+init_user', false],
      ['delegate_spl', false],
      ['delegate_user', false],
      ['permissions+session', false],
    ],
  )
})

test('returning owner after exit: no L1 leg is built until the janitor closed the accounts', async () => {
  const ctx = makeCtx()
  const ua = await userAccountData({ owner: ctx.owner, exited: true })
  installBase(
    new Map([
      [ctx.config.toBase58(), info(DEXXER_CORE_PROGRAM_ID, Buffer.alloc(8))],
      [ctx.userAccount.toBase58(), info(DEXXER_CORE_PROGRAM_ID, ua)],
      [pdas.faucet(ctx.owner).toBase58(), info(DEXXER_CORE_PROGRAM_ID)],
    ]),
  )
  const snap = await readL1Snapshot(baseConn, l1KeysFor(ctx.owner, MINT))
  assert.equal(l1ProgressFrom(snap), 'Exited')
  const log: string[] = []
  const mwa = { getConnection: async () => fakeConn(new Map()) as unknown as Connection }
  const legs = await collectBatchLegs(ctx, mwa, FEE_PAYER, (s) => log.push(s), [null, null, null], snap)
  assert.deepEqual(legs.map((l) => l.label), [])
  assert.ok(log.some((s) => s.startsWith('init_user: account exited')))
})

test('initialised but not exited and not delegated: nothing to (re)initialise, delegation still pending', async () => {
  const ctx = makeCtx()
  const base = new Map([
    [ctx.faucetPda.toBase58(), info(DEXXER_CORE_PROGRAM_ID)],
    [ctx.ownerAta.toBase58(), info(PublicKey.unique())],
    [
      ctx.userAccount.toBase58(),
      info(DEXXER_CORE_PROGRAM_ID, await userAccountData({ owner: ctx.owner, exited: false })),
    ],
  ])
  const { legs, log } = await collect(ctx, base, new Map())
  assert.deepEqual(
    legs.map((l) => l.label),
    ['delegate_spl', 'delegate_user', 'permissions+session'],
  )
  assert.ok(log.includes('init_user: exists, skipped'))
})

test('fresh owner whose ATA exists and eATA is already delegated: no ATA-create, no delegate_spl leg', async () => {
  const ctx = makeCtx()
  const [eata] = deriveEphemeralAta(ctx.owner, MINT)
  const base = new Map([
    [ctx.ownerAta.toBase58(), info(PublicKey.unique())],
    [eata.toBase58(), info(DELEGATION_PROGRAM_ID)],
  ])
  const { legs, log } = await collect(ctx, base, new Map())
  assert.deepEqual(
    legs.map((l) => [l.label, l.ixs, l.nonce]),
    [
      ['faucet+init_user', ['faucet_init', 'init_user'], 0],
      ['delegate_user', ['delegate_user'], 2],
      ['permissions+session', ['init_permissions', 'set_session'], null],
    ],
  )
  assert.ok(log.includes('delegate_spl: eATA already delegated, skipped'))
})

test('delegated with this device session fresh on the ER: zero legs', async () => {
  const ctx = makeCtx()
  const base = new Map([
    [ctx.faucetPda.toBase58(), info(DEXXER_CORE_PROGRAM_ID)],
    [ctx.userAccount.toBase58(), info(DELEGATION_PROGRAM_ID)],
  ])
  const tee = new Map([
    [permissionPdaFromAccount(ctx.userAccount).toBase58(), info(PERMISSION_PROGRAM_ID)],
    [
      ctx.userAccount.toBase58(),
      info(
        DELEGATION_PROGRAM_ID,
        await userAccountData({
          owner: ctx.owner,
          sessionKey: ctx.session.publicKey,
          sessionExpiry: nowSec() + SESSION_EXPIRY_SECS,
        }),
      ),
    ],
  ])
  const { legs, log } = await collect(ctx, base, tee)
  assert.deepEqual(legs, [])
  assert.ok(log.includes('init_permissions: exists, skipped'))
  assert.ok(log.some((s) => s.startsWith('set_session: already set')))
})

test('delegated, permissions present, session key matches but expires within the renew margin: set_session alone', async () => {
  const ctx = makeCtx()
  const base = new Map([
    [ctx.faucetPda.toBase58(), info(DEXXER_CORE_PROGRAM_ID)],
    [ctx.userAccount.toBase58(), info(DELEGATION_PROGRAM_ID)],
  ])
  const tee = new Map([
    [permissionPdaFromAccount(ctx.userAccount).toBase58(), info(PERMISSION_PROGRAM_ID)],
    [
      ctx.userAccount.toBase58(),
      info(
        DELEGATION_PROGRAM_ID,
        await userAccountData({
          owner: ctx.owner,
          sessionKey: ctx.session.publicKey,
          sessionExpiry: nowSec() + 30 * 60,
        }),
      ),
    ],
  ])
  const { legs, log } = await collect(ctx, base, tee)
  assert.deepEqual(
    legs.map((l) => [l.label, l.ixs, l.sponsor, l.nonce]),
    [['permissions+session', ['set_session'], false, null]],
  )
  assert.ok(log.some((s) => s.includes('renewing')))
})

test('delegated, key and expiry fresh but the action budget nearly spent: set_session alone', async () => {
  const ctx = makeCtx()
  const base = new Map([
    [ctx.faucetPda.toBase58(), info(DEXXER_CORE_PROGRAM_ID)],
    [ctx.userAccount.toBase58(), info(DELEGATION_PROGRAM_ID)],
  ])
  const tee = new Map([
    [permissionPdaFromAccount(ctx.userAccount).toBase58(), info(PERMISSION_PROGRAM_ID)],
    [
      ctx.userAccount.toBase58(),
      info(
        DELEGATION_PROGRAM_ID,
        await userAccountData({
          owner: ctx.owner,
          sessionKey: ctx.session.publicKey,
          sessionExpiry: nowSec() + SESSION_EXPIRY_SECS,
          actionsLeft: 2,
        }),
      ),
    ],
  ])
  const { legs, log } = await collect(ctx, base, tee)
  assert.deepEqual(
    legs.map((l) => [l.label, l.ixs]),
    [['permissions+session', ['set_session']]],
  )
  assert.ok(log.some((s) => s.includes('2 actions left — renewing')))
})

test('delegated but permissions missing on the ER and a different session key: both ER instructions', async () => {
  const ctx = makeCtx()
  const base = new Map([
    [ctx.faucetPda.toBase58(), info(DEXXER_CORE_PROGRAM_ID)],
    [ctx.userAccount.toBase58(), info(DELEGATION_PROGRAM_ID)],
  ])
  const tee = new Map([
    [
      ctx.userAccount.toBase58(),
      info(
        DELEGATION_PROGRAM_ID,
        await userAccountData({
          owner: ctx.owner,
          sessionKey: PublicKey.unique(),
          sessionExpiry: nowSec() + SESSION_EXPIRY_SECS,
        }),
      ),
    ],
  ])
  const { legs } = await collect(ctx, base, tee)
  assert.deepEqual(
    legs.map((l) => [l.label, l.ixs]),
    [['permissions+session', ['init_permissions', 'set_session']]],
  )
})
