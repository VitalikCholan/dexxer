// tests/er/lib/symbol.ts
//
// Market symbols as the program stores them (spec §2.8.1): 1–8 bytes
// A-Z0-9, left-aligned, zero-padded — `validate_symbol` in
// programs/dexxer_core/src/state/market.rs. IDL-free so pure tests and the
// app-side mirror can import it without an IDL on disk.
const SYMBOL_RE = /^[A-Z0-9]{1,8}$/;

export function symbolBytes(sym: string): Buffer {
  if (!SYMBOL_RE.test(sym)) throw new Error(`invalid symbol: ${JSON.stringify(sym)} (1-8 of A-Z0-9)`);
  const out = Buffer.alloc(8);
  out.write(sym, "ascii");
  return out;
}

export function symbolString(bytes: Uint8Array | number[]): string {
  const b = Buffer.from(bytes);
  const end = b.indexOf(0);
  return b.subarray(0, end === -1 ? b.length : end).toString("ascii");
}
