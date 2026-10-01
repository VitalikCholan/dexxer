import { test } from "node:test";
import assert from "node:assert/strict";
import { BN, BorshAccountsCoder } from "@coral-xyz/anchor";
import { DEXXER_CORE_IDL } from "../../../tests/er/lib/program.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEXXER_CORE_PROGRAM_ID, USER_DISC, dexxerCoreProgram, pdas } from "../../../tests/er/lib/program.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import bs58 from "bs58";
import {
  EXITED_OFFSET, JANITOR_MAX_ATTEMPTS_PER_CYCLE, createJanitorState, janitorDeps, runJanitorCycle, type ExitedOwner, type JanitorDeps,
} from "../src/janitor.js";

// Final review m6: the production classifier decides, so the fakes throw the
// real strings — an on-chain rejection puts one owner on a cooldown, a SHARED
// error (auth, fetch failed, 429, 5xx) aborts the pass, anything else
// (market-local, e.g. a confirm timeout) counts the attempt and goes on, no
// cooldown (fix round 2, R1.5).
const ON_CHAIN = 'transaction 5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW failed: {"InstructionError":[0,{"Custom":6000}]}';

const k = () => Keypair.generate().publicKey;
function fakes(owners: ExitedOwner[], home: Set<string>, failing = new Set<string>()) {
  const closed: ExitedOwner[] = [];
  const deps: JanitorDeps = {
    listExitedOwners: async () => owners,
    bothUnderProgram: async (o: PublicKey) => home.has(o.toBase58()),
    closeExitedUser: async (o) => {
      if (failing.has(o.owner.toBase58())) throw new Error(ON_CHAIN);
      closed.push(o);
      return `sig-${o.owner.toBase58().slice(0, 4)}`;
    },
    feePayerLamports: async () => 1_000_000_000,
    log: () => {},
  };
  return { deps, closed };
}

test("closes an exited owner whose two accounts are back under the program, rent to the recorded payer", async () => {
  const o = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([o], new Set([o.owner.toBase58()]));
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.deepEqual(r, { scanned: 1, closed: [o.owner.toBase58()], skipped: 0, cooledDown: 0, errors: [], aborted: false, lowBalance: false });
  assert.equal(closed[0].rentPayer.toBase58(), o.rentPayer.toBase58());
});

test("an owner whose accounts are still delegated is skipped, not closed", async () => {
  const o = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([o], new Set());
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.equal(closed.length, 0);
  assert.deepEqual([r.scanned, r.skipped, r.closed.length], [1, 1, 0]);
});

