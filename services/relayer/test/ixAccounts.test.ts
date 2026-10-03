// Every account builder must name exactly the accounts the IDL declares for
// its instruction — a missing or misnamed key only fails on a live network
// otherwise (anchor-ts resolves nothing here: the Program is untyped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { DEXXER_CORE_IDL, pdas } from "../../../tests/er/lib/program.js";
import { commitAggregateAccounts, crankTickAccounts, setBalancesRootAccounts } from "../src/ixAccounts.js";
import {
  closeExitedUserAccounts, delegateUserAccounts, initUserAccounts, permissionAccounts, tradeAccounts, undelegateUserAccounts,
} from "../../../tests/er/lib/trader.js";

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function idlAccounts(ix: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (DEXXER_CORE_IDL as any).instructions.find((i: any) => i.name === ix);
  assert.ok(def, `IDL has ${ix}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return def.accounts.map((a: any) => camel(a.name)).sort();
}
const k = () => Keypair.generate().publicKey;
const keys = (o: Record<string, PublicKey>, extra: string[] = []) => [...Object.keys(o), ...extra].sort();

test("init_user / delegate_user builders match the IDL", () => {
  assert.deepEqual(keys(initUserAccounts(k(), k())), idlAccounts("init_user"));
  assert.deepEqual(keys(delegateUserAccounts(k(), k())), idlAccounts("delegate_user"));
});

test("init_permissions and set_session share one builder that matches both", () => {
  const a = keys(permissionAccounts(k()));
  assert.deepEqual(a, idlAccounts("init_permissions"));
  assert.deepEqual(a, idlAccounts("set_session"));
});

test("every trading instruction takes the same 12 accounts", () => {
  const a = keys(tradeAccounts({ config: k(), poolLive: k() }, { userAccount: k(), positions: k() }, { market: k(), marketRisk: k(), feed: k() }), ["signer"]);
  assert.equal(a.length, 12);
  for (const ix of ["open_position", "close_position", "increase_position", "decrease_position", "add_margin"]) {
    assert.deepEqual(a, idlAccounts(ix), ix);
  }
});

test("task_context is the trader's Positions account", () => {
  const positions = k();
  const a = tradeAccounts({ config: k(), poolLive: k() }, { userAccount: k(), positions }, { market: k(), marketRisk: k(), feed: k() });
  assert.equal(a.taskContext.toBase58(), positions.toBase58());
  assert.equal(a.positions.toBase58(), positions.toBase58());
});

test("undelegate_user / close_exited_user builders match the IDL", () => {
  assert.deepEqual(keys(undelegateUserAccounts(k(), k())), idlAccounts("undelegate_user"));
  const rentPayer = k();
  const c = closeExitedUserAccounts(k(), k(), rentPayer);
  assert.deepEqual(keys(c), idlAccounts("close_exited_user"));
  assert.equal(c.rentPayer.toBase58(), rentPayer.toBase58());
});

// Final review I7: the relayer's own instructions, pinned the same way.
test("crank_tick / commit_aggregate / set_balances_root builders (relayer) match the IDL", () => {
  assert.deepEqual(keys(crankTickAccounts(k(), { market: k(), marketRisk: k(), feed: k() }, k())), idlAccounts("crank_tick"));
  assert.deepEqual(keys(commitAggregateAccounts({ payer: k(), pool: k(), poolLive: k(), balancesRoot: k(), feeEscrow: k(), magicFeeVault: k() })), idlAccounts("commit_aggregate"));
  assert.deepEqual(keys(setBalancesRootAccounts(k(), k())), idlAccounts("set_balances_root"));
});

test("relayer builders put each key where the program expects it", () => {
  const crank = k();
  const m = { market: k(), marketRisk: k(), feed: k() };
  const poolLive = k();
  const t = crankTickAccounts(crank, m, poolLive);
  assert.deepEqual(
    [t.crank, t.market, t.marketRisk, t.poolLive, t.feed].map((x) => x.toBase58()),
    [crank, m.market, m.marketRisk, poolLive, m.feed].map((x) => x.toBase58()),
  );
  assert.equal(t.config.toBase58(), pdas.config().toBase58());
  const c = commitAggregateAccounts({ payer: k(), pool: k(), poolLive: k(), balancesRoot: k(), feeEscrow: k(), magicFeeVault: k() });
  assert.equal(c.magicContext.toBase58(), MAGIC_CONTEXT_ID.toBase58());
  assert.equal(c.magicProgram.toBase58(), MAGIC_PROGRAM_ID.toBase58());
});
