// app/src/lib/features.ts
//
// UI feature switches for the Account screen's Receipt and Exit cards. All on; set one to
// `false` to hide that UI — only the UI: the program and relayer are unaffected,
// and the screens stay in the tree.
export const FEATURES = {
  /** Account → Receipt (the `BalancesRoot` exit receipt). */
  receipt: true,
  /** Account → Exit private account. */
  exit: true,
} as const
