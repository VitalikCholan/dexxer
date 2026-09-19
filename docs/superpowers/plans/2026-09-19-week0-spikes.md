# Dexxer Week 0 — Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 11 week-0 checks from spec §7.2 with runnable spike scripts on `devnet-tee`, so that every architectural assumption in the spec is either proven or replaced by its fallback before product code starts on 28.09.

**Architecture:** Each spike is a throwaway folder under `spikes/NN-<name>/` built on a cloned MagicBlock engine example plus one `check.ts` script whose exit code is the pass signal, and a `RESULT.md` recording pass/fail, signatures, and the decision it triggers. No product code is written this week; the only non-spike deliverables are the toolchain pin, the Expo skeleton, docs corrections, and red math tests.

**Tech Stack:** Solana 3.1.9 · Rust 1.89.0 · Anchor 1.0.2 · `ephemeral-rollups-sdk` 0.16.2 (`anchor`, `access-control`) · `@magicblock-labs/ephemeral-rollups-sdk` 0.17.0 · `@magicblock-labs/gum-sdk` · `pyth-solana-receiver-sdk` 2.0.0 · Node 24 · Expo + `@wallet-ui/react-native-web3js` · devnet + `https://devnet-tee.magicblock.app`

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` (§6.1 toolchain, §7.1 risks, §7.2 checks, §7.3 calendar)

## Global Constraints

- Toolchain pinned exactly: Solana CLI `3.1.9`, Rust `1.89.0`, Anchor `1.0.2`, Node `24.10.x`.
- Rust deps: `anchor-lang = "=1.0.2"`, `ephemeral-rollups-sdk = { version = "0.16.2", features = ["anchor", "access-control"] }`.
- TS deps: `@magicblock-labs/ephemeral-rollups-sdk@0.17.0`, `@coral-xyz/anchor@0.32.1`, `@solana/web3.js@^1.98` — **never** `@solana/kit`.
- Endpoints: base `https://rpc.magicblock.app/devnet`; router `https://devnet-router.magicblock.app/`; TEE `https://devnet-tee.magicblock.app` (WS `wss://devnet-tee.magicblock.app`).
- Devnet TEE validator identity: `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` (from private-counter test; re-verify with `getIdentity` on the TEE endpoint in Task 2).
- Every spike ends with `spikes/NN-<name>/RESULT.md` containing: status (PASS/FAIL), evidence (signatures, pubkeys, log lines), decision (which spec risk/fallback it triggers).
- Spikes are throwaway: no code from `spikes/` is copied into `programs/` or `app/` later without a fresh review.
- Blockhash always from the connection the tx is sent to. `skipPreflight: true` only if a documented ER simulation incompatibility is hit, and then execution logs are inspected.
- Commit messages in English; docs in Ukrainian. Commit after each task.
- **Gate:** Task 1 (Colosseum rules) decides whether Tasks 13–14 (red math tests, Expo skeleton) may be committed before 28.09. Spikes are research, not product code, and proceed regardless.

---

## File Structure

```
mobile_perp_dex/
  rust-toolchain.toml                 Task 2
  .nvmrc                              Task 2
  spikes/
    README.md                         Task 2 — how to run spikes, env vars, keypairs
    .env.example                      Task 2
    keys/                             Task 2 — gitignored devnet keypairs
    01-private-counter-tee/           Task 3 (check 1) + Task 4 (check 6)
    02-espl-tee/                      Task 5 (check 2)
    03-l1-readonly-clone/             Task 6 (check 3)
    04-oracle-tee/                    Task 7 (check 4)
    05-crank-tee/                     Task 8 (check 5)
    06-magic-action/                  Task 9 (check 7)
    07-session-payer/                 Task 10 (check 9)
    08-mobile-checks/                 Task 12 (checks 8, 10, 11) — inside app/
  app/                                Task 11 — Expo skeleton (create-solana-dapp)
  programs/dexxer_core/               Task 13 — math.rs with red tests only
  docs/                               Task 14 — corrections
```

---

### Task 1: Colosseum rules gate

**Files:**
- Create: `docs/superpowers/plans/week0-gate.md`

**Interfaces:**
- Produces: a written yes/no on "product code may be committed before 28.09" that Tasks 13–14 read.

- [ ] **Step 1: Read the current Colosseum hackathon rules**

Open `https://www.colosseum.org/` → current hackathon → rules / FAQ. Search for: "existing code", "prior work", "start date", "pre-existing", "must be built during".

- [ ] **Step 2: Record the finding**

```markdown
# Week 0 gate — Colosseum rules (checked 2026-09-19)

Source: <exact URL of rules page>

Quote: "<verbatim sentence about pre-existing code>"

Decision:
- [ ] Product code (programs/, app/) MAY be committed before 28.09
- [ ] Product code MUST NOT be committed before 28.09 → Tasks 13–14 run locally on a branch `pre-hackathon` that is never pushed; spikes stay on main.

Also checked: Solana Mobile CLOCK IN dates: <dates or "not announced">
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/week0-gate.md
git commit -m "docs: record Colosseum pre-hackathon code rule and week-0 gate"
```

---

### Task 2: Toolchain pin and spikes workspace

**Files:**
- Create: `rust-toolchain.toml`, `.nvmrc`, `spikes/README.md`, `spikes/.env.example`, `spikes/package.json`, `spikes/tsconfig.json`
- Modify: `.gitignore` (add `spikes/keys/`, `spikes/**/target/`, `spikes/**/node_modules/`)

**Interfaces:**
- Produces: `spikes/lib/env.ts` exporting `baseConn`, `teeUrl`, `teeWsUrl`, `routerUrl`, `loadKeypair(name)`, `TEE_VALIDATOR`; every spike imports from it.

- [ ] **Step 1: Pin Rust and Node**

```toml
# rust-toolchain.toml
[toolchain]
channel = "1.89.0"
components = ["rustfmt", "clippy"]
```

```
# .nvmrc
24.10.0
```

- [ ] **Step 2: Install and verify versions**

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.9/install)"
cargo install --git https://github.com/solana-foundation/anchor avm --force
avm install 1.0.2 && avm use 1.0.2
nvm install && nvm use
solana --version && rustc --version && anchor --version && node --version
```

Expected output contains: `solana-cli 3.1.9`, `rustc 1.89.0`, `anchor-cli 1.0.2`, `v24.10.`

- [ ] **Step 3: Create devnet keypairs and fund them**

```bash
mkdir -p spikes/keys
solana-keygen new --no-bip39-passphrase -o spikes/keys/payer.json
solana-keygen new --no-bip39-passphrase -o spikes/keys/user.json
solana-keygen new --no-bip39-passphrase -o spikes/keys/stranger.json
solana-keygen new --no-bip39-passphrase -o spikes/keys/session.json
for k in payer user stranger; do solana airdrop 2 -k spikes/keys/$k.json -u https://api.devnet.solana.com; done
```

If airdrop rate-limits: use `https://faucet.solana.com` manually for each pubkey.

- [ ] **Step 4: Spikes workspace**

```json
// spikes/package.json
{
  "name": "dexxer-spikes",
  "private": true,
  "type": "module",
  "scripts": { "check": "tsx" },
  "dependencies": {
    "@coral-xyz/anchor": "0.32.1",
    "@magicblock-labs/ephemeral-rollups-sdk": "0.17.0",
    "@magicblock-labs/gum-sdk": "latest",
    "@pythnetwork/pyth-solana-receiver": "latest",
    "@solana/spl-token": "^0.4.14",
    "@solana/web3.js": "^1.98.0",
    "dotenv": "^16.4.0",
    "tweetnacl": "^1.0.3"
  },
  "devDependencies": { "tsx": "^4.19.0", "typescript": "^5.6.0" }
}
```

```json
// spikes/tsconfig.json
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "esModuleInterop": true, "resolveJsonModule": true } }
```

