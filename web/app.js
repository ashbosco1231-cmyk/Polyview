// Sharpline terminal frontend. Vanilla JS, no build step.
// Talks only to our own API + /live socket — never to Polymarket directly.

const state = {
  markets: [],
  selected: null,      // MarketMeta
  tokenId: null,       // active outcome token
  trades: [],          // rolling trade history for the active token (ascending)
  mode: { type: "tick", n: 50 },
  venue: "",            // "" = all, "polymarket", "kalshi"
  ws: null,
  wsReady: false,
};

const VENUE_LABEL = { polymarket: "PM", kalshi: "Kalshi" };

const MAX_TRADES = 4000; // cap client memory; plenty for any on-screen chart

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const cents = (p) => (p * 100).toFixed(1);
const fmtSize = (s) => (s >= 1000 ? (s / 1000).toFixed(1) + "k" : s.toFixed(0));
const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour12: false });

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

// ---------- candle reconstruction (mirrors src/aggregate/candles.ts) ----------
function seed(t) {
  return { start: t.ts, end: t.ts, open: t.price, high: t.price, low: t.price,
    close: t.price, volume: 0, buyVolume: 0, sellVolume: 0, trades: 0 };
}
function apply(c, t) {
  c.high = Math.max(c.high, t.price); c.low = Math.min(c.low, t.price);
  c.close = t.price; c.end = t.ts; c.volume += t.size;
  if (t.side === "BUY") c.buyVolume += t.size; else c.sellVolume += t.size;
  c.trades += 1;
}
function buildTick(trades, n) {
  const out = []; let cur = null;
  for (const t of trades) {
    if (!cur) cur = seed(t);
    apply(cur, t);
    if (cur.trades >= n) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}
function buildTime(trades, ms) {
  const out = []; let cur = null, bucket = -1;
  for (const t of trades) {
    const start = Math.floor(t.ts / ms) * ms;
    if (!cur || start !== bucket) {
      if (cur) out.push(cur);
      bucket = start; cur = seed(t); cur.start = start; cur.end = start + ms;
    }
    apply(cur, t); cur.end = bucket + ms;
  }
  if (cur) out.push(cur);
  return out;
}
const TIME_MS = { "1m": 60000, "5m": 300000, "15m": 900000, "1h": 3600000 };
function candles() {
  if (state.mode.type === "tick") return buildTick(state.trades, state.mode.n);
  return buildTime(state.trades, TIME_MS[state.mode.n]);
}

// ---------- chart rendering ----------
const canvas = $("chart-canvas");
const ctx = canvas.getContext("2d");
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

function resizeCanvas() {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(wrap.clientWidth * dpr);
  canvas.height = Math.floor(wrap.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawChart();
}

function drawChart() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  const data = candles();
  $("chart-empty").classList.toggle("show", data.length === 0);
  if (data.length === 0) { updateFoot(null, data); return; }

  const padR = 52, padB = 34, padT = 10, padL = 6;
  const plotW = W - padR - padL, plotH = H - padB - padT;

  let hi = -Infinity, lo = Infinity, maxVol = 0;
  for (const c of data) { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); maxVol = Math.max(maxVol, c.volume); }
  if (hi === lo) { hi += 0.01; lo -= 0.01; }
  const pad = (hi - lo) * 0.12; hi += pad; lo -= pad;
  const Y = (p) => padT + (1 - (p - lo) / (hi - lo)) * plotH;

  const up = css("--up"), down = css("--down"), hair = css("--hair"), faint = css("--ink-faint"),
        amber = css("--amber"), soft = css("--ink-soft");

  // grid + price axis
  ctx.font = "10px ui-monospace, monospace"; ctx.textBaseline = "middle";
  ctx.strokeStyle = hair; ctx.fillStyle = faint; ctx.lineWidth = 1;
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const p = lo + (hi - lo) * (i / ticks); const y = Y(p);
    ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(W - padR, y + 0.5); ctx.stroke();
    ctx.globalAlpha = 1; ctx.textAlign = "left"; ctx.fillText((p * 100).toFixed(1) + "¢", W - padR + 6, y);
  }

  // volume histogram (bottom band)
  const volH = plotH * 0.16, volBase = padT + plotH;
  const n = data.length, slot = plotW / n, bw = Math.max(1, Math.min(slot * 0.7, 14));
  data.forEach((c, i) => {
    const x = padL + i * slot + slot / 2;
    const vh = maxVol ? (c.volume / maxVol) * volH : 0;
    ctx.globalAlpha = 0.28; ctx.fillStyle = c.close >= c.open ? up : down;
    ctx.fillRect(x - bw / 2, volBase - vh, bw, vh); ctx.globalAlpha = 1;
  });

  // candles
  data.forEach((c, i) => {
    const x = padL + i * slot + slot / 2;
    const bull = c.close >= c.open;
    ctx.strokeStyle = bull ? up : down; ctx.fillStyle = bull ? up : down; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 0.5, Y(c.high)); ctx.lineTo(x + 0.5, Y(c.low)); ctx.stroke();
    const yo = Y(c.open), yc = Y(c.close);
    ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1.5, Math.abs(yc - yo)));
  });

  // last price line
  const last = data[data.length - 1];
  const ly = Y(last.close);
  ctx.strokeStyle = amber; ctx.globalAlpha = 0.8; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(padL, ly + 0.5); ctx.lineTo(W - padR, ly + 0.5); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 1;
  ctx.fillStyle = amber; ctx.fillRect(W - padR, ly - 8, padR, 16);
  ctx.fillStyle = css("--bg"); ctx.textAlign = "left";
  ctx.fillText((last.close * 100).toFixed(1), W - padR + 6, ly);

  updateFoot(last, data);
}

