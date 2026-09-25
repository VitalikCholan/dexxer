// app/src/lib/live.ts
//
// Task 9: rewritten on top of the controller's own 30-min spike (23.09.2026):
// `accountSubscribe` over `wss://devnet-tee.magicblock.app?token=<member
// token>` WORKS for both public (`Market`) and permissioned accounts — 72
// notifications observed in 25s. Two consequences:
//
//   1. The TEE pushes a notification on every ER slot REGARDLESS of whether
//      the account's data actually changed — so a push handler that calls
//      `decode`/`setState` unconditionally would re-render on every slot for
//      no reason. Every push (and poll) below is diffed against the last
//      seen raw bytes (`Buffer.equals`) before decoding/setting state.
//   2. Since pushes are reliable here (unlike the ER validator's
//      *confirmation* websocket — see `trade.ts`'s `confirmOnConn`, a
//      different subscription kind, still polled), the unconditional 1s
//      poll from the original (Task-8) version of this file is now a
//      FALLBACK only: poll every `FALLBACK_POLL_MS` while no push has
//      landed in the last `PUSH_FRESH_MS`, or after a WS subscribe error.
//      Once pushes are flowing, the interval tick is a no-op check, not a
//      network call.
import { useEffect, useState } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'

export interface LiveAccount<T> {
  value: T | null
  missing: boolean
  error: string | null
}

/** How often the fallback-poll timer checks whether it needs to fire. */
const FALLBACK_POLL_MS = 2000
/** A push older than this no longer counts as "pushes are flowing" — the fallback poll resumes. */
const PUSH_FRESH_MS = 5000

/**
 * Live account value: `onAccountChange` pushes for the fast path, a 2s
 * fallback poll for when pushes aren't flowing (no push in the last 5s, or
 * the WS subscribe itself failed) — see file header. `conn`/`pubkey` may be
 * `null` while a screen's prerequisites (owner, session, TEE connection) are
 * still loading — the hook just stays idle until both are set.
 */
export function useLiveAccount<T>(
  conn: Connection | null,
  pubkey: PublicKey | null,
  decode: (data: Buffer) => T,
): LiveAccount<T> {
  const [value, setValue] = useState<T | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Reset stale state from a previous (conn, pubkey) pair before
    // (re-)subscribing — see useTradeSession.ts's identical justification.
    /* eslint-disable react-hooks/set-state-in-effect */
    setValue(null)
    setMissing(false)
    setError(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!conn || !pubkey) return
    let cancelled = false
    let subId: number | null = null
    // Last raw bytes actually applied to state — `null` means "not seen
    // yet" (distinct from "account confirmed missing", tracked by `seen`).
    let lastData: Buffer | null = null
    let seen = false
    let lastPushAt = 0
    let wsErrored = false

    /** Apply `data` (or `null` for a missing account) iff it differs from what's already in state. */
    function apply(data: Buffer | null) {
      if (cancelled) return
      const unchanged =
        seen && (data === null) === (lastData === null) && (data === null || (lastData !== null && data.equals(lastData)))
      seen = true
      lastData = data
      if (unchanged) return
      if (data) {
        setValue(decode(data))
        setMissing(false)
      } else {
        setValue(null)
        setMissing(true)
      }
    }

    async function refreshOnce() {
      try {
        const info = await conn!.getAccountInfo(pubkey!, 'confirmed')
        if (cancelled) return
        apply(info ? info.data : null)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }

    void refreshOnce()
    try {
      subId = conn.onAccountChange(
        pubkey,
        (info) => {
          lastPushAt = Date.now()
          apply(info.data)
          if (!cancelled) setError(null)
        },
        'confirmed',
      )
    } catch {
      // ws subscribe itself failed synchronously — fall back to polling only.
      wsErrored = true
    }

    const timer = setInterval(() => {
      const stale = Date.now() - lastPushAt > PUSH_FRESH_MS
      if (wsErrored || stale) void refreshOnce()
    }, FALLBACK_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
      if (subId !== null) conn.removeAccountChangeListener(subId).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, pubkey?.toBase58()])

  return { value, missing, error }
}
