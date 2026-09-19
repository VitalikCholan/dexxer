# Check 7 — Magic Action writes an L1 account after commit; direct call rejected

Status: **PASS**

Program: `6Tm2qGHSsmYhaCtLmWf7TQ2VBi84s2bzuzrHKGFePoxR` (upgraded during this task; last deployed slot `500747537`)
Counter PDA: `HyQ2MdAWESoNi36KP3u6gqHiDVXqMYQgh8jCVjsdwLDX`  Leaderboard PDA: `6RDRRszaPU2JLi8dBgdC2PdngRppiCNSUQLvF8JrZYt4`
Escrow PDA (index 255, escrow_auth = user): `7tSuwoRxtbwiccZo93NnDnMKqxSUhSBjtMp2DrKuL5wh`

ER commit+action sig: `2mfdiacoXjiFEaZrLxwy2xio3f1EfS8wAmGLMDANTG16UAyJDk2496NfF3jgrBEYHV5jGX3KKoqAL9bqZHS78kT6`
Base commit sig (`GetCommitmentSignature`): `3vwcYnLKSDtnCd36xVWdTHDd1qdb9zn5jEsjLU4hceW69DhGNDWVV7dzP8cvZJoTfpu6oACXvQ2cJ6JN7iTPAM9b`
Leaderboard `highScore`: 0 (before) → **3** (after, matches ER counter count). Seconds ER-tx → L1 effect: **4.702s**.
Direct call to `updateLeaderboard` from `user` (base, no delegation-program signature): **rejected client-side**,
`Signature verification failed. Missing signature for public key [7tSuwoRxtbwiccZo93NnDnMKqxSUhSBjtMp2DrKuL5wh]`.

## Reconstructed prior state (before this session)

The prior implementer had: cloned the example into `spikes/06-magic-action/`, written `lib.rs` with the escrow
signer/address check on `UpdateLeaderboard` (matching the skill's "Verify the Caller" pattern) but **without**
a `source_program` field despite a comment above the struct claiming one was present, written a complete
`check.ts` that already anticipated a `sourceProgram: program.programId` account on the direct-call step, and
two debug helpers (`inspect_sigs.mjs`, `inspect_basesig.mjs`) used to pull base-layer signature history and raw
transaction logs for the program and leaderboard PDA. The program was deployed once (slot `500719665`,
authority = `payer`), but `target/deploy/magic_actions.so` was rebuilt at 09:10, seven minutes after that
09:03 deploy — i.e. `lib.rs` had been edited and rebuilt after the only deploy, and the fix was never pushed to
devnet. `Anchor.toml`'s `[programs.devnet]` entry also still pointed at a stale program id
(`FNG2W4yLLuT3ZsuHC94oDFKBxyyPtW6GHkPz1i669VPZ`) that didn't match `declare_id!`
(`6Tm2qGHSsmYhaCtLmWf7TQ2VBi84s2bzuzrHKGFePoxR`) — fixed as part of this task (see Deviations).

Running the inherited `inspect_sigs.mjs` before any new transactions showed exactly one prior attempt at the
real thing: base tx `5fLyxVC5bNu9RptHMbKhgHu8swnhSrxbSFvD4re7NDMs4CEu5qXD4Zr3qWmH9SkqAzhkzBKfvPEtpfv39w89c3q9`
(slot `500720196`), invoked by the delegation program (`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`) as a
genuine post-commit action CPI into `update_leaderboard`, failing with:
```
Program log: Instruction: UpdateLeaderboard
Program log: AnchorError caused by account: escrow. Error Code: Unauthorized. Error Number: 6000. Error Message: Unauthorized.
Program 6Tm2q...ePoxR failed: custom program error: 0x1770
```
i.e. the prior implementer had already reached "commit lands, action fails, leaderboard never updates" and was
mid-investigation (hence the inspect scripts) when they crashed. No successful action call existed anywhere in
the program's or leaderboard's signature history at that point — only one plain `initialize` and one failed
action attempt.

## What was diagnosable and how it was fixed

### Step 1 — redeploy the already-fixed-but-undeployed binary (per brief)

Fixed the `Anchor.toml` devnet program-id mismatch, ran `anchor build` (binary was already up to date with
`lib.rs`, build was a no-op cache hit), then redeployed:
```
anchor deploy --provider.cluster https://rpc.magicblock.app/devnet --provider.wallet ../keys/payer.json
```
First attempt failed — the brief's assumption that "upgrade of an existing program of the same size costs only
tx fees" did not hold in practice: `anchor deploy` allocates a **new temporary buffer account** sized to the
full program (rent-exempt minimum ≈1.71 SOL) before invoking `Upgrade`, rather than writing in place. Payer had
1.688 SOL, buffer creation needed 1.713 SOL:
```
Error: Account allocation failed: RPC response error -32002: Transaction simulation failed:
Error processing Instruction 0: custom program error: 0x1; 3 log messages:
  Program 11111111111111111111111111111111 invoke [1]
  Transfer: insufficient lamports 1688232813, need 1713367160
  Program 11111111111111111111111111111111 failed: custom program error: 0x1
```
Topped up via `solana airdrop 1 <payer> --url https://rpc.magicblock.app/devnet` (the MagicBlock devnet RPC
proxies the real Solana devnet faucet; the standalone `https://api.devnet.solana.com` faucet was rate-limited
at the time). Payer → 2.688242813 SOL. Redeploy then succeeded: sig
`4c6QvVRsjShRG8ozWrn7W85V7YbKk9qMTDwqfQxUCB2YxvE9UUe2tQMnFWtYs2emfyDEjTmpoq6trCi1eHahJMJQ`, deployed slot
`500745834`.

### Re-run 1 — same bug persists after redeploy

Ran `cd spikes && npx tsx 06-magic-action/check.ts`. Commit landed and confirmed on base
(`4LxyrpVZweTZoEXxSaQ6mq9hdP3gN6U47Mp63MuhwwE8XhZdeyTX7utUWj1kbkoDnpe77HYqHVfsPkAJQLW3LiHj`) but
`leaderboard.highScore` stayed 0 after a 60s poll → script `FAIL`ed and exited (`assert()` calls
`process.exit(1)`). So the redeploy alone was **not** the fix — the bug was in the source itself, not staleness.

Inspecting the base commit tx's logs showed only two `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh invoke [1]`
blocks, no CPI into the magic-actions program at all — matching the skill's documented failure mode: *"If any
BaseAction fails, the committor removes all BaseActions in that affected TransactionStrategy and retries its
remaining commit strategy"*. The actual failing action attempt showed up as a separate, later base tx (the
committor retries out-of-band): `5nXfyZJdpR3U1AhMWRMiVvB4RBMCN2w7kF5KrEGrydGHP7LzzSpSGPrbnGVYF8ib2jMpbEqj2skxgcJ6Y8cu4nuN`
(slot `500745948`), same delegation-program-driven CPI into `update_leaderboard`, **same** `Unauthorized` error
on the `escrow` account as the pre-existing failure from before the redeploy:
```
Program DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh invoke [1]
Program 6Tm2qGHSsmYhaCtLmWf7TQ2VBi84s2bzuzrHKGFePoxR invoke [2]
Program log: Instruction: UpdateLeaderboard
Program log: AnchorError caused by account: escrow. Error Code: Unauthorized. Error Number: 6000. Error Message: Unauthorized.
Program 6Tm2q...ePoxR consumed 9940 of 390381 compute units
Program 6Tm2q...ePoxR failed: custom program error: 0x1770
Program DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh failed: custom program error: 0x1770
```

