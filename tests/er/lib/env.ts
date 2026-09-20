// tests/er/lib/env.ts
//
// Shared environment/config for Task 13's mb-stack (local Ephemeral Rollup)
// scenarios: RPC endpoints, the ER validator identity, keypair
// loading/persistence under `.keys/`, airdrop, and a poll helper for
// delegation to land on L1 before sending ER transactions.
//
// No `dotenv` package is installed in this package (see package.json), so
// `.env` is parsed by hand here rather than pulling in a new dependency.

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS_DIR = resolve(ROOT, ".keys");

function parseDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const dotEnv = parseDotEnv(resolve(ROOT, ".env"));
function cfg(key: string, fallback: string): string {
  return process.env[key] ?? dotEnv[key] ?? fallback;
}

export const BASE = cfg("BASE_RPC", "http://127.0.0.1:8899");
export const ER = cfg("ER_RPC", "http://127.0.0.1:7799");
export const PUBLIC = cfg("PUBLIC_RPC", "http://127.0.0.1:6699");
export const ER_VALIDATOR = new PublicKey(cfg("ER_VALIDATOR", "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"));

export const baseConn = new Connection(BASE, "confirmed");
export const erConn = new Connection(ER, "confirmed");

export function loadOrCreateKey(name: string): Keypair {
  if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true });
  const path = resolve(KEYS_DIR, `${name}.json`);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export async function airdrop(conn: Connection, pubkey: PublicKey, sol: number): Promise<string> {
  const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/**
 * Poll base-layer `getAccountInfo` until `pubkey`'s owner is the Delegation
 * Program (i.e. the account has been delegated to the ER). Delegated
 * accounts take a short moment to be picked up by the ER validator after the
 * base-layer delegate transaction confirms.
 */
export async function waitDelegated(conn: Connection, pubkey: PublicKey, label: string, tries = 60, delayMs = 500): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const info = await conn.getAccountInfo(pubkey, "confirmed");
    if (info && info.owner.equals(DELEGATION_PROGRAM_ID)) {
      console.log(`ok (poll): ${label} delegated (attempt ${attempt})`);
      return;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`timeout waiting for ${label} (${pubkey.toBase58()}) to be delegated`);
}

/**
 * Poll an RPC connection's `getAccountInfo` until the account exists
 * (non-null). Used to wait for the ER to have cloned a delegated account
 * before sending a transaction that reads/writes it.
 */
export async function waitAccountExists(conn: Connection, pubkey: PublicKey, label: string, tries = 60, delayMs = 500): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const info = await conn.getAccountInfo(pubkey, "confirmed");
    if (info !== null) {
      console.log(`ok (poll): ${label} exists on ER (attempt ${attempt})`);
      return;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`timeout waiting for ${label} (${pubkey.toBase58()}) to exist`);
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

/** Promise-based delay, used by crank-fallback's tick loop (Task 14). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `getSignatureStatuses` instead of `Connection.confirmTransaction`
 * (Task 14 finding on mb-stack): every shape of `confirmTransaction` — the
 * deprecated single-signature string form included — races a
 * `signatureSubscribe` websocket notification against an internal timeout
 * (30s for `confirmed`). On this local ER validator that notification does
 * not reliably arrive (its ws port accepts connections fine; it just never
 * pushes the subscribed event), so `.rpc()` calls against `erConn` can stall
 * for tens of seconds waiting on it. Plain polling sidesteps the websocket
 * path entirely and is what this file's own `waitDelegated`/
 * `waitAccountExists` already do for the same reason.
 */
export async function confirmSignature(conn: Connection, sig: string, tries = 100, delayMs = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const status = value[0];
    if (status) {
      if (status.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return;
    }
    await sleep(delayMs);
  }
  throw new Error(`confirmSignature timeout waiting for ${sig}`);
}

/**
 * Sign, send, and confirm a single instruction without going through
 * `Connection.confirmTransaction`'s websocket-based strategies — see
 * `confirmSignature` above. Used for every ER-targeted send in trader.ts
 * (open/close/setPrice, plus onboarding's two ER calls) instead of Anchor's
 * `.rpc()`, which hit the same stall.
 */
export async function sendAndConfirmIx(
  conn: Connection,
  payer: Keypair,
  ix: TransactionInstruction,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash("processed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(ix);
  tx.sign(payer, ...extraSigners);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await confirmSignature(conn, sig);
  return sig;
}
