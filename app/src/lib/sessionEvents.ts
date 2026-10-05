// app/src/lib/sessionEvents.ts
//
// "A session key was just saved for this owner." `useTradeSession` reads the
// key once per owner; a tab mounted before onboarding finished (Trade,
// Positions — the tab navigator keeps them alive) cached "No session key on
// this device yet" and kept showing it after onboarding saved the key
// (found 05.10.2026 on a fresh Phantom account). `session.ts` notifies here
// when it writes a key, and the hook re-reads. Pure, so it runs under `npm test`.
type Listener = (owner: string) => void

const listeners = new Set<Listener>()

/** Subscribe; returns the unsubscribe function. */
export function onSessionKeySaved(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Called by `session.ts` after a session key for `owner` (base58) is written to secure storage. */
export function notifySessionKeySaved(owner: string): void {
  for (const l of [...listeners]) l(owner)
}
