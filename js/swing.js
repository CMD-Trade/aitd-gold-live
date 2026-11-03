/* Swing Finder (RSI) — client-side port of the TradingView "RSI Swing" state machine
   used by Aomsin Investor (RSI 7, overbought 70, oversold 30).
   The block order matches the original script and must stay in this order:
     1. laststate==2 and RSI>=70 → start a new swing high (label + line from the last low)
     2. laststate==1 and RSI<=30 → start a new swing low (label + line from the last high)
     3. while RSI>=70, a high >= hh moves that swing high and sets laststate=1
     4. while RSI<=30, a low <= ll moves that swing low and sets laststate=2
     5–6. the original's redundant in-zone trailing blocks
     7. while laststate==1, ANY later bar with high>=hh moves the swing high
     8. while laststate==2, ANY later bar with low<=ll moves the swing low
   The active swing (the last one) keeps moving until RSI crosses to the other side.
   It is drawn hollow; every earlier swing is confirmed. Not a buy/sell signal. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AITD_SWING = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ta.rsi: Wilder RMA. First value is the SMA of the first `length` close-to-close
     changes (bar index `length`), then avg = (prev*(length-1) + current) / length. */
  function rsiWilder(closes, length) {
    const n = closes.length, out = new Array(n).fill(null);
    if (n <= length) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= length; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch > 0) gain += ch; else if (ch < 0) loss -= ch;
    }
    let avgG = gain / length, avgL = loss / length;
    const at = (g, l) => (l === 0 ? 100 : g === 0 ? 0 : 100 - 100 / (1 + g / l));
    out[length] = at(avgG, avgL);
    for (let i = length + 1; i < n; i++) {
      const ch = closes[i] - closes[i - 1];
      const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      avgG = (avgG * (length - 1) + g) / length;
      avgL = (avgL * (length - 1) + l) / length;
      out[i] = at(avgG, avgL);
    }
    return out;
  }

  /* bars: [{time, open, high, low, close}] in chart price, oldest first.
     rsiArr: optional precomputed series (tests). null = not yet valid, same as ta.rsi. */
  function swingFinderRSI(bars, rsiArr, ob, os) {
    const n = bars ? bars.length : 0;
    const OB = ob == null ? 70 : ob, OS = os == null ? 30 : os;
    const rsi = rsiArr || rsiWilder(bars.map(b => b.close), 7);
    const swings = [];
    if (!n) return { swings, rsi, laststate: 0 };
    let laststate = 0;
    let hh = bars[0].low, hhBar = 0;
    let ll = bars[0].high, llBar = 0;
    let haveH = false, haveL = false;

    const put = (side, i, price) => {
      const s = swings[swings.length - 1];
      if (s && s.side === side) { s.price = price; s.i = i; s.time = bars[i].time; return; }
      swings.push({ side, price, i, time: bars[i].time });
    };
    /* Move the active label. The first time that side exists and it is not already
       the label we just started on this bar, this creates it (state 0 → 1 / 0 → 2). */
    const moveH = (i) => { hh = bars[i].high; hhBar = i; haveH = true; put('H', i, hh); };
    const moveL = (i) => { ll = bars[i].low; llBar = i; haveL = true; put('L', i, ll); };

    for (let i = 0; i < n; i++) {
      const r = rsi[i];
      const isOB = r != null && r >= OB;
      const isOS = r != null && r <= OS;
      const high = bars[i].high, low = bars[i].low;

      if (laststate === 2 && isOB) {                 // start a new swing high
        hh = high; hhBar = i; haveH = true;
        swings.push({ side: 'H', price: high, i, time: bars[i].time });
      }
      if (laststate === 1 && isOS) {                 // start a new swing low
        ll = low; llBar = i; haveL = true;
        swings.push({ side: 'L', price: low, i, time: bars[i].time });
      }
      if (isOB && high >= hh) { moveH(i); laststate = 1; }
      if (isOS && low <= ll) { moveL(i); laststate = 2; }
      if (laststate === 1 && isOB && high >= hh) moveH(i);
      if (laststate === 2 && isOS && low <= ll) moveL(i);
      if (laststate === 1 && high >= hh) moveH(i);   // trailing: any later higher high
      if (laststate === 2 && low <= ll) moveL(i);    // trailing: any later lower low
    }
    return { swings, rsi, laststate, hh, hhBar, ll, llBar, haveH, haveL };
  }

  function structureOf(swings) {
    const conf = swings.length ? swings.slice(0, -1) : [];
    const hs = conf.filter(s => s.side === 'H'), ls = conf.filter(s => s.side === 'L');
    const out = {
      high: hs.length ? hs[hs.length - 1].price : null,
      low: ls.length ? ls[ls.length - 1].price : null,
      tag: 'ยังไม่พอ', cls: 'side',
    };
    if (hs.length >= 2 && ls.length >= 2) {
      const h2 = hs[hs.length - 1].price, h1 = hs[hs.length - 2].price;
      const l2 = ls[ls.length - 1].price, l1 = ls[ls.length - 2].price;
      const HH = h2 > h1, LH = h2 < h1, HL = l2 > l1, LL = l2 < l1;
      const th = HH ? 'HH' : LH ? 'LH' : 'EQ', tl = HL ? 'HL' : LL ? 'LL' : 'EQ';
      if (HH && HL) { out.tag = 'HH+HL ขึ้น'; out.cls = 'up'; }
      else if (LH && LL) { out.tag = 'LH+LL ลง'; out.cls = 'down'; }
      else { out.tag = th + '+' + tl + ' ไซด์เวย์'; out.cls = 'side'; }
    }
    return out;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* o: { lsKey, tgId, sumId, digits, LS, fmt, bars():chart-price bars, chart(), series(), timeShift, onChange } */
  function createSwingOverlay(o) {
    const $ = (id) => document.getElementById(id);
    const digits = o.digits == null ? 2 : o.digits;
    const SW = { on: o.LS.get(o.lsKey, true) !== false, res: null };
    const renderSum = () => {
      const el = $(o.sumId); if (!el) return;
      el.classList.toggle('hidden', !SW.on);
      if (!SW.on) return;
      const sw = SW.res && SW.res.swings || [];
      if (!sw.length) { el.textContent = 'ยังไม่มีจุด swing — รอ RSI ถึง 70 หรือ 30'; return; }
      const st = structureOf(sw);
      const f = (v) => o.fmt(v, digits);
      el.innerHTML = `สูงยืนยัน <b>${f(st.high)}</b> · ต่ำยืนยัน <b>${f(st.low)}</b> · โครงสร้าง <b class="tag ${st.cls}">${st.tag}</b>`;
    };
    SW.refresh = () => {
      if (!SW.on) { SW.res = null; renderSum(); return; }
      const bars = (o.bars && o.bars()) || [];
      SW.res = bars.length ? swingFinderRSI(bars) : { swings: [], rsi: [], laststate: 0 };
      renderSum();
    };
    SW.paint = (ctx) => {
      if (!SW.on || !SW.res || !SW.res.swings.length) return;
      const chart = o.chart(), series = o.series();
      if (!chart || !series || !ctx) return;
      const ts = chart.timeScale(), shift = o.timeShift || 0;
      const sw = SW.res.swings;
      const xy = (s) => {
        let x = null;
        if (typeof ts.logicalToCoordinate === 'function') x = ts.logicalToCoordinate(s.i);
        if (x == null && s.time != null) x = ts.timeToCoordinate(s.time + shift);
        const y = series.priceToCoordinate(s.price);
        return x == null || y == null ? null : { x, y };
      };
      const last = sw.length - 1;
      ctx.save();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (let k = 1; k < sw.length; k++) {
        const a = xy(sw[k - 1]), b = xy(sw[k]);
        if (!a || !b) continue;
        const live = k === last;
        ctx.beginPath();
        ctx.setLineDash(live ? [3, 3] : []);
        ctx.strokeStyle = live ? 'rgba(90,169,255,0.45)' : 'rgba(90,169,255,0.95)';
        ctx.lineWidth = 1;
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.setLineDash([]);
      sw.forEach((s, k) => {
        const p = xy(s); if (!p) return;
        const hollow = k === last, up = s.side === 'L';
        const color = up ? '#26a69a' : '#ef5350';
        const w = 16, h = 16, left = Math.round(p.x - w / 2), top = Math.round(up ? p.y + 5 : p.y - h - 5);
        ctx.globalAlpha = hollow ? 0.72 : 1;
        roundRect(ctx, left, top, w, h, 3);
        if (hollow) {
          ctx.fillStyle = 'rgba(13,16,22,0.45)'; ctx.fill();
          ctx.lineWidth = 1.25; ctx.strokeStyle = color; ctx.stroke();
          ctx.fillStyle = color;
        } else {
          ctx.fillStyle = color; ctx.fill();
          ctx.fillStyle = '#fff';
        }
        ctx.font = '700 12px "JetBrains Mono", ui-monospace, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(up ? '↑' : '↓', left + w / 2, top + h / 2 + 0.5);
        ctx.globalAlpha = 1;
      });
      ctx.restore();
    };
    SW.wire = () => {
      const el = $(o.tgId); if (!el) return;
      el.checked = !!SW.on;
      el.onchange = () => { SW.on = el.checked; o.LS.set(o.lsKey, SW.on); if (o.onChange) o.onChange(); };
    };
    SW.wire();
    return SW;
  }

  return { rsiWilder, swingFinderRSI, structureOf, createSwingOverlay };
});
