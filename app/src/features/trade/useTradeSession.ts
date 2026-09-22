// app/src/features/trade/useTradeSession.ts
//
// Shared plumbing for TradeScreen/PositionScreen (Task 8): the connected
// owner (same MWA provider as onboard.tsx — `MobileWalletProvider` wraps the
// whole app, so a wallet connected on the Onboard tab is still connected
// here), the owner's already-provisioned session `Keypair` (loaded, never
// generated here — `set_session` during onboarding is what actually
// authorizes a session key as a permission member on-chain; a screen that
// generated its own would just get `Unauthorized`/`SessionExpired`), the
// session's own TEE connection (`session.ts`'s `teeConnectionForSession` —
// no MWA prompt), and every PDA `Trade`'s accounts need
// (`programs/dexxer_core/src/instructions/trade.rs`'s `Trade` context):
// config, market, marketRisk, pool, userAccount, position, feed.
//
// `Config.dusdc_mint`/`Config.oracle_program` (needed to derive `pool`/
// `feed`) are read once off the base connection, same manual-decode
// approach `useOnboarding.ts` already uses for `dusdc_mint`.
import { useEffect, useState } from 'react'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { toPublicKey } from '@/src/spikes/mwa'
import { baseConn } from '@/src/lib/solana'
import { readConfigDusdcMint, readConfigOracleProgram, type TradeAccounts } from '@/src/lib/program'
import { pdas } from '@/src/lib/pdas'
import { getSessionKeypair, teeConnectionForSession } from '@/src/lib/session'

export interface TradeSession {
  owner: PublicKey | null
  session: Keypair | null
  /** The session's own TEE connection (see file header) — every open/close/read in Task 8 goes through this, never MWA. */
  conn: Connection | null
  accounts: TradeAccounts | null
  loading: boolean
  error: string | null
}

export function useTradeSession(): TradeSession {
  const { account } = useMobileWallet()
  const owner = account ? toPublicKey(account.address) : null

  const [session, setSession] = useState<Keypair | null>(null)
  const [conn, setConn] = useState<Connection | null>(null)
  const [accounts, setAccounts] = useState<TradeAccounts | null>(null)
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
    setAccounts(null)
    setError(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!owner) return

    async function run() {
      setLoading(true)
      try {
        const sessionKp = await getSessionKeypair(owner!)
        if (!sessionKp) {
          throw new Error('No session key on this device yet — finish onboarding first (Onboard tab)')
        }
        const configPda = pdas.config()
        const configInfo = await baseConn.getAccountInfo(configPda, 'confirmed')
        if (!configInfo) {
          throw new Error('Config PDA not found — protocol not bootstrapped on this devnet deployment')
        }
        const mint = readConfigDusdcMint(configInfo.data)
        const oracleProgram = readConfigOracleProgram(configInfo.data)
        const marketPda = pdas.market()
        const tradeAccounts: TradeAccounts = {
          config: configPda,
          market: marketPda,
          marketRisk: pdas.marketRisk(marketPda),
          poolLive: pdas.poolLive(mint),
          userAccount: pdas.userAccount(owner!),
          position: pdas.position(owner!, marketPda),
          feed: pdas.feedUnder(oracleProgram),
        }
        const teeConn = await teeConnectionForSession(sessionKp)
        if (cancelled) return
        setSession(sessionKp)
        setConn(teeConn)
        setAccounts(tradeAccounts)
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

  return { owner, session, conn, accounts, loading, error }
}
