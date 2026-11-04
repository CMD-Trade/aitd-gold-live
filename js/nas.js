/* AiTD Gold Live — NAS100 chart (same look/behaviour as the gold "กราฟ + โซน" chart). Client-only, no API keys.
   Primary feed : Hyperliquid trade.xyz XYZ100 (Nasdaq-100 perp, CORS *, no key, not blocked in Thailand) — candleSnapshot
                  history + WebSocket candle/activeAssetCtx. Checked 27–29 Oct 2026 against Dukascopy USA100 −5 (= Skilling US100 /
                  MT5): after the offset, M15 high/low within median 2–3 / p90 5–7 pts (OKX index 2.5–3 / 7–8; Bitget NDX100
                  index 4–7 / 35–44, its gap to Skilling swings +25…+100 within hours — the old fallback, which made candles wrong).
                  Live offset: XYZ100 mid − oracle (live premium, ~3 pts) + oracle − Skilling (5.5, measured), so it follows the
                  perp's premium instead of a fixed number.
   Second       : OKX index US100-USDT (CORS ok, no key) — REST history-index-candles + WebSocket index-tickers.
                  Checked 28 Oct 2026: tracks CFD NAS100 quotes (Capital.com/Pepperstone/FOREX.com) within ~5-10 pts and
                  closed within ~5 pts of the ^NDX cash close at 16:00 NY. OANDA:NAS100USD ran ~20 pts higher.
   Fallbacks    : Bitget NDX100USDT index (CORS *, ~10-25 pts above OKX) — needed in Thailand, where ISPs block okx.com;
                  OKX US100-USDT-SWAP perp candles (REST poll); if nothing answers, the card switches to the TradingView tab.
   All feeds are requested at once with short timeouts (raceFeeds in app.js); the first good one is shown.
   Bars/ticks inside the broker close (Fri 17:00 → Sun 18:00 NY and the daily 17:00–18:00 NY break) are dropped,
   like the gold chart, because the OKX index keeps printing 24/7.
   Skilling/MT5 match (28 Oct 2026, vs TradingView SKILLING:US100): Skilling ≈ Dukascopy USATECH −4.5 ≈ ^NDX cash −5;
                  OKX US100-USDT index runs ~+7…+12 above Skilling, Bitget NDX100 index ~+36 (off-hours up to +140), OKX perp ~+30.
                  Every feed is shifted by a per-feed offset (default below, or the user's own "ปรับให้ตรง MT5" value saved
                  in localStorage) so candles, price and high/low read in Skilling/MT5 points. */
