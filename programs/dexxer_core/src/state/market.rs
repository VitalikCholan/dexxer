use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub version: u8,
    pub symbol: [u8; 8],
    pub feed: Pubkey,
    pub max_lev_bps: u32,
    pub imr_bps: u32,
    pub mmr_bps: u32,
    pub open_fee_bps: u16,
    pub close_fee_bps: u16,
    pub liq_fee_bps: u16,
    pub oi_cap: u64,
    pub max_position: u64,
    pub min_size: u64,
    pub max_staleness_secs: u64,
    pub max_conf_bps: u16,
    pub max_deviation_bps: u16,
    pub mark: u64,
    pub mark_slot: u64,
    pub ema_alpha_bps: u16,
    pub liq_hysteresis_ticks: u8,
    pub max_stale_ticks: u16,
    pub paused_open: bool,
    pub stale_ticks: u16,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct MarketParams {
    pub max_lev_bps: u32,
    pub imr_bps: u32,
    pub mmr_bps: u32,
    pub open_fee_bps: u16,
    pub close_fee_bps: u16,
    pub liq_fee_bps: u16,
    pub oi_cap: u64,
    pub max_position: u64,
    pub min_size: u64,
    pub max_staleness_secs: u64,
    pub max_conf_bps: u16,
    pub max_deviation_bps: u16,
    pub ema_alpha_bps: u16,
    pub liq_hysteresis_ticks: u8,
    pub max_stale_ticks: u16,
}

impl MarketParams {
    pub fn sol_perp_defaults() -> Self {
        Self {
            max_lev_bps: 100_000,
            imr_bps: 1000,
            mmr_bps: 500,
            open_fee_bps: 6,
            close_fee_bps: 6,
            liq_fee_bps: 100,
            oi_cap: 0,
            max_position: 100_000_000_000,
            min_size: 10_000_000,
            max_staleness_secs: 2,
            max_conf_bps: 50,
            max_deviation_bps: 200,
            ema_alpha_bps: 3000,
            liq_hysteresis_ticks: 2,
            max_stale_ticks: 30,
        }
    }

    pub fn validate(&self) -> bool {
        self.imr_bps > self.mmr_bps
            && self.mmr_bps > 0
            && self.max_lev_bps >= 10_000
            && self.ema_alpha_bps <= 10_000
            && self.liq_hysteresis_ticks >= 1
    }
}

// `oi_cap: 0` means "30% of capital", computed in `risk.rs` from `Pool.capital_total`
// when `oi_cap == 0`; an explicit value is an absolute limit.
