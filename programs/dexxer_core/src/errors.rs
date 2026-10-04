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
    /// Unused: no instruction ever raised it (a healthy position is a no-op
    /// on both liquidation paths). Kept for stable error numbering.
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
    /// Retired with trade disclosure (week-6 slots Task 1, spec §2.9): there is
    /// no `DisclosureQueue` any more. Kept for stable error numbering.
    #[msg("disclosure queue is full")]
    QueueFull,
    /// Retired with `write_commitment`/`write_disclosure` (week-6 slots Task
    /// 1). Kept for stable error numbering.
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
    /// Unused: reveal timing was enforced by selecting due records, never by
    /// this error, and reveals are gone since week-6 slots Task 1. Kept for
    /// stable error numbering.
    #[msg("reveal slot not reached")]
    RevealTooEarly,
    /// Retired by week-5 Task 2: a pending queue no longer blocks the exit —
    /// `undelegate_user` leaves the queue behind instead. Kept for stable
    /// error numbering.
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
    /// Retired with trade disclosure (week-6 slots Task 1). Kept for stable
    /// error numbering.
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
    /// Reserved by week-5 Task 2 for Task 3's per-position liquidation
    /// scheduler, so the three numbers below are fixed now and cannot shift
    /// when that task lands. Unused: a failed scheduler CPI aborts with its
    /// own error. Kept for stable error numbering.
    #[msg("scheduling the liquidation task failed")]
    LiquidationTaskFailed,
    #[msg("user account has not exited")]
    NotExited,
    /// Retired with the `DisclosureQueue` (week-6 slots Task 1). Kept for
    /// stable error numbering.
    #[msg("disclosure queue still has pending records")]
    QueueStillPending,
    #[msg("market symbol must be 1-8 bytes of A-Z0-9, zero-padded")]
    InvalidSymbol,
    /// Retired with the per-market position instructions (week-6 slots Task
    /// 2). Kept for stable error numbering.
    #[msg("owner has not onboarded (no UserAccount)")]
    NotOnboarded,
    /// `delegate_user` on an account that has exited (since the final review
    /// of week-6 slots; it raised `NotExited` before).
    #[msg("user account has exited")]
    UserExited,
    /// Retired with the per-market position instructions (week-6 slots Task
    /// 2). Kept for stable error numbering.
    #[msg("market does not exist")]
    MarketNotFound,
    /// Retired with the per-market position instructions (week-6 slots Task
    /// 2): one `Positions` account holds every market. Kept for stable error
    /// numbering.
    #[msg("the SOL position moves with the user account; other markets use the *_position instructions")]
    PrimaryPositionMismatch,
    #[msg("All position slots are in use")]
    NoFreeSlot,
    /// `increase_position` on a position that would be liquidatable at the
    /// current mark (final review of week-6 slots, C1).
    #[msg("Position is liquidatable at the current mark")]
    PositionLiquidatable,
    #[msg("all order slots are in use")]
    OrderBookFull,
    #[msg("invalid order parameters")]
    InvalidOrder,
    #[msg("order slot is empty")]
    OrderNotFound,
    /// The account predates conditional orders (no order tail, see
    /// `state/order.rs`): everything else still works; exit and re-onboard to
    /// get orders.
    #[msg("account predates conditional orders: exit and set it up again")]
    OrdersUnsupported,
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
