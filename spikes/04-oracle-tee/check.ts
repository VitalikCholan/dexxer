// spikes/04-oracle-tee/check.ts
import { PublicKey, Connection } from "@solana/web3.js";
import nacl from "tweetnacl";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, loadKeypair, assert } from "../lib/env.js";

// Constants confirmed from /tmp/mb-examples/binary-prediction/anchor/tests/binary-prediction.ts
// (ORACLE_PROGRAM_ID, PRICE_FEED_SEED = "price_feed", ORACLE_PROVIDER = "pyth-lazer", ORACLE_SYMBOL = "6").
// Verified SYMBOL "6" == SOL/USD by deriving the PDA locally and matching it against the
// SOL/USD address published in https://github.com/magicblock-labs/real-time-pricing-oracle README
// ("Example Price Feeds" table: SOL/USD -> ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu), which is
// exactly the PDA produced by seeds ["price_feed", "pyth-lazer", "6"] under ORACLE_PROGRAM_ID.
const ORACLE_PROGRAM_ID = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const PRICE_FEED_SEED = "price_feed";
const PROVIDER = "pyth-lazer";
const SYMBOL = "6"; // SOL/USD (Pyth Lazer numeric feed id)
const [feed] = PublicKey.findProgramAddressSync([Buffer.from(PRICE_FEED_SEED), Buffer.from(PROVIDER), Buffer.from(SYMBOL)], ORACLE_PROGRAM_ID);
console.log("feed", feed.toBase58());

// DECODING PATH (fallback, as anticipated by the task brief):
// 1) `@pythnetwork/pyth-solana-receiver`'s `PythSolanaReceiver` cannot even be imported in this
//    environment. Importing it pulls in `@pythnetwork/solana-utils` -> `jito-ts` -> a nested,
//    older `@solana/web3.js` copy whose `rpc-websocket.ts` does
//    `import ... from 'rpc-websockets/dist/lib/client'`. The hoisted top-level `rpc-websockets`
//    is v9.3.9, whose package.json "exports" map only exposes "." (node/browser conditions), not
//    that subpath, so Node throws ERR_PACKAGE_PATH_NOT_EXPORTED at import time, before any
//    account fetch happens. Reproduced with a bare
//    `import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver"`.
// 2) Fell back to `getAccountInfo` + manual decode using `@coral-xyz/borsh`'s `rustEnum` for the
//    `VerificationLevel` field, per the brief. That also failed: `@coral-xyz/borsh@0.31.1`'s
//    `rustEnum()` calls the installed `buffer-layout@1.2.2`'s `union(discr, property)` with only
//    2 args, but that version's `union(discr, defaultLayout, property)` takes 3 and treats the
//    2nd positional arg as `defaultLayout`, throwing
//    `TypeError: defaultLayout must be null or a Layout` — a real version incompatibility in
//    this repo's dependency tree, not a mistake in the layout itself.
// 3) Final fallback: decode the fixed-size PriceUpdateV2 account by hand with plain
//    Buffer reads, using the exact field layout from the receiver SDK's IDL
//    (node_modules/@pythnetwork/pyth-solana-receiver/dist/esm/idl/pyth_solana_receiver.d.ts):
//    8-byte Anchor discriminator, then { writeAuthority: pubkey(32),
//    verificationLevel: enum { Partial{numSignatures:u8} (tag 0) | Full (tag 1) },
//    priceMessage: { feedId:[u8;32], price:i64, conf:u64, exponent:i32, publishTime:i64,
//    prevPublishTime:i64, emaPrice:i64, emaConf:u64 }, postedSlot:u64 }.
//    This works regardless of which program owns the account (MagicBlock oracle program on the
//    TEE vs. the Pyth receiver program on base), since decoding only depends on the byte layout
//    matching, not on the owner.
function decodePriceUpdateV2(data: Buffer) {
  let o = 8; // skip 8-byte Anchor account discriminator
  const writeAuthority = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const verificationTag = data.readUInt8(o);
  o += 1;
  let verificationLevel: { kind: "partial"; numSignatures: number } | { kind: "full" };
  if (verificationTag === 0) {
    const numSignatures = data.readUInt8(o);
    o += 1;
    verificationLevel = { kind: "partial", numSignatures };
  } else if (verificationTag === 1) {
    verificationLevel = { kind: "full" };
  } else {
    throw new Error(`unexpected VerificationLevel tag ${verificationTag}`);
  }
  const verificationTagRaw = verificationTag;
  const feedId = Buffer.from(data.subarray(o, o + 32));
  o += 32;
  const price = data.readBigInt64LE(o);
  o += 8;
  const conf = data.readBigUInt64LE(o);
  o += 8;
  const exponent = data.readInt32LE(o);
  o += 4;
  const publishTime = data.readBigInt64LE(o);
  o += 8;
  const prevPublishTime = data.readBigInt64LE(o);
  o += 8;
  const emaPrice = data.readBigInt64LE(o);
  o += 8;
  const emaConf = data.readBigUInt64LE(o);
  o += 8;
  const postedSlot = data.readBigUInt64LE(o);
  o += 8;
  return {
    writeAuthority,
    verificationLevel,
    verificationTagRaw,
    priceMessage: { feedId, price, conf, exponent, publishTime, prevPublishTime, emaPrice, emaConf },
    postedSlot,
  };
}

const user = loadKeypair("user");
const tok = (await getAuthToken(TEE_RPC, user.publicKey, m => Promise.resolve(nacl.sign.detached(m, user.secretKey)))).token;
const tee = new Connection(`${TEE_RPC}?token=${tok}`, "confirmed");

async function read(conn: Connection, label: string) {
  const info = await conn.getAccountInfo(feed);
  if (!info) throw new Error(`${label}: account not found: ${feed.toBase58()}`);
  const acc = decodePriceUpdateV2(info.data);
  const now = Math.floor(Date.now() / 1000);
  const age = now - Number(acc.priceMessage.publishTime);
  console.log(label, {
    owner: info.owner.toBase58(),
    accountDataLength: info.data.length,
    writeAuthority: acc.writeAuthority.toBase58(),
    verificationLevelTag: acc.verificationTagRaw,
    numSignatures: acc.verificationLevel.kind === "partial" ? acc.verificationLevel.numSignatures : undefined,
    price: acc.priceMessage.price.toString(),
    expo: acc.priceMessage.exponent,
    conf: acc.priceMessage.conf.toString(),
    publishTime: acc.priceMessage.publishTime.toString(),
    postedSlot: acc.postedSlot.toString(),
    ageSec: age,
  });
  return { acc, age };
}
const base = await read(baseConn, "base");
const t1 = await read(tee, "tee#1");
await new Promise(r => setTimeout(r, 2000));
const t2 = await read(tee, "tee#2");

assert(t1.acc.postedSlot > 0n, "tee: posted_slot > 0");
assert(t1.age < 5, `tee: publish_time age < 5s (got ${t1.age})`);
assert(t1.acc.priceMessage.price > 0n, "tee: price > 0");
assert(t2.acc.priceMessage.publishTime !== t1.acc.priceMessage.publishTime, "tee: feed updates between reads (2s)");
console.log("CHECK 4 PASS");
