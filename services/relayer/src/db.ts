// services/relayer/src/db.ts
//
// PostgreSQL pool + startup migrations. Plain SQL files under
// `migrations/*.sql`, applied in filename order, each one wrapped in its own
// transaction and tracked in a `_migrations(name, applied_at)` table so a
// restart never re-applies one. Task 4 ships only `000_meta.sql`
// (`relayer_meta` — a generic key/value store used to persist
// `lastTickAt`/`lastCommitAt` across restarts, see index.ts); indexer/
// sponsor tables land in Tasks 5/6 as further numbered files, migrated the
// same way.
//
// Local dev without Postgres installed: `DATABASE_URL` unset makes
// `createPool` return `null` (logged warning) rather than crash the
// process. The crank loop never touches Postgres either way; `/healthz`'s
// `db` field simply reports "error" when there's no pool (see health.ts).

import { readdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const { Pool } = pg;
export type DbPool = InstanceType<typeof Pool>;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function createPool(databaseUrl: string | undefined): DbPool | null {
  if (!databaseUrl) {
    console.warn('db: DATABASE_URL not set — running without Postgres (local dev only; /healthz reports db="error")');
    return null;
  }
  // Deployed relayer: `DATABASE_URL` is a Railway reference variable
  // resolving to the Postgres service's *private*-network hostname
  // (`postgres.railway.internal`), which needs no TLS at all — `ssl` stays
  // unset and node-postgres talks plain TCP inside Railway's network.
  //
  // Local smoke test only (Step 5/6 gauntlet): the brief points
  // `DATABASE_URL` at the *public* TCP proxy (`*.proxy.rlwy.net`) instead,
  // which does terminate TLS but with a cert chain Node's default CA bundle
  // does not verify — same relaxation Railway's own docs recommend for
  // that specific public-proxy case. Scoped to that hostname pattern only,
  // so the deployed (private-network) path never takes it.
  const ssl = /\.proxy\.rlwy\.net/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined;
  return new Pool({ connectionString: databaseUrl, ssl });
}

export async function migrate(pool: DbPool | null): Promise<void> {
  if (!pool) return;
  await pool.query("CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const { rowCount } = await pool.query("SELECT 1 FROM _migrations WHERE name = $1", [file]);
    if (rowCount && rowCount > 0) continue;
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    console.log(`db: applying migration ${file}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

export async function getMeta(pool: DbPool, key: string): Promise<string | null> {
  const { rows } = await pool.query<{ value: string }>("SELECT value FROM relayer_meta WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setMeta(pool: DbPool, key: string, value: string): Promise<void> {
  await pool.query(
    "INSERT INTO relayer_meta (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    [key, value],
  );
}
