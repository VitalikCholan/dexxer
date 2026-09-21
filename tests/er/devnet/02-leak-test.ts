// tests/er/devnet/02-leak-test.ts
//
// Task 5, script 2 of 4: spec §6.4 level-4 leak test against real devnet +
// devnet-tee.magicblock.app, run immediately after 01-onboard-private.ts
// (reads its persisted `.keys/devnet-run-latest.json` — trader/session
// identities, PDAs, and the pre-delegation Position byte snapshot).
//
// Six checks (brief):
//   (a) base RPC: Position owner == Delegation Program, bytes unchanged vs
//       01's pre-delegation snapshot (spec: L1 shows only the delegated
//       account under the Delegation Program with onboarding-time bytes —
//       CLAUDE.md: "нуль комітів на L1 до закриття").
//   (b) TEE without an auth token -> error.
//   (c) a stranger's own TEE token -> read returns null (not a member).
//   (d) session token -> position visible.
//   (e) crank token -> position visible.
//   (f) owner token -> position visible, state == Open.
//
// LEAK TEST PASS only if all six hold. Run: `npm run devnet:leak`.

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");
const { DELEGATION_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { ER, NET, baseConn, loadOrCreateKey, teeConn } = envMod;
const { accountNs, dexxerCoreProgram } = await import("../lib/program.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:leak`);
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_POINTER_PATH = resolve(HERE, "..", ".keys", "devnet-run-latest.json");

interface RunState {
  owner: string;
  session: string;
  crank: string;
  position: string;
  traderName: string;
  sessionName: string;
  positionSnapshotB64: string;
}

async function main() {
  const run: RunState = JSON.parse(readFileSync(RUN_POINTER_PATH, "utf8"));
  console.log("loaded run state:", RUN_POINTER_PATH, "run id", (run as any).runId);
  const position = new PublicKey(run.position);
  const owner = loadOrCreateKey(run.traderName);
  const session = loadOrCreateKey(run.sessionName);
  const crank = loadOrCreateKey("devnet-crank");
  const stranger = Keypair.generate();

  const results: Record<string, { pass: boolean; note: string }> = {};

  // --- (a) base RPC: owner == Delegation Program, bytes unchanged ---
  const baseInfo = await baseConn.getAccountInfo(position, "confirmed");
  const ownerIsDelegation = baseInfo !== null && baseInfo.owner.equals(DELEGATION_PROGRAM_ID);
  const bytesUnchanged = baseInfo !== null && baseInfo.data.toString("base64") === run.positionSnapshotB64;
  results.a_base_owner_and_bytes = {
    pass: ownerIsDelegation && bytesUnchanged,
    note: `owner=${baseInfo?.owner.toBase58() ?? "null"} (Delegation Program? ${ownerIsDelegation}), bytesUnchanged=${bytesUnchanged} (${baseInfo?.data.length ?? 0}B vs snapshot ${Buffer.from(run.positionSnapshotB64, "base64").length}B)`,
  };

  // --- (b) TEE without a token -> non-visible. Brief's literal expectation
  // ("HTTP 401/помилка") does not match this endpoint's real behavior,
  // verified directly with a bare curl POST (no token, no auth header)
  // against `getAccountInfo` for this exact position: HTTP 200,
  // `x-mb-remote-account-claims: 0`, JSON-RPC result `{"value":null}` — no
  // error at the HTTP or JSON-RPC level, same shape as (c)'s stranger-token
  // result. The privacy property this check actually needs — an
  // unauthenticated caller learns nothing about the private position — still
  // holds (silent null, not leaked bytes); it is just enforced by returning
  // null rather than rejecting the request. Pass on either observed shape
  // (explicit error, or a clean null) so the check tests the real guarantee
  // instead of one specific transport-level status this deployment doesn't
  // produce.
  let noTokenErrored = false;
  let noTokenNull = false;
  let noTokenNote = "";
  try {
    const bare = new Connection(ER, "confirmed");
    const info = await bare.getAccountInfo(position, "confirmed");
    noTokenNull = info === null;
    noTokenNote = `no error thrown, getAccountInfo returned ${info === null ? "null (non-visible, as expected)" : `${info.data.length}B — LEAK`}`;
  } catch (e) {
    noTokenErrored = true;
    noTokenNote = `threw (also acceptable): ${String((e as Error)?.message ?? e).slice(0, 200)}`;
  }
  results.b_no_token_nonvisible = { pass: noTokenErrored || noTokenNull, note: noTokenNote };

  // --- (c) stranger token -> null ---
  let strangerInfo: { data: Buffer } | null = null;
  let strangerNote = "";
  try {
    const strangerConn = await teeConn(stranger);
    const info = await strangerConn.getAccountInfo(position, "confirmed");
    strangerInfo = info;
    strangerNote = info === null ? "null (as expected)" : `unexpectedly visible: ${info.data.length}B`;
  } catch (e) {
    strangerNote = `threw (treated as non-visible): ${String((e as Error)?.message ?? e).slice(0, 150)}`;
  }
  results.c_stranger_null = { pass: strangerInfo === null, note: strangerNote };

  // --- (d) session token -> visible ---
  const sessionConn = await teeConn(session);
  const sessionInfo = await sessionConn.getAccountInfo(position, "confirmed");
  results.d_session_visible = {
    pass: sessionInfo !== null,
    note: sessionInfo === null ? "null (unexpected)" : `visible: ${sessionInfo.data.length}B`,
  };

  // --- (e) crank token -> visible ---
  const crankConn = await teeConn(crank);
  const crankInfo = await crankConn.getAccountInfo(position, "confirmed");
  results.e_crank_visible = {
    pass: crankInfo !== null,
    note: crankInfo === null ? "null (unexpected)" : `visible: ${crankInfo.data.length}B`,
  };

  // --- (f) owner token -> visible, state == Open ---
  const ownerConn = await teeConn(owner);
  const ownerInfo = await ownerConn.getAccountInfo(position, "confirmed");
  const core = dexxerCoreProgram(ownerConn, owner);
  const positionState = await accountNs(core).position.fetch(position);
  const isOpen = "open" in positionState.state;
  results.f_owner_visible_open = {
    pass: ownerInfo !== null && isOpen,
    note: `visible=${ownerInfo !== null}, state=${JSON.stringify(positionState.state)}`,
  };

  console.log("\n=== LEAK TEST TABLE (spec §6.4 level 4) ===");
  console.log(
    Object.entries(results)
      .map(([k, v]) => `${v.pass ? "PASS" : "FAIL"}  ${k}: ${v.note}`)
      .join("\n"),
  );

  const allPass = Object.values(results).every((r) => r.pass);
  console.log(`\n${allPass ? "LEAK TEST PASS" : "LEAK TEST FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch((e) => {
  console.error("02-leak-test FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
