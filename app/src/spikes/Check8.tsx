// Check 8: MWA signs a transaction whose blockhash comes from the TEE, and
// the signed transaction is accepted by the TEE.
//
// Precondition: the connected wallet's pubkey must already own a delegated,
// private `private-counter` PDA (seed [b"counter", owner]) on the TEE ER —
// run spikes/01-private-counter-tee/check.ts once against this exact pubkey
// (export the Mock Wallet's keypair and use it as the `user` key for that
// script), or otherwise add this pubkey as an `EphemeralPermission` member.
// Record on RESULT.md which path was actually used.
//
// If this fails with a program/permission error (not a signing/transport
// error), that is still a valid, informative result: it shows MWA can sign
// a transaction built against an ER blockhash and the TEE will accept the
// signature — the raw error is displayed below either way.
import { useState } from 'react'
import { Button, Text, View } from 'react-native'
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { getAuthToken } from '@magicblock-labs/ephemeral-rollups-sdk'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { TEE_RPC } from '../lib/solana'

// spikes/01-private-counter-tee, deployed to devnet (see task-3-report.md).
const PROGRAM_ID = new PublicKey('2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7')

// 8-byte Anchor discriminator for the `increment` instruction, taken from
// spikes/01-private-counter-tee/target/idl/private_counter.json.
const INCREMENT_DISCRIMINATOR = Uint8Array.from([11, 18, 104, 9, 104, 174, 59, 33])

const PRECONDITION_NOTE =
  'Precondition: this wallet’s pubkey must already own a delegated, private counter ' +
  '(Task 3 check.ts run against this pubkey, or added as a permission member). ' +
  'A program/permission error below is still a valid result for this check.'

export function Check8() {
  const { account, connect, signTransaction, signMessage } = useMobileWallet()
  const [out, setOut] = useState(PRECONDITION_NOTE)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    setOut('running…')
    try {
      const wallet = account ?? (await connect())
      const owner = wallet.address

      // Wallet signs the TEE auth challenge (one MWA prompt).
      const auth = await getAuthToken(TEE_RPC, owner, (m) => signMessage(m))
      const tee = new Connection(`${TEE_RPC}?token=${auth.token}`, 'confirmed')

      const [counter] = PublicKey.findProgramAddressSync([Buffer.from('counter'), owner.toBuffer()], PROGRAM_ID)

      const tx = new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [{ pubkey: counter, isSigner: false, isWritable: true }],
          data: Buffer.from(INCREMENT_DISCRIMINATOR),
        }),
      )
      tx.feePayer = owner
      tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash // ER blockhash, not L1

      const signed = await signTransaction(tx) // MWA bottom sheet prompt
      const sig = await tee.sendRawTransaction(signed.serialize())
      await tee.confirmTransaction(sig, 'confirmed')
      setOut(`CHECK 8 PASS ${sig}`)
    } catch (e) {
      setOut('CHECK 8 FAIL ' + String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontWeight: '600' }}>Check 8: MWA signs ER-blockhash tx</Text>
      <Button title="Run Check 8" onPress={() => void run()} disabled={busy} />
      <Text selectable>{out}</Text>
    </View>
  )
}
