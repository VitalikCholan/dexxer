use crate::{
    errors::DexxerError, instructions::trade::finalize_close, math, oracle::read_price, risk,
    state::*,
};
use anchor_lang::prelude::*;
use magicblock_magic_program_api::pda::CRANK_SIGNER;

#[derive(Accounts)]
pub struct CrankTick<'info> {
    pub crank: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump,
        constraint = crank.key() == config.crank || crank.key().to_bytes() == CRANK_SIGNER.to_bytes() @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [RISK_SEED, market.key().as_ref()], bump = market_risk.bump, has_one = market)]
    pub market_risk: Account<'info, MarketRisk>,
    #[account(mut, seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    /// CHECK: validated in oracle::read_price
    pub feed: UncheckedAccount<'info>,
}

// anchor-lang 1.0.2's `Context<'info, T>` carries a single lifetime (not the
// 4-lifetime `Context<'a, 'b, 'c, 'info, T>` of older Anchor versions), so the
// wrapper below forwards just `'info` — matching how `remaining_accounts:
// &'info [AccountInfo<'info>]` is declared on `Context` itself.
pub fn crank_tick<'info>(mut ctx: Context<'info, CrankTick<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    let market_key = a.market.key();
    // (1) oracle
    let px = match read_price(&a.feed.to_account_info(), &a.market, &a.config, &clock) {
        Ok(p) => p,
        Err(_) => {
            let m = &mut a.market;
            m.stale_ticks = m
                .stale_ticks
                .checked_add(1)
                .ok_or(DexxerError::MathOverflow)?;
            if m.stale_ticks >= m.max_stale_ticks {
                m.paused_open = true;
            }
            return Ok(()); // stale -> no mark update, no liquidations (spec §3.5)
        }
    };
    // (2) mark EMA + deviation guard. Snapshot the mark from *before* this
    // tick's EMA update: measuring deviation against a mark the EMA has
    // already absorbed this same index sample into would understate drift
    // (the mark chases the index within the same tick) and could let a
    // liquidation run on a tick whose index was itself the deviating outlier.
    let m = &mut a.market;
    m.stale_ticks = 0;
    let prev_mark = m.mark;
    // First tick ever (no mark seeded yet): seed mark = index, no deviation
    // check possible (nothing to compare against) and opens stay unpaused.
    let tripped = if prev_mark == 0 {
        m.mark = px.price;
        false
    } else {
        m.mark = math::ema(prev_mark, px.price, m.ema_alpha_bps as u32)?;
        let dev_bps = (px.price.abs_diff(prev_mark) as u128)
            .checked_mul(10_000)
            .ok_or(DexxerError::MathOverflow)?
            .checked_div(prev_mark as u128)
            .ok_or(DexxerError::MathOverflow)?;
        dev_bps > m.max_deviation_bps as u128
    };
    m.mark_slot = clock.slot;
    m.paused_open = tripped;
    if tripped {
        // Index deviated from the previous mark: the EMA still absorbed the
        // sample (so the guard self-clears as the mark converges), but this
        // tick's index is not trustworthy enough to liquidate anyone on.
        return Ok(());
    }
    let mark = m.mark;
    // (3)-(5) candidates: pairs [position, user_account]
    let rem = ctx.remaining_accounts;
    require!(
        rem.len() % 2 == 0 && rem.len() / 2 <= MAX_CANDIDATES,
        DexxerError::InvalidCandidate
    );
    // Reject a duplicate [Position, UserAccount] pair inside the same
    // remaining_accounts list — without this, the same candidate passed
    // twice would run `liquidatable_now`/hysteresis logic twice in one tx,
    // double-incrementing `liq_ticks` and being able to trip liquidation a
    // tick early.
    let mut seen: [Pubkey; MAX_CANDIDATES] = [Pubkey::default(); MAX_CANDIDATES];
    let mut seen_len: usize = 0;
    for pair in rem.chunks(2) {
        let (pos_ai, user_ai) = (&pair[0], &pair[1]);
        require!(
            pos_ai.owner == &crate::ID
                && user_ai.owner == &crate::ID
                && pos_ai.is_writable
                && user_ai.is_writable,
            DexxerError::InvalidCandidate
        );
        require!(
            !seen[..seen_len].contains(&pos_ai.key()),
            DexxerError::InvalidCandidate
        );
        seen[seen_len] = pos_ai.key();
        seen_len = seen_len.checked_add(1).ok_or(DexxerError::MathOverflow)?;
        let mut pos = Position::try_deserialize(&mut &pos_ai.try_borrow_data()?[..])?;
        let mut user = UserAccount::try_deserialize(&mut &user_ai.try_borrow_data()?[..])?;
        require!(
            pos.market == market_key && pos.owner == user.owner,
            DexxerError::InvalidCandidate
        );
        let (exp_pos, _) = Pubkey::find_program_address(
            &[POSITION_SEED, pos.owner.as_ref(), market_key.as_ref()],
            &crate::ID,
        );
        let (exp_user, _) =
            Pubkey::find_program_address(&[USER_SEED, user.owner.as_ref()], &crate::ID);
        require!(
            pos_ai.key() == exp_pos && user_ai.key() == exp_user,
            DexxerError::InvalidCandidate
        );
        if pos.state != PositionState::Open {
            continue;
        }
        if risk::liquidatable_now(&pos, &a.market, mark)? {
            pos.liq_ticks = pos
                .liq_ticks
                .checked_add(1)
                .ok_or(DexxerError::MathOverflow)?;
            if pos.liq_ticks >= a.market.liq_hysteresis_ticks {
                let fee_bps = a.market.liq_fee_bps as u32;
                let delay = a.config.disclosure_delay_slots;
                finalize_close(
                    market_key,
                    &mut a.market_risk,
                    &mut a.pool,
                    &mut user,
                    &mut pos,
                    mark,
                    fee_bps,
                    CloseReason::Liquidated,
                    &clock,
                    delay,
                )?;
            }
        } else {
            pos.liq_ticks = 0;
        }
        pos.try_serialize(&mut &mut pos_ai.try_borrow_mut_data()?[..])?;
        user.try_serialize(&mut &mut user_ai.try_borrow_mut_data()?[..])?;
    }
    Ok(())
}
