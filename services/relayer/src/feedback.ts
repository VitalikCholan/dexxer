// services/relayer/src/feedback.ts
//
// Closed beta: in-app bug and crash reports (`POST /feedback`) and a small
// admin API to read and triage them (`GET /feedback`, `GET /feedback/:id`,
// `PATCH /feedback/:id`, bearer `FEEDBACK_ADMIN_TOKEN`).
//
// Privacy. The relayer never sees private trading state, and a report must
// not become a side door for it. The app builds the report (see
// app/src/lib/diagnostics.ts): a free-text description, build/device info and
// a scrubbed event log — no balances, positions, keys or amounts — and shows
// the tester the exact payload before it is sent. Here:
//   * the wallet address is stored ONLY when the request carries a live
//     relayer session (the tester ticked "attach my wallet address"); a body
//     cannot claim an owner;
//   * the client IP is stored only as a salted sha256, used for rate limiting
//     and duplicate spotting;
//   * the Telegram notification carries the description and build, never the
//     owner.
//
// Abuse. The endpoint is unauthenticated on purpose (a tester who cannot
// connect a wallet is exactly who needs to report), so it is size-capped
// (64 KiB body, 4000-char message, 200 events), validated field by field, and
// rate-limited per IP hash and per owner in memory.
import express from "express";
import type { Request, Response, Router } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DbPool } from "./db.js";
import { hashToken, type AuthStore } from "./auth.js";

