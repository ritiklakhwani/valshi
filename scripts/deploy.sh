#!/usr/bin/env bash
# Deploy your own Validator League instance on NEAR testnet.
#
#   PREFIX=yourname ./scripts/deploy.sh
#
# Creates <PREFIX>-league.testnet (contract) and three player accounts through the
# testnet faucet, builds the contract and deploys it with the launch parameters chosen
# by sim/simulate.mjs. Keys are saved in your OS keychain by near-cli-rs; nothing is
# written to this repo. Then run the demo against it:
#
#   CONTRACT=<PREFIX>-league.testnet ALICE=<PREFIX>-alice.testnet BOB=<PREFIX>-bob.testnet \
#   CAROL=<PREFIX>-carol.testnet LOG=docs/my-run.txt ./scripts/demo.sh
set -euo pipefail
PREFIX=${PREFIX:?set PREFIX, e.g. PREFIX=yourname}
CONTRACT=$PREFIX-league.testnet

for acct in "$CONTRACT" "$PREFIX-alice.testnet" "$PREFIX-bob.testnet" "$PREFIX-carol.testnet"; do
  near account create-account sponsor-by-faucet-service "$acct" autogenerate-new-keypair \
    save-to-keychain network-config testnet create
done

(cd contract && cargo near build non-reproducible-wasm)

near contract deploy "$CONTRACT" use-file ./contract/target/near/validator_league.wasm \
  with-init-call new json-args '{"name":"Validator League","symbol":"LEAGUE","config":{"claim_amount":"1000000000000000000000","max_claims":1000000,"min_back":"1000000000000000000","win_bps":200,"lose_bps":200,"kick_bps":3000}}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

echo "Deployed $CONTRACT"
