# Check 4 — Pricing Oracle SOL/USD freshness on devnet-tee

Status: PASS
Feed PDA (SOL/USD, `["price_feed","pyth-lazer","6"]` under `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`): `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu`
TEE owner: `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` (MagicBlock pricing oracle program). Base owner: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` (Pyth receiver push-oracle program, stale/zeroed on base devnet).
TEE reads: posted_slot > 0, price > 0, publish_time age < 5s (0-1s observed), publish_time advanced between the two TEE reads taken 2s apart.
Decision: MagicBlock's pricing oracle republishes the Pyth Lazer SOL/USD feed inside the TEE validator with fresh (sub-second) publish times. The liquidation design's dependency on this oracle is not blocked.

## Constants and their source

From `/tmp/mb-examples/binary-prediction/anchor/tests/binary-prediction.ts`:
```
const ORACLE_PROGRAM_ID = new web3.PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const PRICE_FEED_SEED = Buffer.from("price_feed");
const ORACLE_PROVIDER = "pyth-lazer";
const ORACLE_SYMBOL = "6";
```
The test does not itself label `"6"` as SOL/USD (it's the only feed the test uses). Confirmed it is SOL/USD by:
1. Fetching `https://github.com/magicblock-labs/real-time-pricing-oracle` README's "Example Price Feeds" table, which lists `SOL/USD | Pyth Lazer | ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu`.
2. Deriving the PDA locally with seeds `["price_feed", "pyth-lazer", "6"]` under `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` — it matches `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` exactly (verified with a throwaway script; also spot-checked symbols `"1"`, `"2"`, `"3"`, `"0"` against the README's BTC/USD, ETH/USD, USDC/USD rows — `"1"` matched BTC/USD).

So: `PRICE_FEED_SEED = "price_feed"`, `PROVIDER = "pyth-lazer"`, `SYMBOL = "6"` (SOL/USD).

## Decoding path used

The brief's primary path (`PythSolanaReceiver({connection, wallet}).receiver.account.priceUpdateV2.fetch(feed)`) could not be reached at all: **importing** `@pythnetwork/pyth-solana-receiver` throws before any RPC call is made.

1. **Primary path failed at import time.** `@pythnetwork/pyth-solana-receiver` depends on `@pythnetwork/solana-utils`, which depends on `jito-ts`, which bundles its own older `@solana/web3.js` copy. That copy's `src/rpc-websocket.ts` does `import RpcWebSocketCommonClient from 'rpc-websockets/dist/lib/client'`. The hoisted top-level `rpc-websockets` in `spikes/node_modules` is v9.3.9, whose `package.json` `"exports"` map only exposes `"."` (node/browser conditions) — not that subpath — so Node throws `ERR_PACKAGE_PATH_NOT_EXPORTED` as soon as the package is imported. Reproduced in isolation with a one-line `import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver"`.
2. **First fallback (borsh layout) also failed.** Per the brief, tried `getAccountInfo` + manual decode with `@coral-xyz/borsh`'s `rustEnum` for `VerificationLevel`. This also failed: the installed `@coral-xyz/borsh@0.31.1`'s `rustEnum()` calls `buffer-layout@1.2.2`'s `union(discr, property)` with 2 arguments, but that installed `buffer-layout` version's signature is `union(discr, defaultLayout, property)` (3 args) — the property string lands in the `defaultLayout` slot and the constructor throws `TypeError: defaultLayout must be null or a Layout`. This is a real version incompatibility in this repo's dependency tree between `@coral-xyz/borsh` and the hoisted `buffer-layout`, not a mistake in the layout definition.
3. **Final path used: `getAccountInfo` + manual byte-offset decode**, no additional library. `PriceUpdateV2`'s fixed-size layout (from `node_modules/@pythnetwork/pyth-solana-receiver/dist/esm/idl/pyth_solana_receiver.d.ts`) was decoded directly with `Buffer` reads: 8-byte Anchor discriminator, `writeAuthority` (pubkey, 32B), `verificationLevel` (1-byte tag: `0`=`Partial{numSignatures:u8}`, `1`=`Full`), then `priceMessage` (`feedId`[u8;32], `price` i64, `conf` u64, `exponent` i32, `publishTime` i64, `prevPublishTime` i64, `emaPrice` i64, `emaConf` u64), then `postedSlot` u64. Verified correct by a raw hex dump of the TEE account: total length 134 bytes = 8 + 32 + 1 (tag=1/Full, no extra byte) + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8 + 1 trailing pad byte, and `publishTime` decoded to a value matching "now" (age 0-1s), confirming byte alignment is correct.

## Raw values

Base read (`baseConn`, owner `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, Pyth receiver push-oracle program): `price=0, expo=8, conf=0, publishTime=1745852560, postedSlot=0, age≈43,942,427s`. The base-devnet account exists but is stale/never pushed to in this run (price and posted_slot are zero) — expected, since nothing on base devnet posts Pyth Lazer updates to this address; only the TEE oracle keeps it fresh.

TEE read #1 (owner `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`): `price=11253396381, expo=8, conf=0, publishTime=1789794987, postedSlot=317232099, age=0s`
TEE read #2 (2s later, same owner): `price=11252486431, expo=8, conf=0, publishTime=1789794989, postedSlot=317232145, age=1s`

publish_time advanced by 2s between TEE reads (`1789794987` → `1789794989`), posted_slot advanced by 46 slots, price moved slightly — all consistent with an actively-updating feed.

Note: `exponent` decoded as `+8` (not the conventional Pyth `-8`) in both TEE and base reads; verified by raw hex dump this is the literal on-chain value, not a decode bug (byte-for-byte: `08000000` at the documented exponent offset). Combined with the price magnitude (`~1.125e10`), the implied SOL/USD price is only sane under `price / 10^exponent` (≈ $112.5), not the standard `price * 10^exponent` convention. This is an observation about this oracle's exponent sign convention, out of scope for CHECK 4's freshness assertions (which do not depend on exponent), and does not affect the PASS verdict — but is worth a note for whoever later consumes this feed's price for real math.

## check.ts stdout

```
feed ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu
base {
  owner: 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh',
  price: '0',
  expo: 8,
  conf: '0',
  publishTime: '1745852560',
  postedSlot: '0',
  ageSec: 43942427
}
tee#1 {
  owner: 'PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd',
  price: '11253396381',
  expo: 8,
  conf: '0',
  publishTime: '1789794987',
  postedSlot: '317232099',
  ageSec: 0
}
tee#2 {
  owner: 'PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd',
  price: '11252486431',
  expo: 8,
  conf: '0',
  publishTime: '1789794989',
  postedSlot: '317232145',
  ageSec: 1
}
ok: tee: posted_slot > 0
ok: tee: publish_time age < 5s (got 0)
ok: tee: price > 0
ok: tee: feed updates between reads (2s)
CHECK 4 PASS
```
