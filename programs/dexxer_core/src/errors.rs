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
    /// Retired with `mark_committed` (week-5 Task 1) — kept so every later
    /// variant keeps its on-chain error number.
    #[msg("commitment not yet written for this closed position")]
    CommitmentNotWritten,
    #[msg("reveal slot not reached")]
    RevealTooEarly,
    #[msg("disclosure queue not empty")]
    QueueNotEmpty,
    #[msg("balances root has no free leaf slot")]
    RootFull,
    #[msg("invalid leaf account")]
    InvalidLeafAccount,
    /// Retired with `mark_committed` (week-5 Task 1): no instruction requires a
    /// `Closed` position any more. Kept for stable error numbering.
    #[msg("position is not closed")]
    NotClosed,
    #[msg("disclosure does not match commitment hash")]
    BadDisclosureHash,
    #[msg("account balance must be zero to exit")]
    BalanceNotZero,
    /// Unused since week-5 Task 1: `commit_aggregate` clamps every candidate to
    /// the remaining budget instead of failing. Kept for stable error numbering.
    #[msg("too many actions in one commit bundle")]
    TooManyActions,
    #[msg("PoolLive mint does not match Pool mint")]
    PoolLiveMismatch,
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