test("one failing close does not stop the others", async () => {
  const a = { owner: k(), rentPayer: k() };
  const b = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([a, b], new Set([a.owner.toBase58(), b.owner.toBase58()]), new Set([a.owner.toBase58()]));
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.deepEqual(closed.map((c) => c.owner.toBase58()), [b.owner.toBase58()]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /Custom":6000/);
});

test("at most JANITOR_MAX_ATTEMPTS_PER_CYCLE successful closes per cycle", async () => {
  const owners = Array.from({ length: JANITOR_MAX_ATTEMPTS_PER_CYCLE + 3 }, () => ({ owner: k(), rentPayer: k() }));
  const { deps, closed } = fakes(owners, new Set(owners.map((o) => o.owner.toBase58())));
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.equal(closed.length, JANITOR_MAX_ATTEMPTS_PER_CYCLE);
  assert.equal(r.scanned, owners.length);
});

test("a failing scan yields an error result, never a throw", async () => {
  const { deps } = fakes([], new Set());
  deps.listExitedOwners = async () => {
    throw new Error("rpc down");
  };
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.deepEqual([r.scanned, r.closed.length], [0, 0]);
  assert.match(r.errors[0], /rpc down/);
});

test("failed attempts count toward the cap", async () => {
  const bad = Array.from({ length: JANITOR_MAX_ATTEMPTS_PER_CYCLE }, () => ({ owner: k(), rentPayer: k() }));
  const good = Array.from({ length: 3 }, () => ({ owner: k(), rentPayer: k() }));
  const all = [...bad, ...good];
  const { deps } = fakes(all, new Set(all.map((o) => o.owner.toBase58())), new Set(bad.map((o) => o.owner.toBase58())));
  let calls = 0;
  const inner = deps.closeExitedUser;
  deps.closeExitedUser = async (o) => {
    calls += 1;
    return inner(o);
  };
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.equal(calls, JANITOR_MAX_ATTEMPTS_PER_CYCLE);
  assert.equal(r.errors.length, JANITOR_MAX_ATTEMPTS_PER_CYCLE);
  assert.equal(r.closed.length, 0);
});

test("a failed owner is in cooldown, retried after it; a success clears the entry", async () => {
  const o = { owner: k(), rentPayer: k() };
  const failing = new Set([o.owner.toBase58()]);
  const { deps, closed } = fakes([o], new Set([o.owner.toBase58()]), failing);
  const state = createJanitorState();
  let t = 1_000;
  const opts = { state, cooldownMs: 5_000, now: () => t };
  let r = await runJanitorCycle(deps, opts);
  assert.equal(r.errors.length, 1);
  t += 1_000;
  r = await runJanitorCycle(deps, opts);
  assert.deepEqual([r.cooledDown, r.errors.length, r.skipped], [1, 0, 0]);
  t += 5_000;
  failing.delete(o.owner.toBase58());
  r = await runJanitorCycle(deps, opts);
  assert.deepEqual(r.closed, [o.owner.toBase58()]);
  assert.equal(closed.length, 1);
  assert.equal(state.failedAt.has(o.owner.toBase58()), false);
});

test("not-yet-home owner sets no cooldown", async () => {
  const o = { owner: k(), rentPayer: k() };
  const { deps } = fakes([o], new Set());
  const state = createJanitorState();
  await runJanitorCycle(deps, { state });
  assert.equal(state.failedAt.size, 0);
});

test("EXITED_OFFSET is the only byte that differs between exited=true/false encodings", async () => {
  const coder = new BorshAccountsCoder(DEXXER_CORE_IDL);
  const base = {
    version: 3, owner: k(), session_key: k(), session_expiry: new BN(7), actions_left: 5, free_margin: new BN(1), locked_margin: new BN(2),
    last_withdraw_slot: new BN(3), exit_salt: Array(32).fill(9), bump: 254, rent_payer: k(), _reserved: Array(32).fill(0),
  };
  const a = await coder.encode("UserAccount", { ...base, exited: true });
  const b = await coder.encode("UserAccount", { ...base, exited: false });
  assert.equal(a.length, b.length);
  const diff = [...a.keys()].filter((i) => a[i] !== b[i]);
  assert.deepEqual(diff, [EXITED_OFFSET]);
  assert.equal(a[EXITED_OFFSET], 1);
  assert.equal(b[EXITED_OFFSET], 0);
});

// --- final review I1: the janitor never hammers a sick RPC, never spends below a floor ---

test("a SHARED failure aborts the pass: no cooldown for that owner, the rest not attempted, reported in errors", async () => {
  const a = { owner: k(), rentPayer: k() };
  const b = { owner: k(), rentPayer: k() };
  for (const msg of ["401 Unauthorized", "fetch failed", "429 Too Many Requests", "502 Bad Gateway"]) {
    const { deps, closed } = fakes([a, b], new Set([a.owner.toBase58(), b.owner.toBase58()]));
    deps.closeExitedUser = async (o) => {
      if (o.owner.equals(a.owner)) throw new Error(msg);
      closed.push(o);
      return "sig";
    };
    const state = createJanitorState();
    const r = await runJanitorCycle(deps, { state });
    assert.equal(r.aborted, true, msg);
    assert.equal(closed.length, 0, `${msg}: b is not attempted after the abort`);
    assert.equal(state.failedAt.size, 0, `${msg}: no cooldown — the owner is not at fault`);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /aborted/);
  }
});

