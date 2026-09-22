// tests/er/devnet/w3-measure.ts
//
// Entrypoint: DEXXER_NET=devnet npx tsx devnet/w3-measure.ts
// (or `npm run devnet:w3measure` from tests/er/)
//
// Week-3 Task 1 orchestrator for M-A, M-C, M-D. Unlike 00-measure.ts, the
// actual measurement logic lives in the spike directories themselves
// (spikes/01-private-counter-tee/w3-ma.ts, spikes/06-magic-action/w3-mc.ts,
// spikes/05-crank-tee/w3-md.ts) — those spikes have their own tsconfig,
// node_modules, keys, and (for 01/06) already-deployed devnet programs that
// this repo's tests/er workspace does not share. This file shells out to
// them with `npx tsx`, run from the spikes/ directory (their scripts import
// shared helpers via relative paths like "../lib/env.js", which only
// resolve from there), rather than reimplementing the logic here.
//
// M-D (spike 05) is NOT re-run by default: its program was deployed
// (~1.6 SOL), measured, and closed (SOL refunded) once already, during this
// task's session (see docs/superpowers/plans/week3-results.md, Task 1 §M-D).
// Re-running it here would require a fresh `anchor keys sync` + a fresh
// ~1.6 SOL deploy (the closed program id can never be redeployed) just to
// reproduce numbers already recorded. Pass `RUN_MD=1` to opt in anyway (you
// are responsible for the deploy cost and for closing the program after).
//
// process.env bootstrap gotcha (see 00-measure.ts, week2-results.md Task 1):
// tests/er/.env pins LOCAL mb-stack endpoints for q1/q2, and lib/env.ts's
// cfg() reads `.env` *over* the `devnet` profile default. This file doesn't
// import lib/env.js at all (it only shells out to spike scripts, which have
// their own spikes/lib/env.ts with its own devnet defaults and its own
// spikes/.env — see spikes/lib/env.ts), so that gotcha does not apply here;
// still set DEXXER_NET=devnet for consistency with the other devnet/*.ts
// entrypoints and to make the "not local mb-stack" intent explicit.
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const spikesDir = resolve(repoRoot, "spikes");

function runSpikeScript(label: string, relPath: string): boolean {
  console.log(`\n${"=".repeat(70)}\n${label}: ${relPath}\n${"=".repeat(70)}`);
  const result = spawnSync("npx", ["tsx", relPath], {
    cwd: spikesDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    console.log(`${label}: FAILED (exit ${result.status}), see output above`);
    return false;
  }
  console.log(`${label}: script exited 0`);
  return true;
}

console.log("Week-3 Task 1 measurements — DEXXER_NET =", process.env.DEXXER_NET ?? "(unset)");

const okA = runSpikeScript("M-A", "01-private-counter-tee/w3-ma.ts");
const okC = runSpikeScript("M-C", "06-magic-action/w3-mc.ts");

let okD: boolean | "skipped" = "skipped";
if (process.env.RUN_MD === "1") {
  console.log(
    "\nRUN_MD=1 set — M-D requires spike 05 to be deployed first " +
      "(anchor keys sync + anchor build + solana program deploy, ~1.6 SOL, " +
      "in spikes/05-crank-tee/), which this orchestrator does NOT do for " +
      "you. Deploy it yourself, then this will run spikes/05-crank-tee/w3-md.ts " +
      "against whatever program id is currently declared there.",
  );
  okD = runSpikeScript("M-D", "05-crank-tee/w3-md.ts");
} else {
  console.log(
    "\nM-D: skipped (spike 05's program was deployed, measured, and closed " +
      "once already this task — see week3-results.md Task 1 §M-D for the " +
      "recorded run. Pass RUN_MD=1 to re-run against a freshly deployed spike 05.)",
  );
}

console.log("\n=== w3-measure.ts SUMMARY ===");
console.log({ M_A: okA, M_C: okC, M_D: okD });

if (!okA || !okC || (okD !== "skipped" && !okD)) {
  process.exitCode = 1;
}