(() => {
'use strict';
const L = window.AITD_LIB; if (!L || !document.getElementById('nasCard')) return;
const { $, qs, LS, fmt, sgn, esc, spotClosed, bucketStart, aggregate, TF, OKX, okxGet, withTimeout, withTV, TH_OFF, dayStartMs, bitgetIndex, raceFeeds, createTrend } = L;
const DEF_OFF = { hl:-9, okxidx:-10, bitget:-45, perp:-30 };   // feed → Skilling US100 (measured 27–29 Oct 2026, see header)
const HL_COIN = 'xyz:XYZ100', HL_K = 5.5;                // trade.xyz oracle − Skilling US100 (median 27–29 Oct 2026; hourly 3.3…8.5)
const median = (a) => { const s = [...a].sort((x,y)=>x-y), n = s.length; return n ? (n%2 ? s[(n-1)/2] : (s[n/2-1]+s[n/2])/2) : null; };
const userOff = (name) => { const v = parseFloat(LS.get('nas_off_'+name, '')); return isFinite(v) ? v : null; };
const prem = [];                                         // XYZ100 mid − oracle samples (live premium of the perp)
const onPrem = (mid, oracle) => { if (mid>0 && oracle>0 && Math.abs(mid-oracle) < 60){ prem.push(mid-oracle); if (prem.length > 60) prem.shift(); } };
const liveOff = () => prem.length >= 3 ? Math.round(Math.min(-3, Math.max(-20, -(HL_K + median(prem))))*10)/10 : null;
const offFor = (name) => userOff(name) ?? (name==='hl' ? liveOff() : null) ?? DEF_OFF[name] ?? 0;
const shiftBar = (b, d) => ({time:b.time, open:b.open+d, high:b.high+d, low:b.low+d, close:b.close+d});
const N = { tf: TF[qs.get('nastf')] ? qs.get('nastf') : (TF[LS.get('nas_tf','15')] ? LS.get('nas_tf','15') : '15'),
  view: LS.get('nas_view','zone'), raw: [], dayRaw: [], off: 0, price: null, prev: null, feed: null, lastTickAt: 0, hi: null, lo: null };

/* ---------------- feeds ---------------- */
const HL_TF = { '1':'1m', '5':'5m', '15':'15m', '30':'30m', '60':'1h' };
async function hlBars(tf, n){                              // tf as chart TF ('240' → 1h bars, aggregated by the caller)
  const base = tf==='240' ? '60' : tf, s = TF[base].s, now = Date.now();
  const j = await L.hlPost({type:'candleSnapshot', req:{coin:HL_COIN, interval:HL_TF[base], startTime: now - (n+1)*s*1000, endTime: now}}, 6000);
  if (!Array.isArray(j) || !j.length) throw new Error('hyperliquid candles');
  return j.map(k=>({time:k.t/1000, open:+k.o, high:+k.h, low:+k.l, close:+k.c})).filter(b=>!spotClosed(b.time*1000));
}
const Feeds = {
  hl: {
    name:'hl', label:'Hyperliquid XYZ100 (Nasdaq-100)',
    async history(tf, bars=500){
      let raw = await hlBars(tf, tf==='240' ? 1100 : Math.round(bars*1.4));   // ×1.4: the daily break / weekend bars are dropped
      if (tf==='240') raw = aggregate(raw, '240');
      return raw;
    },
    stream(onTick){
      let ws, closed=false, retry=0, ping, poll, last=0, cur=null;
      const tick = (px) => { if (isFinite(px) && px>0){ last=Date.now(); onTick(px, Date.now()); } };
      const onCandle = (c) => {                            // feed the 1m candle's new extremes first so wicks match the history bars
        const h = +c.h, l = +c.l, x = +c.c;
        if (!cur || cur.t!==c.t) cur = {t:c.t, h:x, l:x};
        if (h > cur.h){ cur.h = h; tick(h); }
        if (l < cur.l){ cur.l = l; tick(l); }
        tick(x);
      };
      const pollOnce = async()=>{ try{
        const [m, ctx] = await L.hlPost({type:'metaAndAssetCtxs', dex:'xyz'}, 4000);
        const i = m.universe.findIndex(a=>a.name===HL_COIN); if (i<0) return; const c = ctx[i];
        onPrem(+c.midPx, +c.oraclePx); tick(+(c.midPx || c.markPx));
      }catch(e){} };
      const startPoll = () => { if (!poll) poll = setInterval(pollOnce, 3000); };
      const stopPoll = () => { if (poll){ clearInterval(poll); poll=null; } };
      const open = () => {
        try{ ws = new WebSocket('wss://api.hyperliquid.xyz/ws'); }catch(e){ startPoll(); return; }
        ws.onopen = ()=>{
          ws.send(JSON.stringify({method:'subscribe', subscription:{type:'candle', coin:HL_COIN, interval:'1m'}}));
          ws.send(JSON.stringify({method:'subscribe', subscription:{type:'activeAssetCtx', coin:HL_COIN}}));
          clearInterval(ping); ping = setInterval(()=>{ try{ ws.send(JSON.stringify({method:'ping'})); }catch(e){} }, 30000);
        };
        ws.onmessage = (m)=>{ let j; try{ j = JSON.parse(m.data); }catch(e){ return; }
          if (j.channel==='candle' && j.data && j.data.s===HL_COIN){ retry=0; stopPoll(); onCandle(j.data); }
          else if (j.channel==='activeAssetCtx' && j.data && j.data.ctx){ last = Date.now(); onPrem(+j.data.ctx.midPx, +j.data.ctx.oraclePx); } };
        ws.onclose = ()=>{ clearInterval(ping); if (closed) return; startPoll(); setTimeout(open, Math.min(15000, 1000*(++retry))); };
      };
      open(); pollOnce();
      last = Date.now();
      const wd = setInterval(()=>{ if (Date.now()-last > 8000) startPoll(); }, 4000);   // WS silent/blocked → REST poll
      return () => { closed=true; clearInterval(ping); clearInterval(wd); stopPoll(); try{ws.close()}catch(e){} };
    },
    async tail(tf){ return (await hlBars(tf, tf==='240' ? 5 : 3)).slice(tf==='240' ? -5 : -3); }
  },
  okxidx: {
    name:'okxidx', label:'OKX US100-USDT index',
    async history(tf, bars=500){
      const base = tf==='240' ? '60' : tf, s = TF[base].s;
      const need = tf==='240' ? 900 : bars, pages = Math.ceil(need/100);
      const end = (Math.floor(Date.now()/1000/s)+1)*s*1000;
      const res = await Promise.all(Array.from({length:pages}, (_,k)=>
        okxGet(`${OKX}history-index-candles?instId=US100-USDT&bar=${TF[base].okx}&limit=100&after=${end - k*100*s*1000}`)));
      const m = new Map();
      for (const page of res) for (const k of page) m.set(+k[0]/1000, {time:+k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4]});
      let raw = [...m.values()].sort((a,b)=>a.time-b.time).filter(b=>!spotClosed(b.time*1000));
      if (tf==='240') raw = aggregate(raw, '240');
      return raw;
    },
    stream(onTick){
      let ws, closed=false, retry=0, ping, poll, last=0;
      const tick = (px, ts) => { if (isFinite(px) && px>0){ last=Date.now(); onTick(px, ts||Date.now()); } };
      const startPoll = () => { if (poll) return; poll = setInterval(async()=>{ try{ const d = await okxGet(`${OKX}index-tickers?instId=US100-USDT`,1); tick(+d[0].idxPx, +d[0].ts); }catch(e){} }, 2000); };
      const stopPoll = () => { if (poll){ clearInterval(poll); poll=null; } };
      const open = () => {
        try{ ws = new WebSocket('wss://ws.okx.com/ws/v5/public'); }catch(e){ startPoll(); return; }
        ws.onopen = ()=>{ ws.send(JSON.stringify({op:'subscribe', args:[{channel:'index-tickers', instId:'US100-USDT'}]})); clearInterval(ping); ping = setInterval(()=>{ try{ws.send('ping')}catch(e){} }, 20000); };
        ws.onmessage = (m)=>{ if (m.data==='pong') return; const j = JSON.parse(m.data); if (j.data && j.data[0]){ retry=0; stopPoll(); tick(+j.data[0].idxPx, +j.data[0].ts); } };
        ws.onclose = ()=>{ clearInterval(ping); if (closed) return; startPoll(); setTimeout(open, Math.min(15000, 1000*(++retry))); };
      };
      open();
      last = Date.now();
      const wd = setInterval(()=>{ if (Date.now()-last > 5000) startPoll(); }, 2500);   // WS silent/blocked → REST poll
      return () => { closed=true; clearInterval(ping); clearInterval(wd); stopPoll(); try{ws.close()}catch(e){} };
    },
    async tail(tf){
      const base = tf==='240' ? '60' : tf, need = tf==='240' ? 5 : 3;
      const d = await okxGet(`${OKX}index-candles?instId=US100-USDT&bar=${TF[base].okx}&limit=${need}`, 1);
      return d.map(k=>({time:+k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4]})).reverse().filter(b=>!spotClosed(b.time*1000));
    }
  },
  bitget: Object.assign(bitgetIndex('NDX100USDT', 'Bitget NDX100 index (สำรอง)', false), {
    stream(onTick){ return bitgetIndex('NDX100USDT').stream(null, onTick); } }),
  perp: {
    name:'perp', label:'OKX US100-USDT perp (สำรอง)',
    async history(tf){
      const r = await okxGet(`${OKX}candles?instId=US100-USDT-SWAP&bar=${TF[tf].okx}&limit=300`);
      return r.map(k=>({time:+k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4]})).reverse().filter(b=>!spotClosed(b.time*1000));
    },
    stream(onTick){
      const iv = setInterval(async()=>{ try{ const d = await okxGet(`${OKX}ticker?instId=US100-USDT-SWAP`,1); onTick(+d[0].last, +d[0].ts); }catch(e){} }, 3000);
      return () => clearInterval(iv);
    }
  }
};
const ORDER = qs.get('nasfeed') && Feeds[qs.get('nasfeed')] ? [qs.get('nasfeed')] : ['hl','okxidx','bitget','perp'];

