/* AiTD Gold Live — client-only. No API keys. */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const TH_OFF = 7 * 3600;                  // chart shows Thai time (UTC+7)
const PPL = 100;                          // $ per $1 move per 1.00 lot (XAUUSD)
const qs = new URLSearchParams(location.search);
/* ---- Zone guard settings ---- */
const ZONE_NEAR_USD = 3;                  // banner fires when price is inside a level/zone or within this many $ of it
const ALERT_COOLDOWN_MS = 60000;          // min gap between two beeps/notifications for the same state
const CHECK_EXPIRE_MIN = 30;              // pre-trade checklist ticks auto-clear after this many minutes
const TEST_PRICE = parseFloat(qs.get('testprice'));   // debug: ?testprice=4030 forces the banner/checklist price (chart unaffected)
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
    const j = await fetchJSON('https://api.gold-api.com/price/XAU', 5000);
    if (j && j.price){
      const at = Date.parse(j.updatedAt) || Date.now();
      const isNew = at !== S.spotAt;
      S.spot = +j.price; S.spotAt = at;
      if (isNew) sampleOffset();
      if ((!S.feed || S.feed.name==='gold-api') && !refFresh()) onSpotOnlyTick(S.spot, at);
    }
  }catch(e){ /* keep last */ }
  renderFeedInfo();
}
function sampleOffset(){            // gold-api.com (~30 s lag) is only the backup reference when the OANDA quote is unreachable
  if (!S.feed || !S.feed.adjust || !S.ticks.length || S.offsetMode!=='auto' || refFresh()) return;
  if (Date.now() - S.spotAt > 120000) return;                    // stale quote (market shut / API stuck)
  // feed price closest in time to the spot quote's timestamp
  let best = null; for (const k of S.ticks){ if(!best || Math.abs(k[0]-S.spotAt) < Math.abs(best[0]-S.spotAt)) best = k; }
  if (!best || Math.abs(best[0]-S.spotAt) > 120000) best = S.ticks[S.ticks.length-1];
  S.offsetSamples.push(best[1] - S.spot); if (S.offsetSamples.length > 15) S.offsetSamples.shift();
  if (S.offSrc==='static' && S.offsetSamples.length < 3) return;   // gold-api is noisy: need 3 samples before it overrides the static offset
  // gold-api lags spot by up to ~30 s, so on its own it can be $2–3 off in a fast market: keep it within ±$1.5 of the measured static offset
  const st = STATIC_OFF[S.feed.name], m = median(S.offsetSamples);
  setOffset(st==null ? m : Math.min(st+1.5, Math.max(st-1.5, m)), 'gold-api');
}

/* ---------------- OANDA spot reference (TradingView quote endpoint, CORS ok, no key) ----------------
   The backup feeds are not spot: Binance/OKX XAUUSDT perps are quoted in USDT (+ funding basis) and the Bitget
   XAUUSDT index is built from tokenised gold, so they sit ~$4–8 above OANDA / MT5. Every new OANDA:XAUUSD quote
   (polled every 5 s) is compared with the feed price and shift candles, header price, zone distances and the Volume Profile by
   median(feed − OANDA) of the last 9 samples. gold-api.com is the second reference; until the first sample arrives
   a per-source static offset (measured 29 Oct 2026 01:00–01:10 Thai) is used, so the first paint is already close. */
const STATIC_OFF = { binance: 7.5, okx: 7.8, bitget: 4.0 };
const REF_URL = 'https://scanner.tradingview.com/symbol?symbol=OANDA:XAUUSD&fields=close';
S.ref = null; S.refAt = 0; S.refSamples = []; S.offSrc = ''; S.refPrevPoll = 0;
const median = (a) => { const x = [...a].sort((p,q)=>p-q), n = x.length; return n%2 ? x[(n-1)/2] : (x[n/2-1]+x[n/2])/2; };
const refFresh = () => S.refSamples.length > 0 && Date.now() - S.refAt < 60000;
/* the quote endpoint refreshes only every ~10–20 s, so a sample is taken only when the OANDA price changes, paired with
   the mean feed price since the previous poll (the quote was snapped somewhere in that window) */
function feedPriceIn(a, b){
  const v = S.ticks.filter(k=>k[0]>=a && k[0]<=b).map(k=>k[1]);
  if (v.length) return v.reduce((x,y)=>x+y,0)/v.length;
  const last = S.ticks[S.ticks.length-1];                       // no tick in the window: last price if still recent
  return last && b - last[0] <= 15000 ? last[1] : null;
}
function setOffset(v, src){
  if (!isFinite(v)) return; S.offSrc = src;
  if (Math.abs(v - S.offset) >= 0.05){ S.offset = v; redrawAll(); try{ GVP.realign(); }catch(e){} }
}
async function pollRef(){
  if (spotClosed(Date.now())) return;                            // OANDA quote frozen while the market is shut
  try{
    const t0 = Date.now(), j = await fetchJSON(REF_URL, 4000), t1 = Date.now(), p = j && +j.close;
    if (!(p > 500)) return;
    const prevPoll = S.refPrevPoll || t0 - 5000, changed = p !== S.ref; S.refPrevPoll = t1;
    const f = S.feed; S.ref = p;
    if (f && f.name==='gold-api'){ S.refAt = t1; S.refSamples = [0]; onSpotOnlyTick(p, t1); return; }   // spot-only mode: OANDA is faster than gold-api
    if (!f || !f.adjust || S.offsetMode!=='auto'){ S.refAt = t1; return; }
    if (!changed && S.refSamples.length){ S.refAt = t1; return; }   // same snapshot as last time: nothing new to measure
    const fp = feedPriceIn(prevPoll, t1); if (fp == null) return;
    S.refAt = t1; S.refSamples.push(fp - p); if (S.refSamples.length > 9) S.refSamples.shift();
    setOffset(median(S.refSamples), 'OANDA');
  }catch(e){ /* blocked / offline: gold-api or static offset stays */ }
}

/* ---------------- live candle feeds ---------------- */
const TF = { '1':{bn:'1m',okx:'1m',s:60}, '5':{bn:'5m',okx:'5m',s:300}, '15':{bn:'15m',okx:'15m',s:900}, '30':{bn:'30m',okx:'30m',s:1800}, '60':{bn:'1h',okx:'1H',s:3600}, '240':{bn:'4h',okx:'4H',s:14400} };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms))]);

/* every network call gets a hard timeout: a blocked host (OKX is blocked by Thai ISPs since 28 Jun 2025) can hang
   for 20+ s instead of failing, which is what kept the badges on "กำลังเชื่อมต่อ…" */
