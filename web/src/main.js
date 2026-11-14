import "./style.css";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas } from "near-api-js";

// ---------- constants ----------
const CONTRACT = "validator-league.testnet";
const RPC = "https://test.rpc.fastnear.com";
// Testnet faucet used by near-cli-rs `sponsor-by-faucet-service`.
const FAUCET = "https://helper.nearprotocol.com/account";
const EXPLORER_TX = (h) => `https://explorer.testnet.near.org/transactions/${h}`;
const EXPLORER_ACCOUNT = (a) => `https://testnet.nearblocks.io/address/${a}`;
const EPOCH_LENGTH = 43200n; // testnet epoch length in blocks (EXPERIMENTAL_genesis_config)
const TOKEN = 10n ** 18n;
const INDEX_ONE = 10n ** 12n;
const STORE_KEY = "validator-league-player-v1";
const REFRESH_MS = 15000;

const provider = new JsonRpcProvider({ url: RPC });

const state = {
  loaded: false,
  error: null,
  config: null,
  stats: null,
  board: new Map(),
  validators: [],
  epoch: 0,
  blocksLeft: null,
  etaMs: null,
  player: null,
  account: null,
  league: 0n,
  near: 0n,
  claimed: false,
  position: null,
  busy: null,
  feed: [],
  modal: null,
};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fmtTok(v, dp = 2) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / TOKEN;
  const frac = ((a % TOKEN) * 10n ** BigInt(dp)) / TOKEN;
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${dp ? "." + frac.toString().padStart(dp, "0") : ""}`;
}
function fmtNear(v) {
  return (Number(v / 10n ** 21n) / 1000).toFixed(3);
}
function parseTok(str) {
  const s = String(str).trim();
  if (!/^\d+(\.\d{0,18})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return BigInt(w) * TOKEN + BigInt((f + "0".repeat(18)).slice(0, 18));
}
function pct(share, dp = 2) {
  return `${(share * 100).toFixed(dp)}%`;
}
function fmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return "-";
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}
function shortId(id) {
  return id.length > 30 ? id.slice(0, 27) + "..." : id;
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "vl", method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error.cause ?? json.error));
  return json.result;
}

const view = (method, args = {}) => provider.callFunction({ contractId: CONTRACT, method, args });

function cleanError(e) {
  const msg = String(e?.message ?? e);
  const panic = msg.match(/(?:Smart contract|Contract) panicked: ([^"\n}]+)/);
  if (panic) return panic[1].trim();
  if (/NotEnoughBalance|LackBalanceForState/.test(msg)) return "Not enough testnet NEAR for this action.";
  return msg.length > 160 ? msg.slice(0, 160) + "..." : msg;
}

// ---------- toasts and feed ----------
function toast(html, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = html;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 7000);
}
function pushFeed(html, hash) {
  state.feed.unshift({ html, hash, at: new Date() });
  state.feed = state.feed.slice(0, 30);
}

// ---------- data loading ----------
async function loadLeague() {
  const [config, stats, boardList, vals, latest] = await Promise.all([
    view("get_config"),
    view("get_stats"),
    view("get_validators"),
    provider.viewValidators(),
    rpc("block", { finality: "final" }),
  ]);
  state.config = config;
  state.stats = stats;
  state.epoch = stats.epoch;
  state.board = new Map(boardList.map(([id, rec]) => [id, rec]));

  const cur = vals.current_validators.map((v) => ({ id: v.account_id, stake: BigInt(v.stake) }));
  const next = new Map(vals.next_validators.map((v) => [v.account_id, BigInt(v.stake)]));
  const curTotal = cur.reduce((a, v) => a + v.stake, 0n);
  const nextTotal = [...next.values()].reduce((a, v) => a + v, 0n);
  state.validators = cur
    .map((v) => {
      const nextStake = next.get(v.id) ?? 0n;
      let projection = "flat";
      if (nextStake === 0n) projection = "out";
      else {
        // compare nextStake/nextTotal with stake/curTotal without floating point
        const lhs = nextStake * curTotal;
        const rhs = v.stake * nextTotal;
        projection = lhs > rhs ? "up" : lhs < rhs ? "down" : "flat";
      }
      return {
        id: v.id,
        stake: v.stake,
        share: Number((v.stake * 10n ** 12n) / curTotal) / 1e12,
        projection,
      };
    })
    .sort((a, b) => (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : 0));

  // Backed validators that are no longer in the active set still belong on the table.
  for (const [id] of state.board) {
    if (!state.validators.find((v) => v.id === id)) {
      state.validators.push({ id, stake: 0n, share: 0, projection: "out", inactive: true });
    }
  }

  // Matchday countdown from the epoch start block.
  const start = BigInt(vals.epoch_start_height);
  const height = BigInt(latest.header.height);
  state.blocksLeft = start + EPOCH_LENGTH - height;
  try {
    const startBlock = await rpc("block", { block_id: Number(start) });
    const elapsedNs = BigInt(latest.header.timestamp_nanosec) - BigInt(startBlock.header.timestamp_nanosec);
    const perBlockMs = Number(elapsedNs / 1000000n) / Number(height - start || 1n);
    state.etaMs = Number(state.blocksLeft) * perBlockMs;
  } catch {
    state.etaMs = null;
  }
}

async function loadPlayer() {
  if (!state.player) return;
  const id = state.player.accountId;
  const [league, claimed, position, acct] = await Promise.all([
    view("ft_balance_of", { account_id: id }).catch(() => "0"),
    view("has_claimed", { account_id: id }).catch(() => false),
    view("get_position", { account_id: id }).catch(() => null),
    rpc("query", { request_type: "view_account", finality: "final", account_id: id }).catch(() => null),
  ]);
  state.league = BigInt(league ?? "0");
  state.claimed = !!claimed;
  state.position = position;
  state.near = acct ? BigInt(acct.amount) : 0n;
}

async function refresh() {
  try {
    await loadLeague();
    await loadPlayer();
    state.loaded = true;
    state.error = null;
  } catch (e) {
    state.error = cleanError(e);
  }
  render();
}

// ---------- player (browser testnet account) ----------
const ADJ = ["brave", "lucky", "swift", "quiet", "bold", "sly", "calm", "wild", "keen", "grim", "sunny", "rusty"];
const NOUN = ["striker", "keeper", "scout", "captain", "rookie", "coach", "fan", "winger", "sweeper", "ref", "pundit", "ultra"];

function loadStoredPlayer() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p?.accountId && p?.key) setPlayer(p);
  } catch {
    /* storage unavailable */
  }
}
function setPlayer(p) {
  state.player = p;
  state.account = new Account(p.accountId, provider, p.key);
}

async function accountExists(id) {
  try {
    await rpc("query", { request_type: "view_account", finality: "final", account_id: id });
    return true;
  } catch {
    return false;
  }
}

async function createPlayer() {
  state.busy = "create";
  render();
  try {
    let accountId;
    for (let i = 0; i < 5; i++) {
      const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
      accountId = `vl-${pick(ADJ)}-${pick(NOUN)}-${Math.floor(100 + Math.random() * 900)}.testnet`;
      if (!(await accountExists(accountId))) break;
    }
    const keyPair = KeyPair.fromRandom("ed25519");
    const res = await fetch(FAUCET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
    });
    if (!res.ok) throw new Error(`Testnet faucet answered ${res.status}. Try again in a minute.`);
    for (let i = 0; i < 20 && !(await accountExists(accountId)); i++) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!(await accountExists(accountId))) throw new Error("Account not visible yet. Try again in a minute.");
    const player = { accountId, key: keyPair.toString() };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(player));
    } catch {
      /* private mode: the player lasts for this tab only */
    }
    setPlayer(player);
    pushFeed(`Signed <b>${esc(accountId)}</b> as a new player`);
    toast(`Welcome, <b>${esc(accountId)}</b>. Collecting your starter pack...`, "ok");
    state.busy = null;
    await refresh();
    await doClaim();
  } catch (e) {
    toast(esc(cleanError(e)), "err");
  } finally {
    state.busy = null;
    render();
  }
}

function resetPlayer() {
  if (!confirm("Forget this player in this browser? The testnet account and its tokens stay on-chain, but you lose the key unless you copied it.")) return;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
  state.player = null;
  state.account = null;
  state.position = null;
  state.league = 0n;
  render();
}

// ---------- transactions ----------
async function act(kind, method, args, depositNear) {
  if (!state.account) return null;
  state.busy = kind;
  render();
  try {
    const res = await state.account.callFunctionRaw({
      contractId: CONTRACT,
      methodName: method,
      args,
      deposit: depositNear ? nearToYocto(depositNear) : 0n,
      gas: teraToGas("100"),
    });
    const hash = res.transaction?.hash ?? res.transaction_outcome?.id;
    if (res.status && typeof res.status === "object" && "Failure" in res.status) {
      throw new Error(JSON.stringify(res.status.Failure));
    }
    const logs = (res.receipts_outcome ?? []).flatMap((r) => r.outcome.logs);
    const events = logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
    let value = null;
    const sv = res.status?.SuccessValue;
    if (sv) {
      try {
        value = JSON.parse(atob(sv));
      } catch {
        value = null;
      }
    }
    return { hash, events, logs, value };
  } catch (e) {
    toast(esc(cleanError(e)), "err");
    return null;
  } finally {
    state.busy = null;
    await refresh();
  }
}

const txLink = (hash) => (hash ? ` <a href="${EXPLORER_TX(hash)}" target="_blank" rel="noopener">view tx</a>` : "");

async function doClaim() {
  const r = await act("claim", "claim", {}, "0.01");
  if (!r) return;
  pushFeed(`Collected the <b>1,000 LEAGUE</b> starter pack`, r.hash);
  toast(`Starter pack collected: 1,000 LEAGUE.${txLink(r.hash)}`, "ok");
  render();
}

async function doBack(validatorId, amount) {
  const r = await act("back", "back", { validator_id: validatorId, amount: amount.toString() }, "0.005");
  if (!r) return;
  state.modal = null;
  renderModal();
  pushFeed(`Backed <b>${esc(validatorId)}</b> with <b>${fmtTok(amount)}</b> LEAGUE`, r.hash);
  toast(`You now back <b>${esc(shortId(validatorId))}</b>.${txLink(r.hash)}`, "ok");
  render();
}

async function doUnback() {
  const before = state.position;
  const r = await act("unback", "unback", {}, null);
  if (!r) return;
  const value = BigInt(r.value ?? "0");
  const principal = BigInt(before?.principal ?? "0");
  const diff = value - principal;
  pushFeed(
    `Cashed out <b>${fmtTok(value)}</b> LEAGUE from <b>${esc(before?.validator_id ?? "")}</b> (<span class="${diff >= 0n ? "pos" : "neg"}">${diff >= 0n ? "+" : ""}${fmtTok(diff)}</span>)`,
    r.hash,
  );
  toast(`Cashed out ${fmtTok(value)} LEAGUE.${txLink(r.hash)}`, "ok");
  render();
}

async function doTick() {
  const r = await act("tick", "tick", {}, null);
  if (!r) return;
  const scores = r.events.filter((e) => e.event === "score");
  if (scores.length === 0) {
    pushFeed(`Whistle blown: nothing to score yet in matchday ${state.epoch}`, r.hash);
    toast(`Nothing to score yet. Next matchday in about ${fmtDuration(state.etaMs)}.${txLink(r.hash)}`);
  } else {
    for (const s of scores) {
      const d = s.data[0];
      pushFeed(`<b>${esc(d.validator_id)}</b>: <span class="tag ${d.outcome === "up" ? "up" : d.outcome === "down" ? "down" : d.outcome === "kicked" ? "out" : "flat"}">${esc(d.outcome.toUpperCase())}</span>`, r.hash);
    }
    toast(`Scored ${scores.length} validator${scores.length > 1 ? "s" : ""}.${txLink(r.hash)}`, "ok");
  }
  render();
}

// ---------- rendering ----------
function recordValue(rec) {
  return (BigInt(rec.units) * BigInt(rec.index)) / INDEX_ONE;
}
function pendingResult(v, rec) {
  if (!rec || rec.epoch >= state.epoch) return null;
  if (v.stake === 0n) return rec.kicked ? "still out" : "kicked";
  const live = BigInt(Math.round(v.share * 1e12));
  const stored = BigInt(rec.share);
  return live > stored ? "up" : live < stored ? "down" : "flat";
}

function projectionTag(p) {
  const map = { up: ["up", "Rising"], down: ["down", "Slipping"], out: ["out", "Leaving set"], flat: ["flat", "Steady"] };
  const [cls, label] = map[p] ?? map.flat;
  return `<span class="tag ${cls}">${label}</span>`;
}

function formChips(rec) {
  if (!rec) return `<span class="dim">-</span>`;
  const chips = [];
  if (rec.ups) chips.push(`<b class="w" title="share up">${rec.ups}</b>`);
  if (rec.downs) chips.push(`<b class="l" title="share down">${rec.downs}</b>`);
  if (rec.kicks) chips.push(`<b class="k" title="kicked">${rec.kicks}</b>`);
  if (!chips.length) chips.push(`<b class="d" title="not scored yet">0</b>`);
  return `<div class="form">${chips.join("")}</div>`;
}

function renderTable() {
  const maxShare = Math.max(...state.validators.map((v) => v.share), 0.0001);
  const mine = state.position?.validator_id;
  const rows = state.validators
    .map((v, i) => {
      const rec = state.board.get(v.id);
      const pending = pendingResult(v, rec);
      const inLeague = rec ? fmtTok(recordValue(rec), 0) : "-";
      const canBack = state.player && !state.position && state.league > 0n && !v.inactive;
      const btn =
        mine === v.id
          ? `<span class="tag ready">Your team</span>`
          : `<button class="btn small" data-action="open-back" data-id="${esc(v.id)}" ${canBack ? "" : "disabled"} title="${state.position ? "Cash out your current team first" : state.player ? "" : "Press Play now first"}">Back</button>`;
      return `<tr class="${mine === v.id ? "mine" : ""}">
        <td class="rank">${v.inactive ? "-" : i + 1}</td>
        <td><div class="vname" title="${esc(v.id)}">${esc(v.id)}</div>${pending ? `<div class="vsub"><span class="tag ready pulse">Result ready: ${esc(pending.toUpperCase())}</span></div>` : ""}</td>
        <td class="share"><span class="num">${v.inactive ? "0.00%" : pct(v.share)}</span><div class="bar"><i style="width:${(v.share / maxShare) * 100}%"></i></div></td>
        <td class="hide-sm">${projectionTag(v.projection)}</td>
        <td class="num hide-sm">${inLeague}</td>
        <td class="hide-sm">${formChips(rec)}</td>
        <td style="text-align:right">${btn}</td>
      </tr>`;
    })
    .join("");
  return `<table class="table">
    <thead><tr><th>#</th><th>Validator</th><th>Stake share</th><th class="hide-sm">Next matchday</th><th class="hide-sm">LEAGUE backing</th><th class="hide-sm">Record</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function renderPlayer() {
  if (!state.player) {
    return `<div class="panel player">
      <h3>Join the league</h3>
      <p>One click creates a free NEAR testnet account in this browser and collects your 1,000 LEAGUE starter pack. No wallet, no install, no real money.</p>
      <button class="btn primary block" data-action="create" ${state.busy ? "disabled" : ""}>${state.busy === "create" ? `<span class="spinner"></span> Signing you up...` : "Play now"}</button>
      <p class="dim" style="margin:10px 0 0;font-size:12px">The key for this testnet account stays in your browser's local storage.</p>
    </div>`;
  }
  const p = state.player;
  const pos = state.position;
  let ticket = "";
  if (pos) {
    const rec = state.board.get(pos.validator_id);
    const value = rec ? (BigInt(pos.units) * BigInt(rec.index)) / INDEX_ONE : BigInt(pos.value);
    const diff = value - BigInt(pos.principal);
    const pctChange = Number((diff * 10000n) / BigInt(pos.principal)) / 100;
    const v = state.validators.find((x) => x.id === pos.validator_id);
    const pending = v ? pendingResult(v, rec) : null;
    ticket = `<div class="ticket">
      <div class="label">Your team</div>
      <div class="team" title="${esc(pos.validator_id)}">${esc(pos.validator_id)}</div>
      <div class="grid">
        <div><div class="k">Locked</div><div class="v">${fmtTok(BigInt(pos.principal), 0)}</div></div>
        <div><div class="k">Value</div><div class="v">${fmtTok(value, 2)}</div></div>
        <div><div class="k">P&amp;L</div><div class="v ${diff >= 0n ? "pos" : "neg"}">${diff >= 0n ? "+" : ""}${pctChange.toFixed(2)}%</div></div>
      </div>
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">${v ? projectionTag(v.projection) : ""}${pending ? `<span class="tag ready pulse">Result ready: ${esc(pending.toUpperCase())}</span>` : ""}<span class="tag flat">since matchday ${pos.entry_epoch}</span></div>
    </div>
    <div class="row-actions" style="margin-bottom:4px">
      <button class="btn" data-action="unback" ${state.busy ? "disabled" : ""}>${state.busy === "unback" ? `<span class="spinner"></span>` : "Cash out"}</button>
    </div>`;
  } else if (state.claimed) {
    ticket = `<div class="ticket"><div class="label">No team yet</div><div class="team">Pick a validator from the table</div><div class="muted" style="font-size:13px">Press Back on any row. Rising validators grow your stake +${state.config.win_bps / 100}% per matchday.</div></div>`;
  } else {
    ticket = `<button class="btn primary block" data-action="claim" ${state.busy ? "disabled" : ""}>${state.busy === "claim" ? `<span class="spinner"></span> Collecting...` : "Collect 1,000 LEAGUE"}</button><div style="height:12px"></div>`;
  }
  return `<div class="panel player">
    <div class="id-row">
      <div><div class="md-label">Player</div><div class="handle" title="${esc(p.accountId)}"><a href="${EXPLORER_ACCOUNT(p.accountId)}" target="_blank" rel="noopener">${esc(p.accountId)}</a></div></div>
      <button class="btn ghost small" data-action="menu">Key</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">LEAGUE</div><div class="v">${fmtTok(state.league, 0)}</div></div>
      <div class="stat"><div class="k">Testnet NEAR</div><div class="v">${fmtNear(state.near)}</div></div>
    </div>
    ${ticket}
  </div>`;
}

