# Check 3 — ER reads a non-delegated L1 account
Status: **PASS (fresh clone)**
Program: `Gn3UvsXPdWrBJGmz3sxYSgFjF9pJy8b92cpSanMKYCCJ`  Counter PDA: `9vbXJwsJsEe7gRWW3q23iLHZsiRfSzTCAMGy611E618c`  Config PDA: `4cdN75h3sZ4me9pZT4g4ZXAuGHaxc3J1LsazkxS3niWr`
Counter values: before=0, after1=5, after2=12 → `after1 === before + 5` and `after2 === after1 + 7`
Decision: spec risk #2 (ER-read accounts must be delegated) does **not** apply as strictly as feared — a non-delegated, read-only `Config` account on L1 is safe to read from ER instructions and reflects up-to-date L1 state on every ER transaction, no re-delegation trigger needed. Confirmed with an independent second run (see §5).

## 1. Setup — copy, rename, add Rust

Copied `spikes/01-private-counter-tee/{programs,Anchor.toml,tests,package.json,Cargo.toml}` into `spikes/03-l1-readonly-clone/`. Renamed the crate: `programs/private-counter/` → `programs/l1-readonly/`, `Cargo.toml` `[package] name = "l1-readonly"` / `[lib] name = "l1_readonly"`, `lib.rs` `pub mod private_counter` → `pub mod l1_readonly`. `tests/private-counter.ts` renamed to `tests/l1-readonly.ts` (vendor file, unused by `check.ts`, not otherwise edited).

Added to `programs/l1-readonly/src/lib.rs`, exactly per the brief: `CONFIG_SEED`, `Config` account, `init_config`, `set_step`, `increment_by_config` handlers (registered automatically by being inside the `#[ephemeral] #[program] pub mod l1_readonly { ... }` block, alongside the existing `initialize`/`delegate`/`increment`/`init_permission`/`set_privacy`/`close_permission`/`commit`/`undelegate`), and the `InitConfig`/`SetStep`/`IncrementByConfig` `#[derive(Accounts)]` contexts. `COUNTER_SEED` in the copied file was already `pub const COUNTER_SEED: &[u8] = b"counter";` — matched as-is.

