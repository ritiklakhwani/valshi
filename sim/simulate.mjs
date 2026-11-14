// 60-day simulation of the Valshi scoring rule.
//
// Usage:
//   node sim/simulate.mjs            # uses the committed snapshot of real testnet validators
//   node sim/simulate.mjs --live     # fetches the current testnet validator set first
//
// The starting validator set and stakes are real (NEAR testnet RPC). How stakes move
// from epoch to epoch is a MODEL (random multiplicative shocks plus occasional kicks),
// not historical data. The point is to choose parameters, not to predict returns.
//
// Deterministic: a fixed seed, so every run prints the same numbers.

import { readFileSync } from "node:fs";

const EPOCHS = 120; // 60 days at 2 epochs per day (12 h epochs)
const RUNS = 200; // Monte Carlo runs per parameter set
const PLAYERS_PER_STRATEGY = 50;
const CLAIM = 1000;
const RPC = "https://test.rpc.fastnear.com";

// Model assumptions (ours, stated in the README).
const STAKE_SIGMA = 0.01; // per-epoch stake noise per validator (1%)
const REWARD_GROWTH = 0.0002; // everyone grows a little each epoch (staking rewards)
const KICK_PROB = 0.002; // chance a validator leaves the active set in an epoch
const RETURN_PROB = 0.25; // chance a kicked validator is back next epoch

const PARAM_SETS = [
  { name: "A first draft", win: 200, lose: 300, kick: 5000 },
  { name: "B harsh", win: 200, lose: 500, kick: 9000 },
  { name: "C symmetric", win: 200, lose: 200, kick: 5000 },
  { name: "D CHOSEN", win: 200, lose: 200, kick: 3000 },
  { name: "E soft", win: 100, lose: 100, kick: 2000 },
  { name: "F win-biased", win: 250, lose: 200, kick: 3000 },
];

// mulberry32 seeded PRNG
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

async function loadValidators() {
  if (process.argv.includes("--live")) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "validators", params: [null] }),
    });
    const json = await res.json();
    return json.result.current_validators.map((v) => ({ id: v.account_id, stake: Number(BigInt(v.stake) / 10n ** 21n) }));
  }
  const snap = JSON.parse(readFileSync(new URL("./validators-snapshot.json", import.meta.url)));
  return snap.validators.map((v) => ({ id: v.account_id, stake: Number(BigInt(v.stake) / 10n ** 21n) }));
}

// Strategies: how a player picks a validator each epoch.
const STRATEGIES = {
  hold_random: { desc: "back a random validator, never switch", switches: false },
  hold_biggest: { desc: "back the largest validator, never switch", switches: false },
  momentum: { desc: "every epoch, switch to the validator whose share rose most last epoch", switches: true },
  sit_out: { desc: "never back (keep tokens liquid)", switches: false },
};

function simulateRun(validators, params, seed) {
  const rand = rng(seed);
  let stakes = validators.map((v) => v.stake);
  let active = validators.map(() => true);
  const n = stakes.length;
  const shareOf = (s, act) => {
    const total = s.reduce((acc, x, i) => acc + (act[i] ? x : 0), 0);
    return s.map((x, i) => (act[i] ? x / total : 0));
  };
  let shares = shareOf(stakes, active);
  let lastDelta = new Array(n).fill(0);

  const biggest = shares.indexOf(Math.max(...shares));
  const players = {};
  for (const name of Object.keys(STRATEGIES)) {
    players[name] = Array.from({ length: PLAYERS_PER_STRATEGY }, () => ({
      value: CLAIM,
      pick: name === "hold_biggest" ? biggest : Math.floor(rand() * n),
    }));
  }
  let kicks = 0;

  for (let e = 0; e < EPOCHS; e++) {
    // momentum players switch before the epoch, based on last epoch's deltas (public info)
    if (e > 0) {
      let best = 0;
      for (let i = 1; i < n; i++) if (active[i] && lastDelta[i] > lastDelta[best]) best = i;
      for (const p of players.momentum) p.pick = best;
    }
    // move stakes
    const newActive = active.map((a) => (a ? rand() > KICK_PROB : rand() < RETURN_PROB));
    stakes = stakes.map((s) => Math.max(1, s * (1 + REWARD_GROWTH + STAKE_SIGMA * gaussian(rand))));
    const newShares = shareOf(stakes, newActive);
    // score each validator
    const mult = new Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      if (!newActive[i]) {
        if (active[i]) {
          mult[i] = 1 - params.kick / 10000;
          kicks++;
        }
      } else if (newShares[i] > shares[i]) mult[i] = 1 + params.win / 10000;
      else if (newShares[i] < shares[i]) mult[i] = 1 - params.lose / 10000;
      lastDelta[i] = newShares[i] - shares[i];
    }
    for (const [name, list] of Object.entries(players)) {
      if (name === "sit_out") continue;
      for (const p of list) {
        // a kicked validator cannot be backed; random holders who were on it re-pick
        p.value *= mult[p.pick];
        if (!newActive[p.pick] && STRATEGIES[name].switches === false && name === "hold_random") {
          p.pick = Math.floor(rand() * n);
        }
      }
    }
    shares = newShares;
    active = newActive;
  }

  const result = { kicks };
  for (const [name, list] of Object.entries(players)) {
    result[name] = list.reduce((acc, p) => acc + p.value, 0) / list.length;
  }
  return result;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const validators = await loadValidators();
console.log(`Valshi simulation: ${validators.length} real testnet validators, ${EPOCHS} epochs (60 days), ${RUNS} runs per parameter set`);
console.log(`Model: stake noise ${STAKE_SIGMA * 100}%/epoch, reward growth ${REWARD_GROWTH * 100}%/epoch, kick chance ${KICK_PROB * 100}%/epoch`);
console.log(`Each player starts with ${CLAIM} tokens. Numbers are the median ending value per player.\n`);

const header = ["params win/lose/kick bps", ...Object.keys(STRATEGIES), "supply change*"];
console.log(header.map((h, i) => h.padEnd(i === 0 ? 30 : 15)).join(""));
for (const params of PARAM_SETS) {
  const runs = Array.from({ length: RUNS }, (_, r) => simulateRun(validators, params, 1000 + r));
  const row = [`${params.name} ${params.win}/${params.lose}/${params.kick}`];
  for (const name of Object.keys(STRATEGIES)) row.push(median(runs.map((r) => r[name])).toFixed(1));
  const players = Object.keys(STRATEGIES).filter((s) => s !== "sit_out");
  const avg = players.reduce((acc, s) => acc + median(runs.map((r) => r[s])), 0) / players.length;
  row.push(`${(((avg - CLAIM) / CLAIM) * 100).toFixed(1)}%`);
  console.log(row.map((c, i) => String(c).padEnd(i === 0 ? 30 : 15)).join(""));
}
console.log("\n* average change of backed value across the three playing strategies; sit_out never changes.");
console.log("\nStrategies:");
for (const [name, s] of Object.entries(STRATEGIES)) console.log(`  ${name.padEnd(14)} ${s.desc}`);
