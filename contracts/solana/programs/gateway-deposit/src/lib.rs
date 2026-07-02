use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, Burn, Token2022};
use anchor_spl::token_interface::{Mint, TokenAccount};

declare_id!("MCFeMZJYARXVcLvuFbajFC8BzHZNS6Ef8DV59RiteL1");

#[program]
pub mod gateway_deposit {
    use super::*;

    /// Burn `amount` wVIZ from the deposit ATA owned by the PDA derived from
    /// `viz_account`. This is the ONLY state-changing instruction: there is no
    /// path to transfer deposit tokens anywhere. Permissionless — burning cannot
    /// steal, and the value handoff (VIZ release) is M-of-N + F2-validated.
    pub fn burn_deposit(ctx: Context<BurnDeposit>, viz_account: String, amount: u64) -> Result<()> {
        let bump = ctx.bumps.deposit_authority;
        let seeds: &[&[u8]] = &[b"deposit", viz_account.as_bytes(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        token_2022::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.deposit_ata.to_account_info(),
                    authority: ctx.accounts.deposit_authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )
    }
}

#[derive(Accounts)]
#[instruction(viz_account: String)]
pub struct BurnDeposit<'info> {
    /// PDA that owns the deposit ATA; off-curve, no private key. The "deposit address".
    #[account(seeds = [b"deposit", viz_account.as_bytes()], bump)]
    pub deposit_authority: SystemAccount<'info>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = deposit_authority,
        associated_token::token_program = token_program,
    )]
    pub deposit_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token2022>,
}
