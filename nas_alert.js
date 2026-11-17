#!/usr/bin/env node
'use strict';

// Standalone NAS100 FVG / iFVG alert. No model calls.
// The scanner is the function between FVG_START and FVG_END in js/nas.js.
// Candles, the New York session filter and H4/D1 aggregation are the functions
// in js/app.js and js/nas.js, loaded from those files so a page change cannot
// drift quietly. --self-test checks the loaded functions against known bars.

const fs = require('fs');
const path = require('path');
const cfg = require('./nas_alert.config.js');

const HL = 'https://api.hyperliquid.xyz/info';
const HL_COIN = 'xyz:XYZ100';
const HL_TF = { '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1h' };
const OKX = 'https://www.okx.com/api/v5/market/';
const BG = 'https://api.bitget.com/api/v2/mix/market/';
const BG_TF = { '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1H' };
const KNOWN = new Set(['1', '5', '15', '30', '60', '240', 'D']);
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function assert(cond, msg) {
  if (!cond) throw new Error('self-test: ' + msg);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function skipString(source, i) {
  const q = source[i];
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === '\\') { j++; continue; }
    if (source[j] === q) return j;
  }
  throw new Error('unterminated string');
}

function extractFunction(source, name) {
  const re = new RegExp('function\\s+' + escapeRe(name) + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('function not found: ' + name);
  const paren = source.indexOf(')', m.index);
  const brace = source.indexOf('{', paren);
  if (brace < 0) throw new Error('function body not found: ' + name);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"') { i = skipString(source, i); continue; }
    if (c === '`') throw new Error('template literal in ' + name);
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      if (nl < 0) throw new Error('unterminated comment in ' + name);
      i = nl;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated block comment in ' + name);
      i = end + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(m.index, i + 1);
    }
  }
  throw new Error('unclosed function ' + name);
}

function lineConst(source, name) {
  const re = new RegExp('^const ' + escapeRe(name) + ' = [^\\n]*;', 'm');
  const m = source.match(re);
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}

function loadPageLogic() {
  const app = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  const nas = fs.readFileSync(path.join(__dirname, 'js', 'nas.js'), 'utf8');
  const cfgAt = nas.indexOf('const FVG_CFG = ');
  if (cfgAt < 0) throw new Error('FVG_CFG missing in js/nas.js');
  const cfgBrace = nas.indexOf('{', cfgAt);
  let cfgDepth = 0, cfgEnd = -1;
  for (let i = cfgBrace; i < nas.length; i++) {
    if (nas[i] === '{') cfgDepth++;
    else if (nas[i] === '}') { cfgDepth--; if (cfgDepth === 0) { cfgEnd = i; break; } }
  }
  if (cfgEnd < 0) throw new Error('FVG_CFG is not closed in js/nas.js');
  const fvgCfg = new Function('return ' + nas.slice(cfgBrace, cfgEnd + 1))();
  const start = nas.indexOf('/* FVG_START */');
  const end = nas.indexOf('/* FVG_END */');
  if (start < 0 || end < start) throw new Error('FVG_START / FVG_END markers missing in js/nas.js');
  const fvgBlock = nas.slice(start + '/* FVG_START */'.length, end);
  const src = [
    "'use strict';",
    lineConst(app, 'TF'),
    lineConst(app, 'NYF'),
    lineConst(app, '_dsCache'),
    lineConst(nas, '_d1c'),
    extractFunction(app, 'tzParts'),
    extractFunction(app, 'tzOffsetMin'),
    extractFunction(app, 'dayStartMs'),
    extractFunction(app, 'spotClosed'),
    extractFunction(app, 'h4Start'),
    lineConst(app, 'bucketStart'),
    extractFunction(app, 'aggregate'),
    extractFunction(nas, 'd1Start'),
    extractFunction(nas, 'aggD1'),
    'const fvgScan = (function(){',
    fvgBlock,
    'return fvgScan;',
    '})();',
    'return { TF, tzParts, dayStartMs, spotClosed, h4Start, aggregate, aggD1, fvgScan };',
  ].join('\n');
  let page;
  try { page = new Function(src)(); }
  catch (e) { throw new Error('Could not load NAS page logic: ' + e.message); }
  if (typeof page.fvgScan !== 'function') throw new Error('fvgScan did not load from js/nas.js');
  page.fvgCfg = fvgCfg;
  return page;
}

