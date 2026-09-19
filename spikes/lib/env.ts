import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const BASE_RPC = process.env.BASE_RPC ?? "https://rpc.magicblock.app/devnet";
export const ROUTER = process.env.ROUTER ?? "https://devnet-router.magicblock.app/";
export const TEE_RPC = process.env.TEE_RPC ?? "https://devnet-tee.magicblock.app";
export const TEE_WS = process.env.TEE_WS ?? "wss://devnet-tee.magicblock.app";
export const TEE_VALIDATOR = new PublicKey(process.env.TEE_VALIDATOR ?? "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

export const baseConn = new Connection(BASE_RPC, "confirmed");

export function loadKeypair(name: "payer" | "user" | "stranger" | "session"): Keypair {
  const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "keys", `${name}.json`), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export async function routerStatus(account: PublicKey): Promise<{ isDelegated: boolean; fqdn?: string; delegationRecord?: { authority: string; owner: string } }> {
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

export async function rpcIdentity(url: string): Promise<PublicKey> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity", params: [] }),
  });
  if (!r.ok) throw new Error(`getIdentity HTTP ${r.status} from ${url}`);
  const body = await r.json();
  if (body.error) throw new Error(body.error.message);
  return new PublicKey(body.result.identity);
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}
