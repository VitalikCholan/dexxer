import { test } from "node:test";
import assert from "node:assert/strict";
import { commitDue, runIsolated } from "../src/commit.js";

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
