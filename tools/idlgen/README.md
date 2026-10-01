# idlgen

Генератор IDL програми `dexxer_core` без `anchor-cli` (його `[toolchain] solana_version` перемикає глобальну Solana). Окремий крейт поза workspace, використовує `anchor_lang_idl::build::IdlBuilder` 0.1.4.

```bash
cargo build --release --manifest-path tools/idlgen/Cargo.toml
env -u RUSTUP_TOOLCHAIN CARGO_TARGET_DIR="$PWD/tools/idlgen/target/idl-build" \
  tools/idlgen/target/release/idlgen "$PWD/programs/dexxer_core" "$PWD/idl/dexxer_core.json"
```

`idl/dexxer_core.json` — канонічний IDL, який CI порівнює (`cmp`) з виходом `anchor build`.

Пастки:
- `IdlBuilder` підставляє літерал `+{toolchain}`, якщо виставлено `RUSTUP_TOOLCHAIN`, тому запускати ЗІБРАНИЙ бінар з `env -u RUSTUP_TOOLCHAIN`, а не через `cargo run`.
- Шлях до програми — абсолютний; `CARGO_TARGET_DIR` — свіжий на кожен checkout.
- Вихід без кінцевого `\n` — CI порівнює його побайтово з `anchor build`.
- Збірка компілює програму з фічею `idl-build` і може тривати кілька хвилин.
