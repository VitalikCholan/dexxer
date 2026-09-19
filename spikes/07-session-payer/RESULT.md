# Check 9 — session key as ER fee payer after one-time top-up

**Status: PASS**

Tests payer *mechanics* only: can a fresh on-curve keypair (`session`), topped
up solely via `@magicblock-labs/gum-sdk`'s `createSessionV2` instruction on
base, act as the fee payer and sole signer of an ER transaction on the TEE
endpoint. Session-token validation inside the program (`private-counter`'s
`increment` only takes `counter` as an account — it never inspects a session
token) is explicitly out of scope, per the task brief.

Fix round 1 added direct proof of session non-membership (a read-gating
check) and direct proof of state mutation (before/after counter reads via
the member's own token), replacing the earlier "asserted, not demonstrated"
version.

## Result summary

| Field | Value |
|---|---|
| Session pubkey | `8Fn3roFL9f9i4h3rCQa1yMohT4NiAN8pdu9oxjk4wQhQ` |
| `createSessionV2` sig (base, first run) | `5shLe1EXHNvQ1DmNPvvGMLdnZ1pDjKct8ST4anJha5DLQUEhQmDKYG3ugCy5hgA1Chp2juFW5VByeUcq7Gi3SMSm` |
| Session token PDA | `Awi9mcFuTFy2y6hgPhVij4fVbvtT8HYkqsrB4Uzxo859` (reused on this re-run; guarded, see below) |
| Session balance before top-up (very first run) | `0` lamports |
| Session balance held from top-up (this run) | `5,000,000` lamports (0.005 SOL, exactly the `lamports` arg) |
| ER `increment` sig | `4qja4Y9miUxehE72up7Ak9rUtipEVwa59xQfzcBpcSdkMXg23a9Z744A3zy9FEGDszdj3oLbewQhKu8PNmiB74XV` |
| ER tx fee charged (`meta.fee`) | `0` |
| ER tx `meta.err` | `null` |
| Variant that ran | **session-token** — session key obtained its *own* TEE auth token |
| Signers on the ER tx | `session` only (fee payer + sole signer) |
| Did session key get its own TEE token (auth)? | **Yes** |
| Can session key **read** the private counter with that token? | **No** — `getAccountInfo` returned `null` (see Membership proof below) |
| Counter count before ER tx (via user-token read) | `4` |
| Counter count after ER tx (via user-token read) | `5` |

## Membership proof (fix round 1)

The earlier version of this check only asserted non-membership from
inference (Task 1's analogous `stranger` behavior); it never directly probed
whether `session`'s own TEE token could read the private counter. This run
adds that direct probe, plus a direct before/after read of the counter's
actual value via a connection using the **user**'s token (user is the
confirmed permission member), to prove the session-paid tx really mutated
state rather than silently no-opping.

**(a) Read attempt using the SESSION's own TEE token, before the ER tx:**
```
session-token read of counterPDA (raw): null
MEMBERSHIP PROOF: session key CANNOT read the private counter with its own token (null/error) — reads are gated, session is not an effective member.
```
This is the direct evidence: `getAccountInfo` under the session's own
auth token returns `null` for the private counter PDA — the same filtered
response Task 1's `check.ts` observed for `stranger`. This **confirms**
non-membership at the read layer, even though `getAuthToken` itself
succeeded for the session key (auth-token issuance is signature-only and
does not gate on permission membership — see "Key finding" below).

**(b) The subsequent ER `increment`, submitted via that same session-token
connection with `session` as fee payer and sole signer, still succeeded**
(`meta.err: null`, `fee: 0`, sig
`4qja4Y9miUxehE72up7Ak9rUtipEVwa59xQfzcBpcSdkMXg23a9Z744A3zy9FEGDszdj3oLbewQhKu8PNmiB74XV`).
This demonstrates that the ER's transaction-submission/execution path for
this program does not itself check permission membership — only account
*reads* are filtered by the permission list; the write path is gated (if at
all) purely by whatever the program instruction itself checks, and
`private-counter::increment` checks nothing.

**(c) Counter value read via the USER's token (user is a member, unfiltered)
before and after the ER tx:**
```
counter count BEFORE (via user-token read): 4
ok: user (permission member) can read the counter and decode its count before the ER tx
...
counter count AFTER (via user-token read): 5
ok: counter mutated by the session-paid ER tx: before=4 after=5 expected=5
```
`after === before + 1`, proving the session-paid transaction actually
mutated on-chain state (not a silent no-op or an unconfirmed/rolled-back
tx). (`private-counter::increment` resets the counter to `0` once it would
exceed `1000`; `check.ts` computes `expectedAfter` accounting for that
wraparound, though it wasn't hit on this run.)

## Key finding: auth-token issuance vs. read gating are different checks

`getAuthToken` issues a JWT to any keypair that can produce a valid
signature over the auth challenge — it does **not** check permission
membership at token-issuance time. This matches Task 1's `check.ts`
(`stranger` also got a token there). What *is* gated by permission
membership is **reading** a private account (`getAccountInfo` on the
counter PDA returns `null` for non-members, as directly demonstrated above
for `session`, and previously for `stranger`).

Separately, and demonstrated fresh by this check: the ER's **transaction
submission/execution** path is *not* gated by permission membership either
— it ran `increment` successfully with `session` (a non-member, confirmed
non-member by the read probe above) as the sole signer and fee payer,
because `private-counter::increment` itself performs no session-token or
membership check. Whether a production instruction that *does* check the
session token/permission would reject `session` is not something this
program can test — this spike is scoped to payer mechanics only, per the
task brief.

So there are three independent layers, and this run distinguishes them
cleanly:
1. **Auth-token issuance** (`getAuthToken`) — signature-only, not
   membership-gated. Session: succeeded.
2. **Account reads** (`getAccountInfo` on a private account) — membership-gated.
   Session: denied (`null`).
3. **Transaction submission/execution** — gated only by what the target
   program's instruction itself checks. `private-counter::increment` checks
   nothing, so it's effectively ungated here; session succeeded as sole
   signer/payer.

The fallback variant (`user-token`: TEE token obtained via `user`, `session`
still fee payer/signer of the ER tx) is implemented in `check.ts` and would
engage automatically if a future run's `getAuthToken(session)` call fails —
it was not exercised on this run since `sessionGotOwnToken` was `true` both
times.

## Re-run safety note

`createSessionV2`'s `session_token` PDA is derived from a fixed keyset
(`target_program`, `session_signer`, `authority`) — a second `createSessionV2`
call for the same `session`/`user` pair on a later run fails on-chain
(`Allocate: account ... already in use`, observed directly on this fix
round's first re-run attempt before the guard was added — see the fix
report). `check.ts` now checks for the existing `session_token` PDA first
and skips `createSessionV2` if it's already there (mirroring the guard
pattern in `spikes/01-private-counter-tee/check.ts` for
`init_permission`/`set_privacy`), reusing the already-topped-up session key.

## SDK signature deviations from the brief

- **`SessionTokenManager` constructor**: the brief calls
  `new SessionTokenManager(baseProvider.wallet as anchor.Wallet, baseConn, "devnet")`
  (3 args, including a `Cluster` string). The installed
  `@magicblock-labs/gum-sdk@3.0.10`'s actual constructor is
  `constructor(wallet: Wallet, connection: anchor.web3.Connection)` — **2
  args only**, no cluster parameter. `check.ts` drops the third argument.
  (`spikes/node_modules/@magicblock-labs/gum-sdk/lib/sessionTokenManager.d.ts`)
- **`createSessionV2` accounts/args**: matched the brief exactly. IDL
  (`spikes/node_modules/@magicblock-labs/gum-sdk/lib/idl/gpl_session.json`,
  instruction `create_session_v2`) accounts are `session_token` (PDA,
  auto-resolved), `session_signer` (signer), `fee_payer` (signer),
  `authority` (signer), `target_program`, `system_program` (auto-resolved by
  address). Args: `top_up: Option<bool>`, `valid_until: Option<i64>`,
  `lamports: Option<u64>` — camelCased by Anchor's TS client to
  `createSessionV2(topUp, validUntil, lamports)` positionally, matching the
  brief's `stm.program.methods.createSessionV2(true, new BN(expiry), new BN(0.005 * LAMPORTS_PER_SOL))`.
  `feePayer` and `authority` were both set to `user.publicKey` (same signer,
  Anchor only requires one signature for both since they're the same key);
  `sessionSigner` was `session.publicKey`. `session` and the `AnchorProvider`
  wallet (`user`) both signed the transaction (`sendAndConfirm(tx, [session])`
  — `user` signs automatically as the provider wallet).
- **`getAuthToken`** (`@magicblock-labs/ephemeral-rollups-sdk@0.17.0`): used
  exactly as in the brief and as Task 3's `check.ts` — signature matches
  installed typings (`rpcUrl, publicKey, signMessage, template?`).

## Full stdout (fix-round-1 re-run)

```
program: 2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7
counterPDA: GUrqtjuVRoRYxfeDWpwTNn5xb9vSSBWTZ7KpMfMUdzuJ
user pubkey: JAMfwKsWBpug6UpsjwRc71w7rRbzZgAn7tTisvzFHe3D
session pubkey: 8Fn3roFL9f9i4h3rCQa1yMohT4NiAN8pdu9oxjk4wQhQ
session balance before: 5000000
session token already exists — skipping createSessionV2, reusing Awi9mcFuTFy2y6hgPhVij4fVbvtT8HYkqsrB4Uzxo859
session balance after top-up: 5000000
ok: session key holds lamports from the createSessionV2 top-up (no separate base airdrop)
session key obtained its own TEE token: eyJ0eXAiOiJKV1QiLCJhbGci...
session-token read of counterPDA (raw): null
MEMBERSHIP PROOF: session key CANNOT read the private counter with its own token (null/error) — reads are gated, session is not an effective member.
counter count BEFORE (via user-token read): 4
ok: user (permission member) can read the counter and decode its count before the ER tx
variant: session-token (submitting via session's TEE token)
er tx paid by session (session-only signer): 4qja4Y9miUxehE72up7Ak9rUtipEVwa59xQfzcBpcSdkMXg23a9Z744A3zy9FEGDszdj3oLbewQhKu8PNmiB74XV
ok: ER tx with session key as payer succeeded
fee charged: 0
session balance after ER tx: 5000000 (base layer; ER fee is charged on the ER, not necessarily mirrored to base)
counter count AFTER (via user-token read): 5
ok: counter mutated by the session-paid ER tx: before=4 after=5 expected=5
summary: {
  variant: 'session-token',
  sessionGotOwnToken: true,
  sessionCanReadPrivateCounter: false,
  secondSignerNeeded: false,
  baseSig: '',
  erSig: '4qja4Y9miUxehE72up7Ak9rUtipEVwa59xQfzcBpcSdkMXg23a9Z744A3zy9FEGDszdj3oLbewQhKu8PNmiB74XV',
  fee: 0,
  counterBefore: '4',
  counterAfter: '5'
}
CHECK 9 PASS
```
(`baseSig` is empty in this run's summary because the session token PDA
already existed from the first pre-fix run and `createSessionV2` was
skipped by the new guard; the original `createSessionV2` sig from that first
run is recorded in the Result summary table above.)

## Conclusion for spec §5.4

- The ER **does** accept a fresh on-curve keypair as fee payer and sole
  signer of an ER transaction, once it holds lamports from a one-time
  `createSessionV2` top-up on base — no separate airdrop/funding needed.
  Fee charged was `0`.
- Auth-token issuance (`getAuthToken`) is signature-only and does **not**
  gate on permission membership — confirmed both for `session` here and for
  `stranger` in Task 1.
- Permission membership **does** gate account **reads** — directly
  confirmed here: `session`'s own token could not read the private counter
  (`null`).
- Permission membership does **not** gate **transaction submission/execution**
  by itself — that depends entirely on what the target program's
  instruction checks. `private-counter::increment` checks nothing, so a
  confirmed non-member (`session`) could still submit and successfully
  execute it, mutating state (proven: count went `4` → `5`).
- **Implication for spec §5.4**: if writes need to be restricted to
  permission members, that restriction must be enforced **inside the
  program logic** (checking the session token account or permission
  membership explicitly). It cannot be assumed from TEE auth-token
  issuance, and — per this check — it is also not enforced by the ER's
  generic transaction-submission path.
