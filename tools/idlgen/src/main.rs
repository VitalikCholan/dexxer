// Regenerates the program IDL without `anchor-cli` (whose `[toolchain]
// solana_version` switches the machine's global Solana install).
//
// usage: idlgen <absolute path to programs/dexxer_core> <output file>
//
// The output has NO trailing newline — CI compares it byte-for-byte with
// `anchor build`'s `target/idl/dexxer_core.json`.
use std::path::PathBuf;

use anchor_lang_idl::build::IdlBuilder;

fn main() {
    let mut args = std::env::args().skip(1);
    let program = PathBuf::from(args.next().expect("program dir (absolute)"));
    let out = PathBuf::from(args.next().expect("output file"));
    assert!(program.is_absolute(), "program dir must be an absolute path");
    let idl = IdlBuilder::new()
        .program_path(program)
        .skip_lint(true)
        .build()
        .expect("IDL build failed");
    std::fs::write(&out, serde_json::to_string_pretty(&idl).expect("serialize")).expect("write");
}
