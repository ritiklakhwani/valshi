//! Validator League: a NEP-141 memecoin whose mechanic is fantasy sports on
//! NEAR's own validator set.
//!
//! - Anyone can `claim` a fixed amount of tokens once per account.
//! - Holders `back` one active validator by locking tokens on it.
//! - Once per epoch, anyone can call `tick`. For every backed validator the
//!   contract reads that validator's stake and the total validator stake
//!   straight from the NEAR runtime (`env::validator_stake`,
//!   `env::validator_total_stake`). No oracle, no off-chain input.
//! - If the validator's share of total stake went up since its last score,
//!   every position on it grows by `win_bps`. If the share went down, every
//!   position shrinks by `lose_bps`. If the validator dropped out of the
//!   active set, positions shrink by `kick_bps`.
//! - `unback` returns the position at its current value: the difference is
//!   minted or burned.
//!
//! All parameters are fixed at `new` and there is no owner or admin method.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

/// Fixed-point unit for the per-validator value index.
pub const INDEX_ONE: u128 = 1_000_000_000_000;
/// Validator shares are expressed in parts per 1e12 of total stake.
pub const SHARE_SCALE: u128 = 1_000_000_000_000;
/// Stakes are divided by this before computing shares to avoid u128 overflow.
const STAKE_DIVISOR: u128 = 1_000_000_000_000_000;
pub const BPS: u128 = 10_000;
/// Upper bound on how many validators can carry positions at once (bounds `tick` gas).
pub const MAX_VALIDATORS: u32 = 64;
/// Attached to `claim`; pays for the account's token storage. Excess is refunded.
pub const CLAIM_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Attached to `back`; pays for the position's storage. Returned on `unback`.
pub const POSITION_DEPOSIT: NearToken = NearToken::from_millinear(5);
pub const DECIMALS: u8 = 18;

const EVENT_STANDARD: &str = "validator_league";
const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
    Claimed,
    Positions,
    Validators,
}

/// Game parameters. Set once in `new`; there is no method that changes them.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// Tokens minted to an account on its single `claim`.
    pub claim_amount: U128,
    /// Maximum number of accounts that can ever claim.
    pub max_claims: u64,
    /// Smallest amount that can be locked on a validator.
    pub min_back: U128,
    /// Growth per epoch when the validator's stake share went up (basis points).
    pub win_bps: u16,
    /// Shrink per epoch when the validator's stake share went down (basis points).
    pub lose_bps: u16,
    /// Shrink when the validator left the active set (basis points).
    pub kick_bps: u16,
}

impl Config {
    fn assert_valid(&self) {
        require!(self.claim_amount.0 > 0, "claim_amount must be > 0");
        require!(self.max_claims > 0, "max_claims must be > 0");
        require!(self.min_back.0 > 0, "min_back must be > 0");
        require!(self.win_bps <= 1_000, "win_bps must be <= 1000");
        require!(self.lose_bps <= 1_000, "lose_bps must be <= 1000");
        require!(self.kick_bps <= 9_000, "kick_bps must be <= 9000");
    }
}

/// Scoreboard entry for one validator that currently carries positions.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ValidatorRecord {
    /// Sum of position units on this validator.
    pub units: U128,
    /// Value of one unit, scaled by INDEX_ONE. Starts at INDEX_ONE.
    pub index: U128,
    /// Stake share (parts per 1e12) at the last score.
    pub share: U128,
    /// Epoch of the last score.
    pub epoch: u64,
    /// True if the validator was out of the active set at the last score.
    pub kicked: bool,
    pub ups: u32,
    pub downs: u32,
    pub flats: u32,
    pub kicks: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Position {
    pub validator_id: AccountId,
    pub units: U128,
    /// Tokens locked when the position was opened.
    pub principal: U128,
    pub entry_epoch: u64,
}

#[near(serializers = [json])]
pub struct PositionView {
    pub validator_id: AccountId,
    pub units: U128,
    pub principal: U128,
    /// Value at the validator's last score (call `tick` first for a fresh value).
    pub value: U128,
    pub entry_epoch: u64,
}

#[near(serializers = [json])]
pub struct LiveShare {
    pub validator_id: AccountId,
    pub stake: U128,
    pub total_stake: U128,
    pub share: U128,
    pub epoch: u64,
}

#[near(serializers = [json])]
pub struct Stats {
    pub epoch: u64,
    pub launched_epoch: u64,
    pub claims: u64,
    pub max_claims: u64,
    pub total_supply: U128,
    pub backed_validators: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    config: Config,
    claimed: LookupSet<AccountId>,
    claims: u64,
    positions: LookupMap<AccountId, Position>,
    validators: IterableMap<AccountId, ValidatorRecord>,
    launched_epoch: u64,
}

