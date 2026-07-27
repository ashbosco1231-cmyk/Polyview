// Sharpline terminal frontend. Vanilla ES modules, no build step.
// Talks only to our own API + /live socket — never to a venue directly.

import { INDICATORS, PriceChart } from "./chart.js";

const state = {
  markets: [],
  filter: "",
  venue: "", // "" = all
  selected: null,
  tokenId: null,
  mode: { type: "time", interval: "1m" },
  // One question can trade on several venues; [0] is the market that was picked.
  sources: [],
  activeVenue: null,
  compare: false,
  overlayTokenId: null,
  oldestLoaded: null, // cursor for paging history leftwards
  ws: null,
  wsReady: false,
};

const VENUE_LABEL = { polymarket: "PM", kalshi: "KALSHI" };
const VENUE_NAME = { polymarket: "Polymarket", kalshi: "Kalshi" };
const VENUE_COLOR = { polymarket: "#a99cf5", kalshi: "#4fd6b3" };
const INTERVAL_MS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "1h": 3.6e6, "4h": 1.44e7, "1d": 8.64e7 };
const PAGE = 400;

const $ = (id) => document.getElementById(id);
const cents = (p) => (p * 100).toFixed(1);
const fmtSize = (s) =>
  s >= 1e6 ? (s / 1e6).toFixed(1) + "M" : s >= 1e3 ? (s / 1e3).toFixed(1) + "k" : s.toFixed(0);
const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour12: false });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

// ---------- chart ----------
const chart = new PriceChart($("chart-mount"), {
  onNeedHistory: () => loadOlderHistory(),
  onHover: (bar) => renderLegend(bar),
});

function currentIntervalMs() {
  return state.mode.type === "time" ? INTERVAL_MS[state.mode.interval] : 0;
}

function candleQuery(tokenId, { to } = {}) {
  const p = new URLSearchParams({ type: state.mode.type, count: String(PAGE) });
  if (state.mode.type === "time") {
    p.set("interval", state.mode.interval);
    if (to != null) p.set("to", String(to));
  } else {
    p.set("ticks", String(state.mode.ticks ?? 50));
  }
  return `/api/candles/${encodeURIComponent(tokenId)}?${p}`;
}

async function loadCandles(tokenId) {
  const data = await api(candleQuery(tokenId));
  if (state.tokenId !== tokenId) return; // selection moved on while fetching
  chart.setCandles(data.candles, { hasMore: data.hasMore });
  state.oldestLoaded = data.candles.length ? data.candles[0].start : data.from ?? null;
  $("chart-empty").classList.toggle("show", data.candles.length === 0);
  renderFoot(data.candles);
  renderHeader(data.candles);
}

/** Page one screen further back when the view approaches the left edge. */
async function loadOlderHistory() {
  if (state.mode.type !== "time" || state.oldestLoaded == null) {
    chart.prependCandles([], { hasMore: false });
    return;
  }
  const tokenId = state.tokenId;
  $("chart-loading").hidden = false;
  try {
    const data = await api(candleQuery(tokenId, { to: state.oldestLoaded }));
    if (state.tokenId !== tokenId) return;
    chart.prependCandles(data.candles, { hasMore: data.hasMore });
    if (data.candles.length) state.oldestLoaded = data.candles[0].start;
    else chart.hasMore = false;
  } catch {
    chart.prependCandles([], { hasMore: false });
  } finally {
    $("chart-loading").hidden = true;
  }
}

function renderLegend(bar) {
  const el = $("chart-legend");
  if (!bar) {
    el.innerHTML = "";
    return;
  }
  const dir = bar.close >= bar.open ? "up" : "down";
  const cell = (label, value, cls = "") =>
    `<span class="lg"><b>${label}</b><span class="v ${cls}">${value}</span></span>`;
  el.innerHTML =
    cell("O", cents(bar.open)) +
    cell("H", cents(bar.high)) +
    cell("L", cents(bar.low)) +
    cell("C", cents(bar.close), dir) +
    cell("Vol", fmtSize(bar.volume)) +
    (bar.trades ? cell("Prints", bar.trades) : "");
}

