# keys/ (gitignored)

`programs/dexxer_core-keypair.json` — keypair of the `dexxer_core` program, program id
`Fyg2yJBoN97ScWxT37xBp2zaaiNncNqnGJ7PAbtnUfCY` (position slots, clean devnet start, plan 4, 01.10.2026).
The upgrade authority on devnet is `spikes/keys/payer.json`
(`4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM`), not this file.

`programs/dexxer_core-keypair.G2ok.json` — keypair of the OLD program
`G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV` (weeks 1–6 before slots). Keep it: it is needed for
a future `solana program close` of the old program (program-data rent).

`programs/mock_oracle-keypair.json` — upgrade authority + program id
`68xBWNR1uKorC7keLWvsT1pCmKC4RnwvRF4LoV3CCprh` (localnet/LiteSVM only; this
program is not deployed to devnet, prices come from the real Pyth Lazer feed —
see `docs/superpowers/plans/weeks0-5-history.md#week-2` §Global
Constraints).

Losing the `dexxer_core-keypair.json` file = losing the ability to upgrade
the program. A backup in a password manager is a human step (Task 0).

Restoring into `target/deploy/`:

```bash
cp keys/programs/dexxer_core-keypair.json keys/programs/mock_oracle-keypair.json target/deploy/
```

Checking the program id:

```bash
solana-keygen pubkey keys/programs/dexxer_core-keypair.json        # Fyg2yJBoN97ScWxT37xBp2zaaiNncNqnGJ7PAbtnUfCY
solana-keygen pubkey keys/programs/dexxer_core-keypair.G2ok.json   # G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV (old)
```