/* ---------------- chart (same options as the gold chart) ---------------- */
let chart, cs, bbUp, bbMid, bbDn, stop = null;
const BB_LEN = 50, BB_DEV = 1.1;                         // coach MT5: period 50, shift 0, deviation 1.1, Typical Price
const hlc3 = (b) => (b.high + b.low + b.close) / 3;
function bollinger(data){                               // mid = SMA(HLC/3, 50); bands = mid ± 1.1 × population stdev
  const mid = [], up = [], dn = [];
  if (!data || data.length < BB_LEN) return { mid, up, dn };
  let run = 0;
  for (let i = 0; i < data.length; i++){
    run += hlc3(data[i]);
    if (i >= BB_LEN) run -= hlc3(data[i - BB_LEN]);
    if (i < BB_LEN - 1) continue;
    const m = run / BB_LEN; let s2 = 0;
    for (let k = i - BB_LEN + 1; k <= i; k++){ const d = hlc3(data[k]) - m; s2 += d * d; }
    const dev = BB_DEV * Math.sqrt(s2 / BB_LEN);
    mid.push({ time: data[i].time, value: m });
    up.push({ time: data[i].time, value: m + dev });
    dn.push({ time: data[i].time, value: m - dev });
  }
  return { mid, up, dn };
}
function setBands(data){
  const b = bollinger(data);
  bbMid.setData(b.mid); bbUp.setData(b.up); bbDn.setData(b.dn);
}
/* M15…D1 trend panel (engine in app.js): same feed as the NAS chart (Hyperliquid XYZ100 first); offset-free structure */
const NTR = createTrend({ el:'nasTrend', feed:()=>N.feed, digits:1 });
function initChart(){
  const LW = window.LightweightCharts;
  chart = LW.createChart($('nasLw'), {
    autoSize:true,
    layout:{background:{type:'solid',color:'rgba(13,16,22,0)'}, textColor:'#8b93a5', fontFamily:"'JetBrains Mono', monospace", fontSize:11, attributionLogo:true},
    grid:{vertLines:{color:'rgba(255,255,255,0.03)'}, horzLines:{color:'rgba(255,255,255,0.04)'}},
    rightPriceScale:{borderColor:'#232937', scaleMargins:{top:0.08,bottom:0.08}},
    timeScale:{borderColor:'#232937', timeVisible:true, secondsVisible:false, rightOffset:6},
    crosshair:{mode:0},
    localization:{priceFormatter:(p)=>fmt(p,2)},
  });
  cs = chart.addSeries(LW.CandlestickSeries, {upColor:'#26a69a', downColor:'#ef5350', borderVisible:false, wickUpColor:'#26a69a', wickDownColor:'#ef5350', priceFormat:{type:'price',precision:2,minMove:0.01}});
  const line = { priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false };
  bbUp = chart.addSeries(LW.LineSeries, { ...line, color:'#5aa9ff', lineWidth:1 });
  bbDn = chart.addSeries(LW.LineSeries, { ...line, color:'#5aa9ff', lineWidth:1 });
  bbMid = chart.addSeries(LW.LineSeries, { ...line, color:'#f3d27a', lineWidth:1.5 });
  chart.timeScale().subscribeVisibleLogicalRangeChange(drawZones);
  new ResizeObserver(()=>requestAnimationFrame(drawZones)).observe($('nasZoneView'));
  setInterval(drawZones, 400);
}
const adj = (b) => ({time:b.time + TH_OFF, open:b.open, high:b.high, low:b.low, close:b.close});
function redraw(){
  const d = N.raw.map(adj); cs.setData(d); setBands(d);
  if (N.raw.length) setPrice(N.raw[N.raw.length-1].close);
  recomputeDay(); drawZones();
}
function updLast(){
  cs.update(adj(N.raw[N.raw.length-1]));
  const b = bollinger(N.raw.slice(-BB_LEN).map(adj));
  if (b.mid.length){ const i = b.mid.length - 1; bbMid.update(b.mid[i]); bbUp.update(b.up[i]); bbDn.update(b.dn[i]); }
}
function onTick(p, ms){
  p += N.off;                                                  // feed → Skilling/MT5 points
  if (!cs || !N.raw.length || spotClosed(ms)) return;
  const t = bucketStart(Math.floor(ms/1000), N.tf), last = N.raw[N.raw.length-1];
  if (t < last.time) return;
  if (t === last.time){ last.high=Math.max(last.high,p); last.low=Math.min(last.low,p); last.close=p; }
  else { N.raw.push({time:t, open:p, high:p, low:p, close:p}); if (N.raw.length>1500) N.raw.shift(); }
  updLast(); trackDay(p); setPrice(p); N.lastTickAt = Date.now();
}
async function resyncTail(){
  const f = N.feed; if (!f || !f.tail || !N.raw.length) return;
  try{
    const tf = N.tf, off = N.off; let bars = (await f.tail(tf)).map(b=>shiftBar(b, off));
    if (tf==='240'){ const cur = N.raw[N.raw.length-1].time; bars = aggregate(bars.filter(b=>bucketStart(b.time,'240')>=cur), '240'); }
    if (tf!==N.tf || f!==N.feed) return;
    for (const b of bars){
      const i = N.raw.findIndex(x=>x.time===b.time);
      if (i>=0){ if (i===N.raw.length-1){ b.close = N.raw[i].close; b.high=Math.max(b.high,b.close); b.low=Math.min(b.low,b.close); } N.raw[i] = b; }
      else if (b.time > N.raw[N.raw.length-1].time) N.raw.push(b);
    }
    const d = N.raw.map(adj); cs.setData(d); setBands(d); drawZones();
  }catch(e){}
}
async function loadFeed(){
  if (stop){ stop(); stop = null; }
  N.raw = []; $('nasStatus').textContent = 'กำลังโหลด…';
  const tf0 = N.tf;
  N.loading = true;
  const won = await raceFeeds(ORDER, (n)=>withTimeout(Feeds[n].history(N.tf), 6000), 2000);   // Hyperliquid first: a faster Bitget answer waits ≤2 s for it (Bitget candles are off)
  if (tf0 !== N.tf) return;
  N.loading = false;
  if (won){
    const f = Feeds[won.name];
    N.off = offFor(won.name);
    N.feed = f; N.raw = won.hist.map(b=>shiftBar(b, N.off)); renderCal(); redraw(); chart.timeScale().scrollToRealTime();
    if (!COACH.raw.h1 && !COACH.busy) loadCoachHist();
    stop = f.stream(onTick); N.lastTickAt = Date.now();
    setTimeout(()=>loadDay(f), 2000);
    $('nasStatus').textContent = won.name===ORDER[0] ? '' : 'สำรอง: '+f.label; renderBadge(); return;
  }
  N.feed = null; renderBadge();
  $('nasStatus').textContent = 'โหลดข้อมูล NAS100 ไม่ได้ — เปิดแท็บ TradingView ให้แทน';
  if (N.view==='zone') setView('tv', true);                 // show live TradingView chart instead of an empty one
}
async function loadDay(f){ try{ const off = N.off; N.dayRaw = (await f.history('15', 120)).map(b=>shiftBar(b, off)); recomputeDay(); }catch(e){} }