function renderWhistle() {
  const scoredThis = [...state.board.values()].filter((r) => r.epoch >= state.epoch).length;
  const total = state.board.size;
  const ready = total - scoredThis;
  return `<div class="panel whistle">
    <div>
      <div class="t">Blow the whistle</div>
      <div class="s">${ready > 0 ? `<b style="color:var(--accent)">${ready}</b> result${ready > 1 ? "s" : ""} ready to score. Anyone can do it.` : `All ${total} backed validators scored for matchday ${state.epoch}. Next in ~${fmtDuration(state.etaMs)}.`}</div>
    </div>
    <button class="btn ${ready > 0 ? "primary" : ""}" data-action="tick" ${state.player && !state.busy ? "" : "disabled"}>${state.busy === "tick" ? `<span class="spinner"></span>` : "tick()"}</button>
  </div>`;
}

function renderFeed() {
  const items = state.feed.length
    ? state.feed
        .map(
          (f) =>
            `<div class="feed-item"><div class="when">${f.at.toLocaleTimeString()}</div>${f.html}${f.hash ? ` <a href="${EXPLORER_TX(f.hash)}" target="_blank" rel="noopener">tx</a>` : ""}</div>`,
        )
        .join("")
    : `<div class="feed-empty">Your plays appear here, each with its on-chain transaction.</div>`;
  return `<div class="panel"><div class="panel-head"><div class="panel-title">Match feed</div></div><div class="feed">${items}</div></div>`;
}

