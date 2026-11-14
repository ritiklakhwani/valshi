import "./style.css";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas } from "near-api-js";

// ---------- constants ----------
const CONTRACT = "valshi.testnet";
const RPC = "https://test.rpc.fastnear.com";
// Testnet faucet used by near-cli-rs `sponsor-by-faucet-service`.
const FAUCET = "https://helper.nearprotocol.com/account";
const EXPLORER_TX = (h) => `https://explorer.testnet.near.org/transactions/${h}`;
const EXPLORER_ACCOUNT = (a) => `https://testnet.nearblocks.io/address/${a}`;
const EPOCH_LENGTH = 43200n; // testnet epoch length in blocks (EXPERIMENTAL_genesis_config)
const TOKEN = 10n ** 18n;
const INDEX_ONE = 10n ** 12n;
const STORE_KEY = "valshi-player-v1";
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
  filter: "all",
  height: 0n,
  totalStake: 0n,
  updatedAt: null,
};

const HELP_KEY = "valshi-help-seen-v1";

// Deterministic badge colour per validator, from the warm palette.
const BADGE = ["#ff6a2b", "#f2c14e", "#8fd694", "#ff7a6b", "#e8d5b0", "#d9a066", "#b8c97a", "#f0a77a"];
function avatar(id, size = "") {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const label = id.replace(/^(validator|node)/, "").replace(/[^a-z0-9]/gi, "").slice(0, 2) || id.slice(0, 2);
  return `<span class="av ${size}" style="background:${BADGE[h % BADGE.length]}">${esc(label)}</span>`;
}

// Small confetti burst for wins and milestones (no library).
function confetti() {
  const canvas = document.getElementById("confetti");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  const colors = ["#ff6a2b", "#f2c14e", "#8fd694", "#efe6d2", "#ff7a6b"];
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 12 - 4,
    r: Math.random() * 6 + 3,
    c: colors[Math.floor(Math.random() * colors.length)],
    a: Math.random() * Math.PI,
  }));
  let frame = 0;
  (function step() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.vy += 0.35;
      p.x += p.vx;
      p.y += p.vy;
      p.a += 0.15;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      ctx.restore();
    }
    if (++frame < 110) requestAnimationFrame(step);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })();
}

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
  setTimeout(() => el.remove(), kind === "err" ? 14000 : 7000);
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
  state.height = height;
  state.totalStake = curTotal;
  state.updatedAt = new Date();
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
  state.joinError = null;
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
    if (res.status === 429) {
      throw new Error("The public NEAR testnet faucet is rate-limiting your network right now. Try again in a few minutes, or use \"Import a testnet account\" below the button.");
    }
    if (!res.ok) throw new Error(`Testnet faucet answered ${res.status}. Try again in a minute, or import a testnet account.`);
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
    state.joinError = cleanError(e);
    toast(esc(state.joinError), "err");
  } finally {
    state.busy = null;
    render();
  }
}

async function importPlayer() {
  const accountId = prompt("Testnet account id (for example yourname.testnet):")?.trim().toLowerCase();
  if (!accountId) return;
  const key = prompt(`Private key for ${accountId} (starts with ed25519:). It stays in this browser only. Use testnet keys only.`)?.trim();
  if (!key) return;
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,}$/.test(key)) {
    toast("That does not look like an ed25519 private key.", "err");
    return;
  }
  if (!(await accountExists(accountId))) {
    toast(`${esc(accountId)} does not exist on testnet.`, "err");
    return;
  }
  try {
    const kp = KeyPair.fromString(key);
    const keys = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId });
    const pub = kp.getPublicKey().toString();
    if (!keys.keys.some((k) => k.public_key === pub)) {
      toast("That key is not an access key of this account.", "err");
      return;
    }
  } catch (e) {
    toast(esc(cleanError(e)), "err");
    return;
  }
  const player = { accountId, key };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(player));
  } catch {
    /* tab-only */
  }
  setPlayer(player);
  pushFeed(`Imported player <b>${esc(accountId)}</b>`);
  toast(`Playing as <b>${esc(accountId)}</b>.`, "ok");
  await refresh();
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
  pushFeed(`Collected the <b>1,000 VALSHI</b> starter pack`, r.hash);
  toast(`Starter pack collected: 1,000 VALSHI. Now pick a validator in the table.${txLink(r.hash)}`, "ok");
  confetti();
  render();
}