function renderFoot(candles) {
  const foot = $("chart-foot");
  if (!candles.length) {
    foot.innerHTML = "";
    return;
  }
  const vol = candles.reduce((s, c) => s + c.volume, 0);
  const buy = candles.reduce((s, c) => s + (c.buyVolume ?? 0), 0);
  const prints = candles.reduce((s, c) => s + (c.trades ?? 0), 0);
  const imb = vol ? (buy - (vol - buy)) / vol : 0;
  const cls = imb >= 0 ? "up" : "down";
  foot.innerHTML =
    `<span><b>bars</b> ${candles.length}</span>` +
    `<span><b>prints</b> ${prints.toLocaleString()}</span>` +
    `<span><b>volume</b> ${fmtSize(vol)}</span>` +
    `<span><b>orderflow</b> <span class="${cls}">${imb >= 0 ? "+" : ""}${(imb * 100).toFixed(0)}%</span></span>` +
    `<span><b>scroll</b> drag to pan · scroll to zoom</span>`;
}

function renderHeader(candles) {
  if (!candles.length) {
    $("mkt-price").textContent = "—";
    $("mkt-chg").textContent = "";
    return;
  }
  const last = candles[candles.length - 1].close;
  const first = candles[0].open;
  $("mkt-price").textContent = cents(last) + "¢";
  const chg = (last - first) * 100;
  const el = $("mkt-chg");
  el.textContent = `${chg >= 0 ? "+" : ""}${chg.toFixed(1)}¢`;
  el.className = `chg ${chg >= 0 ? "up" : "down"}`;
}

// ---------- indicators menu ----------
function renderIndicatorMenu() {
  const list = $("indicator-list");
  const colors = { sma20: "#5b8dd6", sma50: "#b07fd4", ema9: "#f5b942", vwap: "#e07b53", bb: "#4a5568", rsi: "#c9a227", macd: "#5b8dd6" };
  list.innerHTML = INDICATORS.map(
    (i) =>
      `<button class="dropdown__item ${chart.isEnabled(i.id) ? "is-on" : ""}" data-ind="${i.id}">` +
      `<span class="dropdown__check"></span>${i.label}` +
      `<span class="dropdown__swatch" style="background:${colors[i.id]}"></span></button>`,
  ).join("");
  const on = INDICATORS.filter((i) => chart.isEnabled(i.id)).length;
  const badge = $("indicator-count");
  badge.textContent = String(on);
  badge.hidden = on === 0;
}

$("indicator-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("indicator-list");
  menu.hidden = !menu.hidden;
  $("indicator-btn").setAttribute("aria-expanded", String(!menu.hidden));
});
$("indicator-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-ind]");
  if (!btn) return;
  chart.toggleIndicator(btn.dataset.ind);
  renderIndicatorMenu();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#indicator-menu")) {
    $("indicator-list").hidden = true;
    $("indicator-btn").setAttribute("aria-expanded", "false");
  }
});
$("fit-btn").addEventListener("click", () => chart.fit());