```bash
# spikes/.env.example
BASE_RPC=https://rpc.magicblock.app/devnet
ROUTER=https://devnet-router.magicblock.app/
TEE_RPC=https://devnet-tee.magicblock.app
TEE_WS=wss://devnet-tee.magicblock.app
TEE_VALIDATOR=MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo
```

```typescript
// spikes/lib/env.ts
import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const BASE_RPC = process.env.BASE_RPC ?? "https://rpc.magicblock.app/devnet";
export const ROUTER = process.env.ROUTER ?? "https://devnet-router.magicblock.app/";
export const TEE_RPC = process.env.TEE_RPC ?? "https://devnet-tee.magicblock.app";
export const TEE_WS = process.env.TEE_WS ?? "wss://devnet-tee.magicblock.app";
export const TEE_VALIDATOR = new PublicKey(process.env.TEE_VALIDATOR ?? "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

export const baseConn = new Connection(BASE_RPC, "confirmed");

export function loadKeypair(name: "payer" | "user" | "stranger" | "session"): Keypair {
  const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "keys", `${name}.json`), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export async function routerStatus(account: PublicKey): Promise<{ isDelegated: boolean; fqdn?: string; delegationRecord?: { authority: string; owner: string } }> {
  const r = await fetch(ROUTER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [account.toBase58()] }),
  });
  const body = await r.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

export async function rpcIdentity(url: string): Promise<PublicKey> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity", params: [] }),
  });
  return new PublicKey((await r.json()).result.identity);
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}
```

- [ ] **Step 5: Verify the TEE validator identity**

```typescript
// spikes/00-identity.ts
import { rpcIdentity, TEE_RPC, TEE_VALIDATOR, assert } from "./lib/env.js";
const id = await rpcIdentity(TEE_RPC);
console.log("tee identity:", id.toBase58());
assert(id.equals(TEE_VALIDATOR), "TEE_VALIDATOR in .env matches getIdentity of devnet-tee");
```

Run: `cd spikes && cp .env.example .env && npm i && npx tsx 00-identity.ts`
Expected: `ok: TEE_VALIDATOR ...`. If FAIL: replace `TEE_VALIDATOR` in `.env` with the printed identity and re-run.

- [ ] **Step 6: README and commit**

```markdown
# spikes/

Throwaway week-0 checks (spec §7.2). Each folder: cloned MagicBlock example + `check.ts` + `RESULT.md`.
Run: `cp .env.example .env && npm i && npx tsx NN-name/check.ts`. Keys in `keys/` (gitignored, devnet only).
```

```bash
printf '\nspikes/keys/\nspikes/**/target/\nspikes/**/node_modules/\nspikes/.env\n' >> .gitignore
git add rust-toolchain.toml .nvmrc .gitignore spikes/
git commit -m "chore: pin toolchain and add spikes workspace"
```

---

### Task 3: Check 1 — private-counter on devnet-tee, non-member read denied

**Files:**
- Create: `spikes/01-private-counter-tee/` (clone of `magicblock-engine-examples/private-counter/anchor`), `spikes/01-private-counter-tee/check.ts`, `spikes/01-private-counter-tee/RESULT.md`

**Interfaces:**
- Consumes: `spikes/lib/env.ts`
- Produces: deployed program id `PRIVATE_COUNTER_ID` (written to `RESULT.md`), `counterPDA` for user, used again by Task 4.

- [ ] **Step 1: Clone and build the example on the pinned toolchain**

```bash
cd spikes
git clone --depth 1 https://github.com/magicblock-labs/magicblock-engine-examples.git /tmp/mb-examples
cp -r /tmp/mb-examples/private-counter/anchor 01-private-counter-tee
cd 01-private-counter-tee
grep -n 'anchor-lang\|ephemeral-rollups-sdk' programs/private-counter/Cargo.toml
anchor keys sync
anchor build
```

Expected: Cargo.toml shows `anchor-lang = "1.0.2"` and `ephemeral-rollups-sdk = { version = "0.16.2", features = ["anchor", "access-control"] }`; `anchor build` finishes with `target/deploy/private_counter.so`.

- [ ] **Step 2: Deploy to devnet**

```bash
anchor deploy --provider.cluster https://rpc.magicblock.app/devnet --provider.wallet ../keys/payer.json
```

Record the program id in `RESULT.md`.

- [ ] **Step 3: Write the check script**

```typescript
// spikes/01-private-counter-tee/check.ts
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import {
  getAuthToken, permissionPdaFromAccount,
  PERMISSION_PROGRAM_ID, MAGIC_PROGRAM_ID, DELEGATION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, TEE_WS, TEE_VALIDATOR, loadKeypair, routerStatus, assert } from "../lib/env.js";
import idl from "./target/idl/private_counter.json" with { type: "json" };

const user = loadKeypair("user");
const stranger = loadKeypair("stranger");

// Base provider (user pays)
const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("counter"), user.publicKey.toBuffer()], program.programId);

// 1. initialize + delegate to TEE validator (base layer)
const info = await baseConn.getAccountInfo(counterPDA);
if (!info) {
  await program.methods.initialize().accounts({ authority: user.publicKey }).rpc();
}
if (!info || !info.owner.equals(DELEGATION_PROGRAM_ID)) {
  const sig = await program.methods.delegate().accounts({ authority: user.publicKey, validator: TEE_VALIDATOR }).rpc();
  console.log("delegate sig", sig);
}
// wait for router
let status = await routerStatus(counterPDA);
for (let i = 0; i < 20 && !status.isDelegated; i++) { await new Promise(r => setTimeout(r, 1000)); status = await routerStatus(counterPDA); }
assert(status.isDelegated, "router reports delegated");
assert(status.fqdn?.includes("tee"), `fqdn is TEE endpoint: ${status.fqdn}`);

// 2. TEE token for user, ER provider
const userToken = await getAuthToken(TEE_RPC, user.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, user.secretKey)));
const teeConnUser = new web3.Connection(`${TEE_RPC}?token=${userToken.token}`, { wsEndpoint: `${TEE_WS}?token=${userToken.token}`, commitment: "confirmed" });
const erProvider = new anchor.AnchorProvider(teeConnUser, new anchor.Wallet(user), { commitment: "confirmed" });
const erProgram = new Program(idl as anchor.Idl, erProvider);
const permissionPDA = permissionPdaFromAccount(counterPDA);
const VAULT_ID = new web3.PublicKey("EPHEMERAL_VAULT_ID_FROM_SDK"); // replace with the SDK export used by the example test (see tests/private-counter.ts)

// 3. init permission + set private (ER)
await erProgram.methods.initPermission().accountsPartial({
  authority: user.publicKey, counter: counterPDA, permission: permissionPDA,
  magicProgram: MAGIC_PROGRAM_ID, permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: VAULT_ID,
}).rpc();
await erProgram.methods.setPrivacy(true).accountsPartial({
  authority: user.publicKey, counter: counterPDA, permission: permissionPDA,
  magicProgram: MAGIC_PROGRAM_ID, permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: VAULT_ID,
}).rpc();
await erProgram.methods.increment().accounts({ counter: counterPDA }).rpc();

// 4. owner can read
const ownerView = await teeConnUser.getAccountInfo(counterPDA);
assert(ownerView !== null && ownerView.owner.equals(program.programId), "owner reads counter on TEE, owner = program");

// 5. base layer shows delegated, bytes unchanged
const baseView = await baseConn.getAccountInfo(counterPDA);
assert(baseView !== null && baseView.owner.equals(DELEGATION_PROGRAM_ID), "base: owner is Delegation Program");

// 6. stranger with own token cannot read
const strangerToken = await getAuthToken(TEE_RPC, stranger.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, stranger.secretKey)));
const teeConnStranger = new web3.Connection(`${TEE_RPC}?token=${strangerToken.token}`, "confirmed");
let strangerView: web3.AccountInfo<Buffer> | null = null; let strangerErr = "";
try { strangerView = await teeConnStranger.getAccountInfo(counterPDA); } catch (e) { strangerErr = String(e); }
console.log("stranger view:", strangerView, "err:", strangerErr);
assert(strangerView === null || strangerErr !== "", "stranger (own token) cannot read private counter");

// 7. no token cannot read
const teeConnNoToken = new web3.Connection(TEE_RPC, "confirmed");
let noTokenView: web3.AccountInfo<Buffer> | null = null; let noTokenErr = "";
try { noTokenView = await teeConnNoToken.getAccountInfo(counterPDA); } catch (e) { noTokenErr = String(e); }
assert(noTokenView === null || noTokenErr !== "", "no token cannot read private counter");
console.log("CHECK 1 PASS", { program: program.programId.toBase58(), counterPDA: counterPDA.toBase58() });
```

