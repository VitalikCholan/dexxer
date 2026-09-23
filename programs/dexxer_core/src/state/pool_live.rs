use crate::{
    errors::DexxerError,
    math::{ceil_step, floor_step},
    state::{Pool, SNAPSHOT_STEP},
};
use anchor_lang::prelude::*;

/// Live pool counters. Delegated, permissioned `[crank, admin]`, NEVER committed (spec §2.5.1, risk #24).
/// Every trading/money instruction writes here; the public `Pool` is a rounded snapshot written only by `commit_aggregate`.
#[account]
#[derive(InitSpace)]
pub struct PoolLive {
    pub version: u8,
    pub mint: Pubkey,
    pub capital_total: u64,
    pub protocol_liquidity: u64,
    pub locked_total: u64,
    pub fees_accrued: u64,
    pub insurance: u64,
    pub bad_debt_total: u64,
    pub bump: u8,
}

impl PoolLive {
    /// Copy into the public snapshot with step rounding: assets down, liabilities up.
    pub fn snapshot_into(&self, pool: &mut Pool, slot: u64) -> Result<()> {
        require!(pool.mint == self.mint, DexxerError::PoolLiveMismatch);
        pool.capital_total =
            floor_step(self.capital_total, SNAPSHOT_STEP).map_err(|_| DexxerError::MathOverflow)?;
        pool.protocol_liquidity = floor_step(self.protocol_liquidity, SNAPSHOT_STEP)
            .map_err(|_| DexxerError::MathOverflow)?;
        pool.insurance =
            floor_step(self.insurance, SNAPSHOT_STEP).map_err(|_| DexxerError::MathOverflow)?;
        pool.fees_accrued =
            floor_step(self.fees_accrued, SNAPSHOT_STEP).map_err(|_| DexxerError::MathOverflow)?;
        pool.locked_total =
            ceil_step(self.locked_total, SNAPSHOT_STEP).map_err(|_| DexxerError::MathOverflow)?;
        pool.bad_debt_total =
            ceil_step(self.bad_debt_total, SNAPSHOT_STEP).map_err(|_| DexxerError::MathOverflow)?;
        pool.last_commit_slot = slot;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_rounds_assets_down_liabilities_up() {
        let mint = Pubkey::new_unique();
        let live = PoolLive {
            version: 1,
            mint,
            capital_total: 1_250_000_001,
            protocol_liquidity: 999_999_999,
            locked_total: 48_200_000_001,
            fees_accrued: 199_999_999,
            insurance: 100_000_000,
            bad_debt_total: 1,
            bump: 0,
        };
        let mut pool = Pool {
            version: 1,
            mint,
            vault_ata: Pubkey::default(),
            capital_total: 0,
            protocol_liquidity: 0,
            locked_total: 0,
            fees_accrued: 0,
            insurance: 0,
            bad_debt_total: 0,
            last_commit_slot: 0,
            bump: 0,
        };
        live.snapshot_into(&mut pool, 42).unwrap();
        assert_eq!(pool.capital_total, 1_200_000_000);
        assert_eq!(pool.protocol_liquidity, 900_000_000);
        assert_eq!(pool.locked_total, 48_300_000_000);
        assert_eq!(pool.fees_accrued, 100_000_000);
        assert_eq!(pool.insurance, 100_000_000);
        assert_eq!(pool.bad_debt_total, 100_000_000);
        assert_eq!(pool.last_commit_slot, 42);
    }

    #[test]
    fn snapshot_rejects_mint_mismatch() {
        let live = PoolLive {
            version: 1,
            mint: Pubkey::new_unique(),
            capital_total: 0,
            protocol_liquidity: 0,
            locked_total: 0,
            fees_accrued: 0,
            insurance: 0,
            bad_debt_total: 0,
            bump: 0,
        };
        let mut pool = Pool {
            version: 1,
            mint: Pubkey::new_unique(),
            vault_ata: Pubkey::default(),
            capital_total: 0,
            protocol_liquidity: 0,
            locked_total: 0,
            fees_accrued: 0,
            insurance: 0,
            bad_debt_total: 0,
            last_commit_slot: 0,
            bump: 0,
        };
        assert!(live.snapshot_into(&mut pool, 1).is_err());
    }
}