// ---------- book + tape ----------
function renderBook(book) {
  const asks = (book.asks || []).slice().sort((a, b) => a.price - b.price).slice(0, 9);
  const bids = (book.bids || []).slice().sort((a, b) => b.price - a.price).slice(0, 9);
  const max = Math.max(1, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
  const rows = (levels, cls) =>
    levels
      .map(
        (l) =>
          `<div class="book-row ${cls}"><span class="px">${cents(l.price)}</span>` +
          `<span class="sz">${fmtSize(l.size)}</span>` +
          `<i class="depth" style="width:${(l.size / max) * 100}%"></i></div>`,
      )
      .join("");
  $("book-asks").innerHTML = rows(asks, "ask");
  $("book-bids").innerHTML = rows(bids, "bid");

  const bestAsk = asks[0]?.price;
  const bestBid = bids[0]?.price;
  if (bestAsk != null && bestBid != null) {
    const mid = (bestAsk + bestBid) / 2;
    $("book-mid").innerHTML = `${cents(mid)}¢ <span class="sp">spread ${((bestAsk - bestBid) * 100).toFixed(1)}¢</span>`;
    $("spread-hint").textContent = `${cents(bestBid)} / ${cents(bestAsk)}`;
  }
}

function clearBook() {
  $("book-asks").innerHTML = "";
  $("book-bids").innerHTML = "";
  $("book-mid").textContent = "—";
  $("spread-hint").textContent = "";
}

function addTape(t, flash) {
  const tape = $("tape");
  const row = document.createElement("div");
  row.className = `tape-row ${t.side === "BUY" ? "buy" : "sell"}${flash ? " flash" : ""}`;
  row.innerHTML =
    `<span class="t-side">${t.side === "BUY" ? "BUY" : "SELL"}</span>` +
    `<span class="t-px">${cents(t.price)}</span>` +
    `<span class="t-sz">${fmtSize(t.size)}</span>` +
    `<span class="t-time">${fmtTime(t.ts)}</span>`;
  tape.prepend(row);
  while (tape.children.length > 80) tape.lastChild.remove();
}

// ---------- market selection ----------
async function selectMarket(m) {
  state.selected = m;
  state.tokenId = m.tokenIds[0];
  state.activeVenue = m.venue;
  state.compare = false;
  state.overlayTokenId = null;
  chart.clearCompare();
  $("compare-btn").classList.remove("is-active");
  state.sources = [{ venue: m.venue, tokenId: m.tokenIds[0], lastPrice: m.lastPrice, confidence: 1 }];

  document.querySelectorAll(".wl-row").forEach((r) => r.classList.toggle("is-active", r.dataset.market === m.market));
  $("mkt-question").textContent = m.question;
  setVenueBadge(m.venue);
  renderSourceSwitch();

  await loadSource(state.tokenId);
  subscribe();
  loadCounterparts(state.tokenId);
}

function setVenueBadge(venue) {
  const badge = $("mkt-venue");
  badge.textContent = VENUE_LABEL[venue] || venue;
  badge.dataset.v = venue;
  badge.hidden = false;
}

/** Load everything that hangs off one token: candles, book, tape. */
async function loadSource(tokenId) {
  $("tape").innerHTML = "";
  clearBook();
  try {
    const [, trades, book] = await Promise.all([
      loadCandles(tokenId),
      api(`/api/trades/${encodeURIComponent(tokenId)}?limit=60`),
      api(`/api/book/${encodeURIComponent(tokenId)}`).catch(() => null),
    ]);
    if (state.tokenId !== tokenId) return;
    trades.forEach((t) => addTape(t, false));
    if (book) renderBook(book);
  } catch {
    clearBook();
  }
}

async function loadCounterparts(tokenId) {
  try {
    const data = await api(`/api/counterparts/${encodeURIComponent(tokenId)}?minConfidence=0.4`);
    if (state.tokenId !== tokenId) return;
    for (const c of data.counterparts) {
      if (!state.sources.some((s) => s.venue === c.venue)) {
        state.sources.push({ venue: c.venue, tokenId: c.tokenId, lastPrice: c.lastPrice, confidence: c.confidence });
      }
    }
    renderSourceSwitch();
  } catch {
    /* no counterparts on the other venue */
  }
}

function renderSourceSwitch() {
  const wrap = $("source-switch");
  const cmp = $("compare-btn");
  if (state.sources.length < 2) {
    wrap.hidden = true;
    cmp.hidden = true;
    return;
  }
  wrap.hidden = false;
  cmp.hidden = false;
  $("source-tabs").innerHTML = state.sources
    .map((s) => {
      const active = s.venue === state.activeVenue;
      const px = s.lastPrice != null ? cents(s.lastPrice) + "¢" : "—";
      const conf = s.confidence != null && s.confidence < 1 ? `<span class="src-tab__conf">${Math.round(s.confidence * 100)}%</span>` : "";
      return (
        `<button class="src-tab ${active ? "is-active" : ""}" data-venue="${s.venue}">` +
        `<span class="src-tab__dot" style="background:${VENUE_COLOR[s.venue]}"></span>` +
        `${VENUE_NAME[s.venue] || s.venue} <span class="px">${px}</span> ${conf}</button>`
      );
    })
    .join("");
  $("source-tabs")
    .querySelectorAll(".src-tab")
    .forEach((b) => b.addEventListener("click", () => switchSource(b.dataset.venue)));
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
}

async function toggleCompare() {
  state.compare = !state.compare;
  $("compare-btn").classList.toggle("is-active", state.compare);
  if (!state.compare) {
    state.overlayTokenId = null;
    chart.clearCompare();
    subscribe();
    return;
  }
  const other = state.sources.find((s) => s.venue !== state.activeVenue);
  if (!other) {
    state.compare = false;
    $("compare-btn").classList.remove("is-active");
    return;
  }
  state.overlayTokenId = other.tokenId;
  try {
    const data = await api(candleQuery(other.tokenId));
    if (state.overlayTokenId === other.tokenId) chart.setCompare(data.candles, VENUE_COLOR[other.venue]);
  } catch {
    /* the other venue may have no prints recorded yet */
  }
  subscribe();
}

$("compare-btn").addEventListener("click", toggleCompare);

// ---------- live socket ----------
function setConn(s, label) {
  $("conn-dot").dataset.state = s;
  $("conn-label").textContent = label;
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/live`);
  state.ws = ws;
  ws.onopen = () => {
    state.wsReady = true;
    setConn("live", "live");
    subscribe();
  };
  ws.onclose = () => {
    state.wsReady = false;
    setConn("down", "reconnecting");
    setTimeout(connectWs, 2000);
  };
  ws.onerror = () => setConn("down", "error");
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.kind === "trade" && msg.trade.tokenId === state.tokenId) onLiveTrade(msg.trade);
    else if (msg.kind === "book" && msg.book.tokenId === state.tokenId) renderBook(msg.book);
  };
}

function subscribe() {
  if (!state.wsReady || !state.ws) return;
  const ids = [state.tokenId, state.compare ? state.overlayTokenId : null].filter(Boolean);
  state.ws.send(JSON.stringify({ type: "subscribe", tokenIds: ids }));
}

// Tick candles are bucketed by trade count, not time, so a live print can't be
// folded into the newest bar the way a time candle can. Refetching on a short
// debounce keeps one code path instead of a second client-side aggregator.
let tickRefresh = null;
function onLiveTrade(t) {
  addTape(t, true);
  $("chart-empty").classList.remove("show");
  if (state.mode.type === "time") {
    chart.applyTrade(t, currentIntervalMs());
    renderHeader(chart.candles);
  } else {
    clearTimeout(tickRefresh);
    tickRefresh = setTimeout(() => loadCandles(state.tokenId).catch(() => {}), 800);
  }
}

// ---------- watchlist ----------
function visibleMarkets() {
  const q = state.filter.trim().toLowerCase();
  return q ? state.markets.filter((m) => m.question.toLowerCase().includes(q)) : state.markets;
}

function renderWatchlist() {
  const el = $("watchlist");
  const rows = visibleMarkets();
  // The catalogue refreshes on a timer and rebuilds these rows wholesale, which
  // would otherwise jump a scrolled watchlist back to the top every 30 seconds.
  const scroll = el.scrollTop;
  $("market-count").textContent = `${rows.length}`;
  if (!rows.length) {
    el.innerHTML = `<div class="wl-empty">No markets match “${esc(state.filter)}”.</div>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (m) =>
        `<div class="wl-row" data-market="${esc(m.market)}">` +
        `<div class="wl-row__q">${esc(m.question)}</div>` +
        `<div class="wl-row__px">${m.lastPrice != null ? cents(m.lastPrice) + "¢" : "—"}</div>` +
        `<div class="wl-row__meta">` +
        `<span class="venue-badge" data-v="${m.venue}">${VENUE_LABEL[m.venue] || m.venue}</span>` +
        `${m.volume24hr ? `<span>$${fmtSize(m.volume24hr)} 24h</span>` : ""}` +
        `</div></div>`,
    )
    .join("");
  el.querySelectorAll(".wl-row").forEach((row) => {
    row.addEventListener("click", () => {
      const m = state.markets.find((x) => x.market === row.dataset.market);
      if (m) selectMarket(m);
    });
    if (state.selected && row.dataset.market === state.selected.market) row.classList.add("is-active");
  });
  el.scrollTop = scroll;
}