fn emit_event(event: &str, data: Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

fn refund(account_id: &AccountId, amount: NearToken) {
    if !amount.is_zero() {
        let _ = Promise::new(account_id.clone()).transfer(amount);
    }
}

/// Reads the validator's stake, the total stake and the resulting share from the runtime.
fn live_share(validator_id: &AccountId) -> (u128, u128, u128) {
    let stake = env::validator_stake(validator_id).as_yoctonear();
    let total = env::validator_total_stake().as_yoctonear();
    let total_scaled = total / STAKE_DIVISOR;
    let share = if stake == 0 || total_scaled == 0 {
        0
    } else {
        (stake / STAKE_DIVISOR) * SHARE_SCALE / total_scaled
    };
    (stake, total, share)
}

#[near]
impl Contract {
    #[init]
    pub fn new(name: String, symbol: String, config: Config) -> Self {
        config.assert_valid();
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        };
        metadata.assert_valid();
        Self {
            token: FungibleToken::new(StorageKey::Token),
            metadata,
            config,
            claimed: LookupSet::new(StorageKey::Claimed),
            claims: 0,
            positions: LookupMap::new(StorageKey::Positions),
            validators: IterableMap::new(StorageKey::Validators),
            launched_epoch: env::epoch_height(),
        }
    }

    /// Mints `claim_amount` to the caller, once per account. Attach 0.01 NEAR for storage.
    #[payable]
    pub fn claim(&mut self) -> U128 {
        let account_id = env::predecessor_account_id();
        let attached = env::attached_deposit();
        require!(attached >= CLAIM_DEPOSIT, "Attach at least 0.01 NEAR for storage");
        require!(!self.claimed.contains(&account_id), "Already claimed");
        require!(self.claims < self.config.max_claims, "Claim cap reached");

        if self.token.storage_balance_of(account_id.clone()).is_none() {
            self.token.internal_register_account(&account_id);
        }
        self.claimed.insert(account_id.clone());
        self.claims += 1;

        let amount = self.config.claim_amount.0;
        self.token.internal_deposit(&account_id, amount);
        FtMint { owner_id: &account_id, amount: U128(amount), memo: Some("claim") }.emit();

        refund(&account_id, attached.saturating_sub(CLAIM_DEPOSIT));
        U128(amount)
    }

    /// Locks `amount` tokens on an active validator. One position per account.
    /// Attach 0.005 NEAR for storage; it is returned on `unback`.
    #[payable]
    pub fn back(&mut self, validator_id: AccountId, amount: U128) -> U128 {
        let account_id = env::predecessor_account_id();
        let attached = env::attached_deposit();
        require!(attached >= POSITION_DEPOSIT, "Attach at least 0.005 NEAR for storage");
        require!(self.positions.get(&account_id).is_none(), "Already backing a validator, unback first");
        require!(amount.0 >= self.config.min_back.0, "Amount is below min_back");

        // Score any pending epoch first, so nobody can enter after a result is known
        // but before it is applied.
        self.settle(&validator_id);

        let (stake, _, share) = live_share(&validator_id);
        require!(stake > 0, "Not an active validator in the current epoch");

        let epoch = env::epoch_height();
        if !self.validators.contains_key(&validator_id) {
            require!(self.validators.len() < MAX_VALIDATORS, "Too many validators carry positions");
            self.validators.insert(
                validator_id.clone(),
                ValidatorRecord {
                    units: U128(0),
                    index: U128(INDEX_ONE),
                    share: U128(share),
                    epoch,
                    kicked: false,
                    ups: 0,
                    downs: 0,
                    flats: 0,
                    kicks: 0,
                },
            );
        }

        self.token.internal_withdraw(&account_id, amount.0);
        FtBurn { owner_id: &account_id, amount, memo: Some("back") }.emit();

        let record = self.validators.get_mut(&validator_id).unwrap();
        let units = amount.0 * INDEX_ONE / record.index.0;
        require!(units > 0, "Amount too small for the current index");
        record.units = U128(record.units.0 + units);
        let index = record.index;

        self.positions.insert(
            account_id.clone(),
            Position { validator_id: validator_id.clone(), units: U128(units), principal: amount, entry_epoch: epoch },
        );
        emit_event(
            "back",
            json!({
                "account_id": account_id,
                "validator_id": validator_id,
                "amount": amount,
                "units": U128(units),
                "index": index,
                "epoch": epoch,
            }),
        );

        refund(&account_id, attached.saturating_sub(POSITION_DEPOSIT));
        U128(units)
    }

    /// Closes the caller's position at its current value and returns the storage deposit.
    pub fn unback(&mut self) -> U128 {
        let account_id = env::predecessor_account_id();
        let position = self.positions.remove(&account_id);
        require!(position.is_some(), "No open position");
        let position = position.unwrap();
        let validator_id = position.validator_id.clone();

        self.settle(&validator_id);

        let record = self.validators.get_mut(&validator_id).unwrap();
        let value = position.units.0 * record.index.0 / INDEX_ONE;
        record.units = U128(record.units.0 - position.units.0);
        let empty = record.units.0 == 0;
        let index = record.index;
        if empty {
            self.validators.remove(&validator_id);
        }

        if value > 0 {
            self.token.internal_deposit(&account_id, value);
            FtMint { owner_id: &account_id, amount: U128(value), memo: Some("unback") }.emit();
        }
        emit_event(
            "unback",
            json!({
                "account_id": account_id,
                "validator_id": validator_id,
                "principal": position.principal,
                "value": U128(value),
                "index": index,
                "epoch": env::epoch_height(),
            }),
        );

        refund(&account_id, POSITION_DEPOSIT);
        U128(value)
    }

    /// Scores every backed validator that has not been scored in the current epoch.
    /// Callable by anyone. Never panics; returns how many validators were scored.
    pub fn tick(&mut self) -> u32 {
        let ids: Vec<AccountId> = self.validators.keys().cloned().collect();
        let mut scored = 0;
        for validator_id in ids {
            if self.settle(&validator_id) {
                scored += 1;
            }
        }
        if scored == 0 {
            log!(
                "Nothing to score: every backed validator is already scored for epoch {}",
                env::epoch_height()
            );
        }
        scored
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            epoch: env::epoch_height(),
            launched_epoch: self.launched_epoch,
            claims: self.claims,
            max_claims: self.config.max_claims,
            total_supply: U128(self.token.total_supply),
            backed_validators: self.validators.len(),
        }
    }

    pub fn has_claimed(&self, account_id: AccountId) -> bool {
        self.claimed.contains(&account_id)
    }

    pub fn get_position(&self, account_id: AccountId) -> Option<PositionView> {
        let position = self.positions.get(&account_id)?;
        let index = self.validators.get(&position.validator_id).map(|r| r.index.0).unwrap_or(INDEX_ONE);
        Some(PositionView {
            validator_id: position.validator_id.clone(),
            units: position.units,
            principal: position.principal,
            value: U128(position.units.0 * index / INDEX_ONE),
            entry_epoch: position.entry_epoch,
        })
    }

    pub fn get_validator(&self, validator_id: AccountId) -> Option<ValidatorRecord> {
        self.validators.get(&validator_id).cloned()
    }

    pub fn get_validators(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, ValidatorRecord)> {
        self.validators
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_VALIDATORS) as usize)
            .map(|(id, record)| (id.clone(), record.clone()))
            .collect()
    }

    /// Live stake share of any account as the runtime reports it right now.
    pub fn get_live_share(&self, validator_id: AccountId) -> LiveShare {
        let (stake, total, share) = live_share(&validator_id);
        LiveShare {
            validator_id,
            stake: U128(stake),
            total_stake: U128(total),
            share: U128(share),
            epoch: env::epoch_height(),
        }
    }
}

