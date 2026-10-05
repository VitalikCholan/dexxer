// app/src/features/trade/activity.ts
//
// The Trade screen's Positions / Open Orders block (`TradeActivity`) — pure
// decisions, so they run under `npm test` (05.10.2026).
import type { OnboardingGateStatus } from '../onboard/useOnboardingGate'

/**
 * The block shows only what the private account says. Before it is set up
 * (or while its positions are still being read) a "Positions (0)" would look
 * like a real answer — Trade already shows "Set up private account" then.
 */
export function activityVisible(gate: OnboardingGateStatus, positionsRead: boolean): boolean {
  return gate === 'ready' && positionsRead
}

/** The link to the Positions tab: there is always one when any market has an open position. */
export function positionsLink(openCount: number, hasHere: boolean): string | null {
  if (hasHere) return openCount > 1 ? `Manage all ${openCount} positions` : 'Manage in Positions'
  return openCount > 0 ? `Positions on other markets: ${openCount}` : null
}
