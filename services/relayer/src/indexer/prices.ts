// services/relayer/src/indexer/prices.ts
//
// Decodes the MagicBlock Pricing Oracle's Lazer price-update account bytes
// (SOL/USD feed, `pdas.feedUnder(ORACLE, LAZER_FEED_ID)`) — ported
// byte-for-byte from the Rust parser
// `programs/dexxer_core/src/oracle.rs::parse_price_update`. That file's own
// `#[cfg(test)]` module is the golden-vector source for
// `test/feed.test.ts`'s fixture, so both languages are pinned to the same
// offsets (controller ruling, task-5 brief).
//
// Layout (offsets are absolute byte positions in the account's raw data):
//
//   0..8    discriminator (ignored — this is a plain byte-offset reader,
//           not an Anchor coder, since the account is owned by the oracle
//           program, not dexxer_core)
//   8..40   write_authority (ignored)
//   40      tag: 0 = Partial (one extra byte — `num_signatures` — before
//           feed_id), 1 = Full (no extra byte). The real devnet feed and
//           `mock_oracle` both write tag=1.
//   ..+32   feed_id (ignored)
//   +8      price: i64 LE
//   +8      conf: u64 LE
//   +4      expo: i32 LE
//   +8      publish_time: i64 LE
//   +8      prev (ignored)
//   +8      ema (ignored)
//   +8      ema_conf (ignored)
//   +8      posted_slot: u64 LE
//   ...     trailing bytes ignored
//
// `price` is converted to a 1e6-scaled integer exactly the way the Rust
// side does: `price_1e6 = price * 1_000_000 / 10^|expo|` — always a
// division by 10^|expo| regardless of the sign of `expo` (verified against
// oracle.rs's own `negative_exponent_also_supported` test, which divides
// too, it does not multiply for a negative exponent).

export interface DecodedFeed {
  /** 1e6-scaled price. */
  price: bigint;
  /** Confidence, in basis points of price (ceil-rounded, matches oracle.rs). */
  confBps: number;
  publishTime: bigint;
  postedSlot: bigint;
}

const PRICE_SCALE = 1_000_000n;

function need(d: Buffer, offset: number, len: number): void {
  if (offset < 0 || offset + len > d.length) {
    throw new Error(`feed account truncated: need ${len} bytes at offset ${offset}, have ${d.length}`);
  }
}

export function decodeFeed(data: Buffer | Uint8Array): DecodedFeed {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  need(d, 40, 1);
  const tag = d.readUInt8(40);
  let o: number;
  if (tag === 0) o = 42; // Partial: 1 extra byte (num_signatures) before feed_id
  else if (tag === 1) o = 41; // Full
  else throw new Error(`unknown feed tag: ${tag}`);
  o += 32; // skip feed_id

  need(d, o, 8);
  const price = d.readBigInt64LE(o);
  o += 8;

  need(d, o, 8);
  const conf = d.readBigUInt64LE(o);
  o += 8;

  need(d, o, 4);
  const expo = d.readInt32LE(o);
  o += 4;

  need(d, o, 8);
  const publishTime = d.readBigInt64LE(o);
  o += 8;

  o += 8; // prev
  o += 8; // ema
  o += 8; // ema_conf

  need(d, o, 8);
  const postedSlot = d.readBigUInt64LE(o);

  if (price <= 0n) throw new Error("feed account: non-positive price");

  const priceScaled = price * PRICE_SCALE;
  const divisor = 10n ** BigInt(Math.abs(expo));
  const price1e6 = priceScaled / divisor; // truncates toward zero, matching the Rust checked_div
  if (price1e6 <= 0n) throw new Error("feed account: non-positive scaled price");

  // conf_bps = ceil(conf * 1e4 / price)
  const confBpsBig = (conf * 10_000n + (price - 1n)) / price;
  const confBps = confBpsBig > 0xffffffffn ? 0xffffffff : Number(confBpsBig);

  return { price: price1e6, confBps, publishTime, postedSlot };
}
