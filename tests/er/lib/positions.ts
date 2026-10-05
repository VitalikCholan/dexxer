// tests/er/lib/positions.ts
//
// Manual decoder of the zero-copy `Positions` account (spec §2.9.1). Anchor's
// Borsh coder cannot read a bytemuck `repr(C)` account, so the layout is read
// by offset — the same numbers `offsets_match_the_off_chain_decoders` pins in
// programs/dexxer_core/src/state/positions.rs.
import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";
import { POSITIONS_DISC_BYTES } from "./program.js";

export const MAX_SLOTS = 16;
export const HISTORY_LEN = 16;
const DISC = 8;
const RECORD = 96;
const SLOTS_AT = DISC + 32;
const HISTORY_AT = DISC + 1568;
const HEAD_AT = DISC + 3104;
// 3176 B of slots + history (`POSITIONS_SIZE_LEGACY`), then the OPTIONAL 8
// conditional-order slots (96 B each, state/order.rs). An account onboarded
// before orders is exactly the legacy length and still decodes — the program
// treats the tail the same way. The tail was 8 x 88 B before stop-limit added
// `limit`; such an account (`POSITIONS_SIZE_PREV_TAIL`) also decodes, with no
// orders, exactly as the program sees it.
const ORDERS_AT = DISC + 3176;
const ORDER_RECORD = 96;
export const ORDER_SLOTS = 8;
export const POSITIONS_SIZE_LEGACY = ORDERS_AT;
export const POSITIONS_SIZE = POSITIONS_SIZE_LEGACY + ORDER_SLOTS * ORDER_RECORD;
export const POSITIONS_SIZE_PREV_TAIL = POSITIONS_SIZE_LEGACY + ORDER_SLOTS * 88;
/** `OrderKind::as_u8` names; 0 is an empty slot. */
const ORDER_KINDS = ["none", "limit", "stop", "takeProfit", "stopLoss", "trailingStop"] as const;
export type OrderKindName = Exclude<(typeof ORDER_KINDS)[number], "none">;

export interface PendingOrder {
  slot: number;
  market: PublicKey;
  kind: OrderKindName;
  side: "long" | "short";
  trigger: bigint;
  /** Entry orders: size to open; exits: size to close (0 = the whole position). */
  size: bigint;
  /** Entry orders: margin held in `UserAccount.order_reserved`. */
  margin: bigint;
  /** `stop` entry orders: worst fill price (0 = none). */
  limit: bigint;
}

export interface PositionSlot {
  index: number;
  market: PublicKey;
  size: bigint;
  entry: bigint;
  margin: bigint;
  liqPrice: bigint;
  openedSlot: bigint;
  oiNotional: bigint;
  lastLiqSample: bigint;
  side: "long" | "short";
  liqTicks: number;
}
export interface HistoryRecord {
  market: PublicKey;
  size: bigint;
  entry: bigint;
  exit: bigint;
  pnl: bigint;
  fees: bigint;
  openedSlot: bigint;
  closedSlot: bigint;
  side: "long" | "short";
  reason: "user" | "liquidated" | "decrease";
}
export interface Positions {
  owner: PublicKey;
  /** Open slots only, in slot-index order. */
  slots: PositionSlot[];
  /** Oldest record first. */
  history: HistoryRecord[];
  version: number;
  bump: number;
  /** `false` for a pre-orders account (no current order tail): `place_order` on it fails with `OrdersUnsupported`. */
  ordersSupported: boolean;
  /** Pending conditional orders of every market, empty slots omitted; always `[]` without a current tail. */
  orders: PendingOrder[];
}

const side = (b: number): "long" | "short" => (b === 1 ? "short" : "long");
const REASONS = ["user", "liquidated", "decrease"] as const;
const key = (data: Buffer, at: number) => new PublicKey(data.subarray(at, at + 32));

export function decodePositions(data: Buffer): Positions {
  if (data.length !== POSITIONS_SIZE && data.length !== POSITIONS_SIZE_LEGACY && data.length !== POSITIONS_SIZE_PREV_TAIL) {
    throw new Error(`Positions: length ${data.length}, expected ${POSITIONS_SIZE}, ${POSITIONS_SIZE_PREV_TAIL} or ${POSITIONS_SIZE_LEGACY}`);
  }
  if (!data.subarray(0, DISC).equals(POSITIONS_DISC_BYTES)) throw new Error("Positions: discriminator mismatch");

  const slots: PositionSlot[] = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const at = SLOTS_AT + i * RECORD;
    if (data.readUInt8(at + 88) !== 1) continue; // SLOT_OPEN
    slots.push({
      index: i,
      market: key(data, at),
      size: data.readBigUInt64LE(at + 32),
      entry: data.readBigUInt64LE(at + 40),
      margin: data.readBigUInt64LE(at + 48),
      liqPrice: data.readBigUInt64LE(at + 56),
      openedSlot: data.readBigUInt64LE(at + 64),
      oiNotional: data.readBigUInt64LE(at + 72),
      lastLiqSample: data.readBigUInt64LE(at + 80),
      side: side(data.readUInt8(at + 89)),
      liqTicks: data.readUInt8(at + 90),
    });
  }

  const head = data.readUInt8(HEAD_AT) % HISTORY_LEN;
  const len = Math.min(data.readUInt8(HEAD_AT + 1), HISTORY_LEN);
  const history: HistoryRecord[] = [];
  for (let k = 0; k < len; k++) {
    const at = HISTORY_AT + ((head - len + k + HISTORY_LEN) % HISTORY_LEN) * RECORD;
    history.push({
      market: key(data, at),
      size: data.readBigUInt64LE(at + 32),
      entry: data.readBigUInt64LE(at + 40),
      exit: data.readBigUInt64LE(at + 48),
      pnl: data.readBigInt64LE(at + 56),
      fees: data.readBigUInt64LE(at + 64),
      openedSlot: data.readBigUInt64LE(at + 72),
      closedSlot: data.readBigUInt64LE(at + 80),
      side: side(data.readUInt8(at + 88)),
      reason: REASONS[data.readUInt8(at + 89)] ?? "user",
    });
  }

  const ordersSupported = data.length === POSITIONS_SIZE;
  const orders: PendingOrder[] = [];
  for (let i = 0; ordersSupported && i < ORDER_SLOTS; i++) {
    const at = ORDERS_AT + i * ORDER_RECORD;
    const kind = ORDER_KINDS[data.readUInt8(at + 88)];
    if (!kind || kind === "none") continue;
    orders.push({
      slot: i,
      market: key(data, at),
      kind,
      side: side(data.readUInt8(at + 89)),
      trigger: data.readBigUInt64LE(at + 32),
      size: data.readBigUInt64LE(at + 40),
      margin: data.readBigUInt64LE(at + 48),
      limit: data.readBigUInt64LE(at + 80),
    });
  }
  return {
    owner: key(data, DISC),
    slots,
    history,
    orders,
    version: data.readUInt8(DISC + 3106),
    bump: data.readUInt8(DISC + 3107),
    ordersSupported,
  };
}

export function slotFor(p: Positions, market: PublicKey): PositionSlot | null {
  return p.slots.find((s) => s.market.equals(market)) ?? null;
}

/** `state::liq_task_id`: keccak256(positions ‖ market), first 8 bytes, little-endian, signed. */
export function liqTaskId(positions: PublicKey, market: PublicKey): bigint {
  const h = keccak_256(Buffer.concat([positions.toBuffer(), market.toBuffer()]));
  return Buffer.from(h.subarray(0, 8)).readBigInt64LE(0);
}
