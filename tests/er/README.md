# tests/er — mb-stack end-to-end scenarios (Task 13)

Real end-to-end scenarios against a running local MagicBlock stack
(`mb-stack`, `@magicblock-labs/ephemeral-validator`), proving spec §8 Q1
(deposit → `free_margin`) and Q2 (three `EphemeralPermission`s in one ER
transaction). No mocks: both `dexxer_core` and `mock_oracle` run as real
deployed programs; `Connection`s hit real L1/ER JSON-RPC endpoints.

## Prerequisites

1. Node 24 (`nvm use 24.18.0`) — `npm`/`npx` are not on `PATH` otherwise.
2. `npm install` in this directory (already done if `node_modules/` exists).
3. A running mb-stack:
   ```bash
   npx --yes --package=@magicblock-labs/ephemeral-validator@0.13.7 mb-stack
   ```
   Endpoints (overridable via `tests/er/.env` or `process.env`, see
   `lib/env.ts`): base L1 `http://127.0.0.1:8899`, ER
   `http://127.0.0.1:7799`, public query-filtering `http://127.0.0.1:6699`.
4. Both programs deployed to the base L1 validator:
   ```bash
   cd ../..   # repo root
   anchor deploy --provider.cluster http://127.0.0.1:8899
   ```
   (`Anchor.toml`'s `[provider] cluster` is `localnet`, so the flag must be
   passed explicitly.)

## Run

```bash
cd tests/er
npm run q1   # spec §8 Q1: deposit -> free_margin
npm run q2   # spec §8 Q2: three permissions in one ER tx (run after q1)
```

Each script logs every step's signature and prints a final `Q1 PASS`/`Q2
PASS` summary object (signatures, balances, compute units). A non-zero exit
code and a `FAIL:`/`*_FAIL` line means an assertion or transaction failed —
scroll up for the specific `ok:`/`FAIL:` line and the raw error.

`q2` assumes `q1` has already run for the same persisted identity (same
`.keys/user.json`): it reuses that user's already-delegated
`UserAccount`/`Position`/`DisclosureQueue`.

### Fresh run vs. re-run

`bootstrap()` (in `lib/admin.ts`) checks on-chain state before every step and
skips whatever already exists, so re-running `npm run q1` against a stack
that already has a bootstrapped market/pool is safe for the *admin* setup
steps. It is **not** safe to re-run `npm run q1` end-to-end expecting the
same balance assertions to hold twice in a row: the script deposits real
funds (pool goes from 10,000 to 11,000 dUSDC), so a second run's "pool ==
10,000e6 before any deposit" assertion will legitimately fail against the
now-11,000e6 pool. For a clean assertion run, start from a fresh mb-stack
(fresh `test-ledger`/`magicblock-test-storage`, redeploy) and clear
`tests/er/.keys/`.

## Files

- `lib/env.ts` — RPC endpoints (base/ER/public), ER validator identity,
  `.keys/`-persisted keypair loader, airdrop, delegation/existence pollers.
- `lib/program.ts` — Anchor `Program` construction for both programs (from
  the built IDLs in `target/idl/`), PDA derivation (`pdas`) matching
  `programs/dexxer_core/src/state/mod.rs`'s seeds, eSPL PDA helpers
  (`espl`), and `#[delegate]`-generated buffer/record/metadata PDAs
  (`delegationTriple`).
- `lib/admin.ts` — `bootstrap()`: deploy is assumed done (see above);
  creates Config/dUSDC mint, Market, Pool (funded to 10,000 dUSDC on L1,
  *before* delegation — see comment in the file for why), the mock oracle
  feed, and delegates Market/MarketRisk/Pool(+its eATA)/Feed to the ER.
- `q1-deposit.ts` — spec §8 Q1 scenario + asserts.
- `q2-permissions.ts` — spec §8 Q2 scenario + asserts (run after q1).

Keys are generated into `.keys/` (gitignored) on first run and reused after
that (`admin`, `mint`, `user`).

## Deviations from the brief found on a real mb-stack (see task-13-report.md)

Three real bugs in `programs/dexxer_core` surfaced only once this ran
against a real eSPL/Permission program (LiteSVM has neither, so none of this
was exercisable before):

1. `delegate_pool`'s hand-rolled `InitializeEphemeralAta` CPI marked the
   payer `is_signer: false` instead of `true` — the eSPL program's own
   System Program CPI then failed with `PrivilegeEscalation`. Fixed to
   `true` (matches the TS SDK's `initEphemeralAtaIx`).
2. `delegate_pool`'s `DepositSplTokens` CPI used a hardcoded `amount: 0` —
   mb-stack accepts it, but then the ER-visible ephemeral balance for
   `pool_ata` is 0 regardless of how much was seeded on L1 first. Changed to
   deposit `pool_ata`'s actual current balance.
3. `InitUser`'s `market` field was `Account<'info, Market>` (owner-checked),
   which fails with `AccountOwnedByWrongProgram` once `market` has already
   been delegated (owned by the Delegation Program) — but users must be able
   to onboard after the market is delegated. Changed to `UncheckedAccount`
   with seeds pinned to the `SOL_SYMBOL` constant (matching `DelegateUser`'s
   existing `market` field), since only `.key()` is read.
4. `init_permissions`'s idempotency check (`perm.lamports() > 0`) never
   detects an already-created `EphemeralPermission`: on this mb-stack
   version those accounts are created with 0 lamports (rent goes into the
   shared `ephemeral_vault`, not the account itself), so a second call
   always re-attempted the CPI and failed with `invalid account data for
   instruction`. Changed the check to `perm.owner == PERMISSION_PROGRAM_ID`.

Also: `@coral-xyz/anchor@0.32.1`'s `AnchorProvider.sendAndConfirm` constructs
`web3_js.SendTransactionError` with the old (pre-1.98) positional
`(message, logs)` signature, but the installed `@solana/web3.js@^1.98`
redefined that constructor to take a single `{action, signature,
transactionMessage, logs}` object — so any transaction that lands on chain
but errors gets its real error message and logs silently discarded, surfaced
only as `SendTransactionError: Unknown action 'undefined'`. When that
happens, fetch the real error via `connection.getSignaturesForAddress` +
`getTransaction(...).meta.logMessages` on the relevant signer instead of
trusting the caught error object.
