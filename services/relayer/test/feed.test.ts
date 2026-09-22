// services/relayer/test/feed.test.ts
//
// `decodeFeed` (src/indexer/prices.ts) is ported byte-for-byte from the Rust
// parser `programs/dexxer_core/src/oracle.rs::parse_price_update` — that
// file's own `#[cfg(test)] mod tests` is the golden-vector source. The
// fixture builder below reproduces its `fixture(price, conf, expo, publish,
// posted)` helper (tag=1 "Full" layout) so the expected numbers here are
// copy-pasted from the Rust assertions, pairing both languages against the
// same offsets per the task brief.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFeed } from "../src/indexer/prices.js";

/** Mirrors oracle.rs's `fixture()`: 8 disc | 32 write_authority(0) | tag=1 | 32 feed_id | i64 price | u64 conf | i32 expo | i64 publish | i64 prev | i64 ema | u64 ema_conf | u64 posted | 1 trailing = 134 bytes. */
function fixture(price: bigint, conf: bigint, expo: number, publish: bigint, posted: bigint): Buffer {
  const d = Buffer.alloc(134);
  let o = 0;
  Buffer.from([234, 161, 14, 36, 172, 239, 15, 232]).copy(d, o); // discriminator (ignored)
  o += 8;
  o += 32; // write_authority, zeroed
  d.writeUInt8(1, o); // tag = 1 (Full)
  o += 1;
  Buffer.alloc(32, 0xc6).copy(d, o); // feed_id (ignored)
  o += 32;
  d.writeBigInt64LE(price, o);
  o += 8;
  d.writeBigUInt64LE(conf, o);
  o += 8;
  d.writeInt32LE(expo, o);
  o += 4;
  d.writeBigInt64LE(publish, o); // publish_time
  o += 8;
  d.writeBigInt64LE(publish, o); // prev
  o += 8;
  d.writeBigInt64LE(price, o); // ema
  o += 8;
  d.writeBigUInt64LE(conf, o); // ema_conf
  o += 8;
  d.writeBigUInt64LE(posted, o); // posted_slot
  return d;
}

test("decodeFeed: expo=+8 divisor — mirrors oracle.rs::parses_expo_plus_8_as_divisor", () => {
  const f = decodeFeed(fixture(11_282_999_668n, 5_000_000n, 8, 1_700_000_000n, 317_000_000n));
  assert.equal(f.price, 112_829_996n);
  assert.equal(f.postedSlot, 317_000_000n);
});

test("decodeFeed: conf_bps rounds up (ceil) — mirrors oracle.rs::conf_in_bps_rounds_up", () => {
  const f = decodeFeed(fixture(10_000_000_000n, 5_000_001n, 8, 0n, 1n));
  assert.equal(f.confBps, 6);
});

test("decodeFeed: negative exponent still divides — mirrors oracle.rs::negative_exponent_also_supported", () => {
  const f = decodeFeed(fixture(100_000_000n, 0n, -8, 0n, 1n));
  assert.equal(f.price, 1_000_000n);
});

test("decodeFeed: mock_oracle layout produces the same numbers — mirrors oracle.rs::mock_layout_matches_parser", () => {
  const f = decodeFeed(fixture(15_000_000_000n, 5_000_000n, 8, 1_700_000_000n, 317_000_000n));
  assert.equal(f.price, 150_000_000n);
  assert.equal(f.postedSlot, 317_000_000n);
  assert.equal(f.publishTime, 1_700_000_000n);
});

test("decodeFeed: too-short buffer throws — mirrors oracle.rs::too_short_is_error", () => {
  const short = fixture(1n, 0n, 8, 0n, 1n).subarray(0, 100);
  assert.throws(() => decodeFeed(short));
});

test("decodeFeed: non-positive price throws — mirrors oracle.rs::nonpositive_price_is_error", () => {
  assert.throws(() => decodeFeed(fixture(0n, 0n, 8, 0n, 1n)));
});

test("decodeFeed: unknown tag byte throws", () => {
  const d = fixture(1n, 0n, 8, 0n, 1n);
  d.writeUInt8(2, 40); // tag=2 is neither Partial(0) nor Full(1)
  assert.throws(() => decodeFeed(d));
});