Before running: open `tests/private-counter.ts` in the cloned example and copy the exact `VAULT_ID` constant/import it uses (the SDK exports it; the name may be `EPHEMERAL_VAULT_ID` or similar). Replace the placeholder string.

- [ ] **Step 4: Run**

```bash
cd spikes && npx tsx 01-private-counter-tee/check.ts
```

Expected: all `ok:` lines then `CHECK 1 PASS`. If step 6 or 7 returns account data → **FAIL**, record raw response, stop, post in MagicBlock Discord with signature.

- [ ] **Step 5: RESULT.md and commit**

```markdown
# Check 1 — private-counter on devnet-tee
Status: PASS | FAIL
Program: <id>  Counter PDA: <pda>  Delegate sig: <sig>
Router fqdn: <fqdn>
Owner read: <bytes len>; Base owner: DELeGG…; Stranger read: <null|error text>; No-token read: <null|error text>
Decision: spec §2.1 permission model confirmed | → escalate, blocker
```

```bash
git add spikes/01-private-counter-tee/check.ts spikes/01-private-counter-tee/RESULT.md
git commit -m "spike: check 1 private-counter on devnet-tee"
```

(Do not commit `target/`; only `check.ts`, `RESULT.md`, and the example's `programs/`, `Anchor.toml`, `tests/` if modified.)

---

### Task 4: Check 6 — non-member transaction visibility on TEE RPC

**Files:**
- Create: `spikes/01-private-counter-tee/check-tx-visibility.ts`
- Modify: `spikes/01-private-counter-tee/RESULT.md` (append section "Check 6")

**Interfaces:**
- Consumes: `counterPDA`, deployed program from Task 3; user has done ≥1 `increment` on TEE.

- [ ] **Step 1: Write the script**

```typescript
// spikes/01-private-counter-tee/check-tx-visibility.ts
import { web3 } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { TEE_RPC, loadKeypair, assert } from "../lib/env.js";

const user = loadKeypair("user"); const stranger = loadKeypair("stranger");
const PROGRAM_ID = new web3.PublicKey(process.argv[2]); // from RESULT.md
const [counterPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("counter"), user.publicKey.toBuffer()], PROGRAM_ID);

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}
const userTok = (await getAuthToken(TEE_RPC, user.publicKey, m => Promise.resolve(nacl.sign.detached(m, user.secretKey)))).token;
const strTok = (await getAuthToken(TEE_RPC, stranger.publicKey, m => Promise.resolve(nacl.sign.detached(m, stranger.secretKey)))).token;

const ownerSigs = await rpc(`${TEE_RPC}?token=${userTok}`, "getSignaturesForAddress", [counterPDA.toBase58(), { limit: 5 }]);
console.log("owner sigs:", JSON.stringify(ownerSigs).slice(0, 300));
assert(Array.isArray(ownerSigs.result) && ownerSigs.result.length > 0, "owner sees own signatures");
const sig = ownerSigs.result[0].signature;

for (const [label, url] of [["stranger", `${TEE_RPC}?token=${strTok}`], ["no-token", TEE_RPC]] as const) {
  const sigs = await rpc(url, "getSignaturesForAddress", [counterPDA.toBase58(), { limit: 5 }]);
  const tx = await rpc(url, "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
  console.log(label, "sigs:", JSON.stringify(sigs).slice(0, 200));
  console.log(label, "tx:", JSON.stringify(tx).slice(0, 200));
  const sigsHidden = sigs.error !== undefined || !Array.isArray(sigs.result) || sigs.result.length === 0;
  const txHidden = tx.error !== undefined || tx.result === null;
  assert(sigsHidden, `${label}: getSignaturesForAddress hidden`);
  assert(txHidden, `${label}: getTransaction hidden`);
}
console.log("CHECK 6 PASS");
```

- [ ] **Step 2: Run**

```bash
cd spikes && npx tsx 01-private-counter-tee/check-tx-visibility.ts <PROGRAM_ID>
```

Expected: `CHECK 6 PASS`. If a stranger sees signatures or the tx message (account keys) → FAIL → spec risk #4 activates: record exactly what leaked (signatures only? account keys? logs?).

- [ ] **Step 3: Append to RESULT.md and commit**

```bash
git add spikes/01-private-counter-tee/check-tx-visibility.ts spikes/01-private-counter-tee/RESULT.md
git commit -m "spike: check 6 tx visibility for non-members on TEE"
```

---

### Task 5: Check 2 — Ephemeral SPL Token inside the TEE

**Files:**
- Create: `spikes/02-espl-tee/check.ts`, `spikes/02-espl-tee/RESULT.md`

**Interfaces:**
- Produces: a devnet test mint pubkey `SPIKE_MINT` (record in RESULT.md; reusable by Task 10).

- [ ] **Step 1: Write the script**

```typescript
// spikes/02-espl-tee/check.ts
import { web3 } from "@coral-xyz/anchor";
import { Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import nacl from "tweetnacl";
import { delegateSpl, transferSpl, deriveRentPda, getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, TEE_VALIDATOR, loadKeypair, assert } from "../lib/env.js";

const payer = loadKeypair("payer"); const user = loadKeypair("user"); const pool = loadKeypair("stranger"); // "pool" = second owner

// 1. mint + ATAs + fund user
const mint = await createMint(baseConn, payer, payer.publicKey, null, 6);
const userAta = await getOrCreateAssociatedTokenAccount(baseConn, payer, mint, user.publicKey);
await getOrCreateAssociatedTokenAccount(baseConn, payer, mint, pool.publicKey);
await mintTo(baseConn, payer, mint, userAta.address, payer, 1_000_000_000n); // 1000 dUSDC
console.log("mint", mint.toBase58());

// 2. fund rent PDA (shuttle rent) once
const [rentPda] = deriveRentPda();
const rentBal = await baseConn.getBalance(rentPda);
if (rentBal < 0.1 * LAMPORTS_PER_SOL) {
  await web3.sendAndConfirmTransaction(baseConn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: rentPda, lamports: 0.2 * LAMPORTS_PER_SOL })), [payer]);
}

// 3. deposit+delegate both owners to the TEE validator (base)
for (const owner of [user, pool]) {
  const ixs = await delegateSpl(owner.publicKey, mint, owner === user ? 500_000_000n : 0n, {
    validator: TEE_VALIDATOR, payer: payer.publicKey, initVaultIfMissing: true, initAtasIfMissing: true, idempotent: false,
  });
  const sig = await web3.sendAndConfirmTransaction(baseConn, new Transaction().add(...ixs), [owner, payer], { commitment: "confirmed" });
  console.log("delegateSpl", owner.publicKey.toBase58(), sig);
}

// 4. transfer inside the TEE ER as user
const tok = (await getAuthToken(TEE_RPC, user.publicKey, m => Promise.resolve(nacl.sign.detached(m, user.secretKey)))).token;
const tee = new web3.Connection(`${TEE_RPC}?token=${tok}`, "confirmed");
const ixs = await transferSpl(user.publicKey, pool.publicKey, mint, 100_000_000n, { visibility: "public", fromBalance: "ephemeral", toBalance: "ephemeral" });
const tx = new Transaction().add(...ixs);
tx.feePayer = user.publicKey; tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash; tx.sign(user);
const erSig = await tee.sendRawTransaction(tx.serialize());
await tee.confirmTransaction(erSig, "confirmed");
console.log("er transfer", erSig);

// 5. balances on ER
const poolAtaEr = await getAccount(tee, getAssociatedTokenAddressSync(mint, pool.publicKey));
const userAtaEr = await getAccount(tee, getAssociatedTokenAddressSync(mint, user.publicKey));
console.log("ER balances user/pool:", userAtaEr.amount, poolAtaEr.amount);
assert(poolAtaEr.amount === 100_000_000n, "pool ER balance = 100 dUSDC after transfer");
assert(userAtaEr.amount === 400_000_000n, "user ER balance = 400 dUSDC");
console.log("CHECK 2 PASS", { mint: mint.toBase58() });
```

- [ ] **Step 2: Run and record**

```bash
cd spikes && npx tsx 02-espl-tee/check.ts
```

Expected: `CHECK 2 PASS`. On `EphemeralAtaValidatorMismatch` (`0x7`) — the ATA was delegated to another validator earlier; create fresh keypairs. On any other failure → spec risk #1 → Plan B (own escrow vault on L1) becomes the custody design; write that decision in RESULT.md.

Also record in RESULT.md: whether `getAccount(tee, strangerConnection)` of the user's ER ATA is readable by a non-owner (run once with the `pool` token) — this confirms spec §2.1 rule "margin is accounting, not tokens".

```bash
git add spikes/02-espl-tee && git commit -m "spike: check 2 ephemeral SPL token in TEE"
```

---

### Task 6: Check 3 — ER reads a non-delegated L1 account

**Files:**
- Create: `spikes/03-l1-readonly-clone/` (copy of `spikes/01-private-counter-tee` program, renamed `l1_readonly`), `check.ts`, `RESULT.md`
- Modify: `programs/l1_readonly/src/lib.rs` — add `Config` PDA and `increment_by_config`

- [ ] **Step 1: Add the instruction that reads an L1-only account while writing the delegated counter**

```rust
// add to lib.rs of the copied program (keep everything else)
pub const CONFIG_SEED: &[u8] = b"config";

#[account]
pub struct Config { pub step: u64, pub authority: Pubkey }

pub fn init_config(ctx: Context<InitConfig>, step: u64) -> Result<()> {
    ctx.accounts.config.step = step;
    ctx.accounts.config.authority = ctx.accounts.authority.key();
    Ok(())
}

pub fn set_step(ctx: Context<SetStep>, step: u64) -> Result<()> {
    ctx.accounts.config.step = step;
    Ok(())
}

/// Runs on the ER. `config` is NOT delegated; it must be cloned read-only.
pub fn increment_by_config(ctx: Context<IncrementByConfig>) -> Result<()> {
    let c = &mut ctx.accounts.counter;
    c.count = c.count.checked_add(ctx.accounts.config.step).unwrap();
    Ok(())
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = authority, space = 8 + 8 + 32, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)] pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SetStep<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = authority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct IncrementByConfig<'info> {
    #[account(mut, seeds = [COUNTER_SEED, counter.authority.as_ref()], bump)]
    pub counter: Account<'info, Counter>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
}
```

Register the three handlers in the `#[program]` module. `anchor keys sync && anchor build && anchor deploy --provider.cluster https://rpc.magicblock.app/devnet --provider.wallet ../keys/payer.json`.

- [ ] **Step 2: Check script**

```typescript
// spikes/03-l1-readonly-clone/check.ts
// Setup identical to 01/check.ts steps 1–3 (initialize, delegate to TEE_VALIDATOR, initPermission, setPrivacy(true)) — copy them, program name l1_readonly.
// Then:
const [configPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
if (!(await baseConn.getAccountInfo(configPDA))) await program.methods.initConfig(new anchor.BN(5)).accounts({ authority: user.publicKey }).rpc();

const before = (await erProgram.account.counter.fetch(counterPDA)).count.toNumber();
await erProgram.methods.incrementByConfig().accounts({ counter: counterPDA, config: configPDA }).rpc();
const after1 = (await erProgram.account.counter.fetch(counterPDA)).count.toNumber();
assert(after1 === before + 5, "ER read config.step=5 from non-delegated L1 account");

// change on L1, expect ER to see fresh value
await program.methods.setStep(new anchor.BN(7)).accounts({ authority: user.publicKey }).rpc();
await new Promise(r => setTimeout(r, 3000));
await erProgram.methods.incrementByConfig().accounts({ counter: counterPDA, config: configPDA }).rpc();
const after2 = (await erProgram.account.counter.fetch(counterPDA)).count.toNumber();
console.log({ before, after1, after2 });
assert(after2 === after1 + 7, "ER sees updated L1 value (7) without re-delegation");
console.log("CHECK 3 PASS");
```

- [ ] **Step 3: Run, record, commit**

Run: `cd spikes && npx tsx 03-l1-readonly-clone/check.ts`
Expected: `CHECK 3 PASS`. If the first increment fails with an account-not-found style error → ER does not clone; if `after2 === after1 + 5` → ER clones once and caches (stale). Either → spec risk #2: all ER-read accounts must be delegated; note the exact behavior (no clone vs stale clone) in RESULT.md because "stale" allows `Config` on L1 with a re-delegation trigger, "no clone" does not.

```bash
git add spikes/03-l1-readonly-clone/programs spikes/03-l1-readonly-clone/check.ts spikes/03-l1-readonly-clone/RESULT.md spikes/03-l1-readonly-clone/Anchor.toml
git commit -m "spike: check 3 read-only clone of L1 account in TEE ER"
```

---

### Task 7: Check 4 — Pricing Oracle SOL/USD readable and fresh inside devnet-tee

**Files:**
- Create: `spikes/04-oracle-tee/check.ts`, `spikes/04-oracle-tee/RESULT.md`

- [ ] **Step 1: Get the feed PDA seeds from the binary-prediction test**

```bash
grep -n "PRICE_FEED_SEED\|ORACLE_PROGRAM_ID\|ORACLE_PROVIDER\|ORACLE_SYMBOL\|priceFeed" /tmp/mb-examples/binary-prediction/anchor/tests/binary-prediction.ts | head -20
```

Copy the exact seed string, provider string (`pyth-lazer`) and symbol for SOL/USD (the example uses Lazer feed id as symbol; SOL/USD Lazer id is `6`; confirm from the test) into the script constants.

- [ ] **Step 2: Script**

```typescript
// spikes/04-oracle-tee/check.ts
import { web3 } from "@coral-xyz/anchor";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import * as anchor from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, loadKeypair, assert } from "../lib/env.js";

const ORACLE_PROGRAM_ID = new web3.PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const PRICE_FEED_SEED = "<copy from test>";
const PROVIDER = "pyth-lazer";
const SYMBOL = "<copy SOL/USD symbol from test>";
const [feed] = web3.PublicKey.findProgramAddressSync([Buffer.from(PRICE_FEED_SEED), Buffer.from(PROVIDER), Buffer.from(SYMBOL)], ORACLE_PROGRAM_ID);
console.log("feed", feed.toBase58());

const user = loadKeypair("user");
const tok = (await getAuthToken(TEE_RPC, user.publicKey, m => Promise.resolve(nacl.sign.detached(m, user.secretKey)))).token;
const tee = new web3.Connection(`${TEE_RPC}?token=${tok}`, "confirmed");

async function read(conn: web3.Connection, label: string) {
  const receiver = new PythSolanaReceiver({ connection: conn, wallet: new anchor.Wallet(user) });
  const acc = await receiver.receiver.account.priceUpdateV2.fetch(feed);
  const now = Math.floor(Date.now() / 1000);
  const age = now - Number(acc.priceMessage.publishTime);
  console.log(label, { price: acc.priceMessage.price.toString(), expo: acc.priceMessage.exponent, conf: acc.priceMessage.conf.toString(), postedSlot: acc.postedSlot.toString(), ageSec: age });
  return { acc, age };
}
const base = await read(baseConn, "base");
const t1 = await read(tee, "tee#1");
await new Promise(r => setTimeout(r, 2000));
const t2 = await read(tee, "tee#2");

assert(Number(t1.acc.postedSlot) > 0, "tee: posted_slot > 0");
assert(t1.age < 5, `tee: publish_time age < 5s (got ${t1.age})`);
assert(Number(t1.acc.priceMessage.price) > 0, "tee: price > 0");
assert(t2.acc.priceMessage.publishTime.toString() !== t1.acc.priceMessage.publishTime.toString(), "tee: feed updates between reads (2s)");
console.log("CHECK 4 PASS");
```

- [ ] **Step 3: Run, record, commit**

Run: `cd spikes && npx tsx 04-oracle-tee/check.ts`
Expected: `CHECK 4 PASS`, both TEE reads younger than 5 s and different publish times. If age is large or reads identical → oracle not republished into TEE region: **blocker**, escalate to MagicBlock; interim fallback = read feed on base and pass price via crank (documented in RESULT.md as degraded mode).

```bash
git add spikes/04-oracle-tee && git commit -m "spike: check 4 pricing oracle freshness in TEE"
```

---

### Task 8: Check 5 — scheduler (crank) ticks inside devnet-tee

**Files:**
- Create: `spikes/05-crank-tee/` (copy of `/tmp/mb-examples/crank-counter/anchor`), `check.ts`, `RESULT.md`

- [ ] **Step 1: Build and deploy the crank-counter example to devnet**

```bash
cp -r /tmp/mb-examples/crank-counter/anchor spikes/05-crank-tee && cd spikes/05-crank-tee
grep -n "magicblock-magic-program-api\|ephemeral-rollups-sdk" programs/*/Cargo.toml
anchor keys sync && anchor build && anchor deploy --provider.cluster https://rpc.magicblock.app/devnet --provider.wallet ../keys/payer.json
```

- [ ] **Step 2: Script — delegate to the TEE validator, schedule 1000 ms, observe**

```typescript
// spikes/05-crank-tee/check.ts
// Read tests/ in the example for the exact method names (schedule_increment args: task_id, execution_interval_millis, iterations) and account names; mirror them here.
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { getAuthToken, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, TEE_VALIDATOR, loadKeypair, routerStatus, assert } from "../lib/env.js";
import idl from "./target/idl/crank_counter.json" with { type: "json" };

const user = loadKeypair("user");
const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("counter"), user.publicKey.toBuffer()], program.programId); // check seed in lib.rs

if (!(await baseConn.getAccountInfo(counterPDA))) await program.methods.initialize().accounts({ payer: user.publicKey }).rpc();
await program.methods.delegate().accounts({ payer: user.publicKey }).remainingAccounts([{ pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false }]).rpc();
let st = await routerStatus(counterPDA); for (let i = 0; i < 20 && !st.isDelegated; i++) { await new Promise(r => setTimeout(r, 1000)); st = await routerStatus(counterPDA); }
assert(st.isDelegated && st.fqdn?.includes("tee"), "delegated to TEE");

const tok = (await getAuthToken(TEE_RPC, user.publicKey, m => Promise.resolve(nacl.sign.detached(m, user.secretKey)))).token;
const tee = new web3.Connection(`${TEE_RPC}?token=${tok}`, "confirmed");
const erProgram = new Program(idl as anchor.Idl, new anchor.AnchorProvider(tee, new anchor.Wallet(user), { commitment: "confirmed" }));

const taskId = new anchor.BN(Date.now()); // collision-resistant enough for a spike
await erProgram.methods.scheduleIncrement({ taskId, executionIntervalMillis: new anchor.BN(1000), iterations: new anchor.BN(30) })
  .accounts({ payer: user.publicKey, counter: counterPDA, magicProgram: MAGIC_PROGRAM_ID, program: program.programId }).rpc();

const c0 = (await erProgram.account.counter.fetch(counterPDA)).count.toNumber();
const samples: number[] = [];
for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 1000)); samples.push((await erProgram.account.counter.fetch(counterPDA)).count.toNumber()); }
console.log({ c0, samples });
const ticks = samples[samples.length - 1] - c0;
assert(ticks >= 12, `>=12 ticks in 20s at 1000ms interval (got ${ticks})`);
console.log("CHECK 5 PASS");
```

- [ ] **Step 3: Run, record, commit**

Run: `cd spikes && npx tsx 05-crank-tee/check.ts`
Expected: `CHECK 5 PASS`; record actual ticks/20 s (this number sizes spec §3.5 cadence). If `<12` or schedule rejected → spec risk #3: `scripts/crank-fallback` becomes primary from week 2; still record whether ticks happen at all.

```bash
git add spikes/05-crank-tee/check.ts spikes/05-crank-tee/RESULT.md spikes/05-crank-tee/Anchor.toml spikes/05-crank-tee/programs
git commit -m "spike: check 5 scheduler ticks in TEE"
```

---

### Task 9: Check 7 — Magic Action writes an L1 account after commit; direct call rejected

**Files:**
- Create: `spikes/06-magic-action/` (copy of `/tmp/mb-examples/magic-actions/anchor`), `check.ts`, `RESULT.md`

- [ ] **Step 1: Confirm the example's action handler has the escrow signer check**

```bash
grep -n "escrow\|ephemeral_balance_pda_from_payer\|#\[action\]" spikes/06-magic-action/programs/*/src/lib.rs
```

If the handler lacks `#[account(signer, address = ephemeral_balance_pda_from_payer(&escrow_auth.key(), 255))] pub escrow`, add it exactly as in the magicblock skill `references/magic-actions.md` "The check" block, then `anchor build && anchor deploy` to devnet (same flags as Task 3 Step 2).

- [ ] **Step 2: Script**

```typescript
// spikes/06-magic-action/check.ts
// Mirror tests/ of the example for method/account names. Flow:
// 1. initialize counter + leaderboard on base; delegate counter to TEE_VALIDATOR; initPermission/setPrivacy if the example supports it (optional).
// 2. On TEE: increment; then commitAndUpdateLeaderboard (MagicIntentBundleBuilder commit + add_post_commit_actions).
// 3. Extract base signature with GetCommitmentSignature(erSig, tee); confirm on base.
// 4. Poll base leaderboard.highScore until == counter.count (timeout 60s) → assert.
// 5. Direct call: program.methods.updateLeaderboard().accounts({leaderboard, counter, sourceProgram, escrowAuth: user.publicKey, escrow: <derived pda>}) on base without delegation-program signature → expect error containing "Unauthorized" or signature verification failure.
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";
// ... (setup as in 01/check.ts)
const erSig = await erProgram.methods.commitAndUpdateLeaderboard().accounts({ payer: user.publicKey, counter: counterPDA, leaderboard: leaderboardPDA, programId: program.programId }).rpc();
const baseSig = await GetCommitmentSignature(erSig, tee);
await baseConn.confirmTransaction(baseSig, "confirmed");
let hs = -1; for (let i = 0; i < 60; i++) { hs = (await program.account.leaderboard.fetch(leaderboardPDA)).highScore.toNumber(); if (hs > 0) break; await new Promise(r => setTimeout(r, 1000)); }
assert(hs > 0, `leaderboard on L1 updated by Magic Action (highScore=${hs})`);

let directErr = "";
try { await program.methods.updateLeaderboard().accounts({ leaderboard: leaderboardPDA, counter: counterPDA, sourceProgram: program.programId, escrowAuth: user.publicKey, escrow: escrowPda }).rpc(); } catch (e) { directErr = String(e); }
assert(directErr !== "", `direct call to #[action] handler rejected: ${directErr.slice(0, 120)}`);
console.log("CHECK 7 PASS", { erSig, baseSig });
```

`escrowPda`: derive with the SDK's `ephemeralBalancePdaFromPayer(user.publicKey, 255)` if exported in TS; otherwise pass any pubkey — the point is that a non-delegation-program caller cannot produce the escrow signature.

- [ ] **Step 3: Run, record, commit**

Run: `cd spikes && npx tsx 06-magic-action/check.ts`
Expected: `CHECK 7 PASS`. Record base signature — this is the 13F mechanism proof. If the action never lands → inspect base tx logs; if the direct call succeeds → the escrow check is missing or wrong; fix before recording PASS.

```bash
git add spikes/06-magic-action/check.ts spikes/06-magic-action/RESULT.md spikes/06-magic-action/programs spikes/06-magic-action/Anchor.toml
git commit -m "spike: check 7 magic action to L1 with escrow-signer check"
```

---

### Task 10: Check 9 — session key as ER fee payer after one-time top-up

**Files:**
- Create: `spikes/07-session-payer/check.ts`, `spikes/07-session-payer/RESULT.md`

**Interfaces:**
- Consumes: private-counter program from Task 3 (its `increment` accepts only `counter`; the session token is not validated — this spike tests **payer mechanics only**, not session validation).

- [ ] **Step 1: Script**

```typescript
// spikes/07-session-payer/check.ts
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, TEE_WS, loadKeypair, assert } from "../lib/env.js";
import idl from "../01-private-counter-tee/target/idl/private_counter.json" with { type: "json" };

