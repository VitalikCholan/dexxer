// app/src/features/onboard/batchOnboarding.ts
//
// The batched onboarding RUNNER (Task 6, week 4; week 6 split): collects the
// legs still needed (`onboardLegs.ts`), signs them all in ONE
// `mwa.signTransactions([...])` call, then submits them in order — L1a, L1b,
// then the ER leg — reporting `BatchProgress` to the screen. Types and
// constants live in `onboardTypes.ts`, the L1 snapshot in `onboardState.ts`,
// the send primitives in `src/lib/txSend.ts`. `useOnboarding.ts` is the
// hook wrapper (React state, `buildCtx`).
//
// Finding D (review): blockhashes are fetched immediately before
// `signTransactions` (not earlier — `collectBatchLegs` below does no RPC
// blockhash reads at all, only account-state reads). Between legs, each
// leg's blockhash is re-validated (`Connection.isBlockhashValid`) right
// before it's submitted — confirming an earlier leg can take up to ~15s
// (`confirmOnConn`'s 100 tries * 150ms), long enough for a later leg's
// blockhash to expire while waiting. An expired leg is rebuilt with a fresh
// blockhash and re-signed ALONE (one extra MWA prompt, logged as `re-sign
// leg i (blockhash expired)`) rather than failing the whole batch.
import { PublicKey, Transaction } from '@solana/web3.js'
import { baseConn } from '@/src/lib/solana'
import { readConfigFeePayer } from '@/src/lib/codecs'
import { describeTxError } from '@/src/lib/errors'
import { confirmOnConn } from '@/src/lib/confirm'
import { signWithLiveBlockhash, waitDelegated, type Mwa } from '@/src/lib/txSend'
import { sponsorTx, SponsorError } from '@/src/lib/sponsor'
import { SELF_FUND_ONBOARDING_MIN_LAMPORTS, canSelfFund } from '@/src/lib/selfFund'
import { fetchNonces, nonceTransaction, type NonceInfo } from '@/src/lib/nonce'
import { l1KeysFor, readL1Snapshot, type L1Snapshot } from './onboardState'
import { collectBatchLegs } from './onboardLegs'
import type { BatchLeg, BatchProgress, OnboardCtx, OnboardState } from './onboardTypes'

// Re-exported so existing importers (useOnboarding, StepsList, tests) keep working.
export * from './onboardTypes'
export { collectBatchLegs } from './onboardLegs'
export type { Mwa } from '@/src/lib/txSend'

/**
 * Onboarding's error formatter is `errors.ts`'s `describeTxError`: an
 * Anchor custom-error code in the message becomes its readable text
 * (`test/errors.test.ts`). It used to return `e.message` verbatim, so the
 * flow most likely to fail was the one showing raw `custom program error:
 * 0x…` strings.
 */
export const errText = describeTxError

/**
 * Fetches the owner's three durable nonces from the relayer (`nonce.ts`; the
 * relayer creates the accounts on the first call — no wallet prompt).
 * Returns `[null, null, null]` on failure so onboarding still runs on live
 * blockhashes rather than dying on an optional step.
 */
async function ensureNonceAccounts(owner: PublicKey, appendLog: (s: string) => void): Promise<(NonceInfo | null)[]> {
  try {
    const nonces = await fetchNonces(owner)
    appendLog(`nonce: L1 legs on durable nonces ${nonces.map((n) => n.account.toBase58().slice(0, 6)).join(', ')}`)
    return nonces
  } catch (e) {
    appendLog(`nonce: unavailable, continuing on live blockhashes — ${errText(e)}`)
    if (__DEV__) console.log(`[dexxer] nonce: unavailable — ${errText(e)}`)
    return [null, null, null]
  }
}

