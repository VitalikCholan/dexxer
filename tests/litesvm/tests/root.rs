use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{apk, assert_custom_error, ixs, setup::World, Harness};
use solana_instruction::AccountMeta;
use solana_signer::Signer;

#[test]
fn root_leaves_are_program_computed_from_real_accounts() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let a = w.new_trader(&mut h, 1_000_000_000);
    let b = w.new_trader(&mut h, 2_000_000_000);
    let seed = [0xabu8; 32];
    let metas = vec![
        AccountMeta::new_readonly(a.user, false),
        AccountMeta::new_readonly(b.user, false),
    ];
    h.send(
        &[ixs::set_balances_root(
            &w.crank.pubkey(),
            &w,
            true,
            true,
            seed,
            &metas,
        )],
        &[&w.crank],
    )
    .unwrap();
    let root = h.account::<BalancesRoot>(&w.balances_root);
    let ua = h.account::<UserAccount>(&a.user);
    let ub = h.account::<UserAccount>(&b.user);
    assert_eq!(root.filled, 2);
    assert_eq!(
        root.leaves[0],
        leaf(
            &apk(a.kp.pubkey()),
            ua.free_margin,
            &ua.exit_salt,
            root.root_slot
        )
    );
    assert_eq!(
        root.leaves[1],
        leaf(
            &apk(b.kp.pubkey()),
            ub.free_margin,
            &ub.exit_salt,
            root.root_slot
        )
    );
    for i in 2..ROOT_LEAVES {
        assert_eq!(root.leaves[i], pad(&seed, i as u8), "padding slot {i}");
    }
}

#[test]
fn root_slot_binding_changes_every_leaf() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let a = w.new_trader(&mut h, 1_000_000_000);
    let metas = vec![AccountMeta::new_readonly(a.user, false)];
    h.send(
        &[ixs::set_balances_root(
            &w.crank.pubkey(),
            &w,
            true,
            true,
            [1u8; 32],
            &metas,
        )],
        &[&w.crank],
    )
    .unwrap();
    let l1 = h.account::<BalancesRoot>(&w.balances_root).leaves[0];
    let slot = h.svm.get_sysvar::<solana_clock::Clock>().slot;
    h.warp(slot + 10, 1_000_000);
    h.send(
        &[ixs::set_balances_root(
            &w.crank.pubkey(),
            &w,
            true,
            true,
            [1u8; 32],
            &metas,
        )],
        &[&w.crank],
    )
    .unwrap();
    let l2 = h.account::<BalancesRoot>(&w.balances_root).leaves[0];
    assert_ne!(
        l1, l2,
        "same balance, new slot -> new leaf (unlinkable across commits)"
    );
}

#[test]
fn set_balances_root_only_by_crank_and_rejects_foreign_account() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let a = w.new_trader(&mut h, 1_000_000_000);
    let metas = vec![AccountMeta::new_readonly(a.user, false)];
    let r = h.send(
        &[ixs::set_balances_root(
            &a.kp.pubkey(),
            &w,
            true,
            true,
            [1u8; 32],
            &metas,
        )],
        &[&a.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    let bad = vec![AccountMeta::new_readonly(w.market, false)];
    let r = h.send(
        &[ixs::set_balances_root(
            &w.crank.pubkey(),
            &w,
            true,
            true,
            [1u8; 32],
            &bad,
        )],
        &[&w.crank],
    );
    assert_custom_error(&r, 6000 + DexxerError::InvalidLeafAccount as u32);
}

#[test]
fn set_balances_root_batches_and_caps_at_64() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let a = w.new_trader(&mut h, 1_000_000_000);
    let one = vec![AccountMeta::new_readonly(a.user, false)];
    h.send(
        &[ixs::set_balances_root(
            &w.crank.pubkey(),
            &w,
            true,
            false,
            [1u8; 32],
            &one,
        )],
        &[&w.crank],
    )
    .unwrap();
    for _ in 1..ROOT_LEAVES {
        h.send(
            &[ixs::set_balances_root(
                &w.crank.pubkey(),
                &w,
                false,
                false,
                [1u8; 32],
                &one,
            )],
            &[&w.crank],
        )
        .unwrap();
    }
    assert_eq!(
        h.account::<BalancesRoot>(&w.balances_root).filled as usize,
        ROOT_LEAVES
    );
    let r = h.send(
        &[ixs::set_balances_root(
            &w.crank.pubkey(),
            &w,
            false,
            false,
            [1u8; 32],
            &one,
        )],
        &[&w.crank],
    );
    assert_custom_error(&r, 6000 + DexxerError::RootFull as u32);
}
