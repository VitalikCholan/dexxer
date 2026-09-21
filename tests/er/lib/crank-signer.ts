// tests/er/lib/crank-signer.ts
//
// Task 6 fix rounds 2/3: `crank_signer_pda(authority)` — the Magic Program's
// per-authority crank-executor PDA. The devnet-tee validator's Magic Program
// (a newer `magicblock-magic-program-api` than this repo's pinned 0.10.1
// crate) derives the ONLY signer it accepts inside a scheduled instruction
// this way — confirmed by reading the pinned validator source directly
// (`magicblock-labs/magicblock-validator`, commit
// `9c7a94470af1785d88f4c671571f87c146a93779`,
// `magicblock-magic-program-api/src/pda.rs`):
//
//   pub const CRANK_SEED: &[u8] = b"crank-executor";
//   pub fn crank_signer_pda(authority: &Pubkey) -> Pubkey {
//       Pubkey::find_program_address(&[CRANK_SEED, authority.as_ref()], &CRANK_PROGRAM_ID).0
//   }
//
// `CRANK_SEED`/`CRANK_PROGRAM_ID` ARE exported by the pinned 0.10.1 crate
// (only the composed `crank_signer_pda` helper is newer), and this repo's
// own `programs/dexxer_core/src/instructions/crank.rs` used to replicate
// this exact derivation on-chain (fix round 2) before fix round 3 moved the
// write to a base-layer admin ix (`set_scheduler_signer`) and had
// `schedule_crank` go back to just reading `Config.scheduler_signer` — this
// file is the client-side mirror callers use to compute the value that goes
// into that field. `authority` = the account that will call
// `schedule_crank`/be `Config.admin` (confirmed against
// `programs/magicblock/src/schedule_task/process_schedule_task.rs` at the
// same commit: the scheduling transaction's payer, index 0, is what the
// validator treats as `authority`).

import { PublicKey } from "@solana/web3.js";

export const CRANK_PROGRAM_ID = new PublicKey("Crank11111111111111111111111111111111111111");
const CRANK_SEED = Buffer.from("crank-executor");

/** crank_signer_pda(authority) — see file header for the pinned validator source this mirrors. */
export function crankSignerPda(authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CRANK_SEED, authority.toBuffer()], CRANK_PROGRAM_ID)[0];
}
