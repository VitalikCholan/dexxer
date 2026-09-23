// services/relayer/src/keys.ts
//
// Loads the relayer's two identities. Per CLAUDE.md's privacy rule the
// relayer holds ONLY `crank` and `fee_payer` keys — never owner/session
// tokens, and it reads only public accounts, the oracle, and the private
// accounts `crank` is already a permission member of (same as
// scripts/crank-fallback before this move).
//
// Production (Railway): bs58-encoded secret key from env
// (`CRANK_KEY_B58`/`FEE_PAYER_KEY_B58`) — set once via `railway variables
// set`, never committed. Local dev: falls back to
// `loadOrCreateKey`'s persistent `tests/er/.keys/<file>.json` (same file
// this laptop's `scripts/crank-fallback` already used), so `npm start`
// works unchanged without any env vars set.

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadOrCreateKey } from "../../../tests/er/lib/env.js";

export function keypairFromEnv(name: string, fileFallback: string): Keypair {
  const b58 = process.env[name];
  if (b58) return Keypair.fromSecretKey(bs58.decode(b58));
  return loadOrCreateKey(fileFallback); // local dev: tests/er/.keys/<file>.json
}