const user = loadKeypair("user"); const session = loadKeypair("session");
const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("counter"), user.publicKey.toBuffer()], program.programId);

// 1. create session V2 on base with 0.005 SOL one-time top-up to the session signer
const stm = new SessionTokenManager(baseProvider.wallet as anchor.Wallet, baseConn, "devnet");
const expiry = Math.floor(Date.now() / 1000) + 3600;
const tx = await stm.program.methods.createSessionV2(true, new BN(expiry), new BN(0.005 * web3.LAMPORTS_PER_SOL))
  .accounts({ targetProgram: program.programId, sessionSigner: session.publicKey, feePayer: user.publicKey, authority: user.publicKey }).transaction();
const sig = await baseProvider.sendAndConfirm(tx, [session]);
console.log("createSessionV2", sig, "session balance:", await baseConn.getBalance(session.publicKey));

// 2. session key authenticates to TEE (must be a permission member — Task 3 set members=[authority] only, so first update permission to include session)
// Use erProgram.methods.setPrivacy(true) variant of the example if it accepts a member list; otherwise add `session` to the example's set_privacy members in lib.rs, rebuild, redeploy (record in RESULT.md).
const sTok = (await getAuthToken(TEE_RPC, session.publicKey, m => Promise.resolve(nacl.sign.detached(m, session.secretKey)))).token;
const tee = new web3.Connection(`${TEE_RPC}?token=${sTok}`, { wsEndpoint: `${TEE_WS}?token=${sTok}`, commitment: "confirmed" });

