// Sharpline terminal frontend. Vanilla JS, no build step.
// Talks only to our own API + /live socket — never to Polymarket directly.

const state = {
  markets: [],
  selected: null,      // MarketMeta
  tokenId: null,       // active outcome token
  trades: [],          // rolling trade history for the active token (ascending)
  mode: { type: "tick", n: 50 },
  venue: "",            // "" = all, "polymarket", "kalshi"
  // TradingView-style unified symbol: one question, multiple venue sources.
  sources: [],         // [{venue, tokenId, lastPrice, confidence}] — [0] is the picked market
  activeVenue: null,
  compare: false,      // overlay both venues' price lines
  overlay: null,       // { tokenId, venue, trades: [] } for the compared venue
  ws: null,
  wsReady: false,
};

const VENUE_LABEL = { polymarket: "PM", kalshi: "Kalshi" };
const VENUE_NAME = { polymarket: "Polymarket", kalshi: "Kalshi" };
const VENUE_COLOR = { polymarket: "#a99cf5", kalshi: "#4fd6b3" };

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
  if (state.compare && state.overlay) { drawCompare(); return; }
  $("compare-legend").hidden = true;
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

// ---------- compare mode: two venues' price lines on one time axis ----------
function drawCompare() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  // Both venues on a shared time axis so they line up; tick mode isn't comparable
  // across venues, so fall back to 5m buckets when the user is on Tick.
  const ms = state.mode.type === "time" ? TIME_MS[state.mode.n] : 300000;
  const aC = buildTime(state.trades, ms);
  const oC = buildTime(state.overlay.trades, ms);

  const all = [...aC, ...oC];
  if (all.length === 0) {
    $("chart-empty").classList.add("show"); $("compare-legend").hidden = true; return;
  }
  $("chart-empty").classList.remove("show");

  let tMin = Infinity, tMax = -Infinity, pMin = Infinity, pMax = -Infinity;
  for (const c of all) { tMin = Math.min(tMin, c.start); tMax = Math.max(tMax, c.end); pMin = Math.min(pMin, c.low); pMax = Math.max(pMax, c.high); }
  if (pMin === pMax) { pMin -= 0.01; pMax += 0.01; }
  const vpad = (pMax - pMin) * 0.12; pMin -= vpad; pMax += vpad;
  if (tMin === tMax) tMax = tMin + ms;

  const padR = 52, padB = 20, padT = 12, padL = 8, plotW = W - padR - padL, plotH = H - padB - padT;
  const X = (t) => padL + ((t - tMin) / (tMax - tMin)) * plotW;
  const Y = (p) => padT + (1 - (p - pMin) / (pMax - pMin)) * plotH;

  const hair = css("--hair"), faint = css("--ink-faint");
  ctx.font = "10px ui-monospace, monospace"; ctx.textBaseline = "middle";
  for (let i = 0; i <= 5; i++) {
    const p = pMin + (pMax - pMin) * (i / 5), y = Y(p);
    ctx.strokeStyle = hair; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(W - padR, y + 0.5); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = faint; ctx.textAlign = "left"; ctx.fillText((p * 100).toFixed(1) + "¢", W - padR + 6, y);
  }

  function line(cands, color) {
    if (cands.length === 0) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.beginPath();
    cands.forEach((c, i) => {
      const x = X((c.start + c.end) / 2), y = Y(c.close);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    const last = cands[cands.length - 1];
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X((last.start + last.end) / 2), Y(last.close), 3.2, 0, Math.PI * 2); ctx.fill();
  }
  line(aC, VENUE_COLOR[state.activeVenue]);
  line(oC, VENUE_COLOR[state.overlay.venue]);

  const aPx = aC.length ? aC[aC.length - 1].close : null;
  const oPx = oC.length ? oC[oC.length - 1].close : null;
  renderCompareLegend(aPx, oPx);
  updateFoot(aC[aC.length - 1] || null, aC);
}

