// services/relayer/src/betaAccess.ts
//
// Closed beta gate: `BETA_ALLOWLIST` — comma/whitespace-separated wallet
// addresses. When set, `/auth/siws` issues a relayer session only to those
// wallets, so only they get sponsored onboarding and durable nonces
// (`/sponsor`, `/nonce`, both session-gated). Unset = open, as before.
//
// What it does NOT close: the program itself is permissionless, and a
// self-funded wallet that builds its own transactions can still onboard
// without the relayer. The beta is "closed" at the level of the app's
// sponsored path and the APK distribution, which is what a devnet beta needs;
// it also stops strangers draining the sponsor budget (risk #27).
import { PublicKey } from "@solana/web3.js";

export function parseAllowlist(raw: string | undefined, onInvalid?: (entry: string) => void): Set<string> | null {
  if (!raw || raw.trim() === "") return null;
  const out = new Set<string>();
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    try {
      out.add(new PublicKey(entry).toBase58());
    } catch {
      onInvalid?.(entry);
    }
  }
  return out;
}

export const NOT_ON_BETA_LIST = "This wallet is not on the Dexxer beta list yet — ask the team for an invite";