async function fetchJSON(url, ms=4000){
  const ac = new AbortController(), t = setTimeout(()=>ac.abort(), ms);
  try{ const r = await fetch(url, {cache:'no-store', signal:ac.signal}); if (!r.ok) throw new Error(url+' '+r.status); return await r.json(); }
  finally{ clearTimeout(t); }
}
const OKX = 'https://www.okx.com/api/v5/market/';
async function okxGet(url, tries=3){
  for (let i=0;;i++){
    const j = await fetchJSON(url, 4000);                       // network error / timeout → fail fast, no retry
    if (j.code==='0') return j.data;
    if (j.code!=='50011' || i>=tries-1) throw new Error('okx '+j.code+' '+j.msg);
    await new Promise(r=>setTimeout(r, 400*(i+1)));          // 50011 = rate limit
  }
}
/* Bitget index candles (CORS *, no key) — backup when OKX is unreachable. history-index-candles: max 200 bars/request, ascending. */
const BG = 'https://api.bitget.com/api/v2/mix/market/';
const BG_TF = { '1':'1m', '5':'5m', '15':'15m', '30':'30m', '60':'1H' };
async function bgGet(path){ const j = await fetchJSON(BG+path, 4000); if (j.code!=='00000') throw new Error('bitget '+j.code+' '+j.msg); return j.data; }
function bitgetIndex(symbol, label, adjust){
  return {
    name:'bitget', label, adjust, ticks:true,
    async history(tf, bars=500){
      const base = tf==='240' ? '60' : tf, s = TF[base].s;
      const need = tf==='240' ? 900 : bars, pages = Math.ceil(need/200);
      const end = (Math.floor(Date.now()/1000/s)+1)*s*1000;
      const res = await Promise.all(Array.from({length:pages}, (_,k)=>
        bgGet(`history-index-candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${BG_TF[base]}&limit=200&endTime=${end - k*200*s*1000}`)));
      const m = new Map();
      for (const page of res) for (const k of page||[]) m.set(+k[0]/1000, {time:+k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4]});
      let raw = [...m.values()].sort((a,b)=>a.time-b.time).filter(b=>!spotClosed(b.time*1000));
      if (tf==='240') raw = aggregate(raw, '240');
      return raw;
    },
    stream(tf, onTick){
      const iv = setInterval(async()=>{ try{ const d = await bgGet(`symbol-price?symbol=${symbol}&productType=USDT-FUTURES`); onTick(+d[0].indexPrice, +d[0].ts); }catch(e){} }, 2000);
      return () => clearInterval(iv);
    }
  };
}
/* start every candidate feed at once and keep the best one that answers: a higher-priority feed gets `grace` ms
   after a lower one has data, so a slow/blocked primary never stalls the chart (before: 8–10 s timeout per feed, one by one) */