function validateConfig(c) {
  if (!c || !Array.isArray(c.timeframes) || !c.timeframes.length) throw new Error('nas_alert.config.js has no timeframes');
  const ids = new Set();
  for (const tf of c.timeframes) {
    if (!KNOWN.has(tf.id)) throw new Error('unknown timeframe id ' + tf.id);
    if (ids.has(tf.id)) throw new Error('duplicate timeframe ' + tf.id);
    ids.add(tf.id);
    if (typeof tf.enabled !== 'boolean') throw new Error(tf.label + ' enabled must be true or false');
    if (!(Number(tf.proximity) > 0)) throw new Error(tf.label + ' proximity must be a positive number');
    if (tf.session !== 'market' && tf.session !== 'us-cash') throw new Error(tf.label + ' session must be "market" or "us-cash"');
    if (!(Number(tf.lookback) > 0)) throw new Error(tf.label + ' lookback must be a positive number');
    if (!tf.label) throw new Error('timeframe ' + tf.id + ' needs a label');
  }
  if (!c.usCash || c.usCash.tz !== 'America/New_York') throw new Error('usCash.tz must be America/New_York');
  hmToMin(c.usCash.start);
  hmToMin(c.usCash.end);
  if (typeof c.reminder !== 'string' || !c.reminder.trim()) throw new Error('reminder is empty');
  if (!(Number(c.dedupeDays) > 0)) throw new Error('dedupeDays must be a positive number');
}

function hmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error('bad clock ' + s);
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) throw new Error('bad clock ' + s);
  return h * 60 + mi;
}

function inWindow(now, win, tzParts) {
  const p = tzParts(win.tz, now);
  const m = p.h * 60 + p.mi;
  const a = hmToMin(win.start);
  const b = hmToMin(win.end);
  if (a === b) return false;
  if (a < b) return m >= a && m < b;
  return m >= a || m < b;
}

function sessionOpen(tf, now, page, marketOpen) {
  if (!marketOpen) return false;
  if (tf.session === 'market') return true;
  return inWindow(now, cfg.usCash, page.tzParts);
}

function barSeconds(tfId, TF) {
  if (tfId === 'D') return 86400; // same close rule as COACH_TF D1 in js/nas.js
  if (!TF[tfId]) throw new Error('no bar size for ' + tfId);
  return TF[tfId].s;
}

// Same loop as fvgClosedLast in js/nas.js: the forming bar is not a zone.
function closedLast(bars, sec, nowSec) {
  let i = bars.length - 1;
  while (i >= 0 && sec > 0 && bars[i].time + sec > nowSec) i--;
  return i;
}

function kindOf(z) {
  if (z.label === '+ FVG') return { id: 'fvg-bull', th: 'FVG ขาขึ้น' };
  if (z.label === '- FVG') return { id: 'fvg-bear', th: 'FVG ขาลง' };
  if (z.label === 'iFVG' && z.dir === 1) return { id: 'ifvg-bull', th: 'iFVG ขาขึ้น' };
  if (z.label === 'iFVG' && z.dir === -1) return { id: 'ifvg-bear', th: 'iFVG ขาลง' };
  throw new Error('unknown FVG label ' + z.label);
}

function zoneKey(tfId, kindId, leftTime, lo, hi) {
  const n = (v) => Number(v).toFixed(4);
  return [tfId, kindId, Math.round(leftTime), n(lo), n(hi)].join('|');
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function fmtPx(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function thaiStamp(now, tzParts) {
  const p = tzParts('Asia/Bangkok', now);
  const hh = String(p.h).padStart(2, '0');
  const mm = String(p.mi).padStart(2, '0');
  return p.d + ' ' + TH_MONTHS[p.mo - 1] + ' ' + hh + ':' + mm + ' น. (เวลาไทย)';
}

function formatAlert(row, now, tzParts) {
  return [
    'NAS100 · ' + row.label + ' · ' + row.kind,
    'โซน ' + fmtPx(row.lo) + ' – ' + fmtPx(row.hi),
    'ราคา ' + fmtPx(row.price),
    thaiStamp(now, tzParts),
    '',
    cfg.reminder,
  ].join('\n');
}

function scanTf(bars, tfId, page, nowSec) {
  const empty = { bulls: [], bears: [], ifvgs: [], last: -1 };
  if (!bars || bars.length < 3) return empty;
  const last = closedLast(bars, barSeconds(tfId, page.TF), nowSec);
  const res = page.fvgScan(bars, Object.assign({ lastClosed: last }, page.fvgCfg));
  return { bulls: res.bulls || [], bears: res.bears || [], ifvgs: res.ifvgs || [], last };
}

function zoneRows(tf, bars, scan, price, open, state) {
  const rows = [];
  const list = scan.bulls.concat(scan.bears, scan.ifvgs);
  for (const z of list) {
    if (!Number.isFinite(z.top) || !Number.isFinite(z.bottom)) continue;
    const lo = Math.min(z.bottom, z.top);
    const hi = Math.max(z.bottom, z.top);
    let dist;
    if (price >= lo && price <= hi) dist = 0;
    else if (price > hi) dist = price - hi;
    else dist = lo - price;
    const kind = kindOf(z);
    const left = bars[z.left];
    const leftTime = left ? left.time : null;
    const key = leftTime == null ? null : zoneKey(tf.id, kind.id, leftTime, lo, hi);
    const near = round1(dist) <= Number(tf.proximity);
    const deduped = !!(key && state.zones[key]);
    const send = !!(open && near && key && !deduped);
    rows.push({
      id: tf.id, label: tf.label, kind: kind.th, kindId: kind.id, key, lo, hi,
      dist, prox: Number(tf.proximity), near, deduped, send, sessionOpen: open, price,
    });
  }
  rows.sort((a, b) => a.dist - b.dist);
  return rows;
}

function readState(file) {
  if (!file || !fs.existsSync(file)) return { version: 1, zones: {} };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    throw new Error('Dedupe state is not valid JSON (' + file + '). Not sending, so a zone is not alerted twice by mistake.');
  }
  if (!raw || typeof raw !== 'object' || !raw.zones || typeof raw.zones !== 'object' || Array.isArray(raw.zones)) {
    throw new Error('Dedupe state has no zones object. Not sending.');
  }
  return { version: 1, zones: raw.zones };
}

function activeKeys(groups) {
  const keys = new Set();
  for (const g of groups) for (const z of g.rows) if (z.key) keys.add(z.key);
  return keys;
}

function pruneState(state, keys, now, days) {
  const keepAfter = now.getTime() - days * 86400000;
  let dirty = false;
  for (const [k, v] of Object.entries(state.zones)) {
    if (keys.has(k)) continue;
    const t = Date.parse(v && v.alertedAt);
    if (Number.isFinite(t) && t < keepAfter) {
      delete state.zones[k];
      dirty = true;
    }
  }
  return dirty;
}

function writeState(file, state) {
  const zones = {};
  for (const k of Object.keys(state.zones).sort()) zones[k] = state.zones[k];
  const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), zones }, null, 2) + '\n';
  fs.writeFileSync(file, body);
}

