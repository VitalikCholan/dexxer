import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { POSITIONS_DISC_BYTES, pdas } from "../../../tests/er/lib/program.js";
import { POSITIONS_SIZE } from "../../../tests/er/lib/positions.js";
import {
  CRANK_TX_MAX_CANDIDATES,
  applyQuarantine,
  looksLikeOnChainFailure,
  candidatesFrom,
  chunkCandidates,
  liquidatedIn,
  pairAccounts,
  pairKey,
  shouldRetrySingly,
  splitPairKey,
  tickCandidates,
  type Candidate,
  type TickCandidatesDeps,
} from "../src/candidates.js";
import { classifyError } from "../src/errors.js";

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

test("liquidatedIn reports a candidate whose slot on the market is gone (the tick line logs only the count, I5)", () => {
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

// --- fix round 1 (F2): one bad pair must not starve the rest of its chunk ---
// Final review m1/m2/m6: the production classifier and real error strings;
// singles only after an ON-CHAIN chunk failure, and only once a
// zero-candidate probe proved the market itself is fine.

const cand = (): Candidate => ({ positions: k(), owner: k(), market: "m" });

test("applyQuarantine: hides a quarantined pair until its time is up, then releases it once", () => {
  const a = cand();
  const b = cand();
  const q = new Map<string, number>([[pairKey(a), 1_000]]);
  const early = applyQuarantine([a, b], q, 999);
  assert.deepEqual(early.kept, [b]);
  assert.deepEqual(early.released, []);
  const late = applyQuarantine([a, b], q, 1_000);
  assert.deepEqual(late.kept, [a, b]);
  assert.deepEqual(late.released, [pairKey(a)]);
  assert.equal(q.size, 0, "a released pair leaves the quarantine");
  assert.deepEqual(applyQuarantine([a, b], q, 2_000).released, [], "released only once");
});

test("pairKey is positions:market", () => {
  const a = cand();
  assert.equal(pairKey(a), `${a.positions.toBase58()}:m`);
});

test("splitPairKey gives back the positions and the market of a quarantine key (m3)", () => {
  const market = k().toBase58();
  const a: Candidate = { positions: k(), owner: k(), market };
  assert.deepEqual(splitPairKey(pairKey(a)), { positions: a.positions.toBase58(), market });
});

test("shouldRetrySingly: only a multi-candidate chunk that failed ON CHAIN (m2)", () => {
  assert.equal(shouldRetrySingly(3, true), true);
  assert.equal(shouldRetrySingly(3, false), false, "connection-class: every send would fail the same way, whoever is in it");
  assert.equal(shouldRetrySingly(1, true), false, "a single candidate already failed alone");
  assert.equal(shouldRetrySingly(0, true), false);
});

const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const ON_CHAIN_3002 = `transaction ${SIG} failed: {"InstructionError":[1,{"Custom":3002}]}`;
const TIMEOUT = `confirmSignature timeout waiting for ${SIG}`;
const deps = (send: (chunk: Candidate[]) => Promise<void>, q = new Map<string, number>(), extra: Partial<TickCandidatesDeps> = {}): TickCandidatesDeps => ({
  send, classify: classifyError, quarantine: q, now: 0, cooldownMs: 10, ...extra,
});
function fakeSend(bad: Set<Candidate>, fail?: (chunk: Candidate[]) => string | null) {
  const sent: Candidate[][] = [];
  const send = async (chunk: Candidate[]) => {
    sent.push(chunk);
    const custom = fail?.(chunk);
    if (custom) throw new Error(custom);
    if (chunk.some((c) => bad.has(c))) throw new Error(ON_CHAIN_3002);
  };
  return { sent, send };
}

test("tickCandidates: a bad pair fails its chunk ON CHAIN -> zero-candidate probe lands -> singles, only the bad pair quarantined", async () => {
  const good1 = cand();
  const bad = cand();
  const good2 = cand();
  const q = new Map<string, number>();
  const { sent, send } = fakeSend(new Set([bad]));
  const r = await tickCandidates([good1, bad, good2], deps(send, q, { now: 100, cooldownMs: 60_000 }));
  assert.deepEqual(sent, [[good1, bad, good2], [], [good1], [bad], [good2]]);
  assert.equal(r.landed, 3, "probe + two good singles");
  assert.equal(r.errors.length, 2);
  assert.deepEqual(r.quarantined, [pairKey(bad)]);
  assert.deepEqual([...q.entries()], [[pairKey(bad), 60_100]]);
  assert.equal(r.sharedError, false);
  assert.equal(r.marketFailed, false);
  // Next loop: the bad pair stays out, the others go together.
  const next = fakeSend(new Set([bad]));
  const r2 = await tickCandidates([good1, bad, good2], deps(next.send, q, { now: 200, cooldownMs: 60_000 }));
  assert.deepEqual(next.sent, [[good1, good2]]);
  assert.equal(r2.landed, 1);
});

test("tickCandidates: other chunks are still sent when one chunk fails on chain", async () => {
  const bad = cand();
  const rest = Array.from({ length: 3 }, cand);
  const { sent, send } = fakeSend(new Set([bad]));
  const r = await tickCandidates([bad, ...rest], deps(send, new Map(), { size: 2, cooldownMs: 1 }));
  assert.deepEqual(sent, [[bad, rest[0]], [], [bad], [rest[0]], [rest[1], rest[2]]]);
  assert.equal(r.landed, 3);
});

test("tickCandidates: a SHARED error (401) stops the market: no singles, no probe, no zero tick, nobody quarantined", async () => {
  const a = cand();
  const b = cand();
  const q = new Map<string, number>();
  const { sent, send } = fakeSend(new Set(), () => "401 Unauthorized");
  const r = await tickCandidates([a, b], deps(send, q));
  assert.deepEqual(sent, [[a, b]]);
  assert.equal(r.landed, 0);
  assert.equal(q.size, 0);
  assert.equal(r.sharedError, true);
});

test("tickCandidates: a MARKET-LOCAL chunk failure (confirm timeout) -> no singles, one zero-candidate tick, the market's later chunks skipped (R1)", async () => {
  const cands = Array.from({ length: 4 }, cand);
  const q = new Map<string, number>();
  const { sent, send } = fakeSend(new Set(), (chunk) => (chunk.length > 0 ? TIMEOUT : null));
  const r = await tickCandidates(cands, deps(send, q, { size: 2 }));
  assert.deepEqual(sent, [[cands[0], cands[1]], []], "zero tick once, then stop this market");
  assert.equal(r.landed, 1, "the zero tick advances mark and price sample");
  assert.equal(q.size, 0);
  assert.equal(r.sharedError, false);
  assert.equal(r.marketLocalError, true);
});

test("tickCandidates: a lone bad candidate -> probe lands -> quarantined (not resent alone)", async () => {
  const bad = cand();
  const q = new Map<string, number>();
  const { sent, send } = fakeSend(new Set([bad]));
  const r = await tickCandidates([bad], deps(send, q));
  assert.deepEqual(sent, [[bad], []]);
  assert.equal(r.landed, 1);
  assert.deepEqual(r.quarantined, [pairKey(bad)]);
});

test("tickCandidates: every candidate bad -> probe, then each quarantined; no second zero-candidate tick", async () => {
  const a = cand();
  const b = cand();
  const { sent, send } = fakeSend(new Set([a, b]));
  const r = await tickCandidates([a, b], deps(send));
  assert.deepEqual(sent, [[a, b], [], [a], [b]]);
  assert.equal(r.landed, 1);
  assert.deepEqual(r.quarantined.sort(), [pairKey(a), pairKey(b)].sort());
});

test("tickCandidates: market-wide on-chain failure -> the probe fails on chain too: no singles, no quarantine, the market's later chunks skipped (m1)", async () => {
  const cands = Array.from({ length: 4 }, cand);
  const q = new Map<string, number>();
  const { sent, send } = fakeSend(new Set(), () => ON_CHAIN_3002);
  const r = await tickCandidates(cands, deps(send, q, { size: 2 }));
  assert.deepEqual(sent, [[cands[0], cands[1]], []]);
  assert.equal(r.landed, 0);
  assert.equal(q.size, 0);
  assert.equal(r.marketFailed, true);
  assert.equal(r.sharedError, false);
});

test("tickCandidates: the probe failing for a SHARED reason stops the market as a shared error", async () => {
  const a = cand();
  const b = cand();
  const { sent, send } = fakeSend(new Set([a]), (chunk) => (chunk.length === 0 ? "fetch failed" : null));
  const r = await tickCandidates([a, b], deps(send));
  assert.deepEqual(sent, [[a, b], []]);
  assert.equal(r.sharedError, true);
  assert.equal(r.quarantined.length, 0);
});

test("tickCandidates: the probe failing market-locally (confirm timeout) fails the market, nobody blamed, not shared", async () => {
  const a = cand();
  const b = cand();
  const { sent, send } = fakeSend(new Set([a]), (chunk) => (chunk.length === 0 ? TIMEOUT : null));
  const r = await tickCandidates([a, b], deps(send));
  assert.deepEqual(sent, [[a, b], []]);
  assert.equal(r.sharedError, false);
  assert.equal(r.marketFailed, true);
  assert.equal(r.quarantined.length, 0);
});

test("tickCandidates: a shared error among the singles stops them", async () => {
  const a = cand();
  const b = cand();
  const c = cand();
  let singles = 0;
  const { sent, send } = fakeSend(new Set([a]), (chunk) => (chunk.length === 1 && ++singles === 2 ? "fetch failed" : null));
  const r = await tickCandidates([a, b, c], deps(send));
  assert.deepEqual(sent, [[a, b, c], [], [a], [b]], "c is not sent after b's shared error");
  assert.equal(r.sharedError, true);
  assert.deepEqual(r.quarantined, [pairKey(a)]);
});

test("tickCandidates: no candidates -> one zero-candidate tick; it failing leaves landed 0 and is not resent", async () => {
  const ok = fakeSend(new Set());
  assert.equal((await tickCandidates([], deps(ok.send))).landed, 1);
  assert.deepEqual(ok.sent, [[]]);
  const down = fakeSend(new Set(), () => "fetch failed");
  const r = await tickCandidates([], deps(down.send));
  assert.equal(r.landed, 0);
  assert.deepEqual(down.sent, [[]], "the empty tick is not resent");
  assert.equal(r.errors.length, 1);
  assert.equal(r.sharedError, true);
  const local = fakeSend(new Set(), () => TIMEOUT);
  const rl = await tickCandidates([], deps(local.send));
  assert.deepEqual(local.sent, [[]], "an empty tick failing market-locally is not resent");
  assert.equal(rl.marketLocalError, true);
  const onChain = fakeSend(new Set(), () => ON_CHAIN_3002);
  const r2 = await tickCandidates([], deps(onChain.send));
  assert.deepEqual(onChain.sent, [[]], "an empty tick failing on chain is not probed again");
  assert.equal(r2.marketFailed, true);
});

test("looksLikeOnChainFailure (re-exported from errors.ts): only a landed-and-rejected transaction", () => {
  assert.equal(looksLikeOnChainFailure(new Error(ON_CHAIN_3002)), true);
  assert.equal(looksLikeOnChainFailure(new Error("429 Too Many Requests")), false);
  assert.equal(looksLikeOnChainFailure(new Error(TIMEOUT)), false);
});

test("tickCandidates: an RPC error (429/5xx) is SHARED — no singles, no zero tick, nobody quarantined (m2, R1)", async () => {
  const a = cand();
  const b = cand();
  const q = new Map<string, number>();
  const { sent, send } = fakeSend(new Set(), (chunk) => (chunk.length > 0 ? "503 Service Unavailable" : null));
  const r = await tickCandidates([a, b], deps(send, q));
  assert.deepEqual(sent, [[a, b]], "no singles, no zero-candidate tick: the next send would fail the same way");
  assert.equal(q.size, 0);
  assert.equal(r.landed, 0);
  assert.equal(r.sharedError, true);
});
