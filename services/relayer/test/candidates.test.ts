import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { POSITIONS_DISC_BYTES, pdas } from "../../../tests/er/lib/program.js";
import { POSITIONS_SIZE } from "../../../tests/er/lib/positions.js";
import { CRANK_TX_MAX_CANDIDATES, candidatesFrom, chunkCandidates, liquidatedIn, pairAccounts, type Candidate } from "../src/candidates.js";

const k = () => Keypair.generate().publicKey;
function positionsBytes(owner: PublicKey, open: PublicKey[]): Buffer {
  const b = Buffer.alloc(POSITIONS_SIZE);
  POSITIONS_DISC_BYTES.copy(b, 0);
  owner.toBuffer().copy(b, 8);
  open.forEach((m, i) => {
    const at = 8 + 32 + i * 96;
    m.toBuffer().copy(b, at);
    b.writeUInt8(1, at + 88);
  });
  return b;
}

test("one Positions account yields one candidate per open slot, keyed by market", () => {
  const owner = k();
  const sol = k();
  const btc = k();
  const key = k();
  const c = candidatesFrom([{ pubkey: key, data: positionsBytes(owner, [sol, btc]) }]);
  assert.deepEqual(c.map((x) => x.market).sort(), [sol.toBase58(), btc.toBase58()].sort());
  assert.ok(c.every((x) => x.positions.equals(key) && x.owner.equals(owner)));
});

test("an account with no open slot yields nothing", () => {
  assert.deepEqual(candidatesFrom([{ pubkey: k(), data: positionsBytes(k(), []) }]), []);
});

test("garbage among the accounts is skipped and reported, the rest survive", () => {
  const good = k();
  const short = k();
  const foreign = k();
  const bad = positionsBytes(k(), [k()]);
  bad.writeUInt8(bad[0] ^ 0xff, 0);
  const skipped: string[] = [];
  const c = candidatesFrom(
    [
      { pubkey: short, data: Buffer.alloc(100) },
      { pubkey: good, data: positionsBytes(k(), [k()]) },
      { pubkey: foreign, data: bad },
    ],
    (p) => skipped.push(p.toBase58()),
  );
  assert.deepEqual(c.map((x) => x.positions.toBase58()), [good.toBase58()]);
  assert.deepEqual(skipped.sort(), [short.toBase58(), foreign.toBase58()].sort());
});

test("pairAccounts emits [Positions, UserAccount] per candidate, both writable", () => {
  const a: Candidate = { positions: k(), owner: k(), market: k().toBase58() };
  const metas = pairAccounts([a], (o) => pdas.userAccount(o));
  assert.deepEqual(metas.map((m) => m.pubkey.toBase58()), [a.positions.toBase58(), pdas.userAccount(a.owner).toBase58()]);
  assert.ok(metas.every((m) => m.isWritable && !m.isSigner));
});

test("chunkCandidates: at least one chunk, none above the limit, none lost, no pair twice in a chunk", () => {
  assert.deepEqual(chunkCandidates([]), [[]]);
  const many = Array.from({ length: CRANK_TX_MAX_CANDIDATES * 2 + 1 }, () => ({ positions: k(), owner: k(), market: "m" }));
  const chunks = chunkCandidates(many);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.length <= CRANK_TX_MAX_CANDIDATES));
  assert.equal(chunks.flat().length, many.length);
  for (const c of chunks) assert.equal(new Set(c.map((x) => x.positions.toBase58())).size, c.length);
});

test("liquidatedIn reports a candidate whose slot on the market is gone", () => {
  const market = k();
  const owner = k();
  const c: Candidate = { positions: k(), owner, market: market.toBase58() };
  assert.deepEqual(liquidatedIn([c], [positionsBytes(owner, [market])]), []);
  assert.deepEqual(liquidatedIn([c], [positionsBytes(owner, [k()])]), [c.positions.toBase58()], "open elsewhere only");
  assert.deepEqual(liquidatedIn([c], [null]), [], "an unreadable account is not reported as liquidated");
});

test("a full chunk fits a transaction and one more candidate does not", () => {
  const size = (n: number): number => {
    const keys = [k(), k(), k(), k(), k(), k()].map((pubkey, i) => ({ pubkey, isWritable: i > 1, isSigner: i === 0 }));
    const rem = pairAccounts(Array.from({ length: n }, () => ({ positions: k(), owner: k(), market: "m" })), () => k());
    const ix = new TransactionInstruction({ programId: k(), keys: [...keys, ...rem], data: Buffer.alloc(8) });
    const tx = new Transaction({ feePayer: keys[0].pubkey, recentBlockhash: "11111111111111111111111111111111" })
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(ix);
    // Wire size = shortvec(signature count) + 64 B per signature + message.
    // Measured from the message because `Transaction.serialize` throws
    // ("Transaction too large") instead of returning a size above 1232.
    const msg = tx.serializeMessage();
    return 1 + 64 * msg[0] + msg.length;
  };
  assert.ok(CRANK_TX_MAX_CANDIDATES <= 16, "program cap");
  assert.ok(size(CRANK_TX_MAX_CANDIDATES) <= 1232, `full chunk is ${size(CRANK_TX_MAX_CANDIDATES)} B`);
  if (CRANK_TX_MAX_CANDIDATES < 16) assert.ok(size(CRANK_TX_MAX_CANDIDATES + 1) > 1232, "the limit is the largest that fits");
});

test("the same market twice in one account (or the same account listed twice) yields one candidate, never a repeated pair", () => {
  const owner = k();
  const key = k();
  const sol = k();
  const data = positionsBytes(owner, [sol, sol]);
  const c = candidatesFrom([{ pubkey: key, data }, { pubkey: key, data }]);
  assert.deepEqual(c.map((x) => [x.positions.toBase58(), x.market]), [[key.toBase58(), sol.toBase58()]]);
});
