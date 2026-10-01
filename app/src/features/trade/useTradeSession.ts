// app/src/features/trade/useTradeSession.ts
//
// Shared plumbing for the trading screens: the connected owner (same MWA
// provider as onboard.tsx — `MobileWalletProvider` wraps the whole app, so a
// wallet connected on the Onboard tab is still connected here), the owner's
// already-provisioned session `Keypair` (loaded, never generated here —
// `set_session` during onboarding is what actually authorizes a session key
// as a permission member on-chain; a screen that generated its own would just
// get `Unauthorized`/`SessionExpired`), the session's own TEE connection
// (`session.ts`'s `teeConnectionForSession` — no MWA prompt), and the
// MARKET-INDEPENDENT `Trade` accounts (`base`): config, poolLive,
// userAccount, positions, feeEscrow, magicProgram, liqCrankSigner. A screen
// adds the selected market with `trade.ts`'s `tradeAccountsFor` (market PDA,
// its risk PDA, its feed from `Market.feed`; `taskContext` = positions).
//
// `Config.dusdc_mint` (needed to derive `poolLive`) is read once off the base
// connection, same manual-decode approach `useOnboarding.ts` uses.
import { useEffect, useState } from 'react'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { MAGIC_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk'
import { toPublicKey } from '@/src/lib/mwa/accounts'
import { baseConn } from '@/src/lib/solana'
import { readConfigDusdcMint } from '@/src/lib/codecs'
import { type BaseTradeAccounts } from '@/src/lib/trade'
import { pdas } from '@/src/lib/pdas'
import { getSessionKeypair, teeConnectionForSession } from '@/src/lib/session'

export type { BaseTradeAccounts }

export interface TradeSession {
  owner: PublicKey | null
  session: Keypair | null
  /** The session's own TEE connection (see file header) — every open/close/read in Task 8 goes through this, never MWA. */
  conn: Connection | null
  /** Market-independent accounts, derived once per owner — `tradeAccountsFor(base, market)` completes them. */
  base: BaseTradeAccounts | null
  loading: boolean
  error: string | null
}

export function useTradeSession(): TradeSession {
  const { account } = useMobileWallet()
  const owner = account ? toPublicKey(account.address) : null

  const [session, setSession] = useState<Keypair | null>(null)
  const [conn, setConn] = useState<Connection | null>(null)
  const [base, setBase] = useState<BaseTradeAccounts | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Reset stale state from a previous owner before (re-)deriving for this
    // one — same "clear on dependency change" shape react-hooks/set-state-in-effect
    // otherwise disallows; deliberate here, not a subscription callback.
    /* eslint-disable react-hooks/set-state-in-effect */
    setSession(null)
    setConn(null)
    setBase(null)
    setError(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!owner) return

    async function run() {
      setLoading(true)
      try {
        const sessionKp = await getSessionKeypair(owner!)
        if (!sessionKp) {
          throw new Error('No session key on this device yet — finish onboarding first')
        }
        const configPda = pdas.config()
        const configInfo = await baseConn.getAccountInfo(configPda, 'confirmed')
        if (!configInfo) {
          throw new Error('Config PDA not found — protocol not bootstrapped on this devnet deployment')
        }
        const mint = readConfigDusdcMint(configInfo.data)
        const baseAccounts: BaseTradeAccounts = {
          config: configPda,
          poolLive: pdas.poolLive(mint),
          userAccount: pdas.userAccount(owner!),
          positions: pdas.positions(owner!),
          feeEscrow: pdas.feeEscrow(),
          magicProgram: MAGIC_PROGRAM_ID,
          liqCrankSigner: pdas.liqCrankSigner(),
        }
        const teeConn = await teeConnectionForSession(sessionKp)
        if (cancelled) return
        setSession(sessionKp)
        setConn(teeConn)
        setBase(baseAccounts)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // Only re-derive when the connected owner changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.toBase58()])

  return { owner, session, conn, base, loading, error }
}
