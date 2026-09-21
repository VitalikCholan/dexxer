# keys/ (gitignored)

`programs/dexxer_core-keypair.json` — upgrade authority + program id
`G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`.

`programs/mock_oracle-keypair.json` — upgrade authority + program id
`68xBWNR1uKorC7keLWvsT1pCmKC4RnwvRF4LoV3CCprh` (тільки localnet/LiteSVM; на
devnet ця програма не деплоїться, ціни бере реальний Pyth Lazer фід —
див. `docs/superpowers/plans/2026-09-20-week2-privacy-devnet.md` §Global
Constraints).

Втрата файлу `dexxer_core-keypair.json` = втрата можливості оновлювати
програму. Бекап у менеджері паролів — людський крок (Task 0).

Відновлення в `target/deploy/`:

```bash
cp keys/programs/*.json target/deploy/
```

Перевірка program id:

```bash
solana-keygen pubkey keys/programs/dexxer_core-keypair.json   # G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV
```