function renderCompareLegend(aPx, oPx) {
  const leg = $("compare-legend"); leg.hidden = false;
  const item = (venue, px) =>
    `<span class="leg"><span class="leg__dot" style="background:${VENUE_COLOR[venue]}"></span>` +
    `<span class="leg__name">${VENUE_NAME[venue]}</span>` +
    `<span class="leg__px" style="color:${VENUE_COLOR[venue]}">${px != null ? cents(px) + "¢" : "—"}</span></span>`;
  let html = item(state.activeVenue, aPx) + item(state.overlay.venue, oPx);
  if (aPx != null && oPx != null) {
    const d = (oPx - aPx) * 100;
    html += `<span class="leg__spread">divergence <b>${d >= 0 ? "+" : ""}${d.toFixed(1)}¢</b></span>`;
  }
  leg.innerHTML = html;
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

function clearBook() {
  $("book-asks").innerHTML = ""; $("book-bids").innerHTML = "";
  $("book-mid").textContent = "—"; $("spread-hint").textContent = "";
}

// ---------- market selection ----------
async function selectMarket(m) {
  state.selected = m;
  state.tokenId = m.tokenIds[0];
  state.activeVenue = m.venue;
  // Reset compare/source state for the new question.
  state.compare = false; state.overlay = null;
  $("compare-btn").classList.remove("is-active"); $("compare-legend").hidden = true;
  state.sources = [{ venue: m.venue, tokenId: m.tokenIds[0], lastPrice: m.lastPrice, confidence: 1 }];

  document.querySelectorAll(".wl-row").forEach((r) => r.classList.toggle("is-active", r.dataset.market === m.market));
  $("mkt-question").textContent = m.question;
  setVenueBadge(m.venue);
  renderSourceSwitch();

  await loadSource(m.tokenIds[0]);
  drawChart(); updateHeader();
  subscribe();
  loadCounterparts(m.tokenIds[0]); // async; adds other-venue sources when ready
}

function setVenueBadge(venue) {
  const badge = $("mkt-venue");
  badge.textContent = VENUE_LABEL[venue] || venue;
  badge.dataset.v = venue;
  badge.hidden = false;
}

/** Load trades + book for one token into the active view. */
async function loadSource(tokenId) {
  state.trades = [];
  $("tape").innerHTML = "";
  try {
    const [trades, book] = await Promise.all([
      api(`/api/trades/${tokenId}?limit=1000`),
      api(`/api/book/${tokenId}`).catch(() => null),
    ]);
    if (state.tokenId !== tokenId) return; // selection changed mid-fetch
    state.trades = trades.slice().reverse(); // API gives newest-first; we want ascending
    trades.slice(0, 30).forEach((t) => addTape(t, false));
    if (book) renderBook(book); else clearBook();
  } catch (e) { clearBook(); }
}

async function loadCounterparts(tokenId) {
  try {
    const data = await api(`/api/counterparts/${tokenId}?minConfidence=0.4`);
    if (state.tokenId !== tokenId && !state.sources.some((s) => s.tokenId === tokenId)) return;
    for (const c of data.counterparts) {
      if (!state.sources.some((s) => s.venue === c.venue)) {
        state.sources.push({ venue: c.venue, tokenId: c.tokenId, lastPrice: c.lastPrice, confidence: c.confidence });
      }
    }
    renderSourceSwitch();
  } catch (e) { /* no counterparts */ }
}

function renderSourceSwitch() {
  const wrap = $("source-switch");
  const cmp = $("compare-btn");
  if (state.sources.length < 2) { wrap.hidden = true; cmp.hidden = true; return; }
  wrap.hidden = false; cmp.hidden = false;
  $("source-tabs").innerHTML = state.sources.map((s) => {
    const active = s.venue === state.activeVenue;
    const px = s.lastPrice != null ? cents(s.lastPrice) + "¢" : "—";
    const conf = s.confidence != null && s.confidence < 1 ? `<span class="src-tab__conf">${Math.round(s.confidence * 100)}% match</span>` : "";
    return `<button class="src-tab ${active ? "is-active" : ""}" data-venue="${s.venue}">` +
      `<span class="src-tab__dot" style="background:${VENUE_COLOR[s.venue]}"></span>` +
      `${VENUE_NAME[s.venue] || s.venue} <span class="px">${px}</span> ${conf}</button>`;
  }).join("");
  $("source-tabs").querySelectorAll(".src-tab").forEach((b) =>
    b.addEventListener("click", () => switchSource(b.dataset.venue)));
}

async function switchSource(venue) {
  const src = state.sources.find((s) => s.venue === venue);
  if (!src || venue === state.activeVenue) return;
  state.activeVenue = venue;
  state.tokenId = src.tokenId;
  setVenueBadge(venue);
  renderSourceSwitch();
  await loadSource(src.tokenId);
  subscribe();
  drawChart(); updateHeader();
}

async function toggleCompare() {
  state.compare = !state.compare;
  $("compare-btn").classList.toggle("is-active", state.compare);
  if (state.compare) {
    const other = state.sources.find((s) => s.venue !== state.activeVenue);
    if (!other) { state.compare = false; $("compare-btn").classList.remove("is-active"); return; }
    state.overlay = { tokenId: other.tokenId, venue: other.venue, trades: [] };
    await loadOverlay(other.tokenId);
  } else {
    state.overlay = null;
    $("compare-legend").hidden = true;
  }
  subscribe();
  drawChart();
}

async function loadOverlay(tokenId) {
  try {
    const trades = await api(`/api/trades/${tokenId}?limit=1000`);
    if (state.overlay && state.overlay.tokenId === tokenId) state.overlay.trades = trades.slice().reverse();
  } catch (e) { if (state.overlay) state.overlay.trades = []; }
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
  ws.onopen = () => { state.wsReady = true; setConn("live", "live"); subscribe(); };
  ws.onclose = () => { state.wsReady = false; setConn("down", "reconnecting…"); setTimeout(connectWs, 2000); };
  ws.onerror = () => setConn("down", "error");
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.kind === "trade") {
      if (msg.trade.tokenId === state.tokenId) onLiveTrade(msg.trade);
      else if (state.overlay && msg.trade.tokenId === state.overlay.tokenId) onOverlayTrade(msg.trade);
    } else if (msg.kind === "book" && msg.book.tokenId === state.tokenId) {
      renderBook(msg.book);
    }
  };
}
function subscribe() {
  if (!state.wsReady || !state.ws) return;
  const ids = [state.tokenId];
  if (state.compare && state.overlay) ids.push(state.overlay.tokenId);
  state.ws.send(JSON.stringify({ type: "subscribe", tokenIds: ids.filter(Boolean) }));
}
function onLiveTrade(t) {
  state.trades.push(t);
  if (state.trades.length > MAX_TRADES) state.trades.shift();
  addTape(t, true);
  drawChart(); updateHeader();
}
function onOverlayTrade(t) {
  if (!state.overlay) return;
  state.overlay.trades.push(t);
  if (state.overlay.trades.length > MAX_TRADES) state.overlay.trades.shift();
  drawChart();
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
  document.querySelectorAll("#interval-tabs .tab").forEach((t) => t.classList.remove("is-active"));
  btn.classList.add("is-active");
  const [type, n] = btn.dataset.mode.split(":");
  state.mode = { type, n: type === "tick" ? Number(n) : n };
  drawChart(); updateHeader();
});

$("compare-btn").addEventListener("click", toggleCompare);

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
