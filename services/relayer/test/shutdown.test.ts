// services/relayer/test/shutdown.test.ts
//
// Fix round 1 (code review): the original `shutdown()` closed the server
// and exited right after `requestStop()`, without waiting for the crank
// loop to actually stop — see shutdown.ts's header comment. These tests
// exercise the ordering directly against fakes (no real process, no real
// startCrank/Express) using a short injected `timeoutMs` so the fallback
// test doesn't have to wait the real 5s.

import { test } from "node:test";
import assert from "node:assert/strict";
import { shutdown } from "../src/shutdown.js";

const noopLog = () => {};

test("shutdown: closes/exits only after crankDone resolves (requestStop observed first)", async () => {
  const order: string[] = [];
  let resolveCrank: () => void = () => {};
  const crankDone = new Promise<void>((resolve) => {
    resolveCrank = resolve;
  });

  const requestStop = () => {
    order.push("requestStop");
    // Simulate the crank loop's `while (!stopRequested)` observing the
    // stop request and finishing its in-flight tick shortly after —
    // exactly the ordering the fix is about.
    setTimeout(() => {
      order.push("crank-finished");
      resolveCrank();
    }, 10);
  };
  const closeServer = () => order.push("closeServer");
  const exit = (_code: number) => order.push("exit");

  await shutdown("SIGTERM", { requestStop, crankDone, closeServer, exit, timeoutMs: 1000, log: noopLog });

  assert.deepEqual(order, ["requestStop", "crank-finished", "closeServer", "exit"]);
});

test("shutdown: falls back to the hard-kill timeout if the crank loop never stops", async () => {
  const order: string[] = [];
  const crankDone = new Promise<void>(() => {}); // never settles — a genuinely wedged loop
  const requestStop = () => order.push("requestStop");
  const closeServer = () => order.push("closeServer");
  const exit = (_code: number) => order.push("exit");

  await shutdown("SIGTERM", { requestStop, crankDone, closeServer, exit, timeoutMs: 20, log: noopLog });

  // closeServer/exit still ran (via the timeout race), not because crankDone resolved.
  assert.deepEqual(order, ["requestStop", "closeServer", "exit"]);
});

test("shutdown: a rejecting crankDone does not hang shutdown", async () => {
  const order: string[] = [];
  const crankDone = Promise.reject(new Error("crank loop crashed"));
  const requestStop = () => order.push("requestStop");
  const closeServer = () => order.push("closeServer");
  const exit = (_code: number) => order.push("exit");

  await shutdown("SIGTERM", { requestStop, crankDone, closeServer, exit, timeoutMs: 1000, log: noopLog });

  assert.deepEqual(order, ["requestStop", "closeServer", "exit"]);
});
