// services/relayer/test/indexerQuery.test.ts
//
// Pure query-string parsing for the indexer's paginated/filtered endpoints —
// no Postgres, runs in CI. The SQL those parsed filters drive is covered
// against a real Postgres in indexerDb.test.ts (skipped without
// TEST_DATABASE_URL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  STATS_WINDOWS,
  disclosureCursor,
  parseDisclosureQuery,
  parsePoolHistoryQuery,
  parseStatsQuery,
} from "../src/indexer/query.js";

const PK = Keypair.generate().publicKey.toBase58();
const MARKET = Keypair.generate().publicKey.toBase58();

test("parseDisclosureQuery: defaults — limit 100, no cursor, no filters", () => {
  assert.deepEqual(parseDisclosureQuery({}), {
    ok: true,
    value: { limit: 100, cursor: null, side: null, reason: null, market: null, from: null, to: null },
  });
});

test("parseDisclosureQuery: limit is clamped to [1, 1000] like before (bad values fall back to the default)", () => {
  const limit = (q: Record<string, unknown>) => {
    const r = parseDisclosureQuery(q);
    return r.ok ? r.value.limit : null;
  };
  assert.equal(limit({ limit: "5" }), 5);
  assert.equal(limit({ limit: "5000" }), 1000);
  assert.equal(limit({ limit: "0" }), 100);
  assert.equal(limit({ limit: "abc" }), 100);
});

test("parseDisclosureQuery: accepts every filter together", () => {
  const r = parseDisclosureQuery({
    cursor: `12345.${PK}`,
    side: "short",
    reason: "liquidated",
    market: MARKET,
    from: "1000",
    to: "2000",
  });
  assert.deepEqual(r, {
    ok: true,
    value: { limit: 100, cursor: { closedSlot: 12345n, pubkey: PK }, side: "short", reason: "liquidated", market: MARKET, from: 1000, to: 2000 },
  });
});

const BAD_DISCLOSURE_QUERIES: [string, Record<string, unknown>, RegExp][] = [
  ["a cursor without a dot", { cursor: "12345" }, /cursor/],
  ["a cursor with a non-numeric slot", { cursor: `abc.${PK}` }, /cursor/],
  ["a cursor with a negative slot", { cursor: `-1.${PK}` }, /cursor/],
  ["a cursor with a bad pubkey", { cursor: "12.notapubkey" }, /cursor/],
  ["an unknown side", { side: "up" }, /side/],
  ["an unknown reason", { reason: "rugged" }, /reason/],
  ["a bad market", { market: "x" }, /market/],
  ["a non-numeric from", { from: "yesterday" }, /from/],
  ["a negative to", { to: "-5" }, /to/],
  ["from after to", { from: "20", to: "10" }, /from/],
  ["a repeated parameter", { side: ["long", "short"] }, /side/],
];
for (const [label, q, re] of BAD_DISCLOSURE_QUERIES) {
  test(`parseDisclosureQuery: rejects ${label}`, () => {
    const r = parseDisclosureQuery(q);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, re);
  });
}

test("disclosureCursor round-trips through parseDisclosureQuery", () => {
  const c = disclosureCursor({ closed_slot: "987654321", pubkey: PK });
  assert.equal(c, `987654321.${PK}`);
  const r = parseDisclosureQuery({ cursor: c });
  assert.ok(r.ok && r.value.cursor?.closedSlot === 987654321n && r.value.cursor.pubkey === PK);
});

test("parsePoolHistoryQuery: default limit 100, optional numeric slot cursor", () => {
  assert.deepEqual(parsePoolHistoryQuery({}), { ok: true, value: { limit: 100, cursor: null } });
  assert.deepEqual(parsePoolHistoryQuery({ limit: "10", cursor: "555" }), { ok: true, value: { limit: 10, cursor: 555n } });
  const bad = parsePoolHistoryQuery({ cursor: "5.5" });
  assert.equal(bad.ok, false);
});

test("parseStatsQuery: window defaults to 24h; market optional; the window resolves to [now - span, now]", () => {
  const now = 10_000_000_000;
  assert.deepEqual(parseStatsQuery({}, now), { ok: true, value: { window: "24h", market: null, from: now - 24 * 3_600_000, to: now } });
  assert.deepEqual(parseStatsQuery({ window: "7d", market: MARKET }, now), {
    ok: true,
    value: { window: "7d", market: MARKET, from: now - 7 * 24 * 3_600_000, to: now },
  });
  assert.deepEqual(parseStatsQuery({ window: "all" }, now), { ok: true, value: { window: "all", market: null, from: 0, to: now } });
  assert.deepEqual([...STATS_WINDOWS], ["24h", "7d", "30d", "all"]);
});

test("parseStatsQuery: rejects an unknown window and a bad market", () => {
  const w = parseStatsQuery({ window: "1y" }, 0);
  assert.ok(!w.ok && /window/.test(w.error));
  const m = parseStatsQuery({ market: "x" }, 0);
  assert.ok(!m.ok && /market/.test(m.error));
});
