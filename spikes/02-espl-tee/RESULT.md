# Check 2 — Ephemeral SPL Token inside the TEE

**Status: PASS**

Proves: `delegateSpl` (deposit + delegate) on base, `transferSpl` between two
owners inside the TEE ephemeral rollup, and balances readable on the ER. Also
probes whether a non-owner can read another owner's ER token account balance
(spec §2.1: "margin is accounting, not tokens").

## Environment

- `TEE_RPC` = `https://devnet-tee.magicblock.app`
- `TEE_VALIDATOR` = `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`
- `@magicblock-labs/ephemeral-rollups-sdk` 0.17.0
- Keypairs reused from Task 2: `payer`, `user`, `stranger` (used here as the
  second SPL owner "pool" — see deviations below).

## SPIKE_MINT (reusable by Task 10)

```
44FTm7zsYePyuBzLmQDjxk53eioxqzkdEW28FEPnSNBk
```
6 decimals, mint/freeze authority = payer (`4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM`).

- user ATA (base): `F82SwPjfgZV7VpPvrdFwF4MK5XGaqpkAtU4Zc1ippXmS`
- pool ATA (base): `22fh32iVNBkv8rCBxTXG3N8AnaS2QmQRmfH43Czhms92`

## Signatures

| Step | Signature |
|---|---|
| user `delegateSpl` (deposit 500 dUSDC, initVaultIfMissing=true) | `44ci33H2nFg2bhGEa6vPFfVAuEpveCzFaHJ4e6GnKHNUWe6cf1YBjFzbVcNMnmsh67eYKkkJXo7edXnqLenHLiVT` |
| pool `delegateSpl` (deposit 0, initVaultIfMissing=false) | `4faF2myLkGTpTGhKSstGxQfdxVDNR7jtM4NpSCvC4NJB3J9UdTBvYLG3HyX6PNYNL8ZA5Jq8GyhM7VC4aYS7TzS3` |
| ER `transferSpl` (user -> pool, 100 dUSDC, public/ephemeral->ephemeral) | `2CZHv9YUCN9Gmo3QQcdHj6md1L1oSLnSaTSaraS4jxENMXpWa36SEkjPUUjvRVNdLLA2Qnpz8nGAvgX7z5sQLtHS` |

`rentPda` (`4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp`) already held
14.56 SOL, well above the 0.1 SOL threshold, so no top-up transaction was
sent (shared PDA funded by other spikes/prior runs).

## Balances (all amounts in base units, 6-decimal mint)

| Owner | Base ATA (pre-delegate) | Deposited on delegate | ER balance (post-delegate) | ER balance (post-transfer) |
|---|---|---|---|---|
| user | 1,000,000,000 (1000 dUSDC) | 500,000,000 | 500,000,000 | 400,000,000 |
| pool | 10,000,000 (buffer, unused) | 0 | 0 | 100,000,000 |

Pool's `0n` deposit was **accepted** by the SDK/program on the first attempt
— no fallback to `1_000_000n` was needed. (The script still pre-funds pool's
base ATA with a 10,000,000 buffer in case a retry was needed; it went
unused.)

Both `assert()` checks passed:
- `pool ER balance = 100000000 after transfer` — ok
- `user ER balance = 400000000` — ok

## Stranger-read probe (spec §2.1: "margin is accounting, not tokens")

Ran `getAccount(teePool, userAta)` — i.e. read the **user's** ER token
account using a TEE connection authenticated with **pool/stranger's own**
auth token (`getAuthToken` with the `stranger` keypair). This is the same
keypair used as the second SPL owner in this spike, so its own token is a
distinct, independently-authenticated identity from the user.

**Result: NOT readable.** `@solana/spl-token`'s `getAccount` threw
`TokenAccountNotFoundError`. The raw underlying JSON-RPC call
(`getAccountInfo`, `commitment: "confirmed"`) confirms this is not an
auth/HTTP error but a scoped null result:

```
HTTP 200
{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":317236860},"value":null}}
```

**Implication for the spec:** SPL token account reads on this TEE validator
are already owner-scoped at the RPC layer (same behavior observed for the
private-counter PDA in Check 1/Task 3) — a stranger's own auth token cannot
see another owner's ephemeral token account at all, not even its balance.
This is a *stronger* result than the spec's minimum bar ("margin is
accounting, not tokens" only requires that the *margin/position* numbers be
hidden, not necessarily the raw token balance) — here the token account
itself is invisible cross-owner. This is good news for the custody design:
Ephemeral SPL Token's account-level access control gives privacy "for free"
on the collateral leg, so the custody design (Global Vault + eATA) does not
need a separate mechanism to hide raw token balances; commit-then-reveal
still governs when net P&L/position state becomes visible per spec.

Note: this does not by itself prove *arbitrary* strangers (not previously
authenticated at all, or unrelated pubkeys) can't guess/derive access another
way — it proves that the RPC-level scoping the TEE enforces for a
differently-authenticated, unrelated owner keeps the account invisible. That
matches the mechanism already validated in Task 3/Check 1 for the private
counter PDA.

## Deviations from the brief's illustrative script

1. **`initVaultIfMissing` split, not uniform `true`.** The brief's loop sets
   `initVaultIfMissing: true` for both owners. The SDK's own example test
   (`/tmp/mb-examples/spl-tokens/anchor/tests/spl-tokens.ts`) explicitly only
   sets it `true` for the first delegator and `false` for the second
   ("A's delegation creates the shared vault for this mint; B reuses it.").
   We followed the tested pattern: `true` for `user` (first), `false` for
   `pool` (second), both sharing the one per-mint vault.
