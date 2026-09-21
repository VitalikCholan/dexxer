// Week-3 M-A: does `commit_and_undelegate` deliver bytes to L1 for an account
// whose ephemeral permission was JUST closed (`CloseEphemeralPermissionCpi`)
// in the same ER transaction? Decides `undelegate_user`'s instruction order
// (spec §2.4.3).
//
// Sequence: increment (fresh count) -> exit (close_permission +
// commit_and_undelegate, one atomic ER tx) -> poll base until
// counter.owner == PROGRAM_ID (not the Delegation Program) and count matches
// the ER value. PASS = bytes landed. On a send/execution FAILURE of `exit`,
// falls back to the pre-existing `undelegate` instruction (commit_and_undelegate
// WITHOUT closing the permission first) and records which variant worked — a
// failed `exit` cannot leave the permission half-closed (Solana tx atomicity),
// so it is always safe to retry with the no-close variant on the same account.
//
// Run (from spikes/): `npx tsx 01-private-counter-tee/w3-ma.ts`
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { getAuthToken, permissionPdaFromAccount, PERMISSION_PROGRAM_ID, MAGIC_PROGRAM_ID, DELEGATION_PROGRAM_ID, EPHEMERAL_VAULT_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, TEE_WS, loadKeypair, routerStatus, assert } from "../lib/env.js";
import idl from "./target/idl/private_counter.json" with { type: "json" };

const user = loadKeypair("user");

const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("counter"), user.publicKey.toBuffer()], program.programId);
const permissionPDA = permissionPdaFromAccount(counterPDA);

console.log("program:", program.programId.toBase58());
console.log("counterPDA:", counterPDA.toBase58());
console.log("permissionPDA:", permissionPDA.toBase58());

// Precondition: counter already delegated + private from week 2 (see RESULT.md
// check 1). This measurement does not (re-)establish that state, it only adds
// one more increment for a fresh, known count value before exiting.
const baseBefore = await baseConn.getAccountInfo(counterPDA);
assert(baseBefore !== null && baseBefore.owner.equals(DELEGATION_PROGRAM_ID), "counter delegated before M-A run");
console.log("base owner before:", baseBefore!.owner.toBase58());

let status = await routerStatus(counterPDA);
for (let i = 0; i < 20 && !status.isDelegated; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  status = await routerStatus(counterPDA);
}
assert(status.isDelegated, "router reports delegated");
assert(status.fqdn?.includes("tee"), `fqdn is TEE endpoint: ${status.fqdn}`);

const userToken = await getAuthToken(TEE_RPC, user.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, user.secretKey)));
const teeConnUser = new web3.Connection(`${TEE_RPC}?token=${userToken.token}`, { wsEndpoint: `${TEE_WS}?token=${userToken.token}`, commitment: "confirmed" });
const erProvider = new anchor.AnchorProvider(teeConnUser, new anchor.Wallet(user), { commitment: "confirmed" });
const erProgram = new Program(idl as anchor.Idl, erProvider);

const permBefore = await teeConnUser.getAccountInfo(permissionPDA);
console.log("permission exists before exit:", permBefore !== null, permBefore ? `${permBefore.data.length} bytes` : "");

await erProgram.methods.increment().accountsPartial({ counter: counterPDA }).rpc();
const erCounterBefore = await erProgram.account.counter.fetch(counterPDA);
const erCount = (erCounterBefore as any).count.toNumber();
console.log("ER count after increment:", erCount);

async function pollBaseDelivered(label: string, timeoutMs = 120_000): Promise<{ delivered: boolean; elapsedMs: number; finalOwner?: string; finalCount?: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const info = await baseConn.getAccountInfo(counterPDA);
    if (info && info.owner.equals(program.programId)) {
      const count = info.data.readBigUInt64LE(8);
      if (Number(count) === erCount) {
        return { delivered: true, elapsedMs: Date.now() - t0, finalOwner: info.owner.toBase58(), finalCount: Number(count) };
      }
      // owner already flipped but count doesn't match yet (unexpected) — keep polling, but log once.
      console.log(`${label}: owner flipped to program but count=${count} != expected ${erCount}, still polling`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  const info = await baseConn.getAccountInfo(counterPDA);
  return {
    delivered: false,
    elapsedMs: Date.now() - t0,
    finalOwner: info?.owner.toBase58(),
    finalCount: info ? Number(info.data.readBigUInt64LE(8)) : undefined,
  };
}

let exitSig: string | undefined;
let exitError: string | undefined;
try {
  exitSig = await erProgram.methods
    .exit()
    .accountsPartial({
      payer: user.publicKey,
      counter: counterPDA,
      permission: permissionPDA,
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .rpc();
  console.log("exit() ER sig:", exitSig);
} catch (e: any) {
  exitError = e?.message ?? String(e);
  console.log("exit() FAILED:", exitError);
  if (e?.logs) console.log("exit() logs:", e.logs);
}

let variant: "exit (close_permission + commit_and_undelegate)" | "undelegate (commit_and_undelegate only)";
let pass = false;
let pollResult: Awaited<ReturnType<typeof pollBaseDelivered>> | undefined;

if (exitSig) {
  variant = "exit (close_permission + commit_and_undelegate)";
  console.log("polling base for exit()'s delivery (<=120s)...");
  pollResult = await pollBaseDelivered("exit");
  pass = pollResult.delivered;
  console.log("exit() poll result:", pollResult);
} else {
  variant = "undelegate (commit_and_undelegate only)";
  console.log("exit() send failed — falling back to undelegate() (no permission close)");
  try {
    const fallbackSig = await erProgram.methods
      .undelegate()
      .accountsPartial({ payer: user.publicKey, counter: counterPDA })
      .rpc();
    console.log("undelegate() ER sig:", fallbackSig);
    pollResult = await pollBaseDelivered("undelegate-fallback");
    pass = pollResult.delivered;
    console.log("undelegate() poll result:", pollResult);
  } catch (e: any) {
    console.log("undelegate() fallback ALSO FAILED:", e?.message ?? String(e));
  }
}

console.log("\n=== M-A RESULT ===");
console.log(JSON.stringify({ variant, pass, exitError, erCount, pollResult }, null, 2));
