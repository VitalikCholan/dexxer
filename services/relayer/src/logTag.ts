// services/relayer/src/logTag.ts
//
// Final review I5: operator logs are persisted (Railway), and a `Positions`
// address is the PDA of its owner — "Positions X on market M, liquidated at
// T" in a log is "wallet W traded M and was liquidated at T". Where a log line
// needs to tell one trader apart from another, it carries `tagOf(PROCESS_SALT,
// key)`: the first 8 hex chars of sha256(salt ‖ key). The salt is random per
// process and never logged, so a tag cannot be mapped back to a key, not even
// by hashing every known wallet; it is stable only within one process
// lifetime, which is all a debugging session needs.
import { createHash, randomBytes } from "crypto";
import { PublicKey } from "@solana/web3.js";

export const PROCESS_SALT: Buffer = randomBytes(16);

export function tagOf(salt: Buffer, key: PublicKey | string): string {
  const bytes = typeof key === "string" ? new PublicKey(key).toBuffer() : key.toBuffer();
  return createHash("sha256").update(salt).update(bytes).digest("hex").slice(0, 8);
}