async function doBack(validatorId, amount) {
  const r = await act("back", "back", { validator_id: validatorId, amount: amount.toString() }, "0.005");
  if (!r) return;
  state.modal = null;
  renderModal();
  pushFeed(`Backed <b>${esc(validatorId)}</b> with <b>${fmtTok(amount)}</b> VALSHI`, r.hash);
  toast(`You now back <b>${esc(shortId(validatorId))}</b>. Your result lands at the next whistle.${txLink(r.hash)}`, "ok");
  confetti();
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
    `Cashed out <b>${fmtTok(value)}</b> VALSHI from <b>${esc(before?.validator_id ?? "")}</b> (<span class="${diff >= 0n ? "pos" : "neg"}">${diff >= 0n ? "+" : ""}${fmtTok(diff)}</span>)`,
    r.hash,
  );
  toast(`Cashed out ${fmtTok(value)} VALSHI.${txLink(r.hash)}`, "ok");
  if (diff > 0n) confetti();
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

function renderTabs() {
  const count = (p) => state.validators.filter((v) => v.projection === p).length;
  const tabs = [
    ["all", "All", state.validators.length],
    ["up", "Rising", count("up")],
    ["down", "Slipping", count("down")],
    ["out", "Leaving", count("out")],
    ["backed", "In play", state.board.size],
  ];
  return `<div class="tabs">${tabs
    .map(([k, label, n]) => `<button class="tab ${state.filter === k ? "on" : ""}" data-action="filter" data-f="${k}">${label}<span class="n">${n}</span></button>`)
    .join("")}</div>`;
}