/* ---------------- "ปรับให้ตรง MT5": user types the MT5/Skilling price once → offset saved per feed ---------------- */
function setOff(v){
  const d = v - N.off; if (!isFinite(d)) return;
  N.off = v;
  N.raw = N.raw.map(b=>shiftBar(b, d)); N.dayRaw = N.dayRaw.map(b=>shiftBar(b, d));
  if (N.hi!=null){ N.hi += d; N.lo += d; }
  if (N.price!=null) N.price += d;
  N.prev = null; redraw(); renderCal();
}
function renderCal(){
  const el = $('nasCalInfo'); if (!el) return;
  if (!N.feed){ el.textContent = ''; return; }
  const own = userOff(N.feed.name) != null;
  const live = !own && N.feed.name==='hl' && liveOff()!=null;
  el.textContent = `ปรับ ${sgn(N.off, Number.isInteger(N.off)?0:1)} จุด (${own ? 'ตั้งเอง' : live ? 'วัดสด ≈ Skilling' : 'ค่าเริ่มต้น ≈ Skilling'})`;
  el.title = `ราคาแหล่ง ${N.feed.label} ${N.off>=0?'+':'−'} ${Math.abs(N.off)} จุด`;
}
function wireCal(){
  const box = $('nasCalBox'), inp = $('nasCalIn');
  $('nasCalBtn').onclick = ()=>{ box.classList.toggle('hidden'); if (!box.classList.contains('hidden')){ inp.value = N.price!=null ? N.price.toFixed(1) : ''; inp.focus(); inp.select(); } };
  $('nasCalSet').onclick = ()=>{
    const mt5 = parseFloat(String(inp.value).replace(/,/g,'')); if (!N.feed || N.price==null || !isFinite(mt5)) return;
    const v = Math.round((N.off + (mt5 - N.price))*10)/10;
    if (Math.abs(v) > 500){ $('nasCalMsg').textContent = 'ต่างเกิน 500 จุด — ตรวจตัวเลขอีกครั้ง'; return; }
    LS.set('nas_off_'+N.feed.name, String(v)); setOff(v); $('nasCalMsg').textContent = 'บันทึกแล้ว (เก็บในเครื่องนี้)'; box.classList.add('hidden');
  };
  $('nasCalReset').onclick = ()=>{ if (!N.feed) return; try{ localStorage.removeItem('aitd_nas_off_'+N.feed.name); }catch(e){}; setOff(DEF_OFF[N.feed.name] ?? 0); $('nasCalMsg').textContent = 'กลับเป็นค่าเริ่มต้น'; box.classList.add('hidden'); };
  inp.onkeydown = (e)=>{ if (e.key==='Enter') $('nasCalSet').click(); };
}
function recomputeDay(){
  const t0 = dayStartMs()/1000; let hi=null, lo=null;
  const src = N.dayRaw.length ? N.dayRaw : (N.tf!=='240' ? N.raw : []);
  for (const b of src){ if (b.time < t0) continue; hi = hi==null?b.high:Math.max(hi,b.high); lo = lo==null?b.low:Math.min(lo,b.low); }
  if (hi!=null){ N.hi = hi; N.lo = lo; }
  renderHL();
}
function trackDay(p){ if (N.hi==null){ N.hi = N.lo = p; } N.hi = Math.max(N.hi,p); N.lo = Math.min(N.lo,p); renderHL(); }
function renderHL(){ $('nasHL').textContent = N.hi!=null ? `${fmt(N.hi)} / ${fmt(N.lo)}` : '—'; }

/* ---------------- price header ---------------- */
let flashT;
function priorClose(){
  const t0 = dayStartMs()/1000;
  const pick = (src) => { let c = null; for (const b of src || []){ if (b.time >= t0) break; c = b.close; } return c; };
  return pick(N.dayRaw) ?? pick(N.raw);
}
function setPrice(p){
  if (p==null || !isFinite(p)) return;
  N.prev = N.price; N.price = p;
  const el = $('nasPrice'); el.textContent = fmt(p);
  if (N.prev!=null && p!==N.prev){ el.classList.remove('up','down'); el.classList.add(p>N.prev?'up':'down'); clearTimeout(flashT); flashT = setTimeout(()=>el.classList.remove('up','down'),700); }
  const pc = priorClose(), ch = $('nasChg');
  if (ch && pc){ const c = p-pc; ch.className = 'chg '+(c>=0?'pos':'neg'); ch.textContent = `${sgn(c)} (${sgn(c/pc*100)}%) เทียบปิด ${fmt(pc)}`; }
}
function renderBadge(){
  const b = $('nasBadge'), stale = !N.lastTickAt || Date.now()-N.lastTickAt > 90000;
  if (!N.feed){ b.className='badge'; b.textContent = N.loading ? 'กำลังเชื่อมต่อ…' : 'ไม่มีข้อมูล'; return; }
  if (spotClosed(Date.now())){ b.className='badge warn'; b.textContent='ตลาดปิด'; return; }
  b.className = 'badge ' + (stale?'warn':'live'); b.textContent = stale ? 'รอข้อมูล' : 'LIVE';
}
/* Swing Finder (RSI 7, 70/30) — same candles / timeframe as this chart. N.raw is already in Skilling points. */
const TF_LABEL = { '1':'M1', '5':'M5', '15':'M15', '30':'M30', '60':'H1', '240':'H4' };
const NSW = (document.getElementById('nasTgSwing') && window.AITD_SWING) ? window.AITD_SWING.createSwingOverlay({
  lsKey:'nas_swing_on', tgId:'nasTgSwing', sumId:'nasSwingSum', digits:2, LS:L.LS, fmt:L.fmt, timeShift:L.TH_OFF,
  bars:()=>N.raw, chart:()=>chart, series:()=>cs, onChange:()=>drawZones(),
  pdKey:'nas_pd_on', pdTgId:'nasTgPd', pdCv:'nasPdCanvas', wrapId:'nasZoneView', noteId:'nasPdNote',
  tf:()=>N.tf, tfLabel:()=>TF_LABEL[N.tf] || N.tf, price:()=>N.price, feedKey:()=>N.feed && N.feed.name,
  loadH1:()=>{ const f=N.feed; if (!f || !f.history) return null; return f.history('60', 400); },
  adjust:(raw)=>raw.map(b=>shiftBar(b, N.off)),
  aggregate:L.aggregate,
}) : null;
window.__AITD_NSW = NSW;

/* ---------------- Coach patterns (Coach_Patterns_v3.pine, default inputs) ----------------
   HDB / WF / PAIR / VBC / DBD / RBR / RBD / DBR computed from the page's own candles.
   Pine defaults rbdOn/dbrOn off; this page draws all four leg-base-leg boxes (coach uses them).
   PAIR levels stop after 3 fresh retests (course: ใช้ไม่เกิน 2–3 ครั้ง). No volume profile. */
