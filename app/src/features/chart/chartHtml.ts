// app/src/features/chart/chartHtml.ts
//
// The WebView page behind `TradingChart`: lightweight-charts (inlined by
// scripts/gen-lwc.ts, no network) plus a small bridge. React Native sends
// JSON messages through `window.__dexxer(msg)` (`injectJavaScript`):
//
//   { type: 'render', series, ema, lines, scale, resetView }  full redraw (empty series = clear)
//   { type: 'tick', point, emaPoint }                          last bar only
//   { type: 'zoom', dir: 1 | -1 | 0 }                          in / out / reset
//
// and the page answers `{ type: 'ready' }` once the chart exists, and
// `{ type: 'error', message }` if handling a message throws. The page
// owns only what must follow the finger — the OHLC row under the crosshair
// and the High/Low of the visible range; everything else (series data per
// chart type, EMA, the live mark folded in) arrives computed from
// `chartData.ts` — on `1s` it may carry whitespace items ({ time } only). Colors come in from the design tokens (`ChartColors`);
// nothing here hard-codes a palette.
import { LWC_SOURCE } from './lwcSource.generated'

export interface ChartColors {
  bg: string
  text: string
  textDim: string
  grid: string
  border: string
  up: string
  down: string
  accent: string
  accentSubtle: string
  warning: string
}

