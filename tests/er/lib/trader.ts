// tests/er/lib/trader.ts
//
// Task 14: per-trader helpers for the week-1 CLI demo (deposit -> open ->
// crank-liquidate -> close), built on top of Task 13's mb-stack scaffolding.
//
// `onboardTrader` is the single place the per-user onboarding sequence
// lives (airdrop, faucet_init, init_user, delegateSpl, delegate_user, wait
// for delegation, credit_deposit, init_permissions) — q1-deposit.ts and
// scripts/demo/week1-cli.ts both call it rather than each keeping their own
// copy (Task 14 review fix round 1). `creditDeposit`/`initPermissions` are
// exposed standalone too: onboardTrader uses them internally, and callers
// that need a step on its own (e.g. q1's negative "second deposit must
// fail" test, which deliberately calls `creditDeposit` a second time
// outside onboarding) can call them directly instead of re-deriving PDAs
// and accounts. `openPosition` / `closePosition` / `readPosition` wrap the
// `Trade` instructions (spec §7.3 /
// programs/dexxer_core/src/instructions/trade.rs) against the ER
// connection, since Market/Pool/UserAccount/Position are all delegated
// there by `bootstrap()`. `setPrice` moves the mock oracle's feed on the ER
// (the feed is delegated too, so this must go through an ER connection,
// signed by the feed's write authority — the admin key, per `admin.ts`'s
// `init_feed`).
//
// Task 5 (week 2): every ER-targeted call below resolves its connection via
// `teeConn(kp)` (env.ts) instead of the module-level `erConn` — locally
// (`DEXXER_NET` unset/"local") `teeConn` returns `erConn` unchanged (byte-
// identical to week 1); on `DEXXER_NET=devnet` it authenticates against
// `devnet-tee.magicblock.app` with `kp`'s own signature (spike-07), so every
// signer here (owner, session, crank, admin) reads/writes with its own TEE
// token rather than one shared connection.
//
// Every ER-targeted send below goes through `sendAndConfirmIx` (build the
// instruction, sign, `sendRawTransaction`, poll `confirmSignature`) instead
// of Anchor's `.rpc()` (Task 14 finding, see crank-fallback's header
// comment): `.rpc()`'s confirm falls back to `Connection.confirmTransaction`
// with a bare signature, which races a `signatureSubscribe` websocket
// notification against a 30s timeout — a notification this local ER
// validator doesn't reliably push, so a `.rpc()` call here could stall for
// tens of seconds (reproduced on `close_position` specifically once other
// ER traffic — the crank loop — was also running). L1 sends (via
// `baseConn`, the real `solana-test-validator`) don't hit this and keep
// using `.rpc()`.

import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateSpl,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, ER_VALIDATOR, loadOrCreateKey, sendAndConfirmIx, teeConn, waitAccountExists, waitDelegated } from "./env.js";
import { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, delegationTriple, mockOracleProgram, pdas } from "./program.js";
import { MOCK_CONF } from "./admin.js";
import type { Bootstrapped } from "./admin.js";

export interface Trader {
  name: string;
  kp: Keypair;
  userAccount: PublicKey;
  position: PublicKey;
  disclosureQueue: PublicKey;
  userAta: PublicKey;
  /** Signatures from onboardTrader's steps, keyed by step name; only steps that actually ran (weren't skipped as already-done) are present. */
  sigs: Record<string, string>;
  /** Compute units of onboardTrader's own credit_deposit call, or `null` if that step was skipped (already funded). */
  creditDepositCU: number | null;
}

/** u64::MAX — the permissive ("no slippage protection") limit for a Short close. */
export const U64_MAX = 18_446_744_073_709_551_615n;

/** Scale a whole/fractional USD amount to the program's 1e6 fixed-point (dUSDC decimals / PRICE_SCALE). */
export function usd(n: number): bigint {
  return BigInt(Math.round(n * 1_000_000));
}

/** Scale a whole/fractional SOL size to the program's 1e9 fixed-point (math.rs SIZE_SCALE). */
export function solSize(n: number): bigint {
  return BigInt(Math.round(n * 1_000_000_000));
}

