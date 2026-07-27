// The price chart.
//
// Rendering is TradingView's own lightweight-charts, which is where the things
// the hand-rolled canvas could never afford come from: a real time axis, pan and
// zoom, a crosshair, and stacked panes. What lives here is everything specific
// to Sharpline — the panes we want, the indicator wiring, prices that read as
// cents, and paging older history in as the user scrolls left.

import { bollinger, ema, macd, rsi, sma, vwap } from "./indicators.js";

const LC = window.LightweightCharts;

/** Prices are probabilities 0..1 but every trader reads them as cents. */
const asCents = (p) => (p * 100).toFixed(1) + "¢";

/** Candle timestamps arrive as epoch ms; the chart's time axis wants seconds. */
const toSec = (ms) => Math.floor(ms / 1000);

/**
 * Indicators the user can toggle. `pane` 0 draws over price; anything else gets
 * its own stacked pane underneath.
 */
export const INDICATORS = [
  { id: "sma20", label: "SMA 20", pane: 0 },
  { id: "sma50", label: "SMA 50", pane: 0 },
  { id: "ema9", label: "EMA 9", pane: 0 },
  { id: "vwap", label: "VWAP", pane: 0 },
  { id: "bb", label: "Bollinger", pane: 0 },
  { id: "rsi", label: "RSI 14", pane: 2 },
  { id: "macd", label: "MACD", pane: 2 },
];

export class PriceChart {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {() => void} opts.onNeedHistory Called when the view nears the left
   *   edge of loaded data, so the caller can page older candles in.
   * @param {(bar: object|null) => void} opts.onHover Crosshair readout.
   */
  constructor(container, { onNeedHistory, onHover } = {}) {
    this.container = container;
    this.onNeedHistory = onNeedHistory ?? (() => {});
    this.onHover = onHover ?? (() => {});
    this.candles = [];
    this.overlays = new Map(); // indicator id -> ISeriesApi[]
    this.enabled = new Set(["sma20"]);
    this.hasMore = true;
    this.loading = false;
    this.compare = null; // second venue's line series, when comparing

    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    this.theme = {
      up: css("--up") || "#26a69a",
      down: css("--down") || "#ef5350",
      ink: css("--ink") || "#e6e9ef",
      inkFaint: css("--ink-faint") || "#5a616e",
      hair: css("--hair") || "#21252d",
      bg: css("--bg") || "#0a0b0d",
      accent: css("--accent") || "#f0b429",
    };

    this.chart = LC.createChart(container, {
      autoSize: true,
      layout: {
        background: { type: LC.ColorType.Solid, color: "transparent" },
        textColor: this.theme.inkFaint,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
        fontSize: 11,
        panes: { separatorColor: this.theme.hair, separatorHoverColor: this.theme.accent },
      },
      grid: {
        vertLines: { color: this.theme.hair, style: LC.LineStyle.Solid },
        horzLines: { color: this.theme.hair, style: LC.LineStyle.Solid },
      },
      crosshair: {
        mode: LC.CrosshairMode.Normal,
        vertLine: { color: this.theme.inkFaint, width: 1, style: LC.LineStyle.Dashed, labelBackgroundColor: this.theme.accent },
        horzLine: { color: this.theme.inkFaint, width: 1, style: LC.LineStyle.Dashed, labelBackgroundColor: this.theme.accent },
      },
      rightPriceScale: { borderColor: this.theme.hair, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: {
        borderColor: this.theme.hair,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 8,
      },
    });

    this.priceSeries = this.chart.addSeries(
      LC.CandlestickSeries,
      {
        upColor: this.theme.up,
        downColor: this.theme.down,
        borderUpColor: this.theme.up,
        borderDownColor: this.theme.down,
        wickUpColor: this.theme.up,
        wickDownColor: this.theme.down,
        priceFormat: { type: "custom", formatter: asCents, minMove: 0.001 },
      },
      0,
    );

    // Volume gets its own pane rather than floating inside the price plot, so it
    // can't visually collide with the candles it belongs to.
    this.volumeSeries = this.chart.addSeries(
      LC.HistogramSeries,
      { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false },
      1,
    );

    this.#layoutPanes();
    this.#wireHistoryPaging();
    this.#wireCrosshair();
  }

  /**
   * Price gets the room; the lower panes are readouts, not the subject.
   *
   * Sized by relative stretch factor rather than pixels, and set on *every*
   * pane. Assigning an absolute height to one pane leaves the others on their
   * default factor of 1, which lets a 20%-tall volume strip claim most of the
   * chart and squeeze price down to a few unusable pixels.
   */
  #layoutPanes() {
    const WEIGHTS = [100, 18, 26]; // price, volume, oscillator
    this.chart.panes().forEach((pane, i) => pane.setStretchFactor(WEIGHTS[i] ?? 20));
  }

