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

  /* Premium/Discount + 3-point Fibo 1.618 from a finished Swing Finder leg.
     Does not touch swing detection: `swings` is the array swingFinderRSI already returned.
     Confirmed swings are every point except the last (still forming). The leg is the most
     recent confirmed pair: A → B, low-to-high or high-to-low, whichever finished later.
     C is the forming swing after B, or the pullback extreme when that swing does not exist yet.
     Target = C + 1.618 × (B − A). 0 = range low, 1 = range high, 0.5 = equilibrium. */
  function dealingRange(swings, bars) {
    const conf = swings && swings.length ? swings.slice(0, -1) : [];
    if (conf.length < 2) return null;
    const B = conf[conf.length - 1];
    let A = null;
    for (let i = conf.length - 2; i >= 0; i--) if (conf[i].side !== B.side) { A = conf[i]; break; }
    if (!A || !(B.price > A.price || B.price < A.price)) return null;
    const last = swings[swings.length - 1];
    let C = null, cFrom = null;
    const afterB = last && last !== B && (
      (last.i != null && B.i != null && last.i > B.i) ||
      (last.time != null && B.time != null && last.time > B.time)
    );
    if (afterB && isFinite(last.price)) { C = last.price; cFrom = 'swing'; }
    else if (bars && bars.length) {
      let ext = B.side === 'H' ? Infinity : -Infinity, seen = false;
      for (const b of bars) {
        if (B.time != null && b.time < B.time) continue;
        seen = true;
        if (B.side === 'H') ext = Math.min(ext, b.low);
        else ext = Math.max(ext, b.high);
      }
      if (seen && isFinite(ext)) { C = ext; cFrom = 'extreme'; }
    }
    if (C == null || !isFinite(C)) return null;
    const lo = Math.min(A.price, B.price), hi = Math.max(A.price, B.price), span = hi - lo;
    if (!(span > 0)) return null;
    const delta = B.price - A.price;
    return {
      A: { side: A.side, price: A.price, time: A.time, i: A.i },
      B: { side: B.side, price: B.price, time: B.time, i: B.i },
      C, cFrom, lo, hi, eq: lo + span / 2, span, delta,
      tp: C + 1.618 * delta,
      ext1: C + delta,
      dir: B.side === 'H' ? 'up' : 'down',
    };
  }

  /* pct is the position of price inside the leg: 0 = range low, 100 = range high. */
  function zoneAt(dr, price) {
    if (!dr || price == null || !isFinite(price) || !(dr.span > 0)) return null;
    const pct = (price - dr.lo) / dr.span * 100;
    let name, where;
    if (pct > 100) { name = 'Premium'; where = 'above'; }
    else if (pct < 0) { name = 'Discount'; where = 'below'; }
    else if (pct >= 50) { name = 'Premium'; where = 'in'; }
    else { name = 'Discount'; where = 'in'; }
    return { pct, name, where };
  }

  function zonePhrase(dr, price, fmt, digits) {
    const z = zoneAt(dr, price);
    if (!z || !isFinite(dr.tp)) return '';
    const where = z.where === 'above' ? 'ราคาอยู่เหนือ Premium'
      : z.where === 'below' ? 'ราคาอยู่ใต้ Discount'
      : `ราคาอยู่โซน ${z.name} (${Math.round(z.pct)}%)`;
    return `${where} · เป้า 1.618: <b>${fmt(dr.tp, digits)}</b>`;
  }

  const PD_NOTE = 'Premium/Discount วัดจากสวิง H1 ล่าสุดที่ยืนยัน · Buy ในโซน Discount, Sell ในโซน Premium · 1.618 เป็นเป้าไกล ใช้เป็นแนวทาง ไม่ใช่สัญญาณ';

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

  /* o: { lsKey, tgId, sumId, digits, LS, fmt, bars():chart-price bars, chart(), series(), timeShift, onChange,
          pdKey, pdTgId, pdCv, wrapId, noteId, tf(), tfLabel(), price(), feedKey(), loadH1(), adjust(raw), aggregate(bars, tf) } */
  function createSwingOverlay(o) {
    const $ = (id) => document.getElementById(id);
    const digits = o.digits == null ? 2 : o.digits;
    const SW = { on: o.LS.get(o.lsKey, true) !== false, res: null,
      pdOn: o.pdKey ? o.LS.get(o.pdKey, true) !== false : false,
      pd: null, h1Raw: null, h1At: 0, h1Feed: '', h1Busy: false, h1Fail: false };
    const priceNow = () => {
      const p = o.price && o.price();
      if (p != null && isFinite(p)) return p;
      const bars = (o.bars && o.bars()) || [];
      return bars.length ? bars[bars.length - 1].close : null;
    };
    const ensureH1 = () => {
      if (!o.loadH1 || !SW.pdOn) return;
      const tf = o.tf ? o.tf() : '60';
      if (tf === '60') return;
      const feed = (o.feedKey && o.feedKey()) || '';
      if (!feed) return;
      if (SW.h1Busy) return;
      if (SW.h1Feed === feed && Date.now() - SW.h1At < 60000 && (SW.h1Raw || SW.h1Fail)) return;
      SW.h1Busy = true;
      const want = feed;
      Promise.resolve().then(() => o.loadH1()).then(raw => {
        SW.h1Busy = false;
        if (((o.feedKey && o.feedKey()) || '') !== want) return;
        SW.h1At = Date.now(); SW.h1Feed = want;
        if (raw && raw.length) { SW.h1Raw = raw; SW.h1Fail = false; }
        else SW.h1Fail = true;
      }).catch(() => { SW.h1Busy = false; SW.h1Fail = true; SW.h1At = Date.now(); SW.h1Feed = want; });
    };
    const pdBars = () => {
      const tf = o.tf ? o.tf() : '';
      const label = (o.tfLabel && o.tfLabel()) || tf || 'TF';
      if (tf === '60') return { bars: (o.bars && o.bars()) || [], tf: 'H1', source: 'chart' };
      if (SW.h1Raw && SW.h1Raw.length && o.adjust) return { bars: o.adjust(SW.h1Raw), tf: 'H1', source: 'feed' };
      const chartBars = (o.bars && o.bars()) || [];
      if (!SW.h1Raw && o.aggregate && ['1', '5', '15', '30'].includes(tf)) {
        const h1 = o.aggregate(chartBars, '60');
        if (h1 && h1.length >= 24) return { bars: h1, tf: 'H1', source: 'agg' };
      }
      return { bars: chartBars, tf: label, source: 'chart' };
    };
    const syncPd = () => {
      if (!SW.pdOn) { SW.pd = null; return; }
      ensureH1();
      const src = pdBars();
      const found = src.bars.length ? swingFinderRSI(src.bars) : { swings: [] };
      const dr = dealingRange(found.swings, src.bars);
      const px = priceNow();
      SW.pd = { tf: src.tf, source: src.source, dr, zone: dr ? zoneAt(dr, px) : null, price: px };
    };
    const renderSum = () => {
      const el = $(o.sumId); if (!el) return;
      el.classList.toggle('hidden', !SW.on && !SW.pdOn);
      const note = o.noteId ? $(o.noteId) : null;
      if (note) {
        note.classList.toggle('hidden', !SW.pdOn);
        const tf = (SW.pd && SW.pd.tf) || 'H1';
        note.textContent = tf === 'H1' ? PD_NOTE : PD_NOTE.replace('สวิง H1', 'สวิง ' + tf);
      }
      if (!SW.on && !SW.pdOn) return;
      const parts = [];
      if (SW.on) {
        const sw = SW.res && SW.res.swings || [];
        if (!sw.length) parts.push('ยังไม่มีจุด swing — รอ RSI ถึง 70 หรือ 30');
        else {
          const st = structureOf(sw);
          const f = (v) => o.fmt(v, digits);
          parts.push(`สูงยืนยัน <b>${f(st.high)}</b> · ต่ำยืนยัน <b>${f(st.low)}</b> · โครงสร้าง <b class="tag ${st.cls}">${st.tag}</b>`);
        }
      }
      if (SW.pdOn) {
        const pd = SW.pd;
        const phrase = pd && pd.dr ? zonePhrase(pd.dr, priceNow(), o.fmt, digits) : '';
        if (phrase) parts.push(phrase + (pd.tf && pd.tf !== 'H1' ? ` · ${pd.tf}` : ''));
        else parts.push('Premium/Discount: รอสวิง' + (pd && pd.tf ? ' ' + pd.tf : ' H1'));
      }
      el.innerHTML = parts.join(' · ');
    };
    SW.refresh = () => {
      if (!SW.on) SW.res = null;
      else {
        const bars = (o.bars && o.bars()) || [];
        SW.res = bars.length ? swingFinderRSI(bars) : { swings: [], rsi: [], laststate: 0 };
      }
      syncPd();
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
    const yPrice = (series, price) => {
      if (!series || price == null || !isFinite(price)) return null;
      const y = series.priceToCoordinate(price);
      return y == null ? null : y;
    };
    const xTime = (chart, time) => {
      if (!chart || time == null) return null;
      const x = chart.timeScale().timeToCoordinate(time + (o.timeShift || 0));
      return x == null ? null : x;
    };
    /* Shaded premium/discount halves, behind the candles (own canvas under the chart). */
    SW.paintBack = () => {
      const cv = o.pdCv ? $(o.pdCv) : null, wrap = o.wrapId ? $(o.wrapId) : null;
      if (!cv || !wrap) return;
      const dpr = window.devicePixelRatio || 1, W = wrap.clientWidth, H = wrap.clientHeight;
      if (!(W > 0 && H > 0)) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + 'px'; cv.style.height = H + 'px';
      }
      const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const dr = SW.pdOn && SW.pd && SW.pd.dr;
      const chart = o.chart(), series = o.series();
      if (!dr || !chart || !series) return;
      const paneW = chart.timeScale().width(), paneH = H - chart.timeScale().height();
      const yHi = yPrice(series, dr.hi), yLo = yPrice(series, dr.lo), yEq = yPrice(series, dr.eq);
      if (yHi == null || yLo == null) return;
      let x0 = xTime(chart, dr.A.time);
      if (x0 == null || x0 < 0) x0 = 0;
      const x1 = Math.max(x0, paneW);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, paneW, paneH); ctx.clip();
      const top = Math.min(yHi, yLo), bot = Math.max(yHi, yLo);
      const mid = yEq == null ? (top + bot) / 2 : yEq;
      ctx.fillStyle = 'rgba(239,83,80,0.22)'; ctx.fillRect(x0, top, x1 - x0, Math.max(1, mid - top));
      ctx.fillStyle = 'rgba(38,166,154,0.20)'; ctx.fillRect(x0, mid, x1 - x0, Math.max(1, bot - mid));
      ctx.restore();
    };
    /* Equilibrium, 0/0.5/1 prices, and the 1.618 / 1.0 targets. On the overlay so the text stays readable. */
    SW.paintMarks = (ctx, paneW, paneH) => {
      if (!SW.pdOn || !SW.pd || !SW.pd.dr || !ctx) return;
      const chart = o.chart(), series = o.series();
      if (!chart || !series) return;
      const dr = SW.pd.dr;
      const f = (v) => o.fmt(v, digits);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, paneW, paneH); ctx.clip();
      ctx.font = '600 11px "IBM Plex Sans Thai", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const hLine = (price, color, dash, label, faint) => {
        const y = yPrice(series, price); if (y == null || y < -20 || y > paneH + 20) return;
        ctx.save();
        ctx.globalAlpha = faint ? 0.45 : 1;
        ctx.beginPath(); ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.moveTo(0, y + 0.5); ctx.lineTo(paneW, y + 0.5); ctx.stroke();
        ctx.setLineDash([]);
        if (label) {
          ctx.font = '600 11px "IBM Plex Sans Thai", system-ui, sans-serif';
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = 'rgba(13,16,22,0.72)'; ctx.fillRect(6, y - 8, tw + 8, 16);
          ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(label, 10, y);
        }
        ctx.restore();
      };
      hLine(dr.hi, 'rgba(239,83,80,0.85)', [], `1  ${f(dr.hi)}`);
      hLine(dr.eq, 'rgba(240,180,41,0.9)', [5, 4], `Equilibrium 0.5  ${f(dr.eq)}`);
      hLine(dr.lo, 'rgba(38,166,154,0.85)', [], `0  ${f(dr.lo)}`);
      const near = (a, b) => Math.abs(a - b) <= dr.span * 0.02;
      if (![dr.lo, dr.hi, dr.eq, dr.tp].some(p => near(dr.ext1, p))) hLine(dr.ext1, 'rgba(243,210,122,0.55)', [2, 4], `1.0  ${f(dr.ext1)}`, true);
      hLine(dr.tp, '#f3d27a', [7, 4], `Fibo 1.618 TP  ${f(dr.tp)}`);
      const yHi = yPrice(series, dr.hi), yLo = yPrice(series, dr.lo), yEq = yPrice(series, dr.eq);
      if (yHi != null && yLo != null && yEq != null) {
        const tag = (text, y, color) => {
          if (y < 8 || y > paneH - 8) return;
          ctx.font = '600 12px "IBM Plex Sans Thai", system-ui, sans-serif';
          ctx.textAlign = 'center';
          const tw = ctx.measureText(text).width;
          const x = Math.max(80, Math.min(paneW - 80, paneW * 0.46));
          ctx.fillStyle = 'rgba(13,16,22,0.55)'; ctx.fillRect(x - tw / 2 - 6, y - 9, tw + 12, 18);
          ctx.fillStyle = color; ctx.fillText(text, x, y);
        };
        if (Math.abs(yEq - yHi) > 18) tag('Premium (แพง) – หา Sell', (yHi + yEq) / 2, 'rgba(255,138,135,0.95)');
        if (Math.abs(yLo - yEq) > 18) tag('Discount (ถูก) – หา Buy', (yEq + yLo) / 2, 'rgba(94,224,200,0.95)');
      }
      ctx.restore();
    };
    SW.wire = () => {
      const el = $(o.tgId); if (el) {
        el.checked = !!SW.on;
        el.onchange = () => { SW.on = el.checked; o.LS.set(o.lsKey, SW.on); if (o.onChange) o.onChange(); };
      }
      const pd = o.pdTgId ? $(o.pdTgId) : null;
      if (pd) {
        pd.checked = !!SW.pdOn;
        pd.onchange = () => { SW.pdOn = pd.checked; if (o.pdKey) o.LS.set(o.pdKey, SW.pdOn); if (o.onChange) o.onChange(); };
      }
    };
    SW.wire();
    return SW;
  }

  return { rsiWilder, swingFinderRSI, structureOf, dealingRange, zoneAt, zonePhrase, createSwingOverlay };
});