function clock() {
  if (!process.env.NAS_NOW) return new Date();
  const d = new Date(process.env.NAS_NOW);
  if (Number.isNaN(d.getTime())) throw new Error('NAS_NOW is not a valid time');
  console.log('clock override NAS_NOW=' + d.toISOString());
  return d;
}

function dryRun() {
  return process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
}

function secrets() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chat = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  return { token, chat, ok: !!(token && chat) };
}

async function fetchJSON(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const host = new URL(url).host;
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    if (!r.ok) throw new Error(host + ' HTTP ' + r.status);
    return body;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(host + ' timeout');
    if (e && e.message && e.message.indexOf(host) === 0) throw e;
    throw new Error(host + ' ' + (e && e.message ? e.message : 'request failed'));
  } finally {
    clearTimeout(t);
  }
}

function postJSON(url, body, ms) {
  return fetchJSON(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, ms);
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function asBars(rows, spotClosed) {
  // Same de-dupe as the NAS page: overlapping OKX / Bitget pages collapse on open time.
  const m = new Map();
  for (const k of rows || []) {
    const time = +k[0] / 1000;
    if (!Number.isFinite(time) || spotClosed(time * 1000)) continue;
    m.set(time, { time, open: +k[1], high: +k[2], low: +k[3], close: +k[4] });
  }
  return [...m.values()].sort((a, b) => a.time - b.time);
}

function sliceLookback(bars, seconds, n) {
  const cut = Date.now() / 1000 - (n + 1) * seconds;
  return bars.filter((b) => b.time >= cut);
}

function buildSeries(base, page) {
  const out = {};
  const byId = {};
  for (const tf of cfg.timeframes) byId[tf.id] = tf;
  for (const id of ['1', '5', '15', '30']) {
    if (base[id]) out[id] = sliceLookback(base[id], page.TF[id].s, byId[id].lookback);
  }
  if (base['60']) {
    if (byId['60']) out['60'] = sliceLookback(base['60'], 3600, byId['60'].lookback);
    if (byId['240']) out['240'] = page.aggregate(sliceLookback(base['60'], 3600, byId['240'].lookback), '240');
    if (byId['D']) out['D'] = page.aggD1(sliceLookback(base['60'], 3600, byId['D'].lookback));
  }
  return out;
}

function neededBase() {
  let h1 = 0;
  const ids = [];
  for (const tf of cfg.timeframes) {
    if (!tf.enabled) continue;
    if (tf.id === '60' || tf.id === '240' || tf.id === 'D') h1 = Math.max(h1, tf.lookback);
    else ids.push(tf.id);
  }
  if (h1) ids.push('60');
  return { ids, h1 };
}

function usablePrice(price, bars) {
  return Number.isFinite(price) && price > 1000 && price < 100000 && bars && bars.length;
}

async function okxGet(url) {
  for (let i = 0; i < 3; i++) {
    const j = await fetchJSON(url, {}, 8000);
    if (j && j.code === '0') return j.data;
    if (!j || j.code !== '50011' || i === 2) throw new Error('okx ' + (j && j.code) + ' ' + (j && j.msg || ''));
    await sleep(400 * (i + 1));
  }
  throw new Error('okx');
}

async function loadHl(page) {
  const need = neededBase();
  const pairs = await Promise.all(need.ids.map(async (id) => {
    const n = id === '60' ? need.h1 : cfg.timeframes.find((t) => t.id === id).lookback;
    const s = page.TF[id].s;
    const j = await postJSON(HL, { type: 'candleSnapshot', req: { coin: HL_COIN, interval: HL_TF[id], startTime: Date.now() - (n + 1) * s * 1000, endTime: Date.now() } }, 8000);
    if (!Array.isArray(j) || !j.length) throw new Error('hyperliquid candles ' + id);
    const bars = j.map((k) => ({ time: k.t / 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c }))
      .filter((b) => !page.spotClosed(b.time * 1000))
      .sort((a, b) => a.time - b.time);
    if (!bars.length) throw new Error('hyperliquid candles ' + id + ' empty after session filter');
    return [id, bars];
  }));
  const base = Object.fromEntries(pairs);
  const ctx = await postJSON(HL, { type: 'metaAndAssetCtxs', dex: 'xyz' }, 8000);
  const i = ctx[0].universe.findIndex((a) => a.name === HL_COIN);
  if (i < 0) throw new Error('XYZ100 missing');
  const c = ctx[1][i];
  const price = +(c.midPx || c.markPx);
  const series = buildSeries(base, page);
  if (!usablePrice(price, series['60'] || series['1'] || series['15'])) throw new Error('hyperliquid price');
  return { name: 'hl', label: 'Hyperliquid XYZ100', price, series };
}

async function okxHistory(baseId, n, page) {
  const s = page.TF[baseId].s;
  const pages = Math.ceil(n / 100);
  const end = (Math.floor(Date.now() / 1000 / s) + 1) * s * 1000;
  const chunks = await mapPool(Array.from({ length: pages }, (_, k) => k), 4, (k) =>
    okxGet(OKX + 'history-index-candles?instId=US100-USDT&bar=' + page.TF[baseId].okx + '&limit=100&after=' + (end - k * 100 * s * 1000)));
  const rows = [];
  for (const pageRows of chunks) for (const row of pageRows || []) rows.push(row);
  const bars = asBars(rows, page.spotClosed);
  if (!bars.length) throw new Error('okx candles ' + baseId);
  return bars;
}

async function loadOkx(page) {
  const need = neededBase();
  const pairs = await Promise.all(need.ids.map(async (id) => {
    const n = id === '60' ? need.h1 : cfg.timeframes.find((t) => t.id === id).lookback;
    return [id, await okxHistory(id, n, page)];
  }));
  const series = buildSeries(Object.fromEntries(pairs), page);
  const tick = await okxGet(OKX + 'index-tickers?instId=US100-USDT');
  const price = +tick[0].idxPx;
  if (!usablePrice(price, series['60'] || series['1'])) throw new Error('okx price');
  return { name: 'okxidx', label: 'OKX US100-USDT index', price, series };
}

async function bgGet(p) {
  const j = await fetchJSON(BG + p, {}, 8000);
  if (!j || j.code !== '00000') throw new Error('bitget ' + (j && j.code) + ' ' + (j && j.msg || ''));
  return j.data;
}

async function loadBitget(page) {
  const need = neededBase();
  const pairs = await Promise.all(need.ids.map(async (id) => {
    const n = id === '60' ? need.h1 : cfg.timeframes.find((t) => t.id === id).lookback;
    const s = page.TF[id].s;
    const pages = Math.ceil(n / 200);
    const end = (Math.floor(Date.now() / 1000 / s) + 1) * s * 1000;
    const chunks = await mapPool(Array.from({ length: pages }, (_, k) => k), 4, (k) =>
      bgGet('history-index-candles?symbol=NDX100USDT&productType=USDT-FUTURES&granularity=' + BG_TF[id] + '&limit=200&endTime=' + (end - k * 200 * s * 1000)));
    let tail = [];
    try { tail = await bgGet('candles?symbol=NDX100USDT&productType=usdt-futures&granularity=' + BG_TF[id] + '&limit=5&kLineType=index') || []; }
    catch (e) { tail = []; }
    const rows = [];
    for (const chunk of chunks) for (const row of chunk || []) rows.push(row);
    for (const row of tail) rows.push(row);
    const bars = asBars(rows, page.spotClosed);
    if (!bars.length) throw new Error('bitget candles ' + id);
    return [id, bars];
  }));
  const series = buildSeries(Object.fromEntries(pairs), page);
  const px = await bgGet('symbol-price?symbol=NDX100USDT&productType=USDT-FUTURES');
  const price = +(px[0].indexPrice || px[0].price);
  if (!usablePrice(price, series['60'] || series['1'])) throw new Error('bitget price');
  return { name: 'bitget', label: 'Bitget NDX100 index', price, series };
}

// Last fallback. js/nas.js also stops at 300 perp candles, so H4/D1 are a short sample on this feed only.
async function loadPerp(page) {
  const need = neededBase();
  const pairs = await Promise.all(need.ids.map(async (id) => {
    const rows = await okxGet(OKX + 'candles?instId=US100-USDT-SWAP&bar=' + page.TF[id].okx + '&limit=300');
    const bars = asBars((rows || []).slice().reverse(), page.spotClosed);
    if (!bars.length) throw new Error('perp candles ' + id);
    return [id, bars];
  }));
  const series = buildSeries(Object.fromEntries(pairs), page);
  const tick = await okxGet(OKX + 'ticker?instId=US100-USDT-SWAP');
  const price = +tick[0].last;
  if (!usablePrice(price, series['60'] || series['1'])) throw new Error('perp price');
  return { name: 'perp', label: 'OKX US100-USDT perp', price, series };
}

const FEEDS = [
  { name: 'hl', label: 'Hyperliquid XYZ100', load: loadHl },
  { name: 'okxidx', label: 'OKX US100-USDT index', load: loadOkx },
  { name: 'bitget', label: 'Bitget NDX100 index', load: loadBitget },
  { name: 'perp', label: 'OKX US100-USDT perp', load: loadPerp },
];

async function loadFeed(page) {
  const only = process.env.NAS_FEED;
  const feeds = only ? FEEDS.filter((f) => f.name === only) : FEEDS;
  if (!feeds.length) throw new Error('NAS_FEED must be hl, okxidx, bitget or perp');
  const errors = [];
  for (const feed of feeds) {
    try { return await feed.load(page); }
    catch (e) {
      errors.push(feed.name + ': ' + (e && e.message ? e.message : e));
      console.error('feed ' + feed.name + ' failed: ' + (e && e.message ? e.message : e));
    }
  }
  throw new Error('all price feeds failed\n' + errors.join('\n'));
}

async function sendTelegram(token, chatId, text) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  let r;
  try {
    r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: ac.signal,
    });
  } catch (e) {
    throw new Error('Telegram network error');
  } finally {
    clearTimeout(t);
  }
  let j = {};
  try { j = await r.json(); } catch (e) { j = {}; }
  if (!r.ok || !j.ok) throw new Error('Telegram send failed: ' + ((j && j.description) || ('HTTP ' + r.status)));
}

