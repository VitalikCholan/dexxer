// programs/dexxer_core/src/state/permissions.rs
//
// Membership rules for the three per-user ER `EphemeralPermission` accounts
// (UserAccount, Position, DisclosureQueue). Week 2 (spec §8 Q2): flip from
// week-1 public permissions to private, member-gated ones — owner always has
// full authority flags, the session key (when issued) and the crank get
// viewer-only flags (visibility for trading/liquidation, no ability to
// reassign membership).
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::structs::{
    Member, ACCOUNT_SIGNATURES_FLAG, AUTHORITY_FLAG, TX_BALANCES_FLAG, TX_LOGS_FLAG,
    TX_MESSAGE_FLAG,
};

pub const OWNER_FLAGS: u8 =
    AUTHORITY_FLAG | TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG | ACCOUNT_SIGNATURES_FLAG;
pub const VIEWER_FLAGS: u8 = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG;

/// `anchor_lang::prelude::Pubkey` -> `ephemeral_rollups_sdk::compat::Pubkey`,
/// by bytes — same pattern as `admin.rs::espl::espl_program_id` /
/// `find_eata_delegation_pdas`.
fn compat_pubkey(p: Pubkey) -> ephemeral_rollups_sdk::compat::Pubkey {
    ephemeral_rollups_sdk::compat::Pubkey::new_from_array(p.to_bytes())
}

/// Owner is always first with full authority flags. Session is included only
/// when set (`Pubkey::default()` means no session key issued yet — 2 members,
/// not 3). Crank always gets a trailing viewer-flags member so the ER crank
/// can read trading/liquidation state without owner-level authority.
pub fn build_members(owner: Pubkey, session: Pubkey, crank: Pubkey) -> Vec<Member> {
    let mut m = vec![Member {
        flags: OWNER_FLAGS,
        pubkey: compat_pubkey(owner),
    }];
    if session != Pubkey::default() {
        m.push(Member {
            flags: VIEWER_FLAGS,
            pubkey: compat_pubkey(session),
        });
    }
    m.push(Member {
        flags: VIEWER_FLAGS,
        pubkey: compat_pubkey(crank),
    });
    m
}

/// Week-4 Task 2 (risk #24): membership for the two market-scoped private
/// aggregates (`MarketRisk`, `PoolLive`) — neither has a single trader-owner,
/// so the crank gets full authority flags (it is the only ER writer for
/// both) and the admin gets viewer-only flags (bootstrap/ops visibility, no
/// ability to reassign membership).
pub fn build_admin_members(crank: Pubkey, admin: Pubkey) -> Vec<Member> {
    vec![
        Member {
            flags: OWNER_FLAGS,
            pubkey: compat_pubkey(crank),
        },
        Member {
            flags: VIEWER_FLAGS,
            pubkey: compat_pubkey(admin),
        },
    ]
}

/// Week-5 Task 2 (spec §2.6.3): membership for a `DisclosureQueue` its owner
/// has exited and left behind. The owner is gone and the session key is dead,
/// so the crank — the only party that still touches the queue, through
/// `commit_aggregate`'s reveals and then `close_orphan_queue` — is the single
/// member, with full authority flags (nobody else is left to reassign
/// membership).
pub fn build_crank_only(crank: Pubkey) -> Vec<Member> {
    vec![Member {
        flags: OWNER_FLAGS,
        pubkey: compat_pubkey(crank),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    #[test]
    fn owner_always_first_with_authority_flag() {
        let members = build_members(pk(1), Pubkey::default(), pk(3));
        assert_eq!(members[0].pubkey, compat_pubkey(pk(1)));
        assert_eq!(members[0].flags & AUTHORITY_FLAG, AUTHORITY_FLAG);
    }

    #[test]
    fn no_session_yields_two_members() {
        let members = build_members(pk(1), Pubkey::default(), pk(3));
        assert_eq!(members.len(), 2);
    }

    #[test]
    fn with_session_yields_three_members() {
        let members = build_members(pk(1), pk(2), pk(3));
        assert_eq!(members.len(), 3);
        assert_eq!(members[1].pubkey, compat_pubkey(pk(2)));
        assert_eq!(members[1].flags, VIEWER_FLAGS);
    }

    #[test]
    fn crank_present_with_viewer_flags() {
        let members = build_members(pk(1), pk(2), pk(3));
        let crank_member = members.last().unwrap();
        assert_eq!(crank_member.pubkey, compat_pubkey(pk(3)));
        assert_eq!(crank_member.flags, VIEWER_FLAGS);
        assert_eq!(crank_member.flags & AUTHORITY_FLAG, 0);
    }

    // Week-4 Task 2 (risk #24): `MarketRisk`/`PoolLive` have no single owner,
    // so membership is crank (full authority, only ER writer) + admin
    // (viewer, bootstrap/ops visibility).
    #[test]
    fn build_admin_members_is_crank_owner_admin_viewer() {
        let members = build_admin_members(pk(1), pk(2));
        assert_eq!(members.len(), 2);
        assert_eq!(members[0].pubkey, compat_pubkey(pk(1)));
        assert_eq!(members[0].flags, OWNER_FLAGS);
        assert_eq!(members[1].pubkey, compat_pubkey(pk(2)));
        assert_eq!(members[1].flags, VIEWER_FLAGS);
        assert_eq!(members[1].flags & AUTHORITY_FLAG, 0);
    }

    // Week-5 Task 2: an orphaned `DisclosureQueue` has exactly one member left.
    #[test]
    fn build_crank_only_is_a_single_authoritative_member() {
        let members = build_crank_only(pk(7));
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].pubkey, compat_pubkey(pk(7)));
        assert_eq!(members[0].flags, OWNER_FLAGS);
        assert_eq!(members[0].flags & AUTHORITY_FLAG, AUTHORITY_FLAG);
    }
}