test("any other failure (confirm timeout) counts the attempt, sets no cooldown and the pass goes on (R1.5)", async () => {
  const a = { owner: k(), rentPayer: k() };
  const b = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([a, b], new Set([a.owner.toBase58(), b.owner.toBase58()]));
  let calls = 0;
  deps.closeExitedUser = async (o) => {
    calls += 1;
    if (o.owner.equals(a.owner)) throw new Error("confirmSignature timeout waiting for 5abc");
    closed.push(o);
    return "sig";
  };
  const state = createJanitorState();
  const r = await runJanitorCycle(deps, { state, maxAttempts: 2 });
  assert.equal(r.aborted, false);
  assert.equal(calls, 2, "both attempted — the failed one counted toward the cap");
  assert.deepEqual(closed.map((c) => c.owner.toBase58()), [b.owner.toBase58()]);
  assert.equal(state.failedAt.size, 0, "no cooldown");
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /confirmSignature timeout/);
});

test("a SHARED failure of the delegation check aborts the pass too", async () => {
  const a = { owner: k(), rentPayer: k() };
  const { deps } = fakes([a], new Set([a.owner.toBase58()]));
  deps.bothUnderProgram = async () => {
    throw new TypeError("fetch failed");
  };
  const state = createJanitorState();
  const r = await runJanitorCycle(deps, { state });
  assert.equal(r.aborted, true);
  assert.equal(state.failedAt.size, 0);
});

test("fee payer below the floor: the whole pass is skipped (not even scanned)", async () => {
  const o = { owner: k(), rentPayer: k() };
  const { deps, closed } = fakes([o], new Set([o.owner.toBase58()]));
  let scanned = false;
  const list = deps.listExitedOwners;
  deps.listExitedOwners = async () => {
    scanned = true;
    return list();
  };
  deps.feePayerLamports = async () => 1_999_999;
  const r = await runJanitorCycle(deps, { state: createJanitorState(), minFeePayerLamports: 2_000_000 });
  assert.equal(r.lowBalance, true);
  assert.equal(scanned, false);
  assert.equal(closed.length, 0);
  assert.match(r.errors[0], /below/);
  deps.feePayerLamports = async () => 2_000_000;
  const ok = await runJanitorCycle(deps, { state: createJanitorState(), minFeePayerLamports: 2_000_000 });
  assert.equal(ok.lowBalance, false);
  assert.equal(closed.length, 1, "at the floor the pass runs");
});

test("a failing balance read aborts the pass with an error, never a throw", async () => {
  const { deps } = fakes([], new Set());
  deps.feePayerLamports = async () => {
    throw new Error("503 Service Unavailable");
  };
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.equal(r.aborted, true);
  assert.match(r.errors[0], /503/);
});

// --- final review I7: janitorDeps against a fake connection ---

