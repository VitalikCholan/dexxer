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
    /// Identity (`posted_slot`) of the latest oracle print `crank_tick` has seen.
    pub last_print: u64,
    /// Number of distinct oracle prints `crank_tick` has seen (risk #38). Only
    /// `crank_tick` writes it; `liq_due` counts a tick per new value.
    pub sample_seq: u64,
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
            // 2 distinct price samples (`Market.sample_seq` guards
            // the count, risk #38 — it was 3 while two callers double-counted).
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

/// A market symbol: 1–8 bytes of `A-Z0-9`, left-aligned and zero-padded
/// (`b"BTC\0\0\0\0\0"`). It is a PDA seed, so a lowercase twin or a stray byte
/// after the padding would mint a second address for "the same" market.
pub fn validate_symbol(symbol: &[u8; 8]) -> bool {
    let len = symbol.iter().position(|&b| b == 0).unwrap_or(symbol.len());
    len > 0
        && symbol[..len]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && symbol[len..].iter().all(|&b| b == 0)
}

#[cfg(test)]
mod symbol_tests {
    use super::validate_symbol;

    fn sym(s: &str) -> [u8; 8] {
        let mut b = [0u8; 8];
        b[..s.len()].copy_from_slice(s.as_bytes());
        b
    }

    #[test]
    fn accepts_uppercase_and_digits_zero_padded() {
        for s in ["SOL", "BTC", "HYPE", "ZEC", "ABCDEFGH", "1INCH"] {
            assert!(validate_symbol(&sym(s)), "{s}");
        }
    }

    #[test]
    fn rejects_empty_lowercase_and_punctuation() {
        for s in ["", "btc", "Btc", "BTC-", "B C", "ÄB"] {
            assert!(!validate_symbol(&sym(s)), "{s:?}");
        }
    }

    #[test]
    fn rejects_bytes_after_the_padding() {
        let mut b = sym("BTC");
        b[4] = b'X';
        assert!(!validate_symbol(&b));
    }
}