// The bridge, as page JS (ES2017 — Android System WebView). Kept in one
// string so the page is a single self-contained document.
const BRIDGE = String.raw`
(function () {
  var C = window.__COLORS;
  var L = LightweightCharts;
  var el = document.getElementById('chart');
  var ohlcEl = document.getElementById('ohlc');
  var chart = L.createChart(el, {
    autoSize: true,
    // Apache-2.0 NOTICE of lightweight-charts: the TradingView attribution must stay visible. The link opens in the system browser (TradingChart's onShouldStartLoadWithRequest).
    layout: { background: { type: 'solid', color: C.bg }, textColor: C.textDim, fontFamily: 'monospace', fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.border },
    timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 6, minBarSpacing: 0.5 },
    crosshair: { mode: 0 },
    // Horizontal pan / pinch stay on the chart; a vertical drag scrolls the screen.
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    localization: {
      timeFormatter: function (t) {
        var d = new Date(t * 1000);
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      },
    },
  });
  chart.timeScale().applyOptions({
    tickMarkFormatter: function (t, kind) {
      var d = new Date(t * 1000);
      return kind < 3 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },
  });

  var series = [];     // everything drawn for the current chart type
  var main = null;     // the series the price lines and High/Low attach to
  var emaSeries = null;
  var kind = null;
  var chartType = null;
  var bars = [];       // current points, for the OHLC row and High/Low
  var hlLines = [];
  var extraLines = [];

  // The view opens on the latest DEFAULT_SPACING-px bars, not every bar:
  // fitContent squeezed 300 candles into ~1 px each, so a short swipe
  // scrolled the whole history away.
  var DEFAULT_SPACING = 6, MIN_SPACING = 0.5, MAX_SPACING = 40, ZOOM_STEP = 1.5;
  function resetView() {
    chart.timeScale().applyOptions({ barSpacing: DEFAULT_SPACING });
    chart.timeScale().scrollToRealTime();
  }
  function zoom(dir) {
    if (dir === 0) { resetView(); return; }
    var cur = chart.timeScale().options().barSpacing;
    var next = Math.min(MAX_SPACING, Math.max(MIN_SPACING, dir > 0 ? cur * ZOOM_STEP : cur / ZOOM_STEP));
    chart.timeScale().applyOptions({ barSpacing: next });
  }

  function fmt(v) { return v == null || isNaN(v) ? '—' : v.toFixed(2); }

  function clear() {
    series.forEach(function (s) { chart.removeSeries(s); });
    if (emaSeries) chart.removeSeries(emaSeries);
    series = []; main = null; emaSeries = null; hlLines = []; extraLines = [];
  }

  function build(type) {
    var up = C.up, down = C.down;
    if (type === 'bars') {
      main = chart.addSeries(L.BarSeries, { upColor: up, downColor: down, thinBars: false });
      series = [main];
    } else if (type === 'candles' || type === 'heikinAshi') {
      main = chart.addSeries(L.CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down });
      series = [main];
    } else if (type === 'hollow') {
      main = chart.addSeries(L.CandlestickSeries, { upColor: 'rgba(0,0,0,0)', downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
      series = [main];
    } else if (type === 'highLow') {
      main = chart.addSeries(L.CandlestickSeries, { upColor: C.accentSubtle, downColor: C.accentSubtle, borderUpColor: C.accent, borderDownColor: C.accent, wickVisible: false });
      series = [main];
    } else if (type === 'line' || type === 'lineMarkers' || type === 'step') {
      main = chart.addSeries(L.LineSeries, { color: C.accent, lineWidth: 2, pointMarkersVisible: type === 'lineMarkers', lineType: type === 'step' ? 1 : 0 });
      series = [main];
    } else if (type === 'area') {
      main = chart.addSeries(L.AreaSeries, { lineColor: C.accent, topColor: C.accentSubtle, bottomColor: 'rgba(0,0,0,0)', lineWidth: 2 });
      series = [main];
    } else if (type === 'baseline') {
      main = chart.addSeries(L.BaselineSeries, { topLineColor: up, bottomLineColor: down, topFillColor1: 'rgba(0,0,0,0)', topFillColor2: 'rgba(0,0,0,0)', bottomFillColor1: 'rgba(0,0,0,0)', bottomFillColor2: 'rgba(0,0,0,0)', lineWidth: 2 });
      series = [main];
    } else if (type === 'columns') {
      main = chart.addSeries(L.HistogramSeries, { color: C.accent });
      series = [main];
    } else if (type === 'hlcArea') {
      // Band between high and low: an area down from the highs, then an
      // area in the background colour down from the lows erasing below it.
      var hi = chart.addSeries(L.AreaSeries, { lineColor: up, topColor: C.accentSubtle, bottomColor: C.accentSubtle, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      var lo = chart.addSeries(L.AreaSeries, { lineColor: down, topColor: C.bg, bottomColor: C.bg, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      main = chart.addSeries(L.LineSeries, { color: C.text, lineWidth: 2 });
      series = [hi, lo, main];
    }
    main.applyOptions({ priceLineColor: C.accent, title: 'Mark' });
  }

  // Series data may carry whitespace items ({ time } only, on 1s): they keep
  // the time axis uniform and are never drawn, read or counted as bars.
  function real(p) { return p.value != null || p.close != null || p.high != null; }
  function setData(s) {
    kind = s.kind;
    // An empty series (a market or timeframe with nothing to draw yet) clears
    // the chart, so the previous one never stays on screen under it; the
    // columns base and the baseline below need at least one real point.
    if (!s.data.length) {
      series.forEach(function (x) { x.setData([]); });
      bars = [];
      return;
    }
    if (s.kind === 'hlc') {
      series[0].setData(s.data.map(function (p) { return real(p) ? { time: p.time, value: p.high } : { time: p.time }; }));
      series[1].setData(s.data.map(function (p) { return real(p) ? { time: p.time, value: p.low } : { time: p.time }; }));
      series[2].setData(s.data.map(function (p) { return real(p) ? { time: p.time, value: p.close } : { time: p.time }; }));
    } else if (chartType === 'columns') {
      // Columns rise from just under the lowest close, not from 0 — from 0
      // the price scale spans 0…max and every column looks the same height.
      var vals = s.data.filter(real).map(function (p) { return p.value; });
      if (vals.length) {
        var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
        main.applyOptions({ base: lo - (hi - lo) * 0.1 });
      }
      var prevVal = null;
      main.setData(s.data.map(function (p) {
        if (!real(p)) return { time: p.time };
        var color = prevVal == null || p.value >= prevVal ? C.up : C.down;
        prevVal = p.value;
        return { time: p.time, value: p.value, color: color };
      }));
    } else {
      main.setData(s.data);
    }
    var firstReal = s.data.filter(real)[0];
    if (chartType === 'baseline' && firstReal) main.applyOptions({ baseValue: { type: 'price', price: firstReal.value } });
    bars = s.data.filter(real);
  }

  function updatePoint(p) {
    if (!p) return;
    if (kind === 'hlc') {
      series[0].update({ time: p.time, value: p.high });
      series[1].update({ time: p.time, value: p.low });
      series[2].update({ time: p.time, value: p.close });
    } else if (chartType === 'columns') {
      var prev = bars.length > 1 ? bars[bars.length - 2].value : p.value;
      main.update({ time: p.time, value: p.value, color: p.value >= prev ? C.up : C.down });
    } else {
      main.update(p);
    }
    if (bars.length && bars[bars.length - 1].time === p.time) bars[bars.length - 1] = p; else bars.push(p);
  }

  function close(p) { return p.close != null ? p.close : p.value; }

  function showOhlc(p) {
    if (!p) { ohlcEl.textContent = ''; return; }
    if (p.open != null) {
      var up = p.close >= p.open;
      ohlcEl.innerHTML = 'O <b>' + fmt(p.open) + '</b> H <b>' + fmt(p.high) + '</b> L <b>' + fmt(p.low) + '</b> C <b style="color:' + (up ? C.up : C.down) + '">' + fmt(p.close) + '</b>';
    } else if (p.high != null) {
      ohlcEl.innerHTML = 'H <b>' + fmt(p.high) + '</b> L <b>' + fmt(p.low) + '</b> C <b>' + fmt(p.close) + '</b>';
    } else {
      ohlcEl.innerHTML = 'C <b>' + fmt(p.value) + '</b>';
    }
  }

  // High / Low of what is on screen, as axis labels.
  function refreshHighLow() {
    hlLines.forEach(function (l) { main.removePriceLine(l); });
    hlLines = [];
    // By time, not index: logical indices count whitespace slots, bars does not.
    var r = chart.timeScale().getVisibleRange();
    if (!r || !bars.length) return;
    var hi = -Infinity, lo = Infinity;
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      if (b.time < r.from || b.time > r.to) continue;
      var h = b.high != null ? b.high : b.value, l = b.low != null ? b.low : b.value;
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    if (!isFinite(hi)) return;
    hlLines.push(main.createPriceLine({ price: hi, color: C.textDim, lineVisible: false, axisLabelVisible: true, title: 'H' }));
    hlLines.push(main.createPriceLine({ price: lo, color: C.textDim, lineVisible: false, axisLabelVisible: true, title: 'L' }));
  }

  function setLines(lines) {
    extraLines.forEach(function (l) { main.removePriceLine(l); });
    extraLines = [];
    if (lines.entry != null) extraLines.push(main.createPriceLine({ price: lines.entry, color: C.accent, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'Entry' }));
    if (lines.liq != null) extraLines.push(main.createPriceLine({ price: lines.liq, color: C.warning, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'Liq.' }));
  }

  function setEma(points) {
    if (!points) { if (emaSeries) { chart.removeSeries(emaSeries); emaSeries = null; } return; }
    if (!emaSeries) emaSeries = chart.addSeries(L.LineSeries, { color: C.warning, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    emaSeries.setData(points);
  }

  chart.subscribeCrosshairMove(function (param) {
    var p = param && param.time != null && main ? param.seriesData.get(main) : null;
    if (p && kind === 'hlc') {
      var b = null;
      for (var i = bars.length - 1; i >= 0; i--) if (bars[i].time === param.time) { b = bars[i]; break; }
      p = b;
    }
    showOhlc(p || bars[bars.length - 1]);
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange(refreshHighLow);

  function post(m) { window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
  function handle(msg) {
    if (msg.type === 'render') {
      if (msg.chartType !== chartType || !main) { clear(); chartType = msg.chartType; build(chartType); }
      setData(msg.series);
      setEma(msg.ema);
      setLines(msg.lines || {});
      chart.priceScale('right').applyOptions({ mode: msg.scale === 'log' ? 1 : 0 });
      if (msg.resetView) resetView();
      refreshHighLow();
      showOhlc(bars[bars.length - 1]);
    } else if (msg.type === 'tick' && main) {
      updatePoint(msg.point);
      if (msg.emaPoint && emaSeries) emaSeries.update(msg.emaPoint);
      showOhlc(bars[bars.length - 1]);
    } else if (msg.type === 'zoom') {
      zoom(msg.dir);
    }
  }
  // A throw in here would otherwise die silently in the page's console.
  window.__dexxer = function (msg) {
    try { handle(msg); } catch (e) { post({ type: 'error', message: String(e && e.stack || e) }); }
  };
  post({ type: 'ready' });
})();
`

export function chartHtml(colors: ChartColors): string {
  // `</script>` cannot appear inside an inline script; the minified build
  // has none today, but escaping keeps a future version from breaking out.
  const lib = LWC_SOURCE.replace(/<\/script/gi, '<\\/script')
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: ${colors.bg}; overflow: hidden; -webkit-user-select: none; user-select: none; }
  #chart { position: absolute; inset: 0; }
  #ohlc { position: absolute; left: 4px; top: 2px; z-index: 3; font: 11px monospace; color: ${colors.textDim}; pointer-events: none; }
  #ohlc b { color: ${colors.text}; font-weight: 500; }
</style></head>
<body><div id="chart"></div><div id="ohlc"></div>
<script>${lib}</script>
<script>window.__COLORS = ${JSON.stringify(colors)};</script>
<script>${BRIDGE}</script>
</body></html>`
}