  #wireHistoryPaging() {
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || this.loading || !this.hasMore) return;
      const bars = this.priceSeries.barsInLogicalRange(range);
      // Ask early enough that the fetch lands before the user reaches the edge.
      if (bars && bars.barsBefore !== null && bars.barsBefore < 24) {
        this.loading = true;
        this.onNeedHistory();
      }
    });
  }

  #wireCrosshair() {
    this.chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) return this.onHover(null);
      const bar = this.candles.find((c) => c.time === param.time);
      this.onHover(bar ?? null);
    });
  }

  /** Replace the whole series (new market, or new interval). */
  setCandles(candles, { hasMore = true } = {}) {
    this.candles = normalise(candles);
    this.hasMore = hasMore;
    this.loading = false;
    this.priceSeries.setData(this.candles);
    this.volumeSeries.setData(this.candles.map((c) => volumeBar(c, this.theme)));
    this.#redrawIndicators();
    this.chart.timeScale().fitContent();
  }

  /**
   * Splice an older page onto the front, holding the viewport still.
   *
   * setData resets the visible range, which during a scroll-back would yank the
   * chart out from under the user, so the range is captured and restored across
   * the swap — shifted by however many bars were added.
   */
  prependCandles(older, { hasMore = true } = {}) {
    this.loading = false;
    this.hasMore = hasMore;
    if (!older.length) return;

    const ts = this.chart.timeScale();
    const before = ts.getVisibleLogicalRange();
    const known = new Set(this.candles.map((c) => c.time));
    const fresh = normalise(older).filter((c) => !known.has(c.time));
    if (!fresh.length) return;

    this.candles = fresh.concat(this.candles);
    this.priceSeries.setData(this.candles);
    this.volumeSeries.setData(this.candles.map((c) => volumeBar(c, this.theme)));
    this.#redrawIndicators();

    if (before) {
      ts.setVisibleLogicalRange({ from: before.from + fresh.length, to: before.to + fresh.length });
    }
  }

  /** Fold one live trade into the newest candle, opening a new one if needed. */
  applyTrade(trade, intervalMs) {
    if (!this.candles.length) return;
    const bucket = toSec(Math.floor(trade.ts / intervalMs) * intervalMs);
    const last = this.candles[this.candles.length - 1];

    if (bucket > last.time) {
      const bar = {
        time: bucket,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.size,
        buyVolume: trade.side === "BUY" ? trade.size : 0,
        sellVolume: trade.side === "BUY" ? 0 : trade.size,
      };
      this.candles.push(bar);
      this.priceSeries.update(bar);
      this.volumeSeries.update(volumeBar(bar, this.theme));
    } else if (bucket === last.time) {
      last.high = Math.max(last.high, trade.price);
      last.low = Math.min(last.low, trade.price);
      last.close = trade.price;
      last.volume += trade.size;
      if (trade.side === "BUY") last.buyVolume += trade.size;
      else last.sellVolume += trade.size;
      this.priceSeries.update(last);
      this.volumeSeries.update(volumeBar(last, this.theme));
    } else {
      return; // late print older than the newest bar; the archive still has it
    }
    this.#redrawIndicators();
  }

  toggleIndicator(id) {
    if (this.enabled.has(id)) this.enabled.delete(id);
    else this.enabled.add(id);
    this.#redrawIndicators();
    return this.enabled.has(id);
  }

  isEnabled(id) {
    return this.enabled.has(id);
  }

  /** Overlay a second venue's closes for divergence spotting. */
  setCompare(candles, color) {
    this.clearCompare();
    if (!candles || !candles.length) return;
    this.compare = this.chart.addSeries(
      LC.LineSeries,
      { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: { type: "custom", formatter: asCents, minMove: 0.001 } },
      0,
    );
    this.compare.setData(normalise(candles).map((c) => ({ time: c.time, value: c.close })));
  }

  clearCompare() {
    if (this.compare) {
      this.chart.removeSeries(this.compare);
      this.compare = null;
    }
  }

  /**
   * Rebuild every enabled indicator.
   *
   * Series are torn down and recreated rather than diffed: indicator output is
   * cheap to recompute and the alternative is tracking per-series state that
   * silently drifts out of sync with the candles it claims to describe.
   */
  #redrawIndicators() {
    for (const series of this.overlays.values()) {
      for (const s of series) this.chart.removeSeries(s);
    }
    this.overlays.clear();
    if (!this.candles.length) return;

    const line = (data, color, opts = {}, pane = 0) => {
      const s = this.chart.addSeries(
        LC.LineSeries,
        {
          color,
          lineWidth: 1.5,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          ...opts,
        },
        pane,
      );
      s.setData(data);
      return s;
    };

    const add = (id, series) => this.overlays.set(id, series);

    if (this.enabled.has("sma20")) add("sma20", [line(sma(this.candles, 20), "#5b8dd6")]);
    if (this.enabled.has("sma50")) add("sma50", [line(sma(this.candles, 50), "#b07fd4")]);
    if (this.enabled.has("ema9")) add("ema9", [line(ema(this.candles, 9), this.theme.accent)]);
    if (this.enabled.has("vwap")) {
      add("vwap", [line(vwap(this.candles), "#e07b53", { lineStyle: LC.LineStyle.Dashed })]);
    }
    if (this.enabled.has("bb")) {
      const b = bollinger(this.candles, 20, 2);
      const faint = "#4a5568";
      add("bb", [
        line(b.upper, faint, { lineWidth: 1 }),
        line(b.middle, faint, { lineWidth: 1, lineStyle: LC.LineStyle.Dotted }),
        line(b.lower, faint, { lineWidth: 1 }),
      ]);
    }

    // Lower-pane oscillators. Only one occupies pane 2 at a time — stacking both
    // would squeeze price into a strip.
    if (this.enabled.has("rsi")) {
      const s = line(rsi(this.candles, 14), "#c9a227", {}, 2);
      s.createPriceLine({ price: 70, color: this.theme.hair, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
      s.createPriceLine({ price: 30, color: this.theme.hair, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
      add("rsi", [s]);
    } else if (this.enabled.has("macd")) {
      const m = macd(this.candles);
      const hist = this.chart.addSeries(
        LC.HistogramSeries,
        { priceLineVisible: false, lastValueVisible: false },
        2,
      );
      hist.setData(m.histogram.map((p) => ({ time: p.time, value: p.value, color: p.value >= 0 ? this.theme.up : this.theme.down })));
      add("macd", [hist, line(m.macd, "#5b8dd6", {}, 2), line(m.signal, this.theme.accent, {}, 2)]);
    }

    this.#layoutPanes();
  }

  fit() {
    this.chart.timeScale().fitContent();
  }

  destroy() {
    this.chart.remove();
  }
}

/** Colour volume by which side did the lifting, not by the price change. */
function volumeBar(c, theme) {
  const buyLed = (c.buyVolume ?? 0) >= (c.sellVolume ?? 0);
  return { time: c.time, value: c.volume, color: (buyLed ? theme.up : theme.down) + "66" };
}

/**
 * Put candles in the shape the chart requires: seconds, strictly ascending, no
 * duplicate timestamps.
 *
 * Tick candles are the reason the de-duplication exists — N-trades-per-bar can
 * close several bars inside one second, and a repeated timestamp is rejected
 * outright. Nudging each collision forward a second keeps the bars in order and
 * distorts only the axis label, not the prices.
 */
function normalise(candles) {
  const out = [];
  let prev = -Infinity;
  for (const c of candles) {
    let t = toSec(c.start ?? c.time * 1000);
    if (t <= prev) t = prev + 1;
    prev = t;
    out.push({
      time: t,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
      buyVolume: c.buyVolume ?? 0,
      sellVolume: c.sellVolume ?? 0,
      trades: c.trades ?? 0,
    });
  }
  return out;
}