function raceFeeds(order, run, grace=1000){
  return new Promise((resolve)=>{
    const st = order.map(()=>({done:false, ok:false, v:null})); let timer = null, fin = false;
    const decide = (force)=>{
      if (fin) return;
      for (let i=0;i<order.length;i++){
        if (st[i].ok){ fin = true; clearTimeout(timer); return resolve({name:order[i], hist:st[i].v}); }
        if (!st[i].done && !force){ if (st.some(x=>x.ok) && !timer) timer = setTimeout(()=>decide(true), grace); return; }
      }
      if (st.every(x=>x.done)){ fin = true; clearTimeout(timer); resolve(null); }
    };
    order.forEach((n,i)=>Promise.resolve().then(()=>run(n)).then(v=>{ if (!v || !v.length) throw new Error('empty'); st[i].ok = true; st[i].v = v; })
      .catch(e=>console.warn('feed fail', n, e && e.message || e)).finally(()=>{ st[i].done = true; decide(false); }));
  });
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
      last = Date.now();                                                                // REST snapshot is already on screen
      const wd = setInterval(()=>{ if (Date.now()-last > 5000) startPoll(); }, 2500);   // WS silent/blocked → REST poll
      return () => { closed=true; clearInterval(ping); clearInterval(wd); stopPoll(); try{ws.close()}catch(e){} };
    }
  },
  binance: {
    name:'binance', label:'Binance XAUUSDT', adjust:true,
    async history(tf, limit=500){
      const j = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${TF[tf].bn}&limit=${limit}`);
      return j.map(k=>({time:k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4]}));
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
      const j = await fetchJSON(`https://www.okx.com/api/v5/market/candles?instId=XAU-USDT-SWAP&bar=${TF[tf].okx}&limit=${Math.min(limit,300)}`);
      if (j.code!=='0') throw new Error('okx '+j.msg);
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
  bitget: bitgetIndex('XAUUSDT', 'Bitget XAUUSDT index (สำรอง)', true),
};
const ORDER = (qs.get('feed') ? [qs.get('feed')] : ['okxidx','binance','bitget','okx']).filter(f=>Feeds[f]);

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
  S.ticks.push([Date.now(), p]); if (S.ticks.length>600) S.ticks.shift();
  trackDay(p - S.offset); setPrice(p - S.offset); S.lastTickAt = Date.now();
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
  if (!cs || wrap.classList.contains('hidden')) return;
  const dpr = window.devicePixelRatio||1, W = wrap.clientWidth, H = wrap.clientHeight;
  if (cv.width !== W*dpr || cv.height !== H*dpr){ cv.width=W*dpr; cv.height=H*dpr; cv.style.width=W+'px'; cv.style.height=H+'px'; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
  const paneW = chart.timeScale().width(), paneH = H - chart.timeScale().height();
  const col = {resistance:[239,83,80], support:[38,166,154], pivot:[240,180,41]};
  ctx.save(); ctx.beginPath(); ctx.rect(0,0,paneW,paneH); ctx.clip();
  drawVP(ctx, paneW, paneH);
  for (const z of (S.zones ? S.zones.zones : [])){
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


/* ---------------- option OI levels (options_levels.json; proxies: Cboe GLD + SHFE au) ---------------- */
const OPT_STYLE = {
  gld:  {call:'#b388ff', put:'#2ec4b6', mp:'#ffd54f', ls:2, w:1, tag:'GLD'},     // dashed
  shfe: {call:'#e0b3ff', put:'#7fe3d6', mp:'#ffb74d', ls:1, w:1, tag:'SH'},      // dotted, lighter
};
/* expiry clock: GLD options stop at 16:00 New York on the expiry date; SHFE au options ≈ 15:00 Beijing on the 5th-last
   weekday of the month before the futures month (estimate, Chinese holidays ignored). Expired blocks are hidden/labelled
   on the site even if options_levels.json has not been rebuilt yet (weekend, failed run). */
function nyCloseMs(ymd){                                       // 16:00 America/New_York on that date
  const [y,m,d] = ymd.split('-').map(Number); let t = Date.UTC(y, m-1, d, 20);   // EDT guess
  const p = tzParts('America/New_York', new Date(t)); return t + (16 - p.h)*3600e3;
}
function shfeLastTrade(series){                                // 'au2612' → '2026-11-24'
  const m = /(\d{2})(\d{2})$/.exec(series||''); if (!m) return null;
  let y = 2000 + +m[1], mo = +m[2] - 1; if (mo === 0){ mo = 12; y--; }
  let d = new Date(Date.UTC(y, mo, 0)), n = 0;                 // last day of month mo
  for (;;){ if (d.getUTCDay()%6){ if (++n === 5) break; } d = new Date(d - 86400e3); }
  return d.toISOString().slice(0,10);
}
function optExpMs(src, e){
  if (src==='gld') return e.expiry ? nyCloseMs(e.expiry) : null;
  const lt = e.expiry_est || shfeLastTrade(e.series); return lt ? Date.parse(lt+'T15:00:00+08:00') : null;
}
const optAlive = (src, e, now=optNow()) => { const t = optExpMs(src, e); return t==null || now < t; };
const optNow = () => S.optNowOverride ?? Date.now();            // ?optnow=ISO for testing the roll
if (qs.get('optnow')) S.optNowOverride = Date.parse(qs.get('optnow'));
const optFront = (src, b) => (b && b.expiries || []).find(e=>optAlive(src, e)) || null;   // first not-yet-expired block
let optLines = [];
S.opt = null; S.optTab = qs.get('opt') || LS.get('optTab','gld'); S.optOn = {gld: LS.get('opt_gld', true), shfe: LS.get('opt_shfe', true)};
function drawOptLines(){
  if (!cs) return;
  optLines.forEach(l=>{ try{ cs.removePriceLine(l); }catch(e){} }); optLines = [];
  if (!S.opt) return;
  for (const src of ['gld','shfe']){
    const b = S.opt[src], st = OPT_STYLE[src];
    if (!S.optOn[src] || !b || !b.expiries || !b.expiries.length) continue;
    const e = optFront(src, b); if (!e) continue;               // first NOT expired block only (front weekly / active series)
    const add = (price, color, title, ls) => optLines.push(cs.createPriceLine({price, color, lineWidth:st.w, lineStyle:ls, axisLabelVisible:true, title}));
    (e.call_walls||[]).forEach(w=>add(w.level_spot, st.call, `${st.tag} C${w.strike}`, st.ls));
    (e.put_walls||[]).forEach(w=>add(w.level_spot, st.put, `${st.tag} P${w.strike}`, st.ls));
    if (e.max_pain) add(e.max_pain.level_spot, st.mp, `${st.tag} MaxPain`, src==='gld'?3:1);
  }
}
const thDT = (iso) => { if(!iso) return '—'; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString('th-TH',{timeZone:'Asia/Bangkok', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'}) + ' น.'; };
function renderOpt(){
  document.querySelectorAll('.otab').forEach(b=>b.classList.toggle('active', b.dataset.src===S.optTab));
  const body = $('optBody');
  if (!S.opt){ body.innerHTML = '<div class="sub">ยังไม่มีข้อมูล options_levels.json</div>'; return; }
  $('optGen').textContent = '· อัปเดต ' + thDT(S.opt.generated_at);
  const src = S.optTab, b = S.opt[src];
  if (!b || !b.expiries || !b.expiries.length){ body.innerHTML = `<div class="sub">ไม่มีข้อมูล ${src.toUpperCase()} ${b&&b.error?('('+esc(b.error)+')'):''}</div>`; return; }
  const c = b.conversion || {}, p = S.price;
  const stale = b.stale ? `<span class="badge warn">ข้อมูลเก่า (ดึงล่าสุดไม่สำเร็จ ${thDT(b.failed_at)})</span>` : '';
  const unit = src==='gld' ? '$/หุ้น GLD' : 'หยวน/กรัม';
  const dist = (lv) => p!=null ? `<small>${sgn(lv-p)}</small>` : '';
  const row = (t, cls, w) => `<span class="t ${cls}">${t}</span><span class="lv">${fmt(w.level_spot)}</span><span class="k2">${w.strike}</span><span class="oi">OI ${fmt(w.oi,0)}${w.oi_chg!=null?` <small>(${w.oi_chg>=0?'+':''}${fmt(w.oi_chg,0)})</small>`:''} ${dist(w.level_spot)}</span>`;
  let html = '';
  const now = optNow(), live = b.expiries.filter(e=>optAlive(src, e, now)), gone = b.expiries.filter(e=>!optAlive(src, e, now));
  const tTH = (ms) => new Date(ms).toLocaleString('th-TH',{timeZone:'Asia/Bangkok', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'}) + ' น.';
  const show = live.length ? live : b.expiries;                 // everything expired → still show, labelled
  if (gone.length && live.length) html += `<div class="ometa oroll" style="grid-column:1/-1"><span class="badge warn">หมดอายุแล้ว</span> ${gone.map(e=>src==='gld'?e.expiry:e.series).join(', ')} — ซ่อนแล้ว แสดงสัญญาถัดไปแทน · ไฟล์จะอัปเดตเองรอบถัดไป</div>`;
  for (const e of show){
    const xt = optExpMs(src, e), dead = xt!=null && now >= xt, hrs = xt!=null ? (xt-now)/3600e3 : null;
    const name = src==='gld' ? `หมดอายุ ${e.expiry}` : `ซีรีส์ ${e.series}${xt!=null?` <small>(หมดอายุ ≈ ${e.expiry_est || shfeLastTrade(e.series)})</small>`:''}`;
    const kind = {'front weekly':'รายสัปดาห์ใกล้สุด','next weekly':'รายสัปดาห์ถัดไป','monthly':'รายเดือน','front weekly + monthly':'รายสัปดาห์+รายเดือน','active (largest OI)':'สัญญาหลัก (OI มากสุด)','front':'สัญญาใกล้สุด'}[e.kind]||e.kind;
    const xb = dead ? `<span class="badge warn">หมดอายุแล้ว — รอข้อมูลรอบใหม่</span>`
             : (hrs!=null && hrs <= 24) ? `<span class="badge warn">หมดอายุ ${tTH(xt)}</span>` : '';
    const L = [...(e.call_walls||[]).map(w=>['Call wall','call',w]), ...(e.put_walls||[]).map(w=>['Put wall','put',w])];
    if (e.max_pain) L.push(['Max pain','mp',{...e.max_pain, oi:null}]);
    L.sort((a,b)=>b[2].level_spot-a[2].level_spot || (a[1]==='mp'?-1:1));       // price ladder, high -> low
    let rows = '', placed = false;
    for (const [t,c,w] of L){
      if (p!=null && !placed && w.level_spot < p){ rows += `<div class="now-row" style="grid-column:1/-1">ราคา ${fmt(p)}</div>`; placed = true; }
      rows += row(t,c,w).replace('OI —','');
    }
    if (p!=null && !placed) rows += `<div class="now-row" style="grid-column:1/-1">ราคา ${fmt(p)}</div>`;
    html += `<div class="oexp${dead?' dead':''}"><h4>${name} <small>${kind}</small> ${xb}</h4>
      <div class="ostats"><span>P/C OI <b>${e.pc_oi_ratio??'—'}</b></span><span>Call OI <b>${fmt(e.call_oi_total,0)}</b></span><span>Put OI <b>${fmt(e.put_oi_total,0)}</b></span><span>อ้างอิง <b>${e.underlying}</b> ${unit}</span></div>
      <div class="olv"><span class="ometa">ระดับ (spot XAUUSD) · strike (${unit}) · OI (เปลี่ยนแปลง) · ระยะจากราคา — แสดงเฉพาะ strike ภายใน ±${e.window_pct}% ของราคาอ้างอิง</span>${rows}</div></div>`;
  }
  const conv = src==='gld'
    ? `แปลงด้วย spot/GLD = ${c.spot} / ${c.gld_price} = ${c.ratio} (spot OKX ${thDT(c.spot_time)})`
    : `แปลงด้วย spot/au = ${c.spot} / ${Object.values(c.series||{}).map(x=>x.au_close_cny_g+' ('+x.au_future+')').join(', ')} → ×${Object.values(c.series||{}).map(x=>x.ratio).join(', ')} · USDCNY ${c.usdcny} · ส่วนต่าง SHFE เทียบ spot ${Object.values(c.series||{}).map(x=>sgn(x.premium_usd_oz_vs_spot)+' $/oz').join(', ')}`;
  html += `<div class="ometa">${stale} ข้อมูลวันที่ <b>${b.data_date}</b> · ${esc(b.source)} · ${esc(b.oi_note||'')} · ${conv} · ดึงเมื่อ ${thDT(b.fetched_at)}</div>`;
  body.innerHTML = html;
}
async function loadOpt(){ try{ S.opt = await getJSON('options_levels.json'); }catch(e){ } drawOptLines(); renderOpt(); renderGuard(); }

async function loadFeed(){
  if (stopStream){ stopStream(); stopStream=null; }
  S.raw = []; S.ticks = []; S.offsetSamples = []; S.refSamples = []; S.ref = null; S.refPrevPoll = 0; S.offset = 0; S.offSrc = ''; $('lwStatus').textContent = 'กำลังโหลด…';
  const tfAtStart = S.tf;
  const won = await raceFeeds(ORDER, (n)=>withTimeout(Feeds[n].history(S.tf), 6000));
  if (tfAtStart !== S.tf) return;                           // user switched TF meanwhile
  if (won){
    try{
      const f = Feeds[won.name], hist = won.hist;
      S.feed = f; S.raw = hist; window.AITD_LIB.okxSlow = won.name!=='okxidx';   // NAS skips waiting for OKX too
      { const lb = hist[hist.length-1]; S.ticks.push([Math.min(Date.now(), (lb.time + TF[S.tf].s)*1000), lb.close]); }   // stamped at bar end: Bitget's index history lags ~1 bar, so a stale close must not be paired with a live OANDA quote
      S.offset = f.adjust ? (STATIC_OFF[f.name] ?? 0) : 0; S.offSrc = f.adjust ? 'static' : '';   // refined by pollRef() within ~1 s
      redrawAll(); chart.timeScale().scrollToRealTime(); GVP.realign();   // VP shift follows the chart source
      stopStream = f.stream(S.tf, f.adjust && !f.ticks ? onBar : onIndexTick);
      S.lastTickAt = Date.now(); if (f.adjust) pollRef();
      setTimeout(()=>loadDay(f), 1500);                     // after first paint, not in the startup burst
      $('lwStatus').textContent = won.name==='okxidx' ? '' : 'สำรอง: '+f.label+' (ปรับให้ตรง OANDA)';
      renderFeedInfo(); goldReady(); return;
    }catch(e){ console.warn('feed fail', won.name, e); }
  }
  // fallback: spot polling only (+ static seed for M15)
  S.feed = {name:'gold-api', label:'gold-api.com (spot)'}; S.offset = 0;
  if (['15','30','60','240'].includes(S.tf)){ try{ const s = await getJSON('candles_seed.json'); const c = s.candles.map(c=>({...c})); S.raw = S.tf==='15' ? c : aggregate(c, S.tf); }catch(e){} }
  redrawAll(); GVP.realign(); if (S.spot) onSpotOnlyTick(S.spot, Date.now()); pollRef();
  $('lwStatus').textContent = 'โหมดสำรอง: อัปเดตจาก spot ทุก ~30 วิ';
  renderFeedInfo(); goldReady();
}
/* js/nas.js waits for this (max ~1 s) so the NAS chart never competes with the gold chart's first load */
let goldReady; window.AITD_GOLD_READY = new Promise(r=>goldReady=r);
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
  renderZones(); renderCalc(); renderGuard();
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
  if (f && f.adjust) t += ` ปรับฐาน ${S.offset>=0?'−':'+'}${fmt(Math.abs(S.offset))} ให้ตรง ${S.offSrc==='OANDA' ? `OANDA (วัดสด ${S.refSamples.length} ครั้ง)` : S.offSrc==='gold-api' ? 'spot (gold-api)' : 'spot (ค่าประมาณ รอวัดสด)'}`;
  if (f && f.name==='okxidx') t += ' (ราคา spot USD ไม่ต้องปรับฐาน)';
  if (S.ref && S.refAt && f && f.name!=='gold-api') t += ` · OANDA ${fmt(S.ref)} (${Math.round((Date.now()-S.refAt)/1000)}s ก่อน${S.price!=null ? `, ต่าง ${sgn(S.price-S.ref)}` : ''})`;
  if (S.spot) t += ` · เทียบ gold-api ${fmt(S.spot)} (อัปเดตช้า ~30 วิ, ${spotAge}s ก่อน${S.price!=null && f && f.name!=='gold-api' ? `, ต่าง ${sgn(S.price-S.spot)}` : ''})`;
  if (spotClosed(Date.now())) t += ' · ตลาดทอง spot ปิดอยู่ กราฟหยุดที่ราคาปิดล่าสุด';
  $('feedInfo').textContent = t;
  const src = $('feedSrc'); if (src) src.textContent = f ? `· ${f.label}` : '';
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


/* ---------------- zone guard banner ---------------- */
/* Levels that feed the banner:
   - zones.json  : type 'support' / 'resistance' bands [low, high] (type 'pivot' is ignored)
   - options     : front expiry of GLD (Cboe) and SHFE — Put wall = support, Call wall = resistance (max pain ignored)
   - Volume Profile (when switched on): VAL = support, VAH = resistance (POC ignored)
   Options/VP are single prices → treated as a zero-width band. */
function guardLevels(){
  const L = [];
  for (const z of (S.zones && S.zones.zones) || []){
    if (z.type!=='support' && z.type!=='resistance') continue;
    L.push({side:z.type, lo:Math.min(z.zone[0],z.zone[1]), hi:Math.max(z.zone[0],z.zone[1]), src:'โซน'});
  }
  if (S.opt) for (const src of ['gld','shfe']){
    const b = S.opt[src], e = optFront(src, b); if (!e) continue;
    const tag = src==='gld' ? 'GLD' : 'SHFE';
    (e.put_walls||[]).forEach(w=>isFinite(w.level_spot) && L.push({side:'support', lo:w.level_spot, hi:w.level_spot, src:`${tag} Put wall ${w.strike}`}));
    (e.call_walls||[]).forEach(w=>isFinite(w.level_spot) && L.push({side:'resistance', lo:w.level_spot, hi:w.level_spot, src:`${tag} Call wall ${w.strike}`}));
  }
  if (S.vpOn && S.vp){ L.push({side:'support', lo:S.vp.val, hi:S.vp.val, src:'VAL'}); L.push({side:'resistance', lo:S.vp.vah, hi:S.vp.vah, src:'VAH'}); }
  return L;
}
const lvDist = (p, l) => p < l.lo ? l.lo - p : p > l.hi ? p - l.hi : 0;
const lvRng = (l) => l.lo===l.hi ? fmt(l.lo) : `${fmt(l.lo)}–${fmt(l.hi)}`;
function guardPrice(){ return isFinite(TEST_PRICE) ? TEST_PRICE : S.price; }
function guardState(){
  const p = guardPrice(); if (p==null || !isFinite(p)) return {state:'wait'};
  const L = guardLevels();
  const near = (side) => L.filter(l=>l.side===side && lvDist(p,l) <= ZONE_NEAR_USD)
                          .sort((a,b)=>lvDist(p,a)-lvDist(p,b) || (a.src==='โซน'?-1:1));
  const sup = near('support'), res = near('resistance');
  const below = L.filter(l=>l.side==='support' && l.hi < p).sort((a,b)=>b.hi-a.hi)[0];
  const above = L.filter(l=>l.side==='resistance' && l.lo > p).sort((a,b)=>a.lo-b.lo)[0];
  const state = sup.length && res.length ? 'both' : sup.length ? 'support' : res.length ? 'resistance' : 'neutral';
  return {state, p, sup, res, below, above, key: state + '|' + (sup[0]?lvRng(sup[0]):'') + '|' + (res[0]?lvRng(res[0]):'')};
}
function srcList(arr){ return [...new Set(arr.map(l=> l.src==='โซน' ? `โซน ${lvRng(l)}` : `${l.src} @ ${fmt(l.lo)}`))].join(' · '); }
function rngOf(arr){ const z = arr.find(l=>l.src==='โซน') || arr[0]; return lvRng(z); }
S.guard = {state:'wait'};
function renderGuard(){
  const g = guardState(), el = $('guard'); if (!el) return;
  const prev = S.guard; S.guard = g;
  el.className = 'guard ' + g.state;
  const test = isFinite(TEST_PRICE) ? `<span class="test">TEST ${fmt(TEST_PRICE)}</span>` : '';
    const near = (l, side) => l ? `${side} <b>${lvRng(l)}</b> (ห่าง $${fmt(l.side==='support' ? g.p-l.hi : l.lo-g.p)})` : `${side} —`;
  let main, sub;
  if (g.state==='wait'){ main = 'กำลังรอราคา…'; sub = ''; }
  else if (g.state==='support'){
    main = `⚠️ ราคาอยู่ในแนวรับ <span class="rng">${rngOf(g.sup)}</span> — ห้าม SELL · รอแท่งกลับตัว M15 ก่อนค่อยคิด BUY${test}`;
    sub = `ราคา <b>${fmt(g.p)}</b> · ชนแนวรับ: ${esc(srcList(g.sup))} · ${near(g.above,'แนวต้านถัดไป')}`;
  } else if (g.state==='resistance'){
    main = `⚠️ ราคาอยู่ในแนวต้าน <span class="rng">${rngOf(g.res)}</span> — ห้าม BUY · รอแท่งกลับตัว M15 ก่อนค่อยคิด SELL${test}`;
    sub = `ราคา <b>${fmt(g.p)}</b> · ชนแนวต้าน: ${esc(srcList(g.res))} · ${near(g.below,'แนวรับถัดไป')}`;
  } else if (g.state==='both'){
    main = `⚠️ ราคาติดทั้งแนวรับ <span class="rng">${rngOf(g.sup)}</span> และแนวต้าน <span class="rng">${rngOf(g.res)}</span> — ห้ามทั้ง BUY และ SELL · รอราคาหลุด/ทะลุพร้อมแท่ง M15${test}`;
    sub = `ราคา <b>${fmt(g.p)}</b> · แนวรับ: ${esc(srcList(g.sup))} · แนวต้าน: ${esc(srcList(g.res))}`;
  } else {
    main = `ราคาอยู่กลางทาง — รอราคาเข้าโซน ไม่ไล่ราคา${test}`;
    sub = `ราคา <b>${fmt(g.p)}</b> · ${near(g.below,'แนวรับใกล้สุด')} · ${near(g.above,'แนวต้านใกล้สุด')}`;
  }
  sub += ` · เกณฑ์ ±$${ZONE_NEAR_USD}` + (spotClosed(Date.now()) && !isFinite(TEST_PRICE) ? ' · ตลาดปิด (ราคาปิดล่าสุด)' : '');
  if (el._m !== main){ $('gMain').innerHTML = main; el._m = main; }
  if (el._s !== sub){ $('gSub').innerHTML = sub; el._s = sub; }
  if (prev.key !== g.key) onGuardChange(prev, g);
  renderChecklist();
}
/* optional beep + browser notification when entering a zone (off by default) */
S.alertOn = LS.get('guard_alert', false); S.lastAlert = {};
let audioCtx = null;
function beep(){
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state==='suspended') audioCtx.resume();
    [0, 0.22].forEach(t0=>{ const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.type='square'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime+t0); g.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime+t0+0.02); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime+t0+0.18);
      o.connect(g).connect(audioCtx.destination); o.start(audioCtx.currentTime+t0); o.stop(audioCtx.currentTime+t0+0.2); });
  }catch(e){}
}
function onGuardChange(prev, g){
  if (!S.alertOn || prev.state==='wait' || !['support','resistance','both'].includes(g.state)) return;
  const now = Date.now(); if (now - (S.lastAlert[g.key]||0) < ALERT_COOLDOWN_MS) return;
  S.lastAlert[g.key] = now;
  beep();
  const msg = g.state==='support' ? `ราคา ${fmt(g.p)} อยู่ในแนวรับ ${rngOf(g.sup)} — ห้าม SELL` : g.state==='resistance' ? `ราคา ${fmt(g.p)} อยู่ในแนวต้าน ${rngOf(g.res)} — ห้าม BUY` : `ราคา ${fmt(g.p)} ติดทั้งแนวรับและแนวต้าน — ห้ามทั้ง BUY/SELL`;
  try{ if ('Notification' in window && Notification.permission==='granted') new Notification('AiTD Gold · เข้าโซน', {body: msg, tag:'aitd-guard'}); }catch(e){}
}
function wireGuard(){
  const b = $('gAlert'); if (!b) return;
  const paint = () => { b.classList.toggle('on', S.alertOn); b.innerHTML = S.alertOn ? '🔔<span class="g-al"> เตือน: เปิด</span>' : '🔕<span class="g-al"> เตือน: ปิด</span>'; b.setAttribute('aria-pressed', S.alertOn); };
  paint();
  b.onclick = () => {
    S.alertOn = !S.alertOn; LS.set('guard_alert', S.alertOn); paint();
    if (S.alertOn){ beep(); try{ if ('Notification' in window && Notification.permission==='default') Notification.requestPermission(); }catch(e){} }
  };
}

/* ---------------- pre-trade checklist (localStorage only) ---------------- */
const CHECKS = [
  'ไม่ SELL ในแนวรับ / ไม่ BUY ในแนวต้าน',
  'เห็นแท่งกลับตัว M15 แล้ว',
  'ล็อต 0.1 เท่านั้น',
  'SL ประมาณ $5 ไม่เกิน $10 · TP $5–10',
  'วันนี้ขาดทุนยังไม่ถึง -$200',
  'ไม่ใช่ไม้แก้แค้น / ไม่เพิ่มล็อตหลังโดน SL',
  'ไม่ใช่ช่วงข่าวแรง (เช่น FOMC)',
];
function ckLoad(){
  const c = LS.get('checklist', null);
  if (!c || !Array.isArray(c.v) || c.v.length!==CHECKS.length || Date.now() - (c.at||0) > CHECK_EXPIRE_MIN*60000) return {v: CHECKS.map(()=>false), at: 0};
  return c;
}
function ckSave(c){ LS.set('checklist', c); }
function wireChecklist(){
  const list = $('ckList'); if (!list) return;
  list.innerHTML = CHECKS.map((t,i)=>`<label class="ck" data-i="${i}"><input type="checkbox" data-i="${i}"><span>${esc(t)}<small class="hidden"></small></span></label>`).join('');
  list.querySelectorAll('input').forEach(inp=>inp.onchange = ()=>{ const c = ckLoad(); c.v[+inp.dataset.i] = inp.checked; c.at = Date.now(); ckSave(c); renderChecklist(); });
  $('ckReset').onclick = ()=>{ ckSave({v: CHECKS.map(()=>false), at: 0}); renderChecklist(); };
  renderChecklist();
}
function renderChecklist(){
  const list = $('ckList'); if (!list || !list.firstChild) return;
  const c = ckLoad(), g = S.guard || {state:'wait'};
  list.querySelectorAll('.ck').forEach(row=>{ const i = +row.dataset.i, inp = row.querySelector('input'); inp.checked = !!c.v[i]; row.classList.toggle('done', !!c.v[i]); });
  // live warnings next to items
  const warn = {};
  if (g.state==='support') warn[0] = 'ตอนนี้ราคาอยู่ในแนวรับ → ห้าม SELL';
  if (g.state==='resistance') warn[0] = 'ตอนนี้ราคาอยู่ในแนวต้าน → ห้าม BUY';
  if (g.state==='both') warn[0] = 'ตอนนี้ราคาติดทั้งแนวรับและแนวต้าน → ห้ามทั้งสองฝั่ง';
  const lot = parseFloat($('cLot') && $('cLot').value); if (isFinite(lot) && lot > 0.1) warn[2] = `ช่องคำนวณตั้ง Lot ไว้ ${lot} (เกิน 0.1)`;
  const pl = todayPL(), stop = acct().daily_stop; if (pl <= stop) warn[4] = `P/L วันนี้ ${sUsd(pl)} ถึงจุดหยุด ${usd(stop)} แล้ว → หยุดเทรด`;
  const nx = S.events && S.events.find(e=>e.ms > Date.now() - 15*60000); if (nx && nx.ms - Date.now() < 30*60000) warn[6] = `ข่าวแรงภายใน 30 นาที: ${nx.title}`;
  list.querySelectorAll('.ck').forEach(row=>{ const i = +row.dataset.i, sm = row.querySelector('small'); const w = warn[i];
    row.classList.toggle('flag', !!w); sm.classList.toggle('hidden', !w); sm.textContent = w || ''; });
  // blocked-direction flag inside the card
  const blk = $('ckBlock');
  const btxt = g.state==='support' ? `🚫 SELL ถูกบล็อก — ราคาอยู่ในแนวรับ ${rngOf(g.sup)} · รอแท่งกลับตัว M15 ก่อนคิด BUY`
             : g.state==='resistance' ? `🚫 BUY ถูกบล็อก — ราคาอยู่ในแนวต้าน ${rngOf(g.res)} · รอแท่งกลับตัว M15 ก่อนคิด SELL`
             : g.state==='both' ? `🚫 BUY และ SELL ถูกบล็อก — ราคาติดแนวรับ ${rngOf(g.sup)} และแนวต้าน ${rngOf(g.res)}` : '';
  blk.classList.toggle('hidden', !btxt); blk.textContent = btxt;
  const all = c.v.every(Boolean), n = c.v.filter(Boolean).length, bd = $('ckBadge');
  const hardStop = pl <= stop;
  if (hardStop){ bd.className = 'ready stop'; bd.textContent = 'หยุดเทรดวันนี้'; }
  else if (g.state==='both'){ bd.className = 'ready stop'; bd.textContent = 'ห้ามกด (ติดทั้งสองฝั่ง)'; }
  else if (all){ bd.className = 'ready ok'; bd.textContent = g.state==='support' ? 'พร้อมกด · BUY เท่านั้น' : g.state==='resistance' ? 'พร้อมกด · SELL เท่านั้น' : 'พร้อมกด'; }
  else { bd.className = 'ready no'; bd.textContent = `ยังไม่พร้อม (${n}/${CHECKS.length})`; }
  const left = c.at ? Math.max(0, Math.ceil((c.at + CHECK_EXPIRE_MIN*60000 - Date.now())/60000)) : null;
  $('ckInfo').textContent = 'เก็บในเครื่องนี้เท่านั้น (localStorage)' + (left!=null && n ? ` · ติ๊กจะล้างเองใน ${left} นาที` : ` · ติ๊กล้างเองหลัง ${CHECK_EXPIRE_MIN} นาที`);
}

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
  withTV(go);
}
/* load tv.js once; queue every caller (gold TradingView tab + NAS100 card in js/nas.js) until it is ready */
const tvQueue = [];
function withTV(fn){
  if (window.TradingView && window.TradingView.widget) return fn();
  tvQueue.push(fn);
  if (!tvjs){ tvjs = document.createElement('script'); tvjs.src = 'https://s3.tradingview.com/tv.js';
    tvjs.onload = () => { while (tvQueue.length) { try{ tvQueue.shift()(); }catch(e){ console.warn('tv widget', e); } } };
    document.head.append(tvjs); }
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

/* ---------------- Volume Profile engine (gold + NAS100) ----------------
   Volume comes from crypto-exchange perpetuals (the only free, CORS-open, no-key candle volume):
   gold: OKX XAU-USDT-SWAP → Bitget XAUUSDT → Binance XAUUSDT;  NAS100: OKX US100-USDT-SWAP → Bitget NDX100USDT.
   All sources are requested at once (4 s fetch timeout each, raceFeeds); the first one in priority order that answers wins —
   in Thailand okx.com is blocked, so Bitget/Binance take over instead of the profile staying blank.
   The perp trades at a different price than the chart (basis, and for NAS the Skilling offset), so the profile is shifted onto
   the chart: shift = median(perp close − chart close) over bars that close at the same time. That also carries the NAS
   Skilling offset / "ปรับให้ตรง MT5" value automatically because the NAS chart candles are already shifted. */
const VP_PERIODS = { today:{bar:'5m', s:300, label:'วันนี้'}, asia:{bar:'5m', s:300, label:'ตั้งแต่เปิดเอเชีย'}, h24:{bar:'5m', s:300, label:'24 ชม.'}, week:{bar:'15m', s:900, label:'สัปดาห์นี้'} };
function vpStart(p, now=Date.now()){
  if (p==='h24') return now - 86400000;
  if (p==='asia'){ const d = new Date(now + 7*3600e3); let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0) ; if (t > now) t -= 86400000; return t; }   // 07:00 Thai = 00:00 UTC
  let t = dayStartMs(new Date(now));
  if (p==='week'){ for (let i=0;i<7 && tzParts('America/New_York', new Date(t+3600e3)).wd!=='Sun'; i++) t -= 86400000; }
  return t;
}
const vpRow = (t,h,l,c,v) => ({t:+t, h:+h, l:+l, c:+c, v:+v});
const VP_SRC = {
  okx: (instId) => async (bar, start, full) => {             // k[6] = volCcy (oz for XAU, index units for US100)
    const out = []; const put = (rows)=>rows.forEach(k=>out.push(vpRow(k[0],k[2],k[3],k[4],k[6])));
    let rows = await okxGet(`${OKX}candles?instId=${instId}&bar=${bar}&limit=${full?300:3}`, 1); put(rows);
    if (full){
      let after = rows.length ? rows[rows.length-1][0] : null;
      for (let i=0; i<12 && after && +after > start; i++){
        rows = await okxGet(`${OKX}history-candles?instId=${instId}&bar=${bar}&limit=100&after=${after}`, 1);
        if (!rows.length) break; put(rows); after = rows[rows.length-1][0];
      }
    }
    return out;
  },
  bitget: (symbol) => async (bar, start, full) => {           // k[5] = base volume (oz / index units)
    const j = await fetchJSON(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${bar}&limit=${full?1000:3}${full?`&startTime=${start}`:''}`);
    if (j.code!=='00000' || !Array.isArray(j.data)) throw new Error('bitget '+j.code);
    return j.data.map(k=>vpRow(k[0],k[2],k[3],k[4],k[5]));
  },
  binance: (symbol) => async (bar, start, full) => {          // k[5] = base volume (oz)
    const j = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${bar}&limit=${full?1500:3}${full?`&startTime=${start}`:''}`);
    if (!Array.isArray(j)) throw new Error('binance '+(j && j.code));
    return j.map(k=>vpRow(k[0],k[2],k[3],k[4],k[5]));
  },
};
/* o: { key (LS prefix), qsOn, qsPeriod, ids:{tg, period, info}, sources:[{name,label,fetch}], bin, unit, volDigits,
        tf:()=>chart tf, chartBars:()=>[{time(sec UTC), close(as drawn)}], series:()=>candle series, onChange:()=>void } */
function createVP(o){
  const V = { on: qs.get(o.qsOn) ? qs.get(o.qsOn)!=='0' : LS.get(o.key+'_on', true),
    period: VP_PERIODS[qs.get(o.qsPeriod)] ? qs.get(o.qsPeriod) : LS.get(o.key+'_period', 'today'),
    bars: new Map(), src: null, data: null, err: null, busy: false };
  if (!VP_PERIODS[V.period]) V.period = 'today';
  const srcOf = (n) => o.sources.find(s=>s.name===n);
  const fetchFrom = async (n, full) => {
    const start = vpStart(V.period), rows = await withTimeout(srcOf(n).fetch(VP_PERIODS[V.period].bar, start, full), full ? 9000 : 5000);
    return rows.filter(r=>r.t>=start && isFinite(r.h) && isFinite(r.l) && !spotClosed(r.t));
  };
  V.shift = () => {                                            // perp → chart price
    const cb = o.chartBars(); if (!cb.length || !V.bars.size) return null;
    const tf = o.tf(), vs = VP_PERIODS[V.period].s, m = new Map(cb.map(b=>[b.time, b.close])), d = [];
    const bars = [...V.bars.values()].sort((a,b)=>a.t-b.t);
    for (const b of bars){
      if (!(b.v > 0)) continue;
      const t0 = b.t/1000, end = t0 + vs, k = bucketStart(end - 1, tf);
      if (bucketStart(end, tf) === k) continue;               // perp bar must close together with the chart bar
      const c = m.get(k); if (c!=null) d.push(b.c - c);
    }
    const use = d.slice(-60).sort((a,b)=>a-b);
    if (use.length) return use[use.length>>1];
    return bars[bars.length-1].c - cb[cb.length-1].close;
  };
  V.compute = () => {
    const sh = V.shift(); if (sh==null){ V.data = null; return; }
    const bs = o.bin, bins = new Map(); let total = 0;
    for (const c of V.bars.values()){
      if (!(c.v > 0)) continue;
      const lo = Math.floor((c.l - sh)/bs), hi = Math.floor((c.h - sh)/bs), n = hi - lo + 1, per = c.v / n;
      for (let b = lo; b <= hi; b++) bins.set(b, (bins.get(b)||0) + per);
      total += c.v;
    }
    if (!bins.size){ V.data = null; return; }
    const keys = [...bins.keys()].sort((a,b)=>a-b), lo = keys[0], hi = keys[keys.length-1];
    const arr = []; for (let b=lo; b<=hi; b++) arr.push(bins.get(b)||0);
    let pi = 0; arr.forEach((v,i)=>{ if (v > arr[pi]) pi = i; });
    let a = pi, z = pi, acc = arr[pi];
    while (acc < total*0.7 && (a>0 || z<arr.length-1)){
      const up = z<arr.length-1 ? arr[z+1] : -1, dn = a>0 ? arr[a-1] : -1;
      if (up >= dn){ z++; acc += up; } else { a--; acc += dn; }
    }
    V.data = { lo, bs, arr, max: arr[pi], poc: (lo+pi+0.5)*bs, vah: (lo+z+1)*bs, val: (lo+a)*bs, total, bars: V.bars.size, shift: sh, src: srcOf(V.src), at: Date.now() };
  };
  V.realign = () => { if (V.bars.size){ V.compute(); V.render(); o.onChange(); } };
  V.load = async (full) => {
    if (!V.on){ V.render(); o.onChange(); return; }
    if (V.busy) return; V.busy = true;
    try{
      let ok = false;
      if (!full && V.src && V.bars.size){                     // minute refresh: newest bars from the source already in use
        try{ (await fetchFrom(V.src, false)).forEach(b=>V.bars.set(b.t, b)); ok = true; }catch(e){}
      }
      if (!ok){                                               // all sources at once, first in priority order wins
        const won = await raceFeeds(o.sources.map(s=>s.name), (n)=>fetchFrom(n, true), 800);
        if (won){ V.src = won.name; V.bars = new Map(won.hist.map(b=>[b.t, b])); V.err = null; }
        else { V.err = 'all'; V.src = null; V.bars = new Map(); }
      }
      const start = vpStart(V.period); for (const t of V.bars.keys()) if (t < start) V.bars.delete(t);
      V.compute();
    }catch(e){ V.err = String(e); }
    finally{ V.busy = false; }
    V.render(); o.onChange();
  };
  V.render = () => {
    const el = $(o.ids.info); if (!el) return;
    if (!V.on){ el.textContent = 'ปิดอยู่'; el.classList.remove('vp-fail'); return; }
    const v = V.data;
    el.classList.toggle('vp-fail', !v && !!V.err);
    if (!v){ el.textContent = V.err ? `Volume Profile โหลดไม่ได้ (${o.sources.map(s=>s.short).join(' / ')} ไม่ตอบ) · ลองใหม่ทุก 1 นาที` : 'กำลังโหลด Volume Profile…'; return; }
    const t = new Date(v.at).toLocaleTimeString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit'}), dg = o.bin < 1.5 ? 1 : 0;
    el.innerHTML = `POC <b>${fmt(v.poc,dg)}</b> · VAH <b>${fmt(v.vah,0)}</b> · VAL <b>${fmt(v.val,0)}</b> · ที่มา <b class="vp-src">${esc(v.src ? v.src.label : '—')}</b> · เลื่อน ${sgn(-v.shift,1)} ให้ตรงกราฟ · ${v.bars} แท่ง ${VP_PERIODS[V.period].bar} · ${fmt(v.total, o.volDigits ?? 0)} ${o.unit} · ${t}`;
  };
  V.draw = (ctx, paneW, paneH) => {
    if (!V.on) return;
    const v = V.data, cs = o.series(); if (!cs) return;
    if (!v){
      if (V.err){ ctx.font = '600 10.5px "IBM Plex Sans Thai", sans-serif'; ctx.fillStyle = 'rgba(255,170,90,0.9)'; const s = 'Volume Profile โหลดไม่ได้'; ctx.fillText(s, paneW - ctx.measureText(s).width - 8, paneH - 8); }
      return;
    }
    const maxW = Math.min(180, paneW*0.18), x1 = paneW - 2, bs = v.bs;
    for (let i=0;i<v.arr.length;i++){
      if (!v.arr[i]) continue;
      const p = (v.lo + i)*bs, ya = cs.priceToCoordinate(p+bs), yb = cs.priceToCoordinate(p);
      if (ya==null || yb==null || yb < 0 || ya > paneH) continue;
      const w = maxW * v.arr[i] / v.max, h = Math.max(1, yb - ya - 0.5);
      ctx.fillStyle = (p + bs/2 === v.poc) ? 'rgba(255,152,0,0.85)' : (p >= v.val && p < v.vah) ? 'rgba(100,140,255,0.36)' : 'rgba(139,147,165,0.22)';
      ctx.fillRect(x1 - w, ya, w, h);
    }
    const line = (p, col, dash, lbl)=>{
      const y = cs.priceToCoordinate(p); if (y==null || y<0 || y>paneH) return;
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(0, Math.round(y)+.5); ctx.lineTo(paneW, Math.round(y)+.5); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '600 10px "IBM Plex Sans Thai", sans-serif'; ctx.fillStyle = col;
      const s = `${lbl} ${fmt(p,lbl==='POC' && bs<1.5?1:0)}`; ctx.fillText(s, x1 - maxW - ctx.measureText(s).width - 6, y - 3);
    };
    line(v.vah, 'rgba(130,160,255,0.9)', [6,3], 'VAH'); line(v.val, 'rgba(130,160,255,0.9)', [6,3], 'VAL'); line(v.poc, 'rgba(255,152,0,0.95)', [], 'POC');
  };
  V.wire = () => {
    const tg = $(o.ids.tg), sel = $(o.ids.period);
    if (tg){ tg.checked = V.on; tg.onchange = ()=>{ V.on = tg.checked; LS.set(o.key+'_on', V.on); if (V.on){ V.data = null; V.err = null; V.render(); V.load(true); } else { V.render(); o.onChange(); } }; }
    if (sel){ sel.value = V.period; sel.onchange = ()=>{ V.period = sel.value; LS.set(o.key+'_period', V.period); V.data = null; V.err = null; V.bars = new Map(); V.render(); o.onChange(); V.load(true); }; }
    V.render();
  };
  V.start = (delay=0) => {
    setTimeout(()=>V.load(true), delay);
    setInterval(()=>{ if (V.on) V.load(false); }, 60000);         // newest bars every minute (full race again if the source failed)
    setInterval(()=>{ if (V.on) V.load(true); }, 15*60000);       // full rebuild (drops bars older than the period start)
  };
  return V;
}
const GVP = createVP({
  key:'vp', qsOn:'vp', qsPeriod:'vpp', ids:{tg:'tgVp', period:'vpPeriod', info:'vpInfo'}, bin:1, unit:'oz',
  sources:[ {name:'okx', short:'OKX', label:'OKX XAU-USDT perp', fetch:VP_SRC.okx('XAU-USDT-SWAP')},
            {name:'bitget', short:'Bitget', label:'Bitget XAUUSDT perp', fetch:VP_SRC.bitget('XAUUSDT')},
            {name:'binance', short:'Binance', label:'Binance XAUUSDT perp', fetch:VP_SRC.binance('XAUUSDT')} ],
  tf:()=>S.tf, chartBars:()=>S.raw.map(b=>({time:b.time, close:b.close - S.offset})), series:()=>cs,
  onChange:()=>{ S.vpOn = GVP.on; S.vp = GVP.data; drawZones(); renderGuard(); },
});
S.vpOn = GVP.on; S.vp = null; window.__AITD_GVP = GVP;
function drawVP(ctx, paneW, paneH){ if (S.view==='zone') GVP.draw(ctx, paneW, paneH); }

/* ---------------- gold news (news.json: public RSS headlines, automatic keyword tags) ---------------- */
S.newsFilter = LS.get('news_filter', 'all');
function relTime(iso){
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!isFinite(m)) return '';
  if (m < 1) return 'เมื่อสักครู่'; if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.floor(m/60); if (h < 24) return `${h} ชม.ที่แล้ว`; return `${Math.floor(h/24)} วันที่แล้ว`;
}
function renderNews(){
  const box = $('newsList'); if (!box) return;
  const N = S.news;
  if (!N || !N.items){ box.innerHTML = '<div class="sub">ยังไม่มี news.json</div>'; return; }
  const items = N.items;
  const counts = {}; items.forEach(x=>(x.tags||[]).forEach(t=>counts[t]=(counts[t]||0)+1));
  const lean = {}; items.forEach(x=>lean[x.lean]=(lean[x.lean]||0)+1);
  const chips = [['all','ทั้งหมด',items.length], ['lean:ทองบวก','ทองบวก',lean['ทองบวก']||0], ['lean:ทองลบ','ทองลบ',lean['ทองลบ']||0],
    ...Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([t,n])=>['tag:'+t, t, n])];
  if (!chips.some(c=>c[0]===S.newsFilter)) S.newsFilter = 'all';
  $('newsFilters').innerHTML = chips.map(([k,l,n])=>`<button class="nchip ${k===S.newsFilter?'active':''} ${k.startsWith('lean:')?(l==='ทองบวก'?'up':'dn'):''}" data-k="${esc(k)}">${esc(l)} <small>${n}</small></button>`).join('');
  $('newsFilters').querySelectorAll('.nchip').forEach(b=>b.onclick=()=>{ S.newsFilter=b.dataset.k; LS.set('news_filter', S.newsFilter); renderNews(); });
  const f = S.newsFilter, sel = items.filter(x=> f==='all' || (f.startsWith('lean:') && x.lean===f.slice(5)) || (f.startsWith('tag:') && (x.tags||[]).includes(f.slice(4))));
  const LC = {'ทองบวก':'up','ทองลบ':'dn','กลาง':'flat'};
  box.innerHTML = sel.map(x=>`<div class="nitem"><span class="nlean ${LC[x.lean]||'flat'}">${esc(x.lean||'กลาง')}</span>
    <div class="nmain"><a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>
    <div class="nmeta"><span>${esc(x.source||'')}</span> · <span title="${esc(thDT(x.published))}">${relTime(x.published)}</span>${(x.tags||[]).filter(t=>t!=='ทั่วไป').map(t=>` <i class="ntag">${esc(t)}</i>`).join('')}</div></div></div>`).join('') || '<div class="sub">ไม่มีข่าวในหมวดนี้</div>';
  const ok = (N.sources||[]).filter(s=>s.ok && s.used>0).map(s=>s.name);
  $('newsMeta').textContent = `อัปเดต ${thDT(N.generated_at)} · ${items.length} หัวข้อใน 48 ชม. · แหล่ง: ${ok.join(', ')||'—'}`;
}
async function loadNews(){ try{ S.news = await getJSON('news.json'); }catch(e){} renderNews(); }

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
  ['cLot','aToday','aStopIn'].forEach(id=>$(id).addEventListener('input', renderChecklist));
  wireGuard(); wireChecklist();
  $('zoneLot').value = LS.get('zoneLot', 0.1);
  $('zoneLot').addEventListener('input', ()=>{ LS.set('zoneLot', $('zoneLot').value); renderZones(); });
  document.querySelectorAll('.otab').forEach(b=>b.onclick=()=>{ S.optTab=b.dataset.src; LS.set('optTab',S.optTab); renderOpt(); });
  [['tgGld','gld'],['tgShfe','shfe']].forEach(([id,k])=>{ $(id).checked = S.optOn[k]; $(id).onchange = ()=>{ S.optOn[k] = $(id).checked; LS.set('opt_'+k, S.optOn[k]); drawOptLines(); }; });
  GVP.wire();
  $('cUseLive').onclick = ()=>{ if (S.price){ $('cEntry').value = S.price.toFixed(2); renderCalc(); } };
  const io = new IntersectionObserver((ents)=>ents.forEach(e=>{ if(e.isIntersecting){ WIDGETS[e.target.dataset.widget](e.target); io.unobserve(e.target);} }), {rootMargin:'300px'});
  document.querySelectorAll('.lazy-widget[data-widget=overview]').forEach(el=>io.observe(el));
  document.querySelectorAll('#tfs button').forEach(b=>b.classList.toggle('active', b.dataset.tf===S.tf));
}

