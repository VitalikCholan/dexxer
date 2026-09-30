import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEXXER_CORE_PROGRAM_ID, POSITIONS_DISC_BYTES, pdas } from "../../../tests/er/lib/program.js";
import { HISTORY_LEN, MAX_SLOTS, POSITIONS_SIZE, decodePositions, liqTaskId, slotFor } from "../../../tests/er/lib/positions.js";

const SLOTS = 8 + 32;
const HISTORY = 8 + 1568;
const HEAD = 8 + 3104;

function blank(owner: PublicKey): Buffer {
  const b = Buffer.alloc(POSITIONS_SIZE);
  POSITIONS_DISC_BYTES.copy(b, 0);
  owner.toBuffer().copy(b, 8);
  b.writeUInt8(1, 8 + 3106); // version
  b.writeUInt8(254, 8 + 3107); // bump
  return b;
}
function putSlot(b: Buffer, i: number, market: PublicKey, o: { size: bigint; margin: bigint; side: number; liqTicks?: number; state?: number }): void {
  const at = SLOTS + i * 96;
  market.toBuffer().copy(b, at);
  b.writeBigUInt64LE(o.size, at + 32);
  b.writeBigUInt64LE(150_000_000n, at + 40);
  b.writeBigUInt64LE(o.margin, at + 48);
  b.writeBigUInt64LE(140_000_000n, at + 56);
  b.writeBigUInt64LE(77n, at + 64);
  b.writeBigUInt64LE(1_500_000_000n, at + 72);
  b.writeBigUInt64LE(5n, at + 80);
  b.writeUInt8(o.state ?? 1, at + 88);
  b.writeUInt8(o.side, at + 89);
  b.writeUInt8(o.liqTicks ?? 0, at + 90);
}
function putHistory(b: Buffer, i: number, closedSlot: bigint, pnl: bigint, reason: number): void {
  const at = HISTORY + i * 96;
  Keypair.generate().publicKey.toBuffer().copy(b, at);
  b.writeBigUInt64LE(10n, at + 32);
  b.writeBigInt64LE(pnl, at + 56);
  b.writeBigUInt64LE(closedSlot, at + 80);
  b.writeUInt8(1, at + 88);
  b.writeUInt8(reason, at + 89);
}

test("decodePositions returns only open slots, with their index and fields", () => {
  const owner = Keypair.generate().publicKey;
  const sol = Keypair.generate().publicKey;
  const btc = Keypair.generate().publicKey;
  const b = blank(owner);
  putSlot(b, 0, sol, { size: 10n, margin: 150n, side: 0 });
  putSlot(b, 3, btc, { size: 7n, margin: 80n, side: 1, liqTicks: 1 });
  putSlot(b, 5, Keypair.generate().publicKey, { size: 1n, margin: 1n, side: 0, state: 0 }); // residue in an EMPTY slot
  const p = decodePositions(b);
  assert.equal(p.owner.toBase58(), owner.toBase58());
  assert.deepEqual(p.slots.map((s) => s.index), [0, 3]);
  assert.equal(p.slots[1].market.toBase58(), btc.toBase58());
  assert.equal(p.slots[1].side, "short");
  assert.equal(p.slots[1].liqTicks, 1);
  assert.equal(p.slots[0].entry, 150_000_000n);
  assert.equal(p.slots[0].oiNotional, 1_500_000_000n);
  assert.equal(p.slots[0].lastLiqSample, 5n);
  assert.equal(slotFor(p, btc)?.index, 3);
  assert.equal(slotFor(p, Keypair.generate().publicKey), null);
  assert.equal(p.version, 1);
  assert.equal(p.bump, 254);
});

test("history comes back oldest first, before and after the ring wraps", () => {
  const b = blank(Keypair.generate().publicKey);
  for (let i = 0; i < 3; i++) putHistory(b, i, BigInt(100 + i), -5n, i);
  b.writeUInt8(3, HEAD); // head = next write index
  b.writeUInt8(3, HEAD + 1); // len
  const p = decodePositions(b);
  assert.deepEqual(p.history.map((h) => h.closedSlot), [100n, 101n, 102n]);
  assert.deepEqual(p.history.map((h) => h.reason), ["user", "liquidated", "decrease"]);
  assert.equal(p.history[0].pnl, -5n);
  assert.equal(p.history[0].side, "short");

  const w = blank(Keypair.generate().publicKey);
  for (let i = 0; i < HISTORY_LEN; i++) putHistory(w, i, BigInt(200 + i), 0n, 0);
  putHistory(w, 0, 300n, 0n, 0); // the 17th close overwrote record 0
  w.writeUInt8(1, HEAD);
  w.writeUInt8(HISTORY_LEN, HEAD + 1);
  const q = decodePositions(w);
  assert.equal(q.history.length, HISTORY_LEN);
  assert.equal(q.history[0].closedSlot, 201n, "oldest surviving record");
  assert.equal(q.history[HISTORY_LEN - 1].closedSlot, 300n, "newest record last");
});

test("decodePositions refuses a wrong length and a foreign discriminator", () => {
  const b = blank(Keypair.generate().publicKey);
  assert.throws(() => decodePositions(b.subarray(0, POSITIONS_SIZE - 1)), /length/);
  const foreign = Buffer.from(b);
  foreign.writeUInt8(foreign[0] ^ 0xff, 0);
  assert.throws(() => decodePositions(foreign), /discriminator/);
  assert.equal(MAX_SLOTS, 16);
});

test("pdas.positions is seeded by the owner only", () => {
  const owner = Keypair.generate().publicKey;
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from("positions"), owner.toBuffer()], DEXXER_CORE_PROGRAM_ID);
  assert.equal(pdas.positions(owner).toBase58(), expected.toBase58());
});

test("liqTaskId matches the program's golden vector and depends on argument order", () => {
  const positions = new PublicKey(Buffer.alloc(32, 1));
  const market = new PublicKey(Buffer.alloc(32, 2));
  assert.equal(liqTaskId(positions, market), 1387748199796337972n);
  assert.equal(liqTaskId(market, positions), 4965387733951305052n);
});