impl Contract {
    /// Applies the score for `validator_id` if it has not been scored this epoch.
    /// Returns true if a score was applied.
    fn settle(&mut self, validator_id: &AccountId) -> bool {
        let epoch = env::epoch_height();
        let (win_bps, lose_bps, kick_bps) =
            (self.config.win_bps as u128, self.config.lose_bps as u128, self.config.kick_bps as u128);
        let Some(record) = self.validators.get_mut(validator_id) else {
            return false;
        };
        if record.epoch >= epoch {
            return false;
        }

        let (stake, total, share) = live_share(validator_id);
        let old_share = record.share.0;
        let old_index = record.index.0;

        let (outcome, new_index) = if stake == 0 {
            if record.kicked {
                record.flats += 1;
                ("still_out", old_index)
            } else {
                record.kicked = true;
                record.kicks += 1;
                ("kicked", old_index * (BPS - kick_bps) / BPS)
            }
        } else {
            record.kicked = false;
            if share > old_share {
                record.ups += 1;
                ("up", old_index * (BPS + win_bps) / BPS)
            } else if share < old_share {
                record.downs += 1;
                ("down", old_index * (BPS - lose_bps) / BPS)
            } else {
                record.flats += 1;
                ("flat", old_index)
            }
        };

        record.index = U128(new_index.max(1));
        record.share = U128(share);
        record.epoch = epoch;
        let index = record.index;

        emit_event(
            "score",
            json!({
                "validator_id": validator_id,
                "epoch": epoch,
                "outcome": outcome,
                "old_share": U128(old_share),
                "new_share": U128(share),
                "stake": U128(stake),
                "total_stake": U128(total),
                "index": index,
            }),
        );
        true
    }
}

// ---------- NEP-141 / NEP-145 / NEP-148 plumbing ----------

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used_amount, burned_amount) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned_amount > 0 {
            log!("Account @{} burned {}", sender_id, burned_amount);
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        require!(
            self.positions.get(&env::predecessor_account_id()).is_none(),
            "Unback before unregistering"
        );
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            log!("Closed @{} with {}", account_id, balance);
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests;
