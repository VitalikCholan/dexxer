// test/feedback.test.ts — closed-beta bug/crash reports (src/feedback.ts):
// validation, the anonymous-by-default owner rule, rate limits, the admin
// API and the Telegram line.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import {
  MAX_EVENTS,
  MAX_MESSAGE,
  createRateLimiter,
  feedbackRouter,
  formatFeedbackNotice,
  memFeedbackStore,
  parseFeedback,
  type FeedbackDeps,
  type FeedbackInput,
} from "../src/feedback.js";
import { memAuthStore } from "./memAuthStore.js";

const BODY = {
  kind: "bug",
  category: "trading",
  message: "Close button does nothing on BTC",
  contact: "@tester",
  app: { version: "1.0.0", build: "7", channel: "beta", platform: "android", osVersion: "14", device: "Google Pixel 7" },
  context: { screen: "/positions", market: "BTC" },
  events: [
    { t: 1_700_000_000_000, level: "info", tag: "nav", msg: "/positions" },
    { t: 1_700_000_001_000, level: "error", tag: "tx", msg: "slippage exceeded (6015)" },
  ],
};

test("parseFeedback accepts a full report and defaults category", () => {
  const r = parseFeedback(BODY);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.message, BODY.message);
  assert.equal(r.value.app.device, "Google Pixel 7");
  assert.equal(r.value.events.length, 2);
  const noCat = parseFeedback({ ...BODY, category: undefined });
  assert.ok(noCat.ok && noCat.value.category === "other");
});

test("parseFeedback rejects bad shapes, naming the field", () => {
  const bad = (patch: Record<string, unknown>, re: RegExp) => {
    const r = parseFeedback({ ...BODY, ...patch });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, re);
  };
  bad({ kind: "praise" }, /kind/);
  bad({ category: "everything" }, /category/);
  bad({ message: "" }, /message is required/);
  bad({ message: "   " }, /message is required/);
  bad({ message: "x".repeat(MAX_MESSAGE + 1) }, /longer than/);
  bad({ app: { platform: "android" } }, /version/);
  bad({ app: "v1" }, /app must be an object/);
  bad({ events: "lots" }, /events must be an array/);
  bad({ events: Array.from({ length: MAX_EVENTS + 1 }, () => BODY.events[0]) }, /at most/);
  bad({ events: [{ t: "now", level: "info", tag: "x", msg: "y" }] }, /events\[0\]\.t/);
  bad({ events: [{ t: 1, level: "fatal", tag: "x", msg: "y" }] }, /events\[0\]\.level/);
  assert.equal(parseFeedback(null).ok, false);
});

test("parseFeedback strips control characters but keeps newlines", () => {
  const r = parseFeedback({ ...BODY, message: "line1\nline2\u0007\u001b[31m" });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.message, "line1\nline2[31m");
});

test("rate limiter: a sliding window per key", () => {
  let t = 0;
  const rl = createRateLimiter(2, 1000, () => t);
  assert.equal(rl.take("a"), true);
  assert.equal(rl.take("a"), true);
  assert.equal(rl.take("a"), false);
  assert.equal(rl.take("b"), true, "keys are independent");
  t = 1000;
  assert.equal(rl.take("a"), true, "the window slid");
});

