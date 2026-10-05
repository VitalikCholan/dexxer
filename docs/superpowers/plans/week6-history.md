# Dexxer — week 6: condensed history of plans and results

One document in place of the eight week-6 plan and results files (27.09–04.10.2026). Each plan is reduced to its goal and a line per task; measurements, verdicts, rulings, findings, addresses, signatures and open items are kept. Step-by-step instructions, code listings and checklists are removed.

The full originals (in Ukrainian) are in git history, last present in commit `7243d39`, e.g. `git show 7243d39:docs/superpowers/plans/week6-results.md`. Each section's "Source:" line names the original file. Labels that other documents cite (`Task N`, `M-slots-A…F`, `M-G′`, `C1–C3`, `#38`, `#39`, `fix round N`, "Chart C.5", "App smoke", "Cost of devnet", "Open after plan 4") are kept verbatim.

This is history: current rules are in `CLAUDE.md` and the spec (§2.7–§2.10). The live to-do list for week 6 is `week6-backlog.md`. Weeks 0–5 are in `weeks0-5-history.md`.

| Section | Date | Replaces |
|---|---|---|
| [Relayer SIWS sessions](#siws-sessions) | 27.09 | `2026-09-27-week6-siws-relayer-sessions.md` |
| [Multi-market in the program](#multi-market) | 28.09 | `2026-09-28-week6-multi-market-program.md` |
| [Position slots, plan 1: program](#slots-program) | 30.09 | `2026-09-30-week6-slots-program.md` |
| [Position slots, plan 2: relayer, admin TS, IDL](#slots-relayer) | 01.10 | `2026-09-30-week6-slots-relayer.md` |
| [Position slots, plan 3: app](#slots-app) | 01.10 | `2026-10-01-week6-slots-app.md` |
| [Position slots, plan 4: devnet deploy and measurements](#slots-deploy) | 01.10 | `2026-10-01-week6-slots-deploy.md`, `week6-results.md` (plan 4) |
| [Chart: 16 timeframes, candles, backfill](#chart-timeframes) | 02.10 | `2026-10-01-week6-chart-timeframes.md`, `week6-results.md` (Chart C.5, App smoke) |
| [Conditional orders: review of PR #13 → #14](#orders-review) | 04.10 | `week6-results.md` |
| [Token information: review of PR #15](#token-info) | 04.10 | `week6-results.md` |
| [Devnet deploy and smoke](#devnet-04-10) | 04.10 | `week6-results.md` |
| [Process lessons](#lessons) | — | `week6-results.md` |

---

<a id="siws-sessions"></a>
## Relayer SIWS sessions (27.09.2026)

Source: `2026-09-27-week6-siws-relayer-sessions.md` (outcomes from `2026-09-18-dexxer-mvp-design.md` §2.7 "Implemented").

### Goal

The relayer's `/sponsor` and `/nonce` accept requests only with the owner's SIWS session; the app gets that session from the same Connect prompt. This partly mitigates #27 (spec §2.7). The `dexxer_core` program is not touched.

### Plan in brief

Architecture: the relayer hands out a single-use nonce (`POST /auth/challenge`), verifies the signed SIWS message (`POST /auth/siws`) and issues a random session token (Postgres stores only its `sha256`). Middleware `requireSession` sits in front of `/sponsor` (session owner == tx signer) and `/nonce` (owner taken from the session). The app signs SIWS with the relayer nonce on Connect and fetches a session with `ensureRelayerSession` at the start of onboarding/deposit. Stack: Express 5, `pg`, `tweetnacl`, `@solana/wallet-standard-util` 1.1.4, `node:test` (relayer); Expo/RN, `expo-secure-store`, MWA via `@wallet-ui/react-native-web3js` (app).

| Task | Name | Outcome |
|---|---|---|
| Task 1 | relayer: SIWS check, `AuthStore`, `/auth/*`, `requireSession` | `src/auth.ts`, migration `006_auth.sql`, `test/memAuthStore.ts`, `test/auth.test.ts` (+18 tests) |
| Task 2 | relayer: gate `/sponsor` and `/nonce`, mount in `index.ts` | gate in `sponsor.ts`/`nonce.ts`, fail-closed in `index.ts`; +2 `/sponsor` and +2 `/nonce` tests |
| Task 3 | app: `relayerAuth.ts`, Bearer in clients, Connect, entry points | `src/lib/relayerAuth.ts`, Bearer in `sponsorTx`/`fetchNonces`, relayer nonce in Connect SIWS, `ensureRelayerSession` at the start of `runBatchedOnboarding`/`depositTx`; `tsc` + `expo lint` clean |
| Task 4 | documents | spec §2.7 "Implemented", §7.1 #27, `CLAUDE.md`, `docs/deployments.md` |
| Task 5 | live run (as far as the environment allows) | relayer live run done (see Measurements); app on the emulator not run |

Fixed design facts:
- Constants: nonce = 16 random bytes hex, TTL 5 min (`CHALLENGE_TTL_MS`); `issuedAt` skew ±5 min (`ISSUED_AT_SKEW_MS`); session = 32 random bytes (`base64url`), TTL `AUTH_SESSION_TTL_HOURS` (`DEFAULT_SESSION_TTL_HOURS = 168`); `MAX_OPEN_CHALLENGES = 10_000` → 503; `SIWS_STATEMENT = "Sign in to the Dexxer relayer"`; `/auth/siws` JSON limit `8kb`, `/nonce` `4kb`.
- `/auth/challenge` response: `{ nonce, issuedAt, expirationTime, domain, uri: https://<domain>, statement, version: "1" }`. `/auth/siws` body `{ address, signedMessage, signature }` (base64) → `{ token, owner, expiresAt }`.
- `verifySiws` check order: `parseSignInMessage` (not SIWS → 400); `domain` and host of `uri` == `SIWS_DOMAIN`; message `address` == `body.address` (bad base58 → 400); nonce present; `issuedAt` ±5 min; `expirationTime` (if any) in the future; `notBefore` (if any) in the past; signature exactly 64 bytes; ed25519 verify. Rejections are 401. Only after a valid signature is the nonce consumed atomically (`UPDATE … SET used_at … WHERE nonce = $1 AND used_at IS NULL AND expires_at > … RETURNING`); unknown/used/expired → 401. `chainId` is not checked.
- Migration `006_auth.sql`: `auth_challenges(nonce PK, expires_at, used_at)`, `auth_sessions(token_hash PK, owner, created_at, expires_at)`, indexes on `expires_at`; expired rows (`expires_at < now() - interval '1 hour'`) deleted inline in `createChallenge`/`createSession`, no background job.
- `AuthStore` interface: `createChallenge`, `countOpenChallenges`, `consumeChallenge`, `createSession`, `getSession`; `pgAuthStore(pool)`; `hashToken` = sha256 hex.
- `requireSession`: header must match `^Bearer ([A-Za-z0-9_-]+)$`, else 401 (`bearer x`, empty, `Basic` → 401, not 500); sets `res.locals.sessionOwner: PublicKey`.
- `/sponsor`: session → `checkWhitelist` → session owner == tx owner signer (else 403) → `reserve`. No session → 401 before parsing or `reserve`.
- `/nonce`: owner from the session; `body.owner` optional, invalid → 400, ≠ session owner → 403. An unauthenticated POST no longer spends SOL.
- `index.ts`: env `SIWS_DOMAIN` (required; the app's MWA identity domain, `IDENTITY_DOMAIN`, today the relayer host), `AUTH_SESSION_TTL_HOURS` (168; non-finite or ≤ 0 falls back to the default). Mounted in the `sponsorEnabled && pool` block; without `SIWS_DOMAIN` an error is logged and `/auth`, `/sponsor`, `/nonce` are not mounted (fail-closed).
- Logs: rejection reason and owner pubkey, never the token.
- App: token stored per owner in SecureStore (key `dexxer.relayer.<owner>`, `{ token, expiresAt }`), renewed when < 5 min to `expiresAt` (`REFRESH_SKEW_MS`). SIWS `domain`/`uri` = `IDENTITY_DOMAIN`/`IDENTITY_URI`; from the challenge only `nonce`/`issuedAt`/`expirationTime`/`statement`/`version`. `__DEV__` warning if relayer `SIWS_DOMAIN` ≠ app `IDENTITY_DOMAIN`. Signature normalized by `pickSignature` to 64 bytes. On 401 from `/sponsor`/`/nonce` the token is cleared (`clearRelayerToken`), no auto-prompt mid-flow. A relayer error at Connect does not fail Connect.
- `@solana/wallet-standard-util` 1.1.4 — explicit dependency of both relayer and app.
- Review focus (plan): wallet returning `message ‖ signature` (128+ bytes); wallet ignoring the passed `nonce` (exchange → 401, Connect survives); two parallel `/auth/siws` with one nonce → exactly one 200; garbage `Authorization` → 401; old client without token on `/nonce` → 401 and no `reserve`/`send`.

### What was done

Relayer: `src/auth.ts` (`verifySiws`, `authRouter`, `requireSession`, `pgAuthStore`), migration `006_auth.sql`, gate in `sponsor.ts`/`nonce.ts`, fail-closed in `index.ts`. App: `src/lib/relayerAuth.ts`, Bearer in `sponsorTx`/`fetchNonces`, relayer nonce in SIWS on Connect, `ensureRelayerSession` at the start of `runBatchedOnboarding`/`depositTx`. Spec §7.1 #27 marked "partially mitigated, week 6".

### Measurements

- Relayer tests **121 → 143** (+18 `auth.test.ts`, +2 `/sponsor` gate, +2 `/nonce` gate); app — `tsc` + `expo lint` clean.
- Live relayer run (devnet profile, one-off keys, real Postgres 16 in Docker): migration applied; HTTP e2e **9/9** — challenge → siws 200, replay 401, foreign domain 401, `/nonce` without a token 401, garbage token 401, someone else's `body.owner` 403, with a session the request passes the gate (then 502 from the devnet preflight of the unfunded one-off `fee_payer`, expected), `/sponsor` without a token 401; `auth_sessions` holds only `sha256(token)`, TTL 168 h; without `SIWS_DOMAIN` — `/auth`/`/nonce`/`/sponsor` 404, `/healthz` 200.

### Rulings and findings

- State before (spec §2.7, read from code): `/nonce` accepted `body.owner` without any signature and spent ≈0.003 SOL of rent (two nonce accounts) from the shared daily budget; the app already did SIWS on Connect but discarded the `SignInOutput`.
- The session is not an owner/TEE token: SIWS is bound to the app identity domain (different format from the TEE challenge), opens only `/sponsor`/`/nonce`, is never forwarded.
- Nonce is consumed only after a valid signature, so garbage cannot burn someone else's nonce.
- Sessions are ensured before the first prompt of a flow: `signOwnerL1` silently falls back to a live blockhash when `/nonce` fails, which on Phantom means "confirm timeout" (Alpenglow).
- Final self-review (27.09, spec §2.7.3): relayer unable to issue a session (network 0, 404 from a pre-§2.7 relayer, 5xx) → the flow continues without a session; 4xx from `/auth/siws` and a wallet rejection are flow errors. A new APK against an old relayer works as before.
- Deliberately not done: `/auth/logout`, deleting the token on Disconnect.
- Rollout without a flag: `SIWS_DOMAIN` in Railway → relayer deploy → new APK; old APK gets 401 on `/sponsor` and falls back to a live blockhash on `/nonce` — acceptable for the devnet MVP.
- Environment finding: relayer tests must run on Node from `.nvmrc` (24.18); on 24.10 `sponsor.test.ts` does not load (`import { BN } from "@coral-xyz/anchor"`, CJS named export) — not a code defect.

### Open at the end

- Sybil remains open: fresh keys are free and each signs SIWS; full closure of #27 needs a scarce resource (invite codes / Seeker Genesis Token / per-IP) — a separate product decision.
- Not run: the app on the emulator (fakewallet/Phantom) — needs a Railway deploy with `Config.fee_payer`/`crank` keys (user action); checklist in `docs/deployments.md`; Phantom checklist for the user.

---

<a id="multi-market"></a>
## Multi-market in the program (28.09.2026)

Source: `2026-09-28-week6-multi-market-program.md` (plan 1 of 3: program `dexxer_core` + LiteSVM); outcomes from `2026-09-18-dexxer-mvp-design.md` §2.8 "Implemented (program, 28.09)".

### Goal

The program lets the admin create markets by symbol, and lets an owner hold a position on every market (enable, session, exit), without changing any account layout. Plan 2 (relayer + admin TS scripts) and plan 3 (app) consume the IDL and measurements from this layer. Spec: §2.8 (2.8.1, 2.8.2, 2.8.5).

Architecture: `init_market`/`delegate_market` parameterized by symbol (`[MARKET_SEED, symbol]`, SOL PDA unchanged). New module `instructions/positions.rs`: `init_position` + `delegate_position` (L1), `init_position_permission` and `undelegate_position` (ER), `close_exited_position` (L1). `set_session` updates the permissions of the owner's other positions from `remaining_accounts`. Trading, liquidation and crank were already parameterized by the market account — proved by tests, not code changes.

### Plan in brief

Global constraints fixed by the plan:
- No account layout changes; errors only APPENDED to the end of `DexxerError` (stable numbering).
- SOL market PDA stays `[MARKET_SEED, b"SOL\0\0\0\0\0"]`.
- Symbol: 1–8 bytes `A-Z0-9`, left-aligned, zero-padded; otherwise `InvalidSymbol` (`validate_symbol(&[u8; 8]) -> bool` in `state/market.rs`; a lowercase twin or a stray byte after the padding would mint a second PDA for "the same" market).
- No new instruction commits private bytes to L1: `undelegate_position` requires `Position::Empty` (fields already zeroed by `finalize_close`), closes the permission and calls `exit()` BEFORE `commit_and_undelegate` (week 3 rule, ruling 10).
- Permission/Magic/Delegation CPIs are absent in LiteSVM: gated on `executable` (as in `init_market_permissions`/`undelegate_user`); authorization is checked before the gate.
- Solana MCP `program_autofixer` was unavailable in this session → replaced by `cargo fmt --check` + `cargo clippy` + full LiteSVM/unit.
- LiteSVM needs `target/deploy/dexxer_core.so` rebuilt with `cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml` — NOT `anchor build` (local `anchor` is 0.26, and `anchor-1.0.2` with `[toolchain] solana_version` may switch the global Solana).

Review focus: (1) `set_session` with another owner's position or a permission not derived from this position → reject (Task 4); (2) `init_position` for a symbol whose market does not exist → `MarketNotFound` (Task 2); (3) `undelegate_position` by the crank while the owner is active → `Unauthorized` (Task 5); (4) `close_exited_position` while `UserAccount` is still delegated on L1 → do not close (Task 5); (5) an open non-SOL position blocks `undelegate_user` with `BalanceNotZero` (Task 3).

| Task | Name | Outcome |
|---|---|---|
| Task 1 | market symbol, parameterized `init_market`/`delegate_market`, multi-market harness (`setup::sym`, `Mkt {symbol, market, risk, feed}`, `World::add_market`, `set_price_on`, `Trader::position_on`/`trade_accounts_on`, `ixs::delegation_quad`, `dlp`) | done; new suite `tests/litesvm/tests/markets.rs`, +3 unit `symbol_tests` |
| Task 2 | `init_position` + `delegate_position` (L1); helpers `require_user_active`, `user_has_left` | done |
| Task 3 | trading on two markets — isolation, per-market liquidation, exit (characterization tests; `assert_invariant_markets`, `open_position_on`, `close_position_on`, `crank_tick_on`) | passed **without program changes** |
| Task 4 | `init_position_permission` (ER) + `set_session` with pairs for other markets | done |
| Task 5 | `undelegate_position` (ER) + `close_exited_position` (L1); `close_permission_if_present` → `pub(crate)` | done |
| Task 6 | quality, IDL, measurements, docs | done; spec §2.8 "Implemented (program, 28.09)", CLAUDE.md rules |

Account lists fixed by the plan:
- `init_market`: `[admin(s), config, market(w), market_risk(w), system]`; `delegate_market(symbol)`: `[admin(s), config, quad(market), quad(risk), program, dlp, system]`, quad = `[buffer, delegation_record, delegation_metadata, account]`.
- `init_position(symbol)`: `[owner(s), payer(s,w), market, user_account, position(w, init), system]`; rent + `EphemeralPermission` prefund paid by `payer` (`fee_payer` via `/sponsor` for a 0-SOL owner, or the owner).
- `delegate_position(symbol)`: `[owner(s), payer(s,w), config, market, user_account, quad(position), program, dlp, system]`, validator = `Config.tee_validator`.
- `init_position_permission()`: `[signer, config, position, user_account, position_permission, permission_program, ephemeral_vault, magic_program]`; members `[owner, session, crank]`; create vs update decided by permission ownership (a fresh one has 0 lamports).
- `set_session`: `remaining_accounts` pairs `[position (w), position_permission (w)]`; a permission not yet owned by the permission program is skipped (`continue`).
- `undelegate_position()`: `[signer, config, position, user_account, position_permission, ephemeral_vault, permission_program, fee_escrow, magic_fee_vault, magic_context, magic_program]`; cancels the liquidation task (`liq_task_id(position)`; unknown id = measured no-op, week 5) and runs `commit_and_undelegate` via `FeeEscrow`.
- `close_exited_position()`: `[fee_payer, config, position, user_account]`; `close = fee_payer`, constraint `Position::Empty` → `HasOpenPosition`, handler `user_has_left` → `NotExited`.

### What was done

Branch `multi-market`. New instructions live in a separate `instructions/positions.rs`; no account layout changed; the devnet program upgrade was left to the user.
- Markets: `init_market(symbol, params, lazer_feed_id)`, `delegate_market(symbol)`; a test pins the `"SOL\0…"` address.
- Positions: `init_position(symbol)` / `delegate_position(symbol)` (L1, `owner` + `payer`); `init_position_permission()` (ER, no argument — market and owner from the `Position` itself), signer the owner or a live session key, does not spend `actions_left`; `set_session` pairs (odd count / wrong permission → `InvalidInput`, foreign position → `Unauthorized`, non-`Position` → `AccountDiscriminatorMismatch` 3002); `undelegate_position()` (ER); `close_exited_position()` (L1, `fee_payer`).
- New errors (appended, numbers stable): `InvalidSymbol` 6044, `NotOnboarded` 6045, `UserExited` 6046, `MarketNotFound` 6047, `PrimaryPositionMismatch` 6048 (the last one added by the final review; not in the plan).
- IDL (`app/src/idl/dexxer_core.json`) regenerated with `anchor_lang_idl::build::IdlBuilder` 0.1.4 (what `anchor idl build` 1.0.2 calls) without `anchor-cli`; the method was verified on `main` byte-for-byte except the trailing `\n`. Diff: +5 instructions, +5 errors, `symbol` in `init_market`/`delegate_market`.

### Measurements

Tests: LiteSVM **107** (89 + 18 in `tests/markets.rs`: 17 behavioral + 1 measurement; the plan expected 89 + 16), unit **64** (61 + 3 `symbol_tests`), relayer 171 unchanged (161 pass, 10 DB-skip) on the new IDL, `tsc` ×4 clean.

| What (LiteSVM) | Value |
|---|---|
| Rent per additional market per user (`Position` + `EphemeralPermission` prefund) | **2 742 544 lamports** (≈0.00274 SOL); ≈0.011 SOL for 4 markets from `fee_payer` (delegation-record rent separate, to measure on devnet in plan 2) |
| CU `init_market` | 20.8k |
| CU `init_position` | 14.6–19.1k |
| CU `init_position_permission` | 12–17k |
| CU `set_session` | 32–44k without pairs, 40–54k with 2 pairs |
| CU `undelegate_position` | 16–17k |
| CU `close_exited_position` | 8.5k |
| Sponsored tx (nonce-advance + 2 CB + `[init_position, delegate_position]`×N, signers `fee_payer` + owner) | N=1 732 B, N=2 948 B, **N=3 1164 B**, N=4 ≈1380 B > 1232 → **≤ 3 markets per L1 tx**; four new markets = two legs (plan 3) |
| `set_session` + 4 pairs | 849 B (fits; together with other ER instructions in one tx — check in plan 3) |

ER CPIs are skipped in LiteSVM; the CU spread comes from the bump search for random keys.

### Rulings and findings

- Characterization tests (SOL and BTC for one trader, BTC-only liquidation, exit blocked by an open BTC) passed without program changes: trading, the crank and the margin gate were already market-parameterized.
- Final-review finding — the SOL position goes only together with `UserAccount`: `init_user`/`init_user_reuse_queue` pin it to SOL, but `undelegate_user`/`close_exited_user` derived the position seed from `position.market` and would accept any empty position of the owner. If the janitor closed the SOL position via `close_exited_position`, or `close_exited_user` got a BTC position, re-onboarding would become impossible forever. Fix: `undelegate_user`/`close_exited_user` accept **only** the SOL position; `delegate_position`/`undelegate_position`/`close_exited_position` **only** non-SOL (`PrimaryPositionMismatch`; checked in the handler, not a constraint — `UndelegateUser::try_accounts` is at the SBF frame limit).
- Plan rulings deviating from §2.8.2: (1) `undelegate_position` signed by the owner (any time) or the crank only when the owner has left; the session key is NOT allowed (least privilege; cost — one wallet signature in Exit). (2) No scrub: `Position::Empty` is already zeroed by `finalize_close`. (3) `user_has_left` is conservative: `UserAccount` absent or under the program with `exited`; delegated (Delegation Program owner) or foreign = not left (tested with a manually set DLP owner). (4) `require_user_active` in `init_position`/`delegate_position`: delegated = active; under the program → read `exited` (mid-onboarding or LiteSVM). (5) No symbol argument in `init_position_permission`/`undelegate_position`/`close_exited_position` — none derives the market from seeds.
- Spec §2.8.1 fix (28.09): `max_position` is notional in USD (1e6), not size — the first edition set "BTC 0.15" = `150_000_000`, read as $150 notional; the first BTC open for $800 failed with `PositionTooLarge`, found by a LiteSVM test. The cap is taken as in SOL, not scaled by price; `min_size` is per market.

### Superseded later

CLAUDE.md marks the multi-market position design as "Outdated since 30.09.2026" (see "Week 6 rules: position slots"), and spec §2.8.2 is marked "replaced by §2.9 (30.09.2026): slots in a single account". Per-market `Position` PDAs, `init_position`/`delegate_position`/`init_position_permission`/`undelegate_position`/`close_exited_position`, `set_session` pairs, `PrimaryPositionMismatch` gating and `user_has_left`/`require_user_active` were replaced by the 16-slot `Positions` account; the IDL dropped to 40 instructions (was 50). The symbol-keyed markets (`[MARKET_SEED, symbol]`, `validate_symbol`, USD-notional `max_position`, per-market `min_size`) remain in force.

### Open at the end

- Program upgrade on devnet — user's gate (rollout: upgrade → `add-market` BTC/ETH/HYPE/ZEC → relayer deploy with migration `008` → new APK).
- Delegation-record rent per market — measure on devnet (plan 2).
- `set_session` + 4 pairs combined with other ER instructions in one tx — check in plan 3.
- From spec §2.8.5: SOL staleness threshold on devnet vs a ≈9 s feed (reconcile, do not change blindly); `fee_payer` budget per market; low-priced assets (BONK) at scale 1e6 — out of scope.

---

<a id="slots-program"></a>
## Position slots, plan 1: program (30.09.2026)

Source: `2026-09-30-week6-slots-program.md`; outcomes from `2026-09-18-dexxer-mvp-design.md` §2.9 "Implemented (program, 30.09.2026)".

### Goal

A trader holds positions on any markets in ONE `Positions` account (16 slots + a private history ring of 16 records); trades are not disclosed; a new market needs no action from the trader; risks #38 and #39 closed. Spec §2.9 (2.9.1, 2.9.2, 2.9.5) overrides §2.4.1 and §2.8.2. Plan 1 of 4 (plans 2–4: relayer + admin TS; app; clean deploy and measurements).

### Plan in brief

Order: first delete the disclosure subsystem and the per-market position instructions (program shrinks, stays green), then add the zero-copy `Positions` account and move onboarding, trading, liquidation, crank and exit onto it in one step. The market is looked up in the account's data (slot by market key), not in the PDA address. Then multi-market behavior tests, per-sample hysteresis (#38) and rent return to the payer (#39).

Global constraints fixed by the plan:
- Branch `positions-slots` from `main` 9904b98; nothing pushed; commit per task. Clean devnet start: no layout compatibility with old accounts needed. `DexxerError` codes only APPENDED; unused variants stay (the app's error map relies on numbers).
- `Positions` layout (spec §2.9.1): `owner: Pubkey | slots: [PositionSlot; 16] | history: [HistoryRecord; 16] | history_head: u8 | history_len: u8 | version: u8 | bump: u8 | _pad: [u8; 4] | _reserved: [u8; 64]` = 3176 B + 8 (`SPACE` 3184). Seeds `[b"positions", owner]`. Access only via `AccountLoader` (Borsh by value of 3.1 KiB overflows the SBF stack).
- `PositionSlot` 96 B: `market: Pubkey | size | entry | margin | liq_price | opened_slot | oi_notional | last_liq_mark_slot (u64 ×7) | state: u8 | side: u8 | liq_ticks: u8 | _pad: [u8; 5]`. `HistoryRecord` 96 B: `market: Pubkey | size | entry | exit: u64 | pnl: i64 | fees | opened_slot | closed_slot: u64 | side: u8 | reason: u8 | _pad: [u8; 6]`.
- Constants: `POSITIONS_SEED = b"positions"`, `MAX_SLOTS = 16`, `HISTORY_LEN = 16`, `SLOT_EMPTY = 0`, `SLOT_OPEN = 1`; `Side` 0 Long / 1 Short; `CloseReason` 0 User / 1 Liquidated.
- `RefMut` from `load_mut()` must be dropped BEFORE any CPI that takes the account (scheduler, permission, `commit_and_undelegate`).
- No private byte reaches L1: `undelegate_user` erases history and requires all slots `Empty` before `commit_and_undelegate`; a cleared slot is all 96 bytes zero, `market` included.
- CPIs to Permission/Magic/Delegation are absent in LiteSVM: gates on `.executable`, authorization BEFORE the gate.
- Build with `cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml` (NOT `anchor build`); LiteSVM `cargo +nightly-2026-09-18 test -p dexxer_litesvm`; unit `cargo test -p dexxer_core`; `cargo fmt --check && cargo clippy -p dexxer_core -- -D warnings` before commit; `program_autofixer` on every changed `.rs`.
- Baseline on `main`: LiteSVM 107, unit 64.

Review focus: (1) foreign-market slot → `PositionNotOpen` (trading) or silent `continue`/no-op (crank, scheduler); (2) 17th market → `NoFreeSlot`, state unchanged; (3) 17th close overwrites the oldest record, liquidation writes `reason = Liquidated`, `undelegate_user` leaves zero non-zero slot/history bytes; (4) one price sample — one liquidation tick (#38); (5) rent to the payer (#39).

| Task | Name | Outcome |
|---|---|---|
| Task 1 | Remove the disclosure subsystem | Done. Deleted `write_commitment`, `write_disclosure`, `set_disclosure_delay`, `close_orphan_queue`, `init_user_reuse_queue`, `DisclosureQueue`/`Commitment`/`Disclosure`, `ClosedRecord`, `PositionState::Closed`, `Config.disclosure_delay_slots`, `UserAccount.nonce`, `MAX_ACTIONS_PER_COMMIT`. `commit_aggregate()` — no arguments, no actions: `commit(&[Pool, BalancesRoot])` via `FeeEscrow`. `Trade` — 12 accounts; `crank_tick` — pairs. RED test `nine_closes_in_a_row_all_succeed` (9th close failed `QueueFull`) |
| Task 2 | Remove per-market position instructions | Done. `init_position`, `delegate_position`, `init_position_permission`, `undelegate_position`, `close_exited_position` gone; `set_session` ignores `remaining_accounts`; `NotOnboarded`, `UserExited`, `MarketNotFound`, `PrimaryPositionMismatch` kept unused in the enum |
| Task 3 | `Positions` state — slots and history ring | Done. `state/positions.rs` (`find_open`, `open_index`, `alloc`, `clear_slot`, `open_count`, `push_history`, `scrub_history`), `liq_task_id(positions, market)` = keccak(positions ‖ market)[0..8] LE, `NoFreeSlot` appended last |
| Task 4 | Move the program onto slots | Done. `Position`/`PositionState` deleted; all trading/crank/exit instructions on slots; `finalize_close` writes a `HistoryRecord` and resets the slot (cannot fail due to fullness) |
| Task 5 | Multi-market behavior, slot ceiling, history | Done (LiteSVM: several markets, 17th ceiling, history ring, exit scrub) |
| Task 6 | Risk #38 — one price sample, one tick | Done in two commits; mechanism changed by the final review (see rulings) |
| Task 7 | Risk #39 — rent to its payer; owner may close | Done. `UserAccount.rent_payer`, `_reserved: [u8; 32]`, `USER_ACCOUNT_VERSION = 3` |
| Task 8 | Measurements, IDL check, documents | Done (spec "Implemented (program)", CLAUDE.md) |

Account lists fixed by Task 4/7:
- `Trade` (12): `[signer, config, market, market_risk, pool_live, user_account, positions, feed, fee_escrow, task_context(=positions), magic_program, liq_crank_signer]`.
- `LiquidationCheck`: `[crank, config, market, market_risk, pool_live, feed, positions, user_account]`; no slot on the market → `Ok(())`.
- `InitUser`: `[owner, payer, config, user_account, positions, system_program]` (no `market`); `DelegateUser`: `[owner, payer, config, user_account, positions]` + delegation quads; `InitPermissions`/`SetSession`: `positions` + `positions_permission`, no `market`.
- `UndelegateUser`: `[owner, config, user_account, positions, user_permission, positions_permission, ephemeral_vault, permission_program, fee_escrow, magic_fee_vault, magic_context, magic_program]` + `remaining_accounts` = markets whose tasks to cancel (≤16).
- `CloseExitedUser`: `[closer, config, rent_payer, user_account, positions]`; closer = `Config.fee_payer` or owner, else `Unauthorized`; `rent_payer` must equal `UserAccount.rent_payer`.

### What was done

Tasks 1–8 on branch `positions-slots`, LiteSVM/unit only, nothing measured on devnet. Final review (30.09.2026, commit `fix(program): liquidation cannot be evaded…`):
- C1: `increase_position` no longer resets `liq_ticks` and rejects an increase after which the slot is liquidatable at the stored `Market.mark` (`PositionLiquidatable` 6050; no check when `mark == 0`; `add_margin` unchanged).
- C2: a sample is `posted_slot != last_print` (was `>`).
- C3: a print on which `crank_tick` fired the deviation safeguard does not move `last_print`/`sample_seq` — `liquidation_check` neither counts nor liquidates on it.
- I3: a partial `decrease_position` writes a history record (`reason = 2`).
- Minor: `delegate_user` → `UserExited`; `undelegate_user` also zeroes slots (`Positions::scrub_slots`); `alloc(&self)`; unused `DexxerError` variants marked; foreign-market tests for `increase/decrease/add_margin/crank_tick/liquidation_check` (`*_on` builders); byte-by-byte slot comparisons. C1–C3 and I3 tests written first and seen red. Full `program_autofixer` over the 16 changed program `.rs` files (whole files; `user.rs` in two parts) — 0 findings.

Deleted tests: unit (−6) — commitment hash and golden vector, queue helpers (`due_reveals`, `pending_commitments`, `push`), `build_crank_only`. LiteSVM — files `disclosure.rs` (12) and `commit_actions.rs` (6) entirely; `set_disclosure_delay`, full ring in `crank`, `QueueStillPending`, exit with disclosure debt, `close_orphan_queue` ×4, `init_user_reuse_queue` (6 separate); 13 position-per-market tests in `markets.rs` (replaced by slot-based Task 5). All money/OI/margin/liquidation assertions preserved.

### Measurements

LiteSVM, not devnet; re-measured after the final review.

| Item | Value |
|---|---|
| Unit `dexxer_core` | **68** (main 64; 66 before the final review); `mock_oracle` 1 |
| LiteSVM | **89** (main 107); trajectory 107 → 82 → 69 → 69 → 76 → 81 → 82 → 89 (+4 `liquidation.rs` C1 ×2/C2/C3, +1 `resize.rs` I3, +2 `markets.rs` foreign market) |
| `Positions::SPACE` | 3184 B (pinned by `assert_eq!` in `size_tests` and `positions.rs`); `UserAccount` 207 B |
| L1 rent `(space + 128) × 6960` | `Positions` 23 051 520 lamports (≈0.0231 SOL), `UserAccount` 2 331 600, total 25 383 120 (≈0.0254 SOL); ER-permission prefund 7 264 lamports ×2 |
| `.so` | **1 107 440 B** (before review 1 109 712) |
| IDL | 40 instructions (50 on `main`, exactly 10 deleted; the plan's 37 was a counting error — `process_undelegation` comes from `#[ephemeral]`); not regenerated after the review (only an error code added) |

CU (`measure_slots` in `tests/litesvm/tests/markets.rs`, `-- --nocapture`, six runs):
- Stable: `open_position` 27 857; `increase_position` **29 744** (was 28 489; only change — C1 check); `close_position` 26 686; `liquidation_check` 24 746 (no liquidation) / 25 979 (liquidates).
- Key-dependent (PDA via `find_program_address`, cost depends on bump): `init_user` 18 741…23 241; `undelegate_user` with 5 markets 20 341…29 341; `crank_tick` 16 candidates without liquidations **142 096…172 096**, first hysteresis tick 142 351…172 351, with **16 liquidations** **162 080…192 080** (within one run the difference is constant — 19 984).
- Before the review one run gave 178 973 without liquidations (`main` 166k, with triples) and 198 989 with 16 liquidations (`main` 367k); since the number wanders by ~30k on the same code, "166k → 179k growth" is not established by one run; the cause of 367k → ~199k not measured. `sixteen_candidates_fit_in_cu_budget` — 182 596 in one run.
- Conclusion: a batch with 16 liquidations is near or above the default 200k — raising the CU limit is mandatory. CU excludes CPIs to Permission/Magic/Delegation (absent in LiteSVM).

### Rulings and findings

1. 16 slots, not 8 (user's decision 30.09).
2. **#38 not via `Market.mark_slot`** (the plan's Task 6 design): `mark_slot` grows on every crank tick, so two crank sources gave two ticks per print. Instead `Market.last_print`/`sample_seq` (moved only by `crank_tick`) and `PositionSlot.last_liq_sample` (renamed from `last_liq_mark_slot`, same type and offset); `liq_ticks` grows only when `sample_seq > last_liq_sample`. Hysteresis default 2 (back from 3).
3. Consequence: `liquidation_check` only reads the market, so liquidation without the relayer requires a live `crank_tick` per market (scheduled crank on the new deployment, re-measure M-G′ — plan 4).
4. `crank_tick` aborts the whole batch on a structurally wrong pair: PDA/owner mismatch or account not the program's → `InvalidCandidate`; first account the program's but not `Positions` → Anchor **3002** (`AccountDiscriminatorMismatch` from `AccountLoader::try_from`); `continue` only for a trader without an open slot on the market and an undecodable `UserAccount`.
5. `undelegate_user` cancels tasks only for markets in `remaining_accounts` (≤16, by key); a liquidated position leaves its task until the next `open` on the market or exit (cancelling an unknown id is a safe no-op, week 5).
6. #39: `rent_payer` survives the `undelegate_user` scrub (public on L1 anyway); tests in `tests/litesvm/tests/user.rs`.
7. `liq_task_id` golden vector: positions `[1; 32]`, market `[2; 32]` → `1387748199796337972` (verified by another keccak implementation); swapped argument order → `4965387733951305052`.
8. `program_autofixer` was run on excerpts of large files in some tasks; full whole-file pass in the final fix wave (0 findings).
9. History ring: `HistoryRecord` carries only ER slots (`opened_slot`/`closed_slot`), no unix time; reasons 0 close by owner, 1 liquidation, 2 partial decrease.
10. IDL: plan 1 did not regenerate `app/src/idl/dexxer_core.json` (TS kept working against the old IDL until plan 2).

### Superseded later

- "Not measured (devnet)" list — closed 01.10.2026 (plan 4, spec "Measured (devnet, 01.10.2026)"), except task resilience to a TEE restart and CU of `credit_deposit`/`withdraw` (TEE does not return it); cost of tasks over an exited account — only an observation (no fee visible).
- "Open for plan 2/plan 3" — done 01.10.2026; the canonical IDL went to `idl/dexxer_core.json`, not `app/src/idl`.
- Unit count 68 → 69 on 01.10.2026 (offsets test `offsets_match_the_off_chain_decoders`).

### Open at the end

- Not measured on devnet (at plan 1 close): several `liquidation_check` tasks of one trader on one `Positions` (shared `task_context`); M-G′; `posted_slot` of the real feed on every print; CU in ER with zero-copy; onboarding tx sizes; cost of the simplified commit; task resilience to a TEE restart; that the automatic `exit` of zero-copy `Positions` after `commit_and_undelegate` gives no `ExternalAccountDataModified`; cost of tasks left over an exited account.
- Plan 4 first gate: `posted_slot` of real Pyth Lazer changes on every print, and every market has a live `crank_tick` source.
- Whether to gate the EMA by a new print (every `crank_tick` re-applies EMA to the same print — behavior from `main`).
- Plan 3 inputs: error map `NoFreeSlot` 6049, `PositionLiquidatable` 6050; History from the `Positions` ring.

---

<a id="slots-relayer"></a>
## Position slots, plan 2: relayer, admin TS, canonical IDL (01.10.2026)
Source: `2026-09-30-week6-slots-relayer.md`; spec `2026-09-18-dexxer-mvp-design.md` §2.9 "Implemented (relayer and admin TS, 01.10.2026)".

### Goal
Make the TypeScript side (`tests/er`, `scripts`, `services/relayer`) and the committed IDL work with the plan 1 program (`Positions` slots, no disclosure) and with several markets: the crank ticks and liquidates every market, the indexer serves prices per market, the janitor closes the accounts of owners who exited, CI is green again. Branch `positions-slots` (from plan 1 head `b2176f7`). Nothing was run against devnet or deployed (that is plan 4); the app is plan 3. Port source: unmerged branch `multi-market-relayer` (head `2b58fd3`), read via `git show`, never checked out or merged.

### Plan in brief
Order: IDL generator → shared library `tests/er/lib` (PDA, `Positions` codec, trader/admin helpers) → relayer in three steps (port the position-independent part of `multi-market-relayer`; janitor + sponsor whitelist; per-market crank on slots + simplified commit cycle). Disclosure removed from the relayer entirely.

Global constraints fixed by the plan: Node from `.nvmrc` (24.18.0); relayer tests `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl npm test`; `tsc --noEmit` in `tests/er`, `scripts`, `services/relayer`; Postgres tests (`test/indexerDb.test.ts`) only with `TEST_DATABASE_URL`, skipped otherwise; never run `anchor build` locally; `programs/` unchanged except one offsets unit test (then `program_autofixer`); `idl/dexxer_core.json` without trailing `\n`; servers read only public accounts and the oracle, private accounts (`Positions`, `UserAccount`, `MarketRisk`, `PoolLive`) only by the crank via its own TEE token; open interest never served; `Positions`/`PositionSlot`/`HistoryRecord`/`BalancesRoot` are `bytemuck`/`repr(C)`, decoded only manually; candidates are `[Positions, UserAccount]` pairs, ≤16 per instruction (wrong-type first account aborts the batch, Anchor 3002); `commit_aggregate()` has no arguments and no `remaining_accounts`, fixed interval only. Baseline relayer on `main`: 171 tests (161 + 10 Postgres). Full green required from Task 6.

Review focus: (1) trader with positions on several markets (one candidate per OPEN slot, no repeated pair in one tx); (2) garbage among `Positions` accounts skipped with a log; (3) SOL always ticks, unknown market visible; (4) janitor does not close early and sends rent to the address read from the account; (5) clock-based commit.

| Task | Name | Outcome |
|---|---|---|
| Task 1 | In-repo IDL generator, new IDL | Done: `tools/idlgen` (`anchor-lang-idl` 0.1.4, standalone crate with its own `[workspace]`), canonical `idl/dexxer_core.json` — 40 instructions; CI and Dockerfile switched to it. Ruling: canonical IDL in `idl/`, not `app/src/idl` (see Rulings) |
| Task 2 | `tests/er/lib`: program, PDA, symbols, `Positions` codec | Done: `tests/er/lib/positions.ts`, `symbol.ts`, `pdas.positions(owner)` = `[b"positions", owner]`, `pdas.marketFor(symbol)`; Rust test `offsets_match_the_off_chain_decoders` (the only program change, `#[cfg(test)]`); disclosure helpers deleted |
| Task 3 | Admin/trader helpers, market catalog, `add-market`, scripts | Done: pure account builders in `lib/trader.ts`, `lib/admin.ts`, `lib/markets.ts`, `tests/er/devnet/add-market.ts`; scripts moved to slots; `06`, `12`, `14`, `15` deleted |
| Task 4 | Relayer: market registry, per-market indexer, no disclosure | Done: `src/env.ts`, `src/markets.ts`, `GET /markets`, `?market=`, `/ws?markets=`, migration `008_ticks_market.sql`; disclosure feed removed |
| Task 5 | Relayer: janitor and sponsor whitelist | Done: `src/janitor.ts` (`close_exited_user`), `src/orphan.ts` deleted; `/sponsor` whitelist without `init_user_reuse_queue` |
| Task 6 | Relayer: per-market crank on slots, clock-based commit, wiring | Done: `src/candidates.ts`, `src/commit.ts`, `crank.ts`, `src/index.ts`; `src/disclosure.ts` deleted. Followed by Task 6 fix round (`1435fc2`) |
| Task 7 | Documents and final verification | Done: relayer README, `docs/deployments.md`, spec §2.9, `CLAUDE.md` |

### What was done
- **IDL generator.** `tools/idlgen` calls `IdlBuilder` (`skip_lint(true)`), absolute program path required, output without trailing newline. Run the built binary: `cargo build --release --manifest-path tools/idlgen/Cargo.toml`, then `env -u RUSTUP_TOOLCHAIN CARGO_TARGET_DIR="$PWD/tools/idlgen/target/idl-build" tools/idlgen/target/release/idlgen "$PWD/programs/dexxer_core" "$PWD/idl/dexxer_core.json"`. Pitfalls: `IdlBuilder` substitutes the literal `+{toolchain}` when `RUSTUP_TOOLCHAIN` is set; fresh `CARGO_TARGET_DIR` per checkout. Expected IDL: accounts exactly `BalancesRoot, Config, Faucet, FeeEscrow, Market, MarketRisk, Pool, PoolLive, Positions, UserAccount`; last errors `6049 NoFreeSlot`, `6050 PositionLiquidatable`; `init_user` accounts `owner,payer,config,user_account,positions,system_program`. CI: `cmp` against `idl/` and `DEXXER_IDL_DIR=${{ github.workspace }}/idl`; Dockerfile `COPY idl/dexxer_core.json idl/dexxer_core.json`, `ENV DEXXER_IDL_DIR=/app/idl`.
- **`Positions` layout pinned** (offsets without the 8 B discriminator):
  - `Positions`: `owner` 0, `slots` 32, `history` 1568, `history_head` 3104, `history_len` 3105, `version` 3106, `bump` 3107; `POSITIONS_SIZE = 3184` (8 + 3176).
  - `PositionSlot` (96 B): `market` 0, `size` 32, `entry` 40, `margin` 48, `liq_price` 56, `opened_slot` 64, `oi_notional` 72, `last_liq_sample` 80, `state` 88 (`1` = open), `side` 89, `liq_ticks` 90.
  - `HistoryRecord` (96 B): `market` 0, `size` 32, `entry` 40, `exit` 48, `pnl` 56 (signed), `fees` 64, `opened_slot` 72, `closed_slot` 80, `side` 88, `reason` 89 (`user`/`liquidated`/`decrease`).
  - `decodePositions` throws on wrong length/discriminator, returns only open slots in index order and history oldest-first (ring head = next write index). `liqTaskId(positions, market)` = keccak256 first 8 B, LE, signed; golden `[1;32]`,`[2;32]` → `1387748199796337972`, swapped → `4965387733951305052`.
- **`tests/er/lib/program.ts`.** Added `POSITIONS_DISC`/`POSITIONS_DISC_BYTES`, `MARKET_DISC`; deleted `POSITION_DISC`, `DQ_DISC`, `DISCLOSURE_DISC`, `MAX_ACTIONS_PER_COMMIT`, `ACTION_ESCROW_INDEX`, `hashSeed`, `pdas.position/disclosureQueue/commitment/disclosure`; `hashes.ts` reduced to `leaf`, `pad`, `u64le`.
- **Account builders** (`tests/er/lib/trader.ts`): `initUserAccounts`, `delegateUserAccounts` (delegation triples for `UserAccount` and `Positions`), `permissionAccounts` (shared by `init_permissions` and `set_session`; two permissions `userPermission`, `positionsPermission`), `tradeAccounts` (12 accounts incl. `signer`; `taskContext` = trader's `Positions`, `liqCrankSigner = crankSignerPda(feeEscrow)`), `undelegateUserAccounts`, `closeExitedUserAccounts` (`[closer, config, rentPayer, userAccount, positions]`), `readPositions`. Checked against the IDL by `services/relayer/test/ixAccounts.test.ts`. `readPosition`/`readLastClosedRecord` deleted.
- **Admin** (`lib/admin.ts`): `initMarket(Array.from(SOL_SYMBOL), …)`/`delegateMarket(Array.from(SOL_SYMBOL))` in both `bootstrap()` and `bootstrapDevnet()`; `initConfig` without the disclosure-delay argument (order `crank, oracle_program, tee_validator, scheduler_signer, fee_payer, magic_fee_vault`); `DISCLOSURE_DELAY_SLOTS`, `setDisclosureDelay`, `topUpActionEscrow` deleted; `fundMarketPermissions`/`initMarketPermissions` exported; `MARKET_DEFAULTS.liqHysteresisTicks` 2.
- **Scripts.** `tests/er/devnet/06`, `12`, `14`, `15` deleted; `08-undelegate` rewritten for run file `01` (`remainingAccounts` = markets from history + SOL, ≤16; after exit both PDAs under the program, `Positions` bytes `[40, 40 + 3072)` zero); the known-trader check in `07` depends on order `07` → `08`; `11-liq-task-migration` keeps only "cancel unknown task_id" and "open registers the task"; `add-market` added (`devnet:add-market`), with a note that since risk #38 relayer-less liquidation on a market needs its scheduled task (or the relayer).
- **Indexer/health.** `health.ts`: `markets` field, no `commitMaxActions`/`indexer.disclosures`, `commitIntervalTicks` → `commitIntervalMs`. Indexer: ticks keyed by `market`, `parseMarketParam`, `wsFilterFrom`/`wsWants`, `attachWs(server, { heartbeatMs? })`; `/disclosures`, `/stats`, WS frame `disclosure` removed (404, tested). Migrations `001`/`007` untouched; the `disclosures` table is not dropped (unused).
- **Janitor** (`src/janitor.ts`): owners with `UserAccount.exited` whose `UserAccount` and `Positions` are both back under the program get `close_exited_user` from `fee_payer`, rent to `UserAccount.rent_payer` read from the account; still delegated → skip. Sponsor whitelist: `faucet_init`, `init_user`, `delegate_user` (`{ownerIdx: 0, payerIdx: 1}`), `faucet_mint` (`{ownerIdx: 0}`).
- **Crank** (`src/candidates.ts`, `crank.ts`): one `getProgramAccounts` over `Positions` per tick → one candidate per open slot; garbage skipped with a log; `UserAccount` decoded before inclusion; `chunkCandidates` always yields ≥1 chunk (an empty market still needs its mark advanced); `liquidatedIn` reports a candidate whose slot on the market is gone (unreadable → not reported); CU limit `1_400_000` set explicitly (plan 1 LiteSVM: 16 candidates 142k–172k without, 162k–192k with liquidations). `withSol` — SOL always ticked, the registry's own SOL entry wins.
- **Commit** (`src/commit.ts`): `COMMIT_INTERVAL_MS = envNum("COMMIT_INTERVAL_MS", 300_000, 10_000)`, `commitDue` by wall clock; `runRootCycle` moved from `disclosure.ts`; `runCommitCycle` = `commitAggregate()` with no arguments; steps root → commit → janitor via `runIsolated`; `lastCommitAt` moves only on commit success. Deleted: `COMMIT_INTERVAL_TICKS`, `COMMIT_MAX_ACTIONS`, `QUARANTINE_CYCLES`, `createQuarantineState`, `disclosureCycle`, `runProvisionCycle`.
- **Tests deleted:** `orphan.test.ts`, `disclosure.test.ts`, disclosure cases in `indexerQuery`/`indexerDb`/`health`, `init_user_reuse_queue` in `sponsor.test.ts`; all money/liquidation assertions preserved. Tests ported from the branch: `symbol` (4), `marketParams` (2), `env` (1), `markets` (6), `wsFilter` (3), `wsHeartbeat` (1), `crankMarkets` (7, `marketsOrSolFallback` replaced by `withSol`/`untickedMarkets`).

### Measurements
All from tests/`tsc`; nothing on a network.

| Item | Value |
|---|---|
| Relayer tests at Task 7 | **171** = **164 passed + 7 skipped** (7 = `indexerDb.test.ts`, need `TEST_DATABASE_URL`; no Docker); `main` baseline 171 (161 + 10 Postgres) |
| Relayer after first final-review fix wave | 223 = 216 + 7 |
| Relayer after fix round 2 | 235 = 228 + 7 |
| Relayer after fix round 3 (final) | **244** = **237 passed + 7 skipped** |
| App | **103** (unchanged, `app/` not touched) |
| Unit `dexxer_core` | **69** (68 + offsets test); `mock_oracle` 1 |
| LiteSVM | **89** |
| Other gates | `tsc --noEmit` ×3 clean; `selftest:hashes` ALL PASS; `cargo fmt --check`, `clippy -D warnings` clean; `tools/idlgen` regeneration → `cmp` with `idl/dexxer_core.json` identical |
| Crank tx size | `CRANK_TX_MAX_CANDIDATES = 12`; legacy `crank_tick` tx = `383 + 66·n` B (6 fixed accounts + ComputeBudget + 8 B data); 12 pairs → 1175 B, 13 → 1241 B > 1232 (computed in `test/candidates.test.ts`, not a network measurement) |
| `getProgramAccounts` over `Positions` | ≈4.4 KB per trader per tick (estimate) |

### Rulings and findings
- **Ruling Task 1 (30.09): canonical IDL is `idl/dexxer_core.json`, not `app/src/idl`.** Replacing the app's copy broke 12 of its tests (codecs and builders go through the IDL, `DISCLOSURE_DISC` computed at module load), so `app/` was not touched at all and its old IDL stays until plan 3; the planned `app/src/lib/errors.ts` edits (6049/6050 messages) were replaced by "`app/` unchanged, 103/103". CI compares `idl/` but had not run on the branch — byte-identity with `anchor build` unverified until the first CI run on a PR.
- **Janitor (fix round):** the per-cycle limit counts **attempts** (`JANITOR_MAX_ATTEMPTS_PER_CYCLE = 8`; failed ones also cost a fee), replacing the planned `JANITOR_MAX_CLOSES_PER_CYCLE`; per-owner pause after a failure `JANITOR_RETRY_COOLDOWN_MS` (3 600 000, min. 60 000, in process memory); scan filtered on the server (`dataSize` 207 + discriminator + `exited` byte at offset 142, pin test).
- **Crank:** `candidatesFrom` drops a repeated `(Positions, market)`; `UserAccount`s read in pages of 100 (`getMultipleAccountsInfo` limit); each market chunk isolated.
- **Task 6 fix round (`1435fc2`):** a candidate-selection failure → every market ticks without candidates (`planTick`) and `lastTickAt` does not move (was: no market ticks); single retry and pair quarantine for `CRANK_BAD_PAIR_COOLDOWN_MS` (60 000, min. 5 000) only for a candidate whose tx landed and was rejected by the program; `/healthz.markets` built from the same `withSol` view.
- **Final review of plan 2 (fix wave, 01.10.2026, tests only):**
  - **C1:** `bootstrap()`/`bootstrapDevnet()` could not complete a clean start — `PoolLive` was delegated before `seed_pool`, while `SeedPool` takes `Pool` and `PoolLive` as program-owned `Account<…>` (delegated → Anchor 3007). Order now `init_pool` → `init_pool_live` → faucet + `seed_pool` → `delegate_pool_live` → `delegate_pool`, set by pure `poolBootstrapPlan` (`tests/er/lib/poolBootstrap.ts`, unit test); an uncompletable state errors before sending. Fixed by reading the Rust contexts, **not executed** on mb-stack or devnet.
  - **I1:** commit cycle (root → commit → janitor) separated from the tick loop (`createCycleRunner`, at most one in flight, loop waits for it on stop); janitor skips the pass while `fee_payer` < `JANITOR_MIN_FEE_PAYER_SOL` (0.002).
  - **I2:** `process.exit(1)` when `startCrank` fails; watchdog `CRANK_WATCHDOG_MS` (120 000, min. 30 000); `lastTickAt` no longer restored from Postgres; `freshBlockhash` gives up after 5 s.
  - **I3:** tick set = SOL + registry + the process's sticky markets + markets with open candidates (unknown → one read of the public `Market`); replaces the earlier `untickedMarkets` logging. Registry privacy gate remains for publication.
  - **I4, m1, m2:** one error classifier (`src/errors.ts`); a chunk rejected on-chain is first re-checked with a tick without candidates. **Fix round 2 (R1–R3)** narrowed it to three classes — *on-chain*, *shared* (401, network, 429, 5xx, `freshBlockhash timeout`), *market-local* (everything else incl. `confirmSignature timeout`); only shared stops the loop and reconnects, next loop starts after the stopping market (`rotateMarkets`, round-robin); market-local → one tick without candidates, then skipped until next loop; selection failure reconnects only on auth/network errors; janitor: shared → abort pass, on-chain → per-owner pause, rest → attempt without pause. Watchdog also exits when the commit cycle exceeds max(3 × `COMMIT_INTERVAL_MS`, 600 000 ms) (`cycleStuck`/`cycleDeadlineMs`).
  - **Fix round 3:** reconnect also when no market landed a tx and something failed not on-chain (`shouldReconnectAfterLoop`); janitor stops after 2 consecutive non-on-chain close failures; `cycleDeadlineMs` floor added; `healthcheckTimeout` in `railway.json` 30 → 180 s (new process returns 503 until its first own SOL tick).
  - **I5:** logs carry counts and tags `sha256(process salt ‖ key)[..8 hex]` instead of `Positions`/owner keys. Plus m3–m6, relayer account builders checked against the IDL (I7), `?market=SOL` via `withSol`.
- **Plan decisions:** clock-based commit; SOL always ticks; `disclosures` table kept; generator in `tools/idlgen`; `Positions` decoded only manually; builders checked by `ixAccounts.test.ts`.

### Superseded later
- The spec's "Not measured (devnet)" list for this plan is marked "[01.10.2026: see 'Measured (devnet, 01.10.2026)' below]" — measured by plan 4.
- "Open for plan 3" items (switch the app to `idl/`, History from the `Positions` ring, 6049/6050 error map, `/ws?markets=`) are marked done by plan 3 on 01.10.2026.

### Open at the end
- **Not measured (devnet):** everything from plan 1's list, plus size and CU of a real `crank_tick` with 12 pairs; reading `Positions` with the crank token via `getProgramAccounts` (and its volume as traders grow); reading permission-PDA owners by the market registry; 7 Postgres tests and migration `008` on a real DB; `08-undelegate` and liquidation detection in `05`/`13`; janitor and crank as a whole process (`startCrank`, `src/index.ts` untested — only pure decisions).
- **For plan 4 (rollout):** scheduled `crank_tick` for every market — SOL via `scripts/admin/schedule-eternal.ts` (`add-market` rejects `SOL`), others `add-market --schedule`; top up the new `FeeEscrow` (`scripts/admin/fund-fee-payer.ts`); rotate `tests/er/.keys/devnet-mint.json`; live DB `pool_snapshots`/`roots`/stored `lastTickAt`/`lastCommitAt` belong to the old program (`TRUNCATE` or new DB); Railway env `COMMIT_INTERVAL_TICKS=60` → `COMMIT_INTERVAL_MS=60000`, delete `COMMIT_MAX_ACTIONS`/`QUARANTINE_CYCLES`; no way to cancel a non-SOL market's scheduled crank (`cancel-crank.ts` knows only SOL); external uptime monitor (Railway calls `/healthz` only on deploy); fresh `bootstrap()` on mb-stack before deploy.
- **Gates for plan 4:** several scheduled cranks with one `taskContext = admin`; `ticks` table without retention (grows ×markets); candidate selection loads whole `Positions` (`dataSlice` follow-up); `CRANK_WATCHDOG_MS` does not scale with loop size; local `bootstrap()` does not create/delegate `BalancesRoot` (pre-existing; local root/commit fail); tick-failure log lines and `state.errors` contain tx signatures (whether TEE allows `getTransaction` to non-members unmeasured); JSON-RPC body errors (`"Invalid token"`, `"Node is unhealthy"`, `{"code":503,…}`) classified as market-local — check real TEE strings; `restartPolicyMaxRetries: 10` + exiting watchdogs → a recurring condition leaves the crank dead (`ALWAYS` or more retries); a local chunk error skips the market's remaining chunks until the next loop (covered by the scheduler path).

---

<a id="slots-app"></a>
## Position slots, plan 3: app (01.10.2026)

Source: `2026-10-01-week6-slots-app.md`; outcomes from `2026-09-18-dexxer-mvp-design.md` §2.9 "Implemented (app, 01.10.2026)".

### Goal

The mobile app works with the program of plans 1–2 (`Positions` slots, no disclosure, several markets): onboarding on two accounts, trading on the selected market, a position list, History from the history ring plus a local archive, exit. Ledger and commit-reveal removed, Receipt stays; the app consumes the canonical IDL and the new relayer API. Plan 4 (clean deploy, devnet measurements, APK) is separate; plan 3 runs nothing on devnet. Mandatory criteria: `tsc`, `expo lint`, `npm test` (baseline 103 tests).

### Plan in brief

Branch `positions-slots` (plan 2 head `b831466`, PR #11 open). Only `app/` changes (and `.github/workflows/ci.yml` in Task 1); program, relayer, `tests/er`, `idl/` untouched. Screens stay render-only over hooks; no decoder uses Anchor's Borsh coder at runtime (broken in Hermes).

Design facts fixed by the plan:
- `Positions` (zero-copy, 3184 B): disc 8 | owner 32 | slots 16×96 | history 16×96 | history_head u8 | history_len u8 | version u8 | bump u8 | _pad 4 | _reserved 64. `PositionSlot` 96 B: market 32 | size | entry | margin | liq_price | opened_slot | oi_notional | last_liq_sample (u64 ×7) | state u8 (0 Empty, 1 Open) | side u8 (0 Long, 1 Short) | liq_ticks u8 | _pad 5. `HistoryRecord` 96 B: market 32 | size | entry | exit u64 | pnl i64 | fees | opened_slot | closed_slot u64 | side u8 | reason u8 (0 user, 1 liquidated, 2 partial decrease) | _pad 6. Offsets = those pinned by the Rust test `offsets_match_the_off_chain_decoders`. `POSITIONS_DISC = [197,153,71,203,133,176,119,182]` (pinned against the IDL by a test).
- `UserAccount` (Borsh, no `nonce`): version | owner | session_key | session_expiry i64 | actions_left u32 | free_margin | locked_margin | last_withdraw_slot | exit_salt [32] | bump | exited bool | rent_payer | _reserved [32]; offsets `exit_salt` 117 → 109, `exited` 150 → 142, `rent_payer` 143. `Config` without `disclosure_delay_slots`: `CONFIG_FEE_PAYER_OFFSET` 210 → 202 (the old offset would silently read `magic_fee_vault`, hence a mandatory `Config` codec test). `Market` gains `last_print u64 | sample_seq u64` after `mark_slot` (later offsets shift by 16); `decodeMarket` returns `symbol` (NUL-trimmed).
- Instruction accounts: `init_user(exit_salt)` 6 (owner, payer, config, userAccount, positions, systemProgram); `delegate_user` 14 (2nd `payer`, 11th `positions`); `init_permissions`/`set_session` 9; `undelegate_user` 12 + markets as read-only `remaining_accounts` (≤16); trading (`open/close/increase/decrease_position`, `add_margin`) 12: signer, config, market, marketRisk, poolLive, userAccount, positions, feed, feeEscrow, taskContext (= positions), magicProgram, liqCrankSigner. `close_exited_user` is not called by the app (relayer janitor).
- Relayer API: `GET /markets` → `[{symbol, market, feed, params:{maxLevBps, imrBps, mmrBps, openFeeBps, closeFeeBps, liqFeeBps, oiCap, maxPosition, minSize, maxStalenessSecs, pausedOpen}}]` (u64 as decimal strings); `GET /mark?market=`, `GET /prices?tf=&limit=&market=`; `/ws?markets=SOL,BTC` or `*` (without the parameter only SOL `mark` frames); `/disclosures`, `/stats`, WS frame `disclosure` — 404/gone.
- PDAs: `pdas.positions(owner)` = `[b"positions", owner]`; `pdas.marketFor(symbol)` = `[b"market", symbolBytes(symbol)]` (1–8 bytes `A-Z0-9`, NUL-padded).
- Review Focus: (1) garbage/foreign layout in `Positions` → decoder throws, screen shows error, not "no positions"; (2) market without a slot; (3) 17th market and liquidatable increase (6049/6050 messages, Trade blocks opening at 16 open slots before sending); (4) History loses no records (archive keeps every seen record; partial decrease is its own record; order by `closed_slot` desc, no duplicates); (5) Exit with a position on another market (checklist looks at all slots); (6) silent extra keys — every built instruction checked against the IDL.

| Task | Content | Outcome (commits) |
|---|---|---|
| Task 1 | Canonical IDL, new-layout codecs, error map | Done (`618a96f`) |
| Task 2 | PDAs, onboarding on two accounts, state `Exited` | Done (`c363b20`, `fe4b52e`) |
| Task 3 | Account and exit (`exitMarkets`, `exitTx`) | Done (`42b1c3b`) |
| Task 4 | Markets from the relayer, picker, trading on the selected market's slot | Done (`06b2df9`, `5432ee3`) |
| Task 5 | Position list from slots | Done (`2e7f67a`, `01d0b2d`, `353c529`) |
| Task 6 | History from ring + on-device archive; Ledger and commit-reveal removed | Done (`a17c156`, `e14cdda`) |
| Task 7 | Final check, documents, smoke checklist | Done; `prettier` style commit `5d5fd82` |

### What was done

- **Task 1:** `app/src/lib/anchor.ts` and `errors.ts` import `../../../idl/dexxer_core.json`; the `app/src/idl/` copy deleted; `app/metro.config.js` adds `../idl` to `watchFolders`. Manual decoder `app/src/lib/positions.ts` (`decodePositions`: `slots` — only open ones, by index; history oldest first; `slotFor`, `historyKey` = `${market}:${openedSlot}:${closedSlot}:${size}:${reason}`). `codecs.ts`: `UserAccount` v3, `Config.fee_payer`, `Market.symbol`; `Position`/`ClosedRecord`/`DisclosureQueue`/`Disclosure` codecs and the commitment hash deleted. Error map: 6046 `UserExited`, 6049 `NoFreeSlot`, 6050 `PositionLiquidatable`.
- **Task 2:** `pdas.positions(owner)`, `pdas.marketFor(symbol)`; onboarding legs on `UserAccount` + `Positions`; state `Exited` (`isExitedOnL1`), on which `collectBatchLegs` returns `[]` (wait for the janitor instead of `init_user_reuse_queue`). Test helper `app/test/ixAccounts.test.ts`.
- **Task 3:** `exitMarkets` (SOL first, then open slots, then history from newest; no repeats, ≤16) → `remaining_accounts` of `undelegate_user` (`exitIx`/`exitTx`, `features/account/accountTx.ts`). `AccountScreen` reads `Positions` via `useLiveAccount`; the disclosure-debt line removed from `ExitSheet`.
- **Task 4:** `app/src/lib/markets.ts` (`useMarkets` → `GET /markets`, `parseMarkets`, `resolveSymbol`, `useSelectedMarket`), provider `app/src/lib/marketStore.tsx`, `MarketPicker`. `useMark(symbol)`/`useCandles(symbol, …)` with `?market=`; WS `…/ws?markets=*`, a `mark` frame patches only `QK.mark(frame.market)`. `TradeAccounts` 12 (`tradeAccountsFor(base, {market, feed})`, `taskContext = positions`, feed from the live `Market`). `closePosition` takes the side from this market's slot. 16-slot gate before sending (`slotGate`). `PositionScreen` and its route deleted.
- **Task 5:** `features/positions/positionRows.ts` (pure), `usePositionActions.ts`, `PositionsScreen` (one subscription to `Positions`, one to the active card's `Market`); loading, error, missing account and empty list are separate states.
- **Task 6:** History from the ring + archive (`features/history/historyArchive.ts` — pure `toArchived`/`mergeArchive`/`parseArchive`; `historyArchiveStore.ts` — AsyncStorage). Reasons `Closed`/`Liquidated`/`Partial close`. Deleted: `LedgerScreen`, `DisclosuresTab`, `RootTab`, the Ledger route, `hashStore.ts`, `useDisclosures`, `FEATURES.ledger`/`commitReveal`. Pool snapshot → `features/receipt/PoolSnapshotCard.tsx` in `AccountScreen` under Receipt.
- **Task 7:** `prettier` over 14 files (`5d5fd82`; three — `nonce.ts`, `pdas.ts`, `selfFund.ts` — were unformatted before plan 3); spec, `CLAUDE.md`, `docs/emulator-runbook.md` §6 smoke checklist, `app/README.md`.

### Measurements

| Item | Value |
|---|---|
| App tests (Node 24.18.0) | **137**, 137 passed, before and after the style commit (plan 2 baseline 103) |
| `tsc --noEmit`, `lint:check`, `format:check` | clean (`format:check` was not in the Tasks 1–6 gate; failed on 14 files, fixed by `5d5fd82`) |
| `npx expo export --platform android` | successful: 2566 modules, one `.hbc` bundle 9.5 MB; contains `close_exited_user`, none of `init_position_permission`, `init_user_reuse_queue` — first proof Metro resolves `../../../idl` via `watchFolders` |
| `grep "app/src/idl"` over `.github`, `services` | nothing |

Only `tsc`/`expo lint`/`node:test`/`prettier`/`expo export` were run — no device, emulator, wallet or devnet.

### Rulings and findings

- Plan decisions: (1) IDL imported from `idl/` directly, no sync script; (2) history archive in AsyncStorage `dexxer.history.<owner>`, record time `seenAt` (first seen by the app — `HistoryRecord` carries only ER slots), identity `historyKey`; (3) `Exited` onboarding state instead of `init_user_reuse_queue`; (4) market chosen globally (React context — zustand not a dependency), stored in AsyncStorage `dexxer.market`, unknown symbol after `/markets` loads → SOL; (5) `PositionScreen` and Ledger deleted.
- Controller rulings: (1) Task 2: `assertIxKeysMatchIdl(tx, expected)` compares **every** key against `{ix: {idlAccountName: PublicKey}}`, not the key count — anchor-ts resolves `pda`/`address` accounts itself, so a stale builder gives the same count; applied to onboarding legs, trading instructions, `undelegate_user`. (2) Task 4: Exit's `Positions` PDA derived only from the owner (`pdas.positions(owner)`), not the session (Exit/deposit/withdraw are owner-signed via MWA). (3) Task 5: the active card reads its own public `Market` by `slot.market` (feed, symbol, mark, mmr), so every slot is manageable without the registry; Close is one tap; submit disabled while no mark. (4) Task 5: deferred Close bound to `PendingClose {index, market}` (`shouldFireClose`/`isCloseStale`), stale one reset. (5) Task 6: an archive read error is never written back as empty (`getItem` failure propagated, write skipped). (6) User's decision: no final whole-branch review, only per-task reviews. (7) Task 7: one style commit for all 14 files.

### Superseded later

- "NOT verified" → plan 4 smoke on AVD with fakewallet: runbook §6 steps 1–7 PASS (1 — app and L1 logs; 2–7 — per the owner's report, the logs show only routes), 8–9 not done (see plan 4).
- App test count 137 → 140 after smoke fixes `c0d39db`/`b276769`.

### Open at the end

- Not executed in plan 3: two-account onboarding (leg sizes; three L1 legs + ER leg), the decoder on a real TEE account, `GET /markets`/`?market=`/`/ws?markets=*` against a live relayer, market selection persistence, non-SOL trading, position list, archive after restart, Exit with several markets, `Exited` → janitor → repeat onboarding.
- For plan 4: APK only after deploy (`bootstrapDevnet`, `add-market`, relayer). Without a session key `AccountScreen` does not read `Positions` (reads go through the session's TEE connection), so Exit cancels only the SOL task (program gates `open_count() == 0` anyway); same if Exit is tapped before `Positions` first loads. Archive is one unbounded AsyncStorage value (Android default ≈2 MB). Keep `format:check` in every task's gate.
- Deferred minors: *decoders* — `DecodedMarket.symbol`/NUL trimming untested in `marketLimits.test`; `formatUsd2` untested; unknown side/reason bytes silently become `Long`/`User`; the two TS copies of `positions.ts` (app vs `tests/er/lib`) are not pinned to each other; `isExitedOnL1` checks neither length (short `UserAccount` → `RangeError`) nor owner. *Tests* — `ixAccounts.test.ts` imported from other tests (self-test runs several times); `Config` fixture in the `Exited` test is `Buffer.alloc(8)`; no `exitMarkets` test with open slots + history > 16; `isSigner`/`isWritable` of the 12 `undelegate_user` keys not asserted; uncovered position-hook paths (unknown market, `mark == null`), Close on A then B in one batch, the history hook and corrupt archive JSON; `positionsList.test.ts` mid-file imports and redundant `void PublicKey`. *Onboarding* — on `Exited` confirm still calls `ensureRelayerSession`/`ensureNonceAccounts` first. *Markets/trading* — `SOL_FALLBACK` exported but unused; `MarketPicker` with a stored non-SOL symbol shows only `SOL` unhighlighted before `/markets`; late AsyncStorage read in `marketStore` can overwrite an early choice; `pausedOpen` only a badge, Open stays active (program rejects); `handleOpen`/`handleClose` silently return while `Market` loads; `TradeScreen` 252 lines, `TradeTicket` 247. *Positions* — `selectedIndex` not reset when a slot closes (stale `sheet`); fallback `mmrBps` 500; no selected-card visual state, nested `Pressable`s; unused `ready`; a deferred Close survives an open sheet and fires when `Market` arrives. *History* — storage access on every `Positions` byte change (should key by history fingerprint); same-`closedSlot` records sorted oldest first; `historyKey` can collide for two identical partial decreases in one ER slot (add pnl/entry/exit); `loadArchive` checks only `Array.isArray` (corrupt element → `BigInt(undefined)` in render); after a transient read error only the ring is shown.

---

<a id="slots-deploy"></a>
## Position slots, plan 4: clean devnet deploy and measurements (01.10.2026)

Source: `2026-10-01-week6-slots-deploy.md` (plan), `week6-results.md` (plan-4 part, up to "Graph C.5").

### Goal

The new `dexxer_core` (plans 1–3) lives on devnet-tee with five markets and scheduled cranks, the relayer on Railway serves it, an APK is built against it, and every "not measured" item of spec §2.9 gets a number or a recorded FAIL in `week6-results.md`.

### Plan in brief

Order: two no-cost gates (real feed `posted_slot`; fresh `bootstrap()` on mb-stack) → new program identity (keypair → `declare_id!` → IDL → deploy) → devnet bootstrap (`bootstrapDevnet` → `fund-fee-payer` → `add-market --schedule` ×4 → `schedule-eternal` SOL) → relayer (env, DB, `railway up`) → `tests/er/devnet` scenarios as measurements → APK + smoke with a live wallet → results. Every step that spends SOL, is irreversible or touches secrets is a user gate; the agent prepares commands and checks results.

- Task 1: feed gate, `tests/er/devnet/14-feed-prints.ts` (`npm run devnet:feedprints`; 90 s, poll 250 ms; `FEED-PRINTS PASS` iff every market has `repeats_posted_slot == 0` and `prints >= 10`; FAIL stops the plan before deploy as a #38 blocker) + mb-stack `bootstrap()` (`npm run q1`).
- Task 2: cancel the OLD SOL eternal crank before changing the id (`cancel-crank.ts` derives `task_id` from the current program id); new keypair (old → `keys/programs/dexxer_core-keypair.G2ok.json`); `declare_id!` in `lib.rs:18`, `Anchor.toml` lines 11/17; `cargo build-sbf` + `tools/idlgen`; deploy (payer needs >= 5.5 SOL; program-data rent estimated ≈4.61 SOL).
- Task 3: rotate `tests/er/.keys/devnet-mint.json` → `devnet-mint.G2ok.json`; `npm run devnet:bootstrap`; `fund-fee-payer` (0.2 SOL fixed); four `add-market --schedule`; SOL `schedule-eternal`; new `tests/er/devnet/15-marks.ts` (`npm run devnet:marks`; 60 s; `MARKS PASS` iff every market >= 30 ticks and `sample_seq_delta > 0`). Balance gates: admin `8L4EyWLc6yGH4c3zrVWLCoJqRbgWGtUf9sYyqnMPkVtH` >= 1.0 SOL, fee_payer `3HgDNwQPnHRRK6Sy5MXTN18zEYpGMJZioiGV3dD3Chnt` >= 0.3 SOL.
- Task 4: relayer tick line gains `bytes=` (`tx.serialize().length`); `railway.json` `restartPolicyType: "ALWAYS"` (watchdog `process.exit(1)` is deliberate; 10 retries would end in a dead crank); env cleanup (drop `COMMIT_INTERVAL_TICKS`/`COMMIT_MAX_ACTIONS`/`QUARANTINE_CYCLES`, add `COMMIT_INTERVAL_MS`, set `SIWS_DOMAIN`); DB `TRUNCATE pool_snapshots, roots; DELETE FROM relayer_meta` (keep `ticks`); `railway up`; endpoint checks.
- Task 5: `tests/er/devnet/16-multi-market.ts` (`devnet:multimarket`) + `10-set-params.ts --market SYM`; runs 01 → 02 → 03 → 05 → 13 → 11 → 16 → 07 → 08; every tx recorded as `ix | cu | bytes | sig`.
- Task 6: dev-client APK (no app code changes; IDL via `idl/`), smoke checklist `docs/emulator-runbook.md` §6 (9 steps) performed by the user; the agent never taps in the wallet.
- Task 7: `week6-results.md`, spec §2.9 "Measured (devnet)", `CLAUDE.md` section, `docs/deployments.md`, `README.md`; link check for `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`.

Fixed facts from the plan: branch `positions-slots` (plan-3 head `bfe5d59`, PR #11). Old program `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`; payer/upgrade authority `spikes/keys/payer.json` = `4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM`. Endpoints: base `https://rpc.magicblock.app/devnet`, TEE `https://devnet-tee.magicblock.app`, router `https://devnet-router.magicblock.app/`, validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, oracle `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`; Lazer feeds SOL `6`, BTC `1`, ETH `2`, HYPE `110`, ZEC `66`. Railway: project `dexxer` `2aac2416-043e-4845-8c19-8e1e2e862f4d`, env `production` `0a5d310b-fac2-40f9-88d1-630df862695a`, service `relayer` `c2581443-1fa1-46ce-bb08-8e95b1fd682f`, Postgres `8d0f27fb-6df7-4eeb-8086-790f4d4ef3c5`, domain `https://relayer-production-1ae7.up.railway.app`. User-only actions: SOL transfers, Railway secrets (`CRANK_KEY_B58`, `FEE_PAYER_KEY_B58`, `DATABASE_URL`, `SIWS_DOMAIN`), live-wallet smoke, closing the old program; irreversible steps (`solana program deploy`, `TRUNCATE` on live DB, `solana program close`) need an explicit "yes" each — `program close` is not executed in this plan. Review focus: feed gate failing; old scheduler tasks still burning the old `FeeEscrow`; partial bootstrap must be re-runnable; dead env and stale DB; liquidation of one market must not touch another; smoke without substitution.

### What was done

Status at end of 01.10.2026: plan executed fully except two smoke steps (deferred by the owner) and one irreversible owner decision.

| Task | Status | Evidence |
|---|---|---|
| 1 Feed gate (`posted_slot` on every print) | done | `FEED-PRINTS PASS`, 5 markets |
| 2 New program: keypair, `declare_id!`, IDL, deploy | done | `Fyg2…UfCY`, slot 506295949, bytes verified |
| 3 Devnet bootstrap: Config, pool, 5 markets, 5 cranks, `FeeEscrow` | done | bootstrap first try, `MARKS PASS` |
| 4 Relayer on Railway: code, env, DB, deploy, policy | done | `8b33d95d` → `5a070a7c`, `/healthz` ok, `ALWAYS`/180 s applied |
| 5 Scenarios and measurements (01, 02, 03, 05, 07, 08, 11, 13, 16) | done | all PASS; CU/cost/liquidations measured |
| 6 APK and wallet smoke | partial | steps 1–7 PASS, two defects fixed; **steps 8–9 not done** |
| 7 Docs | done | results file, spec §2.9, CLAUDE.md, deployments, runbook §6, README |
| Closing old program `G2ok…` | owner decision | irreversible, not executed |

Commits `d6a33e9..44b41bb` (14 after plan commit `d6a33e9`):

| Commit | What |
|---|---|
| `b1a1bb8` | `14-feed-prints.ts` feed gate (Task 1) |
| `60243f3` | new program id `Fyg2…UfCY`, `declare_id!`, IDL, `tests/er/lib/program.ts` default IDL → `idl/` (Task 2) |
| `c049e93` | devnet bootstrap, `15-marks.ts`, `docs/deployments.md` (Task 3) |
| `6e1492f` | relayer: `bytes=` in tick line, `railway.json` → `restartPolicyType: ALWAYS` (Task 4) |
| `44b8e88` | relayer docs; note on Railway trial block (Task 4) |
| `dbeccde` | `16-multi-market.ts`, `10-set-params.ts --market` (Task 5, part 1) |
| `253e8f2` | fix round 16: BTC param restore, strict relayer probe, `--cu-reader` (Task 5) |
| `39d0ed5` | relayer deploy on new program — facts in `docs/deployments.md` (Task 4) |
| `a756062` | docs: `railway.json` in repo != applied Railway policy; time to first tick (Task 4, fix round) |
| `c0d39db` | fix(app): market symbols decoded byte by byte — smoke defect #1 (Task 6) |
| `b276769` | fix(app): leverage slider and MAX capped by market `max_lev_bps` — smoke defect #2 (Task 6) |
| `018cc7f` | docs: results, spec §2.9 "Measured", CLAUDE.md, deployments, runbook §6, README (Task 6 docs + Task 7) |
| `f83e3e1` | docs: smoke evidence qualifiers, measurement attribution (doc-review fix round) |
| `44b41bb` | docs: `ALWAYS`/180 s applied on Railway directly; config-as-code deprecated |

Live on devnet (01.10.2026): program `Fyg2yJBoN97ScWxT37xBp2zaaiNncNqnGJ7PAbtnUfCY` (slot `506295949`), Config/pool/`FeeEscrow`/`BalancesRoot`, five markets (SOL, BTC, ETH, HYPE, ZEC) with five scheduled `crank_tick` (`i64::MAX`, 1000 ms), relayer on Railway (deployment `8b33d95d`, from ≈21:30 Kyiv time `5a070a7c` with `ALWAYS`/180 s, `COMMIT_INTERVAL_MS=300000`), dev-client APK on the new program. Old `G2ok…` **not closed**.

Tests at end of plan 4: app **140** (plan 3 — 137; `c0d39db` +1 → 138, `b276769` +2 → 140), relayer **244** (237 passed + 7 Postgres skipped), unit `dexxer_core` **69**, LiteSVM **89** — relayer/unit/LiteSVM from the Task 2 run (Node 24.18.0, `+nightly-2026-09-18`), app after Task 6 fixes. Postgres tests (`indexerDb.test.ts`) not run: no Docker. PR #11 updated to "plans 1–4 of 4". No final whole-branch review (owner decision since plan 3), per-task only.

### Measurements

#### Key measurements

| What | Value | Where |
|---|---|---|
| Real Pyth Lazer `posted_slot` | changes on **every** print: 5 markets × 47 prints / 90 s, 0 repeats, interval 1.7–2.5 s | Task 1 |
| Liquidation by scheduler only (`liquidation_check`, relayer crank off) | **8.5–10.2 s** (13: 9.0 s SOL; 16: BTC 8.9 / 8.7 / 8.5 / 10.2 s over four runs) | Task 5 |
| Liquidation by relayer (`crank_tick`) | **2.9 s** after `set_params` (05) | Task 5 |
| Relayer `crank_tick`, no candidates | `cu` 15 523…15 540, 383 B | Task 4 |
| `crank_tick` with 1 / 2 candidates | `cu` 21 428…21 445, 449 B / `cu` 28 820…30 088, 515 B (formula `383 + 66·n` confirmed) | Task 4, 5 |
| First SOL tick after container start | **6.7 s** | Task 4 |
| Full relayer loop over 5 markets | ≈3.3 s (market ticks sequential, ≈0.55 s each) | Task 4 |
| `commit_aggregate()` | **48 376 CU**, **200 000 lamports** from `FeeEscrow` to magic fee vault per commit | Task 5 (07) |
| Janitor: exit → accounts closed | ≈50 s (50.8 s in 16, ≈50 s in 08) at `COMMIT_INTERVAL_MS=60000` | Task 5 |
| Rent on devnet | `Positions` **16 832 224** lamports, `UserAccount` **1 709 064** (LiteSVM formula gives 23 051 520 / 2 331 600) | Task 5 |
| Onboarding from the app (sponsored, nonce + 2 CB) | L1 795 / 812 / 765 B, ER leg 506 B | Task 6 |

#### Task 1 / M-slots-gate: `14-feed-prints.ts` — PASS

01.10.2026 13:44:31–13:46:02 UTC, 90 s, poll every 250 ms, feed read without token on devnet-tee.

| Symbol | Prints | Distinct `posted_slot` | Repeats | Min gap, ms | Max gap, ms |
|---|---|---|---|---|---|
| SOL | 47 | 47 | 0 | 1707 | 2496 |
| BTC | 47 | 47 | 0 | 1700 | 2422 |
| ETH | 47 | 47 | 0 | 1699 | 2412 |
| HYPE | 47 | 47 | 0 | 1699 | 2447 |
| ZEC | 47 | 47 | 0 | 1697 | 2450 |

Gaps over 2 s are the feed's normal cadence, not failures. The #38 mechanism (`sample_seq` grows only on a new `posted_slot`) yields a sample on every print on the real feed. Not done: mb-stack `bootstrap()` (Step 3) — no `mb-stack` binary on the machine; the first real run of the C1 pool order became the devnet bootstrap in Task 3. Open after Task 1: 90 s sample only; long-term feed cadence stability not measured.

#### Task 2: new program identity, build, IDL, deploy

| What | Value |
|---|---|
| Old program's SOL eternal crank | cancelled via `cancel_crank`, `task_id -8632762600545312817`, sig `55pfC2ES…cQmi`. The tx does not prove the task was alive (cancel of unknown id is a no-op), but the id matches the documented one |
| New program id | `Fyg2yJBoN97ScWxT37xBp2zaaiNncNqnGJ7PAbtnUfCY`; old keypair → `keys/programs/dexxer_core-keypair.G2ok.json` (gitignored) |
| `program_autofixer` on `lib.rs` | 0 findings |
| `.so` | 1 107 440 B, sha256 `ebeed3b1…440692f`; new id ×1 in `.so`, old ×0 |
| `idl/dexxer_core.json` | new id ×7, old ×0, 40 instructions; diff 247 lines because 8 PDA seeds contain the program id as a constant |
| Tests | relayer 244 (237 + 7 skipped), app 137, unit 69, LiteSVM 89, `tsc` `tests/er` clean |
| Deploy | sig `4PQfpkUg…RUWM`, slot **506295949**, ProgramData `6AVVm2ZM…hok1Q` (5.62667404 SOL rent), authority `4P1WD9…MGMM`, Data Length 1 107 440 B |
| Byte check | `solana program dump` to a file + `cmp` with `target/deploy/dexxer_core.so` — **identical** |
| payer `4P1WD9` | 6.938610579 → 1.305608419 SOL (≈5.633 SOL) |

Open after Task 2: old program's `liquidation_check` tasks cannot be cancelled; they tick while the old `FeeEscrow` lives — an argument for `solana program close G2ok…` (owner decision).

#### Task 3 / M-slots-MARKS: bootstrap, markets, cranks

Bootstrap PASS first try: `init_pool → init_pool_live → seed_pool → delegate_pool_live → delegate_pool` without Anchor 3007 — **C1 order from plan 2's final review confirmed on the live network**. New dUSDC mint `UU1BFV3G…mvHR6`. Sigs: `init_config` `5h6iYWRf…`, `seed_pool` `4FGxB3JB…`, `delegate_pool` `ZVELyUCn…`, `init_market_permissions` `5taHtfBH…` (`marketRisk`/`poolLive` permissioned = true), `fund-fee-payer` `eCigiqHW…` (0.2 SOL into `FeeEscrow`, ER balance 200 701 040). PDA addresses — `docs/deployments.md` "Program / PDA".

| Symbol | Lazer feed id | Crank `task_id` | `schedule_crank` |
|---|---|---|---|
| SOL | 6 | `6355626329445645097` (`schedule-eternal.ts`) | `4ubUU8pu…` |
| BTC | 1 | `9088409262532617907` | `2cYKSjap…` |
| ETH | 2 | `-5077243792603821260` | `aWR6QB3g…` |
| HYPE | 110 | `-4085983205633519634` | `pmJFJncd…` |
| ZEC | 66 | `-3261127409136503701` | `44WDyGgQ…` |

`SCHEDULE-ETERNAL PASS`: 11 samples of `Market.mark_slot` in 60 s, 11 distinct slots. `Config.scheduler_signer` already equalled `crank_signer_pda(admin)`, so `set_scheduler_signer` was not needed.

M-slots-MARKS (`15-marks.ts`) — PASS, 60 s, one read of all five `Market` per second (14:11:40–14:12:40 UTC):

| Symbol | Ticks (`mark_slot`) | `last_print` changes | `sample_seq` delta |
|---|---|---|---|
| SOL | 59 | 59 | 59 |
| BTC | 58 | 58 | 58 |
| ETH | 59 | 59 | 59 |
| HYPE | 59 | 59 | 59 |
| ZEC | 58 | 58 | 58 |

Several scheduled `crank_tick` with one `taskContext = admin` coexist and tick simultaneously ≈1/s; plan-2 gate closed; `sample_seq_delta == ticks` on every market (each tick accepted a new print).

| Admin `8L4E…` balance | SOL |
|---|---|
| before (after owner top-up +0.7, `3RWYHfHk…`) | 1.5006478 |
| after bootstrap | 1.4424852 |
| after `fund-fee-payer` | 1.2421802 |
| after 4 markets + SOL crank | 1.1937320 |

Total ≈0.3069 SOL (bootstrap 0.0582, `FeeEscrow` 0.2003, markets and crank 0.0484). `fee_payer` (after owner top-up +0.5, `4sicKSf3…`) 0.504802688 SOL, unused by bootstrap. Open after Task 3: no way to cancel a non-SOL market's scheduled `crank_tick` (`cancel-crank.ts` knows only SOL).

#### Task 4: relayer on the new program

Block: the Railway trial had expired — all relayer deployments REMOVED since 25.09, Postgres since 22.09; no live relayer since 25.09. `railway redeploy --service Postgres --from-source` → `Your trial has expired`. Owner paid; Postgres restored with `railway redeploy --service Postgres --from-source -y` (deployments `7b896600`, `788c3daa` SUCCESS 16:38–16:39 UTC; image `postgres-ssl:18` by tag, same volume).

| What | Value |
|---|---|
| Env before | `COMMIT_INTERVAL_TICKS=60`, `COMMIT_MAX_ACTIONS=4`, no `SIWS_DOMAIN`, no `COMMIT_INTERVAL_MS` |
| Env after | `COMMIT_INTERVAL_MS=60000` (for measurements; later **300000**), `SIWS_DOMAIN=relayer-production-1ae7.up.railway.app`; `COMMIT_INTERVAL_TICKS`/`COMMIT_MAX_ACTIONS` removed; `QUARANTINE_CYCLES` was not set |
| DB, variant A (owner decision), 16:40:48 UTC | `TRUNCATE pool_snapshots, roots; DELETE FROM relayer_meta`: 927 → 0, 908 → 0, 2 → 0; `ticks` 654 676 kept |
| Deploy | `railway up --service relayer --ci` from tree `253e8f2` → deployment **`8b33d95d`** SUCCESS; migrations 006/007/008 applied (008 ≈0.6 s on 654 676 rows) |
| First SOL tick | **6.7 s** after container start (16:41:59.6 → 16:42:06.3 UTC) |
| Checks | `/healthz` ok, 5 markets with fresh `lastTickAt`; `/markets` 5 symbols; `/mark?market=BTC` `stale:false`; `/disclosures`, `/stats` → 404; `/pool/latest` new pool (capital 11 000, liquidity 9 900, locked 100 dUSDC) |
| First commit cycle | `root: filled=5`, `commit_aggregate` (success not logged, visible from `lastCommitAt`), janitor `scanned=4 closed=4 errors=0` — four exited traders of the new program from early Task 5 runs |
| TEE error lines | none in ≈3 min (only `bigint: Failed to load bindings`) |

Relayer `crank_tick` per market (first 34 ticks each):

| Market | `cu` | `bytes` | `tick_ms` | `candidates` |
|---|---|---|---|---|
| SOL | 21 428…21 445 | 449 | 551…936 | 1 |
| BTC | 15 528…15 540 | 383 | 550…943 | 0 |
| ETH | 15 523…15 540 | 383 | 550…561 | 0 |
| HYPE | 15 523…15 540 | 383 | 551…561 | 0 |
| ZEC | 15 523…15 540 | 383 | 550…565 | 0 |

Full loop ≈3.3 s (27 loops in 89 s); `intervalMs: 1000` is a pause between loops, not market cadence.

Railway ignores `services/relayer/railway.json`: deployment had `fileServiceManifest: {}`, `serviceManifest` `restartPolicyType: ON_FAILURE`, `restartPolicyMaxRetries: 10`, `healthcheckTimeout: 30` (log `Retry window: 30s`). Policy applied the same evening (controller, ≈21:30 Kyiv): Railway deprecated config-as-code (`railway.json`/`railway.toml`) in favour of `.railway/railway.ts` — `update-service` with `railwayConfigFile` was rejected with exactly that message, so `railway.json` stays documentation of intended values. Set directly via Railway MCP `update-service`: `restartPolicyType = ALWAYS`, `healthcheckTimeout = 180`; `get-service-config` after: `healthcheckTimeout: 180, restartPolicyType: "ALWAYS"`. MCP `redeploy` (deployment `3d1ccce7`) failed at BUILD_IMAGE (`Railpack failed to prepare the build`) — a `railway up` deployment has no source repo to rebuild; live deployment untouched. Fresh `railway up --service relayer --ci` → **`5a070a7c` SUCCESS** (21:30:23 Kyiv), `/healthz` ok, `commitIntervalMs 300000`, 5 markets. Between `8b33d95d` and `5a070a7c` the live policy was `ON_FAILURE` × 10 / 30 s.

`COMMIT_INTERVAL_MS` returned to 300000 (controller ruling after Task 5): a commit costs 200 000 lamports (M-slots-B), so at 60 s `FeeEscrow` would empty in ≈16 h; `/healthz` at 18:04 UTC: `commitIntervalMs: 300000`.

Open after Task 4: move service settings into `.railway/railway.ts`; successful `commit_aggregate` writes no log line (failure only); market ticks sequential, loop grows linearly with markets and `CRANK_WATCHDOG_MS` (120 s) does not scale with it; Postgres tests not run (no Docker), migration 008 verified only by deploy log.

#### Task 5: devnet scenarios and measurements

Two sessions: part 1 (14:40–16:00 UTC) without relayer (Railway still blocked); part 2 (16:48–17:16 UTC) relayer live, `COMMIT_INTERVAL_MS=60000`. Raw logs in the session scratchpad, not in git.

CU in TEE is visible only to permission members: for a tx writing a permissioned account, devnet-tee `getTransaction` returns non-members a stub (message 102 B, `computeUnitsConsumed: 0`, no logs). The sender (owner/session) is not a member of `PoolLive`/`MarketRisk` (`[crank, admin]`), so sees the stub for its own trades; crank and admin tokens see full meta. For `credit_deposit`/`withdraw` the meta is empty **for every** token (probable cause, not verified: they also write eSPL accounts whose permission includes neither crank nor admin). Trading CU below were re-read with the crank token (`--cu-reader crank`).

#### M-slots-A: `01-onboard-private.ts` — PASS (second attempt)

First attempt: L1 `init_user` → `TransactionExpiredTimeoutError`, sig never reached the cluster; Anchor `.rpc()` does not retry a lost tx, trader `FVfD8Xc3…` left with faucet only (0.05 SOL). Second attempt: owner `FNnwSCpZ…`, open SOL 1.0 @ 117.62; on base `UserAccount` 207 B and `Positions` 3184 B under the Delegation Program.

| Leg (self-funded script, no nonce/CB) | Network | `bytes` | `cu` |
|---|---|---|---|
| `faucet_init` | L1 | 418 | 23 683…28 183 |
| `init_user` | L1 | 343 | 18 741…23 241 |
| `delegateSpl` | L1 | 590 | 30 436…45 436 |
| `delegate_user` | L1 | 543 | 91 236…100 236 |
| `credit_deposit` | ER | 384 | not measurable |
| `init_permissions` | ER | 442 | 29 130…41 130 |
| `set_session` | ER | 486 | 28 210…34 210 |

CU ranges over run 01 and three runs of 16; L1 figures depend on PDA bumps of random keys, as in LiteSVM. App-shaped (sponsored, nonce + 2 CB) sizes — Task 6.

`Positions` privacy, `02-leak-test.ts` — PASS (6/6): base owner is the Delegation Program, 3184 B unchanged vs snapshot; no token and foreign token → `null`; session and crank see 3184 B; owner sees open SOL slot #0.

#### M-slots-B: `03-commit-cycle.ts` + `07-balances-root.ts` — PASS

| What | Value |
|---|---|
| 03, part 1: 12 × `commit_aggregate()` | all 12 landed in ER; 11/12 on base within 60 s; the first took ≈70 s, so the script counted it FAIL (poll window too short) |
| `FeeEscrow` in ER during part 1 | **0** lamports delta on all 12 commits and hours of relayer commits |
| 07, part 2: 12 × commit | 12/12 OK, **−200 000 lamports each** (`BdfNhXM9…` → magic fee vault `EUJssY6k…`), tx `fee` 0, `fee_payer` 0 |
| Commit CU | **48 376** (meta of commit #1, admin token; `ScheduleCommit … ID: 128605`) |
| Debit cadence (poll every 2 s, 16:58–17:11) | −200 000 every ≈61 s, 1–2 s after each relayer `root: filled=…` |
| `BalancesRoot` | cycle #1 `5bF6o8iB…` filled=3, base `root_slot` == ER `root_slot`; cycle #2 `26mPqVAo…` — 64/64 leaves changed |

Why part 1 saw 0 and part 2 200 000 — not verified; most likely a free commit quota on the escrow (week 2 measured "0 lamports below nonce 25"), now exhausted. Reserve: 191 301 040 lamports in `FeeEscrow` (18:04 UTC) / 200 000 ≈ 956 commits ≈3.3 days at 300 s (live), ≈16 h at 60 s.

#### M-slots-C: `05-crank-liquidation.ts` — PASS (relayer)

Owner `FDaVm7vw…`, open SOL 1.0 @ 117.27 ≈9.1× (`CQDF7xED…`), forced `set_params(mmr 9500, imr 9600)` (`5PcxGDF1…`). **Liquidated 2.9 s** after `set_params`.

| Relayer tick line | `cu` | `bytes` | `candidates` | `liquidated` |
|---|---|---|---|---|
| `n=126 market=SOL` (`liq_ticks` 0 → 1) | 28 820 | 515 | 2 | 0 |
| `n=127 market=SOL`, sig `2FAZtKoE…AoZCh` | 30 088 | 515 | 2 | 1 |

Two candidates, not one: trader 01 also had an open SOL slot. History record `reason: liquidated`; params restored (`42fJj9iC…`, `match original: true`).

#### M-slots-D (M-G′): `13-liquidation-check.ts` — PASS (scheduler only)

`CRANK_ENABLED=false` via railway (`/healthz`: `crankEnabled:false, schedulerActive:true, tick:0`). Owner `Ar6ZN63m…`, open `3p3XF8RR…`, `set_params` `dQ6qumVB…`. **Liquidated in 9.0 s**, `liq_ticks [0,1,1]` → closed; script restored `CRANK_ENABLED=true`. Side effect: forced SOL params hit every position on the shared market, so trader 01's own `liquidation_check` liquidated its SOL slot (meant for 08) — an inference, not direct observation: the slot was open at `candidates=2` in 05, and the SOL tick in 16 at 16:54:52 already had 1 candidate.

Task registration, `11-liq-task-migration.ts` — PASS: owner `BNi2z3ed…`; `open_position` accepted with `task_context == positions`, `close_position` cancels the live task, `undelegate_user` cancels an unknown id (no-op); no `ExternalAccountDataModified` on zero-copy `Positions` (first data point for M-slots-F).

#### M-slots-E: `16-multi-market.ts` — PASS (four runs)

One trader, slots #0 SOL and #1 BTC on one `Positions`, two `liquidation_check` tasks with different `task_id` (run 2: SOL −5426448393446346208, BTC −7784038026803801695). `decrease_position` SOL by half → `history.at(-1).reason = decrease` (2), slot stays open. Forced liquidation of **BTC only** by the scheduler: SOL `liq_ticks` 0 on every poll.

| Run | Owner | BTC liquidation | BTC `liq_ticks` tail |
|---|---|---|---|
| part 1, run 1 (`--no-janitor`) | `3syiR7JH…` | 8.9 s | 0→1→1→closed |
| part 1, run 2 | `B4EBrKKS…` | 8.7 s | 0→1→1→closed |
| fix round, `--cu-reader crank` | `BhGw7DNf…` | 8.5 s | 0→1→1→closed |
| part 2, with janitor, `RELAYER_TOGGLE=1` | `5HVddUMF…` | 10.2 s | 0→1→1→closed (`sample_seq` 10113→10120) |

Trading instructions in ER (crank token):

| Instruction | `cu` | `bytes` |
|---|---|---|
| `open_position` SOL / BTC | 42 887…42 889 / 42 986 | 534 |
| `increase_position` | 29 758…29 759 | 533 |
| `add_margin` | 25 513 | 517 |
| `decrease_position` (half) | 28 307 | 525 |
| `close_position` | 28 635 | 517 |
| `undelegate_user` [SOL, BTC] | 68 140…75 640 | 607 |
| `set_params` | 7 635 | 303 |
| `credit_deposit` | not measurable (empty meta for all tokens) | 384 |
| `withdraw` | not measurable (empty meta for all tokens) | 549 |
| L1 `create ATA` (idempotent) | 13 417 | 304 |
| L1 `close_exited_user` (janitor) | 9 143 | — |

`open_position` in ER ≈42.9k vs 27 857 in LiteSVM; hypothesis (not decomposed): CPIs to the scheduler and Permission Program cost more in a real ER.

Exit and janitor (part 2): `undelegate_user` [SOL, BTC] `5kfACEuc…`, no `ExternalAccountDataModified`; on base `UserAccount` 207 B with `exited=1` and `Positions` 3184 B, both under the program. Janitor `16:55:54 janitor: closed 5HVddUMF… rent_payer=5HVddUMF… sig=hPgnyS4d…`, accounts gone **50.8 s** after exit check. `UserAccount` 1 709 064 → 0, `Positions` 16 832 224 → 0, `rent_payer` +18 541 288, `fee_payer` −5 000. `init_user` debited the owner exactly 18 546 288 (rent + 5 000 fee) — **rent is returned in full**.

#### M-slots-F: `08-undelegate.ts` — PASS

Trader 01 `FNnwSCpZ…`; SOL slot already closed (liquidated during 13), so no close sent. `withdraw` 998 222 345 (`5aLh2YDa…`), `undelegate_user` `61opTZjV…` (markets: SOL): **no `ExternalAccountDataModified`**, base owner changed within 4.4 s. Scrub verified: `session_key`/`exit_salt`/`last_withdraw_slot` zero, `Positions` bytes [40, 3112) zero. Janitor `2w3FL4av…` at 17:15:17, ≈50 s after exit; rent +18 541 288 to the owner. Gate on automatic `exit()` of zero-copy `Positions` closed (also by 11 and 16).

#### Task 5 additional measurements and balances

| What | Value |
|---|---|
| 10 min idle after exit of 16 (16:55:17 → 17:05:05) | `FeeEscrow` −1 800 000 = 9 commits × 200 000; no other deltas: cost of two tasks over an exited account **not visible** at 2 s / 1 lamport resolution |
| Max `candidates=` over all runs | 2; `crank_tick` with 12 pairs not measured (too few traders) |
| Relayer log over 40 min | no reconnect, watchdog or TEE error lines (`Invalid token`, 503); 3 × `Starting Container`, all from `CRANK_ENABLED` toggles (13 and 16) |
| `/healthz` at 17:16 UTC | `ok:true, crankEnabled:true, tick:409`, `tickAge` of all 5 markets 1.5 s, `feePayerSol 0.50477`, `crankSol 0.1` |
| Clean state after runs | SOL mmr 500 / imr 1000 / hysteresis 2 / staleness 2; BTC mmr 500 / imr 1000 / min_size 20 000 / staleness 15 (verified); traders 16 and 01 exited and closed; 05 `FDaVm7vw…` and 13 `Ar6ZN63m…` — no positions, margin in ER, not exited |

| Moment (lamports) | admin L1 | `fee_payer` L1 | `FeeEscrow` ER | `FeeEscrow` base |
|---|---|---|---|---|
| start part 1 (14:40Z) | 1 193 732 040 | 504 802 688 | 200 701 040 | 701 040 |
| end part 1 (after fix round) | 843 697 040 | 504 802 688 | 200 701 040 | 701 040 |
| start part 2 (16:48Z) | 843 697 040 | 504 782 688 | 200 701 040 | 701 040 |
| end part 2 (17:16Z) | 693 682 040 | 504 772 688 | 193 901 040 | 701 040 |

Admin −0.50 SOL: ten fresh traders × 0.05 SOL (01 ×2, 11, four PASS runs of 16, one 16 attempt that died on an ATA-creation race, 05, 13). `fee_payer` −30 000: six janitor closes × 5 000 (4 in the first deploy cycle, 2 in part 2).

Open after Task 5: abandoned devnet identities `FVfD8Xc3…` (faucet only) and `GXQ83pzK…` (ATA race), 0.05 SOL each; L1 `.rpc()` without retry of a lost tx in 01/05/11 (16 has a retry); 03's base poll window (60 s) shorter than first-commit latency (≈70 s); failure/retry branch of param restore in 16 untested (no fault injection on devnet); `crank_tick` with 12 pairs; task survival across TEE restart; CU of `credit_deposit`/`withdraw` in ER.

#### Task 6: APK on the new program and wallet smoke

| What | Value |
|---|---|
| Build | `npm run android -- --no-bundler`, incremental, `BUILD SUCCESSFUL in 55s` |
| APK | `app/android/app/build/outputs/apk/debug/app-debug.apk`, 110 870 032 B, sha256 `4178ed2223f56777a6766f8cdf60a558eb35d3cc7890a98840fd4c464137e531` |
| Signing cert (SHA-256) | `FA:C6:17:45:DC:09:…:03:3B:9C` — **matches** relayer default (`services/relayer/src/assetlinks.ts`) and live `/.well-known/assetlinks.json` |
| Metro bundle | new program id ×7, old ×0 |
| Environment | AVD `local_phone` (fakewallet), proxy `scripts/emu-proxy.cjs`, Metro `--dev-client` |
| Owner (fakewallet) | `2TQerBRHvjxR3hGbSqGaSKZWBhbiB7mRfEWCeVeEFgWi` |

The owner ran the smoke; the agent did not tap wallet buttons. Steps 1–7 PASS per the owner's report, L1 signatures checked via public RPC; full table in `docs/emulator-runbook.md` §6.

| Step | Result |
|---|---|
| 1 Onboarding on two accounts | PASS. `selfFund: owner has 0 lamports → sponsored`; legs `faucet+init_user` 795 B, `delegate_spl` 812 B, `delegate_user` 765 B (all `+advance+2 CB`, `feePayer` = `fee_payer`), ER `permissions+session` 506 B (`feePayer` = owner). Three L1 tx at 20:35:10–12 Kyiv = 17:35 UTC (`NtRjGqL7…`, `3cCf6rVL…`, `36BWmyeX…`), then deposit `2YRYNrwZ…` at 20:35:26 via durable nonce `8HijrvhF…` |
| 2 Market selection and persistence | PASS |
| 3 Open on SOL and BTC | PASS after defect #1 fix |
| 4 Position list | PASS |
| 5 Partial decrease → `Partial close` | PASS |
| 6 Close → `Closed` | PASS |
| 7 History archive after restart | PASS |
| 8 Exit with two markets | **not done** (owner deferred) |
| 9 Re-onboarding after janitor | **not done** (owner deferred) |

Defect #1 (fixed `c0d39db`): Open silently did nothing on any market. In Hermes `Buffer.subarray().toString()` returns `"83,79,76,0,0,0,0,0"` instead of `"SOL"`, so `decodeMarket.symbol` never matched, market/accounts stayed `null`, `handleOpen` returned silently. Found with a temporary DEBUG log (reverted, not committed). Fix decodes bytes by hand (`pdas.ts`, `codecs.ts`), regression test on a plain `Uint8Array`. Applied by JS reload at 20:46; steps 3–7 ran on that bundle; no new APK build after the fix.

Defect #2 (fixed `b276769`): HYPE, Open Short 7× → toast `insufficient margin (6010)`. `LeverageSlider` hardcoded 1–10× and ignored the market's `max_lev_bps` (HYPE/ZEC 5×; before plan 3 all markets had 10×); the program behaved correctly. Fix: `MarketParams.maxLeverage`, slider `max`, clamp at render, `impliedLeverage(ntl, free, maxLev)`, `clampLeverage` + tests. JS reloaded at 20:58; **not re-checked on device**.

Open after Task 6: steps 8 and 9 from the app; both fixes without re-smoke on a fresh APK; app ER actions (open/decrease/close/add margin/exit) write no signature to logcat and Trade/Positions failures show only as toasts — evidence for steps 3–6 is screenshots, Exit `remaining_accounts` not verifiable from logs; Phantom (`phantom_phone`) not run on the new program.

#### Task 7: docs — done

Commits `018cc7f`, `f83e3e1`, `44b41bb`: results file; spec §2.9 "Measured (devnet, 01.10.2026)" with pointers on closed "Not measured"/"Open for plan 4" items; `CLAUDE.md` section "position slots, devnet measurements (01.10.2026)", a "Documents" line and `[Obsolete since 01.10.2026: …]` markers; `docs/deployments.md` (final state, APK, env, Railway policy); `docs/emulator-runbook.md` §6; `README.md`. Doc review: no invented number; after the fix round smoke steps 2–7 marked "per owner's report", measurements attributed to the token they were read with.

#### Cost of devnet

| Wallet | Before | After | Delta | What |
|---|---|---|---|---|
| payer `4P1WD9…MGMM` | 6.938610579 | 1.305608419 → +6 (owner, `38NYtGvW…`) → **7.305608419** (18:04 UTC) | −5.633002160 | deploy; of which 5.62667404 is ProgramData rent of the new program |
| admin `8L4E…kVtH` | 0.80 → +0.7 (owner) = 1.5006478 | **0.693682040** (18:04 UTC) | −0.806965760 | bootstrap and markets 0.3069 (0.2003 of it in `FeeEscrow`), 10 traders × 0.05 |
| `fee_payer` `3HgD…3Chnt` | 0.0048 → +0.5 (owner) = 0.504802688 | **0.475688640** (18:04 UTC) | −0.029114048 | 6 janitor closes × 5 000 lamports; rest after 17:16 UTC, most likely sponsored onboarding and smoke deposit (rent of two accounts, nonce accounts); not broken down |
| `FeeEscrow` ER `BdfN…w8vs` | 200 701 040 lamports | **191 301 040** (18:04 UTC) | −9 400 000 | computed: 9 400 000 / 200 000 = 47 commits (step deltas observed only until 17:11 UTC) |
| crank `2w7X…ZerFA` | 0.1 | 0.1 | 0 | — |

Owner top-ups for the plan: payer +6, admin +0.7, `fee_payer` +0.5 SOL. Spent (excluding program rent, returned only by `program close`) ≈0.65 SOL: admin ≈0.62 (0.807 minus ≈0.19 still in `FeeEscrow`; includes 0.0094 of `FeeEscrow` commit debits and ≈0.5 to traders — part of whose rent returned to the traders themselves), `fee_payer` ≈0.03, deploy fee ≈0.006. Another ≈0.191 SOL is prepaid commits in `FeeEscrow`, not spent. Rent of old `G2ok…` (≈4.6 SOL by the plan's estimate) locked until it is closed.

### Rulings and findings

- Default `DEXXER_IDL_DIR` in `tests/er/lib/program.ts` (`target/idl`) was stale and `program.ts` failed on `Positions`; ruling: default is canonical `<repo>/idl` (changed in Task 2, `60243f3`).
- The permission classifier (auto mode) blocks `solana program deploy` ("Production Deploy") for both executor and controller; the owner deployed via `!` in the session; the block was not bypassed.
- `solana program dump <id> -` treats `-` as a file name, not stdout: `dump <id> - | sha256sum` hashes empty output; compare via a dumped file + `cmp`.
- Five cranks, not six as the brief said (four non-SOL markets).
- C1 pool-bootstrap order (plan 2 final review) confirmed on devnet; mb-stack run impossible (no binary).
- CU in TEE visible only to permission members; trading CU must be read with crank or admin token; `credit_deposit`/`withdraw` meta empty for every token.
- `commit_aggregate()` costs 200 000 lamports from `FeeEscrow` (first hours 0 — likely free quota, unverified) → controller ruling `COMMIT_INTERVAL_MS=300000`.
- Railway does not read `services/relayer/railway.json`; config-as-code deprecated in favour of `.railway/railway.ts`; policy set via MCP `update-service`; redeploy only via `railway up` (MCP `redeploy` fails on a `railway up` deployment).
- Railway trial silently expired (relayer down since 25.09) — external uptime monitor needed.
- Forcing params on a shared market liquidates every trader on it (13 took trader 01) — run deliberately.
- Anchor `.rpc()` on L1 does not retry a lost tx (`TransactionExpiredTimeoutError` in 01).
- `undelegate_user` on zero-copy `Positions` has no `ExternalAccountDataModified` (11, 16, 08): automatic `exit()` suffices for `Positions`; explicit only for `user_account`.
- Devnet rent is ≈27 % below the LiteSVM formula; janitor returns it in full to `rent_payer` ≈50 s after exit (60 s cycle).
- Two `liquidation_check` tasks of one trader on one `Positions` are independent (only BTC liquidated, SOL untouched).
- Hermes: `Buffer.subarray().toString()` is not a string — decode symbol bytes manually (`c0d39db`); UI leverage capped by market `max_lev_bps` (`b276769`).

### Superseded later

- `COMMIT_INTERVAL_MS=60000` set in Task 4 was returned to `300000` after Task 5 (commit cost).
- `services/relayer/railway.json` `ALWAYS` never took effect; the policy was applied directly to the service (`5a070a7c`).
- Retention of the `ticks` table (open after plan 4) — closed by C.5 on 02.10: `TICKS_RETENTION_MS`, first pass deleted 210 426 ticks.
- Postgres skipped count grew to 14 after C.5 (migrations 009/010 also verified only by deploy).
- Conditional orders (PR #14) and Token information (PR #15), 04.10.2026: merged to `main` and **deployed to devnet the same day** (program slot `507294602`, relayer deployment `58089680`); see the section "Devnet deploy and smoke, 04.10.2026".

### Open at the end

#### Open after plan 4

- **Irreversible owner decisions:** `solana program close G2ok…` (returns old program rent; old scheduler tasks die with it). Separately, not irreversible: move Railway service settings into `.railway/railway.ts` (`ALWAYS` / 180 s already applied directly, `5a070a7c`).
- **Smoke 8–9** from the app, re-smoke of both fixes on a fresh APK, Phantom.
- **Not measured:** task survival across TEE restart; `crank_tick` with 12 pairs (size and CU); CU of `credit_deposit`/`withdraw` in ER; `ComputeBudget` 1.4M in ER; real TEE error lines for the classifier (none in ≈40 min).
- **Relayer:** `dataSlice` for candidate selection (whole `Positions` loaded now); ~~`ticks` retention~~ (closed by C.5); external uptime monitor on `/healthz`; success log line for commit; `CRANK_WATCHDOG_MS` vs loop length (≈3.3 s on 5 markets, grows with markets); cancelling a non-SOL market's scheduled crank; `FeeEscrow` top-up (≈3.3 days of reserve at 300 s).
- **Program:** whether to gate EMA on a new print (every `crank_tick` re-applies EMA to the same print).
- **Tests:** Postgres tests `indexerDb.test.ts` (no Docker); `bootstrap()` on mb-stack (no mb-stack); local `bootstrap()` does not create `BalancesRoot`.
- **Sybil #27** — unchanged.
- **Docs:** rent in spec/CLAUDE.md is the LiteSVM formula; on devnet ≈27 % lower.
- Leftovers from tasks: abandoned identities `FVfD8Xc3…`, `GXQ83pzK…`; L1 `.rpc()` without retry in 01/05/11; 03 poll window; untested param-restore failure branch in 16; app ER actions without logcat signatures; long-term feed cadence.

---

<a id="chart-timeframes"></a>
## Chart: 16 timeframes, candles, backfill (02.10.2026)

Source: `2026-10-01-week6-chart-timeframes.md` (plan C.5, part 2); `week6-results.md` (sections "Chart C.5, part 2: relayer deploy with 16 timeframes and Hyperliquid backfill (02.10.2026)" and "App smoke on the AVD (02.10.2026)").

### Goal

The relayer's `GET /prices` serves candles on all 16 TradingView timeframes (`1s`…`1M`); history for the longer tfs is backfilled from an external history API; raw ticks get a retention; the app chart switches all 16 tfs, draws `1s` with whitespace in empty seconds and shows the TradingView logo required by the lightweight-charts licence. Spec §2.10 (2.10.1 bucketing, 2.10.2 schema and writes, 2.10.3 backfill, 2.10.4 `/prices`, 2.10.5 App, 2.10.6 tests, 2.10.7 risks).

### Plan in brief

- Branch `chart-timeframes` from `main` (`a9de283`; spec `afa07c6`). Program, `idl/`, `tests/er` (except new `tests/fixtures/`) untouched. Baselines: relayer **244** (237 + 7 Postgres skipped), app **140**.
- Timeframes exactly `1s 1m 5m 15m 30m 1h 2h 4h 6h 8h 12h 24h 2D 5D 1W 1M` (label `24h`, not `1D`). Stored tiers `1m`, `1h`, `1d`; `TIER_TF = {"1m":"1m","1h":"1h","1d":"24h"}`. `tierOf`: `1s` → `ticks`; `1m…30m` → `1m`; `1h…12h` → `1h`; `24h 2D 5D 1W 1M` → `1d`. UTC only (`Date.UTC`/`getUTC*`). `1W` starts Monday 00:00 UTC, `1M` on the 1st, all others fixed widths from the epoch (`2D`/`5D` included).
- Bucketing (`TIMEFRAMES`, `isTf`, `bucketStart`, `prevBucket`, `nthPrevBucket`, `tierOf`, `mergeCandles`) lives in two TS copies (relayer, app) pinned by `tests/fixtures/timeframes.golden.json` (>= 14 vectors: year boundary, leap February, Sunday to Monday, `2D`/`5D` from the epoch). Any tf change goes into both copies and the golden file.
- `/prices` response shape unchanged: `{ market, tf, candles: [{ t, o, h, l, c }] }`, o/h/l/c 1e6 numbers, `t` = bucket start ms; `source` not exposed; `/mark`, `/ws` unchanged. `limit` default 300, max 1000; unknown tf → 400 listing every accepted tf; default tf `1m`.
- Table `candles(market, tf CHECK IN ('1m','1h','1d'), t, o, h, l, c, source CHECK IN ('oracle','pyth_pro'), PRIMARY KEY (market, tf, t))`. Each oracle tick = one SQL round-trip: insert into `ticks` + three upserts (`o` kept, `h = GREATEST`, `l = LEAST`, `c` = this price, `source` flips to `'oracle'`). Backfill rows: `ON CONFLICT DO NOTHING`, so an oracle candle always wins.
- `planPrices(tf, limit, now)`: `1s` reads raw ticks `limit + 1` seconds back; other tfs read their tier from `nthPrevBucket(tf, bucketStart(tf, now), limit)` (calendar-aware). `candlesForTf` = `mergeCandles(...).slice(-limit)`, never pads.
- Retention: `TICKS_RETENTION_MS` (default `604800000` = 7 d, min `3600000`), `DELETE FROM ticks WHERE ts < cutoff` every `COMMIT_INTERVAL_MS`; a failed DELETE is logged, retried next interval.
- Backfill as planned (Pyth Pro History API, TradingView UDF): base `https://pyth.dourolabs.app/v1`, channel `fixed_rate@200ms`, resolutions `1`/`60`/`D`, chunks `TIER_CHUNK_MS` 2 d / 90 d / 400 d; market → symbol by Lazer feed id (`MARKET_CATALOG[symbol].lazerFeedId` == keyless `/v1/symbols[].pyth_lazer_id`), never by name; enabled only by secret `PYTH_PRO_API_KEY` (header only, never in logs/URL/fixtures/docs); 401 disables the job until restart; other errors isolated per market x tier; env `BACKFILL_INTERVAL_MS` (`86400000`, min `600000`), `BACKFILL_1M_DAYS` (7), `BACKFILL_1H_DAYS` (90), `BACKFILL_1D_FROM` (`2025-04-01`), `BACKFILL_REQUEST_GAP_MS` (500). `/healthz.backfill` = `{ enabled, lastRunAt, lastOkAt, lastError, rows }`. (Replaced by Hyperliquid, see "Superseded later".)
- App: `foldMarks` folds a tail of WS marks into candles (`MARK_TAIL_MAX = 2000`, ≈33 min at 1 s); `fillWhitespace` on `1s` (`WHITESPACE_MAX_GAP = 1000` steps); `/prices` refetch 15 s for `1s`, 30 s otherwise (`candlesRefetchMs`); `attributionLogo: true`.
- Review focus: (1) old tf on a nearly empty table → 200 with 1–2 candles, no padding; (2) `now` exactly on a `1W`/`1M` boundary → `bucketStart` returns `now`; (3) late tick in a closed bucket changes only that bucket's `h/l/c`, never `o`; (4) malformed history response (lengths differ, misaligned `t`, `s: "error"`) → chunk dropped whole with a log; (5) an hour gap on `1s` must not grow to 3600 whitespace points; (6) Columns/Baseline/HLC with whitespace (no colour on whitespace, `Math.min` safe, baseline from the first REAL point, `bars` only real).

| Task | Outcome |
|---|---|
| Task 1 relayer `timeframes.ts` + golden vectors | done (plan expected 251 = 244 + 7) |
| Task 2 migration `009_candles.sql` (table + one-off roll-up of all existing ticks into 1m/1h/1d), `insertTick` three-tier upsert, `listCandles`, `insertBackfillCandles`, `deleteTicksBefore`, `tickBucketParams` | done; 6 new Postgres `dbTest`s skipped locally (expected 258 = 245 + 13) |
| Task 3 `/prices` on 16 tfs (`planPrices`, `candlesForTf`, `tfMsOf` removed) | done (expected 263 = 250 + 13) |
| Task 4 tick retention (`indexer/retention.ts`, own timer in `index.ts`) | done (expected 265 = 252 + 13) |
| Task 5 Pyth Pro backfill + `/healthz.backfill` | done (expected 274 = 261 + 13); later replaced by Task 13 |
| Task 6 relayer README + `docs/deployments.md` env rows | done |
| Task 7 app `timeframes.ts` twin, `Tf` widened to 16, `useCandles(symbol, tf, limit)` | done (expected app 144) |
| Task 8 `foldMarks` + `useMarkTail` replace `withLiveMark`; `markUsd` prop removed from chart | done (expected 146) |
| Task 9 whitespace for empty `1s` buckets, whitespace-safe `chartHtml.ts` | done (expected 148) |
| Task 10 16 tf pills with auto-scroll, per-tf refetch, TradingView logo | done (expected 149; `npx expo export --platform android` once) |
| Task 11 docs (CLAUDE.md section, spec "Implemented", backlog C.5 status) | done 02.10.2026 |
| Task 12 devnet: relayer deploy, `/prices`, backfill, app smoke (owner gates) | relayer on devnet done; app on AVD done (see Measurements) |
| Task 13 Hyperliquid instead of Pyth Pro | done (`3d01b82`, `0c3265a`, `8f6bd34`) |
| Task 14 backfill pacing by rate-limit weight | done (`4da24bc`, `35dd402`) |
| Task 15 two smoke findings | done (`e8f7947`) |

### What was done

- All tasks of plan C.5 completed (status 02.10.2026): Tasks 1–11 (relayer, app, docs), Task 12 (relayer on devnet, app on AVD), Task 13, Task 14, Task 15. Final review of the branch + fix-wave (`3c9db88`, `a35fed8`).
- Branch `chart-timeframes` (PR #12, head `a2f552d`), Railway deployment `0968a8e6` (`railway up --service relayer --ci`, 07:17 UTC). Program unchanged. Image build ≈1 min; first healthcheck 404 (process still starting), then OK. No separate APK built for the smoke (dev-client + Metro).
- Tests: relayer **291** (277 + 14 Postgres skipped), app **159**, unit 69 and LiteSVM 89 unchanged.

### Measurements

#### Chart C.5

| What | Measured |
|---|---|
| Migration 009 (`candles` + roll-up of all ticks) | `db: applying migration 009_candles.sql` 07:17:51.4 → 010 at 07:17:55.9 — **≈4.5 s** on 908 135 ticks (five markets, oldest 22.09 19:40 UTC) |
| Migration 010 (CHECK on `candles.source` not bound to a name) | ≈1.7 s; `pg_constraint` after: `candles_source_check CHECK (source IN ('oracle','pyth_pro','hyperliquid'))`, `candles_tf_check` untouched |
| Oracle roll-up into `candles` | `1m` 15 527, `1h` 267, `1d` 19 rows `source='oracle'` (since 22.09) |
| Hyperliquid backfill, first run | 07:17:58 → 07:19:27 = **89 s**; `run done rows=35025 weight=1440 markets=5 errors=0`; exactly 1 "incomplete" row dropped per market x tier (the current candle); no 429 |
| Inserted from Hyperliquid | `1d` 6 126 (SOL 1360 / BTC 1369 / ETH 1369 / ZEC 1363 from 01.01.2023, HYPE 665 from 05.12.2024); `1h` 10 538 (2145 per market, SOL 1958 — the rest already existed from the oracle); `1m` 18 361 (3.5 days — Hyperliquid's 5000-candles-per-interval limit) |
| `/healthz.backfill` after the run | `{enabled: true, lastOkAt: 1790925477638, lastError: null, rows: 35025, source: "hyperliquid"}` |
| `/prices` (limit 1000) | `1M SOL` 46 candles from 2023-01; `1W HYPE` 96 from 2024-12-02; `1M HYPE` 23; `1W ETH` 197 from 2022-12-26 (Monday of the first week of 2023); `1h BTC` 1000 from 21.08; `30m HYPE` 172 (≈3.6 days); `1s SOL` 983 over 1000 s; all monotonic in `t`; `tf=7m` and `tf=1d` → 400 (the label is `24h`) |
| `ticks` before retention | 908 135 rows (SOL 706 392, BTC 51 686, ETH 51 708, HYPE 49 161, ZEC 49 186) |
| Retention, first `DELETE` | `retention: deleted 210426 ticks older than 604800000 ms` at 07:22:58.3 — 300 s after start, **≈0.7 s** per DELETE (timer 07:22:57.6); `ticks` 908 680 → 698 611; oldest SOL tick now 25.09 07:22 UTC, other markets from 01.10 16:42 (their ticks are younger than 7 days) |

Conclusions: the first-run weight estimate (≈1515) was conservative — actual 1440, because `1m` chunks return fewer than 2880 candles (Hyperliquid depth 3.5 days). Pacing at 55 ms per weight unit gave 89 s per run. Daily candles of ZEC/SOL/BTC/ETH reach 2023 — `1M` has ~46 months, `1W` ~197 weeks. Hyperliquid does return the unfinished candle in every response — the `T >= now` filter fired 15 times out of 15. Pyth Pro was no longer in the deploy: no key was needed.

#### App smoke

AVD `local_phone`, dev-client + Metro from branch `chart-timeframes`, 02.10.2026. Run by the agent (no wallet — the chart is visible without onboarding; the dev-client still had a session from earlier smokes, so Entry/Liq lines show on SOL/HYPE). Screenshots via `adb exec-out screencap`.

| Step | Result |
|---|---|
| 16 timeframe pills | PASS, all present, selected one scrolls into view; **finding #1:** on mount with default `1m` the row shifted by 46 px and hid `1s` past the edge (peek 24 px < pill) — fixed (`e8f7947`: scroll only when the pill is not fully visible, `scrollTargetFor`), confirmed by cold start |
| `1s` | PASS, flat per-second candles with whitespace between, uniform axis; live edge without whitespace until the next refetch (known deferred minor); **finding #2:** axis labels only `HH:MM PM` ("04:08 PM" three times) — fixed (`secondsVisible` on `1s`), on device now `04:18:13 PM, 04:18:26 PM …` |
| Columns / Baseline / HLC area on `1s` | PASS, no page errors; Columns at a smaller scale shows alternating columns and empty slots; Baseline line starts from the first real point; HLC band H–L degenerate on `1s` (one price per candle), as expected |
| H/L labels for the visible window | PASS on all tfs, including `1s` when zoomed (`H 122.63 / L 122.47` for a one-minute window) |
| TradingView logo | PASS, tap opens `tradingview.com` in system Chrome (`mCurrentFocus = com.android.chrome`), app returns without losing state |
| Long tfs from backfill | PASS, `1M SOL` candles from 2023 (L 9.68, SOL price in January 2023); `2D BTC` from July; `1W/1M HYPE` from December 2024 (L 9.31 — HYPE's launch price); `8h SOL` from mid-September |
| Market switch without cache (`1s`, SOL → ZEC) | PASS, after 0.4 s only ZEC prices (~1389) and ZEC H/L on the chart; no SOL bar |
| Environment noise | toast "ws error: undefined" after returning from Chrome — from `@expo/devtools` (dev-client's WebSocketWithReconnect), not app code |

### Rulings and findings

- Retention deviates from spec §2.10.2 ("in the commit cycle"): `crank.ts`'s cycle has no `DbPool` (its `pool` is the `Pool` PDA), so retention runs on its own timer in `index.ts` with period `COMMIT_INTERVAL_MS`.
- "Saved tf is validated" (spec) is moot: the app never persisted `tf` (plain `useState('1m')` in `TradeScreen`), nothing added.
- The relayer never synthesizes buckets; `1s` whitespace is client-only (the oracle prints every ~2 s, so about every other second is empty). The tick effect always sends a real last point (whitespace is only inserted between points).
- `foldMarks`: a mark in the newest bucket sets close and stretches h/l; a later bucket opens at the previous close; a mark older than the newest candle is ignored. `useMarkTail` resets on each candles fetch (`dataUpdatedAt`).
- `attributionLogo: true` is a lightweight-charts (Apache-2.0 NOTICE) requirement — do not disable; the link opens in the system browser.
- Smoke pitfalls: a **fast** horizontal swipe over the timeframe row switches the market (screen gesture); a slow drag (>= 1 s) scrolls the row. Auto-scroll is animated — a screenshot right after a tap catches an intermediate frame; wait >= 2 s before the next coordinate tap.

### Superseded later

- Backfill source: Pyth Pro was replaced by the Hyperliquid public info API (Task 13; `source='hyperliquid'` via migration 010; `'pyth_pro'` kept in the CHECK). The plan's Pyth Pro design (`PYTH_PRO_API_KEY`, Lazer-id symbol mapping, UDF parsing, chunk sizes, env defaults above) did not ship in the deploy.
- "Postgres tests (`indexerDb.test.ts`, now 14) never run locally (no Docker) — migrations 009/010 checked only by the live deploy": **closed 04.10.2026** — Docker Desktop 29.5.3, `postgres:16-alpine` in a container, full relayer suite with `TEST_DATABASE_URL` — **304/304, 0 skipped**, `indexerDb.test.ts` 15/15 (migrations 008, 009 with roll-up on a table with rows, 010 CHECK `source`; candle upsert; backfill does not overwrite the oracle; retention does not touch candles).
- "Second (daily) backfill run": **observed 04.10** — after redeploy `58089680` the run passed (`lastError: null`, `rows: 0` — no new closed candles); the retry branch on a real error has not happened yet.

### Open at the end

- Release APK for the branch (smoke was on the dev-client).
- Retry branch of the backfill on a real error not yet exercised.
- Mount case: `scrollTargetFor` returns 0 instead of null (no-op `scrollTo`).
- Live edge of `1s` without whitespace until the next refetch.
- `lastView` not updated after `render` from the tick effect (one extra refit).
- Deferred per-task review minors — spec §2.10 "Implemented".

---

<a id="orders-review"></a>
## Conditional orders: review of PR #13 → PR #14 (04.10.2026)
Source: `week6-results.md` (section "Conditional orders: review of PR #13 → PR #14 and two fixes"; local tests only, NOT measured on devnet at the time)

### What was done
- **PR #14 merged into `main` on 04.10.2026 at 06:43 UTC (`c459847`), PR #13 closed.** No devnet deploy yet at that point.
- PR #13 (colleague, branch `feat/conditional-orders`, base 27.09 + merge of main 03.10) adds Limit / Stop-market / TP / SL / Trailing as 8 `OrderSlot` of 88 B in `Positions`, executed by the same per-(trader, market) `liquidation_check` (`run_orders` after the liquidation check); `place_order`/`cancel_order` on the 12-account `Trade`; in the app — a Market/Limit/Stop ticket with TP/SL, Open Orders, "Add TP / SL" on the card. Design: `docs/superpowers/specs/2026-10-03-conditional-orders-design.md`.
- Against backlog 6.B: done — Limit, Stop-market, TP/SL, Trailing; not done — stop-limit, order execution by the relayer's `crank_tick`, partial TP/SL, margin reservation, Margin mode, Borrow Rate.
- Review (04.10, own + `/code-review`), three blockers:
  - **Blocker 1** — merge commit `142f1ee` deleted `docs/android-install-options.md` (253 lines) and the links to it in CLAUDE.md and `docs/emulator-runbook.md`. Merge redone: PR #14 (`feat/conditional-orders-rebased`, commit `564c10f` on top of `main`), the PR's 31 files byte-equal to `142f1ee`, everything else = `main`. Pointer comment left in #13.
  - **Blocker 2** — `place_order` ended with `register_liq_task` without validating `Trade.feed` (only `open_position` did so via `read_price`): a trader could re-register their own task with a junk `feed`, and every scheduled `liquidation_check` would skip on `WrongFeed` forever (only the relayer liquidates). **Fix `8093519`:** check inside `register_liq_task` itself (`feed.key() == Market.feed`, owner == `Config.oracle_program`). TDD: LiteSVM `place_order_with_a_foreign_feed_is_rejected` — red before the fix ("expected failure", order accepted), green after.
  - **Blocker 3** — `Positions` 3184 → 3888 B without migration: `AccountLoader` cuts data to exactly `size_of + 8`, so every delegated account would fail in every instruction (no close, no exit, no liquidation); the relayer from `main` would skip the new length. Realloc impossible (on L1 the owner is the Delegation Program; resize in ER not measured). **Fix `732928b`:** the order tail is optional — `Positions` is 3176 B again, `Orders = [OrderSlot; 8]` right after (`ORDERS_AT` 3184), `init_user` allocates `SPACE_WITH_ORDERS` 3888; `orders_mut`/`load_positions_mut` read the tail only when length ≥ 3888 (one data borrow — `load_mut()` + a separate tail borrow would fail on `RefCell`). A legacy account trades, ticks, is liquidated by both paths and exits; `place_order`/`cancel_order` → `OrdersUnsupported` (6054). TS decoders accept both lengths (`ordersSupported`). TDD: LiteSVM `legacy_positions_without_order_tail_still_trades_and_refuses_orders` (account truncated to 3184 via `set_account`), decoder tests in app and relayer — red before the fix (missing constants / exports), green after.
- `program_autofixer` over `order.rs`, `liquidation.rs`, the changed parts of `trade.rs` (including both fixes) — 0 findings.
- PR #14 commits: `564c10f` (merge), `8093519` (feed), `732928b` (tail), `15faede` (docs).

### Measurements
Tests after the fixes (04.10.2026, Node 24.18.0):

| Suite | Count |
|---|---|
| LiteSVM | **110** (108 in PR + 2) |
| unit | **73** |
| app | **171** (170 + 1) |
| relayer | **292** (278 + 14 Postgres skipped; 291 on `main`, +1) |

`tsc` ×3, `expo lint`, `prettier`, `cargo fmt`, clippy as in CI — clean. IDL regenerated (`OrdersUnsupported`; the `OrderSlot` type disappeared from the IDL because it is no longer a `Positions` field).

### Rulings and findings
- Cross-check with the `magicblock` skill references (04.10): resize is described only for Ephemeral Accounts (live only in ER, never committed) — for a delegated account there is no resize path, which confirms the optional tail instead of realloc.
- Re-registering the same `task_id` updates only under the same authority (for us always the `FeeEscrow` PDA), but the scheduler applies it **asynchronously**: success of the `place_order` tx does not prove the task was updated — measure by actual execution.
- In a scheduled instruction only `crank_signer_pda(authority)` can be a signer, the account list is fixed at registration, and the program must validate accounts before the CPI — exactly what `8093519` closed.
- Rent of a new `Positions` grows by 704 B (≈ +3.7 M lamports on devnet by the plan 4 formula) — sponsored onboarding gets more expensive for `fee_payer`.

### Open at the end
- Medium (open): reopening on a liquidation tick via a resting entry (`has_orders` is read before liquidation); `attach_exits` places TP before SL and silently drops whichever lacked a slot; entry orders are accepted already triggered; attached TP/SL not checked against the fill price, Stop without a slippage bound; `open_core` writes `free_margin` before four `checked_add`, and `run_orders` swallows the error; `describeOrder` hardcodes "SOL"/1e9; the order row is duplicated in `TradeActivity`/`OrdersCard`.
- Minor: `trailing_stop_price` outside `math.rs`, unchecked `u128` operations, rounding in the trader's favour (contradicts the CLAUDE.md rule unless documented as an exception); the CLAUDE.md rule about platform-tools v1.57 is a quirk of the author's environment (CI passed with a plain `anchor build`); spec §2.11 and ER/admin TS builders for `place_order` are missing.
- Not measured on devnet (measurement plan): (1) `place_order` TP on smoke wallet `2TQe…` (its `Positions` 3184 B) after the upgrade must give `OrdersUnsupported`, while open/close/tick keep working; (2) new wallet: Limit without a position → wait for a scheduler tick and see an open position, not tx success; (3) CU of `run_orders` per tick (crank token); (4) redeploy the relayer together with the program (the new decoder accepts both lengths). Not tried: `realloc` of a delegated account in ER.

<a id="token-info"></a>
## Token information: review of PR #15 (04.10.2026)
Source: `week6-results.md` (section "Token information: review of PR #15"; merged `2bfe24a`; local tests and one live CoinGecko request only)

### What was done
- PR #15 (colleague, branch `feat/token-information`, base — `main` after #14): relayer `GET /assets/:symbol` for SOL/BTC/ETH/HYPE/ZEC — text and https links from `services/relayer/assets/assets.json` in the repo, numbers from CoinGecko (`coins/{id}` + `global`, no key; `COINGECKO_API_KEY` — demo key only for the rate limit), in-memory cache `ASSETS_CACHE_MS` 10 min, single flight, 60 s backoff after a failure, old numbers with `stale: true`, without numbers — text and `market: null`; `ASSETS_ENABLED=false` disables it.
- App: a third tab **Token info** in `ChartSection` (`TokenInfoPanel`, `lib/assets.ts` with an https-only parser, `assetFormat.ts` without `Intl`). Instead of a separate `AssetInfoScreen` with Long/Short at the bottom — a tab on the same screen (the ticket is already under the chart). Backlog item 7.
- **Review (04.10): no blockers.**

### Measurements

| Check | Result |
|---|---|
| relayer, full suite (the PR ran only `assets.test.ts`) | **304** (290 + 14 Postgres skipped; was 292) |
| relayer `tsc` | clean |
| app tests | **181** (was 171) |
| app `tsc`, `expo lint`, `prettier` | clean — the "two errors in generated files" from the PR description do not reproduce; it is the author's environment without `postinstall` (`gen:lwc`) |
| live CoinGecko without a key | `coins/hyperliquid` and `global` → 200; parser: rank 11, market cap ≈19.97 B, ATH 97.96 (2026-09-23), max supply 1 B, total ≈955.3 M; total market cap ≈2.88 T |

Load on CoinGecko — 6 requests per 10 min for all five markets.

### Rulings and findings
- Verified in code: https validation of links twice (at relayer start and in the app parser); Express 5 — an async error in a route does not hang the request; `Dockerfile` copies all of `services/relayer`, so `assets.json` lands in the image; the route is mounted before `listen`; colours only from theme tokens; `key={symbol}` on the panel; facts and launch dates in `assets.json` checked.
- Process finding: the background `/code-review` checked the wrong target this time — branches were switched for tests while it ran, and it analysed local `main` instead of the PR. Its eight findings concern `docs/android-install-options.md` (non-existent command `solana-mobile playground`; `gh release create` with `#` does not rename the file; `eas.json` already exists; editing the generated `build.gradle` will not survive `prebuild`; row 7 of the table about Metro; `minSdkVersion` is not in `app.json`; "key loss = different package" inaccurate) — a separate list of fixes for that document, not part of the PR #15 review.

### Open at the end
- Minor (open): `TokenInfoPanel` writes "not available for X yet" on any error, including network — should distinguish 404 from a network failure; `docs/deployments.md` lacks the new env (`ASSETS_ENABLED`, `ASSETS_CACHE_MS`, `COINGECKO_API_KEY`); 404 echoes `req.params.symbol` without a length limit (JSON, safe).
- Out of the PR, as declared: share / alert / favorite, asset icon, CoinMarketCap.
- Not measured: `/assets/:symbol` from the live relayer (needs `railway up`), the tab on a device, behaviour on 429 from CoinGecko on Railway's shared egress IP.

<a id="devnet-04-10"></a>
## Devnet deploy and smoke (04.10.2026)
Source: `week6-results.md` (section "Devnet deploy and smoke, 04.10.2026"; program + relayer from `main` `7a31959`; AVD `local_phone`, fakewallet)

### What was done
- **Program — upgrade on the same id `Fyg2…UfCY`, not a new keypair** (legacy accounts survive thanks to the optional tail). Build `anchor build --ignore-keys` from `main` code: `.so` **1 136 328 B**, sha256 `ea07c58c…53150e`; the IDL from this build is byte-equal to `idl/dexxer_core.json`. The owner ran the deploy via `!` (the classifier blocks the agent from both `solana program deploy` and — for the first time — `railway up`).
- **Relayer — `railway up --service relayer --ci` from `main`** → deployment **`58089680` SUCCESS** (≈07:58 UTC; healthcheck: 404, 404, 503, then OK — the process was still starting). `/healthz` ok, `db ok`, 5 markets; first SOL tick n=1 right after start.
- Smoke on AVD `local_phone` (agent; fakewallet, owner `2TQe…FgWi` — plan 4 legacy account, `Positions` 3184 B). Proxy + Metro + emulator per runbook §1; boot 18 s; the dev-client takes the bundle from Metro (branch `main`), same APK (01.10).

### Measurements
Program upgrade:

| Step | Fact |
|---|---|
| `solana program extend … 32768` | needed: the new `.so` is 28 888 B larger than the allocated 1 107 440 B; ProgramData 1 107 485 → **1 140 253 B**, rent 5 626 674 040 → 5 793 135 480 lamports (**+0.1665 SOL, irreversible**) |
| `solana program deploy … --program-id Fyg2…` | sig `212XaX63…e9Hu`, slot **507294602**, `err: null`, fee 5 000 lamports; payer `4P1WD9…` 7.3056 → **7.1335 SOL** (≈0.172 SOL together with extend; the ≈5.77 SOL buffer was returned) |
| Byte check | `solana program dump` to a file; sha256 of the first 1 136 328 B == local `.so`, extension tail zero |
| Live relayer (still C.5) on the upgraded program | keeps ticking without errors (`tickAge` 1.2 s) — `crank_tick` compatible with both builds |

Relayer:

| What | Measured |
|---|---|
| `GET /assets/{SOL,BTC,ETH,HYPE,ZEC}` | 200 (`sol` also 200 — case-insensitive), `DOGE` 404; `Cache-Control: public, max-age=60` |
| First burst: 5 symbols in a row within ≈2 s | CoinGecko **HTTP 429** ×3 in the log (`assets: refresh failed`); SOL got numbers, BTC/ETH/HYPE/ZEC returned `market: null` (text present) — after the 60 s backoff all four fetched rank/mcap on the next request. "Never an error" behaviour confirmed; on Railway's shared egress IP without a key the limit is below 6 requests/min |
| `/assets/SOL` | rank 7, market cap 71.16 B, dominance 2.47 %, ATH 293.31 (2025-01-19), circulating rate 92.6 %, `stale: false` |
| `crank_tick` with 1 candidate on the new build | **24 478…24 492 CU**, 449 B (on the plan 4 build — 21 428…21 445): ≈+3 050 CU per candidate for the split loader and the order tail; without candidates 15 535 (unchanged) |

Smoke:

| Step | Result |
|---|---|
| Launch on the legacy account | ✅ Trade opened, Positions (1 on HYPE) / Open Orders (0) from the new decoder, no crash; badge `SESSION EXPIRED` |
| Token info · HYPE | ✅ name, rank #11, launch Nov 29 2024, three texts with "Show more", ATH $97.96 / ATL $3.81, table (mcap $20B, FDV $85.9B, 24h vol $465.99M, dominance 0.69 %, supply 222.45M/1B/955.31M, rate 23.29 %), Website/Explorer/GitHub (Whitepaper absent from `assets.json` — no button), disclaimer "Updated 1 min ago" |
| Website | ✅ opened `hyperliquid.xyz` in system Chrome (tapped accidentally by a swipe), return without state loss |
| Market switch with the tab open | ✅ SOL: "Solana (SOL)", rank #7, Mar 16 2020, Max. supply "—", Whitepaper present; Token info tab stayed active, panel remounted |
| Positions on the legacy account | ✅ three cards (SOL long 3×, HYPE short 3×, ZEC long 5×), Mark/uPnL "—" until the card is activated (by design: live `Market` is read only for the active one) |
| Re-authorize session | ✅ Onboarding in reauth mode → SIWS `sign_messages` → leg `permissions+session` 486 B → `/trade`; `SESSION ACTIVE · 23H LEFT · 20 ACTIONS` |
| Active SOL card | ✅ Mark $120.95, uPnL +$0.23, "30 % away from liquidation", card **Orders · No pending orders · Add TP / SL** |
| **`place_order` TP 130 on the legacy account** | ✅ **tx `5uPqnH9f…HCBD` rejected `Custom 6054`**, app showed "This account predates conditional orders — exit and set it up again to use them (6054)" — blocker 3 fix confirmed on the live network; positions and session untouched |
| New wallet: onboarding, Limit without a position, TP/SL, execution by the scheduler | ⏸ **deferred by the owner** (needs Disconnect → fakewallet will create a new account) |

### Rulings and findings
1. **Error toast is invisible under a sheet.** `ToastHost` lives in the root layout, and `Sheet` is an RN `Modal` drawn on top of everything: a `place_order` rejection (and any action from the Increase/Decrease/Margin/Order sheet) shows as a toast UNDER the modal, the sheet stays open, the user sees nothing. Found only via a temporary log in `run()`. Fix — render the toast inside `Sheet` or close the sheet before the toast (item in 6.B/C.4).
2. **`adb shell input tap` does not fire on a `Pressable` inside a `Modal` sheet** (inputs and segments work); press-hold `input swipe x y x+1 y+1 120` works. `uiautomator` shows `enabled=false` on the button although it is active — do not trust that field for RN buttons in a modal.
3. Fast Refresh from Metro did not deliver edits in `src/features/*` (no new bundle in the log) — full reload via the same `am start … expo-development-client` intent as runbook §1 item 7.
4. Horizontal swipe inertia on the Trade screen shifts the vertical scroll — take screenshots ≥1.5 s after a gesture.

### Open at the end
- New wallet and Limit without a position (task registration from `place_order`, execution by the scheduler — measure by an actually opened position, not by tx success); TP/SL/Trailing on an account with the tail; CU of `run_orders` per tick; smoke 8–9 of plan 4.
- Update `docs/deployments.md` (new env `ASSETS_*`/`COINGECKO_API_KEY`, deployment `58089680`, upgrade slot) and the CLAUDE.md markers "tests only — NOT measured on devnet" for orders and Token info.

<a id="lessons"></a>
## Process lessons
Source: `week6-results.md` (section "Process lessons")

1. Background `/code-review` reads the working tree: switching branches while it runs swaps its target. Run the review on `gh pr diff` / a separate worktree, or do not touch the checkout while it works.
2. A colleague's branch cut before a series of docs commits in `main` silently deleted a new document on merge. Check merges not only by the PR stat but with `git diff main <branch> -- . ':!<PR files>'` — it must be empty.
3. A zero-copy account cannot "just be appended to": `AccountLoader` requires length ≥ `size_of + 8`, and shorter accounts are bricked in all instructions. An optional tail (struct unchanged, read by length) is a safe alternative to realloc, which does not exist for delegated accounts.
4. Agents cannot run `solana program deploy`: the permission classifier ("Production Deploy") blocks both the executor and the controller. Deploy goes via the owner's `!` in the session.
5. Railway CLI hangs on stdin without `</dev/null`: `railway variables --service relayer --kv` hung for over 10 min. CLI 5.23 syntax: `railway variable set/delete`, `-y`/`--json` everywhere.
6. `solana balance <addr>` printed the default signer's balance for all three addresses. Balances — only via JSON-RPC `getBalance`.
7. No local `psql` or Docker: SQL in Railway Postgres — `railway ssh --service Postgres -- psql …` (the service has no public TCP proxy).
8. The Railway trial subscription ended unnoticed: the relayer was down since 25.09, Postgres since 22.09. Nothing notified about it (see uptime monitor).
9. `solana program dump <id> -` writes a file named `-`, not to stdout.
10. `railway.json` in the repo does not mean the policy is applied: check the deployment's `serviceManifest`. Railway config-as-code is deprecated (`.railway/railway.ts`) — set service settings directly (`update-service`).
11. Redeploying a service uploaded with `railway up` — only `railway up`: MCP `redeploy` has no source repo and fails on BUILD_IMAGE.
12. The plugin's `railway mcp` process keeps the token it started with and becomes `Unauthorized` when it expires — restart the process (or the claude.ai Railway connector).
13. A scenario that forces parameters of a shared market liquidates **every** trader on it, not only its own (13 took trader 01).
