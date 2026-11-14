# Validator League

A NEAR memecoin whose mechanic is fantasy sports on NEAR's own validator set. You back a real validator with your tokens; every epoch the contract reads that validator's share of total stake straight from the NEAR runtime, and your position grows or shrinks with it. No oracle, no admin, no off-chain input.

Built at NEAR HACKATHON. Track: `memecoins`. Network: NEAR testnet.

**Play in your browser:** https://ritiklakhwani.github.io/validator-league/ - press "Play now" (creates a free testnet account in your browser and claims 1,000 LEAGUE), press "Back" on a validator, then "Cash out" or "tick()". No wallet or install needed. To run it locally instead: `cd web && pnpm install && pnpm dev`.

## What it does

1. **Claim.** Any account can claim 1,000 LEAGUE once (attach 0.01 NEAR for storage).
2. **Back.** Lock some LEAGUE on one active validator (one position per account).
3. **Score.** Once per epoch (about 12 hours), anyone calls `tick()`. For each backed validator the contract calls the runtime host functions `validator_stake(account)` and `validator_total_stake()` and compares the validator's share of total stake with its share at the last score:
   - share went up: every position on it grows **+2%**
   - share went down: every position on it shrinks **-2%**
   - validator dropped out of the active set: positions shrink **-30%** (once)
   - unchanged: nothing happens
4. **Unback.** Close your position at its current value. The difference from what you locked is minted or burned.

It scores relative share, not raw stake. Staking rewards make every validator's stake grow every epoch; only gaining share against the others counts.

## Why this can only exist on NEAR

NEAR contracts can read the current validator set and stakes directly (`env::validator_stake`, `env::validator_total_stake`, `env::epoch_height`). So the "match results" of this league are produced by the protocol itself and cannot be faked by an oracle, a keeper or the deployer. The meme also points holders at real information: which validators are gaining or losing delegators' trust.

## Deployed on testnet

