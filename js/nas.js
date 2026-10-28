/* AiTD Gold Live — NAS100 chart (same look/behaviour as the gold "กราฟ + โซน" chart). Client-only, no API keys.
   Primary feed : OKX index US100-USDT (CORS ok, no key) — REST history-index-candles + WebSocket index-tickers.
                  Checked 28 Oct 2026: tracks CFD NAS100 quotes (Capital.com/Pepperstone/FOREX.com) within ~5-10 pts and
                  closed within ~5 pts of the ^NDX cash close at 16:00 NY. OANDA:NAS100USD ran ~20 pts higher.
   Fallbacks    : Bitget NDX100USDT index (CORS *, ~10-25 pts above OKX) — needed in Thailand, where ISPs block okx.com;
                  OKX US100-USDT-SWAP perp candles (REST poll); if nothing answers, the card switches to the TradingView tab.
   All feeds are requested at once with short timeouts (raceFeeds in app.js); the first good one is shown.
   Bars/ticks inside the broker close (Fri 17:00 → Sun 18:00 NY and the daily 17:00–18:00 NY break) are dropped,
   like the gold chart, because the OKX index keeps printing 24/7.
   Zones        : nas_zones.json "zones" (bands from ^NDX daily levels, built by nas_zones.py). */
(() => {
'use strict';
const L = window.AITD_LIB; if (!L || !document.getElementById('nasCard')) return;
const { $, qs, LS, fmt, sgn, esc, thDT, spotClosed, bucketStart, aggregate, ema, TF, OKX, okxGet, getJSON, withTimeout, withTV, TH_OFF, dayStartMs, bitgetIndex, raceFeeds } = L;
const NEAR = 15;                                   // inline warning when price is inside a band or within this many points
const N = { tf: TF[qs.get('nastf')] ? qs.get('nastf') : (TF[LS.get('nas_tf','15')] ? LS.get('nas_tf','15') : '15'),
  view: LS.get('nas_view','zone'), raw: [], dayRaw: [], price: null, prev: null, feed: null, zones: null, lastTickAt: 0, hi: null, lo: null };

/* ---------------- feeds ---------------- */
const Feeds = {
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
const ORDER = qs.get('nasfeed') && Feeds[qs.get('nasfeed')] ? [qs.get('nasfeed')] : ['okxidx','bitget','perp'];

/* ---------------- chart (same options as the gold chart) ---------------- */
let chart, cs, e20, e50, stop = null;
function initChart(){
  const LW = window.LightweightCharts;
  chart = LW.createChart($('nasLw'), {
    autoSize:true,
    layout:{background:{type:'solid',color:'#0d1016'}, textColor:'#8b93a5', fontFamily:"'JetBrains Mono', monospace", fontSize:11, attributionLogo:true},
    grid:{vertLines:{color:'rgba(255,255,255,0.03)'}, horzLines:{color:'rgba(255,255,255,0.04)'}},
    rightPriceScale:{borderColor:'#232937', scaleMargins:{top:0.08,bottom:0.08}},
    timeScale:{borderColor:'#232937', timeVisible:true, secondsVisible:false, rightOffset:6},
    crosshair:{mode:0},
    localization:{priceFormatter:(p)=>fmt(p,2)},
  });
  cs = chart.addSeries(LW.CandlestickSeries, {upColor:'#26a69a', downColor:'#ef5350', borderVisible:false, wickUpColor:'#26a69a', wickDownColor:'#ef5350', priceFormat:{type:'price',precision:2,minMove:0.01}});
  e20 = chart.addSeries(LW.LineSeries, {color:'#5aa9ff', lineWidth:1.5, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false});
  e50 = chart.addSeries(LW.LineSeries, {color:'#c792ea', lineWidth:1.5, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false});
  chart.timeScale().subscribeVisibleLogicalRangeChange(drawZones);
  new ResizeObserver(()=>requestAnimationFrame(drawZones)).observe($('nasZoneView'));
  setInterval(drawZones, 400);
}
const adj = (b) => ({time:b.time + TH_OFF, open:b.open, high:b.high, low:b.low, close:b.close});
function redraw(){
  const d = N.raw.map(adj); cs.setData(d); e20.setData(ema(d,20)); e50.setData(ema(d,50));
  if (N.raw.length) setPrice(N.raw[N.raw.length-1].close);
  recomputeDay(); drawZones();
}
function updLast(){
  cs.update(adj(N.raw[N.raw.length-1]));
  const d = N.raw.slice(-300).map(adj), x20 = ema(d,20), x50 = ema(d,50);
  e20.update(x20[x20.length-1]); e50.update(x50[x50.length-1]);
}
function onTick(p, ms){
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
    const tf = N.tf; let bars = await f.tail(tf);
    if (tf==='240'){ const cur = N.raw[N.raw.length-1].time; bars = aggregate(bars.filter(b=>bucketStart(b.time,'240')>=cur), '240'); }
    if (tf!==N.tf || f!==N.feed) return;
    for (const b of bars){
      const i = N.raw.findIndex(x=>x.time===b.time);
      if (i>=0){ if (i===N.raw.length-1){ b.close = N.raw[i].close; b.high=Math.max(b.high,b.close); b.low=Math.min(b.low,b.close); } N.raw[i] = b; }
      else if (b.time > N.raw[N.raw.length-1].time) N.raw.push(b);
    }
    const d = N.raw.map(adj); cs.setData(d); e20.setData(ema(d,20)); e50.setData(ema(d,50)); drawZones();
  }catch(e){}
}
async function loadFeed(){
  if (stop){ stop(); stop = null; }
  N.raw = []; $('nasStatus').textContent = 'กำลังโหลด…';
  const tf0 = N.tf;
  N.loading = true;
  const won = await raceFeeds(ORDER, (n)=>withTimeout(Feeds[n].history(N.tf), 6000), L.okxSlow ? 0 : 1000);
  if (tf0 !== N.tf) return;
  N.loading = false;
  if (won){
    const f = Feeds[won.name];
    N.feed = f; N.raw = won.hist; redraw(); chart.timeScale().scrollToRealTime();
    stop = f.stream(onTick); N.lastTickAt = Date.now();
    setTimeout(()=>loadDay(f), 2000);
    $('nasStatus').textContent = won.name==='okxidx' ? '' : 'สำรอง: '+f.label; renderBadge(); return;
  }
  N.feed = null; renderBadge();
  $('nasStatus').textContent = 'โหลดข้อมูล NAS100 ไม่ได้ — เปิดแท็บ TradingView ให้แทน';
  if (N.view==='zone') setView('tv', true);                 // show live TradingView chart instead of an empty one
}
async function loadDay(f){ try{ N.dayRaw = await f.history('15', 120); recomputeDay(); }catch(e){} }
function recomputeDay(){
  const t0 = dayStartMs()/1000; let hi=null, lo=null;
  const src = N.dayRaw.length ? N.dayRaw : (N.tf!=='240' ? N.raw : []);
  for (const b of src){ if (b.time < t0) continue; hi = hi==null?b.high:Math.max(hi,b.high); lo = lo==null?b.low:Math.min(lo,b.low); }
  if (hi!=null){ N.hi = hi; N.lo = lo; }
  renderHL();
}
function trackDay(p){ if (N.hi==null){ N.hi = N.lo = p; } N.hi = Math.max(N.hi,p); N.lo = Math.min(N.lo,p); renderHL(); }
function renderHL(){ $('nasHL').textContent = N.hi!=null ? `${fmt(N.hi)} / ${fmt(N.lo)}` : '—'; }

/* ---------------- price header + inline zone status ---------------- */
let flashT;
function setPrice(p){
  if (p==null || !isFinite(p)) return;
  N.prev = N.price; N.price = p;
  const el = $('nasPrice'); el.textContent = fmt(p);
  if (N.prev!=null && p!==N.prev){ el.classList.remove('up','down'); el.classList.add(p>N.prev?'up':'down'); clearTimeout(flashT); flashT = setTimeout(()=>el.classList.remove('up','down'),700); }
  const pc = N.zones && N.zones.last_close && N.zones.last_close.close;
  if (pc){ const c = p-pc, e = $('nasChg'); e.className = 'chg '+(c>=0?'pos':'neg'); e.textContent = `${sgn(c)} (${sgn(c/pc*100)}%) เทียบปิด ^NDX ${fmt(pc)}`; }
  renderGuard(); renderList();
}
function renderBadge(){
  const b = $('nasBadge'), stale = !N.lastTickAt || Date.now()-N.lastTickAt > 90000;
  if (!N.feed){ b.className='badge'; b.textContent = N.loading ? 'กำลังเชื่อมต่อ…' : 'ไม่มีข้อมูล'; return; }
  if (spotClosed(Date.now())){ b.className='badge warn'; b.textContent='ตลาดปิด'; return; }
  b.className = 'badge ' + (stale?'warn':'live'); b.textContent = stale ? 'รอข้อมูล' : 'LIVE';
}
/* band type follows the live price (a level above price = resistance, below = support), pivot stays pivot */
const typeOf = (z, p) => z.type==='pivot' ? 'pivot' : p==null ? z.type : ((z.zone[0]+z.zone[1])/2 > p ? 'resistance' : 'support');
const zonesArr = () => (N.zones && Array.isArray(N.zones.zones)) ? N.zones.zones : [];
function renderGuard(){
  const el = $('nasGuard'), p = N.price, Z = zonesArr();
  if (p==null || !Z.length){ el.className='nas-guard'; el.textContent = Z.length ? 'กำลังรอราคา NAS100…' : 'ยังไม่มีโซน NAS100 (nas_zones.json)'; return; }
  const dist = (z) => p < z.zone[0] ? z.zone[0]-p : p > z.zone[1] ? p-z.zone[1] : 0;
  const near = Z.filter(z=>z.type!=='pivot' && dist(z) <= NEAR);
  const sup = near.filter(z=>typeOf(z,p)==='support'), res = near.filter(z=>typeOf(z,p)==='resistance');
  const byDist = (a,b)=>dist(a)-dist(b); sup.sort(byDist); res.sort(byDist);
  const below = Z.filter(z=>z.type!=='pivot' && z.zone[1] < p).sort((a,b)=>b.zone[1]-a.zone[1])[0];
  const above = Z.filter(z=>z.type!=='pivot' && z.zone[0] > p).sort((a,b)=>a.zone[0]-b.zone[0])[0];
  const lv = (z) => `<b>${fmt(z.level ?? (z.zone[0]+z.zone[1])/2)}</b> ${esc(z.label||'')}`;
  const st = sup.length && res.length ? 'both' : sup.length ? 'support' : res.length ? 'resistance' : 'neutral';
  el.className = 'nas-guard ' + st;
  const closed = spotClosed(Date.now()) ? ' · ตลาดปิด (ราคาล่าสุด)' : '';
  if (st==='support') el.innerHTML = `⚠️ NAS100 อยู่ที่แนวรับ ${lv(sup[0])} — ห้าม SELL · รอแท่งกลับตัว M15${closed}`;
  else if (st==='resistance') el.innerHTML = `⚠️ NAS100 อยู่ที่แนวต้าน ${lv(res[0])} — ห้าม BUY · รอแท่งกลับตัว M15${closed}`;
  else if (st==='both') el.innerHTML = `⚠️ NAS100 ติดทั้งแนวรับ ${lv(sup[0])} และแนวต้าน ${lv(res[0])} — รอราคาหลุด/ทะลุ${closed}`;
  else el.innerHTML = `NAS100 อยู่กลางทาง · แนวรับใกล้สุด ${below?`${lv(below)} (ห่าง ${fmt(p-below.zone[1],1)})`:'—'} · แนวต้านใกล้สุด ${above?`${lv(above)} (ห่าง ${fmt(above.zone[0]-p,1)})`:'—'} · เกณฑ์ ±${NEAR} จุด${closed}`;
}

/* ---------------- zone bands on the overlay canvas (same drawing as gold) ---------------- */
function drawZones(){
  const cv = $('nasCanvas'), wrap = $('nasZoneView');
  if (!cs || wrap.classList.contains('hidden')) return;
  const dpr = window.devicePixelRatio||1, W = wrap.clientWidth, H = wrap.clientHeight;
  if (cv.width !== W*dpr || cv.height !== H*dpr){ cv.width=W*dpr; cv.height=H*dpr; cv.style.width=W+'px'; cv.style.height=H+'px'; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
  const paneW = chart.timeScale().width(), paneH = H - chart.timeScale().height();
  const col = {resistance:[239,83,80], support:[38,166,154], pivot:[240,180,41]};
  const TAG = {resistance:'แนวต้าน', support:'แนวรับ', pivot:'Pivot'};
  ctx.save(); ctx.beginPath(); ctx.rect(0,0,paneW,paneH); ctx.clip();
  const used = [];                                             // label y positions already taken (bands can sit close together)
  for (const z of [...zonesArr()].sort((a,b)=>b.zone[1]-a.zone[1])){
    const y1 = cs.priceToCoordinate(z.zone[1]), y2 = cs.priceToCoordinate(z.zone[0]);
    if (y1==null || y2==null) continue;
    const t = typeOf(z, N.price), c = col[t]||[139,147,165];
    ctx.fillStyle = `rgba(${c},0.13)`; ctx.fillRect(0, y1, paneW, Math.max(2, y2-y1));
    ctx.strokeStyle = `rgba(${c},0.55)`; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(0,y1+.5); ctx.lineTo(paneW,y1+.5); ctx.moveTo(0,y2-.5); ctx.lineTo(paneW,y2-.5); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = `rgba(${c},0.95)`; ctx.font = '600 11px "IBM Plex Sans Thai", sans-serif';
    let ly = Math.max(12, y1 - 3);
    if (used.some(u=>Math.abs(u-ly) < 13)) ly = y2 + 12;                           // collides: put it under the band
    if (used.some(u=>Math.abs(u-ly) < 13)) continue;                              // still collides: band only
    used.push(ly);
    ctx.fillText(`${TAG[t]||t} ${fmt(z.level ?? (z.zone[0]+z.zone[1])/2)} · ${z.label||''}`, 8, ly);
  }
  ctx.restore();
}

/* ---------------- level list (collapsible) ---------------- */
function renderList(){
  const box = $('nasZones'), Z = N.zones; if (!box) return;
  if (!Z || !zonesArr().length){ box.innerHTML = '<div class="sub">ยังไม่มีข้อมูล nas_zones.json</div>'; $('nasMeta').textContent=''; return; }
  const p = N.price, TAG = {resistance:'แนวต้าน', support:'แนวรับ', pivot:'Pivot'};
  const zs = [...zonesArr()].sort((a,b)=>b.zone[1]-a.zone[1]);
  let html = '', placed = false;
  for (const z of zs){
    const lv = z.level ?? (z.zone[0]+z.zone[1])/2, t = typeOf(z, p);
    if (p!=null && !placed && lv < p){ html += `<div class="now-row">ราคา ${fmt(p)}</div>`; placed = true; }
    html += `<div class="zone ${t} ${p!=null && p>=z.zone[0] && p<=z.zone[1] ? 'inside':''}"><span class="tag">${TAG[t]||esc(t)}</span><span class="rng">${fmt(lv)}</span><span class="note">${esc(z.label||'')}${p!=null?` · ห่าง ${sgn(lv-p,1)}`:''}</span></div>`;
  }
  if (p!=null && !placed) html += `<div class="now-row">ราคา ${fmt(p)}</div>`;
  box.innerHTML = html;
}
function renderMeta(){
  const Z = N.zones; if (!Z) return;
  $('nasDate').textContent = Z.last_close ? `· ^NDX ปิด ${Z.last_close.date}` : '';
  const ageH = (Date.now() - Date.parse(Z.generated_at)) / 3600e3, pd = Z.prev_day, wk = Z.week, pw = Z.prev_week;
  let m = `ข้อมูล ^NDX ปิดวันที่ ${esc(Z.last_close?.date||Z.date)} (นิวยอร์ก)`;
  if (pd) m += ` · เมื่อวาน H ${fmt(pd.high)} / L ${fmt(pd.low)} / C ${fmt(pd.close)}`;
  if (wk) m += ` · สัปดาห์นี้ H ${fmt(wk.high)} / L ${fmt(wk.low)}`;
  if (pw) m += ` · สัปดาห์ก่อน H ${fmt(pw.high)} / L ${fmt(pw.low)}`;
  m += ` · แถบบนกราฟ = ระดับ ±10 จุด · อัปเดต ${thDT(Z.generated_at)}`;
  if (isFinite(ageH) && ageH > 96) m += ' · ⚠️ ข้อมูลเก่าเกิน 4 วัน';
  $('nasMeta').textContent = m;
}
async function loadZones(){
  try{ const z = await getJSON('nas_zones.json');
    if (!Array.isArray(z.zones) && Array.isArray(z.levels)) z.zones = z.levels.map(l=>({zone:[l.price-10, l.price+10], type:l.type, level:l.price, label:l.label}));   // older file
    N.zones = z; }catch(e){}
  renderMeta(); renderList(); renderGuard(); drawZones(); if (N.price!=null) setPrice(N.price);
}

/* ---------------- TradingView tab (OANDA:NAS100USD) ---------------- */
function loadTV(){
  withTV(()=>{
    $('nasTv').innerHTML = '<div id="nasTvInner" style="height:100%"></div>';
    new window.TradingView.widget({
      container_id:'nasTvInner', autosize:true, symbol:'OANDA:NAS100USD', interval:N.tf, timezone:'Asia/Bangkok', theme:'dark', style:'1', locale:'th_TH',
      toolbar_bg:'#0d1016', enable_publishing:false, allow_symbol_change:false, hide_volume:true, withdateranges:false, save_image:false,
      studies:[{id:'MAExp@tv-basicstudies', inputs:{length:20}}, {id:'MAExp@tv-basicstudies', inputs:{length:50}}],
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
  initChart(); setView(N.view); loadZones();
  // gold first: start NAS when the gold chart has painted, or after 1 s at most
  Promise.race([window.AITD_GOLD_READY || Promise.resolve(), new Promise(r=>setTimeout(r,1000))]).then(loadFeed);
  setInterval(renderBadge, 2000);
  setInterval(resyncTail, 60000);
  setInterval(()=>{ if (N.feed) loadDay(N.feed); }, 5*60000);
  setInterval(loadZones, 600000);
}
start();
window.__AITD_NAS = N;
})();