// 3. session key is fee payer and sole signer of an ER tx
const ix = await program.methods.increment().accounts({ counter: counterPDA }).instruction();
const erTx = new web3.Transaction().add(ix);
erTx.feePayer = session.publicKey;
erTx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
erTx.sign(session);
const erSig = await tee.sendRawTransaction(erTx.serialize());
await tee.confirmTransaction(erSig, "confirmed");
console.log("er tx paid by session", erSig);
const t = await tee.getTransaction(erSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
assert(t !== null && t.meta?.err === null, "ER tx with session key as payer succeeded");
console.log("fee charged:", t?.meta?.fee);
console.log("CHECK 9 PASS");
```

- [ ] **Step 2: Run, record, commit**

Run: `cd spikes && npx tsx 07-session-payer/check.ts`
Expected: `CHECK 9 PASS`, `fee charged: 0` (or small). Record whether the session key needed base lamports at all. If the ER rejects the payer (e.g. account not found) → spec §5.4: payer = our sponsor PDA; note in RESULT.md.

```bash
git add spikes/07-session-payer && git commit -m "spike: check 9 session key as ER fee payer"
```

---

### Task 11: Expo skeleton with MWA connect on the emulator (prerequisite for checks 8, 10, 11)

**Files:**
- Create: `app/` via `create-solana-dapp` (Solana Mobile Expo template)
- Modify: `app/polyfill.js`, `app/index.js`, `app/package.json`

**Interfaces:**
- Produces: running Android dev build with `MobileWalletProvider`; `app/src/lib/solana.ts` exporting `baseConn`, `TEE_RPC`.

- [ ] **Step 1: Scaffold**

```bash
cd /Users/vitalikcholan/Projects/mobile_perp_dex
npm create solana-dapp@latest app -- --template solana-mobile-expo   # pick "Solana Mobile" if prompted
cd app && npm i @magicblock-labs/ephemeral-rollups-sdk@0.17.0 @coral-xyz/anchor@0.32.1 tweetnacl react-native-quick-crypto react-native-nitro-modules expo-secure-store react-native-mmkv
```

If the template flag name differs, run interactively and choose the Solana Mobile framework.

- [ ] **Step 2: Polyfill first**

```javascript
// app/polyfill.js
import { install } from "react-native-quick-crypto";
install();
```

```javascript
// app/index.js
import "./polyfill";
import "expo-router/entry";
```

Ensure `package.json` has `"main": "./index.js"`.

- [ ] **Step 3: Android emulator + Mock MWA wallet**

```bash
# Android Studio: create AVD Pixel 7, arm64, API 34, start it
# Install Mock MWA wallet APK from solana-mobile/mobile-wallet-adapter releases (fakewallet) via `adb install`
npx expo run:android
```

Expected: app launches on emulator, "Connect" opens the Mock Wallet bottom sheet, address shown after authorize.

- [ ] **Step 4: Commit (respecting Task 1 gate)**

If gate allows: `git add app && git commit -m "feat(app): Expo skeleton with MWA connect"`. Else commit on local branch `pre-hackathon` only.

---

### Task 12: Checks 8, 10, 11 — MWA signs ER-blockhash tx; WS with token in RN; TDX attestation in Hermes

**Files:**
- Create: `app/src/spikes/Check8.tsx`, `app/src/spikes/Check10.tsx`, `app/src/spikes/Check11.tsx`, `app/app/spikes.tsx` (route listing three buttons), `spikes/08-mobile-checks/RESULT.md`

- [ ] **Step 1: Check 8 — MWA signs a transaction whose blockhash comes from the TEE**

```tsx
// app/src/spikes/Check8.tsx
import { useMobileWallet } from "@wallet-ui/react-native-web3js";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Button, Text, View } from "react-native";
import { useState } from "react";

