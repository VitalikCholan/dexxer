// scripts/bs58.d.ts
//
// Mirrors tests/er/lib/bs58.d.ts — TypeScript's default `include` (no
// explicit "files"/"include" in tsconfig.json) only picks up ambient .d.ts
// files under a project's own root, so an ambient declaration living in
// tests/er/lib/ isn't visible to `tsc -p scripts` even though it reaches
// (and needs to type-check) tests/er/lib/program.ts's `import bs58 from
// "bs58"` through the relative-import graph from crank-fallback/index.ts.
declare module "bs58" {
  const bs58: {
    encode(source: Uint8Array | Buffer | number[]): string;
    decode(source: string): Buffer;
  };
  export default bs58;
}
