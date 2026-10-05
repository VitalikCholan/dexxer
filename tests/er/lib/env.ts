// tests/er/lib/env.ts
//
// Shared environment/config for Task 13's mb-stack (local Ephemeral Rollup)
// scenarios: RPC endpoints, the ER validator identity, keypair
// loading/persistence under `.keys/`, airdrop, and a poll helper for
// delegation to land on L1 before sending ER transactions.
//
// No `dotenv` package is installed in this package (see package.json), so
// `.env` is parsed by hand here rather than pulling in a new dependency.
//
// Task 0 (week 2) adds a `DEXXER_NET=local|devnet` profile (default
// `local`, so every value below is byte-identical to week 1 when the env
// var is unset) plus `ROUTER`/`routerStatus` and `teeConn` for real devnet +
// `devnet-tee.magicblock.app`. Addresses for the `devnet` profile are the
// ones fixed in `docs/superpowers/plans/weeks0-5-history.md#week-2`
// (Global Constraints) and already spiked in `spikes/lib/env.ts` (week 0).

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { DELEGATION_PROGRAM_ID, getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";

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

export type Net = "local" | "devnet";
export const NET: Net = cfg("DEXXER_NET", "local") === "devnet" ? "devnet" : "local";

interface NetProfile {
  base: string;
  er: string;
  erWs: string;
  public: string;
  router: string;
  validator: string;
  /** Oracle *program* id passed to `init_config`'s `oracle_program` arg. */
  oracle: string;
}

// `local` reproduces week 1's literals exactly (mb-stack defaults); `devnet`
// is the real cluster + TEE rollup. Any single value can still be
// overridden via `.env`/process.env regardless of profile (see `cfg` calls
// below) — this table only supplies the per-profile default.
const PROFILES: Record<Net, NetProfile> = {
  local: {
    base: "http://127.0.0.1:8899",
    er: "http://127.0.0.1:7799",
    erWs: "ws://127.0.0.1:7800",
    public: "http://127.0.0.1:6699",
    router: "http://127.0.0.1:6699", // mb-stack's query-filtering service also answers getDelegationStatus (see weeks0-5-history.md#week-1)
    validator: "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev",
    oracle: "68xBWNR1uKorC7keLWvsT1pCmKC4RnwvRF4LoV3CCprh", // mock_oracle program id (localnet/LiteSVM only)
  },
  devnet: {
    base: "https://rpc.magicblock.app/devnet",
    er: "https://devnet-tee.magicblock.app",
    erWs: "wss://devnet-tee.magicblock.app",
    public: "https://rpc.magicblock.app/devnet",
    router: "https://devnet-router.magicblock.app/",
    validator: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
    oracle: "PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd", // MagicBlock Pricing Oracle (real Pyth Lazer feed)
  },
};
const profile = PROFILES[NET];

export const BASE = cfg("BASE_RPC", profile.base);
export const ER = cfg("ER_RPC", profile.er);
export const ER_WS = cfg("ER_WS", profile.erWs);
export const PUBLIC = cfg("PUBLIC_RPC", profile.public);
export const ROUTER = cfg("ROUTER_RPC", profile.router);
export const ER_VALIDATOR = new PublicKey(cfg("ER_VALIDATOR", profile.validator));
export const ORACLE = new PublicKey(cfg("ORACLE_PROGRAM", profile.oracle));

export const baseConn = new Connection(BASE, "confirmed");
export const erConn = new Connection(ER, "confirmed");

/**
 * A `Connection` authorized to read/write this keypair's permissioned
 * accounts in the ER. Locally `erConn` is already unauthenticated (mb-stack
 * has no TEE token check), so this just returns it unchanged. On devnet the
 * TEE rollup requires a `?token=` from `getAuthToken` (message signed by the
 * keypair) on both the HTTP and WS endpoints — see
 * `spikes/07-session-payer/check.ts` for the week-0 spike this mirrors.
 */
export async function teeConn(kp: Keypair): Promise<Connection> {
  if (NET === "local") return erConn;
  const auth = await getAuthToken(ER, kp.publicKey, async (m) => nacl.sign.detached(m, kp.secretKey));
  return new Connection(`${ER}?token=${auth.token}`, {
    wsEndpoint: `${ER_WS}?token=${auth.token}`,
    commitment: "confirmed",
  });
}

/**
 * Query the MagicBlock router's `getDelegationStatus` for `account` (spec
 * §5's `router` endpoint). Used to confirm a PDA delegated to `fqdn` ==
 * the expected TEE endpoint. Same shape as `spikes/lib/env.ts`'s
 * `routerStatus`, generalized over `ROUTER` for both profiles.
 */
export async function routerStatus(
  account: PublicKey,
): Promise<{ isDelegated: boolean; fqdn?: string; delegationRecord?: { authority: string; owner: string } }> {
  const r = await fetch(ROUTER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [account.toBase58()] }),
  });
  if (!r.ok) throw new Error(`getDelegationStatus HTTP ${r.status} from ${ROUTER}`);
  const body = await r.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

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
