use crate::{
    errors::DexxerError,
    state::{Config, Market},
};
use anchor_lang::prelude::*;

pub const FEED_SEED: &[u8] = b"price_feed";
pub const LAZER_SEED: &[u8] = b"pyth-lazer";
const PRICE_SCALE: i128 = 1_000_000;

pub struct OraclePrice {
    pub price: u64,    // 1e6 scale
    pub conf_bps: u32, // basis points
    pub publish_time: i64,
    pub posted_slot: u64,
}

pub fn feed_pda(oracle_program: &Pubkey, lazer_feed_id: &str) -> Pubkey {
    Pubkey::find_program_address(
        &[FEED_SEED, LAZER_SEED, lazer_feed_id.as_bytes()],
        oracle_program,
    )
    .0
}

fn rd<const N: usize>(d: &[u8], o: usize) -> Result<[u8; N]> {
    let end = o
        .checked_add(N)
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;
    d.get(o..end)
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))
}

pub fn parse_price_update(data: &[u8]) -> Result<OraclePrice> {
    // Layout: 8 disc | 32 write_authority | 1 tag (+1 if Partial) | 32 feed_id | i64 price | u64 conf | i32 expo | i64 publish | i64 prev | i64 ema | u64 ema_conf | u64 posted | 1 trailing
    let tag = *data
        .get(40)
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;
    let mut o: usize = match tag {
        0 => 42,
        1 => 41,
        _ => return err!(DexxerError::InvalidOracleAccount),
    };

    o = o
        .checked_add(32)
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;
    let price = i64::from_le_bytes(rd::<8>(data, o)?);
    o = o
        .checked_add(8)
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;

    let conf = u64::from_le_bytes(rd::<8>(data, o)?);
    o = o
        .checked_add(8)
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;

    let expo = i32::from_le_bytes(rd::<4>(data, o)?);
    o = o
        .checked_add(4)
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;

    let publish_time = i64::from_le_bytes(rd::<8>(data, o)?);
    o = o
        .checked_add(8)
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;
    o = o
        .checked_add(8)
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;
    o = o
        .checked_add(8)
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;
    o = o
        .checked_add(8)
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;

    let posted_slot = u64::from_le_bytes(rd::<8>(data, o)?);

    require!(price > 0, DexxerError::InvalidOracleAccount);

    // price_1e6 = price * 1e6 / 10^|expo| (expo stored as +8 on this feed; support ±)
    let price_scaled = (price as i128)
        .checked_mul(PRICE_SCALE)
        .ok_or_else(|| error!(DexxerError::MathOverflow))?;
    let divisor = 10i128
        .checked_pow(expo.unsigned_abs())
        .ok_or_else(|| error!(DexxerError::MathOverflow))?;
    let price_1e6 = price_scaled
        .checked_div(divisor)
        .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?; // Truncate down for index entry; direction neutralizes client slippage guard
    require!(
        price_1e6 > 0 && price_1e6 <= u64::MAX as i128,
        DexxerError::InvalidOracleAccount
    );

    // conf_bps = ceil(conf * 1e4 / price)
    let conf_bps = {
        let numerator = (conf as u128)
            .checked_mul(10_000)
            .ok_or_else(|| error!(DexxerError::MathOverflow))?;
        let price_u128 = price as u128;
        let price_minus_one = price_u128
            .checked_sub(1)
            .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;
        let ceil_result = numerator
            .checked_add(price_minus_one)
            .ok_or_else(|| error!(DexxerError::MathOverflow))?;
        let result = ceil_result
            .checked_div(price_u128)
            .ok_or_else(|| error!(DexxerError::InvalidOracleAccount))?;
        result.min(u32::MAX as u128) as u32
    };

    Ok(OraclePrice {
        price: price_1e6 as u64,
        conf_bps,
        publish_time,
        posted_slot,
    })
}

pub fn read_price(
    feed: &AccountInfo,
    market: &Market,
    config: &Config,
    clock: &Clock,
) -> Result<OraclePrice> {
    require_keys_eq!(feed.key(), market.feed, DexxerError::WrongFeed);
    require_keys_eq!(*feed.owner, config.oracle_program, DexxerError::WrongFeed);
    let p = parse_price_update(&feed.try_borrow_data()?)?;
    require!(p.posted_slot > 0, DexxerError::StaleOracle);
    let age = clock
        .unix_timestamp
        .checked_sub(p.publish_time)
        .ok_or_else(|| error!(DexxerError::StaleOracle))?;
    require!(
        age >= 0 && (age as u64) <= market.max_staleness_secs,
        DexxerError::StaleOracle
    );
    Ok(p)
}

pub fn check_open_quality(p: &OraclePrice, market: &Market) -> Result<()> {
    // conf == 0 = "not filled" (devnet feed); max_conf_bps == 0 means "skip confidence check"
    if market.max_conf_bps == 0 {
        return Ok(());
    }
    require!(p.conf_bps > 0, DexxerError::OracleConfidence);
    require!(
        p.conf_bps <= market.max_conf_bps as u32,
        DexxerError::OracleConfidence
    );
    Ok(())
}