function renderTable() {
  const maxShare = Math.max(...state.validators.map((v) => v.share), 0.0001);
  const mine = state.position?.validator_id;
  const ranked = state.validators.map((v, i) => ({ v, rank: i + 1 }));
  const shown = ranked.filter(({ v }) =>
    state.filter === "all" ? true : state.filter === "backed" ? state.board.has(v.id) : v.projection === state.filter,
  );
  const rows = shown
    .map(({ v, rank }) => {
      const rec = state.board.get(v.id);
      const pending = pendingResult(v, rec);
      const inLeague = rec ? fmtTok(recordValue(rec), 0) : "-";
      const canBack = state.player && !state.position && state.league > 0n && !v.inactive;
      const why = !state.player ? "Press Start playing first" : state.position ? "Cash out your current team first" : state.league === 0n ? "Collect your VALSHI first" : "";
      const btn =
        mine === v.id
          ? `<span class="tag ready">Your team</span>`
          : `<button class="btn small ${canBack ? "primary" : ""}" data-action="open-back" data-id="${esc(v.id)}" ${canBack ? "" : "disabled"} title="${why}">Back</button>`;
      return `<tr class="${mine === v.id ? "mine" : ""} ${canBack ? "clickable" : ""}" ${canBack ? `data-action="open-back" data-id="${esc(v.id)}"` : ""}>
        <td class="rank">${v.inactive ? "-" : rank}</td>
        <td><div class="vcell">${avatar(v.id)}<div style="min-width:0"><div class="vname" title="${esc(v.id)}">${esc(v.id)}<a class="ext" href="${EXPLORER_ACCOUNT(v.id)}" target="_blank" rel="noopener" title="Open in explorer">&#8599;</a></div>${pending ? `<div class="vsub"><span class="tag ready pulse">Result ready: ${esc(pending.toUpperCase())}</span></div>` : `<div class="vsub">${v.inactive ? "not in the active set" : fmtTok(v.stake / 1000000n, 0) + " NEAR staked"}</div>`}</div></div></td>
        <td class="share"><span class="num">${v.inactive ? "0.00%" : pct(v.share)}</span><div class="bar"><i style="width:${(v.share / maxShare) * 100}%"></i></div></td>
        <td class="hide-sm">${projectionTag(v.projection)}</td>
        <td class="num hide-sm">${inLeague}</td>
        <td class="hide-sm">${formChips(rec)}</td>
        <td style="text-align:right">${btn}</td>
      </tr>`;
    })
    .join("");
  return `<table class="table">
    <thead><tr><th>#</th><th>Validator</th>
      <th><span class="th-tip" title="This validator's share of all stake right now, read live from NEAR testnet. This is what the contract scores.">Stake share</span></th>
      <th class="hide-sm"><span class="th-tip" title="NEAR publishes the next epoch's validator set in advance. Rising = its share grows next matchday, Slipping = shrinks, Leaving = drops out (-30% for backers).">Next matchday</span></th>
      <th class="hide-sm"><span class="th-tip" title="Total VALSHI currently locked on this validator by all players, at its current value.">VALSHI backing</span></th>
      <th class="hide-sm"><span class="th-tip" title="Scored matchdays: green = share rose, coral = fell, red = kicked.">Record</span></th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="feed-empty">No validators in this view right now.</td></tr>`}</tbody></table>`;
}

function questSteps() {
  const scored = state.position && state.board.get(state.position.validator_id)?.epoch > state.position.entry_epoch;
  const steps = [
    ["Join the league", !!state.player],
    ["Collect 1,000 VALSHI", state.claimed],
    ["Back a validator", !!state.position],
    ["Wait for the whistle", !!scored],
    ["Cash out (or ride it)", false],
  ];
  const nowIdx = steps.findIndex(([, done]) => !done);
  return `<div class="quest">${steps
    .map(([label, done], i) => `<div class="q ${done ? "done" : i === nowIdx ? "now" : ""}"><span class="dot">${done ? "&#10003;" : i + 1}</span>${label}</div>`)
    .join("")}</div>`;
}

function renderHelp() {
  const c = state.config;
  return `<div class="scrim" data-action="close-modal">
    <div class="modal wide" role="dialog" aria-label="How to play">
      <h3>How to play Valshi</h3>
      <div class="sub">Fantasy sports where the players are NEAR's real validators and the blockchain is the referee.</div>
      <div class="steps">
        <div class="hstep"><div class="n">01</div><div class="t">Join free</div><div class="d">Press Start playing. We create a free NEAR testnet account in your browser and give you 1,000 VALSHI. No wallet, no real money.</div></div>
        <div class="hstep"><div class="n">02</div><div class="t">Pick a team</div><div class="d">Choose a validator in the table and lock some VALSHI on it. Tip: the Next matchday column shows who is rising or leaving.</div></div>
        <div class="hstep"><div class="n">03</div><div class="t">The whistle</div><div class="d">Every NEAR epoch (about 12 hours) is a matchday. Anyone presses tick() and the contract reads each validator's stake share from the chain: share up +${c.win_bps / 100}%, down -${c.lose_bps / 100}%, dropped -${c.kick_bps / 100}%.</div></div>
        <div class="hstep"><div class="n">04</div><div class="t">Cash out</div><div class="d">Unlock whenever you want at the current value. Wins are minted, losses are burned. Ride a hot validator for many matchdays to compound.</div></div>
      </div>
      <div class="faq">
        <b>Is this data real?</b>
        <p>Yes. The table is the live NEAR testnet validator set read from public RPC, and the block number above updates every 15 seconds. Testnet validators really are named node0, node1, validator4.testnet and so on. Every action you take is a real transaction you can open in the explorer.</p>
        <b>Where is the wallet?</b>
        <p>For this testnet version you do not need one: Start playing creates a testnet account whose key stays in this browser. A mainnet version would connect a NEAR wallet instead.</p>
        <b>Who decides the results?</b>
        <p>Nobody. The contract asks the NEAR runtime for validator stakes directly. There is no oracle and no admin, and the rules cannot be changed.</p>
      </div>
      <div class="modal-actions" style="margin-top:16px"><button class="btn primary" data-action="close-help">${state.player ? "Back to the game" : "Got it, let's play"}</button></div>
    </div>
  </div>`;
}

function renderPlayer() {
  if (!state.player) {
    return `<div class="panel player">
      <h3>Join the league</h3>
      <p>One click creates a free NEAR testnet account in this browser and collects your 1,000 VALSHI starter pack. No wallet, no install, no real money.</p>
      ${questSteps()}
      <button class="btn primary block" data-action="create" ${state.busy ? "disabled" : ""}>${state.busy === "create" ? `<span class="spinner"></span> Signing you up...` : "Start playing - free"}</button>
      <p class="dim" style="margin:10px 0 0;font-size:12px">The key for this testnet account stays in your browser's local storage.</p>
      ${state.joinError ? `<div class="join-err"><b>Could not create a player.</b> ${esc(state.joinError)}</div>` : ""}
      <button class="btn ${state.joinError ? "block" : "ghost small"}" style="margin-top:8px;${state.joinError ? "" : "padding-left:0;color:var(--muted)"}" data-action="import">Already have a testnet account? Import it</button>
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
    ticket = `<button class="btn primary block" data-action="claim" ${state.busy ? "disabled" : ""}>${state.busy === "claim" ? `<span class="spinner"></span> Collecting...` : "Collect 1,000 VALSHI"}</button><div style="height:12px"></div>`;
  }
  return `<div class="panel player">
    <div class="id-row">
      <div><div class="md-label">Player</div><div class="handle" title="${esc(p.accountId)}"><a href="${EXPLORER_ACCOUNT(p.accountId)}" target="_blank" rel="noopener">${esc(p.accountId)}</a></div></div>
      <button class="btn ghost small" data-action="menu">Key</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">VALSHI</div><div class="v">${fmtTok(state.league, 0)}</div></div>
      <div class="stat"><div class="k">Testnet NEAR</div><div class="v">${fmtNear(state.near)}</div></div>
    </div>
    ${questSteps()}
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
    app.innerHTML = `<div class="wrap" style="padding:80px 0;text-align:center"><div class="wordmark">Val<span>shi</span></div><p class="muted pulse">${state.error ? esc(state.error) : "Reading the validator set from NEAR testnet..."}</p></div>`;
    return;
  }
  const c = state.config;
  app.innerHTML = `
  <div class="wrap">
    <header class="top">
      <div class="brand"><div class="wordmark">Val<span>shi</span></div><span class="net">NEAR testnet</span></div>
      <div class="top-right">
        <div class="matchday">
          <div class="md-block"><div class="md-label">Matchday</div><div class="md-value">${state.epoch}</div></div>
          <div class="md-block hide-xs"><div class="md-label">Next whistle</div><div class="md-value accent">~${fmtDuration(state.etaMs)}</div></div>
        </div>
        <button class="btn ghost small" data-action="help">How to play</button>
        ${
          state.player
            ? `<span class="chip">${avatar(state.player.accountId)}${fmtTok(state.league, 0)} VALSHI</span>`
            : `<button class="btn primary" data-action="create" ${state.busy ? "disabled" : ""}>${state.busy === "create" ? `<span class="spinner"></span>` : "Start playing"}</button>`
        }
      </div>
    </header>

    <div class="live">
      <span class="live-dot"><i></i>LIVE</span>
      <div class="progress" title="Progress of the current NEAR epoch (matchday). When it ends, the next whistle can be blown.">
        <span class="kv">Matchday ${state.epoch}</span>
        <div class="track"><div class="fill" style="width:${state.blocksLeft != null ? Math.min(100, Math.max(2, (1 - Number(state.blocksLeft) / Number(EPOCH_LENGTH)) * 100)).toFixed(1) : 0}%"></div></div>
        <span class="kv"><b>${state.blocksLeft != null ? Math.round((1 - Number(state.blocksLeft) / Number(EPOCH_LENGTH)) * 100) : 0}%</b> played</span>
      </div>
      <span class="kv hide-md">block <b>#${Number(state.height).toLocaleString("en-US")}</b></span>
      <span class="kv hide-md"><b>${state.validators.filter((v) => !v.inactive).length}</b> validators</span>
      <span class="kv hide-md"><b>${state.stats.claims}</b> players</span>
    </div>

    <section class="hero">
      <div>
        <h1>Back a validator.<br/><em>The chain keeps score.</em></h1>
        <p>Fantasy sports on NEAR's real validators. Lock VALSHI on one; every epoch the contract reads its share of all stake straight from the NEAR runtime. Share up, you win. No oracle, no admin, no way to fake the result.</p>
        <div class="cta-row">
          ${state.player ? `<button class="btn primary xl" data-action="scroll-table">Pick your team</button>` : `<button class="btn primary xl" data-action="create" ${state.busy ? "disabled" : ""}>${state.busy === "create" ? `<span class="spinner"></span> Signing you up...` : "Start playing - free"}</button>`}
          <button class="btn xl" data-action="help">How it works</button>
        </div>
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
      <div class="panel" id="league-table">
        <div class="panel-head" style="flex-wrap:wrap;gap:10px">
          <div><div class="panel-title">League table</div><div class="dim" style="font-size:11px;margin-top:2px">Live from NEAR testnet &middot; updated ${state.updatedAt ? state.updatedAt.toLocaleTimeString() : "-"}</div></div>
          ${renderTabs()}
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
      <div class="step"><div class="n">01</div><div class="t">Join</div><div class="d">Play now creates a testnet account and claims 1,000 VALSHI. One claim per account.</div></div>
      <div class="step"><div class="n">02</div><div class="t">Pick a team</div><div class="d">Lock VALSHI on one active validator. Read the next-matchday column: it is the chain's own published schedule.</div></div>
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
  if (state.modal.kind === "help") {
    root.innerHTML = renderHelp();
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
      <div class="amount"><input id="amount-input" inputmode="decimal" value="${esc(state.modal.input)}" autocomplete="off" /><span class="muted mono">VALSHI</span></div>
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
        <button class="btn primary" data-action="confirm-back" ${over || below || state.busy ? "disabled" : ""}>${state.busy === "back" ? `<span class="spinner"></span> Locking...` : over ? "Not enough VALSHI" : below ? `Min ${fmtTok(BigInt(c.min_back), 0)}` : "Lock it in"}</button>
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
  if (action === "help") {
    state.modal = { kind: "help" };
    renderModal();
    return;
  }
  if (action === "close-help") {
    try {
      localStorage.setItem(HELP_KEY, "1");
    } catch {
      /* ignore */
    }
    state.modal = null;
    renderModal();
    if (!state.player) createPlayer();
    return;
  }
  if (action === "filter") {
    state.filter = el.dataset.f;
    render();
    return;
  }
  if (action === "scroll-table") {
    document.getElementById("league-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (action === "create") return createPlayer();
  if (action === "import") return importPlayer();
  if (action === "claim") return doClaim();
  if (action === "unback") return doUnback();
  if (action === "tick") return doTick();
  if (action === "open-back") {
    if (e.target.closest("a")) return; // explorer links inside a row
    if (!state.player || state.position || state.league === 0n) return;
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
document.body.insertAdjacentHTML(
  "beforeend",
  `<div id="modal-root"></div><div id="toasts" class="toasts"></div><canvas id="confetti"></canvas>`,
);
loadStoredPlayer();
render();
refresh().then(() => {
  let seen = false;
  try {
    seen = localStorage.getItem(HELP_KEY) === "1";
  } catch {
    /* ignore */
  }
  if (!seen && !state.player && state.loaded) {
    state.modal = { kind: "help" };
    renderModal();
  }
});
setInterval(() => {
  if (!state.busy) refresh();
}, REFRESH_MS);
