import { rpcIdentity, TEE_RPC, TEE_VALIDATOR, assert } from "./lib/env.js";
const id = await rpcIdentity(TEE_RPC);
console.log("tee identity:", id.toBase58());
assert(id.equals(TEE_VALIDATOR), "TEE_VALIDATOR in .env matches getIdentity of devnet-tee");
