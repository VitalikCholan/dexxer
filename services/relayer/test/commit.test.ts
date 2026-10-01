import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { dexxerCoreProgram } from "../../../tests/er/lib/program.js";
import { commitDue, createCycleRunner, runIsolated, runRootCycle } from "../src/commit.js";

test("commitDue: first attempt at once, then once per interval of wall-clock time", () => {
  assert.equal(commitDue(null, 1_000, 300_000), true);
  assert.equal(commitDue(1_000, 1_000 + 299_999, 300_000), false);
  assert.equal(commitDue(1_000, 1_000 + 300_000, 300_000), true);
});

test("runIsolated: a failing step is reported and the later steps still run", async () => {
  const ran: string[] = [];
  const failed: string[] = [];
  const ok = await runIsolated(
    [
      ["root", async () => { throw new Error("root down"); }],
      ["commit", async () => { ran.push("commit"); }],
      ["janitor", async () => { ran.push("janitor"); }],
    ],
    (name, e) => failed.push(`${name}: ${String(e instanceof Error ? e.message : e)}`),
  );
  assert.deepEqual(ran, ["commit", "janitor"]);
  assert.deepEqual(failed, ["root: root down"]);
  assert.deepEqual(ok, ["commit", "janitor"]);
});

// --- final review I1: the commit cycle runs detached from the tick loop ---

test("createCycleRunner: a second trigger while one cycle runs does not start another; idle() waits for it", async () => {
  let runs = 0;
  let release: () => void = () => {};
  const runner = createCycleRunner(
    () => {
      runs += 1;
      return new Promise<void>((r) => {
        release = r;
      });
    },
    () => assert.fail("no error expected"),
  );
  assert.equal(runner.busy(), false);
  assert.equal(runner.trigger(), true, "the first trigger starts a cycle");
  assert.equal(runner.busy(), true);
  assert.equal(runner.trigger(), false, "a second trigger while it runs starts nothing");
  assert.equal(runs, 1);
  let idle = false;
  const waiting = runner.idle().then(() => {
    idle = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(idle, false, "idle() waits for the in-flight cycle");
  release();
  await waiting;
  assert.equal(runner.busy(), false);
  assert.equal(runner.trigger(), true, "after it finished a new cycle can start");
  assert.equal(runs, 2);
  release();
  await runner.idle();
});

test("createCycleRunner: a rejected cycle is reported, clears the flag and never leaves an unhandled rejection", async () => {
  const errors: string[] = [];
  const runner = createCycleRunner(
    async () => {
      throw new Error("commit down");
    },
    (e) => errors.push(String(e instanceof Error ? e.message : e)),
  );
  assert.equal(runner.trigger(), true);
  await runner.idle(); // resolves, does not reject
  assert.deepEqual(errors, ["commit down"]);
  assert.equal(runner.busy(), false, "the flag is cleared");
  assert.equal(runner.trigger(), true);
  await runner.idle();
  assert.equal(errors.length, 2);
});

test("createCycleRunner: idle() with nothing in flight resolves at once", async () => {
  const runner = createCycleRunner(async () => {}, () => {});
  await runner.idle();
});

test("runRootCycle: a failed set_balances_root batch THROWS (so runIsolated records it)", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn: any = {
    getProgramAccounts: async () => [],
    getLatestBlockhash: async () => {
      throw new TypeError("fetch failed");
    },
  };
  const crank = Keypair.generate();
  const prog = dexxerCoreProgram(conn, crank);
  const k = () => Keypair.generate().publicKey;
  const ctx = { conn, prog, crank, feePayerConn: conn, feePayerProg: prog, feePayer: crank, pool: k(), poolLive: k(), balancesRoot: k(), feeEscrow: k() };
  await assert.rejects(runRootCycle(ctx), /set_balances_root batch 1\/1 failed: fetch failed/);
  const failed: string[] = [];
  const ok = await runIsolated(
    [
      ["root", () => runRootCycle(ctx)],
      ["commit", async () => {}],
    ],
    (name) => failed.push(name),
  );
  assert.deepEqual(failed, ["root"]);
  assert.deepEqual(ok, ["commit"], "the commit step still runs");
});
