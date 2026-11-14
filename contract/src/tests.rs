use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;
use std::collections::HashMap;

const ONE: u128 = 1_000_000_000_000_000_000; // 1 token (18 decimals)

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// Sets the mocked chain: caller, attached deposit, epoch and the active validator set
/// (account, stake in NEAR).
fn set(caller: &str, deposit: NearToken, epoch: u64, validators: &[(&str, u128)]) {
    let context = VMContextBuilder::new()
        .current_account_id(acc("league.testnet"))
        .predecessor_account_id(acc(caller))
        .signer_account_id(acc(caller))
        .attached_deposit(deposit)
        .epoch_height(epoch)
        .build();
    let map: HashMap<String, NearToken> =
        validators.iter().map(|(a, s)| (a.to_string(), NearToken::from_near(*s))).collect();
    testing_env!(context, near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), map);
}

fn config() -> Config {
    Config {
        claim_amount: U128(1_000 * ONE),
        max_claims: 3,
        min_back: U128(ONE),
        win_bps: 200,
        lose_bps: 300,
        kick_bps: 5_000,
    }
}

const VALS: &[(&str, u128)] = &[("a.pool.testnet", 100_000), ("b.pool.testnet", 100_000)];

fn setup() -> Contract {
    set("deployer.testnet", NearToken::from_yoctonear(0), 10, VALS);
    Contract::new("Validator League".into(), "LEAGUE".into(), config())
}

fn claim(c: &mut Contract, who: &str, epoch: u64, vals: &[(&str, u128)]) {
    set(who, CLAIM_DEPOSIT, epoch, vals);
    c.claim();
}

fn back(c: &mut Contract, who: &str, v: &str, amount: u128, epoch: u64, vals: &[(&str, u128)]) {
    set(who, POSITION_DEPOSIT, epoch, vals);
    c.back(acc(v), U128(amount));
}

fn unback(c: &mut Contract, who: &str, epoch: u64, vals: &[(&str, u128)]) -> u128 {
    set(who, NearToken::from_yoctonear(0), epoch, vals);
    c.unback().0
}

fn pct(amount: u128, bps: u128) -> u128 {
    amount * bps / BPS
}

#[test]
fn init_sets_metadata_and_config() {
    let c = setup();
    let m = c.ft_metadata();
    assert_eq!(m.symbol, "LEAGUE");
    assert_eq!(m.decimals, 18);
    assert_eq!(c.get_config(), config());
    assert_eq!(c.ft_total_supply().0, 0);
    assert_eq!(c.get_stats().launched_epoch, 10);
}

#[test]
#[should_panic(expected = "kick_bps must be <= 9000")]
fn init_rejects_unsafe_config() {
    set("deployer.testnet", NearToken::from_yoctonear(0), 10, VALS);
    let mut cfg = config();
    cfg.kick_bps = 10_000;
    Contract::new("Validator League".into(), "LEAGUE".into(), cfg);
}

#[test]
fn claim_mints_once() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 1_000 * ONE);
    assert_eq!(c.ft_total_supply().0, 1_000 * ONE);
    assert!(c.has_claimed(acc("alice.testnet")));
}

#[test]
#[should_panic(expected = "Already claimed")]
fn claim_twice_fails() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    claim(&mut c, "alice.testnet", 10, VALS);
}

#[test]
#[should_panic(expected = "Attach at least 0.01 NEAR")]
fn claim_without_deposit_fails() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_yoctonear(0), 10, VALS);
    c.claim();
}

#[test]
#[should_panic(expected = "Claim cap reached")]
fn claim_cap_is_enforced() {
    let mut c = setup();
    for who in ["a1.testnet", "a2.testnet", "a3.testnet", "a4.testnet"] {
        claim(&mut c, who, 10, VALS);
    }
}

#[test]
fn back_then_unback_same_epoch_returns_principal() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", 400 * ONE, 10, VALS);
    assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 600 * ONE);
    assert_eq!(c.ft_total_supply().0, 600 * ONE);
    let value = unback(&mut c, "alice.testnet", 10, VALS);
    assert_eq!(value, 400 * ONE);
    assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 1_000 * ONE);
    assert!(c.get_validator(acc("a.pool.testnet")).is_none(), "empty record is removed");
}

#[test]
fn share_up_grows_position() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", 100 * ONE, 10, VALS);
    let next = &[("a.pool.testnet", 150_000), ("b.pool.testnet", 100_000)];
    set("keeper.testnet", NearToken::from_yoctonear(0), 11, next);
    assert_eq!(c.tick(), 1);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"score\"") && l.contains("\"outcome\":\"up\"")));
    let value = unback(&mut c, "alice.testnet", 11, next);
    assert_eq!(value, 100 * ONE + pct(100 * ONE, 200));
}

#[test]
fn share_down_shrinks_position() {
    let mut c = setup();
    claim(&mut c, "bob.testnet", 10, VALS);
    back(&mut c, "bob.testnet", "b.pool.testnet", 100 * ONE, 10, VALS);
    let next = &[("a.pool.testnet", 150_000), ("b.pool.testnet", 100_000)];
    set("keeper.testnet", NearToken::from_yoctonear(0), 11, next);
    c.tick();
    let value = unback(&mut c, "bob.testnet", 11, next);
    assert_eq!(value, 100 * ONE - pct(100 * ONE, 300));
}

