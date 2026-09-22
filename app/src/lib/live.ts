// app/src/lib/live.ts
//
// Task 9: extracted from `PositionScreen.tsx` (Task 8) so History/Receipt
// (Task 9) can share the same "live account" hook without importing a
// screen component. Behavior unchanged from the Task-8 original — see the
// justification there: `onAccountChange` for fast pushes (best-effort — a
// failed subscribe attempt is swallowed, never thrown) plus an
// unconditional 1s poll, because the TEE validator's confirmation websocket
// is unreliable on-device (same finding as `useOnboarding.ts`).
import { useEffect, useState } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'

export interface LiveAccount<T> {
  value: T | null
  missing: boolean
  error: string | null
}

/**
 * Live account value: `onAccountChange` for fast pushes plus an
 * unconditional 1s poll, whichever lands first/next wins. `conn`/`pubkey`
 * may be `null` while a screen's prerequisites (owner, session, TEE
 * connection) are still loading — the hook just stays idle until both are set.
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

    async function refreshOnce() {
      try {
        const info = await conn!.getAccountInfo(pubkey!, 'confirmed')
        if (cancelled) return
        if (info) {
          setValue(decode(info.data))
          setMissing(false)
        } else {
          setValue(null)
          setMissing(true)
        }
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
          if (cancelled) return
          setValue(decode(info.data))
          setMissing(false)
          setError(null)
        },
        'confirmed',
      )
    } catch {
      // ws subscribe itself failed synchronously — the poll below still covers it.
    }
    const timer = setInterval(refreshOnce, 1000)

    return () => {
      cancelled = true
      clearInterval(timer)
      if (subId !== null) conn.removeAccountChangeListener(subId).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, pubkey?.toBase58()])

  return { value, missing, error }
}
