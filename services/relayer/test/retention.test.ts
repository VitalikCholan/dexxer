// services/relayer/test/retention.test.ts — spec §2.10.2 tick retention.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DbPool } from "../src/db.js";
import { TICKS_RETENTION_MS, retentionCutoff, startRetention } from "../src/indexer/retention.js";

test("retention: default 7 days, cutoff = now - retention", () => {
  assert.equal(TICKS_RETENTION_MS, 7 * 24 * 3_600_000);
  assert.equal(retentionCutoff(10_000_000, 1_000), 9_999_000);
});

test("startRetention: deletes ticks older than the cutoff on every interval; a DB error is logged, not thrown; stop clears the timer", async () => {
  const deletes: unknown[][] = [];
  let fail = false;
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      if (fail) throw new Error("db down");
      deletes.push(params);
      return { rows: [], rowCount: 3 };
    },
  } as unknown as DbPool;
  let tick: (() => void) | null = null;
  let cleared = false;
  const fakeSetInterval = ((fn: () => void) => { tick = fn; return { unref: () => undefined } as unknown as NodeJS.Timeout; }) as unknown as typeof setInterval;
  const fakeClearInterval = () => { cleared = true; };
  const stop = startRetention(pool, { intervalMs: 1000, retentionMs: 500, now: () => 10_000, setInterval: fakeSetInterval, clearInterval: fakeClearInterval as unknown as typeof clearInterval });
  assert.ok(tick);
  const flush = () => new Promise<void>((r) => setImmediate(r)); // the interval callback fires `void run()`; let the DELETE settle
  (tick as unknown as () => void)();
  await flush();
  assert.deepEqual(deletes, [[9_500]]);
  fail = true;
  (tick as unknown as () => void)(); // must not reject or throw
  await flush();
  assert.deepEqual(deletes, [[9_500]]);
  stop();
  assert.ok(cleared);
});