function report(groups, feed, price, now, page) {
  console.log('NAS100 FVG alert');
  console.log('market: open');
  console.log('now: ' + now.toISOString());
  console.log('thai: ' + thaiStamp(now, page.tzParts));
  console.log('feed: ' + feed.label + ' (' + feed.name + ')');
  console.log('price: ' + fmtPx(price));
  console.log('fvg: js/nas.js maxActive=' + page.fvgCfg.maxActiveFvgVisible + ' maxIFvg=' + page.fvgCfg.maxIFvgVisible + ' showIFvg=' + page.fvgCfg.showIFvg);
  console.log('mode: ' + (dryRun() ? 'dry-run' : 'live'));
  console.log('counts:');
  for (const g of groups) {
    const sess = !g.tf.enabled ? 'disabled' : (g.open ? 'open' : 'closed');
    console.log(
      '  ' + g.tf.label.padEnd(3) +
      ' enabled=' + (g.tf.enabled ? 'yes' : 'no ') +
      ' session=' + g.tf.session.padEnd(7) +
      ' ' + sess.padEnd(8) +
      ' bars=' + String(g.bars).padStart(4) +
      ' closed=' + String(g.closed).padStart(4) +
      ' bull=' + g.bull +
      ' bear=' + g.bear +
      ' iFVG=' + g.ifvg +
      ' near=' + g.near +
      ' send=' + g.send
    );
  }
  console.log('zones:');
  let any = false;
  for (const g of groups) {
    for (const z of g.rows) {
      any = true;
      const flag = !z.sessionOpen ? 'session closed' : z.deduped ? 'already sent' : z.send ? 'SEND' : 'outside proximity';
      console.log('  ' + z.label + ' ' + z.kind + ' ' + fmtPx(z.lo) + '–' + fmtPx(z.hi) + ' dist=' + fmtPx(z.dist) + ' prox=' + z.prox + ' ' + flag);
    }
  }
  if (!any) console.log('  (none)');
}