2. **`initAtasIfMissing` dropped.** Inspecting
   `node_modules/@magicblock-labs/ephemeral-rollups-sdk/lib/instructions/ephemeral-spl-token-program/ephemeralAta.js`,
   `delegateSpl` with `idempotent: false` calls `buildDelegateSplInstructions`,
   which never reads `opts.initAtasIfMissing` (only the idempotent/shuttle
   path does). The option would have been silently ignored; we removed it
   instead of passing a no-op key. The base ATAs are created in step 1 via
   `getOrCreateAssociatedTokenAccount`, which this non-idempotent path
   requires anyway.
3. **Explicit polling before assertions.** Added a `waitForErBalance` helper
   (`getAccount` retried every 500ms, up to 60 attempts) after both the
   delegate step and the transfer step, matching a documented race in the
   SDK's own test ("Base-layer delegation can confirm before the ER has
   cloned the token account. Poll the ER view before sending transfer
   instructions."). In this run every poll succeeded on the first attempt
   (`attempt 0`), but the guard is kept for reliability.
4. **TEE connections built with explicit `wsEndpoint` carrying the token**
   (`${TEE_WS}?token=...`), matching Task 3's working `check.ts` pattern,
   instead of relying on web3.js's default http->ws URL derivation for the
   query-string-authenticated endpoint.
5. **Pool pre-funded with a 10,000,000 unit buffer** on its base ATA in case
   the `0n` deposit was rejected and a `1_000_000n` retry was needed (per the
   brief's fallback instruction). Not needed in this run — `0n` was accepted.
6. **`pool` keypair doubles as the "stranger" identity** for the read-probe,
   as implied by the brief's own variable naming (`const pool =
   loadKeypair("stranger")`) — no third keypair was introduced.
7. No `EphemeralAtaValidatorMismatch` (`0x7`) was encountered on this run —
   these keys had not been delegated to a different validator previously.

## Full stdout

```
mint 44FTm7zsYePyuBzLmQDjxk53eioxqzkdEW28FEPnSNBk
userAta F82SwPjfgZV7VpPvrdFwF4MK5XGaqpkAtU4Zc1ippXmS
poolAta 22fh32iVNBkv8rCBxTXG3N8AnaS2QmQRmfH43Czhms92
rentPda 4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp balance 14.55919012 SOL
delegateSpl user JAMfwKsWBpug6UpsjwRc71w7rRbzZgAn7tTisvzFHe3D 44ci33H2nFg2bhGEa6vPFfVAuEpveCzFaHJ4e6GnKHNUWe6cf1YBjFzbVcNMnmsh67eYKkkJXo7edXnqLenHLiVT
delegateSpl pool (deposit 0) ECoz1Asro8EJbuYwWuWC9aVSafPeZZtSuCPQCxR72BmV 4faF2myLkGTpTGhKSstGxQfdxVDNR7jtM4NpSCvC4NJB3J9UdTBvYLG3HyX6PNYNL8ZA5Jq8GyhM7VC4aYS7TzS3
ok (poll): user ER balance (post-delegate) = 500000000 (attempt 0)
ok (poll): pool ER balance (post-delegate) = 0 (attempt 0)
er transfer 2CZHv9YUCN9Gmo3QQcdHj6md1L1oSLnSaTSaraS4jxENMXpWa36SEkjPUUjvRVNdLLA2Qnpz8nGAvgX7z5sQLtHS
ok (poll): user ER balance (post-transfer) = 400000000 (attempt 0)
ok (poll): pool ER balance (post-transfer) = 100000000 (attempt 0)
ER balances user/pool: 400000000n 100000000n
ok: pool ER balance = 100000000 after transfer
ok: user ER balance = 400000000
stranger read of user's ER ATA FAILED: TokenAccountNotFoundError
CHECK 2 PASS {
  mint: '44FTm7zsYePyuBzLmQDjxk53eioxqzkdEW28FEPnSNBk',
  userDelegateSig: '44ci33H2nFg2bhGEa6vPFfVAuEpveCzFaHJ4e6GnKHNUWe6cf1YBjFzbVcNMnmsh67eYKkkJXo7edXnqLenHLiVT',
  poolDelegateSig: '4faF2myLkGTpTGhKSstGxQfdxVDNR7jtM4NpSCvC4NJB3J9UdTBvYLG3HyX6PNYNL8ZA5Jq8GyhM7VC4aYS7TzS3',
  erSig: '2CZHv9YUCN9Gmo3QQcdHj6md1L1oSLnSaTSaraS4jxENMXpWa36SEkjPUUjvRVNdLLA2Qnpz8nGAvgX7z5sQLtHS',
  userDeposit: '500000000',
  poolDeposit: '0',
  transferAmount: '100000000',
  userErBalance: '400000000',
  poolErBalance: '100000000',
  strangerReadOk: false,
  strangerReadRaw: 'TokenAccountNotFoundError'
}
```

## Conclusion

CHECK 2 PASS. Ephemeral SPL Token (`delegateSpl` + `transferSpl`) works
against the TEE validator as designed: deposit+delegate on base, transfer
inside the TEE ER, balances correctly reflect the transfer for both owners.
No spec risk triggered — custody design (Global Vault + eATA, Option 2 core)
stands; Plan B (own escrow vault) is not needed. The stranger-read probe
additionally confirms token account reads are owner-scoped at the TEE RPC
layer, which is a bonus in favor of the current design.
