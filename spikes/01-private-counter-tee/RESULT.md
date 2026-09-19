# Check 1 — private-counter on devnet-tee
Status: PASS
Program: 2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7  Counter PDA: GUrqtjuVRoRYxfeDWpwTNn5xb9vSSBWTZ7KpMfMUdzuJ  Delegate sig: 43EgR5v185rby9hR8m28Pcjahig25G2fZbRkemSydUePtvsdgRHNd5SNjfiazBiaRKZCpcweKPyhhauLtMTQMsb4
Router fqdn: https://devnet-tee.magicblock.app/
Owner read: 48 bytes; Base owner: DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh; Stranger read: null; No-token read: null
Decision: spec §2.1 permission model confirmed

## Raw responses (steps 6 and 7)

Stranger wallet (own valid TEE auth token, not a member of the counter's `EphemeralPermission`):
- `getAccountInfo` via `@solana/web3.js` `Connection`: returned `null`, no exception thrown.
- Raw JSON-RPC over HTTP (`POST https://devnet-tee.magicblock.app?token=<stranger_token>`, `getAccountInfo` on the counter PDA): HTTP 200,
  `{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":317220324},"value":null}}`

No token at all:
- `getAccountInfo` via `@solana/web3.js` `Connection` (no `?token=`): returned `null`, no exception thrown.
- Raw JSON-RPC over HTTP (`POST https://devnet-tee.magicblock.app`, no token, `getAccountInfo` on the counter PDA): HTTP 200,
  `{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":317220330},"value":null}}`

**Finding**: the TEE RPC does not distinguish "account exists but you're not a permission member" from "account
does not exist" — both return a normal JSON-RPC 200 with `result.value: null`, same shape as a plain
`getAccountInfo` miss. No HTTP 401/403 and no JSON-RPC `error` object. Non-member reads (with or without a
valid auth token) are indistinguishable from the account not existing at all. Later tasks that build on this
(e.g. any client-side "does this account exist" check) must treat `null` as ambiguous between those two cases
when the account might be privacy-gated.

## check.ts stdout

```
program: 2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7
counterPDA: GUrqtjuVRoRYxfeDWpwTNn5xb9vSSBWTZ7KpMfMUdzuJ
initialize sig: 2bHT6GLuvhnsoHxmSkn4fUm7KfP4oYGhrrUgDmeJ3hH7evLdcBDkyp5DoPRTzc96P8EzwV4B9NToZ24YwSL7KTmM
delegate sig: 43EgR5v185rby9hR8m28Pcjahig25G2fZbRkemSydUePtvsdgRHNd5SNjfiazBiaRKZCpcweKPyhhauLtMTQMsb4
ok: router reports delegated
ok: fqdn is TEE endpoint: https://devnet-tee.magicblock.app/
router fqdn: https://devnet-tee.magicblock.app/
initPermission sig: Ro3HC2gSfTC3oKunrBrijQJ8j9m5236JXyvbpPXcQVvEhA4NpM3xzQ3CQqR8xrRbU5RXWKrqMbYkTaAYjdQPN46
setPrivacy(true) sig: aNbAPKdYdgEpVgy4uVspDch232b6Y1cXMzcco4Zh3DnjxFLqQRXwVeTjWHgjc4Yw2wP1YxWWNRR4Amps2ZDAXZh
increment sig: 3AGUL9ajNUUcLDKrtXmj9wLCusJzs16SWTVmsE3SvhyaSCMVA6ukkL4ctvnAirjD2EMq5BNrxQPsmqTFpkDK9xYa
ok: owner reads counter on TEE, owner = program
owner view bytes: 48
ok: base: owner is Delegation Program
base view owner: DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh
stranger view: null err:
ok: stranger (own token) cannot read private counter
no-token view: null err:
ok: no token cannot read private counter
CHECK 1 PASS { program: '2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7', counterPDA: 'GUrqtjuVRoRYxfeDWpwTNn5xb9vSSBWTZ7KpMfMUdzuJ' }
```

No transaction hit a preflight simulation failure — every `sendRpc` call in `check.ts` succeeded on the first
try, so the `skipPreflight: true` fallback path was never exercised. Preflight stayed on for all 5 transactions
(base `initialize`, base `delegate`, ER `initPermission`, ER `setPrivacy`, ER `increment`).

## Build / deploy

- Toolchain: `anchor-cli 1.0.2`, `solana-cli 3.1.10`, `rustc 1.89.0` (matches `Anchor.toml`'s
  `anchor_version = "1.0.2"` and the program's `anchor-lang = "1.0.2"`, `ephemeral-rollups-sdk = "0.16.2"`
  with `features = ["anchor", "access-control"]`).
- `anchor keys sync` regenerated the program keypair and rewrote `declare_id!` to
  `2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7`.
- `anchor build` completed with no errors (`target/deploy/private_counter.so`, `target/idl/private_counter.json`
  both produced; a second `anchor build` run confirmed a clean, fully cached "Finished" build with no warnings
  or errors).
- `anchor deploy --provider.cluster https://rpc.magicblock.app/devnet --provider.wallet ../keys/payer.json`
  succeeded: program id `2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7`, IDL metadata account
  `9QLhynHxWEb9LdgTEzZUdYUQidjGNAcDu1f8PE9tD8dL`.
- Payer balance: 4 SOL before deploy → 2.234823718 SOL after (≈1.765 SOL spent).

## Deviations from the brief's illustrative check.ts

1. **`EPHEMERAL_VAULT_ID_FROM_SDK` placeholder** → replaced with the SDK's own exported constant
   `EPHEMERAL_VAULT_ID` from `@magicblock-labs/ephemeral-rollups-sdk` (`lib/constants.ts`), value
   `MagicVau1t999999999999999999999999999999999`. This matches both the Rust program's
   `ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID` import in `lib.rs` and the hardcoded `VAULT_ID` constant
   in the example's `tests/private-counter.ts` — no need to hardcode the string as the test does, the installed
   TS SDK (`@magicblock-labs/ephemeral-rollups-sdk@0.17.0` per `spikes/package.json`) exports it directly.
2. **`delegate` accounts** — the IDL's `DelegateCounterPrivately` context has 9 accounts (`authority`, `buffer_counter`,
   `delegation_record_counter`, `delegation_metadata_counter`, `counter`, `validator` (optional),
   `owner_program`, `delegation_program`, `system_program`). Only `authority`, `counter`, and `validator` are
   passed explicitly (matching the example's `tests/private-counter.ts`); the rest resolve automatically from
   the IDL's declared seeds/addresses. Used `.accountsPartial(...)` (not `.accounts(...)`) for `delegate`,
   `initPermission`, and `setPrivacy`, matching the working example test — `.accounts()` would require every
   account including the auto-resolvable ones.
3. **`initialize`/`delegate`/`increment` idempotency guards** — added skip-with-log branches (matching the
   example test's own idempotency checks) so the script is safe to re-run against an already-initialized/
   delegated counter without erroring.
4. **`sendRpc` retry wrapper** — added a small helper around every `.rpc()` call that keeps preflight on by
   default and retries once with `skipPreflight: true` (logging the simulation error and, on retry, the
   execution logs) only if the first attempt actually fails simulation, per the brief's instruction to keep
   preflight on unless a known ER simulation incompatibility is hit. In this run every call succeeded on the
   first attempt, so no retry path executed — see "check.ts stdout" above.
5. **`spikes/01-private-counter-tee/package.json`** — added `"type": "module"` (the file came from the cloned
   example without a `type` field, i.e. CommonJS by default; because Node resolves `"type"` from the nearest
   `package.json`, this shadowed `spikes/package.json`'s `"type": "module"` for files inside this directory and
   broke both top-level `await` and the `with { type: "json" }` IDL import). This is the one edit made to a
   copied example file outside of `check.ts`/`RESULT.md`.
6. Added `console.log` lines beyond the brief's script (program id, counter PDA, router fqdn, owner view byte
   length, base view owner) to make the stdout self-documenting for this RESULT.md.

# Check 6 — non-member transaction visibility on TEE RPC
Status: **FAIL**
Program: `2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7`  Counter PDA: `GUrqtjuVRoRYxfeDWpwTNn5xb9vSSBWTZ7KpMfMUdzuJ`

## Path taken

Owner's `getSignaturesForAddress` on the counter PDA returned `{"result":[]}` — the ER does not index
signatures by the PDA address (or deliberately returns nothing for a privacy-gated account even to its owner
via this method; `check.ts`'s own `increment` calls used `.rpc()`/`sendRpc()`, not `getSignaturesForAddress`,
so this was not previously exercised). Fell back per the brief: used the `increment` signature from Task 3's
report, `3AGUL9ajNUUcLDKrtXmj9wLCusJzs16SWTVmsE3SvhyaSCMVA6ukkL4ctvnAirjD2EMq5BNrxQPsmqTFpkDK9xYa`, passed as
`argv[3]`. Ran:
```
cd spikes && npx tsx 01-private-counter-tee/check-tx-visibility.ts 2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7 3AGUL9ajNUUcLDKrtXmj9wLCusJzs16SWTVmsE3SvhyaSCMVA6ukkL4ctvnAirjD2EMq5BNrxQPsmqTFpkDK9xYa
```
The brief's illustrative script uses a hard `assert()` that `process.exit(1)`s on the first failed check,
which would have cut the run short before the no-token case and the program-id probe were exercised. Since
the task requires recording *all* of stranger + no-token + the extra program-id probe in one run regardless of
outcome, the script's per-case checks were changed to a soft, non-exiting `soft()` helper that still prints
`ok:`/`FAIL:` per case; overall `CHECK 6 PASS`/`FAIL` is decided after every probe has run, from whether any
case leaked.

## Results — raw JSON (first ~300 chars unless noted)

**`getSignaturesForAddress` on the counter PDA — owner (own valid token):**
```
{"jsonrpc":"2.0","id":1,"result":[]}
```
Empty for the owner too — not evidence of hiding (see "Path taken"), just means this RPC method doesn't serve
the PDA's own history; forced the fallback-signature path.

**`getSignaturesForAddress` on the counter PDA — stranger (own valid token):**
```
{"jsonrpc":"2.0","id":1,"result":[]}
```
`ok: stranger: getSignaturesForAddress hidden` — empty array, no error. Correctly hidden (though as above,
this alone doesn't prove privacy-gating, since even the owner gets `[]` here).

**`getTransaction` on the known `increment` signature — stranger (own valid token):** (full JSON, not truncated —
this is the load-bearing leak)
```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "slot": 317219812,
    "transaction": {
      "signatures": ["3AGUL9ajNUUcLDKrtXmj9wLCusJzs16SWTVmsE3SvhyaSCMVA6ukkL4ctvnAirjD2EMq5BNrxQPsmqTFpkDK9xYa"],
      "message": {
        "header": {"numRequiredSignatures": 0, "numReadonlySignedAccounts": 0, "numReadonlyUnsignedAccounts": 0},
        "accountKeys": [], "recentBlockhash": "11111111111111111111111111111111", "instructions": []
      }
    },
    "meta": {
      "err": null, "status": {"Ok": null}, "fee": 0,
      "preBalances": [], "postBalances": [], "innerInstructions": [], "logMessages": [],
      "preTokenBalances": [], "postTokenBalances": [], "rewards": [],
      "loadedAddresses": {"writable": [], "readonly": []}, "returnData": null,
      "computeUnitsConsumed": 0, "costUnits": 0
    },
    "blockTime": 1789794373
  }
}
```
`FAIL: stranger: getTransaction hidden` — `tx.result` is **not** `null`; HTTP 200, no `error` object.

**`getTransaction` on the known `increment` signature — no token at all:** (full JSON, not truncated —
byte-identical to the stranger response above, re-verified by a fresh direct `curl` against the unauthenticated
endpoint)
```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "slot": 317219812,
    "transaction": {
      "signatures": ["3AGUL9ajNUUcLDKrtXmj9wLCusJzs16SWTVmsE3SvhyaSCMVA6ukkL4ctvnAirjD2EMq5BNrxQPsmqTFpkDK9xYa"],
      "message": {
        "header": {"numRequiredSignatures": 0, "numReadonlySignedAccounts": 0, "numReadonlyUnsignedAccounts": 0},
        "accountKeys": [], "recentBlockhash": "11111111111111111111111111111111", "instructions": []
      }
    },
    "meta": {
      "err": null, "status": {"Ok": null}, "fee": 0,
      "preBalances": [], "postBalances": [], "innerInstructions": [], "logMessages": [],
      "preTokenBalances": [], "postTokenBalances": [], "rewards": [],
      "loadedAddresses": {"writable": [], "readonly": []}, "returnData": null,
      "computeUnitsConsumed": 0, "costUnits": 0
    },
    "blockTime": 1789794373
  }
}
```
`FAIL: no-token: getTransaction hidden` — `tx.result` is **not** `null`; HTTP 200, no `error` object.

**`getSignaturesForAddress` on the counter PDA — no token:**
```
{"jsonrpc":"2.0","id":1,"result":[]}
```
`ok: no-token: getSignaturesForAddress hidden`.

## Extra probe — `getSignaturesForAddress` on the PROGRAM ID (stranger, own token)

Not an assertion, per the brief — recorded as data. Full JSON (first page, `limit: 5`):
```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": [
    {"signature": "3yud9yL2c3mU12rzWvAf2vB2oJMNrJFJmNhmzXzN9yJwnBWUgQiQNa6qDPz19TxnyjKCdsnjZonM1hzXGSNSrVm6", "slot": 317221866, "err": {"InstructionError": [0, "InvalidAccountData"]}, "memo": null, "blockTime": 1789794476, "confirmationStatus": "finalized", "transactionIndex": 0},
    {"signature": "4Ct1ez3yvNhpyi4AREctP8JvRmW3Lgm2AMunCKb88bbVng6AcXhZ8cmUYZEmqGVqNrvc53iSDzm2azUaTiVkoZqF", "slot": 317221854, "err": {"InstructionError": [0, "InvalidAccountData"]}, "memo": null, "blockTime": 1789794475, "confirmationStatus": "finalized", "transactionIndex": 0},
    {"signature": "3AGUL9ajNUUcLDKrtXmj9wLCusJzs16SWTVmsE3SvhyaSCMVA6ukkL4ctvnAirjD2EMq5BNrxQPsmqTFpkDK9xYa", "slot": 317219812, "err": null, "memo": null, "blockTime": 1789794373, "confirmationStatus": "finalized", "transactionIndex": 0},
    {"signature": "aNbAPKdYdgEpVgy4uVspDch232b6Y1cXMzcco4Zh3DnjxFLqQRXwVeTjWHgjc4Yw2wP1YxWWNRR4Amps2ZDAXZh", "slot": 317219772, "err": null, "memo": null, "blockTime": 1789794371, "confirmationStatus": "finalized", "transactionIndex": 0},
    {"signature": "Ro3HC2gSfTC3oKunrBrijQJ8j9m5236JXyvbpPXcQVvEhA4NpM3xzQ3CQqR8xrRbU5RXWKrqMbYkTaAYjdQPN46", "slot": 317219733, "err": null, "memo": null, "blockTime": 1789794369, "confirmationStatus": "finalized", "transactionIndex": 0}
  ]
}
```
The last three rows are exactly the `setPrivacy(true)`, `increment`, and `initPermission` signatures from
Task 3's documented run against the same private, delegated counter — a stranger who never learned any
signature can enumerate them all by querying the *program id* instead of the PDA. (The first two rows,
`InvalidAccountData` errors at a later slot, match Task 3 report §8's noted post-hoc reproducibility failure
on a second `initPermission` invocation — unrelated to this check, left as-is for an accurate record.)

## Leak model — exactly what a non-member sees

- **Fully hidden, both stranger and no-token:** `getSignaturesForAddress` keyed on the counter **PDA**
  returns `{"result":[]}` — no signatures, no error. (Caveat: the owner gets the same empty result via this
  method, so this method doesn't distinguish "hidden" from "not indexed"; see Task 3's Check 1 finding that
  `getAccountInfo` is the reliable owner/non-owner signal, not this method.)
- **Partially leaked, both stranger and no-token, given a signature already in hand:** `getTransaction`
  returns HTTP 200 with a **non-null** `result` — not an error, not `null`. Confirmed present: `slot`,
  `blockTime`, `meta.err`/`meta.status` (success/failure), `meta.fee` (0), `meta.computeUnitsConsumed`/
  `costUnits` (0), and the signature itself (already known to the caller). Redacted/empty: `accountKeys`
  (`[]`), `instructions` (`[]`), `logMessages` (`[]`), `preBalances`/`postBalances` (`[]`),
  `preTokenBalances`/`postTokenBalances` (`[]`), `recentBlockhash` (zeroed out to `1111...1111`). So: **no
  account keys and no logs leak**, but **existence, timing (slot/blockTime), and success/failure of a
  specific already-known signature leak** to anyone, member or not.
- **Fully leaked, stranger, program id instead of PDA (no signature needed in advance):**
  `getSignaturesForAddress` on the **program id** returns the program's complete recent signature list —
  including, in this single-user devnet test, every signature belonging to the private counter's
  `initPermission`/`setPrivacy`/`increment` transactions — with `slot`, `err`, `blockTime`,
  `confirmationStatus`, `transactionIndex` for each. This is the more serious leak: a non-member does not
  need to already hold a signature; they can discover the full list and its timing just by querying the
  known, public program id. Combined with the `getTransaction` leak above, an observer who can correlate
  program activity with real-world timing (e.g. only one or few active users on a given program) could infer
  when a private user interacted with their position, and whether that action succeeded, without ever seeing
  account keys or instruction data.

## Decision

**FAIL.** Signature enumeration by PDA is empty for everyone including the owner (inconclusive as a privacy
signal on its own), but transaction *metadata* (slot/blockTime/success/fee/compute) is not access-gated once a
signature is known, and the *program id*'s signature list is fully open to any caller — leaking the existence,
count, and timing of a private account's transactions, though not their account keys, instructions, or logs.
Spec risk #4 (transaction-level privacy leak) is **activated**: the commit-then-reveal / privacy design must
not assume that hiding `getAccountInfo` on the PDA (Check 1, PASS) also hides the *fact and timing* of
activity — it does not. A client or indexer building a "does this account exist / was it touched" oracle from
program-id signature scans, or from a known signature's `getTransaction`, can already do so today against this
TEE RPC.
