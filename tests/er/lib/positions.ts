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
// 3176 B of slots + history, then the 8 conditional-order slots (88 B each,
// state/order.rs) appended at the end.
export const POSITIONS_SIZE = DISC + 3176 + 704;

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
}

const side = (b: number): "long" | "short" => (b === 1 ? "short" : "long");
const REASONS = ["user", "liquidated", "decrease"] as const;
const key = (data: Buffer, at: number) => new PublicKey(data.subarray(at, at + 32));

export function decodePositions(data: Buffer): Positions {
  if (data.length !== POSITIONS_SIZE) throw new Error(`Positions: length ${data.length}, expected ${POSITIONS_SIZE}`);
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

  return { owner: key(data, DISC), slots, history, version: data.readUInt8(DISC + 3106), bump: data.readUInt8(DISC + 3107) };
}

export function slotFor(p: Positions, market: PublicKey): PositionSlot | null {
  return p.slots.find((s) => s.market.equals(market)) ?? null;
}

/** `state::liq_task_id`: keccak256(positions ‖ market), first 8 bytes, little-endian, signed. */
export function liqTaskId(positions: PublicKey, market: PublicKey): bigint {
  const h = keccak_256(Buffer.concat([positions.toBuffer(), market.toBuffer()]));
  return Buffer.from(h.subarray(0, 8)).readBigInt64LE(0);
}