test("janitorDeps.listExitedOwners: dataSize + discriminator + exited=1 filters; decodes owner and rent_payer", async () => {
  const calls: unknown[] = [];
  const owner = k();
  const rentPayer = k();
  const coder = new BorshAccountsCoder(DEXXER_CORE_IDL);
  const data = await coder.encode("UserAccount", {
    version: 3, owner, session_key: k(), session_expiry: new BN(0), actions_left: 0, free_margin: new BN(0), locked_margin: new BN(0),
    last_withdraw_slot: new BN(0), exit_salt: Array(32).fill(0), exited: true, bump: 255, rent_payer: rentPayer, _reserved: Array(32).fill(0),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn: any = {
    getProgramAccounts: async (programId: PublicKey, cfg: unknown) => {
      calls.push([programId.toBase58(), cfg]);
      return [
        { pubkey: pdas.userAccount(owner), account: { data } },
        { pubkey: k(), account: { data: Buffer.alloc(data.length) } }, // not this layout — ignored
      ];
    },
  };
  const feePayer = Keypair.generate();
  const deps = janitorDeps({ baseConn: conn, baseProg: dexxerCoreProgram(conn, feePayer), feePayer });
  const out = await deps.listExitedOwners();
  assert.deepEqual(out.map((o) => [o.owner.toBase58(), o.rentPayer.toBase58()]), [[owner.toBase58(), rentPayer.toBase58()]]);
  assert.deepEqual(calls, [
    [
      DEXXER_CORE_PROGRAM_ID.toBase58(),
      { filters: [{ dataSize: data.length }, { memcmp: { offset: 0, bytes: USER_DISC } }, { memcmp: { offset: EXITED_OFFSET, bytes: bs58.encode([1]) } }] },
    ],
  ]);
});

test("janitorDeps.bothUnderProgram: true only when UserAccount AND Positions exist and are owned by dexxer_core", async () => {
  const owner = k();
  let infos: ({ owner: PublicKey } | null)[] = [];
  const asked: string[][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn: any = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      asked.push(keys.map((x) => x.toBase58()));
      return infos;
    },
  };
  const feePayer = Keypair.generate();
  const deps = janitorDeps({ baseConn: conn, baseProg: dexxerCoreProgram(conn, feePayer), feePayer });
  const prog = { owner: DEXXER_CORE_PROGRAM_ID };
  const dlg = { owner: DELEGATION_PROGRAM_ID };
  infos = [prog, prog];
  assert.equal(await deps.bothUnderProgram(owner), true);
  assert.deepEqual(asked[0], [pdas.userAccount(owner).toBase58(), pdas.positions(owner).toBase58()]);
  infos = [prog, dlg];
  assert.equal(await deps.bothUnderProgram(owner), false, "Positions still delegated");
  infos = [dlg, prog];
  assert.equal(await deps.bothUnderProgram(owner), false, "UserAccount still delegated");
  infos = [prog, null];
  assert.equal(await deps.bothUnderProgram(owner), false, "Positions missing");
});

// --- fix round 3 (N2): a dead L1 path costs at most two confirm timeouts per cycle ---

test("8 exited owners whose closes all time out -> exactly 2 closeExitedUser calls, then the pass stops", async () => {
  const owners = Array.from({ length: 8 }, () => ({ owner: k(), rentPayer: k() }));
  const { deps } = fakes(owners, new Set(owners.map((o) => o.owner.toBase58())));
  let calls = 0;
  deps.closeExitedUser = async () => {
    calls += 1;
    throw new Error("confirmSignature timeout waiting for 5abc");
  };
  const state = createJanitorState();
  const r = await runJanitorCycle(deps, { state });
  assert.equal(calls, 2);
  assert.equal(r.aborted, true);
  assert.equal(state.failedAt.size, 0, "no cooldown");
  assert.match(r.errors.at(-1) ?? "", /2 consecutive/);
});

test("a success between two timeouts resets the consecutive-failure counter", async () => {
  const owners = Array.from({ length: 5 }, () => ({ owner: k(), rentPayer: k() }));
  const { deps, closed } = fakes(owners, new Set(owners.map((o) => o.owner.toBase58())));
  // timeout, success, timeout, timeout -> stop (owner 5 never attempted)
  const plan = ["timeout", "ok", "timeout", "timeout", "ok"];
  let calls = 0;
  deps.closeExitedUser = async (o) => {
    const p = plan[calls++];
    if (p === "timeout") throw new Error("confirmSignature timeout waiting for 5abc");
    closed.push(o);
    return "sig";
  };
  const r = await runJanitorCycle(deps, { state: createJanitorState() });
  assert.equal(calls, 4);
  assert.equal(closed.length, 1);
  assert.equal(r.aborted, true);
});
