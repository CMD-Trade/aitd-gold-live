/* AiTD Gold Live — client-only. No API keys. */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const TH_OFF = 7 * 3600;                  // chart shows Thai time (UTC+7)
const PPL = 100;                          // $ per $1 move per 1.00 lot (XAUUSD)
const qs = new URLSearchParams(location.search);
const LS = { get:(k,d)=>{try{const v=localStorage.getItem('aitd_'+k);return v===null?d:JSON.parse(v)}catch(e){return d}}, set:(k,v)=>{try{localStorage.setItem('aitd_'+k,JSON.stringify(v))}catch(e){}} };

const fmt = (n, d=2) => (n==null||!isFinite(n)) ? '—' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const sgn = (n, d=2) => (n>0?'+':n<0?'−':'') + fmt(Math.abs(n), d);
const usd = (n) => (n<0?'−$':'$') + fmt(Math.abs(n));
const sUsd = (n) => (n>0?'+$':n<0?'−$':'$') + fmt(Math.abs(n));

const S = {
  zones: null, events: [], tf: LS.get('tf','15'), view: LS.get('view','zone'),
  price: null, prevPrice: null, offset: 0, offsetSamples: [], offsetMode: 'auto',
  spot: null, spotAt: 0, feed: null, raw: [], dayRaw: [], ticks: [], dayHigh: null, dayLow: null,
};