test("formatFeedbackNotice: kind, id, build, device; never the owner", () => {
  const r = parseFeedback(BODY);
  assert.ok(r.ok);
  if (!r.ok) return;
  const text = formatFeedbackNotice(12, r.value, true);
  assert.match(text, /^🐞 bug #12 \[trading\] 1\.0\.0 · build 7 · beta/);
  assert.match(text, /android 14 Google Pixel 7 · \/positions · wallet attached/);
  assert.ok(text.endsWith(BODY.message));
  const long = formatFeedbackNotice(1, { ...(r.value as FeedbackInput), message: "x".repeat(1000), kind: "crash" }, false);
  assert.ok(long.startsWith("💥 crash #1"));
  assert.ok(long.endsWith("…") && long.length < 600);
  assert.doesNotMatch(long, /wallet attached/);
});

async function withServer(deps: FeedbackDeps, fn: (url: string) => Promise<void>) {
  const app = express();
  app.use(feedbackRouter(deps));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/feedback`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("POST /feedback stores the report anonymously and notifies", async () => {
  const store = memFeedbackStore();
  const sent: string[] = [];
  await withServer({ store, notifier: { send: async (t) => void sent.push(t) } }, async (url) => {
    const res = await post(url, BODY);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 1 });
    assert.equal(store.rows[0].owner, null);
    assert.match(store.rows[0].ipHash ?? "", /^[0-9a-f]{32}$/, "the IP is kept only as a salted hash");
    assert.equal(store.rows[0].payload.context.market, "BTC");
    assert.equal((await post(url, { ...BODY, kind: "nope" })).status, 400);
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /bug #1/);
});

test("POST /feedback: the owner comes only from a live relayer session, never from the body", async () => {
  const store = memFeedbackStore();
  const auth = memAuthStore();
  const owner = Keypair.generate().publicKey.toBase58();
  const token = auth.sessionFor(owner);
  await withServer({ store, authStore: auth }, async (url) => {
    assert.equal((await post(url, { ...BODY, owner: "SomeoneElse111111111111111111111111111111111" })).status, 201);
    assert.equal(store.rows[0].owner, null, "a body field cannot claim an owner");
    assert.equal((await post(url, BODY, { authorization: `Bearer ${token}` })).status, 201);
    assert.equal(store.rows[1].owner, owner);
    assert.equal((await post(url, BODY, { authorization: "Bearer not-a-session" })).status, 201);
    assert.equal(store.rows[2].owner, null, "an unknown token just files the report anonymously");
  });
});

test("POST /feedback: rate-limited per device, crashes get their own budget", async () => {
  const store = memFeedbackStore();
  await withServer({ store, limits: { bug: 2, crash: 1, idea: 1 } }, async (url) => {
    assert.equal((await post(url, BODY)).status, 201);
    assert.equal((await post(url, BODY)).status, 201);
    assert.equal((await post(url, BODY)).status, 429);
    assert.equal((await post(url, { ...BODY, kind: "crash" })).status, 201);
    assert.equal((await post(url, { ...BODY, kind: "crash" })).status, 429);
  });
  assert.equal(store.rows.length, 3);
});

test("POST /feedback: an oversized body is refused before parsing", async () => {
  await withServer({ store: memFeedbackStore() }, async (url) => {
    const res = await post(url, { ...BODY, message: "x".repeat(70_000) });
    assert.equal(res.status, 413);
  });
});

test("admin API: absent without a token; with it — list, cursor, filters, get, status", async () => {
  const store = memFeedbackStore();
  await withServer({ store }, async (url) => {
    assert.equal((await fetch(`${url}/feedback`)).status, 404, "not mounted without FEEDBACK_ADMIN_TOKEN");
  });
  const ADMIN = "s3cret-admin-token";
  const auth = { authorization: `Bearer ${ADMIN}` };
  await withServer({ store, adminToken: ADMIN }, async (url) => {
    for (const kind of ["bug", "crash", "bug"]) assert.equal((await post(url, { ...BODY, kind })).status, 201);
    assert.equal((await fetch(`${url}/feedback`)).status, 401);
    assert.equal((await fetch(`${url}/feedback`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    const all = (await (await fetch(`${url}/feedback`, { headers: auth })).json()) as { id: number }[];
    assert.deepEqual(
      all.map((r) => r.id),
      [3, 2, 1],
    );
    const page = await fetch(`${url}/feedback?limit=2`, { headers: auth });
    assert.equal(page.headers.get("x-next-cursor"), "2");
    const older = (await (await fetch(`${url}/feedback?before=2`, { headers: auth })).json()) as { id: number }[];
    assert.deepEqual(
      older.map((r) => r.id),
      [1],
    );
    const crashes = (await (await fetch(`${url}/feedback?kind=crash`, { headers: auth })).json()) as { id: number }[];
    assert.deepEqual(
      crashes.map((r) => r.id),
      [2],
    );
    assert.equal((await fetch(`${url}/feedback?kind=nope`, { headers: auth })).status, 400);
    const one = (await (await fetch(`${url}/feedback/1`, { headers: auth })).json()) as { message: string; status: string };
    assert.equal(one.message, BODY.message);
    assert.equal(one.status, "new");
    assert.equal((await fetch(`${url}/feedback/99`, { headers: auth })).status, 404);
    const patch = (body: unknown) =>
      fetch(`${url}/feedback/1`, { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await patch({ status: "triaged" })).status, 200);
    assert.equal(store.rows[0].status, "triaged");
    assert.equal((await patch({ status: "done-ish" })).status, 400);
    const triaged = (await (await fetch(`${url}/feedback?status=triaged`, { headers: auth })).json()) as { id: number }[];
    assert.deepEqual(
      triaged.map((r) => r.id),
      [1],
    );
  });
});

test("memFeedbackStore counts by kind and window (alerts, /metrics)", async () => {
  let t = 1_000;
  const store = memFeedbackStore(() => t);
  const r = parseFeedback(BODY);
  assert.ok(r.ok);
  if (!r.ok) return;
  await store.insert({ kind: "crash", category: "other", owner: null, ipHash: null, payload: r.value });
  t = 5_000;
  await store.insert({ kind: "crash", category: "other", owner: null, ipHash: null, payload: r.value });
  await store.insert({ kind: "bug", category: "other", owner: null, ipHash: null, payload: r.value });
  assert.equal(await store.countSince("crash", 2_000), 1);
  assert.deepEqual(await store.counts(), { bug: 1, crash: 2, idea: 0 });
});
