// app/src/lib/confirm.ts
//
// The one signature-confirmation helper (week 6: it used to be copied
// verbatim in `trade.ts` and `batchOnboarding.ts`).
//
// Polls `getSignatureStatuses` instead of `Connection.confirmTransaction` —
// found on-device (task-7 emulator verification) that
// `rpc.magicblock.app/devnet`'s websocket doesn't reliably deliver
// `signatureSubscribe` notifications (`Tried to call a JSON-RPC method
// 'signatureSubscribe' but the socket was not 'CONNECTING' or 'OPEN'`,
// retried forever), hanging `confirmTransaction` indefinitely even though
// the transaction had already landed. Same root cause/fix as
// `tests/er/lib/env.ts`'s `confirmSignature` (documented there for the ER
// validator specifically) — the app hits it on the BASE connection too.
import type { Connection } from '@solana/web3.js'

/** The subset of `Connection` this needs — `test/confirm.test.ts` passes a fake. */
export type ConfirmConn = Pick<Connection, 'getSignatureStatuses'>

export async function confirmOnConn(conn: ConfirmConn, sig: string, tries = 100, delayMs = 150): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const { value } = await conn.getSignatureStatuses([sig])
    const status = value[0]
    if (status) {
      if (status.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(status.err)}`)
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error(`confirm timeout waiting for ${sig}`)
}