function bar(t, o, h, l, c) {
  return { time: t, open: o, high: h, low: l, close: c };
}

function runSelfTest(page) {
  validateConfig(cfg);
  assert(page.fvgCfg.maxActiveFvgVisible === 3, 'page keeps 3 active FVGs');
  assert(page.fvgCfg.maxIFvgVisible === 1, 'page keeps 1 iFVG');
  assert(page.fvgCfg.showIFvg === true, 'page shows iFVG');

  const bullBars = [
    bar(0, 1, 10, 0, 9),
    bar(1, 9, 12, 8, 11),
    bar(2, 20, 30, 20, 28),
    bar(3, 28, 32, 12, 30),
    bar(4, 40, 55, 40, 50),
    bar(5, 50, 58, 32, 56),
    bar(6, 70, 90, 70, 80),
  ];
  const one = page.fvgScan(bullBars, { maxActiveFvgVisible: 3, maxIFvgVisible: 1, showIFvg: true, lastClosed: 2 });
  assert(one.bulls.length === 1 && one.bears.length === 0 && one.ifvgs.length === 0, 'first bull gap only');
  assert(one.bulls[0].left === 0 && one.bulls[0].bottom === 10 && one.bulls[0].top === 20 && one.bulls[0].label === '+ FVG', 'bull edges');
  const three = page.fvgScan(bullBars, { maxActiveFvgVisible: 3, maxIFvgVisible: 1, showIFvg: true, lastClosed: 6 });
  assert(three.bulls.length === 3 && three.bears.length === 0, 'three bull gaps on closed bars');
  assert(three.bulls[1].bottom === 30 && three.bulls[1].top === 40, 'second bull edges');
  assert(three.bulls[2].bottom === 55 && three.bulls[2].top === 70, 'third bull edges');
  const pruned = page.fvgScan(bullBars, { maxActiveFvgVisible: 2, maxIFvgVisible: 1, showIFvg: true, lastClosed: 6 });
  assert(pruned.bulls.length === 2 && pruned.bulls[0].left === 2 && pruned.bulls[1].left === 4, 'oldest FVG is pruned');

  const flipped = page.fvgScan([
    bar(0, 1, 10, 0, 9),
    bar(1, 9, 12, 8, 11),
    bar(2, 20, 30, 20, 28),
    bar(3, 15, 16, 8, 9),
  ], { maxActiveFvgVisible: 3, maxIFvgVisible: 1, showIFvg: true, lastClosed: 3 });
  assert(flipped.bulls.length === 0 && flipped.ifvgs.length === 1, 'close through a bull FVG makes an iFVG');
  assert(flipped.ifvgs[0].dir === -1 && flipped.ifvgs[0].bottom === 10 && flipped.ifvgs[0].top === 20 && flipped.ifvgs[0].label === 'iFVG', 'bearish iFVG keeps the box');
  const gone = page.fvgScan([
    bar(0, 1, 10, 0, 9),
    bar(1, 9, 12, 8, 11),
    bar(2, 20, 30, 20, 28),
    bar(3, 15, 16, 8, 9),
    bar(4, 30, 40, 25, 35),
  ], { maxActiveFvgVisible: 3, maxIFvgVisible: 1, showIFvg: true, lastClosed: 4 });
  assert(gone.ifvgs.length === 0 && gone.bulls.length === 0, 'iFVG invalidates on a close through the far side');

  const bear = page.fvgScan([
    bar(0, 100, 110, 90, 95),
    bar(1, 95, 100, 80, 85),
    bar(2, 70, 75, 60, 65),
  ], { maxActiveFvgVisible: 3, maxIFvgVisible: 1, showIFvg: true, lastClosed: 2 });
  assert(bear.bears.length === 1 && bear.bulls.length === 0, 'bear gap');
  assert(bear.bears[0].label === '- FVG' && bear.bears[0].bottom === 75 && bear.bears[0].top === 90 && bear.bears[0].left === 0, 'bear edges');
  const bearFlip = page.fvgScan([
    bar(0, 100, 110, 90, 95),
    bar(1, 95, 100, 80, 85),
    bar(2, 70, 75, 60, 65),
    bar(3, 100, 105, 95, 102),
  ], { maxActiveFvgVisible: 3, maxIFvgVisible: 1, showIFvg: true, lastClosed: 3 });
  assert(bearFlip.bears.length === 0 && bearFlip.ifvgs.length === 1 && bearFlip.ifvgs[0].dir === 1, 'close through a bear FVG makes a bullish iFVG');

  const hourly = bullBars.map((b, i) => bar(i * 3600, b.open, b.high, b.low, b.close));
  const closed = scanTf(hourly, '60', page, 6 * 3600 + 10);
  assert(closed.bulls.length === 2, 'forming bar is not scanned');
  const done = scanTf(hourly, '60', page, 8 * 3600);
  assert(done.bulls.length === 3, 'fully closed series is scanned');

  // US winter (EST, UTC-5) and summer (EDT, UTC-4). spotClosed is the page's rule.
  const closedAt = [
    '2026-11-14T12:00:00Z', // Saturday
    '2026-11-13T22:00:00Z', // Friday 17:00 EST = Saturday 05:00 Thai
    '2026-11-15T22:30:00Z', // Sunday 17:30 EST
    '2026-11-17T22:30:00Z', // Tuesday 17:30 EST = Wednesday 05:30 Thai
    '2026-07-15T21:30:00Z', // Wednesday 17:30 EDT = Thursday 04:30 Thai
  ];
  const openAt = [
    '2026-11-17T15:00:00Z', // Tuesday 10:00 EST
    '2026-11-13T21:30:00Z', // Friday 16:30 EST, still open, cash already shut
    '2026-11-15T23:00:00Z', // Sunday 18:00 EST = Monday 06:00 Thai
    '2026-11-17T23:00:00Z', // Tuesday 18:00 EST = Wednesday 06:00 Thai
    '2026-07-15T22:30:00Z', // Wednesday 18:30 EDT = Thursday 05:30 Thai
  ];
  for (const iso of closedAt) assert(page.spotClosed(Date.parse(iso)) === true, iso + ' should be closed');
  for (const iso of openAt) assert(page.spotClosed(Date.parse(iso)) === false, iso + ' should be open');

  const winterCash = new Date('2026-11-17T14:30:00Z'); // 09:30 EST, 21:30 Thai
  const winterStop = new Date('2026-11-17T21:00:00Z'); // 16:00 EST, 04:00 Thai
  const summerCash = new Date('2026-07-15T13:30:00Z'); // 09:30 EDT, 20:30 Thai
  const summerStop = new Date('2026-07-15T20:00:00Z'); // 16:00 EDT, 03:00 Thai
  assert(inWindow(winterCash, cfg.usCash, page.tzParts) === true, 'winter cash open');
  assert(inWindow(new Date('2026-11-17T14:29:00Z'), cfg.usCash, page.tzParts) === false, 'one minute before the cash open');
  assert(inWindow(winterStop, cfg.usCash, page.tzParts) === false, 'cash end is exclusive');
  assert(inWindow(new Date('2026-11-17T20:59:00Z'), cfg.usCash, page.tzParts) === true, 'last cash minute');
  assert(inWindow(summerCash, cfg.usCash, page.tzParts) === true, 'summer cash open');
  assert(inWindow(summerStop, cfg.usCash, page.tzParts) === false, 'summer cash end');
  assert(page.tzParts('Asia/Bangkok', winterCash).h === 21 && page.tzParts('Asia/Bangkok', winterCash).mi === 30, 'winter cash is 21:30 Thai');
  assert(page.tzParts('Asia/Bangkok', winterStop).h === 4 && page.tzParts('Asia/Bangkok', winterStop).mi === 0, 'winter cash ends 04:00 Thai');
  assert(page.tzParts('Asia/Bangkok', summerCash).h === 20 && page.tzParts('Asia/Bangkok', summerCash).mi === 30, 'summer cash is 20:30 Thai');
  assert(page.tzParts('Asia/Bangkok', summerStop).h === 3 && page.tzParts('Asia/Bangkok', summerStop).mi === 0, 'summer cash ends 03:00 Thai');

  const m1 = cfg.timeframes.find((t) => t.id === '1');
  const h1 = cfg.timeframes.find((t) => t.id === '60');
  assert(m1.session === 'us-cash' && cfg.timeframes.find((t) => t.id === '5').session === 'us-cash', 'M1 and M5 use the cash session');
  for (const id of ['15', '30', '60', '240', 'D']) assert(cfg.timeframes.find((t) => t.id === id).session === 'market', id + ' stays on while the market is open');
  assert(sessionOpen(m1, winterCash, page, true) === true, 'M1 alerts during cash');
  assert(sessionOpen(m1, new Date('2026-11-17T12:00:00Z'), page, true) === false, 'M1 is quiet outside cash');
  assert(sessionOpen(h1, new Date('2026-11-17T12:00:00Z'), page, true) === true, 'H1 alerts outside cash');
  assert(sessionOpen(h1, winterStop, page, false) === false, 'nothing alerts while the market is shut');

  const tOpen = Date.parse('2026-11-15T23:00:00Z') / 1000;
  assert(page.h4Start(tOpen) === Date.parse('2026-11-15T22:00:00Z') / 1000, 'winter H4 anchors at 17:00 New York');
  const tLater = Date.parse('2026-11-16T03:00:00Z') / 1000;
  assert(page.h4Start(tLater) === Date.parse('2026-11-16T02:00:00Z') / 1000, 'next winter H4 bucket is 21:00 New York');
  const tSummer = Date.parse('2026-07-15T22:00:00Z') / 1000;
  assert(page.h4Start(tSummer) === Date.parse('2026-07-15T21:00:00Z') / 1000, 'summer H4 anchors at 17:00 New York');
  const d1 = page.aggD1([
    bar(Date.parse('2026-11-15T23:00:00Z') / 1000, 1, 3, 1, 2),
    bar(Date.parse('2026-11-16T00:00:00Z') / 1000, 2, 4, 2, 3),
    bar(Date.parse('2026-11-16T23:00:00Z') / 1000, 3, 5, 3, 4),
  ]);
  assert(d1.length === 2, 'D1 folds a New York session, not a UTC day');
  assert(d1[0].time === Date.parse('2026-11-15T22:00:00Z') / 1000 && d1[0].high === 4 && d1[0].low === 1 && d1[0].close === 3, 'first session day');
  assert(d1[1].time === Date.parse('2026-11-16T22:00:00Z') / 1000 && d1[1].open === 3, 'next session day');

  const scanned = scanTf(hourly, '60', page, 8 * 3600);
  const rows = zoneRows(h1, hourly, scanned, 58, true, { zones: {} });
  const hit = rows.find((z) => z.send && z.kind === 'FVG ขาขึ้น' && z.lo === 55 && z.hi === 70);
  assert(hit, 'price within H1 proximity is a send');
  assert(rows.some((z) => z.lo === 10 && z.send === false), 'a far zone is not a send');
  const state = { version: 1, zones: {} };
  state.zones[hit.key] = { alertedAt: new Date().toISOString() };
  const again = zoneRows(h1, hourly, scanned, 58, true, state);
  assert(again.find((z) => z.key === hit.key).deduped === true && again.find((z) => z.key === hit.key).send === false, 'a zone alerts once');
  const text = formatAlert(hit, winterCash, page.tzParts);
  assert(text.indexOf('NAS100 · H1 · FVG ขาขึ้น') === 0, 'message names the timeframe and side');
  assert(text.indexOf('โซน 55.0 – 70.0') >= 0, 'message has the zone');
  assert(text.indexOf('ราคา 58.0') >= 0, 'message has the price');
  assert(text.indexOf('21:30 น. (เวลาไทย)') >= 0, 'message has Thai time');
  assert(text.indexOf(cfg.reminder) >= 0, 'message has the reminder');
  assert(text.toLowerCase().indexOf('no setup') < 0, 'message is not a no-setup note');

  const m1rows = zoneRows(m1, bullBars, scanTf(bullBars, '1', page, 100), 58, false, { zones: {} });
  assert(m1rows.some((z) => z.near) && m1rows.every((z) => z.send === false), 'M1 near a zone does not send outside the cash session');
}

