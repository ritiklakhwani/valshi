#!/usr/bin/env bash
# Scripted Validator League demo on NEAR testnet.
#
# Needs near-cli-rs and keys for the accounts below in your keychain
# (see scripts/deploy.sh to create your own). Every step prints the transaction ID;
# the run is also written to docs/demo-run.txt.
#
#   CONTRACT=validator-league.testnet ALICE=... BOB=... CAROL=... ./scripts/demo.sh

set -uo pipefail
CONTRACT=${CONTRACT:-validator-league.testnet}
ALICE=${ALICE:-league-alice.testnet}
BOB=${BOB:-league-bob.testnet}
CAROL=${CAROL:-league-carol.testnet}
V_ALICE=${V_ALICE:-node0}                        # biggest testnet validator
V_BOB=${V_BOB:-aurora.pool.f863973.m0}           # mid-size
V_CAROL=${V_CAROL:-kraken.pool.f863973.m0}       # smallest
LOG=${LOG:-docs/demo-run.txt}
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

strip() { sed -e 's/\x1b\[[0-9;]*m//g'; }

say() { echo "" | tee -a "$LOG"; echo "## $*" | tee -a "$LOG"; }

call() { # call <signer> <method> <json> <deposit>
  local out
  out=$(near contract call-function as-transaction "$CONTRACT" "$2" json-args "$3" \
    prepaid-gas '100 Tgas' attached-deposit "$4" sign-as "$1" \
    network-config testnet sign-with-keychain send 2>&1 | strip)
  echo "signer=$1 method=$2 args=$3 deposit=$4" | tee -a "$LOG"
  echo "$out" | grep -E "Transaction ID|Function execution return value|EVENT_JSON|Nothing to score|Smart contract panicked|Error|error" \
    | grep -v "ed25519:" | sed 's/^[^A-Za-z{]*//' | tee -a "$LOG"
}

view() { # view <method> <json>
  echo "view $1 $2" | tee -a "$LOG"
  near contract call-function as-read-only "$CONTRACT" "$1" json-args "$2" network-config testnet now 2>&1 \
    | strip | sed -n '/^[\[{]/,/^[\]}]/p' | tee -a "$LOG"
}

say "Contract and rules"
view get_config '{}'
view get_stats '{}'

say "1. Three players claim their one-time 1000 LEAGUE"
call "$ALICE" claim '{}' '0.01 NEAR'
call "$BOB" claim '{}' '0.01 NEAR'
call "$CAROL" claim '{}' '0.01 NEAR'

say "2. Claiming twice is refused"
call "$ALICE" claim '{}' '0.01 NEAR'

say "3. Backing an account that is not an active validator is refused"
call "$CAROL" back "{\"validator_id\":\"$BOB\",\"amount\":\"100000000000000000000\"}" '0.005 NEAR'

say "4. Each player backs a real testnet validator (live stake share read on-chain)"
view get_live_share "{\"validator_id\":\"$V_ALICE\"}"
call "$ALICE" back "{\"validator_id\":\"$V_ALICE\",\"amount\":\"500000000000000000000\"}" '0.005 NEAR'
view get_live_share "{\"validator_id\":\"$V_BOB\"}"
call "$BOB" back "{\"validator_id\":\"$V_BOB\",\"amount\":\"500000000000000000000\"}" '0.005 NEAR'
view get_live_share "{\"validator_id\":\"$V_CAROL\"}"
call "$CAROL" back "{\"validator_id\":\"$V_CAROL\",\"amount\":\"500000000000000000000\"}" '0.005 NEAR'

say "5. A second position for the same account is refused"
call "$BOB" back "{\"validator_id\":\"$V_ALICE\",\"amount\":\"100000000000000000000\"}" '0.005 NEAR'

say "6. tick in the launch epoch scores nothing (scores happen once per epoch) and does not fail"
call "$BOB" tick '{}' '0 NEAR'

say "7. Scoreboard and positions"
view get_validators '{}'
view get_position "{\"account_id\":\"$ALICE\"}"
view get_stats '{}'
view ft_balance_of "{\"account_id\":\"$ALICE\"}"

say "Done. After the next epoch boundary anyone can call tick to score these validators."