/* ---------------- time helpers ---------------- */
function tzParts(tz, d=new Date()){
  const p = new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'short'}).formatToParts(d);
  const o = {}; p.forEach(x=>o[x.type]=x.value);
  return {y:+o.year,mo:+o.month,d:+o.day,h:+o.hour,mi:+o.minute,s:+o.second,wd:o.weekday,min:(+o.hour)*60+(+o.minute)};
}
function tzOffsetMin(tz, d=new Date()){ const p=tzParts(tz,d); return Math.round((Date.UTC(p.y,p.mo-1,p.d,p.h,p.mi,p.s)-d.getTime())/60000/15)*15; }
const thaiStr = (d, opt) => new Intl.DateTimeFormat('th-TH',Object.assign({timeZone:'Asia/Bangkok'},opt)).format(d);
const hm = (m) => `${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
function dur(ms){ if(ms<0) ms=0; const s=Math.floor(ms/1000), d=Math.floor(s/86400), h=Math.floor(s%86400/3600), m=Math.floor(s%3600/60), x=s%60;
  return (d? d+' วัน ':'') + [h,m,x].map(v=>String(v).padStart(2,'0')).join(':'); }
/* Gold trading day starts 17:00 New York */
function dayStartMs(now=new Date()){
  const ny = tzParts('America/New_York', now), off = tzOffsetMin('America/New_York', now);
  let t = Date.UTC(ny.y,ny.mo-1,ny.d,17,0,0) - off*60000;
  if (t > now.getTime()) t -= 86400000;
  return t;
}
function marketClosed(now=new Date()){
  const ny = tzParts('America/New_York', now);
  return ny.wd==='Sat' || (ny.wd==='Fri' && ny.h>=17) || (ny.wd==='Sun' && ny.h<18);
}
/* Spot gold (OANDA / MT5) is shut Fri 17:00 → Sun 18:00 New York and 17:00–18:00 NY every day.
   The OKX index keeps printing then, so those bars/ticks are dropped to look like a broker chart. */
const NYF = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hourCycle:'h23',weekday:'short',hour:'2-digit'});
function spotClosed(ms){
  let wd='', h=0; for (const x of NYF.formatToParts(new Date(ms))){ if(x.type==='weekday') wd=x.value; else if(x.type==='hour') h=+x.value; }
  return wd==='Sat' || (wd==='Fri' && h>=17) || (wd==='Sun' && h<18) || h===17;
}
/* H4 buckets anchored to the 17:00 New York session open (04:00/08:00/12:00… Thai in US summer time,
   05:00/09:00/13:00… in winter) — same as TradingView OANDA:XAUUSD and MT5 brokers on GMT+2/+3 servers. */
const _dsCache = new Map();
function h4Start(t){
  const hk = Math.floor(t/3600); let ds = _dsCache.get(hk);
  if (ds===undefined){ ds = dayStartMs(new Date(t*1000+1000))/1000; _dsCache.set(hk, ds); if(_dsCache.size>5000) _dsCache.clear(); }
  return ds + Math.floor((t-ds)/14400)*14400;
}
const bucketStart = (t, tf) => tf==='240' ? h4Start(t) : Math.floor(t/TF[tf].s)*TF[tf].s;
function aggregate(bars, tf){
  const out = [];
  for (const b of bars){ const t = bucketStart(b.time, tf), l = out[out.length-1];
    if (l && l.time===t){ l.high=Math.max(l.high,b.high); l.low=Math.min(l.low,b.low); l.close=b.close; }
    else out.push({time:t, open:b.open, high:b.high, low:b.low, close:b.close}); }
  return out;
}

/* ---------------- data files ---------------- */
async function getJSON(url){ const r = await fetch(url + (url.includes('?')?'&':'?') + 'v=' + Date.now(), {cache:'no-store'}); if(!r.ok) throw new Error(url+' '+r.status); return r.json(); }

/* ---------------- clock / sessions / events ---------------- */
const SESS = [
  {k:'asia',  n:'เอเชีย',   tz:'Asia/Tokyo',       o:9*60,  c:18*60},
  {k:'london',n:'ลอนดอน',  tz:'Europe/London',    o:8*60,  c:16*60+30},
  {k:'us',    n:'สหรัฐ',    tz:'America/New_York', o:8*60,  c:17*60},
];
const MYWIN = [[8*60,12*60],[14*60,17*60]];
function sessToThai(s, now){ const off = tzOffsetMin(s.tz, now); const shift = 420 - off; return [(s.o+shift+1440)%1440, (s.c+shift+1440)%1440]; }
function inRange(m,[a,b]){ return a<=b ? (m>=a && m<b) : (m>=a || m<b); }
function tickClock(){
  const now = new Date(), th = tzParts('Asia/Bangkok', now);
  $('clock').textContent = [th.h,th.mi,th.s].map(v=>String(v).padStart(2,'0')).join(':');
  $('clockDate').textContent = thaiStr(now,{weekday:'short',day:'numeric',month:'short'}) + ' · UTC+7';
  const closed = marketClosed(now);
  $('sessions').innerHTML = SESS.map(s=>{ const r=sessToThai(s,now); const on=!closed && inRange(th.min,r);
    return `<div class="sess ${on?'on':''} ${closed?'closed':''}"><b>${s.n}${on?' ●':''}</b>${hm(r[0])}–${hm(r[1])}</div>`; }).join('');
  const inMine = MYWIN.find(w=>inRange(th.min,w));
  const mw = $('myWin');
  if (closed) { mw.className='mywin'; mw.textContent='ตลาดทองปิด (สุดสัปดาห์)'; }
  else if (inMine) { mw.className='mywin on'; mw.textContent=`อยู่ในช่วงเทรดของคุณ ${hm(inMine[0])}–${hm(inMine[1])} · เหลือ ${dur(((inMine[1]-th.min)*60-th.s)*1000).replace(/^00:/,'')}`; }
  else { const nexts = MYWIN.map(w=>((w[0]-th.min+1440)%1440)*60-th.s).sort((a,b)=>a-b);
    mw.className='mywin'; mw.textContent=`ช่วงเทรดของคุณ 08:00–12:00 · 14:00–17:00 · เริ่มอีก ${dur(nexts[0]*1000)}`; }
  tickEvent(now);
}
function tickEvent(now){
  const evs = S.events; if(!evs.length){ $('evTitle').textContent='ไม่มีข้อมูลข่าว'; return; }
  const t = now.getTime();
  const nxt = evs.find(e=> e.ms > t - 5*60000);
  if (!nxt){ $('evTitle').textContent='ไม่มีข่าวแรงที่เหลือในรายการ'; $('evCount').textContent='—'; $('evTime').textContent=''; }
  else {
    const same = evs.filter(e=>e.ms===nxt.ms).map(e=>e.title);
    $('evTitle').textContent = same.join(' · ');
    $('evTime').textContent = thaiStr(new Date(nxt.ms),{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) + ' น. (ไทย)' + (nxt.forecast?` · คาด ${nxt.forecast} ก่อนหน้า ${nxt.previous||'—'}`:'');
    const left = nxt.ms - t, c = $('evCount');
    c.textContent = left>0 ? dur(left) : 'กำลังประกาศ';
    c.classList.toggle('soon', left < 30*60000);
  }
  $('evList').innerHTML = evs.map(e=>`<li class="${e.ms<t?'past':''}"><span>${e.title}</span><span class="t">${thaiStr(new Date(e.ms),{weekday:'short',hour:'2-digit',minute:'2-digit'})}</span></li>`).join('');
}

/* ---------------- spot reference (gold-api.com, CORS *, no key) ---------------- */
async function pollSpot(){
  try{
    const r = await fetch('https://api.gold-api.com/price/XAU', {cache:'no-store'});
    const j = await r.json();
    if (j && j.price){
      const at = Date.parse(j.updatedAt) || Date.now();
      const isNew = at !== S.spotAt;
      S.spot = +j.price; S.spotAt = at;
      if (isNew) sampleOffset();
      if (!S.feed || S.feed.name==='gold-api') onSpotOnlyTick(S.spot, at);
    }
  }catch(e){ /* keep last */ }
  renderFeedInfo();
}
function sampleOffset(){
  if (!S.feed || !S.feed.adjust || !S.ticks.length || S.offsetMode!=='auto') return;
  // feed price closest in time to the spot quote's timestamp
  let best = null; for (const k of S.ticks){ if(!best || Math.abs(k[0]-S.spotAt) < Math.abs(best[0]-S.spotAt)) best = k; }
  if (!best || Math.abs(best[0]-S.spotAt) > 120000) best = S.ticks[S.ticks.length-1];
  S.offsetSamples.push(best[1] - S.spot); if (S.offsetSamples.length > 15) S.offsetSamples.shift();
  const a = [...S.offsetSamples].sort((x,y)=>x-y), med = a[Math.floor(a.length/2)];
  if (Math.abs(med - S.offset) >= 0.05){ S.offset = med; redrawAll(); }
}

/* ---------------- live candle feeds ---------------- */
const TF = { '1':{bn:'1m',okx:'1m',s:60}, '5':{bn:'5m',okx:'5m',s:300}, '15':{bn:'15m',okx:'15m',s:900}, '60':{bn:'1h',okx:'1H',s:3600}, '240':{bn:'4h',okx:'4H',s:14400} };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms))]);

const OKX = 'https://www.okx.com/api/v5/market/';
async function okxGet(url, tries=3){
  for (let i=0;;i++){
    try{ const r = await fetch(url, {cache:'no-store'}); const j = await r.json();
      if (j.code==='0') return j.data; if (j.code!=='50011' || i>=tries-1) throw new Error('okx '+j.code+' '+j.msg); }
    catch(e){ if (i>=tries-1) throw e; }
    await new Promise(r=>setTimeout(r, 400*(i+1)));          // 50011 = rate limit
  }
}
const Feeds = {
  /* PRIMARY: OKX index XAU-USD = spot gold in USD aggregated from spot venues (CORS *, no key).
     Tracks Dukascopy/OANDA spot within ~$0.2-0.4, so no perp→spot offset is needed. */
  okxidx: {
    name:'okxidx', label:'OKX XAU/USD spot index', adjust:false,
    async history(tf, bars=500){
      const base = tf==='240' ? '60' : tf, s = TF[base].s;
      const need = tf==='240' ? 900 : bars, pages = Math.ceil(need/100);
      const end = (Math.floor(Date.now()/1000/s)+1)*s*1000;
      const res = await Promise.all(Array.from({length:pages}, (_,k)=>
        okxGet(`${OKX}history-index-candles?instId=XAU-USD&bar=${TF[base].okx}&limit=100&after=${end - k*100*s*1000}`)));
      const m = new Map();
      for (const page of res) for (const k of page) m.set(+k[0]/1000, {time:+k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4]});
      let raw = [...m.values()].sort((a,b)=>a.time-b.time).filter(b=>!spotClosed(b.time*1000));
      if (tf==='240') raw = aggregate(raw, '240');
      return raw;
    },
    stream(tf, onTick){
      let ws, closed=false, retry=0, ping, poll, last=0;
      const tick = (px, ts) => { if (isFinite(px) && px>0){ last=Date.now(); onTick(px, ts||Date.now()); } };
      const startPoll = () => { if (poll) return; poll = setInterval(async()=>{ try{ const d = await okxGet(`${OKX}index-tickers?instId=XAU-USD`,1); tick(+d[0].idxPx, +d[0].ts); }catch(e){} }, 2000); };
      const stopPoll = () => { if (poll){ clearInterval(poll); poll=null; } };
      const open = () => {
        try{ ws = new WebSocket('wss://ws.okx.com/ws/v5/public'); }catch(e){ startPoll(); return; }
        ws.onopen = ()=>{ ws.send(JSON.stringify({op:'subscribe', args:[{channel:'index-tickers', instId:'XAU-USD'}]})); clearInterval(ping); ping = setInterval(()=>{ try{ws.send('ping')}catch(e){} }, 20000); };
        ws.onmessage = (m)=>{ if (m.data==='pong') return; const j = JSON.parse(m.data); if (j.data && j.data[0]){ retry=0; stopPoll(); tick(+j.data[0].idxPx, +j.data[0].ts); } };
        ws.onclose = ()=>{ clearInterval(ping); if (closed) return; startPoll(); setTimeout(open, Math.min(15000, 1000*(++retry))); };
      };
      open();
      const wd = setInterval(()=>{ if (Date.now()-last > 10000) startPoll(); }, 5000);   // WS silent → REST
      return () => { closed=true; clearInterval(ping); clearInterval(wd); stopPoll(); try{ws.close()}catch(e){} };
    }
  },
  binance: {
    name:'binance', label:'Binance XAUUSDT', adjust:true,
    async history(tf, limit=500){
      const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${TF[tf].bn}&limit=${limit}`);
      if(!r.ok) throw new Error('binance '+r.status);
      return (await r.json()).map(k=>({time:k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4]}));
    },
    stream(tf, onBar){
      let ws, closed=false, retry=0, poll;
      const open = () => {
        ws = new WebSocket(`wss://fstream.binance.com/market/ws/xauusdt@kline_${TF[tf].bn}`);
        ws.onmessage = (m)=>{ retry=0; if(poll){clearInterval(poll);poll=null;} const k = JSON.parse(m.data).k; if(k) onBar({time:k.t/1000, open:+k.o, high:+k.h, low:+k.l, close:+k.c}); };
        ws.onclose = ()=>{ if(closed) return; if(++retry>=1 && !poll) startPoll(); setTimeout(open, Math.min(15000, 1000*retry)); };
      };
      const startPoll = () => { poll = setInterval(async()=>{ try{ const b=await Feeds.binance.history(tf,2); b.forEach(onBar);}catch(e){} }, 3000); };
      open();
      return () => { closed=true; try{ws.close()}catch(e){} clearInterval(poll); };
    }
  },
  okx: {
    name:'okx', label:'OKX XAU-USDT-SWAP', adjust:true,
    async history(tf, limit=300){
      const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=XAU-USDT-SWAP&bar=${TF[tf].okx}&limit=${Math.min(limit,300)}`);
      const j = await r.json(); if (j.code!=='0') throw new Error('okx '+j.msg);
      return j.data.map(k=>({time:+k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4]})).reverse();
    },
    stream(tf, onBar){
      let ws, closed=false, retry=0, ping, poll;
      const open = () => {
        ws = new WebSocket('wss://ws.okx.com/ws/v5/business');
        ws.onopen = ()=>{ ws.send(JSON.stringify({op:'subscribe', args:[{channel:'candle'+TF[tf].okx, instId:'XAU-USDT-SWAP'}]})); ping = setInterval(()=>{ try{ws.send('ping')}catch(e){} }, 20000); };
        ws.onmessage = (m)=>{ if(m.data==='pong') return; retry=0; if(poll){clearInterval(poll);poll=null;} const j=JSON.parse(m.data); (j.data||[]).forEach(k=>onBar({time:+k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4]})); };
        ws.onclose = ()=>{ clearInterval(ping); if(closed) return; if(++retry>=1 && !poll) startPoll(); setTimeout(open, Math.min(15000,1000*retry)); };
      };
      const startPoll = () => { poll = setInterval(async()=>{ try{ (await Feeds.okx.history(tf,2)).forEach(onBar);}catch(e){} }, 3000); };
      open();
      return () => { closed=true; clearInterval(ping); clearInterval(poll); try{ws.close()}catch(e){} };
    }
  },
};
const ORDER = (qs.get('feed') ? [qs.get('feed')] : ['okxidx','binance','okx']).filter(f=>Feeds[f]);

/* ---------------- Lightweight chart ---------------- */
let chart, cs, e20, e50, zoneLines = [], stopStream = null;
function initChart(){
  const LW = window.LightweightCharts;
  chart = LW.createChart($('lwChart'), {
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
  new ResizeObserver(()=>requestAnimationFrame(drawZones)).observe($('zoneView'));
  setInterval(drawZones, 400);   // autoscale changes on ticks
}
const adj = (b) => ({time:b.time + TH_OFF, open:b.open-S.offset, high:b.high-S.offset, low:b.low-S.offset, close:b.close-S.offset});   // S.offset is 0 for the spot index
function ema(data, n){ const k=2/(n+1); let e=null; return data.map(b=>{ e = e===null ? b.close : b.close*k + e*(1-k); return {time:b.time, value:e}; }); }
function redrawAll(){
  if(!cs) return;
  const d = S.raw.map(adj);
  cs.setData(d); e20.setData(ema(d,20)); e50.setData(ema(d,50));
  recomputeDay(); if (S.raw.length) setPrice(S.raw[S.raw.length-1].close - S.offset);
  drawZones();
}
function onBar(b){
  if (!S.raw.length) return;
  const last = S.raw[S.raw.length-1];
  if (b.time < last.time) return;
  if (b.time === last.time) S.raw[S.raw.length-1] = b; else { S.raw.push(b); if (S.raw.length>1500) S.raw.shift(); }
  const a = adj(b); cs.update(a);
  const d = S.raw.slice(-300).map(adj); const x20 = ema(d,20), x50 = ema(d,50);
  e20.update(x20[x20.length-1]); e50.update(x50[x50.length-1]);
  S.ticks.push([Date.now(), b.close]); if (S.ticks.length>600) S.ticks.shift();
  trackDay(b.close - S.offset);
  setPrice(b.close - S.offset);
  S.lastTickAt = Date.now();
}
function onIndexTick(p, ms){
  if (!cs || !S.raw.length || spotClosed(ms)) return;          // broker market shut: keep last close
  const t = bucketStart(Math.floor(ms/1000), S.tf), last = S.raw[S.raw.length-1];
  if (t < last.time) return;
  if (t === last.time){ last.high=Math.max(last.high,p); last.low=Math.min(last.low,p); last.close=p; }
  else { S.raw.push({time:t, open:p, high:p, low:p, close:p}); if (S.raw.length>1500) S.raw.shift(); }
  cs.update(adj(S.raw[S.raw.length-1]));
  const d = S.raw.slice(-300).map(adj); const x20 = ema(d,20), x50 = ema(d,50);
  e20.update(x20[x20.length-1]); e50.update(x50[x50.length-1]);
  trackDay(p); setPrice(p); S.lastTickAt = Date.now();
}
/* every 60 s re-read the newest bars from REST (exact OHLC incl. ticks the browser missed) */
async function resyncTail(){
  const f = S.feed; if (!f || f.name!=='okxidx' || !S.raw.length) return;
  try{
    const tf = S.tf, base = tf==='240' ? '60' : tf, s = TF[base].s, need = tf==='240' ? 5 : 3;
    const d = await okxGet(`${OKX}index-candles?instId=XAU-USD&bar=${TF[base].okx}&limit=${need}`, 1);
    let bars = d.map(k=>({time:+k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4]})).reverse().filter(b=>!spotClosed(b.time*1000));
    if (tf==='240'){ const cur = S.raw[S.raw.length-1].time; bars = aggregate(bars.filter(b=>h4Start(b.time)>=cur), '240'); }
    if (tf!==S.tf || f!==S.feed) return;
    for (const b of bars){
      const i = S.raw.findIndex(x=>x.time===b.time);
      if (i>=0){ if (i===S.raw.length-1){ b.close = S.raw[i].close; b.high=Math.max(b.high,b.close); b.low=Math.min(b.low,b.close); } S.raw[i] = b; }
      else if (b.time > S.raw[S.raw.length-1].time) S.raw.push(b);
    }
    const d2 = S.raw.map(adj); cs.setData(d2); e20.setData(ema(d2,20)); e50.setData(ema(d2,50)); drawZones();
  }catch(e){}
}
function onSpotOnlyTick(p, at){
  if (!cs) return;
  const tfs = TF[S.tf].s, t = Math.floor(at/1000/tfs)*tfs;
  const last = S.raw[S.raw.length-1];
  if (last && last.time===t){ last.high=Math.max(last.high,p); last.low=Math.min(last.low,p); last.close=p; }
  else if (!last || t>last.time) S.raw.push({time:t,open:last?last.close:p,high:Math.max(p,last?last.close:p),low:Math.min(p,last?last.close:p),close:p});
  const b = S.raw[S.raw.length-1]; cs.update(adj(b));
  const d=S.raw.map(adj); e20.setData(ema(d,20)); e50.setData(ema(d,50));
  trackDay(p); setPrice(p); S.lastTickAt = Date.now();
}

/* zone bands drawn on an overlay canvas, aligned with the price scale */
function drawZones(){
  const cv = $('zoneCanvas'), wrap = $('zoneView');
  if (!cs || !S.zones || wrap.classList.contains('hidden')) return;
  const dpr = window.devicePixelRatio||1, W = wrap.clientWidth, H = wrap.clientHeight;
  if (cv.width !== W*dpr || cv.height !== H*dpr){ cv.width=W*dpr; cv.height=H*dpr; cv.style.width=W+'px'; cv.style.height=H+'px'; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
  const paneW = chart.timeScale().width(), paneH = H - chart.timeScale().height();
  const col = {resistance:[239,83,80], support:[38,166,154], pivot:[240,180,41]};
  ctx.save(); ctx.beginPath(); ctx.rect(0,0,paneW,paneH); ctx.clip();
  for (const z of S.zones.zones){
    const y1 = cs.priceToCoordinate(z.zone[1]), y2 = cs.priceToCoordinate(z.zone[0]);
    if (y1==null || y2==null) continue;
    const c = col[z.type]||[139,147,165];
    ctx.fillStyle = `rgba(${c},0.13)`; ctx.fillRect(0, y1, paneW, Math.max(2, y2-y1));
    ctx.strokeStyle = `rgba(${c},0.55)`; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(0,y1+.5); ctx.lineTo(paneW,y1+.5); ctx.moveTo(0,y2-.5); ctx.lineTo(paneW,y2-.5); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = `rgba(${c},0.95)`; ctx.font = '600 11px "IBM Plex Sans Thai", sans-serif';
    const lbl = {resistance:'แนวต้าน',support:'แนวรับ',pivot:'Pivot'}[z.type]||z.type;
    ctx.fillText(`${lbl} ${z.zone[0]}–${z.zone[1]}`, 8, Math.max(12, y1 - 3));
  }
  ctx.restore();
}

async function loadFeed(){
  if (stopStream){ stopStream(); stopStream=null; }
  S.raw = []; S.ticks = []; S.offsetSamples = []; S.offset = 0; $('lwStatus').textContent = 'กำลังโหลด…';
  for (const name of ORDER){
    try{
      const f = Feeds[name];
      const tfAtStart = S.tf;
      const hist = await withTimeout(f.history(S.tf), 8000);
      if (tfAtStart !== S.tf) return;                       // user switched TF meanwhile
      if (!hist.length) throw new Error('empty');
      S.feed = f; S.raw = hist;
      S.ticks.push([Date.now(), hist[hist.length-1].close]);
      S.offset = 0;
      if (f.adjust && S.spot && S.offsetMode==='auto'){ S.offset = hist[hist.length-1].close - S.spot; S.offsetSamples=[S.offset]; }
      redrawAll(); chart.timeScale().scrollToRealTime();
      stopStream = f.stream(S.tf, f.adjust ? onBar : onIndexTick);
      loadDay(f);
      $('lwStatus').textContent = '';
      renderFeedInfo(); return;
    }catch(e){ console.warn('feed fail', name, e); }
  }
  // fallback: spot polling only (+ static seed for M15)
  S.feed = {name:'gold-api', label:'gold-api.com (spot)'}; S.offset = 0;
  if (['15','60','240'].includes(S.tf)){ try{ const s = await getJSON('candles_seed.json'); const c = s.candles.map(c=>({...c})); S.raw = S.tf==='15' ? c : aggregate(c, S.tf); }catch(e){} }
  redrawAll(); if (S.spot) onSpotOnlyTick(S.spot, Date.now());
  $('lwStatus').textContent = 'โหมดสำรอง: อัปเดตจาก spot ทุก ~30 วิ';
  renderFeedInfo();
}
async function loadDay(f){
  try{ S.dayRaw = await f.history('15', 120); recomputeDay(); }catch(e){}
}
function recomputeDay(){
  const t0 = dayStartMs()/1000; let hi=null, lo=null;
  const src = S.dayRaw.length ? S.dayRaw : (S.tf!=='240' ? S.raw : []);
  for (const b of src){ if (b.time + (S.tf==='240'&&!S.dayRaw.length?0:0) < t0) continue; hi = hi==null?b.high:Math.max(hi,b.high); lo = lo==null?b.low:Math.min(lo,b.low); }
  if (hi!=null){ S.dayHigh = hi - S.offset; S.dayLow = lo - S.offset; }
  renderDay();
}
function trackDay(p){ if (S.dayHigh==null){ S.dayHigh=S.dayLow=p; } S.dayHigh=Math.max(S.dayHigh,p); S.dayLow=Math.min(S.dayLow,p); renderDay(); }
function renderDay(){ $('dayHigh').textContent=fmt(S.dayHigh); $('dayLow').textContent=fmt(S.dayLow); $('dayRange').textContent = S.dayHigh!=null? '$'+fmt(S.dayHigh-S.dayLow):'—'; }

/* ---------------- price header ---------------- */
let flashT;
function setPrice(p){
  if (p==null || !isFinite(p)) return;
  S.prevPrice = S.price; S.price = p;
  const el = $('price'); el.textContent = fmt(p);
  if (S.prevPrice!=null && p!==S.prevPrice){ el.classList.remove('up','down'); el.classList.add(p>S.prevPrice?'up':'down'); clearTimeout(flashT); flashT=setTimeout(()=>el.classList.remove('up','down'),700); }
  const pc = S.zones && S.zones.prev_day && S.zones.prev_day.close;
  if (pc){ const c = p-pc; const e=$('chg'); e.className='chg '+(c>=0?'pos':'neg'); e.textContent = `${sgn(c)} (${sgn(c/pc*100)}%) เทียบปิด ${fmt(pc)}`; }
  renderZones(); renderCalc();
  if (!document.hidden) document.title = `${fmt(p)} · XAUUSD · AiTD Gold Live`;
}
function renderFeedInfo(){
  const b = $('feedBadge'), f = S.feed;
  const stale = !S.lastTickAt || Date.now()-S.lastTickAt > 90000;
  if (!f){ b.className='badge'; b.textContent='กำลังเชื่อมต่อ…'; }
  else if (f.name==='gold-api'){ b.className='badge warn'; b.textContent='spot ~30 วิ'; }
  else { b.className = 'badge ' + (stale?'warn':'live'); b.textContent = stale ? 'รอข้อมูล' : 'LIVE'; }
  const spotAge = S.spotAt ? Math.round((Date.now()-S.spotAt)/1000) : null;
  let t = f ? `ราคาจาก ${f.label}` : '';
  if (f && f.adjust) t += ` ปรับฐาน ${S.offset>=0?'−':'+'}${fmt(Math.abs(S.offset))} ให้ตรง spot`;
  if (f && f.name==='okxidx') t += ' (ราคา spot USD ไม่ต้องปรับฐาน)';
  if (S.spot) t += ` · เทียบ gold-api ${fmt(S.spot)} (อัปเดตช้า ~30 วิ, ${spotAge}s ก่อน${S.price!=null && f && f.name!=='gold-api' ? `, ต่าง ${sgn(S.price-S.spot)}` : ''})`;
  if (spotClosed(Date.now())) t += ' · ตลาดทอง spot ปิดอยู่ กราฟหยุดที่ราคาปิดล่าสุด';
  $('feedInfo').textContent = t;
}

/* ---------------- zones panel ---------------- */
function renderZones(){
  if (!S.zones) return;
  const p = S.price, lot = +$('zoneLot').value || 0.1, per = lot*PPL;
  const zs = [...S.zones.zones].sort((a,b)=>b.zone[1]-a.zone[1]);
  const TAG = {resistance:'แนวต้าน', support:'แนวรับ', pivot:'Pivot'};
  let html = '', placed = false;
  for (const z of zs){
    const [lo,hi] = z.zone;
    if (p!=null && !placed && hi < p){ html += `<div class="now-row">ราคา ${fmt(p)}</div>`; placed = true; }
    let dist = '', cls = '';
    if (p!=null){
      if (p>=lo && p<=hi){ cls='inside'; dist = `<b>อยู่ในโซน</b><small>ขอบบน ${sgn(hi-p)} · ล่าง ${sgn(lo-p)}</small>`; }
      else { const edge = p<lo ? lo : hi, d = edge - p; dist = `<b class="${d>0?'pos':'neg'}">${sgn(d)}</b><small>${sUsd(Math.abs(d)*per).replace('+','±')} @${lot} lot</small>`; }
    }
    html += `<div class="zone ${z.type} ${cls}"><span class="tag">${TAG[z.type]||z.type}</span><span class="rng">${lo} – ${hi}</span><span class="dist">${dist}</span>${z.note?`<span class="note">${esc(z.note)}</span>`:''}</div>`;
  }
  if (p!=null && !placed) html += `<div class="now-row">ราคา ${fmt(p)}</div>`;
  $('zones').innerHTML = html;
}
const esc = (s) => String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------------- calculator + account ---------------- */
const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
function todayPL(){ return num('aToday') ?? 0; }
function acct(){ const st = num('aStopIn'); return { balance: num('aBalIn'), floor: num('aFloorIn'), daily_stop: -Math.abs(st ?? 200) }; }
function renderCalc(){
  const lot = +$('cLot').value || 0, E = parseFloat($('cEntry').value), SL = parseFloat($('cSL').value), TP = parseFloat($('cTP').value);
  const acc = acct();
  const dir = isFinite(SL)&&isFinite(E) ? (SL<E?'buy':'sell') : isFinite(TP)&&isFinite(E) ? (TP>E?'buy':'sell') : null;
  const pd = $('cDir'); pd.className = 'pill ' + (dir||''); pd.textContent = dir==='buy'?'Buy':dir==='sell'?'Sell':'—';
  const per = lot*PPL;
  const slD = isFinite(E)&&isFinite(SL) ? Math.abs(E-SL) : null, tpD = isFinite(E)&&isFinite(TP) ? Math.abs(TP-E) : null;
  const risk = slD!=null ? slD*per : null, rew = tpD!=null ? tpD*per : null;
  $('oSLd').textContent = slD!=null ? '$'+fmt(slD) : '—';
  $('oTPd').textContent = tpD!=null ? '$'+fmt(tpD) : '—';
  $('oRisk').textContent = risk!=null ? '−$'+fmt(risk) : '—';
  $('oRew').textContent = rew!=null ? '+$'+fmt(rew) : '—';
  $('oRR').textContent = risk && rew!=null ? '1 : '+fmt(rew/risk) : '—';
  const px = isFinite(E) ? E : S.price;
  $('oMargin').textContent = px ? '$'+fmt(lot*100*px/100) : '—';
  const tp = todayPL(), room = tp - acc.daily_stop;
  if (risk!=null){
    const after = tp - risk, o=$('oDay');
    o.textContent = `${sUsd(after)} / จุดหยุด ${usd(acc.daily_stop)}` + (after < acc.daily_stop ? ' · เกินจุดหยุด' : '');
    o.className = after < acc.daily_stop ? 'neg' : '';
    $('oMaxLot').textContent = slD>0 ? (room>0 ? fmt(Math.floor(room/(slD*PPL)*100)/100) + ' lot' : '0 (ถึงจุดหยุดแล้ว)') + ` · เหลือ $${fmt(Math.max(0,room))}` : '—';
  } else { $('oDay').textContent = `เหลือ $${fmt(Math.max(0,room))} ก่อนชน ${usd(acc.daily_stop)}`; $('oMaxLot').textContent='—'; }
  LS.set('calc',{lot:$('cLot').value,E:$('cEntry').value,SL:$('cSL').value,TP:$('cTP').value});
  renderAccount();
}
function renderAccount(){
  const a = acct(), tp = todayPL(), room = tp - a.daily_stop;
  const buf = (a.balance!=null && a.floor!=null) ? a.balance - a.floor : null;
  $('aBuf').textContent = buf!=null ? '$'+fmt(buf) : '—'; $('aBuf').className = buf!=null && buf<300 ? 'neg' : '';
  $('aRoom').textContent = '$'+fmt(Math.max(0,room)); $('aRoom').className = room<=0 ? 'neg' : '';
  $('aBar').style.width = (Math.min(1, Math.max(0, -tp / -a.daily_stop))*100)+'%';
  $('aState').textContent = (room<=0 ? `ถึงจุดหยุดรายวันแล้ว (${sUsd(tp)})` : `P/L วันนี้ ${sUsd(tp)} · เหลือ $${fmt(room)} ก่อนถึง ${usd(a.daily_stop)}`)
    + (buf!=null ? ` · ห่างเส้นอยู่ $${fmt(buf)}` : '') + ' · เก็บในเครื่องนี้เท่านั้น';
}
/* ---------------- TradingView widgets ---------------- */
function tvEmbed(el, file, cfg){
  el.innerHTML = '';
  const c = document.createElement('div'); c.className='tradingview-widget-container'; c.style.height='100%';
  const w = document.createElement('div'); w.className='tradingview-widget-container__widget'; w.style.height='100%';
  const s = document.createElement('script'); s.src = 'https://s3.tradingview.com/external-embedding/' + file; s.async = true; s.type='text/javascript';
  s.textContent = JSON.stringify(cfg); c.append(w, s); el.append(c);
}
let tvjs;
function loadTVChart(){
  const go = () => {
    $('tvChart').innerHTML = '<div id="tvInner" style="height:100%"></div>';
    new window.TradingView.widget({
      container_id:'tvInner', autosize:true, symbol:'OANDA:XAUUSD', interval:S.tf, timezone:'Asia/Bangkok', theme:'dark', style:'1', locale:'th_TH',
      toolbar_bg:'#0d1016', enable_publishing:false, allow_symbol_change:true, hide_volume:true, withdateranges:false, save_image:false,
      studies:[{id:'MAExp@tv-basicstudies', inputs:{length:20}}, {id:'MAExp@tv-basicstudies', inputs:{length:50}}],
      overrides:{'paneProperties.background':'#0d1016','paneProperties.backgroundType':'solid'},
    });
  };
  if (window.TradingView && window.TradingView.widget) return go();
  if (!tvjs){ tvjs = document.createElement('script'); tvjs.src = 'https://s3.tradingview.com/tv.js'; tvjs.onload = go; document.head.append(tvjs); }
}
const WIDGETS = {
  overview: (el)=>tvEmbed(el,'embed-widget-market-quotes.js',{colorTheme:'dark', isTransparent:true, width:'100%', height:el.clientHeight||470, locale:'th_TH', showSymbolLogo:true,
    symbolsGroups:[{name:'ตลาดที่เกี่ยวกับทอง', symbols:[{name:'OANDA:XAUUSD',displayName:'ทองคำ'},{name:'OANDA:XAGUSD',displayName:'เงิน'},{name:'CAPITALCOM:DXY',displayName:'ดัชนีดอลลาร์ DXY'},{name:'OANDA:USB10YUSD',displayName:'T-Note 10 ปี (สวนทาง yield)'},{name:'TVC:USOIL',displayName:'น้ำมัน WTI'},{name:'OANDA:NAS100USD',displayName:'Nasdaq 100'},{name:'BITSTAMP:BTCUSD',displayName:'Bitcoin'}]}]}),
  calendar: (el)=>tvEmbed(el,'embed-widget-events.js',{colorTheme:'dark', isTransparent:false, width:'100%', height:el.clientHeight||470, locale:'th_TH', importanceFilter:'0,1', countryFilter:'us,eu,gb,cn,jp'}),
};
function loadTape(){
  tvEmbed($('tape'),'embed-widget-tickers.js',{symbols:[{proName:'OANDA:XAUUSD',title:'ทอง'},{proName:'OANDA:XAGUSD',title:'เงิน'},{proName:'CAPITALCOM:DXY',title:'DXY'},{proName:'OANDA:USB10YUSD',title:'T-Note 10Y'},{proName:'TVC:USOIL',title:'น้ำมัน'},{proName:'OANDA:NAS100USD',title:'NQ'},{proName:'BITSTAMP:BTCUSD',title:'BTC'}],
    showSymbolLogo:true, isTransparent:true, colorTheme:'dark', locale:'th_TH'});
}

/* ---------------- UI wiring ---------------- */
function setView(v){
  S.view = v; LS.set('view', v);
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.view===v));
  $('zoneView').classList.toggle('hidden', v!=='zone'); $('tvView').classList.toggle('hidden', v!=='tv');
  $('chartNote').textContent = v==='zone' ? 'โซนจาก zones.json · EMA20/50 คำนวณจากแท่งบนกราฟ · เวลาไทย' : 'TradingView OANDA:XAUUSD เรียลไทม์ · EMA20/50 · โซนดูในรายการด้านล่าง';
  if (v==='tv' && !$('tvChart').firstChild) loadTVChart();
  if (v==='zone') requestAnimationFrame(drawZones);
}
function setTF(tf){
  S.tf = tf; LS.set('tf', tf);
  document.querySelectorAll('#tfs button').forEach(b=>b.classList.toggle('active', b.dataset.tf===tf));
  loadFeed(); if ($('tvChart').firstChild) loadTVChart();
}
function wire(){
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>setView(b.dataset.view));
  document.querySelectorAll('#tfs button').forEach(b=>b.onclick=()=>setTF(b.dataset.tf));
  const c = LS.get('calc', null);
  if (c){ $('cLot').value=c.lot||0.1; $('cEntry').value=c.E||''; $('cSL').value=c.SL||''; $('cTP').value=c.TP||''; }
  const tday = new Date(Date.now()+7*3600e3-(2*60+55)*60e3).toISOString().slice(0,10);   // trading day resets 02:55 Thai
  const keys = {aBalIn:'acct_balance', aFloorIn:'acct_floor', aStopIn:'acct_dailystop', aToday:'pl_'+tday};
  Object.entries(keys).forEach(([id,k])=>{ const v = LS.get(k, ''); if (v!=='' && v!=null) $(id).value = v; $(id).addEventListener('input', ()=>LS.set(k, $(id).value)); });
  if ($('aStopIn').value==='') $('aStopIn').value = 200;
  ['cLot','cEntry','cSL','cTP','aToday','aBalIn','aFloorIn','aStopIn'].forEach(id=>$(id).addEventListener('input', renderCalc));
  $('zoneLot').value = LS.get('zoneLot', 0.1);
  $('zoneLot').addEventListener('input', ()=>{ LS.set('zoneLot', $('zoneLot').value); renderZones(); });
  $('cUseLive').onclick = ()=>{ if (S.price){ $('cEntry').value = S.price.toFixed(2); renderCalc(); } };
  const io = new IntersectionObserver((ents)=>ents.forEach(e=>{ if(e.isIntersecting){ WIDGETS[e.target.dataset.widget](e.target); io.unobserve(e.target);} }), {rootMargin:'300px'});
  document.querySelectorAll('.lazy-widget[data-widget=overview]').forEach(el=>io.observe(el));
  document.querySelectorAll('#tfs button').forEach(b=>b.classList.toggle('active', b.dataset.tf===S.tf));
}

async function main(){
  const [z, e] = await Promise.allSettled([getJSON('zones.json'), getJSON('events.json')]);
  if (z.status==='fulfilled'){ S.zones = z.value; $('zonesDate').textContent = `· ${S.zones.date||''}`; $('zonesMeta').textContent = (S.zones.bias?('มุมมอง: '+S.zones.bias+' · '):'') + 'อัปเดต '+(S.zones.generated_at||S.zones.date||'—'); }
  if (e.status==='fulfilled'){ S.events = (e.value.events||[]).map(x=>({...x, ms:Date.parse(x.time)})).filter(x=>isFinite(x.ms)).sort((x,y)=>x.ms-y.ms); }
  $('buildInfo').textContent = `zones ${S.zones?.date||'—'}`;
  wire(); tickClock(); setInterval(tickClock, 1000);
  WIDGETS.calendar(document.querySelector('[data-widget=calendar]'));   // load first: avoids a TradingView CDN 403 seen when it loads after other TV widgets
  initChart(); setView(S.view);
  await pollSpot(); setInterval(pollSpot, 15000);
  await loadFeed();
  setInterval(renderFeedInfo, 2000);
  setInterval(()=>{ if(S.feed && S.feed.name!=='gold-api') loadDay(S.feed); }, 5*60000);
  setInterval(resyncTail, 60000);
  loadTape(); renderZones(); renderCalc();
  // reload data files every 10 min (daily update script)
  setInterval(async()=>{ try{ S.zones = await getJSON('zones.json'); drawZones(); renderZones(); }catch(e){} }, 600000);
}
main();
window.__AITD = S;
})();