/* COACH_ENGINE_START */
function coachScan(bars, opt){
  const o = Object.assign({
    stFilt:true, bbLen:50, bbMult:1.1, slopeLen:5, swSlope:0.35, strongSl:1, bandLook:6, bandTchN:2, boxLen:12, boxMaxA:2.5,
    pairOn:true, pairBody:0.3, pairTolA:0.1, pairNoV:true, pairMaxUses:3,
    vbcOn:true, vbcRun:3, vbcMove:0, vbcPen:50, vbcDoji:20,
    wfOn:true, wfBodyP:0,
    hdbOn:true, hdbBody:0.4, hdbTolA:0.1, hdbMinA:0.1, hdbAge:24, hdbStMode:'trend', hdbWick:false, hdbNoWF:false, hdbHL:false,
    dbdOn:true, rbrOn:true, rbdOn:true, dbrOn:true,
    boxDet:12, boxDetA:2.5, brkBufA:0.1, legLook:12, legAtr:2, boxShow:true,
    lineLen:12, sec:0, now:null, trace:false, maxDraw:10,
  }, opt || {});
  const empty = { state:null, patterns:[], drawn:[], latest:null };
  if (!bars || bars.length < 5) return empty;
  const n = bars.length;
  const useClose = o.now != null && o.sec > 0;
  const confirmed = (i) => !useClose || bars[i].time + o.sec <= o.now;
  let lastI = n - 1;
  while (lastI >= 0 && !confirmed(lastI)) lastI--;
  if (lastI < 1) return empty;

  const tr = new Array(n), atr = new Array(n).fill(null);
  for (let i = 0; i < n; i++){
    const b = bars[i];
    let t = b.high - b.low;
    if (i > 0){ const pc = bars[i-1].close; t = Math.max(t, Math.abs(b.high-pc), Math.abs(b.low-pc)); }
    tr[i] = t;
  }
  if (n >= 14){
    let s = 0; for (let i = 0; i < 14; i++) s += tr[i];
    atr[13] = s / 14;
    for (let i = 14; i < n; i++) atr[i] = (atr[i-1] * 13 + tr[i]) / 14;
  }
  const basis = new Array(n).fill(null), bbHi = new Array(n).fill(null), bbLo = new Array(n).fill(null);
  const tp = (i) => (bars[i].high + bars[i].low + bars[i].close) / 3;   // same bands as the chart: SMA50 of HLC/3 ± 1.1 stdev
  let run = 0;
  for (let i = 0; i < n; i++){
    run += tp(i);
    if (i >= o.bbLen) run -= tp(i - o.bbLen);
    if (i >= o.bbLen - 1){
      const mean = run / o.bbLen; let s2 = 0;
      for (let k = i - o.bbLen + 1; k <= i; k++){ const d = tp(k) - mean; s2 += d * d; }
      const dev = o.bbMult * Math.sqrt(s2 / o.bbLen);
      basis[i] = mean; bbHi[i] = mean + dev; bbLo[i] = mean - dev;
    }
  }
  const hiLo = (i, len, side) => {
    if (i < len - 1) return null;
    let m = side === 'h' ? -Infinity : Infinity;
    for (let k = i - len + 1; k <= i; k++) m = side === 'h' ? Math.max(m, bars[k].high) : Math.min(m, bars[k].low);
    return m;
  };
  const bull = (i) => bars[i].close > bars[i].open;
  const bear = (i) => bars[i].close < bars[i].open;
  const bodyAt = (i) => Math.abs(bars[i].close - bars[i].open);
  const patterns = [], zones = [], trace = o.trace ? [] : null;
  let bxTop = null, bxBot = null, bxS = null, bxLeg = '', lastBrkBar = -100000, state = null;

  for (let i = 0; i <= lastI; i++){
    const b = bars[i], a = atr[i], aOk = a != null && a > 0;
    const basisPrev = i >= o.slopeLen ? basis[i - o.slopeLen] : null;
    const slope = aOk && basis[i] != null && basisPrev != null ? (basis[i] - basisPrev) / a : 0;
    const hiR = hiLo(i, o.boxLen, 'h'), loR = hiLo(i, o.boxLen, 'l');
    const rngS = hiR == null ? null : hiR - loR;
    let tUp = 0, tDn = 0;
    for (let k = Math.max(0, i - o.bandLook + 1); k <= i; k++){
      if (bbHi[k] == null) continue;
      if (bars[k].high >= bbHi[k]) tUp++;
      if (bars[k].low <= bbLo[k]) tDn++;
    }
    const sUp = aOk && basis[i] != null && slope >= o.strongSl && b.close > basis[i] && tUp >= o.bandTchN;
    const sDn = aOk && basis[i] != null && slope <= -o.strongSl && b.close < basis[i] && tDn >= o.bandTchN;
    const isBox = (aOk && rngS != null && rngS <= o.boxMaxA * a) || Math.abs(slope) < o.swSlope;
    state = sUp ? 2 : sDn ? -2 : isBox ? 0 : slope >= o.swSlope ? 1 : slope <= -o.swSlope ? -1 : 0;
    if (trace) trace.push(state);
    const notStrong = !o.stFilt || Math.abs(state) < 2;

    let vbcDir = 0;
    if (b.close !== b.open && i > 25){
      const brkG = b.close > b.open; let rl = 0;
      for (let q = 1; q <= 20 && i - q >= 0; q++){
        if (!(brkG ? bear(i - q) : bull(i - q))) break;
        rl++;
      }
      if (rl >= 1){
        const mv = brkG ? bars[i - rl].open - bars[i - 1].close : bars[i - 1].close - bars[i - rl].open;
        const volOk = rl >= o.vbcRun || (o.vbcMove > 0 && mv >= o.vbcMove);
        const body1 = bodyAt(i - 1);
        const pen = brkG ? b.close - bars[i - 1].close : bars[i - 1].close - b.close;
        const rngC = b.high - b.low, bd = bodyAt(i);
        const penOk = body1 > 0 && pen <= o.vbcPen / 100 * body1;
        const djOk = rngC > 0 && bd / rngC * 100 >= o.vbcDoji;
        if (volOk && penOk && djOk) vbcDir = brkG ? 1 : -1;
      }
    }
    let vbcF = false;
    if (o.vbcOn && vbcDir !== 0 && notStrong){
      vbcF = true;
      const i1 = Math.min(lastI, i + o.lineLen);
      patterns.push({ kind:'VBC', dir:vbcDir, i0:i-1, i1, top:b.open, bot:b.open, born:i, level:b.open, t0:bars[i-1].time, t1:bars[i1].time });
    }
    if (i >= 1 && aOk){
      const bd = bodyAt(i), body1 = bodyAt(i-1), tol = o.pairTolA * a, minB = o.pairBody * a;
      const pairBull = bear(i-1) && bull(i) && bd >= minB && body1 >= minB && Math.abs(b.open - bars[i-1].close) <= tol;
      const pairBear = bull(i-1) && bear(i) && bd >= minB && body1 >= minB && Math.abs(b.open - bars[i-1].close) <= tol;
      if (o.pairOn && (pairBull || pairBear) && notStrong && !(o.pairNoV && vbcF)){
        const dir = pairBull ? 1 : -1, lv = (bars[i-1].close + b.open) / 2;
        patterns.push({ kind:'PAIR', dir, i0:i-1, i1:i, top:lv, bot:lv, born:i, level:lv, uses:0, t0:bars[i-1].time, t1:b.time });
      }
    }
    if (o.wfOn && i >= 1){
      const rngC = b.high - b.low, bd = bodyAt(i);
      const bodyPct = rngC > 0 ? bd / rngC * 100 : 0;
      const wfBull = bull(i) && bear(i-1) && b.close > bars[i-1].high && bodyPct >= o.wfBodyP;
      const wfBear = bear(i) && bull(i-1) && b.close < bars[i-1].low && bodyPct >= o.wfBodyP;
      if (wfBull || wfBear){
        const dir = wfBull ? 1 : -1;
        if (!o.stFilt || state === 2 * dir){
          const prev = bars[i-1], lv = dir === 1 ? prev.high : prev.low;
          const wickBase = dir === 1 ? Math.max(prev.open, prev.close) : Math.min(prev.open, prev.close);
          let top = Math.max(lv, wickBase), bot = Math.min(lv, wickBase);
          const mh = aOk ? 0.05 * a : 0;
          if (top - bot < mh){ if (dir === 1) bot = top - mh; else top = bot + mh; }
          const i1 = Math.min(lastI, i + o.lineLen);
          patterns.push({ kind:'WF', dir, i0:i-1, i1, top, bot, born:i, level:lv, t0:prev.time, t1:bars[i1].time });
        }
      }
    }
    for (let k = zones.length - 1; k >= 0; k--){
      const z = zones[k];
      const hit = z.dir === 1 ? b.low <= z.top : b.high >= z.bot;
      const old = i - z.born >= o.hdbAge;
      if (hit || old){
        z.done = hit ? 'hit' : 'age';
        z.fade = !hit;
        z.i1 = i; z.t1 = b.time;
        zones.splice(k, 1);
      }
    }
    if (o.hdbOn && i >= 1 && aOk){
      const dH = bull(i) && bull(i-1) ? 1 : bear(i) && bear(i-1) ? -1 : 0;
      const bOk = bodyAt(i) >= o.hdbBody * a && bodyAt(i-1) >= o.hdbBody * a && Math.abs(b.open - bars[i-1].close) <= o.hdbTolA * a;
      if (dH !== 0 && bOk){
        const wkOk = !o.hdbWick || (dH === 1 ? b.low < b.open : b.high > b.open);
        const wfOk = !o.hdbNoWF || (dH === 1 ? b.close <= bars[i-1].high : b.close >= bars[i-1].low);
        const hlOk = !o.hdbHL || (dH === 1 ? b.low > bars[i-1].low : b.high < bars[i-1].high);
        const stOk = !o.stFilt || (o.hdbStMode === 'strong' ? state === 2 * dH : state * dH >= 1);
        if (wkOk && wfOk && hlOk && stOk){
          let zT = dH === 1 ? Math.max(bars[i-1].close, b.open) : Math.max(bars[i-1].close, b.open, b.high);
          let zB = dH === 1 ? Math.min(bars[i-1].close, b.open, b.low) : Math.min(bars[i-1].close, b.open);
          const mh = o.hdbMinA * a;
          if (zT - zB < mh){ if (dH === 1) zB = zT - mh; else zT = zB + mh; }
          const z = { kind:'HDB', dir:dH, i0:i-1, i1:Math.min(n-1, i+1), top:zT, bot:zB, born:i, done:null, fade:false, t0:bars[i-1].time, t1:bars[Math.min(n-1, i+1)].time };
          zones.push(z); patterns.push(z);
        }
      }
    }
    let brk = 0;
    const rhB = hiLo(i, o.boxDet, 'h'), rlB = hiLo(i, o.boxDet, 'l');
    if (bxTop == null){
      if (rhB != null && aOk && (rhB - rlB) <= o.boxDetA * a && (i - o.boxDet + 1) > lastBrkBar){
        const iBack = i - o.boxDet, iLeg = iBack - o.legLook;
        const mvL = iLeg >= 0 ? bars[iBack].close - bars[iLeg].close : null;
        bxLeg = mvL != null && mvL >= o.legAtr * a ? 'R' : mvL != null && mvL <= -o.legAtr * a ? 'D' : '-';
        bxTop = rhB; bxBot = rlB; bxS = i - o.boxDet + 1;
      }
    } else if (aOk){
      if (b.close > bxTop + o.brkBufA * a) brk = 1;
      else if (b.close < bxBot - o.brkBufA * a) brk = -1;
      else if (bxTop - bxBot > 2 * o.boxDetA * a){ bxTop = null; bxBot = null; bxS = null; bxLeg = ''; }
      else { bxTop = Math.max(bxTop, b.high); bxBot = Math.min(bxBot, b.low); }
    }
    if (brk !== 0 && bxS != null){
      const lab = bxLeg + 'B' + (brk === 1 ? 'R' : 'D');
      const en = (lab === 'DBD' && o.dbdOn) || (lab === 'RBR' && o.rbrOn) || (lab === 'RBD' && o.rbdOn) || (lab === 'DBR' && o.dbrOn);
      if (en && o.boxShow) patterns.push({ kind:lab, dir:brk, i0:bxS, i1:i, top:bxTop, bot:bxBot, born:i, t0:bars[bxS].time, t1:b.time });
      lastBrkBar = i; bxTop = null; bxBot = null; bxS = null; bxLeg = '';
    }
  }
  const liveRight = n - 1;
  for (const z of zones){ z.i1 = liveRight; z.t1 = bars[liveRight].time; }
  for (const p of patterns){
    if (p.kind === 'PAIR'){
      const lv = p.level; let uses = 0, inTouch = false, end = p.born;
      const cap = Math.min(lastI, p.born + 48);
      for (let j = p.born + 1; j <= cap; j++){
        const hit = p.dir === 1 ? bars[j].low <= lv : bars[j].high >= lv;
        if (hit && !inTouch){ uses++; inTouch = true; } else if (!hit) inTouch = false;
        end = j;
        if (uses >= o.pairMaxUses) break;
      }
      p.uses = uses; p.i1 = Math.max(p.i0, end); p.t1 = bars[Math.min(p.i1, n-1)].time;
      if (uses >= o.pairMaxUses){ p.done = 'uses'; p.fade = true; }
    } else if (p.kind === 'WF'){
      let end = p.i1;
      for (let j = p.born + 1; j <= Math.min(p.i1, lastI); j++){
        const hit = p.dir === 1 ? bars[j].low <= p.level : bars[j].high >= p.level;
        if (hit){ end = j; p.done = 'hit'; break; }
      }
      p.i1 = Math.max(p.born, end); p.t1 = bars[Math.min(p.i1, n-1)].time;
    }
    if (p.top < p.bot){ const t = p.top; p.top = p.bot; p.bot = t; }
  }
  const drawn = patterns.slice(-o.maxDraw);
  return { state, patterns, drawn, latest: patterns.length ? patterns[patterns.length-1] : null, trace };
}
/* COACH_ENGINE_END */

