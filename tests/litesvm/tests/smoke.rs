use dexxer_litesvm::{token_ix::*, Harness};
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn program_loads_and_token_helpers_work() {
    let mut h = Harness::new();
    let mint = Keypair::new();
    let rent = h.svm.minimum_balance_for_rent_exemption(MINT_LEN as usize);
    let payer = h.payer.pubkey();
    let [c, i] = create_mint(&payer, &mint.pubkey(), &payer, 6, rent);
    h.send(&[c, i], &[&mint]).unwrap();
    h.send(&[create_ata(&payer, &payer, &mint.pubkey())], &[])
        .unwrap();
    h.send(
        &[mint_to(
            &mint.pubkey(),
            &ata(&payer, &mint.pubkey()),
            &payer,
            1_000_000,
        )],
        &[],
    )
    .unwrap();
    assert_eq!(
        token_balance(&h.svm, &ata(&payer, &mint.pubkey())),
        1_000_000
    );
    assert!(h.svm.get_account(&h.program_id).is_some());
}