function render() {
  const app = $("#app");
  if (!state.loaded) {
    app.innerHTML = `<div class="wrap" style="padding:80px 0;text-align:center"><div class="wordmark">Validator <span>League</span></div><p class="muted pulse">${state.error ? esc(state.error) : "Reading the validator set from NEAR testnet..."}</p></div>`;
    return;
  }
  const c = state.config;
  app.innerHTML = `
  <div class="wrap">
    <header class="top">
      <div class="brand"><div class="wordmark">Validator <span>League</span></div><span class="net">NEAR testnet</span></div>
      <div class="matchday">
        <div class="md-block"><div class="md-label">Matchday</div><div class="md-value">${state.epoch}</div></div>
        <div class="md-block"><div class="md-label">Next whistle</div><div class="md-value accent">~${fmtDuration(state.etaMs)}</div></div>
        <div class="md-block hide-xs"><div class="md-label">Players</div><div class="md-value">${state.stats.claims}</div></div>
      </div>
    </header>

    <section class="hero">
      <div>
        <h1>Back a validator.<br/><em>The chain keeps score.</em></h1>
        <p>A memecoin where every NEAR epoch is a matchday. Lock LEAGUE on a real validator; when someone blows the whistle, the contract reads that validator's share of all stake straight from the NEAR runtime. No oracle. No admin. No way to fake the result.</p>
      </div>
      <div class="rules">
        <div class="rule up"><div class="big">+${c.win_bps / 100}%</div><div class="small">stake share rises</div></div>
        <div class="rule down"><div class="big">-${c.lose_bps / 100}%</div><div class="small">stake share falls</div></div>
        <div class="rule kick"><div class="big">-${c.kick_bps / 100}%</div><div class="small">dropped from the set</div></div>
        <div class="rules-foot">rules fixed at launch in ${CONTRACT}</div>
      </div>
    </section>

    ${state.error ? `<div class="toast err" style="margin-bottom:16px">Live data paused: ${esc(state.error)}</div>` : ""}

    <section class="main">
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">League table</div>
          <div class="legend"><span>Next matchday = stake share in the published next-epoch validator set</span></div>
        </div>
        ${renderTable()}
      </div>
      <aside class="side">
        ${renderPlayer()}
        ${renderWhistle()}
        ${renderFeed()}
      </aside>
    </section>

    <section class="how">
      <div class="step"><div class="n">01</div><div class="t">Join</div><div class="d">Play now creates a testnet account and claims 1,000 LEAGUE. One claim per account.</div></div>
      <div class="step"><div class="n">02</div><div class="t">Pick a team</div><div class="d">Lock LEAGUE on one active validator. Read the next-matchday column: it is the chain's own published schedule.</div></div>
      <div class="step"><div class="n">03</div><div class="t">Whistle</div><div class="d">Each epoch, anyone calls tick(). The contract compares each backed validator's stake share with the last matchday.</div></div>
      <div class="step"><div class="n">04</div><div class="t">Cash out</div><div class="d">Unlock any time at the current value. Gains are minted, losses are burned.</div></div>
    </section>

    <footer class="foot">
      <div>Contract <a href="${EXPLORER_ACCOUNT(CONTRACT)}" target="_blank" rel="noopener">${CONTRACT}</a> &middot; NEP-141 &middot; reads env::validator_stake on-chain</div>
      <div>Built at NEAR HACKATHON &middot; testnet only, no real money</div>
    </footer>
  </div>`;
}

