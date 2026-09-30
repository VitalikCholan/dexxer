// app/src/lib/features.ts
//
// UI feature switches for the Ledger tab, the Account screen's Receipt and
// Exit cards, and the commit-reveal status in History. All on; set one to
// `false` to hide that UI — only the UI: the program, crank and relayer keep
// committing and revealing regardless, and the screens stay in the tree.
export const FEATURES = {
  /** Ledger tab (public Pool / BalancesRoot / Disclosures). */
  ledger: true,
  /** Account → Receipt (the `BalancesRoot` exit receipt). */
  receipt: true,
  /** Account → Exit private account. */
  exit: true,
  /** History: "Why do trades become public?", the Committed / Reveals in / Revealed badge and the Disclosure explorer link. */
  commitReveal: true,
} as const