let spotP = Promise.resolve();
async function main(){
  const [z, e] = await Promise.allSettled([getJSON('zones.json'), getJSON('events.json')]);
  if (z.status==='fulfilled'){ S.zones = z.value; $('zonesDate').textContent = `· ${S.zones.date||''}`; $('zonesMeta').textContent = (S.zones.auto?'โซนอัตโนมัติจากแท่ง H1 ดัชนี OKX XAU-USD (High/Low เมื่อวาน, Pivot, เอเชีย, swing H1/H4, เลขกลม) · ':'') + (S.zones.bias?('มุมมอง: '+S.zones.bias+' · '):'') + 'อัปเดต '+thDT(S.zones.generated_at||S.zones.date); }
  if (e.status==='fulfilled'){ S.events = (e.value.events||[]).map(x=>({...x, ms:Date.parse(x.time)})).filter(x=>isFinite(x.ms)).sort((x,y)=>x.ms-y.ms); }
  $('buildInfo').textContent = `zones ${S.zones?.date||'—'}`;
  wire(); tickClock(); setInterval(tickClock, 1000);
  renderGuard(); setInterval(renderChecklist, 30000);   // checklist expiry
  WIDGETS.calendar(document.querySelector('[data-widget=calendar]'));   // load first: avoids a TradingView CDN 403 seen when it loads after other TV widgets
  initChart(); setView(S.view); loadOpt(); loadNews();
  spotP = pollSpot(); setInterval(pollSpot, 15000); setInterval(pollRef, 5000);   // OANDA reference        // runs alongside the candle load (was awaited first)
  window.AITD_GOLD_READY.then(()=>GVP.start(1500));   // volume profile after both charts have painted (all sources in parallel)
  setInterval(renderNews, 60000);                                           // relative times
  await loadFeed();
  setInterval(renderFeedInfo, 2000);
  setInterval(()=>{ if(S.feed && S.feed.name!=='gold-api') loadDay(S.feed); }, 5*60000);
  setInterval(resyncTail, 60000);
  loadTape(); renderZones(); renderCalc();
  // reload data files every 10 min (daily update script)
  setInterval(async()=>{ try{ S.zones = await getJSON('zones.json'); drawZones(); renderZones(); renderGuard(); }catch(e){} loadOpt(); loadNews(); }, 600000);
  let optKey = '';
  setInterval(()=>{ if (!S.opt) return; renderOpt();     // refresh distance-to-price
    const k = ['gld','shfe'].map(x=>{ const e = optFront(x, S.opt[x]); return e ? (e.expiry||e.series) : '-'; }).join('|');
    if (k !== optKey){ optKey = k; drawOptLines(); renderGuard(); }   // an expiry just passed → roll lines + alert levels
  }, 15000);
}
/* shared helpers for js/nas.js (NAS100 chart) — same formatting, market hours, H4 anchoring and OKX client as the gold chart */
window.AITD_LIB = { $, qs, LS, fmt, sgn, esc, thDT, tzParts, dayStartMs, spotClosed, bucketStart, aggregate, ema, TF, OKX, okxGet, getJSON, withTimeout, withTV, TH_OFF, fetchJSON, bitgetIndex, raceFeeds, createVP, VP_SRC };
main();
window.__AITD = S;
})();
