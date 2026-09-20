// tests/er/lib/bs58.d.ts
//
// `bs58` (pinned to ^4.0.1 in package.json — the version already present
// transitively via @coral-xyz/anchor / @solana/web3.js) ships no types of
// its own. Minimal ambient declaration for the default-export API used in
// program.ts (`bs58.encode`), rather than a blanket `declare module "bs58";`.
declare module "bs58" {
  const bs58: {
    encode(source: Uint8Array | Buffer | number[]): string;
    decode(source: string): Buffer;
  };
  export default bs58;
}