/**
 * Collects whatever's left (`collectBatchLegs`), signs every leg's
 * transaction in ONE `mwa.signTransactions([...])` call, then submits each
 * sequentially — L1a before L1b (L1b's `delegate_user` needs L1a's
 * `init_user`/`init_user_reuse_queue` to have landed), then the ER leg. The
 * two L1 legs go through `/sponsor` first (fee_payer co-signs — findings
 * A.1/A.2, and week-5 Task 6's ATA-create/`delegate_user` extension); the ER
 * leg doesn't (finding A.3, attempted and permanently reverted — see file
 * header). `onProgress` reports
 * `Collecting -> Signing -> Submitting(i/n) -> Done | Failed(step)` for the
 * UI; `setState` still drives the coarse `OnboardState` the screen's
 * progress bar already understands (each leg's `onLanded` states, in
 * order).
 *
 * Finding D: blockhashes are fetched right here, immediately before
 * `signTransactions` — never earlier. Between legs, a leg whose blockhash
 * has since expired (confirming an earlier leg can take up to ~15s) is
 * rebuilt with a fresh blockhash and re-signed ALONE (one extra prompt)
 * rather than failing the whole batch.
 */
export async function runBatchedOnboarding(
  ctx: OnboardCtx,
  mwa: Mwa,
  appendLog: (s: string) => void,
  setState: (s: OnboardState) => void,
  onProgress: (p: BatchProgress) => void,
  l1?: L1Snapshot,
): Promise<void> {
  // Before the first wallet prompt: `/nonce` and `/sponsor` need the owner's
  // relayer session, and a late 401 on `/nonce` would silently fall back to a
  // live blockhash (Phantom: "confirm timeout") — spec §2.7.
  await mwa.ensureRelayerSession(ctx.owner)
  onProgress({ phase: 'Collecting', step: null, i: 0, n: 0 })
  const snap = l1 ?? (await readL1Snapshot(baseConn, l1KeysFor(ctx.owner, ctx.mint)))
  if (!snap.config) throw new Error('Config PDA not found — protocol not bootstrapped on this devnet deployment')
  // Self-funded when the owner holds enough SOL (Phantom cannot simulate a
  // sponsored tx whose fee_payer signature is still empty — see selfFund.ts);
  // sponsored otherwise. `feePayerPubkey` below is whoever pays: owner or relayer.
  const selfFund = await canSelfFund(ctx.owner, SELF_FUND_ONBOARDING_MIN_LAMPORTS)
  const feePayerPubkey = selfFund ? ctx.owner : readConfigFeePayer(snap.config.data)
  appendLog(selfFund ? 'L1 legs: self-funded (owner pays rent + fees)' : 'L1 legs: sponsored by the relayer fee_payer')

  // Durable nonces (nonce.ts): the relayer creates the owner's two nonce
  // accounts (no prompt), then every L1 leg rides on its own nonce and can
  // no longer expire while the wallet is open.
  const nonces = await ensureNonceAccounts(ctx.owner, appendLog)

  const legs = await collectBatchLegs(ctx, mwa, feePayerPubkey, appendLog, nonces, snap)
  if (legs.length === 0) {
    appendLog('onboarding: nothing left to do')
    onProgress({ phase: 'Done', step: null, i: 0, n: 0 })
    return
  }

  const txs = await buildLegTransactions(legs, ctx.owner)
  if (__DEV__) logLegSizes(legs, txs)
  onProgress({ phase: 'Signing', step: null, i: 0, n: legs.length })
  let signed: Transaction[]
  try {
    signed = await mwa.signTransactions(txs)
  } catch (e) {
    onProgress({ phase: 'Failed', step: 'signing', i: 0, n: legs.length })
    throw e
  }

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]
    onProgress({ phase: 'Submitting', step: leg.label, i: i + 1, n: legs.length })
    try {
      await submitLeg(leg, signed[i], i, ctx, mwa, appendLog)
    } catch (e) {
      onProgress({ phase: 'Failed', step: leg.label, i: i + 1, n: legs.length })
      throw e
    }
    for (const s of leg.onLanded) setState(s)
  }

  onProgress({ phase: 'Done', step: null, i: legs.length, n: legs.length })
}

/** One unsigned tx per leg: on the leg's durable nonce when it has one, else on a fresh blockhash from the leg's connection. */
async function buildLegTransactions(legs: BatchLeg[], owner: PublicKey): Promise<Transaction[]> {
  return Promise.all(
    legs.map(async (leg) => {
      if (leg.nonce) return nonceTransaction(leg.feePayer, owner, leg.nonce, leg.ixs)
      const tx = new Transaction().add(...leg.ixs)
      tx.feePayer = leg.feePayer
      tx.recentBlockhash = (await leg.conn.getLatestBlockhash()).blockhash
      return tx
    }),
  )
}