`anchor keys sync` generated a **new** program keypair (not Task 3's `2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7`):
```
Found incorrect program id declaration in ".../programs/l1-readonly/src/lib.rs"
Updated to Gn3UvsXPdWrBJGmz3sxYSgFjF9pJy8b92cpSanMKYCCJ
```

`anchor build`: no errors, no warnings. Ran in the background; completed in well under the 10-20 min worst case (this environment already has most of the dependency tree cached — same as Task 3's finding). Artifacts:
- `target/deploy/l1_readonly.so` (369712 bytes)
- `target/deploy/l1_readonly-keypair.json` → pubkey `Gn3UvsXPdWrBJGmz3sxYSgFjF9pJy8b92cpSanMKYCCJ`
- `target/idl/l1_readonly.json` — instructions: `close_permission, commit, delegate, increment, increment_by_config, init_config, init_permission, initialize, process_undelegation, set_privacy, set_step, undelegate`

`package.json` already had `"type": "module"` (copied from Task 3's fixed version) — no edit needed.

## 2. Deploy

Payer balance before deploy: `3.721695398 SOL` (well above the 1.8 SOL floor; Task 9 still needs ~1.6 SOL after this).

```
anchor deploy --provider.cluster https://rpc.magicblock.app/devnet --provider.wallet ../keys/payer.json
```
```
Deploying program "l1_readonly"...
Program ID: Gn3UvsXPdWrBJGmz3sxYSgFjF9pJy8b92cpSanMKYCCJ
Writing metadata account...
 ├─ metadata: EYCyjwdXL6fuwapUZXcqgC7QphGKNoGkNmcs4p2tW32V
 ├─ program: Gn3UvsXPdWrBJGmz3sxYSgFjF9pJy8b92cpSanMKYCCJ
 └─ seed: idl
[Success] Operation executed successfully
IDL initialized.
Deploy success
```
`solana program show Gn3UvsXPdWrBJGmz3sxYSgFjF9pJy8b92cpSanMKYCCJ --url https://rpc.magicblock.app/devnet`:
```
Owner: BPFLoaderUpgradeab1e11111111111111111111111
ProgramData Address: 4K8WLFuikpTSVZBdgZchtGquY2vEcaWevZysJyhYHSpN
Authority: 4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM
Last Deployed In Slot: 500716303
Data Length: 369712 bytes
Balance: 1.8790158 SOL
```
Payer balance after deploy: `1.82403503 SOL` (≈1.898 SOL spent — the largest chunk is the `1.879 SOL` program-data account rent, consistent with Task 3's `1.749 SOL` for a smaller 344056-byte program). Leaves ≈0.224 SOL of headroom above Task 9's ~1.6 SOL need — tight; flagging for whoever runs Task 9 next.

## 3. check.ts — deviations from the brief's illustrative script

1. Setup (steps 1–3: `initialize`, `delegate` to `TEE_VALIDATOR`, `initPermission`/`setPrivacy(true)`, router-status wait, TEE auth token, re-run guard on the permission PDA) copied verbatim from `spikes/01-private-counter-tee/check.ts`, program renamed `l1_readonly`, `stranger`-read assertions (steps 4–7 of Task 3's script) dropped — out of scope for Check 3, which is only about the `Config` clone.
2. Added a Config-init step (`init_config(5)`, guarded by `baseConn.getAccountInfo(configPDA)` so it only runs once) before the brief's Check-3 block, since the brief's snippet assumes `initConfig` has already run.
3. `sendRpc` wrapper (same as Task 3's) used for every instruction call for consistent skipPreflight-retry-and-log behavior; the brief's inline `.rpc()` calls all succeeded on the first attempt in the documented run below.
4. The brief's script `process.exit`s hard via `assert()` on the first failure. Kept `assert()` for the documented-PASS path (per-brief), but wrapped the *first* `incrementByConfig` call in a try/catch: if it throws (account-not-found / not cloned), the script prints `CHECK 3 RESULT: NO CLONE` and exits 0 instead of crashing — so a "no clone" outcome is still legible as a script result, not an unhandled exception. Not exercised in the documented run (the first call succeeded).
5. Added a three-way `after2` classification (`after1+7` fresh / `after1+5` stale / neither → "unexpected") instead of a single hard `assert`, per the brief's instruction to record whichever outcome occurs rather than force a PASS.

## 4. check.ts run — full stdout (the documented run)

```
program: Gn3UvsXPdWrBJGmz3sxYSgFjF9pJy8b92cpSanMKYCCJ
counterPDA: 9vbXJwsJsEe7gRWW3q23iLHZsiRfSzTCAMGy611E618c
configPDA: 4cdN75h3sZ4me9pZT4g4ZXAuGHaxc3J1LsazkxS3niWr
initialize sig: Nfy37MQyrNEBUXAKZzB6iuS5kLNyrejuAzRe4tMAQNt5tuvdft2cAJ6bQnWXH2hX2AHsYDBpADSDcdbaPS2rQ7N
delegate sig: UA5dgcogFMdSiGZxBA6AeessmHrcHbQh9A93FAXNRhSGuUAH9qAH81g7S4eZ48Crkk1tPZ2gHu6Rgxs3PgXzPUi
ok: router reports delegated
ok: fqdn is TEE endpoint: https://devnet-tee.magicblock.app/
router fqdn: https://devnet-tee.magicblock.app/
initPermission sig: 5WNxJV7pzL8TkgdxcCvfYy5cygfv5ZNSiawHiAmARKBw18vAvQYryre9A4zp33D1Y3wKBhEeooqzy4Xoe4p95DjN
setPrivacy(true) sig: hq8ifaj29b5659oqbHEe92yAmuTBV83P7swZ3RtTsrucu9ViYHfhLwVdHWRF7pTHMvTotXsNTQpZQbvMRy1KG5v
initConfig sig: 4M87rF5T86AXU3d8Po656RBsreeRFiPRKmtEyTvyUXTX17DqAgk8QnQG2s2vrFDYaMB9DzvAPxfKsxCCKRrKWUm2
incrementByConfig (1st) sig: 2AnrDv7wdddtKAJQb54S7jt1cUunrRRciNKR1rG6pasipWph2zCPUqB7W95kmSfFBAfUtrJT6LDvezQFLyKZX8jQ
ok: ER read config.step=5 from non-delegated L1 account
setStep(7) sig: 2TutEEq1fFKMZoCoNUKPMUtFbYRpqQNM4KHE8zeTzG5HwijCZexNbTeChsxyVkG9rJ3h2cVEZfSYQeYTrP6kb8qK
incrementByConfig (2nd) sig: 3T2LUvLAg5mnuEgMpiXrSNqb49S41cnRQNsQDqRdkUpMN3MoydFjU5A6j3kzAZjVSrV8CNbSTjukngDXkH3XFGYJ
{ before: 0, after1: 5, after2: 12 }
CHECK 3 PASS — fresh clone: ER re-read the updated L1 Config value without re-delegation.
```

No transaction hit a preflight simulation failure; every `sendRpc` call succeeded on the first attempt (`initialize`, `delegate`, `initPermission`, `setPrivacy(true)`, `initConfig`, `incrementByConfig` ×2, `setStep(7)`).

## 5. Interpretation and a stronger, independent confirmation

Per the brief:
- `after1 === before + 5` (0 → 5): the ER-side `increment_by_config` instruction successfully read `config.step = 5` off the **non-delegated** L1 `Config` account — proves the ER clones L1-only accounts read-only rather than erroring "account not found."
- `after2 === after1 + 7` (5 → 12), after `set_step(7)` was submitted on L1 and a 3s wait: the ER's clone of `Config` reflected the **new** L1 value on the very next ER transaction, with no explicit re-delegation or cache-invalidation step. This is the "fresh clone" outcome, not "stale clone" (`after2 === after1 + 5` would have been 10, not 12).

**Independent re-run** (not part of the required single documented run, done as a reproducibility check, same pattern as Task 3 §8): ran `check.ts` a second time. `initialize`/`delegate`/`initPermission`/`setPrivacy`/`initConfig` all hit their "already exists, skipping" guards (state persisted from run 1). The re-run's own `assert(after1 === before + 5, ...)` then **failed** — but only because it's hardcoded to the brief's illustrative `+5`, and by this point L1 `config.step` was durably `7` (set by run 1's `set_step(7)`, still in effect):
```
incrementByConfig (1st) sig: 5bmZ9ush5tLPQDjgBG8Y1b3AZqrBnGZ7mWANFB4fK3eGseskeneWFYvTnCDZKXbYe6FKjHzPHZ3jePoUZ3a8yypj
FAIL: ER read config.step=5 from non-delegated L1 account
```
Verified directly (separate ad-hoc scripts, not committed):
- L1 `Config.step` at the time of this second run: `7` (`program.account.config.fetch(configPDA)` against `baseConn` → `L1 config.step: 7`).
- Counter value after this second run's `incrementByConfig (1st)`: `19` via `erProgram.account.counter.fetch(counterPDA)` on a **brand-new TEE auth token / connection** in a **separate process invocation** — exactly `12` (run 1's final `after2`) `+ 7` (the current, persisted L1 step), not `+5`.

This second, independent process — with its own fresh TEE token and no in-memory state carried over from the first run — still read the *current* L1 value (`7`), not a value cached from earlier in the account's history. That rules out "stale clone" (which would have kept serving whatever value was cloned once, e.g. the original `5`) even more conclusively than the single documented run alone. **Conclusion stands: PASS (fresh clone).** The re-run's `FAIL:`/exit-1 is a test-script limitation (hardcoded expected delta), not evidence against the clone being fresh — recorded here for honesty rather than omitted.

## 6. Files

- `spikes/03-l1-readonly-clone/check.ts`
- `spikes/03-l1-readonly-clone/RESULT.md`
- `spikes/03-l1-readonly-clone/Anchor.toml`, `Cargo.toml`
- `spikes/03-l1-readonly-clone/programs/l1-readonly/{Cargo.toml,src/lib.rs}`
- `spikes/03-l1-readonly-clone/tests/l1-readonly.ts` (unmodified vendor copy, renamed only)
- `spikes/03-l1-readonly-clone/package.json`