function renderModal() {
  const root = $("#modal-root");
  if (!state.modal) {
    root.innerHTML = "";
    return;
  }
  const { id } = state.modal;
  const v = state.validators.find((x) => x.id === id);
  const c = state.config;
  const amount = parseTok(state.modal.input) ?? 0n;
  const over = amount > state.league;
  const below = amount < BigInt(c.min_back);
  const up = amount + (amount * BigInt(c.win_bps)) / 10000n;
  const down = amount - (amount * BigInt(c.lose_bps)) / 10000n;
  const kick = amount - (amount * BigInt(c.kick_bps)) / 10000n;
  root.innerHTML = `<div class="scrim" data-action="close-modal">
    <div class="modal" role="dialog" aria-label="Back a validator">
      <h3>Back ${esc(shortId(id))}</h3>
      <div class="sub">Stake share ${v ? pct(v.share, 3) : "-"} &middot; ${v ? projectionTag(v.projection) : ""} for next matchday</div>
      <div class="amount"><input id="amount-input" inputmode="decimal" value="${esc(state.modal.input)}" autocomplete="off" /><span class="muted mono">LEAGUE</span></div>
      <div class="presets">
        ${[25, 50, 75, 100].map((p) => `<button class="btn small" data-action="preset" data-p="${p}">${p === 100 ? "Max" : p + "%"}</button>`).join("")}
      </div>
      <div class="outcomes">
        <div class="outcome"><div class="k">If rising</div><div class="v pos">${fmtTok(up)}</div></div>
        <div class="outcome"><div class="k">If slipping</div><div class="v neg">${fmtTok(down)}</div></div>
        <div class="outcome"><div class="k">If dropped</div><div class="v" style="color:var(--red)">${fmtTok(kick)}</div></div>
      </div>
      <div class="dim" style="font-size:12px;margin:-6px 0 14px">Per matchday. Attaches 0.005 testnet NEAR for storage, returned when you cash out.</div>
      <div class="modal-actions">
        <button class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn primary" data-action="confirm-back" ${over || below || state.busy ? "disabled" : ""}>${state.busy === "back" ? `<span class="spinner"></span> Locking...` : over ? "Not enough LEAGUE" : below ? `Min ${fmtTok(BigInt(c.min_back), 0)}` : "Lock it in"}</button>
      </div>
    </div>
  </div>`;
}