async function loadMarkets(selectFirst) {
  const q = state.venue ? `&venue=${state.venue}` : "";
  state.markets = await api(`/api/markets?limit=150${q}`);
  renderWatchlist();
  if (selectFirst && state.markets.length) await selectMarket(state.markets[0]);
}

$("market-search").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderWatchlist();
});

$("venue-filter").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg__btn");
  if (!btn) return;
  $("venue-filter").querySelectorAll(".seg__btn").forEach((t) => t.classList.remove("is-active"));
  btn.classList.add("is-active");
  state.venue = btn.dataset.venue;
  loadMarkets(false).catch(() => {});
});

$("interval-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg__btn");
  if (!btn) return;
  $("interval-tabs").querySelectorAll(".seg__btn").forEach((t) => t.classList.remove("is-active"));
  btn.classList.add("is-active");
  const [type, n] = btn.dataset.mode.split(":");
  state.mode = type === "tick" ? { type: "tick", ticks: Number(n) } : { type: "time", interval: n };
  if (state.tokenId) loadCandles(state.tokenId).catch(() => {});
});

// ---------- view toggle ----------
$("nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav__tab");
  if (!btn) return;
  document.querySelectorAll(".nav__tab").forEach((t) => t.classList.remove("is-active"));
  btn.classList.add("is-active");
  const cross = btn.dataset.view === "cross";
  $("terminal-view").hidden = cross;
  $("crossvenue").hidden = !cross;
  if (cross) loadCrossVenue();
  else chart.fit();
});

