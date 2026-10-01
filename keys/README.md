# keys/ (gitignored)

`programs/dexxer_core-keypair.json` — keypair програми `dexxer_core`, program id
`Fyg2yJBoN97ScWxT37xBp2zaaiNncNqnGJ7PAbtnUfCY` (позиції-слоти, чистий старт devnet, план 4, 01.10.2026).
Upgrade authority на devnet — `spikes/keys/payer.json`
(`4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM`), не цей файл.

`programs/dexxer_core-keypair.G2ok.json` — keypair СТАРОЇ програми
`G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV` (тижні 1–6 до слотів). Зберігати: потрібен для
майбутнього `solana program close` старої програми (рента program-data).

`programs/mock_oracle-keypair.json` — upgrade authority + program id
`68xBWNR1uKorC7keLWvsT1pCmKC4RnwvRF4LoV3CCprh` (тільки localnet/LiteSVM; на
devnet ця програма не деплоїться, ціни бере реальний Pyth Lazer фід —
див. `docs/superpowers/plans/2026-09-20-week2-privacy-devnet.md` §Global
Constraints).

Втрата файлу `dexxer_core-keypair.json` = втрата можливості оновлювати
програму. Бекап у менеджері паролів — людський крок (Task 0).

Відновлення в `target/deploy/`:

```bash
cp keys/programs/dexxer_core-keypair.json keys/programs/mock_oracle-keypair.json target/deploy/
```

Перевірка program id:

```bash
solana-keygen pubkey keys/programs/dexxer_core-keypair.json        # Fyg2yJBoN97ScWxT37xBp2zaaiNncNqnGJ7PAbtnUfCY
solana-keygen pubkey keys/programs/dexxer_core-keypair.G2ok.json   # G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV (стара)
```