/** `credit_deposit(amount)` on the ER, signed by `t`. Standalone (not just onboardTrader's internal use) so a caller can deposit again later, or — like q1-deposit.ts's negative test — deliberately try a second deposit and expect it to fail. */
export async function creditDeposit(boot: Bootstrapped, t: Pick<Trader, "kp" | "userAccount" | "userAta">, amount: bigint): Promise<string> {
  const conn = await teeConn(t.kp);
  const core = dexxerCoreProgram(conn, t.kp);
  const ix = await core.methods
    .creditDeposit(new BN(amount.toString()))
    .accounts({ owner: t.kp.publicKey, userAccount: t.userAccount, pool: boot.pool, ownerAta: t.userAta, vaultAta: boot.poolAta, tokenProgram: TOKEN_PROGRAM_ID })
    .instruction();
  return sendAndConfirmIx(conn, t.kp, ix);
}

/**
 * `init_permissions()` on the ER, signed by `t`. Standalone so
 * q2-permissions.ts (which specifically tests the first-call-creates-3 /
 * second-call-is-idempotent behavior) can call it itself, on a trader
 * onboardTrader has deliberately not called it for yet
 * (`opts.initPermissions: false`). No `Bootstrapped` param needed — unlike
 * `creditDeposit`, everything this instruction touches is derivable from
 * `t` plus the fixed `market` PDA.
 */
