// Keyless verifier for Valshi. Needs only Node 18+ and internet.
//
//   node scripts/verify.mjs
//
// 1. Reads the deployed contract's rules, stats and scoreboard over public RPC.
// 2. For every backed validator, reads its live stake share from the chain and shows the
//    score the next `tick` would apply (up / down / flat / kicked).
// 3. Re-fetches every transaction recorded in docs/demo-run.txt from an archival RPC and
//    checks that its on-chain outcome (success or the exact panic message) and its
//    EVENT_JSON logs match what the demo recorded.
//
// Env: CONTRACT (default valshi.testnet), NEAR_RPC, NEAR_ARCHIVAL_RPC.

import { readFileSync } from "node:fs";

const CONTRACT = process.env.CONTRACT ?? "valshi.testnet";
const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const ARCHIVAL = [
  process.env.NEAR_ARCHIVAL_RPC,
  "https://archival-rpc.testnet.fastnear.com",
  "https://archival-rpc.testnet.near.org",
].filter(Boolean);
const LOG = new URL("../docs/demo-run.txt", import.meta.url);
const SHARE_SCALE = 1e12;
const TOKEN = 10n ** 18n;

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error.cause ?? json.error)}`);
  return json.result;
}

async function view(method, args = {}) {
  const result = await rpc(RPC, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(result.result).toString());
}

async function txStatus(hash, sender) {
  let lastErr;
  for (const url of [RPC, ...ARCHIVAL]) {
    try {
      return await rpc(url, "tx", [hash, sender]);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const pct = (share) => `${((Number(share) / SHARE_SCALE) * 100).toFixed(4)}%`;
const tokens = (v) => `${(BigInt(v) / TOKEN).toString()}`;

let failures = 0;
const check = (ok, msg) => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${msg}`);
  if (!ok) failures++;
};

console.log(`Valshi verifier - contract ${CONTRACT}\n`);

// 1. Rules and state
const config = await view("get_config");
const stats = await view("get_stats");
const meta = await view("ft_metadata");
console.log("Rules (fixed at deploy, no admin method exists):");
console.log(`  token ${meta.name} (${meta.symbol}), ${meta.decimals} decimals`);
console.log(`  claim ${tokens(config.claim_amount)} once per account, cap ${config.max_claims} accounts`);
console.log(`  share up: +${config.win_bps / 100}%   share down: -${config.lose_bps / 100}%   kicked: -${config.kick_bps / 100}%`);
console.log(`State: epoch ${stats.epoch} (launched ${stats.launched_epoch}), ${stats.claims} claims, supply ${tokens(stats.total_supply)} liquid, ${stats.backed_validators} validators backed\n`);

const sum = BigInt(config.win_bps) + BigInt(config.lose_bps);
check(sum > 0n && config.kick_bps <= 9000, "parameters are within the contract's hard bounds");

// 2. Scoreboard with live shares
console.log("\nScoreboard (stored share at last score vs live share from the chain now):");
const board = await view("get_validators");
for (const [id, rec] of board) {
  const live = await view("get_live_share", { validator_id: id });
  let next = "already scored this epoch";
  if (live.epoch > rec.epoch) {
    if (BigInt(live.stake) === 0n) next = rec.kicked ? "still out" : "KICKED";
    else if (BigInt(live.share) > BigInt(rec.share)) next = "UP";
    else if (BigInt(live.share) < BigInt(rec.share)) next = "DOWN";
    else next = "FLAT";
  }
  const value = (Number(BigInt(rec.index)) / SHARE_SCALE).toFixed(4);
  console.log(
    `  ${id.padEnd(28)} stored ${pct(rec.share).padStart(9)} @epoch ${rec.epoch}  live ${pct(live.share).padStart(9)} @epoch ${live.epoch}  unit value ${value}  next tick: ${next}  (ups ${rec.ups}, downs ${rec.downs}, kicks ${rec.kicks})`,
  );
}

// 3. Recorded demo transactions vs chain
console.log("\nRecorded demo transactions (docs/demo-run.txt) re-checked against the chain:");
const lines = readFileSync(LOG, "utf8").split("\n");
const txs = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^signer=(\S+) method=(\S+)/);
  if (!m) continue;
  const tx = { signer: m[1], method: m[2], hash: null, panic: null, events: [] };
  for (let j = i + 1; j < lines.length && !lines[j].startsWith("signer=") && !lines[j].startsWith("## "); j++) {
    const h = lines[j].match(/Transaction ID: (\S+)/);
    if (h) tx.hash = h[1];
    const p = lines[j].match(/Smart contract panicked: ([^"]+)/);
    if (p) tx.panic = p[1];
    const e = lines[j].match(/"event":"([a-z_]+)"/);
    if (e) tx.events.push(e[1]);
  }
  if (tx.hash) txs.push(tx);
}

for (const tx of txs) {
  try {
    const status = await txStatus(tx.hash, tx.signer);
    const logs = status.receipts_outcome.flatMap((r) => r.outcome.logs);
    const chainEvents = logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)).event);
    const failure = JSON.stringify(status.status.Failure ?? "");
    const label = `${tx.method.padEnd(6)} by ${tx.signer.padEnd(22)} ${tx.hash}`;
    if (tx.panic) {
      check(failure.includes(tx.panic), `${label} refused on-chain: "${tx.panic}"`);
    } else {
      const sameEvents = tx.events.every((e) => chainEvents.includes(e));
      check(status.status.SuccessValue !== undefined && sameEvents, `${label} succeeded, events [${chainEvents.join(", ") || "none"}]`);
    }
  } catch (e) {
    check(false, `${tx.method} ${tx.hash}: ${e.message}`);
  }
}

console.log(`\n${txs.length - Math.min(failures, txs.length)}/${txs.length} recorded transactions match the chain; ${failures} failure(s) in total.`);
process.exit(failures === 0 ? 0 : 1);
