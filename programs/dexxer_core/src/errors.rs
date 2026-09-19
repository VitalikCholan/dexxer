// programs/dexxer_core/src/errors.rs
use anchor_lang::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError { Overflow, DivisionByZero, InvalidInput }

/// Anchor-facing error surface. `math.rs` stays free of Anchor types and returns
/// `MathError`; instructions convert with `?` through the `From` impl below.
#[error_code]
pub enum DexxerError {
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("division by zero")]
    DivisionByZero,
    #[msg("invalid input")]
    InvalidInput,
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