export const FEEDBACK_KINDS = ["bug", "crash", "idea"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_CATEGORIES = ["trading", "onboarding", "funds", "charts", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export const FEEDBACK_STATUSES = ["new", "triaged", "fixed", "wontfix", "duplicate"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
const EVENT_LEVELS = ["info", "warn", "error"] as const;

export const MAX_MESSAGE = 4000;
export const MAX_EVENTS = 200;
const MAX_EVENT_MSG = 500;
const MAX_SHORT = 120;

export interface DiagEvent {
  /** Epoch ms on the device. */
  t: number;
  level: (typeof EVENT_LEVELS)[number];
  tag: string;
  msg: string;
}

export interface FeedbackInput {
  kind: FeedbackKind;
  category: FeedbackCategory;
  message: string;
  /** Optional way to reach the tester (Telegram handle, e-mail). */
  contact: string | null;
  app: {
    version: string;
    build: string | null;
    channel: string | null;
    platform: string;
    osVersion: string | null;
    device: string | null;
  };
  context: { screen: string | null; market: string | null };
  events: DiagEvent[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Control characters except tab and newline are dropped: they have no business in a report and break terminals/Telegram. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function str(o: Record<string, unknown>, k: string, max: number, opts: { optional?: boolean; min?: number } = {}): Parsed<string | null> {
  const v = o[k];
  if (v === undefined || v === null || v === "") {
    if (opts.optional) return { ok: true, value: null };
    return { ok: false, error: `${k} is required` };
  }
  if (typeof v !== "string") return { ok: false, error: `${k} must be a string` };
  const s = clean(v).trim();
  if (s.length < (opts.min ?? 1)) return opts.optional ? { ok: true, value: null } : { ok: false, error: `${k} is required` };
  if (s.length > max) return { ok: false, error: `${k} is longer than ${max} characters` };
  return { ok: true, value: s };
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): Parsed<T> {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? { ok: true, value: v as T }
    : { ok: false, error: `${name} must be one of ${allowed.join(", ")}` };
}

function obj(v: unknown, name: string): Parsed<Record<string, unknown>> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? { ok: true, value: v as Record<string, unknown> } : { ok: false, error: `${name} must be an object` };
}

/** Field-by-field validation of a `POST /feedback` body. Unknown fields are ignored, never stored. */
export function parseFeedback(body: unknown): Parsed<FeedbackInput> {
  const b = obj(body, "body");
  if (!b.ok) return b;
  const o = b.value;
  const kind = oneOf(o.kind, FEEDBACK_KINDS, "kind");
  if (!kind.ok) return kind;
  const category = o.category === undefined ? ({ ok: true, value: "other" } as const) : oneOf(o.category, FEEDBACK_CATEGORIES, "category");
  if (!category.ok) return category;
  const message = str(o, "message", MAX_MESSAGE);
  if (!message.ok) return message;
  const contact = str(o, "contact", 200, { optional: true });
  if (!contact.ok) return contact;

  const a = obj(o.app, "app");
  if (!a.ok) return a;
  const version = str(a.value, "version", 40);
  if (!version.ok) return version;
  const platform = str(a.value, "platform", 20);
  if (!platform.ok) return platform;
  const build = str(a.value, "build", 40, { optional: true });
  const channel = str(a.value, "channel", 40, { optional: true });
  const osVersion = str(a.value, "osVersion", 40, { optional: true });
  const device = str(a.value, "device", MAX_SHORT, { optional: true });
  for (const f of [build, channel, osVersion, device]) if (!f.ok) return f;

  const c = o.context === undefined ? ({ ok: true, value: {} } as const) : obj(o.context, "context");
  if (!c.ok) return c;
  const screen = str(c.value, "screen", MAX_SHORT, { optional: true });
  if (!screen.ok) return screen;
  const market = str(c.value, "market", 16, { optional: true });
  if (!market.ok) return market;

  const rawEvents = o.events === undefined ? [] : o.events;
  if (!Array.isArray(rawEvents)) return { ok: false, error: "events must be an array" };
  if (rawEvents.length > MAX_EVENTS) return { ok: false, error: `at most ${MAX_EVENTS} events` };
  const events: DiagEvent[] = [];
  for (let i = 0; i < rawEvents.length; i++) {
    const e = obj(rawEvents[i], `events[${i}]`);
    if (!e.ok) return e;
    const t = e.value.t;
    if (typeof t !== "number" || !Number.isFinite(t)) return { ok: false, error: `events[${i}].t must be a number` };
    const level = oneOf(e.value.level, EVENT_LEVELS, `events[${i}].level`);
    if (!level.ok) return level;
    const tag = str(e.value, "tag", 40);
    if (!tag.ok) return { ok: false, error: `events[${i}].${tag.error}` };
    const msg = str(e.value, "msg", MAX_EVENT_MSG);
    if (!msg.ok) return { ok: false, error: `events[${i}].${msg.error}` };
    events.push({ t, level: level.value, tag: tag.value!, msg: msg.value! });
  }

  return {
    ok: true,
    value: {
      kind: kind.value,
      category: category.value,
      message: message.value!,
      contact: contact.value,
      app: {
        version: version.value!,
        build: build.ok ? build.value : null,
        channel: channel.ok ? channel.value : null,
        platform: platform.value!,
        osVersion: osVersion.ok ? osVersion.value : null,
        device: device.ok ? device.value : null,
      },
      context: { screen: screen.value, market: market.value },
      events,
    },
  };
}

// ------------------------------------------------------------------ storage

export interface FeedbackRow {
  id: number;
  createdAt: number;
  kind: FeedbackKind;
  category: FeedbackCategory;
  status: FeedbackStatus;
  owner: string | null;
  ipHash: string | null;
  message: string;
  payload: FeedbackInput;
}

export interface FeedbackListQuery {
  limit: number;
  /** Rows strictly older than this id. */
  before: number | null;
  kind: FeedbackKind | null;
  status: FeedbackStatus | null;
}

export interface FeedbackStore {
  insert(r: { kind: FeedbackKind; category: FeedbackCategory; owner: string | null; ipHash: string | null; payload: FeedbackInput }): Promise<number>;
  list(q: FeedbackListQuery): Promise<FeedbackRow[]>;
  get(id: number): Promise<FeedbackRow | null>;
  setStatus(id: number, status: FeedbackStatus): Promise<boolean>;
  /** Reports of `kind` created at or after `sinceMs` — the alert loop's crash-burst signal and `/metrics`. */
  countSince(kind: FeedbackKind, sinceMs: number): Promise<number>;
  counts(): Promise<Record<FeedbackKind, number>>;
}

export function memFeedbackStore(now: () => number = Date.now): FeedbackStore & { rows: FeedbackRow[] } {
  const rows: FeedbackRow[] = [];
  return {
    rows,
    async insert(r) {
      const id = rows.length + 1;
      rows.push({ id, createdAt: now(), kind: r.kind, category: r.category, status: "new", owner: r.owner, ipHash: r.ipHash, message: r.payload.message, payload: r.payload });
      return id;
    },
    async list(q) {
      return rows
        .filter((r) => (q.before === null || r.id < q.before) && (!q.kind || r.kind === q.kind) && (!q.status || r.status === q.status))
        .sort((a, b) => b.id - a.id)
        .slice(0, q.limit);
    },
    async get(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async setStatus(id, status) {
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      r.status = status;
      return true;
    },
    async countSince(kind, sinceMs) {
      return rows.filter((r) => r.kind === kind && r.createdAt >= sinceMs).length;
    },
    async counts() {
      const out = { bug: 0, crash: 0, idea: 0 };
      for (const r of rows) out[r.kind]++;
      return out;
    },
  };
}

interface PgRow {
  id: string;
  created_ms: string;
  kind: FeedbackKind;
  category: FeedbackCategory;
  status: FeedbackStatus;
  owner: string | null;
  ip_hash: string | null;
  message: string;
  payload: FeedbackInput;
}

const fromPg = (r: PgRow): FeedbackRow => ({
  id: Number(r.id),
  createdAt: Number(r.created_ms),
  kind: r.kind,
  category: r.category,
  status: r.status,
  owner: r.owner,
  ipHash: r.ip_hash,
  message: r.message,
  payload: r.payload,
});

const SELECT =
  "SELECT id, (extract(epoch FROM created_at) * 1000)::bigint AS created_ms, kind, category, status, owner, ip_hash, message, payload FROM feedback_reports";

export function pgFeedbackStore(pool: DbPool): FeedbackStore {
  return {
    async insert(r) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO feedback_reports (kind, category, owner, ip_hash, app_version, app_build, platform, message, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [r.kind, r.category, r.owner, r.ipHash, r.payload.app.version, r.payload.app.build, r.payload.app.platform, r.payload.message, JSON.stringify(r.payload)],
      );
      return Number(rows[0].id);
    },
    async list(q) {
      const where: string[] = [];
      const args: unknown[] = [];
      if (q.before !== null) where.push(`id < $${args.push(q.before)}`);
      if (q.kind) where.push(`kind = $${args.push(q.kind)}`);
      if (q.status) where.push(`status = $${args.push(q.status)}`);
      const sql = `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT $${args.push(q.limit)}`;
      const { rows } = await pool.query<PgRow>(sql, args);
      return rows.map(fromPg);
    },
    async get(id) {
      const { rows } = await pool.query<PgRow>(`${SELECT} WHERE id = $1`, [id]);
      return rows[0] ? fromPg(rows[0]) : null;
    },
    async setStatus(id, status) {
      const { rowCount } = await pool.query("UPDATE feedback_reports SET status = $2 WHERE id = $1", [id, status]);
      return (rowCount ?? 0) > 0;
    },
    async countSince(kind, sinceMs) {
      const { rows } = await pool.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM feedback_reports WHERE kind = $1 AND created_at >= to_timestamp($2::double precision / 1000)",
        [kind, sinceMs],
      );
      return Number(rows[0]?.n ?? 0);
    },
    async counts() {
      const { rows } = await pool.query<{ kind: FeedbackKind; n: string }>("SELECT kind, COUNT(*) AS n FROM feedback_reports GROUP BY kind");
      const out = { bug: 0, crash: 0, idea: 0 };
      for (const r of rows) out[r.kind] = Number(r.n);
      return out;
    },
  };
}

// ------------------------------------------------------------------ rate limit

/** Sliding-window counter in memory: `take(key)` is `false` once `limit` hits fell within `windowMs`. Lost on restart, on purpose — it only brakes floods. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    take(key: string): boolean {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      // Bounded memory: drop keys with nothing recent once in a while.
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.every((x) => t - x >= windowMs)) hits.delete(k);
      return true;
    },
  };
}

// ------------------------------------------------------------------ router

export interface Notifier {
  send(text: string): Promise<void>;
}

export interface FeedbackDeps {
  store: FeedbackStore;
  /** When present, a live `Authorization: Bearer` session attaches the owner; absent = reports are always anonymous. */
  authStore?: AuthStore;
  notifier?: Notifier;
  /** `FEEDBACK_ADMIN_TOKEN`; the admin routes are not mounted without it. */
  adminToken?: string;
  /** Salt for the IP hash; random per process when unset (hashes then do not survive a restart). */
  ipSalt?: string;
  now?: () => number;
  /** Per key (IP hash or owner) per hour. */
  limits?: { bug: number; crash: number; idea: number };
}

export const DEFAULT_FEEDBACK_LIMITS = { bug: 10, crash: 30, idea: 10 };
const HOUR_MS = 60 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Short Telegram line for a new report: kind, id, build and the start of the description — never the owner. */
export function formatFeedbackNotice(id: number, r: FeedbackInput, signedIn: boolean): string {
  const icon = r.kind === "crash" ? "💥" : r.kind === "idea" ? "💡" : "🐞";
  const build = [r.app.version, r.app.build && `build ${r.app.build}`, r.app.channel].filter(Boolean).join(" · ");
  const device = [r.app.platform, r.app.osVersion, r.app.device].filter(Boolean).join(" ");
  const text = r.message.length > 400 ? `${r.message.slice(0, 400)}…` : r.message;
  return `${icon} ${r.kind} #${id} [${r.category}] ${build}\n${device}${r.context.screen ? ` · ${r.context.screen}` : ""}${signedIn ? " · wallet attached" : ""}\n\n${text}`;
}

export function feedbackRouter(deps: FeedbackDeps): Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const salt = deps.ipSalt ?? randomBytes(16).toString("hex");
  const limits = deps.limits ?? DEFAULT_FEEDBACK_LIMITS;
  const limiters = {
    bug: createRateLimiter(limits.bug, HOUR_MS, now),
    crash: createRateLimiter(limits.crash, HOUR_MS, now),
    idea: createRateLimiter(limits.idea, HOUR_MS, now),
  };
  const ipHash = (req: Request): string | null => (req.ip ? createHash("sha256").update(`${salt}:${req.ip}`).digest("hex").slice(0, 32) : null);

  router.post("/feedback", express.json({ limit: "64kb" }), async (req, res) => {
    const parsed = parseFeedback(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const r = parsed.value;
    let owner: string | null = null;
    const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.get("authorization") ?? "");
    if (m && deps.authStore) {
      const session = await deps.authStore.getSession(hashToken(m[1]), now());
      // An expired token is not an error here: the report goes in anonymously.
      owner = session?.owner ?? null;
    }
    const ip = ipHash(req);
    const limiter = limiters[r.kind];
    if ((ip && !limiter.take(`ip:${ip}`)) || (owner && !limiter.take(`owner:${owner}`))) {
      res.status(429).json({ error: "too many reports from this device, try again later" });
      return;
    }
    const id = await deps.store.insert({ kind: r.kind, category: r.category, owner, ipHash: ip, payload: r });
    console.log(`feedback: ${r.kind} #${id} [${r.category}] ${r.app.version}${r.app.build ? ` build ${r.app.build}` : ""} ${r.app.platform}`);
    if (deps.notifier) {
      void deps.notifier.send(formatFeedbackNotice(id, r, owner !== null)).catch((e) => console.error("feedback: notify failed", String(e)));
    }
    res.status(201).json({ id });
  });

  if (!deps.adminToken) return router;
  const admin = (req: Request, res: Response): boolean => {
    const m = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
    if (m && safeEqual(m[1], deps.adminToken!)) return true;
    res.status(401).json({ error: "admin token required" });
    return false;
  };

  router.get("/feedback", async (req, res) => {
    if (!admin(req, res)) return;
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit ?? 50)) || 50, 1), 200);
    const before = req.query.before === undefined ? null : Number(req.query.before);
    if (before !== null && !Number.isInteger(before)) {
      res.status(400).json({ error: "before must be an integer id" });
      return;
    }
    const kind = req.query.kind === undefined ? null : oneOf(req.query.kind, FEEDBACK_KINDS, "kind");
    if (kind && !kind.ok) {
      res.status(400).json({ error: kind.error });
      return;
    }
    const status = req.query.status === undefined ? null : oneOf(req.query.status, FEEDBACK_STATUSES, "status");
    if (status && !status.ok) {
      res.status(400).json({ error: status.error });
      return;
    }
    const rows = await deps.store.list({ limit, before, kind: kind?.ok ? kind.value : null, status: status?.ok ? status.value : null });
    if (rows.length === limit) res.setHeader("X-Next-Cursor", String(rows[rows.length - 1].id));
    res.json(rows);
  });

  router.get("/feedback/:id", async (req, res) => {
    if (!admin(req, res)) return;
    const row = await deps.store.get(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: "no such report" });
      return;
    }
    res.json(row);
  });

  router.patch("/feedback/:id", express.json({ limit: "1kb" }), async (req, res) => {
    if (!admin(req, res)) return;
    const status = oneOf((req.body as { status?: unknown } | undefined)?.status, FEEDBACK_STATUSES, "status");
    if (!status.ok) {
      res.status(400).json({ error: status.error });
      return;
    }
    const ok = await deps.store.setStatus(Number(req.params.id), status.value);
    res.status(ok ? 200 : 404).json(ok ? { id: Number(req.params.id), status: status.value } : { error: "no such report" });
  });

  return router;
}
