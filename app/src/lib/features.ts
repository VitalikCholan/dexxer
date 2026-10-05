// app/src/lib/features.ts
//
// UI feature switches for the Account screen's Receipt and Exit cards. Both
// off since 05.10.2026 (owner's call: the cards read as developer jargon, and a
// red Exit next to a zero balance looked like "delete account"). Set one to
// `true` to bring that UI back — only the UI: the program and relayer are
// unaffected, and the screens stay in the tree.
export const FEATURES = {
  /** Account → Receipt (the `BalancesRoot` exit receipt). */
  receipt: false,
  /** Account → Exit private account. */
  exit: false,
} as const