const TEE_RPC = "https://devnet-tee.magicblock.app";
const PROGRAM_ID = new PublicKey("<PRIVATE_COUNTER_ID from spikes/01>");
const INCREMENT_DISC = Uint8Array.from([/* 8-byte discriminator of `increment` from target/idl/private_counter.json */]);

export function Check8() {
  const { account, signTransaction, signMessage } = useMobileWallet();
  const [out, setOut] = useState("");
  async function run() {
    if (!account) return setOut("connect first");
    const owner = account.publicKey;
    // token: wallet signs the TEE challenge (one MWA prompt)
    const tok = (await getAuthToken(TEE_RPC, owner, (m) => signMessage(m))).token;
    const tee = new Connection(`${TEE_RPC}?token=${tok}`, "confirmed");
    const [counter] = PublicKey.findProgramAddressSync([Buffer.from("counter"), owner.toBuffer()], PROGRAM_ID);
    const tx = new Transaction().add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: counter, isSigner: false, isWritable: true }], data: Buffer.from(INCREMENT_DISC) }));
    tx.feePayer = owner;
    tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;   // ER blockhash
    const signed = await signTransaction(tx);                            // MWA bottom sheet
    const sig = await tee.sendRawTransaction(signed.serialize());
    await tee.confirmTransaction(sig, "confirmed");
    setOut(`CHECK 8 PASS ${sig}`);
  }
  return <View><Button title="Check 8: MWA signs ER tx" onPress={() => run().catch(e => setOut("FAIL " + String(e)))} /><Text selectable>{out}</Text></View>;
}
```

Precondition: the emulator wallet's pubkey must own a delegated, private counter (run Task 3 flow once with that pubkey exported from Mock Wallet, or add the wallet pubkey as a permission member). Record which path was used.

- [ ] **Step 2: Check 10 — WS `accountSubscribe` with token from RN**

```tsx
// app/src/spikes/Check10.tsx
import { Connection, PublicKey } from "@solana/web3.js";
// ... same token acquisition as Check8
const tee = new Connection(`${TEE_RPC}?token=${tok}`, { wsEndpoint: `wss://devnet-tee.magicblock.app?token=${tok}`, commitment: "confirmed" });
const t0 = Date.now();
const subId = tee.onAccountChange(counter, (info) => setOut(`CHECK 10 PASS update after ${Date.now() - t0}ms, ${info.data.length} bytes`));
// trigger a change from the spikes CLI: `npx tsx 01-private-counter-tee/check.ts` (it increments) or a dedicated increment script; expect callback within 30s
setTimeout(() => tee.removeAccountChangeListener(subId), 60_000);
```

Expected: callback fires. If the WS never connects in RN → RESULT: fallback poll 1 s (spec §5.5).

- [ ] **Step 3: Check 11 — `verifyTeeRpcIntegrity` under Hermes**

```tsx
// app/src/spikes/Check11.tsx
import { verifyTeeRpcIntegrity } from "@magicblock-labs/ephemeral-rollups-sdk";
async function run() {
  const t0 = Date.now();
  const ok = await verifyTeeRpcIntegrity("https://devnet-tee.magicblock.app");
  setOut(`CHECK 11 ${ok ? "PASS" : "FAIL"} in ${Date.now() - t0}ms`);
}
```

Expected outcomes to record verbatim: PASS with time; or error text (likely `WebAssembly is not defined` under Hermes). If it fails: try `expo-jsc`/JSC engine toggle in `app.json` (`"jsEngine": "jsc"`) once and record whether that passes — this decides spec risk #6 (shim vs v1 with honest note).

- [ ] **Step 4: RESULT.md and commit**

```markdown
# Checks 8 / 10 / 11 — mobile
Emulator: Pixel 7 arm64 API 34, Mock MWA wallet <version>
Check 8: PASS/FAIL — sig <…> | error <…>
Check 10: PASS/FAIL — first update latency <…> ms | fallback poll
Check 11: PASS/FAIL — <ms> | error <verbatim>; JSC attempt: <result>
Decisions: risk #7 …, §5.5 WS vs poll …, risk #6 …
```

```bash
git add spikes/08-mobile-checks/RESULT.md app/src/spikes app/app/spikes.tsx
git commit -m "spike: mobile checks 8/10/11 (MWA ER blockhash, WS token, TDX attestation in Hermes)"
```

---

### Task 13: Red math tests — `math.rs` interface fixed by failing tests (25–26.09)

**Files:**
- Create: `programs/dexxer_core/Cargo.toml`, `programs/dexxer_core/src/lib.rs`, `programs/dexxer_core/src/math.rs`, `programs/dexxer_core/src/errors.rs`, `Anchor.toml`, `Cargo.toml` (workspace)
- Test: `programs/dexxer_core/src/math.rs` (`#[cfg(test)]` + proptest)