function updateFoot(last, data) {
  const foot = $("chart-foot");
  if (!last) { foot.innerHTML = ""; return; }
  const totalVol = data.reduce((s, c) => s + c.volume, 0);
  const buyVol = data.reduce((s, c) => s + c.buyVolume, 0);
  const imb = totalVol ? ((buyVol - (totalVol - buyVol)) / totalVol) : 0;
  const imbColor = imb >= 0 ? css("--up") : css("--down");
  foot.innerHTML =
    `<span><b>candles</b> ${data.length}</span>` +
    `<span><b>prints</b> ${data.reduce((s, c) => s + c.trades, 0)}</span>` +
    `<span><b>volume</b> ${fmtSize(totalVol)}</span>` +
    `<span><b>orderflow</b> <span style="color:${imbColor}">${imb >= 0 ? "+" : ""}${(imb * 100).toFixed(0)}%</span></span>`;
}

// ---------- book + tape ----------
function renderBook(book) {
  const asks = (book.asks || []).slice().sort((a, b) => a.price - b.price).slice(0, 8);
  const bids = (book.bids || []).slice().sort((a, b) => b.price - a.price).slice(0, 8);
  const maxSz = Math.max(1, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
  const rows = (levels, cls) => levels.map((l) =>
    `<div class="book-row ${cls}"><span class="px">${cents(l.price)}</span>` +
    `<span class="sz">${fmtSize(l.size)}</span>` +
    `<i class="depth" style="width:${(l.size / maxSz) * 100}%"></i></div>`).join("");
  $("book-asks").innerHTML = rows(asks, "ask");
  $("book-bids").innerHTML = rows(bids, "bid");
  const bestAsk = asks[0]?.price, bestBid = bids[0]?.price;
  if (bestAsk != null && bestBid != null) {
    const mid = (bestAsk + bestBid) / 2, spread = bestAsk - bestBid;
    $("book-mid").textContent = `${cents(mid)}¢  ·  spread ${(spread * 100).toFixed(1)}¢`;
    $("spread-hint").textContent = `${cents(bestBid)} / ${cents(bestAsk)}`;
  }
}

function addTape(t, flash) {
  const tape = $("tape");
  const row = document.createElement("div");
  row.className = `tape-row ${t.side === "BUY" ? "buy" : "sell"}${flash ? " flash" : ""}`;
  row.innerHTML = `<span class="t-side">${t.side === "BUY" ? "▲" : "▼"}</span>` +
    `<span class="t-px">${cents(t.price)}¢</span>` +
    `<span class="t-sz">${fmtSize(t.size)}</span>` +
    `<span class="t-time">${fmtTime(t.ts)}</span>`;
  tape.prepend(row);
  while (tape.children.length > 60) tape.lastChild.remove();
}

function updateHeader() {
  const data = candles();
  if (data.length === 0) { $("mkt-price").textContent = "—"; $("mkt-chg").textContent = ""; return; }
  const last = data[data.length - 1].close;
  const first = data[0].open;
  $("mkt-price").textContent = cents(last);
  const chg = (last - first) * 100;
  const el = $("mkt-chg");
  el.textContent = `${chg >= 0 ? "+" : ""}${chg.toFixed(1)}¢`;
  el.className = `chg ${chg >= 0 ? "up" : "down"}`;
}

// ---------- market selection ----------
async function selectMarket(m) {
  state.selected = m;
  state.tokenId = m.tokenIds[0];
  document.querySelectorAll(".wl-row").forEach((r) => r.classList.toggle("is-active", r.dataset.market === m.market));
  $("mkt-question").textContent = m.question;
  const badge = $("mkt-venue");
  badge.textContent = VENUE_LABEL[m.venue] || m.venue;
  badge.dataset.v = m.venue;
  badge.hidden = false;
  state.trades = [];
  $("tape").innerHTML = "";

  // initial state
  try {
    const [trades, book] = await Promise.all([
      api(`/api/trades/${state.tokenId}?limit=1000`),
      api(`/api/book/${state.tokenId}`).catch(() => null),
    ]);
    state.trades = trades.slice().reverse(); // API gives newest-first; we want ascending
    trades.slice(0, 30).forEach((t) => addTape(t, false));
    if (book) renderBook(book);
  } catch (e) { /* market may have no data yet */ }

  drawChart(); updateHeader();
  subscribe(state.tokenId);
}

// ---------- live socket ----------
function setConn(stateStr, label) {
  $("conn-dot").dataset.state = stateStr;
  $("conn-label").textContent = label;
}
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/live`);
  state.ws = ws;
  ws.onopen = () => { state.wsReady = true; setConn("live", "live"); if (state.tokenId) subscribe(state.tokenId); };
  ws.onclose = () => { state.wsReady = false; setConn("down", "reconnecting…"); setTimeout(connectWs, 2000); };
  ws.onerror = () => setConn("down", "error");
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.kind === "trade" && msg.trade.tokenId === state.tokenId) onLiveTrade(msg.trade);
    else if (msg.kind === "book" && msg.book.tokenId === state.tokenId) renderBook(msg.book);
  };
}
function subscribe(tokenId) {
  if (state.wsReady && state.ws) state.ws.send(JSON.stringify({ type: "subscribe", tokenId }));
}
function onLiveTrade(t) {
  state.trades.push(t);
  if (state.trades.length > MAX_TRADES) state.trades.shift();
  addTape(t, true);
  drawChart(); updateHeader();
}

// ---------- boot ----------
function renderWatchlist() {
  const el = $("watchlist");
  el.innerHTML = state.markets.map((m, i) =>
    `<div class="wl-row" data-idx="${i}" data-market="${escapeHtml(m.market)}">` +
    `<div class="wl-row__q">${escapeHtml(m.question)}</div>` +
    `<div class="wl-row__px">${m.lastPrice != null ? cents(m.lastPrice) + "¢" : "—"}</div>` +
    `<div class="wl-row__vol">` +
      `<span class="venue-badge" data-v="${m.venue}">${VENUE_LABEL[m.venue] || m.venue}</span> ` +
      `${m.volume24hr ? "$" + fmtSize(m.volume24hr) + " 24h" : ""}</div>` +
    `</div>`).join("");
  el.querySelectorAll(".wl-row").forEach((row) => {
    row.addEventListener("click", () => selectMarket(state.markets[Number(row.dataset.idx)]));
  });
  $("market-count").textContent = `${state.markets.length}`;
}

async function loadMarkets(selectFirst) {
  const q = state.venue ? `&venue=${state.venue}` : "";
  state.markets = await api(`/api/markets?limit=120${q}`);
  renderWatchlist();
  if (selectFirst && state.markets.length) selectMarket(state.markets[0]);
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

$("interval-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab"); if (!btn) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
  btn.classList.add("is-active");
  const [type, n] = btn.dataset.mode.split(":");
  state.mode = { type, n: type === "tick" ? Number(n) : n };
  drawChart(); updateHeader();
});

// ---------- view toggle: Terminal <-> Cross-Venue ----------
$("nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav__tab"); if (!btn) return;
  document.querySelectorAll(".nav__tab").forEach((t) => t.classList.remove("is-active"));
  btn.classList.add("is-active");
  const cross = btn.dataset.view === "cross";
  document.querySelector(".grid").hidden = cross;
  $("crossvenue").hidden = !cross;
  if (cross) loadCrossVenue();
});

async function loadCrossVenue() {
  const body = $("cv-body");
  const empty = $("cv-empty");
  try {
    const data = await api("/api/cross-venue?minConfidence=0.25&limit=60");
    $("cv-stats").innerHTML =
      `<b>${data.matches.length}</b> candidate matches<br>` +
      `${data.polymarketMarkets} Polymarket · ${data.kalshiMarkets} Kalshi markets`;
    if (!data.matches.length) {
      body.innerHTML = "";
      empty.hidden = false; empty.classList.add("show");
      empty.textContent = "No cross-venue candidates right now — the two venues aren't listing overlapping questions at the moment. As shared markets (Fed decisions, crypto, elections) trade on both, they'll appear here automatically.";
      return;
    }
    empty.hidden = true; empty.classList.remove("show");
    body.innerHTML = data.matches.map(renderMatchRow).join("");
  } catch (e) {
    empty.hidden = false; empty.classList.add("show");
    empty.textContent = "Couldn't load cross-venue matches.";
  }
}

function confClass(c) { return c >= 0.6 ? "cv-conf--hi" : c >= 0.4 ? "cv-conf--mid" : ""; }
const ARB_DIR = { "buy-yes-polymarket": "Buy YES · Polymarket", "buy-yes-kalshi": "Buy YES · Kalshi" };

function priceCell(side) {
  const px = side.yes != null ? cents(side.yes) + "¢" : "—";
  return `<div class="cv-venue-cell"><span class="px">${px}</span><span class="q">${escapeHtml(side.question)}</span></div>`;
}

function renderMatchRow(m) {
  const hasArb = m.arbDirection && m.arbDirection !== "none";
  const spreadTxt = m.spread == null ? "—" : `${m.spread >= 0 ? "+" : ""}${(m.spread * 100).toFixed(1)}¢`;
  const spreadCls = m.spread == null ? "muted" : m.spread >= 0 ? "pos" : "neg";
  const consTxt = m.consensus == null ? "—" : cents(m.consensus) + "¢";
  const conf = Math.round(m.confidence * 100);
  const tokens = m.sharedTokens.slice(0, 5).join(" · ");
  const arbCell = hasArb
    ? `<span class="cv-arb__edge">${(m.arbEdge * 100).toFixed(1)}¢</span><span class="cv-arb__dir">${ARB_DIR[m.arbDirection] || ""}</span>`
    : `<span class="cv-arb--none">—</span>`;
  return `<tr class="${hasArb ? "has-arb" : ""}">` +
    `<td><div class="cv-match__q">${escapeHtml(m.label)}</div>` +
      `<div class="cv-match__meta">` +
        `<span class="cv-conf ${confClass(m.confidence)}"><span class="cv-conf__bar"><span class="cv-conf__fill" style="width:${conf}%"></span></span>${conf}%</span>` +
        `<span class="cv-tokens">${escapeHtml(tokens)}</span>` +
      `</div></td>` +
    `<td>${priceCell(m.polymarket)}</td>` +
    `<td>${priceCell(m.kalshi)}</td>` +
    `<td class="cv-num ${spreadCls}">${spreadTxt}</td>` +
    `<td class="cv-num">${consTxt}</td>` +
    `<td class="cv-arb">${arbCell}</td>` +
    `</tr>`;
}

$("venue-filter").addEventListener("click", (e) => {
  const btn = e.target.closest(".vtab"); if (!btn) return;
  document.querySelectorAll(".vtab").forEach((t) => t.classList.remove("is-active"));
  btn.classList.add("is-active");
  state.venue = btn.dataset.venue;
  loadMarkets(false).catch(() => {});
});

window.addEventListener("resize", resizeCanvas);

async function boot() {
  connectWs();
  try {
    await loadMarkets(true);
  } catch (e) {
    setConn("down", "api error");
  }
  resizeCanvas();
  // The Kalshi catalogue fills in as markets trade; refresh the list periodically
  // without disturbing the current selection.
  setInterval(() => {
    const active = state.selected?.market;
    loadMarkets(false).then(() => {
      if (active) document.querySelectorAll(".wl-row").forEach((r) =>
        r.classList.toggle("is-active", r.dataset.market === active));
    }).catch(() => {});
  }, 20000);
}
boot();