function updateModalPreview() {
  // Re-render the modal but keep the caret in the amount input.
  const input = $("#amount-input");
  const pos = input?.selectionStart;
  renderModal();
  const again = $("#amount-input");
  if (again) {
    again.focus();
    if (pos != null) again.setSelectionRange(pos, pos);
  }
}

// ---------- events ----------
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  if (action === "close-modal") {
    if (e.target !== el) return; // clicks inside the modal do not close it
    state.modal = null;
    renderModal();
    return;
  }
  if (action === "create") return createPlayer();
  if (action === "claim") return doClaim();
  if (action === "unback") return doUnback();
  if (action === "tick") return doTick();
  if (action === "open-back") {
    const half = state.league / 2n;
    state.modal = { id: el.dataset.id, input: fmtTok(half, 0).replace(/,/g, "") };
    renderModal();
    return;
  }
  if (action === "preset") {
    const p = BigInt(el.dataset.p);
    const amt = (state.league * p) / 100n;
    state.modal.input = p === 100n ? (Number(amt / 10n ** 16n) / 100).toFixed(2) : fmtTok(amt, 0).replace(/,/g, "");
    updateModalPreview();
    return;
  }
  if (action === "confirm-back") {
    const amount = parseTok(state.modal?.input ?? "");
    if (amount && amount > 0n) {
      const capped = amount > state.league ? state.league : amount;
      await doBack(state.modal.id, capped);
      renderModal();
    }
    return;
  }
  if (action === "menu") {
    const p = state.player;
    const choice = prompt(
      `Player ${p.accountId}\n\nType COPY to copy this testnet account's private key to your clipboard, or RESET to forget this player in this browser.`,
    );
    if (choice?.trim().toUpperCase() === "COPY") {
      try {
        await navigator.clipboard.writeText(p.key);
        toast("Testnet key copied. Keep it private.");
      } catch {
        toast("Clipboard unavailable in this browser.", "err");
      }
    } else if (choice?.trim().toUpperCase() === "RESET") {
      resetPlayer();
    }
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "amount-input" && state.modal) {
    state.modal.input = e.target.value;
    updateModalPreview();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.modal) {
    state.modal = null;
    renderModal();
  }
});

// ---------- boot ----------
document.body.insertAdjacentHTML("beforeend", `<div id="modal-root"></div><div id="toasts" class="toasts"></div>`);
loadStoredPlayer();
render();
refresh();
setInterval(() => {
  if (!state.busy) refresh();
}, REFRESH_MS);