async function loadCrossVenue() {
  const body = $("cv-body");
  const empty = $("cv-empty");
  try {
    const data = await api("/api/cross-venue?minConfidence=0.25&limit=60");
    $("cv-stats").innerHTML =
      `<b>${data.matches.length}</b> candidate matches<br>${data.polymarketMarkets} Polymarket · ${data.kalshiMarkets} Kalshi markets`;
    if (!data.matches.length) {
      body.innerHTML = "";
      empty.hidden = false;
      empty.classList.add("show");
      empty.textContent =
        "No cross-venue candidates right now — the two venues aren't listing overlapping questions at the moment. As shared markets (Fed decisions, crypto, elections) trade on both, they'll appear here automatically.";
      return;
    }
    empty.hidden = true;
    empty.classList.remove("show");
    body.innerHTML = data.matches.map(renderMatchRow).join("");
  } catch {
    empty.hidden = false;
    empty.classList.add("show");
    empty.textContent = "Couldn't load cross-venue matches.";
  }
}

const ARB_DIR = { "buy-yes-polymarket": "Buy YES · Polymarket", "buy-yes-kalshi": "Buy YES · Kalshi" };
const confClass = (c) => (c >= 0.6 ? "cv-conf--hi" : c >= 0.4 ? "cv-conf--mid" : "");

function priceCell(side) {
  const px = side.yes != null ? cents(side.yes) + "¢" : "—";
  return `<div class="cv-venue-cell"><span class="px">${px}</span><span class="q">${esc(side.question)}</span></div>`;
}

function renderMatchRow(m) {
  const hasArb = m.arbDirection && m.arbDirection !== "none";
  const spread = m.spread == null ? "—" : `${m.spread >= 0 ? "+" : ""}${(m.spread * 100).toFixed(1)}¢`;
  const spreadCls = m.spread == null ? "muted" : m.spread >= 0 ? "pos" : "neg";
  const conf = Math.round(m.confidence * 100);
  return (
    `<tr class="${hasArb ? "has-arb" : ""}">` +
    `<td><div class="cv-match__q">${esc(m.label)}</div><div class="cv-match__meta">` +
    `<span class="cv-conf ${confClass(m.confidence)}"><span class="cv-conf__bar"><span class="cv-conf__fill" style="width:${conf}%"></span></span>${conf}%</span>` +
    `<span class="cv-tokens">${esc(m.sharedTokens.slice(0, 5).join(" · "))}</span>` +
    `</div></td>` +
    `<td>${priceCell(m.polymarket)}</td>` +
    `<td>${priceCell(m.kalshi)}</td>` +
    `<td class="cv-num ${spreadCls}">${spread}</td>` +
    `<td class="cv-num">${m.consensus == null ? "—" : cents(m.consensus) + "¢"}</td>` +
    `<td class="cv-num">${
      hasArb
        ? `<span class="cv-arb__edge">${(m.arbEdge * 100).toFixed(1)}¢</span><span class="cv-arb__dir">${ARB_DIR[m.arbDirection] || ""}</span>`
        : `<span class="cv-arb--none">—</span>`
    }</td></tr>`
  );
}

// ---------- boot ----------
async function refreshStats() {
  try {
    const s = await api("/api/stats");
    $("status-archive").innerHTML = `<b>${s.ticks.toLocaleString()}</b> ticks · ${s.diskMB} MB`;
  } catch {
    /* stats are informational only */
  }
}

async function boot() {
  renderIndicatorMenu();
  connectWs();
  try {
    await loadMarkets(true);
  } catch {
    setConn("down", "api error");
  }
  refreshStats();
  setInterval(refreshStats, 30_000);
  // Kalshi's catalogue fills in as markets trade; refresh without disturbing the
  // current selection.
  setInterval(() => loadMarkets(false).catch(() => {}), 30_000);
}

boot();
