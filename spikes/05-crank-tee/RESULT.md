# Check 5 — scheduler (crank) ticks inside devnet-tee
Status: PASS
Program: Ctj6Hz5RG8cPDgmrDPKGjqKVNdHi7x7hmhKshy5wsNyA  Counter PDA: 9sR8qZsTHenRtKXfaTHaiu6LYBPBMotyKFzS2rTL3qkZ
Delegate sig: 3xPtF4z3J4M71JZ6G4CTA1R6J4Qe5bTq6s3YfSFuf3YEqPafcDaoqFBAPUJ9EhAFQBtgm23V8ackicDzUhjdqf1n
Schedule sig (ER): 27yoVEtAeVBJ6QAVRQ8zvXi3dgjQTRFAaLZzAVg9HV3i3wKvWgcX7M5fJeKYf1jQKwdT7e8VbfhDYbvZDnwpiTJr
Router fqdn: https://devnet-tee.magicblock.app/
Ticks observed in 20 s: **27** (requested cadence: `execution_interval_millis = 1000`, `iterations = 30`)
Decision: spec §3.5 crank cadence confirmed working; scheduler ticks land noticeably faster than the requested
1000 ms interval (observed ≈1.35 ticks/s), so any §3.5 liquidation-crank cadence budget should treat 1000 ms as
a *floor request*, not a guaranteed period — see Finding below.

## Deploy

- Toolchain: `anchor-cli 1.0.2`, `solana-cli 3.1.10`, `rustc 1.89.0`, `ephemeral-rollups-sdk = 0.16.0` (git rev
  `0fc4604157de51df28693e02e5a1a6a4a08c8a03`), matching the vendored example exactly (no dependency changes
  needed for this repo's toolchain — same versions Check 1/3's build already validated).
- `anchor keys sync` regenerated the program keypair and rewrote `declare_id!`/`Anchor.toml` to
  `Ctj6Hz5RG8cPDgmrDPKGjqKVNdHi7x7hmhKshy5wsNyA`.
- `anchor build`: first build (cold `target/`), ~55 s wall clock (faster than the 10–20 min budget — most
  ephemeral-rollups-sdk/solana crates were already warm in `~/.cargo/registry` from earlier spikes' builds).
  `target/deploy/crank_counter.so` = 314,032 bytes (~307 KB).
- Payer balance before deploy: 2.220264918 SOL (above the 1.9 SOL go/no-go threshold from the task brief, so
  the deploy was attempted per instructions).
- `anchor deploy --provider.cluster https://rpc.magicblock.app/devnet --provider.wallet ../keys/payer.json`:
  `Deploy success`. IDL deploy was skipped (`Warning: IDL file not found at target/idl/crank_counter.json,
  skipping IDL deployment`) — harmless: the package/lib name (`crank_counter`) differs from the `#[program]`
  module name (`anchor_counter`), so Anchor's `anchor build` wrote the IDL to
  `target/idl/anchor_counter.json`, not `crank_counter.json`. `check.ts` imports the IDL from its actual path
  and does not need the on-chain IDL account.
- Payer balance after deploy: 0.621695398 SOL. **Deploy cost: 1.59857 SOL.**
- `user` keypair (≈1.99 SOL) was used for all `initialize`/`delegate`/`scheduleIncrement` transactions, per the
  task's budget-isolation instruction; its balance was untouched by the deploy.

## Deviations from the brief's illustrative check.ts

The brief's skeleton is illustrative; the real IDL (from `tests/crank-counter.ts` and
`programs/crank-counter/src/lib.rs` in the vendored example) differs in several concrete ways:

1. **Counter PDA seed is `["counter"]` only** — a single global counter, not per-user
   (`["counter", user.pubkey]` as the brief sketch guessed). Confirmed in `Initialize`'s account constraint:
   `seeds = [COUNTER_SEED], bump`.
2. **`initialize()` account is named `user`, not `payer`** (`Initialize<'info>` has `pub user: Signer<'info>`).
3. **`delegate()` accounts are `{ payer, pda: counterPDA }`**, not `{ payer }` alone as the brief sketch
   implied — the example's generic `#[delegate]` macro produces a `DelegateInput` struct with a `pda` account,
   not `counter`. The validator is passed via `remainingAccounts` exactly as the brief described.