export async function initPermissions(t: Pick<Trader, "kp" | "userAccount" | "position" | "disclosureQueue">): Promise<string> {
  const conn = await teeConn(t.kp);
  const coreEr = dexxerCoreProgram(conn, t.kp);
  const userPermission = permissionPdaFromAccount(t.userAccount);
  const positionPermission = permissionPdaFromAccount(t.position);
  const dqPermission = permissionPdaFromAccount(t.disclosureQueue);
  const ix = await coreEr.methods
    .initPermissions()
    .accounts({
      owner: t.kp.publicKey,
      market: pdas.market(),
      userAccount: t.userAccount,
      position: t.position,
      disclosureQueue: t.disclosureQueue,
      userPermission,
      positionPermission,
      dqPermission,
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();
  return sendAndConfirmIx(conn, t.kp, ix);
}

/**
 * Onboard a trader on L1 (spec §8 Q1 sequence): airdrop, faucet mint,
 * init_user, delegateSpl(deposit), delegate_user, wait for delegation,
 * credit_deposit (ER), init_permissions (ER, unless `opts.initPermissions
 * === false`). Every step checks on-chain state first and skips if already
 * done, so this is safe to call again for the same persisted
 * `.keys/<name>.json` identity (mirrors `bootstrap()`'s idempotency).
 *
 * `opts.initPermissions` defaults to `true` (what scripts/demo/week1-cli.ts
 * needs — permissions must exist before trading). q1-deposit.ts passes
 * `{ initPermissions: false }`: it hands the same user off to
 * q2-permissions.ts, which specifically tests init_permissions's own
 * first-call/second-call behavior and would see a false "already exists,
 * idempotent no-op" on its first call otherwise.
 *
 * Takes `boot` (mint/pool/poolAta) in addition to the brief's compact
 * `onboardTrader(name, deposit)` signature — those addresses aren't
 * derivable from `name` alone and every other script in this repo threads
 * `Bootstrapped` through explicitly rather than caching it as module state.
 */
export async function onboardTrader(
  boot: Bootstrapped,
  name: string,
  deposit: bigint,
  opts: { initPermissions?: boolean } = {},
): Promise<Trader> {
  const doInitPermissions = opts.initPermissions ?? true;
  const sigs: Record<string, string> = {};
  const kp = loadOrCreateKey(name);
  const bal = await baseConn.getBalance(kp.publicKey, "confirmed");
  if (bal < 2_500_000_000) {
    const sig = await baseConn.requestAirdrop(kp.publicKey, 5_000_000_000);
    const { blockhash, lastValidBlockHeight } = await baseConn.getLatestBlockhash();
    await baseConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    sigs.airdrop = sig;
    console.log(`airdrop ${name} 5 SOL`, sig);
  } else {
    console.log(`${name} already funded, skipped airdrop`);
  }

  const core = dexxerCoreProgram(baseConn, kp);
  const config = pdas.config();
  const market = pdas.market();
  const userAccount = pdas.userAccount(kp.publicKey);
  const position = pdas.position(kp.publicKey, market);
  const disclosureQueue = pdas.disclosureQueue(kp.publicKey);
  const faucetPda = pdas.faucet(kp.publicKey);
  const mintAuth = pdas.mintAuth();

  // user's real (base-layer) ATA — also the address the ER exposes the
  // ephemeral (eSPL) balance under, once delegated.
  const userAta = getAssociatedTokenAddressSync(boot.mint, kp.publicKey);
  await getOrCreateAssociatedTokenAccount(baseConn, kp, boot.mint, kp.publicKey);

  const faucetInfo = await baseConn.getAccountInfo(faucetPda, "confirmed");
  if (!faucetInfo) {
    const sig = await core.methods
      .faucetInit(new BN(deposit.toString()))
      .accounts({
        owner: kp.publicKey,
        config,
        faucet: faucetPda,
        dusdcMint: boot.mint,
        mintAuth,
        ownerAta: userAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    sigs.faucetInit = sig;
    console.log(`faucet_init (${name})`, sig);
  } else {
    console.log(`faucet_init (${name}): faucet exists, skipped (assuming already funded)`);
  }

  const userAccountInfoPre = await baseConn.getAccountInfo(userAccount, "confirmed");
  if (!userAccountInfoPre) {
    const sig = await core.methods
      .initUser()
      .accounts({ owner: kp.publicKey, config, market, userAccount, position, disclosureQueue, systemProgram: SystemProgram.programId })
      .rpc();
    sigs.initUser = sig;
    console.log(`init_user (${name})`, sig);
  } else {
    console.log(`init_user (${name}): exists, skipped`);
  }

  const userAccountInfoNow = await baseConn.getAccountInfo(userAccount, "confirmed");
  const userDelegated = userAccountInfoNow !== null && userAccountInfoNow.owner.equals(DELEGATION_PROGRAM_ID);
  if (!userDelegated) {
    // delegateSpl(user, mint, deposit) on L1 — the global vault already
    // exists (created by bootstrap()'s admin delegateSpl call).
    const ixs = await delegateSpl(kp.publicKey, boot.mint, deposit, {
      validator: ER_VALIDATOR,
      initVaultIfMissing: false,
      idempotent: false,
    });
    const delegateSplSig = await sendAndConfirmTransaction(baseConn, new Transaction().add(...ixs), [kp], { commitment: "confirmed" });
    sigs.delegateSpl = delegateSplSig;
    console.log(`delegateSpl(${name}, ${deposit})`, delegateSplSig);

    const ut = delegationTriple(userAccount, DEXXER_CORE_PROGRAM_ID);
    const pt = delegationTriple(position, DEXXER_CORE_PROGRAM_ID);
    const dt = delegationTriple(disclosureQueue, DEXXER_CORE_PROGRAM_ID);
    const sig = await core.methods
      .delegateUser()
      .accounts({
        owner: kp.publicKey,
        config,
        market,
        bufferUserAccount: ut.buffer,
        delegationRecordUserAccount: ut.record,
        delegationMetadataUserAccount: ut.metadata,
        userAccount,
        bufferPosition: pt.buffer,
        delegationRecordPosition: pt.record,
        delegationMetadataPosition: pt.metadata,
        position,
        bufferDisclosureQueue: dt.buffer,
        delegationRecordDisclosureQueue: dt.record,
        delegationMetadataDisclosureQueue: dt.metadata,
        disclosureQueue,
        ownerProgram: DEXXER_CORE_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    sigs.delegateUser = sig;
    console.log(`delegate_user (${name})`, sig);
  } else {
    console.log(`delegate_user (${name}): already delegated, skipped`);
  }

  await waitDelegated(baseConn, userAccount, `${name} UserAccount`);
  await waitDelegated(baseConn, position, `${name} Position`);
  await waitDelegated(baseConn, disclosureQueue, `${name} DisclosureQueue`);
  const ownerTee = await teeConn(kp);
  await waitAccountExists(ownerTee, userAta, `${name} eATA (as userAta on ER)`);

  const trader: Trader = { name, kp, userAccount, position, disclosureQueue, userAta, sigs, creditDepositCU: null };

  const coreEr = dexxerCoreProgram(ownerTee, kp);
  const userAccountState = await accountNs(coreEr).userAccount.fetch(userAccount);
  if (BigInt(userAccountState.freeMargin.toString()) === 0n) {
    const creditSig = await creditDeposit(boot, trader, deposit);
    sigs.creditDeposit = creditSig;
    const tx = await ownerTee.getTransaction(creditSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    trader.creditDepositCU = tx?.meta?.computeUnitsConsumed ?? null;
    console.log(`credit_deposit (${name})`, creditSig);
  } else {
    console.log(`credit_deposit (${name}): free_margin already nonzero (${userAccountState.freeMargin.toString()}), skipped`);
  }

  if (doInitPermissions) {
    const userPermission = permissionPdaFromAccount(userAccount);
    const permInfo = await ownerTee.getAccountInfo(userPermission, "confirmed");
    if (!permInfo || !permInfo.owner.equals(PERMISSION_PROGRAM_ID)) {
      const sig = await initPermissions(trader);
      sigs.initPermissions = sig;
      console.log(`init_permissions (${name})`, sig);
    } else {
      console.log(`init_permissions (${name}): exists, skipped`);
    }
  }

  return trader;
}

/** Open a position for `t` on the ER (Trade context; `side`: "long" | "short"). */
export async function openPosition(
  boot: Bootstrapped,
  t: Trader,
  side: "long" | "short",
  sizeSol: number,
  marginUsd: number,
  limitUsdPrice: number,
): Promise<string> {
  const conn = await teeConn(t.kp);
  const core = dexxerCoreProgram(conn, t.kp);
  const market = pdas.market();
  const ix = await core.methods
    .openPosition(
      side === "long" ? { long: {} } : { short: {} },
      new BN(solSize(sizeSol).toString()),
      new BN(usd(marginUsd).toString()),
      new BN(usd(limitUsdPrice).toString()),
    )
    .accounts({
      signer: t.kp.publicKey,
      config: pdas.config(),
      market,
      marketRisk: pdas.marketRisk(market),
      pool: boot.pool,
      userAccount: t.userAccount,
      position: t.position,
      feed: boot.feed,
    })
    .instruction();
  return sendAndConfirmIx(conn, t.kp, ix);
}

/**
 * Close `t`'s position on the ER. `limitUsdPrice === 0` (the default) is a
 * "no slippage protection" sentinel: `close_position`'s Short branch
 * requires `exec_price <= limit_price`, so a literal `0` would always
 * reject a short close (any real price is > 0) — this helper reads the
 * position's side first and maps the sentinel to the permissive bound for
 * that side (0 for Long, u64::MAX for Short) instead of sending 0 as-is.
 */
export async function closePosition(boot: Bootstrapped, t: Trader, limitUsdPrice = 0): Promise<string> {
  const conn = await teeConn(t.kp);
  const core = dexxerCoreProgram(conn, t.kp);
  const posState = await accountNs(core).position.fetch(t.position);
  const isShort = "short" in posState.side;
  const limitArg: bigint = limitUsdPrice === 0 ? (isShort ? U64_MAX : 0n) : usd(limitUsdPrice);
  const market = pdas.market();
  const ix = await core.methods
    .closePosition(new BN(limitArg.toString()))
    .accounts({
      signer: t.kp.publicKey,
      config: pdas.config(),
      market,
      marketRisk: pdas.marketRisk(market),
      pool: boot.pool,
      userAccount: t.userAccount,
      position: t.position,
      feed: boot.feed,
    })
    .instruction();
  return sendAndConfirmIx(conn, t.kp, ix);
}

/** Read `t`'s Position from the ER. No signer needed for a plain account read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPosition(t: Trader): Promise<any> {
  const conn = await teeConn(t.kp);
  const core = dexxerCoreProgram(conn, t.kp);
  return accountNs(core).position.fetch(t.position);
}

/**
 * Move the mock oracle's price on the ER. The feed PDA is delegated (see
 * `admin.ts`'s `delegate_feed`), so this must go through an ER connection
 * (locally `erConn`, on devnet a TEE-authenticated connection — see
 * `teeConn`) with an ER blockhash, signed by the feed's write authority (the
 * admin key that ran `init_feed`) — `mock_oracle::set_price` checks
 * `authority == body[0..32]`. Local-only in practice (devnet uses the real
 * Pricing Oracle, not `mock_oracle` — see `admin.ts` header comment), kept
 * NET-aware for consistency with the rest of this file.
 */
export async function setPrice(boot: Bootstrapped, price1e8: bigint): Promise<string> {
  const conn = await teeConn(boot.admin);
  const oracle = mockOracleProgram(conn, boot.admin);
  const now = Math.floor(Date.now() / 1000);
  const ix = await oracle.methods
    .setPrice(new BN(price1e8.toString()), new BN(MOCK_CONF.toString()), new BN(now))
    .accounts({ authority: boot.admin.publicKey, feed: boot.feed })
    .instruction();
  return sendAndConfirmIx(conn, boot.admin, ix);
}
