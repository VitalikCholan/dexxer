// services/relayer/src/shutdown.ts
//
// Graceful-shutdown ordering, extracted out of index.ts so it's unit
// testable without spinning up the real process (Express server, network
// connections, startCrank's real ER/TEE calls) — see test/shutdown.test.ts.
//
// Fix round 1 (code review): the original inline `shutdown()` in index.ts
// called `server.close(() => process.exit(0))` right after `requestStop()`,
// without ever waiting for the crank loop itself to actually stop — a
// Railway redeploy's SIGTERM could kill the process mid
// `sendRawTransaction`/`confirmSignature` or mid `runRootCycle`/
// `runCommitCycle`, contradicting the "finish its in-flight tick and
// stop" the header comment promised. `shutdown()` below fixes the ordering:
// `requestStop()` → wait for `crankDone` to settle (the promise
// `startCrank(cfg, state)` returns) → `closeServer()` → `exit(0)`. A
// `timeoutMs` race is the hard-kill fallback only, for a genuinely wedged
// loop (stuck TEE auth, hung RPC call) — it must never be the normal path.

export interface ShutdownDeps {
  /** Tells the crank loop's `while (!stopRequested)` to exit after its current iteration. */
  requestStop: () => void;
  /** The promise `startCrank(cfg, state)` returns (already `.catch()`-wrapped in index.ts so it never rejects) — resolves once the loop has actually stopped. */
  crankDone: Promise<void>;
  /** Closes the HTTP server. Not awaited — see header comment: the fix is about crank ordering, not about draining in-flight HTTP requests. */
  closeServer: () => void;
  exit: (code: number) => void;
  /** Hard-kill fallback if the crank loop never stops. Default 5000ms in index.ts; tests inject a short value so they don't have to wait 5s. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export async function shutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  const { requestStop, crankDone, closeServer, exit, timeoutMs = 5000, log = console.log } = deps;
  log(`relayer: ${signal} received, shutting down`);
  requestStop();

  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
    t.unref?.();
  });

  await Promise.race([crankDone.catch(() => undefined), timeout]);
  if (timedOut) {
    log("relayer: shutdown timeout — crank loop did not stop in time, forcing exit");
  } else {
    log("relayer: crank loop stopped, closing server");
  }

  closeServer();
  exit(0);
}
