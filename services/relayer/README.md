# services/relayer

Crank fallback for the Dexxer ER scheduler, packaged as an always-on Railway
service (moved from `scripts/crank-fallback`, Task 4 / week 4). Holds ONLY
`crank` and `fee_payer` keys — never owner/session tokens — and reads only
public accounts, the oracle, and the private accounts `crank` is already a
permission member of (privacy rule, see repo `CLAUDE.md`).

## What it does

- `src/crank.ts` — the 1s `crank_tick` loop (liquidation candidates via
  `getProgramAccounts`), moved from `scripts/crank-fallback/index.ts`.
- `src/disclosure.ts` — the ~5-min `set_balances_root` + `commit_aggregate`
  + `mark_committed` cycle, moved unchanged (import paths only) from
  `scripts/crank-fallback/disclosure.ts`.
- `src/keys.ts` — `keypairFromEnv(name, fileFallback)`: bs58 secret key from
  an env var in production, `tests/er/.keys/<fileFallback>.json` (via
  `loadOrCreateKey`) for local dev.
- `src/health.ts` — `GET /healthz`, Railway's healthcheck target.
- `src/db.ts` — Postgres pool + startup SQL migrations
  (`migrations/*.sql`).
- `src/index.ts` — wires the above together, graceful `SIGTERM`.

## Env vars

| Var | Required | Notes |
| --- | --- | --- |
| `DEXXER_NET` | no (default `local`) | `devnet` switches `tests/er/lib/env.ts`'s RPC/TEE profile |
| `CRANK_KEY_B58` | prod | bs58 secret key; local dev falls back to `tests/er/.keys/devnet-crank.json` / `admin.json` |
| `FEE_PAYER_KEY_B58` | prod | same, falls back to `devnet-fee-payer.json` / `admin.json` |
| `PORT` | no (default `8080`) | HTTP port |
| `DATABASE_URL` | prod | Postgres connection string (Railway reference variable to the Postgres plugin); unset = no persistence, `/healthz`'s `db` reports `"error"` |
| `CRANK_INTERVAL_MS` | no (default `1000`) | tick cadence |
| `INDEXER_ENABLED` / `SPONSOR_ENABLED` | no (default `false`) | reserved for Tasks 5/6 |

Never commit key values. Encode a local keyfile for Railway with:

```ts
bs58.encode(Uint8Array.from(JSON.parse(readFileSync("tests/er/.keys/devnet-crank.json"))));
```

## Local dev

```sh
cd services/relayer
npm install
DEXXER_NET=devnet npm start   # crank + fee-payer keys auto-loaded/created under tests/er/.keys/
curl localhost:8080/healthz
```

Without `DATABASE_URL` set, `db.ts` logs a warning and runs without
Postgres — the crank loop is unaffected; only `/healthz`'s `lastTickAt`/
`lastCommitAt` persistence across restarts and its `db` field are skipped.

## Tests

```sh
npm test        # node:test — keypairFromEnv b58 round-trip, health-payload staleness logic
npx tsc --noEmit
```

## Docker / Railway

Build context is the **repo root**, not `services/relayer/` — see
`Dockerfile`'s header comment for why (it needs `tests/er/lib/*.ts` and the
committed `app/src/idl/dexxer_core.json`). Railway service config: root
directory `/`, `RAILWAY_DOCKERFILE_PATH=services/relayer/Dockerfile`.

Deployed project/service ids, domain, and PDA/program references live in
`docs/deployments.md` (repo root).