#[test]
fn everyone_growing_equally_is_flat() {
    // Staking rewards grow every validator; only relative share counts.
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", 100 * ONE, 10, VALS);
    let next = &[("a.pool.testnet", 200_000), ("b.pool.testnet", 200_000)];
    set("keeper.testnet", NearToken::from_yoctonear(0), 11, next);
    c.tick();
    assert_eq!(c.get_validator(acc("a.pool.testnet")).unwrap().flats, 1);
    assert_eq!(unback(&mut c, "alice.testnet", 11, next), 100 * ONE);
}

#[test]
fn kicked_validator_burns_backers() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", 100 * ONE, 10, VALS);
    let next = &[("b.pool.testnet", 100_000)];
    set("keeper.testnet", NearToken::from_yoctonear(0), 11, next);
    c.tick();
    let rec = c.get_validator(acc("a.pool.testnet")).unwrap();
    assert!(rec.kicked);
    assert_eq!(rec.kicks, 1);
    // A second epoch out of the set does not burn again.
    set("keeper.testnet", NearToken::from_yoctonear(0), 12, next);
    c.tick();
    assert_eq!(unback(&mut c, "alice.testnet", 12, next), 50 * ONE);
}

#[test]
fn tick_scores_once_per_epoch() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", 100 * ONE, 10, VALS);
    let next = &[("a.pool.testnet", 150_000), ("b.pool.testnet", 100_000)];
    set("keeper.testnet", NearToken::from_yoctonear(0), 11, next);
    assert_eq!(c.tick(), 1);
    assert_eq!(c.tick(), 0, "second tick in the same epoch scores nothing");
    assert_eq!(c.get_validator(acc("a.pool.testnet")).unwrap().ups, 1);
}

#[test]
fn tick_in_launch_epoch_scores_nothing_and_does_not_panic() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", 100 * ONE, 10, VALS);
    set("keeper.testnet", NearToken::from_yoctonear(0), 10, VALS);
    assert_eq!(c.tick(), 0);
}

#[test]
fn wins_compound_across_epochs() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", 100 * ONE, 10, VALS);
    set("keeper.testnet", NearToken::from_yoctonear(0), 11, &[("a.pool.testnet", 110_000), ("b.pool.testnet", 100_000)]);
    c.tick();
    let e12 = &[("a.pool.testnet", 130_000), ("b.pool.testnet", 100_000)];
    set("keeper.testnet", NearToken::from_yoctonear(0), 12, e12);
    c.tick();
    let after_one = 100 * ONE + pct(100 * ONE, 200);
    let expected = after_one + pct(after_one, 200);
    assert_eq!(unback(&mut c, "alice.testnet", 12, e12), expected);
}

#[test]
fn late_entry_cannot_capture_a_pending_result() {
    // Epoch 11 makes "a" a winner, but nobody has called tick yet. Bob backs "a"
    // in epoch 11: the pending score is applied before he enters, so he gains nothing.
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    claim(&mut c, "bob.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", 100 * ONE, 10, VALS);
    let next = &[("a.pool.testnet", 150_000), ("b.pool.testnet", 100_000)];
    back(&mut c, "bob.testnet", "a.pool.testnet", 100 * ONE, 11, next);
    // Bob gets his principal back, minus at most 1 base unit of rounding.
    // Rounding always goes down (in the contract's favour), never up.
    let bob = unback(&mut c, "bob.testnet", 11, next);
    assert!(bob <= 100 * ONE && 100 * ONE - bob <= 1, "bob got {}", bob);
    assert_eq!(unback(&mut c, "alice.testnet", 11, next), 100 * ONE + pct(100 * ONE, 200));
}

#[test]
fn unback_applies_pending_loss() {
    // Leaving after a bad epoch still takes the loss: no free option.
    let mut c = setup();
    claim(&mut c, "bob.testnet", 10, VALS);
    back(&mut c, "bob.testnet", "b.pool.testnet", 100 * ONE, 10, VALS);
    let next = &[("a.pool.testnet", 150_000), ("b.pool.testnet", 100_000)];
    assert_eq!(unback(&mut c, "bob.testnet", 11, next), 100 * ONE - pct(100 * ONE, 300));
}

#[test]
#[should_panic(expected = "Not an active validator")]
fn cannot_back_a_non_validator() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "attacker.testnet", 100 * ONE, 10, VALS);
}

#[test]
#[should_panic(expected = "Already backing")]
fn one_position_per_account() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", 100 * ONE, 10, VALS);
    back(&mut c, "alice.testnet", "b.pool.testnet", 100 * ONE, 10, VALS);
}

#[test]
#[should_panic(expected = "below min_back")]
fn min_back_is_enforced() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", ONE / 2, 10, VALS);
}

#[test]
#[should_panic(expected = "The account doesn't have enough balance")]
fn cannot_back_more_than_balance() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", 2_000 * ONE, 10, VALS);
}

#[test]
#[should_panic(expected = "Unback before unregistering")]
fn cannot_unregister_with_open_position() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    back(&mut c, "alice.testnet", "a.pool.testnet", 100 * ONE, 10, VALS);
    set("alice.testnet", NearToken::from_yoctonear(1), 10, VALS);
    c.storage_unregister(Some(true));
}

#[test]
fn transfers_work_like_any_nep141() {
    let mut c = setup();
    claim(&mut c, "alice.testnet", 10, VALS);
    claim(&mut c, "bob.testnet", 10, VALS);
    set("alice.testnet", NearToken::from_yoctonear(1), 10, VALS);
    c.ft_transfer(acc("bob.testnet"), U128(250 * ONE), None);
    assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 750 * ONE);
    assert_eq!(c.ft_balance_of(acc("bob.testnet")).0, 1_250 * ONE);
}
