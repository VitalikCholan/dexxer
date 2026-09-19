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