const COACH_TF = [ {k:'D', label:'D1', sec:86400}, {k:'240', label:'H4', sec:14400}, {k:'60', label:'H1', sec:3600}, {k:'30', label:'M30', sec:1800} ];
const COACH = { raw:{ m30:null, h1:null }, res:{}, key:{}, html:'', busy:false, seq:0, on:true };
const _d1c = new Map();
function d1Start(t){
  const hk = Math.floor(t / 3600); let ds = _d1c.get(hk);
  if (ds === undefined){ ds = dayStartMs(new Date(t * 1000 + 1000)) / 1000; _d1c.set(hk, ds); if (_d1c.size > 5000) _d1c.clear(); }
  return ds;
}
function aggD1(bars){
  const out = [];
  for (const b of bars){
    const t = d1Start(b.time), l = out[out.length-1];
    if (l && l.time === t){ l.high = Math.max(l.high, b.high); l.low = Math.min(l.low, b.low); l.close = b.close; }
    else out.push({ time:t, open:b.open, high:b.high, low:b.low, close:b.close });
  }
  return out;
}
function coachStateInfo(st){
  if (st === 2) return { cls:'up', th:'เทรนด์ขึ้นแรง', ar:'▲' };
  if (st === 1) return { cls:'up', th:'ไซด์เวย์ขึ้น', ar:'▲' };
  if (st === 0) return { cls:'side', th:'ไซด์เวย์', ar:'◆' };
  if (st === -1) return { cls:'down', th:'ไซด์เวย์ลง', ar:'▼' };
  if (st === -2) return { cls:'down', th:'เทรนด์ลงแรง', ar:'▼' };
  return { cls:'na', th:'—', ar:'·' };
}
function coachBarsFor(k){
  if ((k === '30' || k === '60' || k === '240') && N.tf === k && N.raw.length) return N.raw;
  const shift = (rows) => rows.map(b => shiftBar(b, N.off));
  if (k === '30'){
    if (COACH.raw.m30 && COACH.raw.m30.length) return shift(COACH.raw.m30);
    if (['1','5','15'].includes(N.tf) && N.raw.length) return aggregate(N.raw, '30');
  }
  if (k === '60'){
    if (COACH.raw.h1 && COACH.raw.h1.length) return shift(COACH.raw.h1);
    if (['1','5','15','30'].includes(N.tf) && N.raw.length) return aggregate(N.raw, '60');
  }
  if (k === '240'){
    if (COACH.raw.h1 && COACH.raw.h1.length) return aggregate(shift(COACH.raw.h1), '240');
    if (['1','5','15','30','60'].includes(N.tf) && N.raw.length) return aggregate(N.raw, '240');
  }
  if (k === 'D'){
    if (COACH.raw.h1 && COACH.raw.h1.length) return aggD1(shift(COACH.raw.h1));
    if (['1','5','15','30','60','240'].includes(N.tf) && N.raw.length) return aggD1(N.raw);
  }
  return null;
}
function coachSig(bars, sec){
  if (!bars || !bars.length) return '0';
  const now = Date.now() / 1000;
  let iEnd = bars.length - 1;
  while (iEnd >= 0 && sec > 0 && bars[iEnd].time + sec > now) iEnd--;
  let h = bars.length * 131 + iEnd;
  for (let i = 0; i <= iEnd; i++){
    const b = bars[i];
    h = (h * 33 + (b.time|0) + Math.round(b.open*10) + Math.round(b.high*10) + Math.round(b.low*10) + Math.round(b.close*10)) | 0;
  }
  return h + '|' + N.off;
}
function scanTf(k){
  const bars = coachBarsFor(k);
  const sec = k === 'D' ? 86400 : (TF[k] ? TF[k].s : 0);
  if (!bars || bars.length < 20){ COACH.res[k] = null; COACH.key[k] = ''; return null; }
  const key = coachSig(bars, sec);
  if (COACH.key[k] === key && COACH.res[k]) return COACH.res[k];
  let res = null;
  try { res = coachScan(bars, { sec, now: Date.now()/1000 }); }
  catch (e){ res = null; if (!COACH.err){ COACH.err = String(e && e.stack || e); console.error('coach', e); } }
  COACH.res[k] = res; COACH.key[k] = key;
  return res;
}
function coachOn(){ return !!COACH.on; }
function renderCoachPanel(){
  const el = $('nasCoachPanel'); if (!el) return;
  const view = ['30','60','240'].includes(N.tf);
  let html = `<div class="coach-head"><span class="coach-title">รูปแบบโค้ชน้ำ</span><span class="tr-sum">${view ? 'กล่องบนกราฟ = ' + (TF_LABEL[N.tf] || N.tf) : 'เปิด M30 / H1 / H4 เพื่อวาดกล่องบนกราฟ'}</span></div><div class="coach-row">`;
  for (const tf of COACH_TF){
    const res = COACH.res[tf.k], st = coachStateInfo(res ? res.state : null), pat = res && res.latest;
    const cls = pat ? (pat.dir === 1 ? 'up' : 'down') : st.cls;
    const side = pat ? (pat.dir === 1 ? 'BUY' : 'SELL') : '';
    const patTx = pat ? `${pat.kind} ${side}` : 'ยังไม่มีรูปแบบ';
    const tip = `${tf.label}: ${st.th}` + (pat ? ` · ล่าสุด ${pat.kind} ${side} ${fmt(Math.min(pat.top, pat.bot), 1)}–${fmt(Math.max(pat.top, pat.bot), 1)}` : '') + (res ? ` · ${res.patterns.length} รูปแบบ` : '');
    html += `<div class="coach-chip ${cls}" data-tf="${tf.k}" data-state="${res && res.state != null ? res.state : ''}" data-pat="${pat ? pat.kind : ''}" data-dir="${pat ? pat.dir : ''}" data-n="${res ? res.patterns.length : 0}" title="${esc(tip)}"><small>${tf.label}</small><b>${st.ar} ${st.th}</b><span class="pat">${patTx}</span></div>`;
  }
  html += '</div>';
  const drawn = view && COACH.res[N.tf] && COACH.res[N.tf].drawn ? COACH.res[N.tf].drawn.length : 0;
  if (html === COACH.html && el.dataset.drawn === String(drawn)) return;
  COACH.html = html; el.innerHTML = html; el.dataset.drawn = String(drawn); el.dataset.tf = N.tf;
}
function refreshCoach(){
  for (const tf of COACH_TF) scanTf(tf.k);
  renderCoachPanel();
}
async function loadCoachHist(){
  const f = N.feed; if (!f || !f.history || COACH.busy) return;
  const seq = ++COACH.seq, name = f.name;
  COACH.busy = true;
  try {
    const [m30, h1] = await Promise.allSettled([
      withTimeout(f.history('30', 700), 12000),
      withTimeout(f.history('60', 1000), 15000),
    ]);
    if (seq !== COACH.seq || !N.feed || N.feed.name !== name) { COACH.busy = false; return; }
    if (m30.status === 'fulfilled' && Array.isArray(m30.value) && m30.value.length) COACH.raw.m30 = m30.value;
    if (h1.status === 'fulfilled' && Array.isArray(h1.value) && h1.value.length) COACH.raw.h1 = h1.value;
    COACH.key = {};
  } catch (e) {}
  COACH.busy = false;
  refreshCoach(); if (typeof drawZones === 'function') drawZones();
}
function wireCoach(){
  const el = $('nasTgCoach'); if (!el) return;
  COACH.on = LS.get('nas_coach_on', true) !== false;
  el.checked = COACH.on;
  el.onchange = () => { COACH.on = el.checked; LS.set('nas_coach_on', COACH.on); drawZones(); };
}
function paintCoach(ctx, paneW, paneH){
  if (!coachOn() || !cs || !chart || !N.raw.length) return;
  if (!['30','60','240'].includes(N.tf)) return;
  const res = COACH.res[N.tf]; if (!res) return;
  const st = coachStateInfo(res.state);
  ctx.save();
  ctx.font = '600 12px "IBM Plex Sans Thai", sans-serif';
  const badge = 'สภาวะ ' + (TF_LABEL[N.tf] || '') + ' ' + st.th;
  const tw = ctx.measureText(badge).width;
  ctx.fillStyle = 'rgba(13,16,22,0.78)';
  ctx.fillRect(8, 6, tw + 14, 18);
  ctx.fillStyle = st.cls === 'up' ? '#089981' : st.cls === 'down' ? '#f23645' : '#9aa3b5';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(badge, 15, 15);
  const ts = chart.timeScale(), n = N.raw.length;
  const xOf = (i) => {
    if (i < 0 || i >= n) return null;
    let x = null;
    try { if (typeof ts.logicalToCoordinate === 'function') x = ts.logicalToCoordinate(i); } catch (e) {}
    if (x == null && N.raw[i]) { try { x = ts.timeToCoordinate(N.raw[i].time + TH_OFF); } catch (e) {} }
    return x;
  };
  const stepOf = (i) => {
    const a = xOf(Math.max(0, Math.min(n - 1, i)));
    const b = xOf(Math.max(0, Math.min(n - 1, i + 1)));
    if (a != null && b != null && b !== a) return b - a;
    const c = xOf(0), d = xOf(Math.min(n - 1, 1));
    if (c != null && d != null && d !== c) return d - c;
    return 8;
  };
  for (const p of res.drawn || []){
    if (!isFinite(p.top) || !isFinite(p.bot)) continue;
    const i0 = Math.max(0, Math.min(n - 1, p.i0|0)), i1 = Math.max(i0, Math.min(n - 1, p.i1|0));
    let x0 = xOf(i0), x1 = xOf(i1);
    const step = stepOf(i1);
    if (x0 == null && x1 == null){
      const anchor = xOf(n - 1); if (anchor == null) continue;
      x1 = anchor - (n - 1 - i1) * step; x0 = anchor - (n - 1 - i0) * step;
    } else {
      if (x0 == null) x0 = x1 - (i1 - i0) * step;
      if (x1 == null) x1 = x0 + (i1 - i0) * step;
    }
    const left = Math.min(x0, x1) - Math.abs(step) / 2, right = Math.max(x0, x1) + Math.abs(step) / 2;
    if (right < 0 || left > paneW) continue;
    const yA = cs.priceToCoordinate(p.top), yB = cs.priceToCoordinate(p.bot);
    if (yA == null || yB == null) continue;
    const minH = (p.kind === 'PAIR' || p.kind === 'VBC') ? 8 : 5;
    let top = Math.min(yA, yB), h = Math.abs(yB - yA);
    if (h < minH){ top -= (minH - h) / 2; h = minH; }
    const buy = p.dir === 1, col = p.fade ? '#9aa3b5' : (buy ? '#089981' : '#f23645');
    const fillA = p.fade ? 0.10 : 0.22, lineA = p.fade ? 0.45 : 0.85;
    ctx.beginPath();
    ctx.fillStyle = hexA(col, fillA); ctx.strokeStyle = hexA(col, lineA);
    ctx.lineWidth = 1.25; ctx.setLineDash(p.kind === 'HDB' || /^.[B].$/.test(p.kind) ? [] : [4, 3]);
    ctx.fillRect(left, top, Math.max(2, right - left), h);
    ctx.strokeRect(left + 0.5, top + 0.5, Math.max(2, right - left) - 1, Math.max(1, h - 1));
    ctx.setLineDash([]);
    ctx.font = '700 11px "JetBrains Mono", ui-monospace, sans-serif';
    const text = p.kind, lw = ctx.measureText(text).width;
    let tx = Math.max(4, Math.min(left + 3, paneW - lw - 8));
    let ty = top - 3; if (ty < 28) ty = top + h + 11; if (ty > paneH - 4) ty = Math.max(28, top + 11);
    ctx.fillStyle = 'rgba(13,16,22,0.78)'; ctx.fillRect(tx - 3, ty - 9, lw + 6, 14);
    ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, tx, ty - 2);
  }
  ctx.restore();
}
function hexA(hex, a){
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}
window.__AITD_COACH = { scan: coachScan, scanTf, barsFor: coachBarsFor, get: () => COACH };