**Interfaces:**
- Produces (for week 1): exact signatures below; every function returns `Result<T, MathError>`; all prices 1e6, sizes 1e9, USD 1e6, rates bps.

```rust
pub const PRICE_SCALE: u128 = 1_000_000;
pub const SIZE_SCALE: u128 = 1_000_000_000;
pub const BPS: u128 = 10_000;
pub enum Side { Long, Short }
pub fn notional(size: u64, price: u64) -> Result<u64, MathError>;           // size*price/SIZE_SCALE, round down
pub fn upnl(side: Side, size: u64, entry: u64, mark: u64) -> Result<i64, MathError>;
pub fn fee(notional: u64, bps: u16) -> Result<u64, MathError>;             // round UP
pub fn required_margin(notional: u64, imr_bps: u32) -> Result<u64, MathError>; // round UP
pub fn equity(margin: u64, upnl: i64, close_fee: u64) -> Result<i64, MathError>;
pub fn liq_price(side: Side, entry: u64, size: u64, margin: u64, mmr_bps: u32) -> Result<u64, MathError>;
pub fn is_liquidatable(equity: i64, notional: u64, mmr_bps: u32) -> bool;
pub fn vwap_entry(old_size: u64, old_entry: u64, add_size: u64, add_price: u64) -> Result<u64, MathError>;
```

- [ ] **Step 1: Workspace skeleton**

```bash
anchor init dexxer_core --no-git   # then move: mv dexxer_core/programs/dexxer_core programs/ ; mv dexxer_core/Anchor.toml . ; rm -rf dexxer_core
```

`programs/dexxer_core/Cargo.toml`:

```toml
[package]
name = "dexxer_core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "dexxer_core"

[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
idl-build = ["anchor-lang/idl-build"]

[dependencies]
anchor-lang = "=1.0.2"
ephemeral-rollups-sdk = { version = "0.16.2", features = ["anchor", "access-control"] }

[dev-dependencies]
proptest = "1.5"
```

- [ ] **Step 2: Write the failing tests**

```rust
// programs/dexxer_core/src/math.rs
use crate::errors::MathError;

pub const PRICE_SCALE: u128 = 1_000_000;
pub const SIZE_SCALE: u128 = 1_000_000_000;
pub const BPS: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side { Long, Short }

pub fn notional(_size: u64, _price: u64) -> Result<u64, MathError> { unimplemented!() }
pub fn upnl(_side: Side, _size: u64, _entry: u64, _mark: u64) -> Result<i64, MathError> { unimplemented!() }
pub fn fee(_notional: u64, _bps: u16) -> Result<u64, MathError> { unimplemented!() }
pub fn required_margin(_notional: u64, _imr_bps: u32) -> Result<u64, MathError> { unimplemented!() }
pub fn equity(_margin: u64, _upnl: i64, _close_fee: u64) -> Result<i64, MathError> { unimplemented!() }
pub fn liq_price(_side: Side, _entry: u64, _size: u64, _margin: u64, _mmr_bps: u32) -> Result<u64, MathError> { unimplemented!() }
pub fn is_liquidatable(_equity: i64, _notional: u64, _mmr_bps: u32) -> bool { unimplemented!() }
pub fn vwap_entry(_old_size: u64, _old_entry: u64, _add_size: u64, _add_price: u64) -> Result<u64, MathError> { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const P: u64 = 150_000_000;      // $150.000000
    const S: u64 = 10_000_000_000;   // 10 SOL

    #[test]
    fn notional_10_sol_at_150() { assert_eq!(notional(S, P).unwrap(), 1_500_000_000); } // $1500

    #[test]
    fn upnl_long_up_10pct() { assert_eq!(upnl(Side::Long, S, P, 165_000_000).unwrap(), 150_000_000); }
    #[test]
    fn upnl_short_up_10pct() { assert_eq!(upnl(Side::Short, S, P, 165_000_000).unwrap(), -150_000_000); }

    #[test]
    fn fee_rounds_up() { assert_eq!(fee(1_000_001, 6).unwrap(), 601); } // 1_000_001*6/10_000 = 600.0006 → 601

    #[test]
    fn required_margin_10x() { assert_eq!(required_margin(1_500_000_000, 1000).unwrap(), 150_000_000); }

    #[test]
    fn liq_price_long_10x_mmr5() {
        // entry 150, lev 10 → 1/lev = 0.10, mmr 0.05 → liq = 150 * (1 - 0.10 + 0.05) = 142.5
        assert_eq!(liq_price(Side::Long, P, S, 150_000_000, 500).unwrap(), 142_500_000);
    }
    #[test]
    fn liq_price_short_10x_mmr5() {
        assert_eq!(liq_price(Side::Short, P, S, 150_000_000, 500).unwrap(), 157_500_000);
    }

    #[test]
    fn liquidatable_below_mmr() {
        let n = 1_500_000_000u64;
        assert!(is_liquidatable(74_999_999, n, 500));
        assert!(!is_liquidatable(75_000_000, n, 500));
    }

    #[test]
    fn vwap_two_equal_lots() { assert_eq!(vwap_entry(S, P, S, 160_000_000).unwrap(), 155_000_000); }

    #[test]
    fn overflow_is_error() { assert_eq!(notional(u64::MAX, u64::MAX), Err(MathError::Overflow)); }

    proptest! {
        #[test]
        fn liq_long_below_entry_short_above(entry in 1_000_000u64..1_000_000_000_000, size in 1_000_000u64..1_000_000_000_000, lev_bps in 10_000u32..100_000) {
            let n = notional(size, entry).unwrap();
            let margin = (n as u128 * BPS / lev_bps as u128) as u64;
            prop_assume!(margin > 0);
            let l = liq_price(Side::Long, entry, size, margin, 500).unwrap();
            let s = liq_price(Side::Short, entry, size, margin, 500).unwrap();
            prop_assert!(l < entry && entry < s);
        }
        #[test]
        fn fee_superadditive(a in 0u64..1_000_000_000_000, b in 0u64..1_000_000_000_000, bps in 0u16..1000) {
            prop_assert!(fee(a, bps).unwrap() + fee(b, bps).unwrap() >= fee(a + b, bps).unwrap());
        }
        #[test]
        fn upnl_antisymmetric(size in 1u64..1_000_000_000_000, entry in 1u64..1_000_000_000_000, mark in 1u64..1_000_000_000_000) {
            prop_assert_eq!(upnl(Side::Long, size, entry, mark).unwrap(), -upnl(Side::Short, size, entry, mark).unwrap());
        }
    }
}
```

