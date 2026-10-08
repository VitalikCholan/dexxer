// services/relayer/test/feedbackDb.test.ts
//
// `pgFeedbackStore` (migration 011) against a REAL Postgres — skipped unless
// TEST_DATABASE_URL is set, same recipe as indexerDb.test.ts:
//   docker run -d --rm -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:16-alpine
//   TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres npm test
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool, migrate, type DbPool } from "../src/db.js";
import { parseFeedback, pgFeedbackStore, type FeedbackInput } from "../src/feedback.js";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const skip = ADMIN_URL ? false : "TEST_DATABASE_URL not set (needs a real Postgres)";
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

const DB_NAME = `dexxer_feedback_test_${process.pid}_${Date.now()}`;
let pool: DbPool;

before(async () => {
  if (!ADMIN_URL) return;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  pool = createPool(url.toString()) as DbPool;
  await migrate(pool);
});

after(async () => {
  if (!ADMIN_URL) return;
  await pool.end();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.end();
});

beforeEach(async () => {
  if (!ADMIN_URL) return;
  await pool.query("TRUNCATE feedback_reports RESTART IDENTITY");
});

function report(kind: "bug" | "crash" | "idea", message = "it broke"): FeedbackInput {
  const r = parseFeedback({ kind, category: "funds", message, app: { version: "1.0.0", build: "3", platform: "android" }, events: [{ t: 1, level: "error", tag: "toast", msg: "boom" }] });
  assert.ok(r.ok);
  return (r as { ok: true; value: FeedbackInput }).value;
}

dbTest("insert / get round-trips the payload; ids grow; owner and ip hash stored as given", async () => {
  const s = pgFeedbackStore(pool);
  const a = await s.insert({ kind: "bug", category: "funds", owner: null, ipHash: "h1", payload: report("bug") });
  const b = await s.insert({ kind: "crash", category: "other", owner: "Owner111", ipHash: null, payload: report("crash", "Fatal TypeError") });
  assert.equal(b, a + 1);
  const row = await s.get(a);
  assert.ok(row);
  assert.equal(row.kind, "bug");
  assert.equal(row.status, "new");
  assert.equal(row.ipHash, "h1");
  assert.equal(row.owner, null);
  assert.deepEqual(row.payload, report("bug"));
  assert.ok(Math.abs(row.createdAt - Date.now()) < 60_000);
  assert.equal((await s.get(b))?.owner, "Owner111");
  assert.equal(await s.get(999), null);
  const { rows } = await pool.query("SELECT app_version, app_build, platform FROM feedback_reports WHERE id = $1", [a]);
  assert.deepEqual(rows[0], { app_version: "1.0.0", app_build: "3", platform: "android" });
});

dbTest("list: newest first, cursor, kind and status filters; setStatus; counts and countSince", async () => {
  const s = pgFeedbackStore(pool);
  for (const k of ["bug", "crash", "bug", "idea"] as const) await s.insert({ kind: k, category: "other", owner: null, ipHash: null, payload: report(k) });
  const ids = async (q: Partial<Parameters<typeof s.list>[0]>) => (await s.list({ limit: 10, before: null, kind: null, status: null, ...q })).map((r) => r.id);
  assert.deepEqual(await ids({}), [4, 3, 2, 1]);
  assert.deepEqual(await ids({ limit: 2 }), [4, 3]);
  assert.deepEqual(await ids({ before: 3 }), [2, 1]);
  assert.deepEqual(await ids({ kind: "bug" }), [3, 1]);
  assert.equal(await s.setStatus(3, "triaged"), true);
  assert.equal(await s.setStatus(99, "fixed"), false);
  assert.deepEqual(await ids({ status: "triaged" }), [3]);
  assert.deepEqual(await s.counts(), { bug: 2, crash: 1, idea: 1 });
  assert.equal(await s.countSince("crash", Date.now() - 60_000), 1);
  assert.equal(await s.countSince("crash", Date.now() + 60_000), 0);
});

dbTest("the CHECK constraints refuse an unknown kind or status", async () => {
  await assert.rejects(() => pool.query("INSERT INTO feedback_reports (kind, category, message, payload) VALUES ('rant', 'other', 'x', '{}')"));
  await assert.rejects(() => pool.query("UPDATE feedback_reports SET status = 'whatever'").then(async () => {
    await pool.query("INSERT INTO feedback_reports (kind, category, message, payload) VALUES ('bug', 'other', 'x', '{}')");
    await pool.query("UPDATE feedback_reports SET status = 'whatever'");
  }));
});