4. **`scheduleIncrement()` accounts are `{ magicProgram, payer, program }`** — `counter` is present in the IDL
   (it's a PDA-seeded `UncheckedAccount` in `ScheduleIncrement<'info>`) but Anchor's TS client resolves it
   automatically from the `["counter"]` seed with no external dependency, so it does not need to be passed
   explicitly; the vendored test (`tests/crank-counter.ts`) omits it too and `check.ts` mirrors that.
5. **IDL/program name mismatch**: `Cargo.toml` package/lib name is `crank_counter`, but the `#[program] mod
   anchor_counter { ... }` module name is `anchor_counter` — Anchor names the generated IDL and TS types after
   the module, so the IDL file is `target/idl/anchor_counter.json`, not `crank_counter.json` as the brief's
   import path assumed. `check.ts` imports from the correct path.

No preflight simulation failures occurred: `initialize`, `delegate`, and `scheduleIncrement` all succeeded on
the first `rpc()` call, so the `skipPreflight: true` retry path in `check.ts`'s `sendRpc` wrapper was never
exercised.

## 20 samples (1 per second, ER connection)

`c0` = counter value read immediately after the `scheduleIncrement` transaction confirmed (already 2, since
the scheduler had already fired twice by the time the fetch landed):

```
c0: 2
samples (t+1s .. t+20s):
[ 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19, 21, 22, 23, 24, 26, 27, 29 ]
```

`ticks = samples[19] - c0 = 29 - 2 = 27` → **CHECK 5 PASS** (`>= 12` required).

**Finding**: the observed cadence (27 ticks / 20 s ≈ 1.35 ticks/s, ≈740 ms average inter-tick spacing) is
faster than the requested `execution_interval_millis = 1000`. The scheduler CPI's requested interval is a
lower bound on submission spacing under load, not a guaranteed exact period — likely because the crank
executor batches/pipelines pending scheduled tasks rather than sleeping a full 1000 ms between each tick. For
spec §3.5 (liquidation crank cadence), this means the engine should budget for *at least* the requested rate,
not assume ticks land exactly on the requested boundary; downstream logic (e.g. a liquidation check that
compares "time since last tick") must not assume a fixed 1000 ms delta between ticks.

The full 30-iteration schedule was not exhausted within the 20 s observation window (29 of 30 increments
observed) — consistent with the counter's `count > 1000 → reset to 0` guard never firing during this run.

## check.ts stdout

```
program: Ctj6Hz5RG8cPDgmrDPKGjqKVNdHi7x7hmhKshy5wsNyA
counterPDA: 9sR8qZsTHenRtKXfaTHaiu6LYBPBMotyKFzS2rTL3qkZ
initialize sig: 5WSHd223ksEBzzH3vgwC6vXaem6tKaeTYGgw37JKcYa85DPNnbFWvGEmCBeFnQ1CXS6RaU5Gvr5BJkP4j1d9j554
delegate sig: 3xPtF4z3J4M71JZ6G4CTA1R6J4Qe5bTq6s3YfSFuf3YEqPafcDaoqFBAPUJ9EhAFQBtgm23V8ackicDzUhjdqf1n
ok: router reports delegated
ok: fqdn is TEE endpoint: https://devnet-tee.magicblock.app/
router fqdn: https://devnet-tee.magicblock.app/
scheduleIncrement sig: 27yoVEtAeVBJ6QAVRQ8zvXi3dgjQTRFAaLZzAVg9HV3i3wKvWgcX7M5fJeKYf1jQKwdT7e8VbfhDYbvZDnwpiTJr
c0 (count at schedule time): 2
t+1s: 3
t+2s: 5
t+3s: 6
t+4s: 7
t+5s: 9
t+6s: 10
t+7s: 11
t+8s: 13
t+9s: 14
t+10s: 15
t+11s: 17
t+12s: 18
t+13s: 19
t+14s: 21
t+15s: 22
t+16s: 23
t+17s: 24
t+18s: 26
t+19s: 27
t+20s: 29
{
  c0: 2,
  samples: [
     3,  5,  6,  7,  9, 10, 11,
    13, 14, 15, 17, 18, 19, 21,
    22, 23, 24, 26, 27, 29
  ]
}
ticks observed in 20s: 27
ok: >=12 ticks in 20s at 1000ms interval (got 27)
CHECK 5 PASS { program: 'Ctj6Hz5RG8cPDgmrDPKGjqKVNdHi7x7hmhKshy5wsNyA', counterPDA: '9sR8qZsTHenRtKXfaTHaiu6LYBPBMotyKFzS2rTL3qkZ', ticks: 27 }
```