```rust
// programs/dexxer_core/src/errors.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError { Overflow, DivisionByZero }
```

```rust
// programs/dexxer_core/src/lib.rs
use anchor_lang::prelude::*;
pub mod errors;
pub mod math;
declare_id!("Dexxer11111111111111111111111111111111111111");
#[program]
pub mod dexxer_core {}
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cargo test -p dexxer_core --lib math
```

Expected: every test panics with `not implemented` (red). `cargo build-sbf` is not required this week.

- [ ] **Step 4: Commit (respecting Task 1 gate)**

```bash
git add Anchor.toml Cargo.toml programs/dexxer_core
git commit -m "test(core): red tests fixing math.rs interface (spec §3.2, §3.6)"
```

---

### Task 14: Docs corrections and week-0 wrap-up

**Files:**
- Modify: `docs/dexxer-plan.md` (header note), `docs/dexxer-architecture.md` (§2 candidates table, §7 stack rows), `docs/solana-perp-privacy-landscape.md` (Flash/Adrena rows, Percolator "candidates" table)
- Create: `docs/superpowers/plans/week0-results.md`

- [ ] **Step 1: Mark plan.md superseded**

Insert after the title line of `docs/dexxer-plan.md`:

```markdown
> **Застаріло (19.09.2026):** §2 (скоуп) і §3 (календар) замінені `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §1 і §7.3. Опція 1 (омнібус над Jupiter) не є MVP. Розділи §5–§7 (ризики омнібусу, комплаєнс) лишаються довідковими.
```

- [ ] **Step 2: Fix facts in architecture.md and landscape.md**

Apply with `sed`/Edit, exact replacements:

| File | Find | Replace with |
|---|---|---|
| architecture.md §2 table, `solana-labs/perpetuals` row | `Anchor ~0.26` | `Anchor 0.28.0, solana-program 1.16.9, pyth-sdk-solana 0.8.0 (застарілий Pyth v1)` |
| architecture.md §2 table, `Drift` row | `Drift `protocol-v2` (→ velocity-exchange)` | `Drift `protocol-v2` (archived 03.09.2026 → `velocity-exchange/protocol-v2`, Anchor 0.29)` |
| architecture.md §7 "Власний пул" row | whole row | delete row (own core is the base, not a fork) |
| architecture.md §7 "Venue" row | keep, prefix with `**v1, не MVP.** ` | — |
| architecture.md §7 "Локальна розробка" row | `**Surfpool** (форк mainnet із клонованими акаунтами venue) + власний keeper-емулятор; LiteSVM для юніт-тестів` | `LiteSVM/proptest → `mb-stack` → devnet + `devnet-tee-as` (spec §6.3). Surfpool не потрібен` |
| landscape.md 1.1 Flash row | `**Найвідкритіший технічно:** `flash-perpetuals` — форк офіційної `solana-labs/perpetuals`;` | `**Програма закрита** (репо `flash-perpetuals` публічно не існує);` |
| landscape.md "Кандидати на форк" table, Flash/Adrena row | `Референс пулової математики; форк — якщо Percolator не ляже; перевірити відкритість і свіжість Adrena` | `Лише формули + аудит-звіт. Форки Flash і Adrena закриті (`AdrenaFoundation/perpetuals` — archived 2024 копія solana-labs)` |
| landscape.md "Кандидати" table, Brute row | `Ліцензія невідома` | `**LICENSE відсутній → all rights reserved; код не брати**` |

- [ ] **Step 3: Results summary**

```markdown
# Week 0 results (fill by 27.09)

| # | Check | Status | Evidence | Decision applied |
|---|---|---|---|---|
| 1 | private-counter TEE, non-member denied | | spikes/01/RESULT.md | |
| 2 | eSPL in TEE | | spikes/02/RESULT.md | |
| 3 | L1 read-only clone | | spikes/03/RESULT.md | |
| 4 | Oracle fresh in TEE | | spikes/04/RESULT.md | |
| 5 | Scheduler ticks | | spikes/05/RESULT.md | |
| 6 | Tx visibility | | spikes/01/RESULT.md | |
| 7 | Magic Action + escrow check | | spikes/06/RESULT.md | |
| 8 | MWA signs ER blockhash | | spikes/08/RESULT.md | |
| 9 | Session key payer | | spikes/07/RESULT.md | |
| 10 | WS token in RN | | spikes/08/RESULT.md | |
| 11 | TDX attestation in Hermes | | spikes/08/RESULT.md | |

Spec changes required: <list, or "none">
Week 1 plan may start: yes/no
```

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: mark plan v2 superseded, fix fork-candidate facts, add week-0 results table"
```

---

## Self-review

**Spec coverage (§7.2 checks → tasks):** 1→T3, 2→T5, 3→T6, 4→T7, 5→T8, 6→T4, 7→T9, 8→T12, 9→T10, 10→T12, 11→T12. §6.1 toolchain→T2. §7.3 days 19 (rules)→T1, 24 (docs)→T14, 25–26 (red math tests)→T13, Expo skeleton→T11. Not in this plan by design: Publisher Policy checklist, `dexxer.xyz` + assetlinks, decks, post №1 — non-code items; owner does them from spec §7.3 directly.

**Placeholders:** two intentional lookups remain and are marked as such with the exact file to read: `VAULT_ID` export name (T3 step 3, from the example test) and oracle `PRICE_FEED_SEED`/`SYMBOL` (T7 step 1, from binary-prediction test). Both are copy-from-source steps, not design gaps. `INCREMENT_DISC` (T12) is read from the IDL JSON.

**Type consistency:** `assert`, `loadKeypair`, `routerStatus`, `rpcIdentity`, `TEE_VALIDATOR` defined once in `spikes/lib/env.ts` and used by the same names everywhere. `math.rs` signatures in T13 match spec §3.2 units (price 1e6, size 1e9, USD 1e6, bps).