/* ---------------- overlay: coach boxes, then Swing Finder and the 1.618 line on top ---------------- */
function drawZones(){
  if (NSW) NSW.refresh();
  refreshCoach();
  const cv = $('nasCanvas'), wrap = $('nasZoneView');
  if (!cs || !wrap || wrap.classList.contains('hidden')) return;
  const dpr = window.devicePixelRatio||1, W = wrap.clientWidth, H = wrap.clientHeight;
  if (cv.width !== W*dpr || cv.height !== H*dpr){ cv.width=W*dpr; cv.height=H*dpr; cv.style.width=W+'px'; cv.style.height=H+'px'; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
  const paneW = chart.timeScale().width(), paneH = H - chart.timeScale().height();
  ctx.save(); ctx.beginPath(); ctx.rect(0,0,paneW,paneH); ctx.clip();
  try { paintCoach(ctx, paneW, paneH); } catch (e) { if (!COACH.err){ COACH.err = String(e && e.stack || e); console.error('coach paint', e); } }
  if (NSW) NSW.paintBack();
  if (NSW) NSW.paintMarks(ctx, paneW, paneH);
  if (NSW) NSW.paint(ctx);
  ctx.restore();
}

/* ---------------- TradingView tab (SKILLING:US100 — the user's MT5 broker feed) ---------------- */
function loadTV(){
  withTV(()=>{
    $('nasTv').innerHTML = '<div id="nasTvInner" style="height:100%"></div>';
    new window.TradingView.widget({
      container_id:'nasTvInner', autosize:true, symbol:'SKILLING:US100', interval:N.tf, timezone:'Asia/Bangkok', theme:'dark', style:'1', locale:'th_TH',
      toolbar_bg:'#0d1016', enable_publishing:false, allow_symbol_change:false, hide_volume:true, withdateranges:false, save_image:false,
      studies:[{id:'BB@tv-basicstudies', inputs:{length:50, src:'hlc3', mult:1.1}}],
      overrides:{'paneProperties.background':'#0d1016','paneProperties.backgroundType':'solid'},
    });
  });
}
function setView(v, auto){
  N.view = v==='tv' ? 'tv' : 'zone'; if (!auto) LS.set('nas_view', N.view);
  document.querySelectorAll('.ntab').forEach(b=>b.classList.toggle('active', b.dataset.nview===N.view));
  $('nasZoneView').classList.toggle('hidden', N.view!=='zone'); $('nasTvView').classList.toggle('hidden', N.view!=='tv');
  if (N.view==='tv' && !$('nasTv').firstChild) loadTV();
  if (N.view==='zone') requestAnimationFrame(drawZones);
}
function setTF(tf){
  N.tf = tf; LS.set('nas_tf', tf);
  document.querySelectorAll('#nasTfs button').forEach(b=>b.classList.toggle('active', b.dataset.tf===tf));
  loadFeed(); if ($('nasTv').firstChild) loadTV();
}

function start(){
  document.querySelectorAll('.ntab').forEach(b=>b.onclick=()=>setView(b.dataset.nview));
  document.querySelectorAll('#nasTfs button').forEach(b=>{ b.classList.toggle('active', b.dataset.tf===N.tf); b.onclick=()=>setTF(b.dataset.tf); });
  wireCal(); wireCoach(); initChart(); setView(N.view);
  // gold first: start NAS when the gold chart has painted, or after 1 s at most
  Promise.race([window.AITD_GOLD_READY || Promise.resolve(), new Promise(r=>setTimeout(r,1000))]).then(()=>{ loadFeed(); });
  setInterval(renderBadge, 2000);
  setInterval(resyncTail, 60000);
  setInterval(()=>{ if (N.feed) loadCoachHist(); }, 60000);
  NTR.start();
  setInterval(()=>{                                        // follow the XYZ100 premium (live offset), unless the user set their own
    if (!N.feed || N.feed.name!=='hl' || N.loading || userOff('hl')!=null) return;
    const v = liveOff(); if (v!=null && Math.abs(v - N.off) >= 0.5) setOff(v); else renderCal();
  }, 5000);
  setInterval(()=>{ if (N.feed) loadDay(N.feed); }, 5*60000);
}
start();
window.__AITD_NAS = N; window.__AITD_NTR = NTR;
})();