### Root cause — decoded raw account list, confirmed the `source_program` gap

Decoded the failing tx's inner instruction (`getTransaction`, raw/compiled format, not `jsonParsed`) for the
CPI into `6Tm2qGHSsmYhaCtLmWf7TQ2VBi84s2bzuzrHKGFePoxR`:
```
accounts (indices into staticAccountKeys): [1, 8, 12, 9, 3]
  1  = 6RDRRszaPU2JLi8dBgdC2PdngRppiCNSUQLvF8JrZYt4  (leaderboard)
  8  = HyQ2MdAWESoNi36KP3u6gqHiDVXqMYQgh8jCVjsdwLDX  (counter)
  12 = 6Tm2qGHSsmYhaCtLmWf7TQ2VBi84s2bzuzrHKGFePoxR  (the program's own id!)
  9  = JAMfwKsWBpug6UpsjwRc71w7rRbzZgAn7tTisvzFHe3D  (user wallet — the real escrow_auth)
  3  = 7tSuwoRxtbwiccZo93NnDnMKqxSUhSBjtMp2DrKuL5wh  (the real escrow PDA)
```
**5 accounts on-chain**, but the deployed `UpdateLeaderboard` struct declared only 4 (`leaderboard`, `counter`,
`escrow_auth`, `escrow`) — confirmed by reading the `#[action]` proc-macro source
(`~/.cargo/registry/.../ephemeral-rollups-sdk-attribute-action-0.16.2/src/lib.rs`): it only appends
`escrow_auth`/`escrow` when absent, nothing else. So the live delegation program on this devnet cluster inserts
the destination program's own id as an extra account between the declared data accounts (`leaderboard`,
`counter`) and the two escrow accounts when dispatching the action CPI — regardless of whether the target
program's `CallHandler.accounts` vec included it. With only 4 fields declared, Anchor's positional
deserialization shifted everything after `counter` by one: the `escrow_auth` field received the **program id**
(account index 2, not what it expected), and the `escrow` field received what should have been `escrow_auth`
(account index 3, the user's wallet — not a signer, not the derived PDA). The `escrow` signer+address check
then correctly rejected this shifted, garbage input as `Unauthorized` — a real bug, not a security finding: the
genuine post-commit action was being misdecoded and self-rejected.

This is exactly what the brief's Step-1 prompt was pointing at ("check whether `source_program` pinned to
`crate::ID` is also present") and what the stale comment block above `UpdateLeaderboard` had already described
in prose without the code ever catching up.

### Fix

Added the missing `source_program` field to `UpdateLeaderboard`, in the position the on-chain evidence showed
(`leaderboard`, `counter`, `source_program`, `escrow_auth`, `escrow`), pinned `#[account(address = crate::ID @
ErrorCode::Unauthorized)]`:
```rust
/// CHECK: program that scheduled the action; also absorbs the account slot the
/// delegation program inserts for the destination program during CPI dispatch.
#[account(address = crate::ID @ ErrorCode::Unauthorized)]
pub source_program: UncheckedAccount<'info>,
```
Ran `mcp__solana-mcp-server__program_autofixer` on the full `lib.rs` before rebuilding (CLAUDE.md rule):
`{"issues":[],"suggestions":[],"require_another_tool_call_after_fixing":false}` — clean. `anchor build`
succeeded, new IDL confirmed 5 accounts in the right order
(`['leaderboard','counter','source_program','escrow_auth','escrow']`). Redeployed:
```
anchor deploy --provider.cluster https://rpc.magicblock.app/devnet --provider.wallet ../keys/payer.json
```
Sig `4kpKSeCUVDFu2FzeUHp4zn85MyhJ9mhu7N4xZaZgdq8DCDMFgGJ7QJejRw3ppTHSjGm7HgtJhLCgSp3fAU8JRdoM`, deployed slot
`500747537` (this second upgrade did not need another buffer top-up — the buffer from the first upgrade was
already reclaimed and payer had enough headroom).

### Re-run 2 — full PASS

```
cd spikes && npx tsx 06-magic-action/check.ts
```
Full stdout:
```
program: 6Tm2qGHSsmYhaCtLmWf7TQ2VBi84s2bzuzrHKGFePoxR
counterPDA: HyQ2MdAWESoNi36KP3u6gqHiDVXqMYQgh8jCVjsdwLDX
leaderboardPDA: 6RDRRszaPU2JLi8dBgdC2PdngRppiCNSUQLvF8JrZYt4
escrowPda: 7tSuwoRxtbwiccZo93NnDnMKqxSUhSBjtMp2DrKuL5wh
initialize: counter already exists, skipping
delegate: counter already delegated, skipping (escrow top-up also skipped)
ok: router reports delegated
ok: fqdn is TEE endpoint: https://devnet-tee.magicblock.app/
router fqdn: https://devnet-tee.magicblock.app/
increment sig: 4s98pDzFFJeDwrkfkpGQnsnrmjX1FWGp4owmWE6Aop5bWv3pDTYPSJ8QSS4BHeDpFwveeP3EMV6EgnEEWNoxMApF
counter count on ER after increment: 3
leaderboard.highScore on base BEFORE commit+action: 0
ER commit+action sig: 2mfdiacoXjiFEaZrLxwy2xio3f1EfS8wAmGLMDANTG16UAyJDk2496NfF3jgrBEYHV5jGX3KKoqAL9bqZHS78kT6
base commit signature (GetCommitmentSignature): 3vwcYnLKSDtnCd36xVWdTHDd1qdb9zn5jEsjLU4hceW69DhGNDWVV7dzP8cvZJoTfpu6oACXvQ2cJ6JN7iTPAM9b
ok: base commit signature confirmed: 3vwcYnLKSDtnCd36xVWdTHDd1qdb9zn5jEsjLU4hceW69DhGNDWVV7dzP8cvZJoTfpu6oACXvQ2cJ6JN7iTPAM9b
leaderboard.highScore on base AFTER commit+action: 3 seconds from ER tx to L1 effect: 4.702
ok: leaderboard on L1 updated by Magic Action (highScore=3, expected >= 3)
CHECK 7 PASS (Magic Action landed on L1) {
  erSig: '2mfdiacoXjiFEaZrLxwy2xio3f1EfS8wAmGLMDANTG16UAyJDk2496NfF3jgrBEYHV5jGX3KKoqAL9bqZHS78kT6',
  baseSig: '3vwcYnLKSDtnCd36xVWdTHDd1qdb9zn5jEsjLU4hceW69DhGNDWVV7dzP8cvZJoTfpu6oACXvQ2cJ6JN7iTPAM9b',
  highScore: 3,
  secondsToEffect: 4.702
}
direct call raw error: Signature verification failed.
Missing signature for public key [`7tSuwoRxtbwiccZo93NnDnMKqxSUhSBjtMp2DrKuL5wh`].
ok: direct call to #[action] handler rejected: Signature verification failed.
Missing signature for public key [`7tSuwoRxtbwiccZo93NnDnMKqxSUhSBjtMp2DrKuL5wh`].
CHECK 7 FULL PASS {
  erSig: '2mfdiacoXjiFEaZrLxwy2xio3f1EfS8wAmGLMDANTG16UAyJDk2496NfF3jgrBEYHV5jGX3KKoqAL9bqZHS78kT6',
  baseSig: '3vwcYnLKSDtnCd36xVWdTHDd1qdb9zn5jEsjLU4hceW69DhGNDWVV7dzP8cvZJoTfpu6oACXvQ2cJ6JN7iTPAM9b',
  highScore: 3,
  secondsToEffect: 4.702,
  directErr: 'Signature verification failed.\n' +
    'Missing signature for public key [`7tSuwoRxtbwiccZo93NnDnMKqxSUhSBjtMp2DrKuL5wh`].'
}
```
Independently confirmed on base: `solana program show` at deployed slot `500747537`; leaderboard account raw
bytes (`getAccountInfo`, u64 LE at offset 8) = `3`, matching the ER counter's post-increment count.

## Direct-call rejection — analysis

The direct-call test (`program.methods.updateLeaderboard().accountsPartial({ leaderboard, counter,
sourceProgram: program.programId, escrowAuth: user.publicKey, escrow: escrowPda }).rpc()`, signed only by
`user`) never reached the chain: `@coral-xyz/anchor`'s local transaction builder saw the IDL mark `escrow` as
`signer: true` and refused to construct a valid transaction because `user`'s keypair cannot produce a signature
for `escrow` (`7tSuwoRxtbwiccZo93NnDnMKqxSUhSBjtMp2DrKuL5wh`) — it isn't `user`'s key, it's a PDA nobody but the
delegation program can sign for. This is the strongest form of rejection available: it is not a runtime program
check that could theoretically be bypassed by a cleverer client, it is a hard cryptographic impossibility (no
private key exists for `escrow`) enforced before the transaction is even sent — matches the brief's expected
outcome ("expect error containing... signature verification failure").

## Deviations from the brief

1. **`Anchor.toml` `[programs.devnet]` program id** — was `FNG2W4yLLuT3ZsuHC94oDFKBxyyPtW6GHkPz1i669VPZ`,
   didn't match `declare_id!` (`6Tm2qGHSsmYhaCtLmWf7TQ2VBi84s2bzuzrHKGFePoxR`); fixed to match before deploying.
2. **Deploy cost was not "only tx fees" for the first (Anchor.toml-fix) redeploy** — `anchor deploy` allocates a
   fresh rent-exempt buffer account (≈1.71 SOL) before the in-place upgrade, not a delta write; needed a 1 SOL
   devnet airdrop via the MagicBlock RPC (`https://api.devnet.solana.com` was rate-limited). The *second*
   redeploy (the actual `source_program` fix) did not need a further top-up.
3. **Program change beyond "already has the escrow check"** — added the `source_program` field the brief asked
   to check for; it was missing and was the actual cause of the action failing even with a correctly-checked
   `escrow` account. One redeploy of this change, as allowed by the brief ("a program change requires one
   redeploy — allowed once"); in total there were two redeploys in this session (one to push the prior
   implementer's already-built-but-undeployed binary, which did not fix anything on its own, and one for this
   `source_program` fix, which did).
4. **`inspect_sigs.mjs` / `inspect_basesig.mjs` deleted** — used them to reconstruct prior state and to decode
   the two failing base txs (raw signatures and logs are quoted above in full); not needed going forward and
   not part of the brief's committed file set.
5. Everything else in `check.ts` (already written by the prior implementer) matched the brief's illustrative
   script's intent; no further script changes were needed.

## Build / deploy summary

- Toolchain: `anchor-cli 1.0.2`, `solana-cli 3.1.10` (matches `Anchor.toml`'s `anchor_version = "1.0.2"` and
  `programs/magic-actions/Cargo.toml`'s `anchor-lang = "1.0.2"`, `ephemeral-rollups-sdk = "0.16.2"`).
- Payer balance: 1.688242813 SOL (start of session) → airdropped +1 SOL → 2.688242813 SOL → **2.683973857 SOL**
  (final, after both redeploys and all check.ts transactions).
- `mcp__solana-mcp-server__program_autofixer` run on the fixed `lib.rs` before the second `anchor build`: no
  issues, `require_another_tool_call_after_fixing: false`.
