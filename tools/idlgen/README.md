# idlgen

IDL generator for the `dexxer_core` program without `anchor-cli` (its `[toolchain] solana_version` switches the global Solana). A separate crate outside the workspace, using `anchor_lang_idl::build::IdlBuilder` 0.1.4.

```bash
cargo build --release --manifest-path tools/idlgen/Cargo.toml
env -u RUSTUP_TOOLCHAIN CARGO_TARGET_DIR="$PWD/tools/idlgen/target/idl-build" \
  tools/idlgen/target/release/idlgen "$PWD/programs/dexxer_core" "$PWD/idl/dexxer_core.json"
```

`idl/dexxer_core.json` is the canonical IDL, which CI compares (`cmp`) with the output of `anchor build`.

Pitfalls:
- `IdlBuilder` inserts a literal `+{toolchain}` when `RUSTUP_TOOLCHAIN` is set, so run the BUILT binary with `env -u RUSTUP_TOOLCHAIN`, not through `cargo run`.
- The path to the program must be absolute; `CARGO_TARGET_DIR` must be fresh for every checkout.
- The output has no trailing `\n` — CI compares it byte for byte with `anchor build`.
- The build compiles the program with the `idl-build` feature and can take several minutes.