| What | Account |
| --- | --- |
| Contract | [`validator-league.testnet`](https://testnet.nearblocks.io/address/validator-league.testnet) |
| Demo players | `league-alice.testnet` (backs `node0`, the largest validator), `league-bob.testnet` (backs `aurora.pool.f863973.m0`), `league-carol.testnet` (backs `kraken.pool.f863973.m0`, the smallest) |
| Launch epoch | 5447 |

Recorded demo run: [docs/demo-run.txt](docs/demo-run.txt). Selected transactions:

| Step | Result | Transaction |
| --- | --- | --- |
| Alice claims 1,000 LEAGUE | `ft_mint` event | [RRZi5Vxq...](https://explorer.testnet.near.org/transactions/RRZi5Vxqui7g3mLWLqrmitqzUX2K9VeVzk8kRZjMKDk) |
| Alice claims again | refused: "Already claimed" | [9EycQQj4...](https://explorer.testnet.near.org/transactions/9EycQQj4yrhNK9wsq1fxPXRKhKutLhcKrT9RcHWoG3Wg) |
| Carol backs a non-validator account | refused: "Not an active validator in the current epoch" | [H5geFfL3...](https://explorer.testnet.near.org/transactions/H5geFfL3fmxRyJMkiwvYFve6EjLtphacf6TxJX6jLRSP) |
| Alice backs `node0` with 500 | `ft_burn` + `back` events | [FNHYQMfW...](https://explorer.testnet.near.org/transactions/FNHYQMfWztfiYoT2oJynuDr4j5KAHW9cArRYzFLpnv7n) |
| Bob opens a second position | refused: "Already backing a validator, unback first" | [2jL7TA4W...](https://explorer.testnet.near.org/transactions/2jL7TA4WZHCEVnsmWKamZ7CYBv1nz4auHCR1DaszooEX) |
| `tick` in the launch epoch | no-op, logs "Nothing to score" | [JAzzS89z...](https://explorer.testnet.near.org/transactions/JAzzS89zbAta8DMnRW7vvhcNM5VjciDi288pKQrJP643) |

## Try it (do X - see Y)

Requirements: Node 18+ for steps 1 and 3; Rust with the `wasm32-unknown-unknown` target for step 2; [near-cli-rs](https://github.com/near/near-cli-rs) for steps 4-6. No keys are needed for steps 1-4.

1. **Verify the deployment, no keys:** `node scripts/verify.mjs` (or `pnpm verify`).
   You see the immutable rules, the scoreboard with each backed validator's stored share next to its live share read from the chain, the score the next `tick` would apply, and `10/10 recorded transactions match the chain`.
2. **Run the contract tests:** `cd contract && cargo test`.
   You see `22 passed`: share up, share down, everyone-grows-equally is flat, kick burns once, compounding, one score per epoch, a late entrant cannot capture a pending result, leaving cannot dodge a pending loss, refusals (double claim, non-validator, second position, below minimum, over balance, unregister with an open position), NEP-141 transfers.
3. **Run the 60-day simulation:** `node sim/simulate.mjs` (`--live` refetches the current validator set).
   You see median ending value per player for six parameter sets and four strategies, starting from the real stakes of the 27 testnet validators. Row D is the launch configuration.
4. **Read a live validator share from the contract, no keys:**
   `near contract call-function as-read-only validator-league.testnet get_live_share json-args '{"validator_id":"node0"}' network-config testnet now`
   You see `stake`, `total_stake`, `share` (parts per 1e12) and `epoch`, as the runtime reports them inside the contract.
5. **Play with your own testnet account** (create one with `near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create`):
   ```sh
   C=validator-league.testnet; ME=<you>.testnet
   near contract call-function as-transaction $C claim json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0.01 NEAR' sign-as $ME network-config testnet sign-with-keychain send
   near contract call-function as-transaction $C back json-args '{"validator_id":"node1","amount":"100000000000000000000"}' prepaid-gas '100 Tgas' attached-deposit '0.005 NEAR' sign-as $ME network-config testnet sign-with-keychain send
   near contract call-function as-transaction $C tick json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send
   near contract call-function as-transaction $C unback json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send
   ```
   You see `ft_mint`, `ft_burn`, `back`, `score` and `unback` events in the transaction logs. `tick` scores a validator at most once per epoch; in the same epoch it logs "Nothing to score".
6. **Deploy and demo your own instance:** `PREFIX=<name> ./scripts/deploy.sh`, then run `scripts/demo.sh` with the variables printed at the top of `scripts/deploy.sh`.

**About live scores:** the contract launched in testnet epoch 5447, a few hours before the submission deadline, so the first real score becomes possible after the next epoch boundary. From then on anyone can call `tick` (step 5) and `node scripts/verify.mjs` shows the result (`ups`, `downs`, `kicks`, unit value) for `node0`, `aurora.pool.f863973.m0` and `kraken.pool.f863973.m0`. Until then the scoring logic is shown by the unit tests (step 2), which mock the validator set.

## Web app

`web/` is a static page (Vite, near-api-js 7.5.3, no backend) built into `docs/play/` and served by GitHub Pages.

- League table: every active testnet validator with its live stake share (RPC `validators`), the "next matchday" projection from the published next-epoch validator set (Rising / Slipping / Leaving set), LEAGUE backing and win/loss/kick record from the contract.
- Player: "Play now" generates an ed25519 key in the browser, asks the public testnet faucet (`https://helper.nearprotocol.com/account`, the same one near-cli-rs uses) to create the account, and claims the starter pack. The key stays in the browser's local storage; this is a testnet convenience and would be replaced by a wallet connection on mainnet.
- Actions: Back (with an outcome preview for rising / slipping / dropped), Cash out, and tick(). Every action is a real transaction; the match feed links each one to the explorer.

## Repository layout

| Path | What |
| --- | --- |
| `contract/` | Rust contract (`src/lib.rs`) and unit tests (`src/tests.rs`) |
| `sim/` | 60-day simulation and the snapshot of real testnet validator stakes it starts from |
| `scripts/` | `verify.mjs` (keyless), `demo.sh` (recorded run), `deploy.sh` (your own instance) |
| `docs/demo-run.txt` | Output of the recorded testnet demo |
| `web/` | Web app source; `docs/play/` is its build |

## Contract interface

| Method | Who | Notes |
| --- | --- | --- |
| `new(name, symbol, config)` | deployer, once | sets metadata and the immutable `Config` |
| `claim()` | anyone, once per account | payable, attach >= 0.01 NEAR (excess refunded); mints `claim_amount` |
| `back(validator_id, amount)` | token holder | payable, attach >= 0.005 NEAR (returned on unback); validator must have stake in the current epoch |
| `unback()` | position owner | applies any pending score first, then mints the current value |
| `tick()` | anyone | scores every backed validator not yet scored this epoch; never panics; returns the count |
| `ft_*`, `storage_*` | NEP-141 / NEP-145 / NEP-148 | standard; `storage_unregister` is refused while a position is open |
| views | anyone | `get_config`, `get_stats`, `get_position`, `get_validator`, `get_validators`, `get_live_share`, `has_claimed` |

Accounting: each validator has a unit-value index (starts at 1.0). Backing converts tokens to units at the current index; a score multiplies the index; unbacking converts units back at the new index. Scoring is O(number of backed validators) and never touches individual positions. Backed validators are capped at 64 to bound `tick` gas. All division rounds down, in the contract's favour.

Events (NEP-297, standard `validator_league`, version `1.0.0`): `back`, `unback`, `score` (with `outcome` = `up` / `down` / `flat` / `kicked` / `still_out`, old and new share, stake, total stake, new index), plus the standard NEP-141 `ft_mint` / `ft_burn`.

## Rules and why these numbers

| Parameter | Value | Hard bound in code |
| --- | --- | --- |
| `claim_amount` | 1,000 LEAGUE | > 0 |
| `max_claims` | 1,000,000 accounts | > 0 |
| `min_back` | 1 LEAGUE | > 0 |
| `win_bps` | 200 (+2%) | <= 1000 |
| `lose_bps` | 200 (-2%) | <= 1000 |
| `kick_bps` | 3000 (-30%) | <= 9000 |

There is no method that changes any of these after `new`, and no owner role. The parameters were chosen with `sim/simulate.mjs`: the first draft (+2% / -3% / -50%) cost the median player about half their position in 60 days, which nobody would play; a win-biased set inflated supply by about 22%. The chosen set is mildly deflationary for players (median about -7% to -11% over 60 days in the model) while sitting out costs nothing. The simulation's stake dynamics are a model (stated at the top of the script), not historical data.

## Sybil limits (honest)

- One claim per account, capped at 1,000,000 accounts in total, and each claim costs 0.01 NEAR of storage deposit that is not refunded.
- On testnet, accounts are free to create, so the claim is farmable. On mainnet, each top-level account costs real NEAR and each claim still costs 0.01 NEAR, which bounds farming but does not stop it. The claim is a faucet, not a fair launch.
- Farming does not create an edge in the game: every position on the same validator moves by the same percentage, so many small accounts do exactly what one big account does.

## Threat model and known limits

- **No oracle to corrupt.** Scores come from runtime host functions; a keeper calling `tick` cannot change the result, only trigger it.
- **No timing games around a known result.** `back` and `unback` both apply any pending score for that validator before anything else, so nobody can enter after a result is known but before it is applied, or leave before a known loss is applied (unit tests `late_entry_cannot_capture_a_pending_result`, `unback_applies_pending_loss`).
- **Skill is allowed.** The next epoch's validator set is published in advance by the RPC (`validators` / `next_validators`), so players who read it can anticipate kicks. That is the research part of the game, not an exploit.
- **One score per tick.** If several epochs pass without anyone calling `tick`, the next score compares the share at the last score with the share now: one result, not one per missed epoch.
- **Storage griefing** is bounded: positions and claims require storage deposits, refused calls store nothing, and at most 64 validators can carry positions.
- **Upgradeability:** during the hackathon the contract account still has a full-access key held by the deployer, so the code could be redeployed. For a real launch, delete that key (`near account delete-keys`) to make the contract immutable.
- Testnet stakes are much more concentrated than mainnet (`node0`..`node3` and `kiln` hold most of the stake), so testnet scores are noisier than mainnet scores would be.

## Hackathon window, AI disclosure and libraries

- Repository created 2026-11-14 UTC (inside the code window that opened 2026-10-19). Baseline: tag `pre-hackathon` (license and readme stub only). Submission: tag `hackathon-submission`. Everything between the two tags was written during the hackathon. Full diff: https://github.com/ritiklakhwani/validator-league/compare/pre-hackathon...hackathon-submission
- All code was written with AI coding assistance (Claude Code, Anthropic) under Ritik Lakhwani's direction and review.
- Libraries and tools: `near-sdk` 5.30.2, `near-contract-standards` 5.30.2, `cargo-near` 0.23.0, `near-cli-rs` 0.31.1; web app: `near-api-js` 7.5.3, `vite` 8.3.8, Google Fonts (Archivo, JetBrains Mono). The scripts use only Node built-ins. No templates.
- This is the author's only NEAR HACKATHON project.

## License

MIT, see [LICENSE](LICENSE). Author: Ritik Lakhwani (GitHub `ritiklakhwani`).
