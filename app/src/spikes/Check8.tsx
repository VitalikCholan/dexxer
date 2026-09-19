// Check 8: MWA signs a transaction whose blockhash comes from the TEE, and
// the signed transaction is accepted by the TEE.
//
// Self-contained: "Onboard" creates and delegates a private-counter PDA for
// the connected wallet (initialize + delegate on L1, init_permission +
// set_privacy on the TEE ER — the last two ARE ER-blockhash transactions
// signed by MWA, which is the point of this check). "Run Check 8" then
// sends `increment` with an ER blockhash. No key export needed.
//
// Program: spikes/01-private-counter-tee (deployed to devnet, task-3-report.md).
// Account layouts: spikes/01-private-counter-tee/target/idl/private_counter.json.
import { useState } from 'react'
import { Button, Text, View } from 'react-native'
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  getAuthToken,
  permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { TEE_RPC, baseConn } from '../lib/solana'

const PROGRAM_ID = new PublicKey('2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7')
// Devnet TEE validator identity (spikes/.env, verified by spikes/00-identity.ts).
const TEE_VALIDATOR = new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo')
const ROUTER = 'https://devnet-router.magicblock.app/'

// Anchor discriminators from target/idl/private_counter.json.
const DISC = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  delegate: [90, 147, 75, 178, 85, 88, 4, 137],
  initPermission: [66, 14, 153, 250, 187, 36, 179, 236],
  setPrivacy: [120, 77, 9, 207, 149, 140, 138, 129],
  increment: [11, 18, 104, 9, 104, 174, 59, 33],
}

function ix(keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], data: number[]) {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.from(data) })
}

async function routerStatus(account: PublicKey): Promise<{ isDelegated: boolean; fqdn?: string }> {
  const r = await fetch(ROUTER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()] }),
  })
  const body = await r.json()
  if (body.error) throw new Error(body.error.message)
  return body.result
}

export function Check8() {
  const { account, connect, signTransaction, signMessage } = useMobileWallet()
  const [out, setOut] = useState('Step 1: Onboard (3 MWA prompts). Step 2: Run Check 8.')
  const [busy, setBusy] = useState(false)

  async function withWallet() {
    const wallet = account ?? (await connect())
    const owner = wallet.address
    const [counter] = PublicKey.findProgramAddressSync([Buffer.from('counter'), owner.toBuffer()], PROGRAM_ID)
    return { owner, counter }
  }

  async function signAndSend(conn: Connection, owner: PublicKey, instructions: TransactionInstruction[], label: string) {
    const tx = new Transaction().add(...instructions)
    tx.feePayer = owner
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
    const signed = await signTransaction(tx) // MWA bottom sheet
    const sig = await conn.sendRawTransaction(signed.serialize())
    await conn.confirmTransaction(sig, 'confirmed')
    return `${label}: ${sig}`
  }

  async function teeConnFor(owner: PublicKey) {
    const auth = await getAuthToken(TEE_RPC, owner, (m) => signMessage(m))
    return new Connection(`${TEE_RPC}?token=${auth.token}`, 'confirmed')
  }

  async function onboard() {
    setBusy(true)
    const log: string[] = []
    try {
      const { owner, counter } = await withWallet()
      log.push(`owner ${owner.toBase58()}`, `counter ${counter.toBase58()}`)
      setOut(log.join('\n'))

      // L1: initialize (skip if exists)
      const info = await baseConn.getAccountInfo(counter)
      if (!info) {
        log.push(
          await signAndSend(
            baseConn,
            owner,
            [
              ix(
                [
                  { pubkey: counter, isSigner: false, isWritable: true },
                  { pubkey: owner, isSigner: true, isWritable: true },
                  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                DISC.initialize,
              ),
            ],
            'initialize (L1)',
          ),
        )
      } else log.push('initialize: exists, skipped')
      setOut(log.join('\n'))

      // L1: delegate to TEE validator (skip if already delegated)
      const after = info ?? (await baseConn.getAccountInfo(counter))
      if (!after || !after.owner.equals(DELEGATION_PROGRAM_ID)) {
        log.push(
          await signAndSend(
            baseConn,
            owner,
            [
              ix(
                [
                  { pubkey: owner, isSigner: true, isWritable: false },
                  { pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(counter, PROGRAM_ID), isSigner: false, isWritable: true },
                  { pubkey: delegationRecordPdaFromDelegatedAccount(counter), isSigner: false, isWritable: true },
                  { pubkey: delegationMetadataPdaFromDelegatedAccount(counter), isSigner: false, isWritable: true },
                  { pubkey: counter, isSigner: false, isWritable: true },
                  { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
                  { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
                  { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
                  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                DISC.delegate,
              ),
            ],
            'delegate (L1)',
          ),
        )
      } else log.push('delegate: already delegated, skipped')
      setOut(log.join('\n'))

      // Router: wait for TEE placement
      let st = await routerStatus(counter)
      for (let i = 0; i < 20 && !st.isDelegated; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        st = await routerStatus(counter)
      }
      log.push(`router: delegated=${st.isDelegated} fqdn=${st.fqdn}`)
      setOut(log.join('\n'))
      if (!st.isDelegated) throw new Error('router never reported delegated')

      // ER: init_permission + set_privacy(true) — signed by MWA with ER blockhash
      const tee = await teeConnFor(owner)
      const permission = permissionPdaFromAccount(counter)
      const permKeys = [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: counter, isSigner: false, isWritable: true },
        { pubkey: permission, isSigner: false, isWritable: true },
        { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
        { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      ]
      const permInfo = await tee.getAccountInfo(permission)
      if (permInfo === null) {
        log.push(
          await signAndSend(
            tee,
            owner,
            [ix(permKeys, DISC.initPermission), ix(permKeys, [...DISC.setPrivacy, 1])],
            'initPermission+setPrivacy (ER blockhash)',
          ),
        )
      } else log.push('permission: exists, skipped')
      log.push('ONBOARD DONE')
      setOut(log.join('\n'))
    } catch (e) {
      log.push('ONBOARD FAIL ' + String(e))
      setOut(log.join('\n'))
    } finally {
      setBusy(false)
    }
  }

  async function run() {
    setBusy(true)
    setOut('running…')
    try {
      const { owner, counter } = await withWallet()
      const tee = await teeConnFor(owner)
      const t0 = Date.now()
      const line = await signAndSend(
        tee,
        owner,
        [ix([{ pubkey: counter, isSigner: false, isWritable: true }], DISC.increment)],
        'increment (ER blockhash)',
      )
      setOut(`CHECK 8 PASS ${Date.now() - t0}ms\n${line}`)
    } catch (e) {
      setOut('CHECK 8 FAIL ' + String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontWeight: '600' }}>Check 8: MWA signs ER-blockhash tx</Text>
      <Button title="Onboard (init + delegate + permission)" onPress={() => void onboard()} disabled={busy} />
      <Button title="Run Check 8 (increment)" onPress={() => void run()} disabled={busy} />
      <Text selectable>{out}</Text>
    </View>
  )
}