/**
 * Wire size BEFORE the wallet sees it — MWA serializes with all signatures
 * blank, so a >1232-byte leg fails right there, silently from the wallet's
 * point of view (measured 25.09: `Transaction too large: 1322 > 1232`,
 * sponsored `faucet+init_user` on a nonce). Dev builds only.
 */
function logLegSizes(legs: BatchLeg[], txs: Transaction[]) {
  for (let i = 0; i < legs.length; i++) {
    let size = 'n/a'
    try {
      size = String(txs[i].serialize({ requireAllSignatures: false, verifySignatures: false }).length)
    } catch (e) {
      size = `ERR ${errText(e)}`
    }
    console.log(
      `[dexxer] leg ${legs[i].label}: ${legs[i].ixs.length} ixs (+${legs[i].nonce ? 'advance+2 CB' : 'blockhash'}), ${size} bytes`,
    )
  }
}

/**
 * Sends one signed leg and waits for it: re-signs alone if its blockhash
 * expired while earlier legs confirmed (Finding D), routes sponsored legs
 * through `/sponsor` first, and after `delegate_user` polls until the three
 * PDAs show as delegated on L1 (the ER validator only clones a delegated
 * account after L1 shows it so).
 */
async function submitLeg(
  leg: BatchLeg,
  signedTx: Transaction,
  i: number,
  ctx: OnboardCtx,
  mwa: Mwa,
  appendLog: (s: string) => void,
): Promise<void> {
  let toSend = signedTx

  // Finding D: re-validate this leg's blockhash right before it's sent —
  // an earlier leg's confirmation wait (up to ~15s) may have let this
  // one's expire.
  const bh = toSend.recentBlockhash
  // A nonce-backed leg carries the nonce value as `recentBlockhash` — it
  // is not a blockhash and never expires by slot; skip the liveness check.
  const stillValid = leg.nonce
    ? true
    : bh
      ? (await leg.conn.isBlockhashValid(bh, { commitment: 'confirmed' })).value
      : false
  if (!stillValid) {
    appendLog(`re-sign leg ${i + 1} (blockhash expired)`)
    // Re-checked AFTER signing too — Phantom prompts measured at 38–55 s each (24.09).
    toSend = await signWithLiveBlockhash(
      leg.conn,
      leg.feePayer,
      leg.ixs,
      async (tx) => (await mwa.signTransactions([tx]))[0],
      appendLog,
    )
  }

  if (leg.sponsor) {
    try {
      toSend = await sponsorTx(toSend, ctx.owner)
    } catch (e) {
      const msg = e instanceof SponsorError ? `sponsor rejected (${e.status}): ${e.message}` : errText(e)
      throw new Error(`${leg.label}: ${msg}`)
    }
  }
  const raw = toSend.serialize()
  if (__DEV__)
    console.log(
      `[dexxer] leg ${leg.label}: feePayer=${toSend.feePayer?.toBase58()} ixs=${toSend.instructions.length} bytes=${raw.length} tx=${raw.toString('base64')}`,
    )
  const sig = await leg.conn.sendRawTransaction(raw, { skipPreflight: true })
  await confirmOnConn(leg.conn, sig)
  appendLog(`${leg.label} ${sig}`)
  // `delegate_user`'s three accounts don't appear as delegated on L1
  // immediately after the tx confirms — poll BEFORE the next leg (the ER
  // leg reads these same PDAs on the ER validator, which only clones a
  // delegated account after L1 shows it delegated), mirroring the
  // legacy flow's ordering.
  if (leg.label === 'delegate_user') {
    await waitDelegated(ctx.userAccount, 'UserAccount', appendLog)
    await waitDelegated(ctx.position, 'Position', appendLog)
    await waitDelegated(ctx.disclosureQueue, 'DisclosureQueue', appendLog)
  }
}
