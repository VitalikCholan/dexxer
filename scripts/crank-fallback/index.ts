// scripts/crank-fallback/index.ts
//
// Thin local-run shim (Task 4, week 4): the real tick/disclosure loop moved
// to services/relayer/src/crank.ts (`startCrank`) — see that file's header
// comment and services/relayer/README.md for the actual crank service
// (Railway, `npm run crank` from scripts/, or `npm start` from
// services/relayer/).
//
// This file exists only so existing local tooling that spawns it as a
// child process — scripts/demo/week1-cli.ts's
// `spawn("npx", ["tsx", CRANK_SCRIPT])` — keeps working unchanged against
// mb-stack.
//
// Fix wave (23.09.2026, CI run 35836477084): this used to `await
// import("../../services/relayer/src/crank.js")` directly and call
// `startCrank` itself. That made `npx tsc --noEmit` in scripts/ — which has
// no relayer node_modules installed — type-check relayer source files
// (crank.ts, and transitively keys.ts/env.ts/program.ts), failing on
// `@solana/web3.js`/`@coral-xyz/anchor`/the generated SDK (TS2307). scripts/
// and services/relayer/ are deliberately separate npm packages (own
// package-lock.json, own CI step) — a source-level import defeats that
// isolation even though it worked fine at runtime.
//
// The fix: spawn the relayer as its OWN process (`npm --prefix
// ../services/relayer start`, i.e. `node --import tsx src/index.ts` there)
// instead of importing its TypeScript into this one. `keys.ts`'s
// `keypairFromEnv` falls back to `loadOrCreateKey`'s `tests/er/.keys/`
// files (same identities this shim used to load directly) when
// `CRANK_KEY_B58`/`FEE_PAYER_KEY_B58` aren't set, so `npm start` works
// unchanged with no env vars — `env: process.env` here only forwards
// whatever the caller (week1-cli.ts, a shell) already set, e.g.
// `DEXXER_NET=devnet`. `stdio: "inherit"` means the relayer's own
// `console.log`/`console.error` output (crank.ts's unchanged `tick n=...`
// lines included) flows straight through this process's stdout/stderr —
// week1-cli.ts's `parseTickLine`, reading THIS process's stdout, keeps
// working byte-for-byte.
//
// Not a deployable entrypoint — see services/relayer/ for that.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(HERE, "..");
const RELAYER_DIR = resolve(SCRIPTS_DIR, "..", "services", "relayer");

const child = spawn("npm", ["--prefix", RELAYER_DIR, "start"], {
  stdio: "inherit",
  env: process.env,
  cwd: SCRIPTS_DIR,
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (e) => {
  console.error("crank-fallback FAIL", e);
  process.exit(1);
});
