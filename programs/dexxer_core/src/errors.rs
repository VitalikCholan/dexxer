// programs/dexxer_core/src/errors.rs
use anchor_lang::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    DivisionByZero,
    InvalidInput,
}

/// Anchor-facing error surface. `math.rs` stays free of Anchor types and returns
/// `MathError`; instructions convert with `?` through the `From` impl below.
///
/// Order matters from here down: LiteSVM tests pin error codes as
/// `DexxerError::X as u32 + 6000`, so variants after this task must never be
/// reordered — only appended.
#[error_code]
pub enum DexxerError {
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("division by zero")]
    DivisionByZero,
    #[msg("invalid input")]
    InvalidInput,
    #[msg("protocol is paused")]
    Paused,
    #[msg("opening new positions is paused")]
    OpenPaused,
    #[msg("oracle price is stale")]
    StaleOracle,
    #[msg("oracle confidence too wide")]
    OracleConfidence,
    #[msg("oracle price deviates too far from mark")]
    OracleDeviation,
    #[msg("wrong oracle feed for market")]
    WrongFeed,
    #[msg("invalid oracle account")]
    InvalidOracleAccount,
    #[msg("insufficient margin")]
    InsufficientMargin,
    #[msg("leverage too high")]
    LeverageTooHigh,
    #[msg("position too small")]
    PositionTooSmall,
    #[msg("position too large")]
    PositionTooLarge,
    #[msg("open interest cap exceeded")]
    OiCapExceeded,
    #[msg("slippage exceeded")]
    SlippageExceeded,
    #[msg("position is not empty")]
    PositionNotEmpty,
    #[msg("position is not open")]
    PositionNotOpen,
    #[msg("position is not liquidatable")]
    NotLiquidatable,
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("session key expired")]
    SessionExpired,
    #[msg("no actions left on session key")]
    NoActionsLeft,
    #[msg("account has an open position")]
    HasOpenPosition,
    #[msg("disclosure queue is full")]
    QueueFull,
    #[msg("invalid action signer")]
    InvalidActionSigner,
    #[msg("pool is insolvent")]
    PoolInsolvent,
    #[msg("invalid liquidation candidate")]
    InvalidCandidate,
    #[msg("amount must be non-zero")]
    AmountZero,
    #[msg("invalid parameters")]
    InvalidParams,
    #[msg("faucet daily limit exceeded")]
    FaucetLimit,
    #[msg("withdraw is on cooldown for this account")]
    WithdrawCooldown,
}

impl From<MathError> for anchor_lang::error::Error {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Overflow => DexxerError::MathOverflow.into(),
            MathError::DivisionByZero => DexxerError::DivisionByZero.into(),
            MathError::InvalidInput => DexxerError::InvalidInput.into(),
        }
    }
}