/// Reject opening/increasing exposure when the fresh index price has drifted
/// too far from the market's already-published mark. `mark == 0` means no
/// mark has been seeded yet (no crank tick has run), so there is nothing to
/// deviate from and the check is skipped. Closes/decreases never call this —
/// a trader must always be able to exit (spec §3.4).
pub fn check_deviation(px: &OraclePrice, market: &Market) -> Result<()> {
    if market.mark == 0 {
        return Ok(());
    }
    let diff_bps = (px.price.abs_diff(market.mark) as u128)
        .checked_mul(10_000)
        .ok_or_else(|| error!(DexxerError::MathOverflow))?
        .checked_div(market.mark as u128)
        .ok_or_else(|| error!(DexxerError::MathOverflow))?;
    require!(
        diff_bps <= market.max_deviation_bps as u128,
        DexxerError::OracleDeviation
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // devnet feed bytes: disc | writeAuthority(0) | tag=1 | feedId | price | conf | expo=8 | publish | prev | ema | emaConf | posted | trailing
    fn fixture(price: i64, conf: u64, expo: i32, publish: i64, posted: u64) -> Vec<u8> {
        let mut d = vec![234u8, 161, 14, 36, 172, 239, 15, 232];
        d.extend_from_slice(&[0u8; 32]);
        d.push(1);
        d.extend_from_slice(&hex_literal(
            "c6ad3e841d9c0f248adff90cf776f839fd59f1cbd8ffbc8f9402883ea16e8420",
        ));
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&conf.to_le_bytes());
        d.extend_from_slice(&expo.to_le_bytes());
        d.extend_from_slice(&publish.to_le_bytes());
        d.extend_from_slice(&publish.to_le_bytes());
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&conf.to_le_bytes());
        d.extend_from_slice(&posted.to_le_bytes());
        d.push(0);
        assert_eq!(d.len(), 134);
        d
    }

    fn hex_literal(s: &str) -> [u8; 32] {
        let mut o = [0u8; 32];
        for i in 0..32 {
            o[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
        }
        o
    }

    #[test]
    fn parses_expo_plus_8_as_divisor() {
        let p = parse_price_update(&fixture(
            11_282_999_668,
            5_000_000,
            8,
            1_700_000_000,
            317_000_000,
        ))
        .unwrap();
        assert_eq!(p.price, 112_829_996); // 112.829996 $ in 1e6
        assert_eq!(p.posted_slot, 317_000_000);
    }

    #[test]
    fn conf_in_bps_rounds_up() {
        let p = parse_price_update(&fixture(10_000_000_000, 5_000_001, 8, 0, 1)).unwrap(); // conf 0.05000001 % → 5.000001 bps
        assert_eq!(p.conf_bps, 6);
    }

    #[test]
    fn partial_tag_shifts_offsets_by_one() {
        let mut d = fixture(10_000_000_000, 0, 8, 0, 1);
        d[40] = 0;
        d.insert(41, 3); // Partial{num_signatures:3}
        assert_eq!(parse_price_update(&d).unwrap().price, 100_000_000);
    }

    #[test]
    fn negative_exponent_also_supported() {
        assert_eq!(
            parse_price_update(&fixture(100_000_000, 0, -8, 0, 1))
                .unwrap()
                .price,
            1_000_000
        );
    }

    #[test]
    fn too_short_is_error() {
        assert!(parse_price_update(&fixture(1, 0, 8, 0, 1)[..100]).is_err());
    }

    #[test]
    fn nonpositive_price_is_error() {
        assert!(parse_price_update(&fixture(0, 0, 8, 0, 1)).is_err());
    }

    // Builds the `mock_oracle` `Feed.body` byte-for-byte the way its
    // `init_feed`/`set_price` instructions do (same index arithmetic, copied
    // from `programs/mock_oracle/src/lib.rs`), then prepends the 8-byte Anchor
    // discriminator this parser ignores. Ties both programs to identical
    // offsets so a change on either side that breaks the layout fails here.
    #[test]
    fn mock_layout_matches_parser() {
        const BODY: usize = 126;
        let price_1e8: i64 = 15_000_000_000;
        let conf: u64 = 5_000_000;
        let publish_time: i64 = 1_700_000_000;
        let posted_slot: u64 = 317_000_000;
        let authority = [7u8; 32];

        // init_feed
        let mut body = [0u8; BODY];
        body[0..32].copy_from_slice(&authority);
        body[32] = 1;
        body[33..65].copy_from_slice(&[0xc6u8; 32]);
        body[81..85].copy_from_slice(&8i32.to_le_bytes());

        // set_price
        body[65..73].copy_from_slice(&price_1e8.to_le_bytes());
        body[73..81].copy_from_slice(&conf.to_le_bytes());
        body[85..93].copy_from_slice(&publish_time.to_le_bytes());
        body[93..101].copy_from_slice(&publish_time.to_le_bytes());
        body[101..109].copy_from_slice(&price_1e8.to_le_bytes());
        body[109..117].copy_from_slice(&conf.to_le_bytes());
        body[117..125].copy_from_slice(&posted_slot.to_le_bytes());

        let mut account = vec![0u8; 8];
        account.extend_from_slice(&body);
        assert_eq!(account.len(), 134);

        let p = parse_price_update(&account).unwrap();
        assert_eq!(p.price, 150_000_000);
        assert_eq!(p.posted_slot, posted_slot);
        assert_eq!(p.publish_time, publish_time);
    }
}