async function main() {
  const page = loadPageLogic();
  if (process.argv.includes('--self-test')) {
    runSelfTest(page);
    console.log('self-test ok');
    return;
  }
  validateConfig(cfg);
  const now = clock();
  if (page.spotClosed(now.getTime())) {
    console.log('NAS100 market closed (weekend or the 17:00–18:00 New York break). No alert.');
    return;
  }
  const stateFile = process.env.STATE_FILE || '';
  const state = readState(stateFile);
  const feed = await loadFeed(page);
  const nowSec = now.getTime() / 1000;
  const market = true;
  const groups = [];
  for (const tf of cfg.timeframes) {
    if (!tf.enabled) {
      groups.push({ tf, open: false, bars: 0, closed: 0, bull: 0, bear: 0, ifvg: 0, near: 0, send: 0, rows: [] });
      continue;
    }
    const bars = feed.series[tf.id] || [];
    const scan = scanTf(bars, tf.id, page, nowSec);
    const open = sessionOpen(tf, now, page, market);
    const rows = zoneRows(tf, bars, scan, feed.price, open, state);
    groups.push({
      tf, open, bars: bars.length, closed: scan.last + 1,
      bull: scan.bulls.length, bear: scan.bears.length, ifvg: scan.ifvgs.length,
      near: rows.filter((z) => z.near).length,
      send: rows.filter((z) => z.send).length,
      rows,
    });
  }
  report(groups, feed, feed.price, now, page);
  const pending = groups.reduce((acc, g) => acc.concat(g.rows.filter((z) => z.send)), []);
  let dirty = pruneState(state, activeKeys(groups), now, cfg.dedupeDays);
  if (!pending.length) {
    console.log('no alert. Telegram not called.');
    if (dirty && stateFile && !dryRun()) writeState(stateFile, state);
    return;
  }
  for (const z of pending) console.log('----\n' + formatAlert(z, now, page.tzParts));
  if (dryRun()) {
    console.log('dry-run: ' + pending.length + ' message(s) not sent');
    return;
  }
  const creds = secrets();
  if (!creds.ok) {
    console.log('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set. Add both repository secrets (Settings → Secrets and variables → Actions), then re-run. No message sent.');
    return;
  }
  if (!stateFile) {
    throw new Error('STATE_FILE is not set, so a sent alert could not be deduped. Refusing to send.');
  }
  const errors = [];
  for (const z of pending) {
    const text = formatAlert(z, now, page.tzParts);
    try {
      await sendTelegram(creds.token, creds.chat, text);
      state.zones[z.key] = {
        tf: z.label, kind: z.kind, bottom: z.lo, top: z.hi,
        alertedAt: new Date().toISOString(), price: feed.price,
      };
      dirty = true;
      console.log('sent ' + z.label + ' ' + z.kind);
    } catch (e) {
      errors.push(e.message || String(e));
      console.error('send failed ' + z.label + ' ' + z.kind + ': ' + (e.message || e));
    }
  }
  if (dirty) writeState(stateFile, state);
  if (errors.length) throw new Error(errors.join('; '));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
